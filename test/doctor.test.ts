import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeCache, urlSlug } from "../src/cache.js";
import { loadRegistry, type LibraryEntry, type Registry } from "../src/registry.js";
import {
  runDoctor,
  classifySourceKind,
  deriveProbeQuery,
  formatDoctorTable,
  doctorExitCode,
  doctorToolText,
  DOCTOR_CONCURRENCY,
  type DoctorReport,
} from "../src/doctor.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "vibectx-doctor-"));
  process.env.DOCS_CACHE_DIR = dir;
});

afterEach(() => {
  delete process.env.DOCS_CACHE_DIR;
  rmSync(dir, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

function reg(...entries: LibraryEntry[]): Registry {
  return { entries: new Map(entries.map((e) => [e.name, e])) };
}

/** Seed the cache and back-date its fetchedAt so cache age / staleness rules can be tested. */
function seedAged(library: string, url: string, content: string, ageHours: number) {
  writeCache(library, url, content);
  const metaPath = join(dir, library.replace(/[^a-z0-9_-]/gi, "_"), `${urlSlug(url)}.meta.json`);
  const meta = JSON.parse(readFileSync(metaPath, "utf8"));
  meta.fetchedAt = new Date(Date.now() - ageHours * 3600_000).toISOString();
  writeFileSync(metaPath, JSON.stringify(meta), "utf8");
}

function stubFetch(pages: Record<string, string>) {
  const spy = vi.fn(async (url: unknown) => {
    const body = pages[String(url)];
    if (body === undefined) return new Response("not found", { status: 404 });
    return new Response(body, { status: 200, headers: { "content-type": "text/plain" } });
  });
  vi.stubGlobal("fetch", spy);
  return spy;
}

/** Fastify-shaped index: > 100 KB of relative link lines (PAR-706 fixture shape). */
function fastifyIndex(): string {
  const lines = ["# Fastify", "", "> Fast and low overhead web framework.", "", "## Reference"];
  lines.push("- [Server querystring parsing](/docs/latest/Reference/Server.md): server options");
  for (let i = 0; i < 2500; i++) {
    lines.push(`- [Reference page ${i}](/docs/latest/Reference/Page-${i}.md): description of page ${i}`);
  }
  const index = lines.join("\n");
  if (index.length <= 100_000) throw new Error("fixture must exceed 100 KB");
  return index;
}

const FASTIFY_INDEX_URL = "https://fastify.dev/llms.txt";
const FASTIFY_PAGE_URL = "https://fastify.dev/docs/latest/Reference/Server.md";
const FASTIFY_PAGE =
  "# Server\n\n## querystring parsing\n\nFastify uses the querystring module for parsing by default; set querystringParser to override.";

const REACT_URL = "https://react.dev/llms-full.txt";
const REACT_DOC = [
  "# React",
  "",
  "Prose introduction to React, hooks and rendering.",
  "",
  "## useEffect cleanup",
  "",
  "Return a function from useEffect to run cleanup before the next effect and on unmount.",
  "",
  "## useState",
  "",
  "State in function components.",
].join("\n");

const PGVECTOR_URL = "https://raw.githubusercontent.com/pgvector/pgvector/master/README.md";
const PGVECTOR_README = [
  "# pgvector",
  "- [Installation](#installation)",
  "- [Indexing](#indexing)",
  "## Installation",
  "Compile and install the extension.",
  "## HNSW",
  "Create an hnsw index for approximate nearest neighbour search.",
].join("\n");

describe("classifySourceKind", () => {
  it("classifies by structure first: a link-dense document is index-only whatever its URL", () => {
    expect(classifySourceKind(FASTIFY_INDEX_URL, fastifyIndex())).toBe("index-only");
    expect(classifySourceKind("https://raw.githubusercontent.com/x/y/main/docs/Index.md", fastifyIndex())).toBe(
      "index-only",
    );
  });

  it("classifies prose at an llms.txt / llms-full.txt URL as full-text", () => {
    expect(classifySourceKind(REACT_URL, REACT_DOC)).toBe("full-text");
    expect(classifySourceKind("https://docs.example.com/llms.txt", REACT_DOC)).toBe("full-text");
  });

  it("classifies raw GitHub and README-style URLs as readme", () => {
    expect(classifySourceKind(PGVECTOR_URL, PGVECTOR_README)).toBe("readme");
    expect(classifySourceKind("https://docs.example.com/README.md", REACT_DOC)).toBe("readme");
    expect(classifySourceKind("https://docs.example.com/readme", REACT_DOC)).toBe("readme");
  });

  it("classifies prose with no llms.txt provenance as readme (curated page fallback)", () => {
    expect(classifySourceKind("https://docs.example.com/guide/intro.md", REACT_DOC)).toBe("readme");
  });
});

describe("deriveProbeQuery", () => {
  it("uses the description minus the library's own name tokens", () => {
    expect(deriveProbeQuery({ name: "hono", urls: ["u"], description: "Hono web framework" })).toBe("web framework");
  });

  it("falls back to the library name when the description adds nothing", () => {
    expect(deriveProbeQuery({ name: "hono", urls: ["u"], description: "Hono" })).toBe("hono");
    expect(deriveProbeQuery({ name: "hono", urls: ["u"] })).toBe("hono");
  });
});

describe("runDoctor source kinds and probes", () => {
  it("fastify shape: index-only, follows a link, answered from the followed page (index-followed), healthy", async () => {
    // Under the pre-PAR-706 detector (documents over 100,000 chars were never treated
    // as an index) get_docs followed nothing here and returned, at best, the index's
    // own link list. doctor's "index-only with zero followed links" rule is the ✗ that
    // would have caught that, had doctor existed; see the next test for that shape.
    writeCache("fastify", FASTIFY_INDEX_URL, fastifyIndex());
    const spy = stubFetch({ [FASTIFY_PAGE_URL]: FASTIFY_PAGE });
    const report = await runDoctor(
      reg({ name: "fastify", urls: [FASTIFY_INDEX_URL], probeQueries: ["querystring parsing"] }),
    );
    const [lib] = report.libraries;
    expect(spy).toHaveBeenCalledWith(FASTIFY_PAGE_URL, expect.anything());
    expect(lib.kind).toBe("index-only");
    expect(lib.url).toBe(FASTIFY_INDEX_URL);
    expect(lib.followed).toBe(1);
    expect(lib.dropped).toBe(0);
    expect(lib.probes).toEqual([
      { query: "querystring parsing", derived: false, status: "index-followed", followed: 1, dropped: 0 },
    ]);
    expect(lib.healthy).toBe(true);
    expect(lib.reasons).toEqual([]);
    expect(report.healthy).toBe(1);
    expect(report.total).toBe(1);
  });

  it("index-only with every followed link failing is unhealthy even though the index text itself matched", async () => {
    writeCache("fastify", FASTIFY_INDEX_URL, fastifyIndex());
    stubFetch({}); // every followed page 404s
    const report = await runDoctor(
      reg({ name: "fastify", urls: [FASTIFY_INDEX_URL], probeQueries: ["querystring parsing"] }),
    );
    const [lib] = report.libraries;
    expect(lib.kind).toBe("index-only");
    expect(lib.followed).toBe(0);
    expect(lib.dropped).toBe(1);
    expect(lib.probes[0].status).toBe("answered"); // the link list matched — that is the PAR-704 shape
    expect(lib.healthy).toBe(false);
    expect(lib.reasons.join(" ")).toMatch(/index-only.*no links followed/);
  });

  it("index-only with a followed page that lacks the topic is 'answered' (from the link list), not index-followed", async () => {
    // Rule as specified for PAR-707: ✗ only when zero links were followed. This row is ✓
    // with links 1/0 and probe 'answered' — the operator can see the answer did not come
    // from the followed page. A stricter rule (index-only requires an index-followed probe)
    // is a candidate follow-up, not applied here.
    writeCache("fastify", FASTIFY_INDEX_URL, fastifyIndex());
    stubFetch({ [FASTIFY_PAGE_URL]: "# Unrelated\n\nNothing about the topic here." });
    const report = await runDoctor(
      reg({ name: "fastify", urls: [FASTIFY_INDEX_URL], probeQueries: ["querystring parsing"] }),
    );
    const [lib] = report.libraries;
    expect(lib.kind).toBe("index-only");
    expect(lib.followed).toBe(1);
    expect(lib.probes[0].status).toBe("answered");
    expect(lib.healthy).toBe(true);
  });

  it("full-text: prose at an llms-full.txt URL, probe answered, healthy", async () => {
    writeCache("react", REACT_URL, REACT_DOC);
    stubFetch({});
    const report = await runDoctor(reg({ name: "react", urls: [REACT_URL], probeQueries: ["useEffect cleanup"] }));
    const [lib] = report.libraries;
    expect(lib.kind).toBe("full-text");
    expect(lib.probes[0].status).toBe("answered");
    expect(lib.followed).toBe(0);
    expect(lib.healthy).toBe(true);
  });

  it("readme: raw GitHub README, probe answered, healthy", async () => {
    writeCache("pgvector", PGVECTOR_URL, PGVECTOR_README);
    stubFetch({});
    const report = await runDoctor(reg({ name: "pgvector", urls: [PGVECTOR_URL], probeQueries: ["hnsw index"] }));
    const [lib] = report.libraries;
    expect(lib.kind).toBe("readme");
    expect(lib.probes[0].status).toBe("answered");
    expect(lib.healthy).toBe(true);
  });

  it("unreachable: nothing fetched and nothing cached; no probes run; unhealthy", async () => {
    stubFetch({});
    const report = await runDoctor(
      reg({ name: "ghost", urls: ["https://ghost.example.com/llms.txt"], probeQueries: ["anything"] }),
    );
    const [lib] = report.libraries;
    expect(lib.kind).toBe("unreachable");
    expect(lib.url).toBeNull();
    expect(lib.cacheAgeHours).toBeNull();
    expect(lib.stale).toBe(false);
    expect(lib.probes).toEqual([]);
    expect(lib.healthy).toBe(false);
    expect(lib.reasons).toEqual(["unreachable: nothing fetched and nothing cached"]);
  });

  it("a probe with no match makes the library unhealthy and names the query", async () => {
    writeCache("react", REACT_URL, REACT_DOC);
    stubFetch({});
    const report = await runDoctor(
      reg({ name: "react", urls: [REACT_URL], probeQueries: ["useEffect cleanup", "zzz-unmatched"] }),
    );
    const [lib] = report.libraries;
    expect(lib.probes.map((p) => p.status)).toEqual(["answered", "no match"]);
    expect(lib.healthy).toBe(false);
    expect(lib.reasons).toEqual(['no match: "zzz-unmatched"']);
  });

  it("treats probeQueries: [] exactly like an absent probeQueries (derived query)", async () => {
    writeCache("hono", "https://hono.dev/llms-full.txt", "# Hono\n\n## Web framework\n\nHono is a small web framework.");
    stubFetch({});
    const report = await runDoctor(
      reg({ name: "hono", urls: ["https://hono.dev/llms-full.txt"], description: "Hono web framework", probeQueries: [] }),
    );
    expect(report.libraries[0].probes).toEqual([
      { query: "web framework", derived: true, status: "answered", followed: 0, dropped: 0 },
    ]);
  });

  it("derives a probe from the description when none is configured and marks it derived", async () => {
    writeCache("hono", "https://hono.dev/llms-full.txt", "# Hono\n\n## Web framework\n\nHono is a small web framework.");
    stubFetch({});
    const report = await runDoctor(
      reg({ name: "hono", urls: ["https://hono.dev/llms-full.txt"], description: "Hono web framework" }),
    );
    const [lib] = report.libraries;
    expect(lib.probes).toEqual([{ query: "web framework", derived: true, status: "answered", followed: 0, dropped: 0 }]);
    expect(formatDoctorTable(report)).toContain('"web framework" (derived)');
  });
});

describe("runDoctor cache age and staleness", () => {
  const entry: LibraryEntry = { name: "react", urls: [REACT_URL], ttlHours: 10, probeQueries: ["useEffect cleanup"] };

  it("reports cache age in hours and stale=false within TTL", async () => {
    seedAged("react", REACT_URL, REACT_DOC, 4);
    stubFetch({});
    const [lib] = (await runDoctor(reg(entry))).libraries;
    expect(lib.cacheAgeHours).toBeGreaterThanOrEqual(3.9);
    expect(lib.cacheAgeHours).toBeLessThan(4.2);
    expect(lib.stale).toBe(false);
    expect(lib.ttlHours).toBe(10);
    expect(lib.healthy).toBe(true);
  });

  it("stale past TTL but under 2x TTL (served stale, network down) is flagged stale yet still healthy", async () => {
    seedAged("react", REACT_URL, REACT_DOC, 15);
    stubFetch({}); // refresh fails → stale content served
    const [lib] = (await runDoctor(reg(entry))).libraries;
    expect(lib.stale).toBe(true);
    expect(lib.cacheAgeHours).toBeGreaterThanOrEqual(14.9);
    expect(lib.probes[0].status).toBe("answered");
    expect(lib.healthy).toBe(true);
  });

  it("exactly 2x TTL is already unhealthy (boundary is >=)", async () => {
    seedAged("react", REACT_URL, REACT_DOC, 20);
    stubFetch({});
    const [lib] = (await runDoctor(reg(entry))).libraries;
    expect(lib.cacheAgeHours).toBe(20);
    expect(lib.healthy).toBe(false);
    expect(lib.reasons).toEqual(["stale 20h, over 2x TTL (10h)"]);
  });

  it("ttlHours 0 (always revalidate) disables the staleness rule: a refreshed library is healthy", async () => {
    seedAged("react", REACT_URL, REACT_DOC, 5);
    stubFetch({ [REACT_URL]: REACT_DOC });
    const [lib] = (await runDoctor(reg({ ...entry, ttlHours: 0 }))).libraries;
    expect(lib.ttlHours).toBe(0);
    expect(lib.stale).toBe(true); // cache.ts semantics: ttl 0 is stale the moment it is written
    expect(lib.healthy).toBe(true);
    expect(lib.reasons).toEqual([]);
  });

  it("stale beyond 2x TTL is unhealthy", async () => {
    seedAged("react", REACT_URL, REACT_DOC, 25);
    stubFetch({});
    const [lib] = (await runDoctor(reg(entry))).libraries;
    expect(lib.stale).toBe(true);
    expect(lib.healthy).toBe(false);
    expect(lib.reasons.join(" ")).toMatch(/stale .*2x TTL/);
  });

  it("a successful refresh resets the age: stale cache plus reachable network is healthy and fresh", async () => {
    seedAged("react", REACT_URL, REACT_DOC, 25);
    stubFetch({ [REACT_URL]: REACT_DOC });
    const [lib] = (await runDoctor(reg(entry))).libraries;
    expect(lib.stale).toBe(false);
    expect(lib.cacheAgeHours).toBeLessThan(0.1);
    expect(lib.healthy).toBe(true);
  });
});

describe("runDoctor --offline", () => {
  it("never calls fetch; serves cached libraries stale and reports uncached ones unreachable", async () => {
    seedAged("react", REACT_URL, REACT_DOC, 15);
    const spy = vi.fn();
    vi.stubGlobal("fetch", spy);
    const report = await runDoctor(
      reg(
        { name: "react", urls: [REACT_URL], ttlHours: 10, probeQueries: ["useEffect cleanup"] },
        { name: "fastify", urls: [FASTIFY_INDEX_URL], probeQueries: ["querystring parsing"] },
      ),
      { offline: true },
    );
    expect(spy).not.toHaveBeenCalled();
    const [react, fastify] = report.libraries;
    expect(react.kind).toBe("full-text");
    expect(react.stale).toBe(true);
    expect(react.probes[0].status).toBe("answered");
    expect(fastify.kind).toBe("unreachable");
    expect(fastify.healthy).toBe(false);
    expect(report.healthy).toBe(1);
    expect(report.total).toBe(2);
  });

  it("offline reaches the link-following layer: an uncached linked page is dropped, not fetched", async () => {
    // Mutant guard: dropping `args.offline` from the fetchLinkedPage call in get-docs.ts
    // makes this fetch the page and turns this test red.
    writeCache("fastify", FASTIFY_INDEX_URL, fastifyIndex());
    const spy = vi.fn(async () => new Response(FASTIFY_PAGE, { status: 200, headers: { "content-type": "text/plain" } }));
    vi.stubGlobal("fetch", spy);
    const report = await runDoctor(
      reg({ name: "fastify", urls: [FASTIFY_INDEX_URL], probeQueries: ["querystring parsing"] }),
      { offline: true },
    );
    expect(spy).not.toHaveBeenCalled();
    const [lib] = report.libraries;
    expect(lib.kind).toBe("index-only");
    expect(lib.probes[0]).toEqual({
      query: "querystring parsing",
      derived: false,
      status: "answered",
      followed: 0,
      dropped: 1,
    });
    expect(lib.healthy).toBe(false);
  });

  it("offline index following uses cached pages only", async () => {
    writeCache("fastify", FASTIFY_INDEX_URL, fastifyIndex());
    writeCache("fastify", FASTIFY_PAGE_URL, FASTIFY_PAGE);
    const spy = vi.fn();
    vi.stubGlobal("fetch", spy);
    const report = await runDoctor(
      reg({ name: "fastify", urls: [FASTIFY_INDEX_URL], probeQueries: ["querystring parsing"] }),
      { offline: true },
    );
    expect(spy).not.toHaveBeenCalled();
    expect(report.libraries[0].probes[0].status).toBe("index-followed");
    expect(report.libraries[0].healthy).toBe(true);
  });
});

describe("runDoctor library filter", () => {
  it("restricts the report to one library", async () => {
    writeCache("react", REACT_URL, REACT_DOC);
    stubFetch({});
    const report = await runDoctor(
      reg(
        { name: "react", urls: [REACT_URL], probeQueries: ["useEffect cleanup"] },
        { name: "ghost", urls: ["https://ghost.example.com/llms.txt"] },
      ),
      { library: "react" },
    );
    expect(report.libraries.map((l) => l.library)).toEqual(["react"]);
    expect(report.total).toBe(1);
  });

  it("rejects an unknown library", async () => {
    await expect(runDoctor(reg({ name: "react", urls: [REACT_URL] }), { library: "nope" })).rejects.toThrow(
      /Unknown library "nope"/,
    );
  });

  it("resolves an alias to its canonical entry and reports it under the canonical name (PAR-654)", async () => {
    writeCache("react", REACT_URL, REACT_DOC);
    stubFetch({});
    const report = await runDoctor(
      reg(
        { name: "react", urls: [REACT_URL], aliases: ["reactjs"], probeQueries: ["useEffect cleanup"] },
        { name: "ghost", urls: ["https://ghost.example.com/llms.txt"] },
      ),
      { library: "reactjs" },
    );
    expect(report.libraries.map((l) => l.library)).toEqual(["react"]);
    expect(report.libraries[0].healthy).toBe(true);
  });
});

describe("runDoctor on the shipped default registry (PAR-654)", () => {
  it("--offline with an empty cache reports 30 rows, all unreachable, without touching the network", async () => {
    const spy = vi.fn();
    vi.stubGlobal("fetch", spy);
    const report = await runDoctor(loadRegistry(), { offline: true });
    expect(spy).not.toHaveBeenCalled();
    expect(report.total).toBe(30);
    expect(report.libraries).toHaveLength(30);
    expect(report.healthy).toBe(0);
    expect(report.libraries.every((l) => l.kind === "unreachable")).toBe(true);
    expect(formatDoctorTable(report)).toContain("0/30 libraries healthy");
  });
});

describe("report shape, table and exit code", () => {
  async function mixedReport(): Promise<DoctorReport> {
    writeCache("react", REACT_URL, REACT_DOC);
    stubFetch({});
    return runDoctor(
      reg(
        { name: "react", urls: [REACT_URL], probeQueries: ["useEffect cleanup"] },
        { name: "ghost", urls: ["https://ghost.example.com/llms.txt"], probeQueries: ["x"] },
      ),
    );
  }

  it("emits the documented JSON shape with stable keys", async () => {
    const report = JSON.parse(JSON.stringify(await mixedReport()));
    expect(Object.keys(report)).toEqual(["schemaVersion", "generatedAt", "libraries", "healthy", "total"]);
    expect(report.schemaVersion).toBe(1);
    expect(Number.isNaN(Date.parse(report.generatedAt))).toBe(false);
    for (const lib of report.libraries) {
      expect(Object.keys(lib)).toEqual([
        "library",
        "kind",
        "url",
        "cacheAgeHours",
        "stale",
        "ttlHours",
        "probes",
        "followed",
        "dropped",
        "healthy",
        "reasons",
      ]);
      for (const p of lib.probes) {
        expect(Object.keys(p)).toEqual(["query", "derived", "status", "followed", "dropped"]);
      }
    }
    expect(report.healthy).toBe(1);
    expect(report.total).toBe(2);
  });

  it("renders one row per library with a mark and a summary line, listing reasons for ✗ rows", async () => {
    const table = formatDoctorTable(await mixedReport());
    const lines = table.split("\n");
    expect(lines[0]).toMatch(/^vibectx doctor/);
    expect(table).toMatch(/library\s+kind\s+cache\s+probe\s+links\s+mark/);
    expect(table).toMatch(/react\s+full-text\s+0\.0h\s+"useEffect cleanup" → answered\s+0\/0\s+✓/);
    expect(table).toMatch(/ghost\s+unreachable\s+—\s+—\s+0\/0\s+✗/);
    expect(table).toContain("1/2 libraries healthy");
    expect(table).toContain("✗ ghost: unreachable: nothing fetched and nothing cached");
  });

  it("exit code is 1 when any library is unhealthy, else 0", async () => {
    const report = await mixedReport();
    expect(doctorExitCode(report)).toBe(1);
    expect(doctorExitCode({ ...report, libraries: report.libraries.filter((l) => l.healthy), healthy: 1, total: 1 })).toBe(0);
  });
});

describe("runDoctor per-library failure isolation", () => {
  it("a library whose cache read throws is reported unreachable with the error; the rest still render", async () => {
    // Corrupt meta.json → JSON.parse throws inside readCache → getLibraryDoc → getDocsDetailed.
    writeCache("broken", "https://broken.example.com/llms.txt", "# Broken");
    const metaPath = join(dir, "broken", `${urlSlug("https://broken.example.com/llms.txt")}.meta.json`);
    writeFileSync(metaPath, "{ not json", "utf8");
    writeCache("react", REACT_URL, REACT_DOC);
    stubFetch({});
    const report = await runDoctor(
      reg(
        { name: "broken", urls: ["https://broken.example.com/llms.txt"], probeQueries: ["x"] },
        { name: "react", urls: [REACT_URL], probeQueries: ["useEffect cleanup"] },
      ),
    );
    const [broken, react] = report.libraries;
    expect(broken.kind).toBe("unreachable");
    expect(broken.healthy).toBe(false);
    expect(broken.probes).toEqual([]);
    expect(broken.reasons).toHaveLength(1);
    expect(broken.reasons[0]).toMatch(/^error: /);
    expect(broken.reasons[0]).toMatch(/JSON/i);
    expect(react.healthy).toBe(true);
    expect(report.healthy).toBe(1);
    expect(report.total).toBe(2);
    expect(formatDoctorTable(report)).toMatch(/broken\s+unreachable\s+—\s+—\s+0\/0\s+✗/);
  });
});

describe("runDoctor concurrency cap", () => {
  it("never has more than DOCTOR_CONCURRENCY libraries in flight", async () => {
    expect(DOCTOR_CONCURRENCY).toBe(3);
    let inFlight = 0;
    let maxInFlight = 0;
    const spy = vi.fn(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 10));
      inFlight -= 1;
      return new Response("not found", { status: 404 });
    });
    vi.stubGlobal("fetch", spy);
    const entries: LibraryEntry[] = Array.from({ length: 5 }, (_, i) => ({
      name: `lib${i}`,
      urls: [`https://lib${i}.example.com/llms.txt`],
      probeQueries: ["x"],
    }));
    const report = await runDoctor(reg(...entries));
    expect(spy).toHaveBeenCalledTimes(5);
    expect(maxInFlight).toBeGreaterThan(1); // it did fan out …
    expect(maxInFlight).toBeLessThanOrEqual(DOCTOR_CONCURRENCY); // … but no further than the cap
    expect(report.libraries.map((l) => l.library)).toEqual(entries.map((e) => e.name)); // registry order kept
    expect(report.total).toBe(5);
  });
});

describe("doctorToolText (MCP doctor tool body)", () => {
  it("returns the table for the whole registry when no library is given", async () => {
    writeCache("react", REACT_URL, REACT_DOC);
    stubFetch({});
    const out = await doctorToolText(
      reg(
        { name: "react", urls: [REACT_URL], probeQueries: ["useEffect cleanup"] },
        { name: "ghost", urls: ["https://ghost.example.com/llms.txt"] },
      ),
    );
    expect(out).toMatch(/^vibectx doctor/);
    expect(out).toContain("1/2 libraries healthy");
  });

  it("restricts to a known library", async () => {
    writeCache("react", REACT_URL, REACT_DOC);
    stubFetch({});
    const out = await doctorToolText(
      reg(
        { name: "react", urls: [REACT_URL], probeQueries: ["useEffect cleanup"] },
        { name: "ghost", urls: ["https://ghost.example.com/llms.txt"] },
      ),
      "react",
    );
    expect(out).toContain("1/1 libraries healthy");
    expect(out).not.toContain("ghost");
  });

  it("names the known libraries for an unknown one, without running any probe", async () => {
    const spy = stubFetch({});
    const out = await doctorToolText(reg({ name: "react", urls: [REACT_URL] }), "nope");
    expect(out).toBe('Unknown library "nope". Known: react');
    expect(spy).not.toHaveBeenCalled();
  });

  it("accepts an alias for the library argument (PAR-654)", async () => {
    writeCache("react", REACT_URL, REACT_DOC);
    stubFetch({});
    const out = await doctorToolText(
      reg({ name: "react", urls: [REACT_URL], aliases: ["reactjs"], probeQueries: ["useEffect cleanup"] }),
      "reactjs",
    );
    expect(out).toContain("1/1 libraries healthy");
    expect(out).toMatch(/\nreact\s+full-text/);
  });
});
