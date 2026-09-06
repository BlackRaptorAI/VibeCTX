import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeCache } from "../src/cache.js";
import type { Registry } from "../src/registry.js";
import { rankSections } from "../src/retrieval.js";
import {
  documentHash,
  indexDocument,
  invalidateIndex,
  readIndex,
  resetSearchIndexMemo,
  searchIndexPath,
  writeIndex,
  MAX_LAZY_INDEX_DOCS,
  SEARCH_INDEX_SCHEMA_VERSION,
} from "../src/search-index.js";
import {
  formatSearchResults,
  runSearch,
  searchExitCode,
  searchToolText,
  MAX_QUERY_CHARS,
  MAX_RENDERED_LIBRARIES,
  SEARCH_SCHEMA_VERSION,
} from "../src/search.js";

/**
 * PAR-659 · D-35 — cross-library `search`. Every case here runs against a real cache
 * directory and NEVER against the network: `fetch` is stubbed to throw in `beforeEach`, so a
 * single request from this path fails the suite rather than passing it quietly.
 */

let dir: string;
let fetchSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "vibectx-search-"));
  process.env.DOCS_CACHE_DIR = dir;
  resetSearchIndexMemo();
  fetchSpy = vi.fn(() => {
    throw new Error("search must never touch the network (D-35)");
  });
  vi.stubGlobal("fetch", fetchSpy);
});

afterEach(() => {
  delete process.env.DOCS_CACHE_DIR;
  rmSync(dir, { recursive: true, force: true });
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const HONO_URL = "https://hono.dev/llms.txt";
const AI_URL = "https://ai-sdk.dev/llms.txt";
const NEXT_URL = "https://nextjs.org/llms.txt";

const HONO_DOC = [
  "# Hono",
  "",
  "A small web framework for any JavaScript runtime.",
  "",
  "## Streaming responses",
  "",
  "Use `streamSSE` to send server-sent events to the client as they are produced.",
  "",
  "## Route params",
  "",
  "Read a route parameter with `c.req.param('id')`.",
].join("\n");

const AI_DOC = [
  "# AI SDK",
  "",
  "## streamText",
  "",
  "`streamText` streams a model response token by token; pipe it to a server-sent events response.",
  "",
  "## generateObject",
  "",
  "Produce a typed object from a schema.",
].join("\n");

const NEXT_DOC = ["# Next.js", "", "## Caching", "", "Revalidate a route segment with `revalidatePath`."].join("\n");

const registry = (): Registry => ({
  entries: new Map([
    ["hono", { name: "hono", urls: [HONO_URL] }],
    ["ai-sdk", { name: "ai-sdk", aliases: ["ai", "vercel-ai"], urls: [AI_URL] }],
    ["next.js", { name: "next.js", aliases: ["next"], urls: [NEXT_URL] }],
  ]),
});

/** Cache the three documents (all of them, unless `only` names a subset). */
function warmAll(only?: string[]): void {
  const all: [string, string, string][] = [
    ["hono", HONO_URL, HONO_DOC],
    ["ai-sdk", AI_URL, AI_DOC],
    ["next.js", NEXT_URL, NEXT_DOC],
  ];
  for (const [name, url, doc] of all) if (!only || only.includes(name)) writeCache(name, url, doc);
}

const search = (opts: Parameters<typeof runSearch>[1]) => runSearch(registry(), opts);

describe("runSearch · grouping and ordering (PAR-659, D-35)", () => {
  it("groups hits by library, libraries by their best section, sections by score", () => {
    warmAll();
    const out = search({ query: "server-sent events streaming" });
    expect(out.groups.length).toBeGreaterThanOrEqual(2);
    expect(out.groups.map((g) => g.library)).not.toContain("next.js"); // nothing in it matches
    const scores = out.groups.map((g) => g.bestScore);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
    for (const group of out.groups) {
      const s = group.sections.map((x) => x.score);
      expect(s).toEqual([...s].sort((a, b) => b - a));
      expect(group.sections[0].body.length).toBeGreaterThan(0);
    }
    // The streaming section, not the routing one, is what each library leads with.
    expect(out.groups.map((g) => g.sections[0].heading).join(" | ")).toMatch(/Streaming responses|streamText/);
  });

  it("scores a section exactly as get_docs would score it inside its own document", () => {
    warmAll(["hono"]);
    const out = search({ query: "route params" });
    const ownDocument = rankSections(HONO_DOC, "route params");
    // The corpus differs (one document here, one document there), so the NUMBERS differ; the
    // ORDER within a library must not.
    expect(out.groups[0].sections.map((s) => s.heading)).toEqual(
      ownDocument.filter((s) => out.groups[0].sections.some((x) => x.heading === s.heading)).map((s) => s.heading),
    );
    expect(out.groups[0].sections[0].heading).toBe("Route params");
  });

  it("is deterministic and offline: the same query twice, byte for byte, with no fetch", () => {
    warmAll();
    const first = formatSearchResults(search({ query: "streaming events" }));
    const second = formatSearchResults(search({ query: "streaming events" }));
    expect(second).toBe(first);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("never resolves or fetches for a library with nothing in the cache", () => {
    warmAll(["hono"]);
    const out = search({ query: "streaming" });
    expect(out.searched).toBe(1);
    expect(out.uncached).toEqual(["ai-sdk", "next.js"]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

/**
 * PAR-659 · D-39 — THE BUDGET IS PRICED ON WHAT IS ACTUALLY RETURNED.
 *
 * The fixture matters more than the assertions here, and the quality gate's finding is why.
 * The previous "spends the budget ACROSS libraries" case ran on a corpus where EVERY library
 * had exactly one matching section, so `groups.length >= 2` and `sections.length === 1` were
 * arithmetic rather than behaviour: depth-first selection passed it unchanged. This corpus is
 * built so the two strategies give visibly different answers — one library owns FOUR matching
 * sections, and the budget has room for about three sections in total. Round-robin spreads
 * them across three libraries; depth-first would spend them all inside the first.
 *
 * Sections are long on purpose (~1 KB each), because the budget defect the review and schema
 * gates MEASURED — 9.9× at the default, 97× at `maxTokens: 200`, 322× on their fixture — only
 * shows on a corpus whose bodies are big enough to overrun it.
 */
const WIDE_URL = (n: string) => `https://${n}.example.com/llms-full.txt`;
const PARAGRAPH =
  "Open a streaming response and write each event as it is produced, flushing between writes so " +
  "the client sees them as they arrive rather than at the end. The helper takes care of the " +
  "framing, the keep-alive comments and the retry hint, and closes the stream when the handler " +
  "returns or the request is aborted. Everything here is ordinary streaming: no polling, no " +
  "second connection, and no buffering in front of the client. ";

/** `sections` sections of streaming prose, each ~1 KB, under a library's own heading. */
function wideDoc(library: string, sections: number): string {
  const lines = [`# ${library}`, "", `Documentation for ${library}.`, ""];
  for (let s = 0; s < sections; s++) {
    lines.push(`## Streaming events ${s}`, "", `${PARAGRAPH}${PARAGRAPH}Section ${s} of ${library}.`, "");
  }
  return lines.join("\n");
}

/** Four libraries; the first has four matching sections, the rest have one each. */
function wideCorpus(counts = [4, 1, 1, 1]): Registry {
  const entries = new Map<string, { name: string; urls: string[] }>();
  counts.forEach((n, i) => {
    const name = `wide-${i}`;
    writeCache(name, WIDE_URL(name), wideDoc(name, n));
    entries.set(name, { name, urls: [WIDE_URL(name)] });
  });
  return { entries };
}

describe("runSearch · the budget (PAR-659, D-35, D-39)", () => {
  it("always returns at least one section from the best-scoring library, however small the budget", () => {
    warmAll();
    const best = search({ query: "server-sent events streaming" }).groups[0].library;
    const out = search({ query: "server-sent events streaming", maxTokens: 1 });
    expect(out.groups).toHaveLength(1);
    expect(out.groups[0].library).toBe(best);
    expect(out.groups[0].sections).toHaveLength(1);
    // D-39/D-29: at four characters of budget the CAP wins over the body, exactly as it does
    // for an over-budget snippet. Give the section room and the body is there.
    const roomy = search({ query: "server-sent events streaming", maxTokens: 200 });
    expect(roomy.groups[0].library).toBe(best);
    expect(roomy.groups[0].sections[0].body.length).toBeGreaterThan(0);
  });

  it("spends the budget ACROSS libraries where depth-first would spend it inside one", () => {
    const reg = wideCorpus();
    // The first library HAS four matching sections — so this fixture can tell the strategies
    // apart, which the case it replaces could not.
    const all = runSearch(reg, { query: "streaming events flushing", maxTokens: 100_000 });
    expect(all.groups[0].matched).toBeGreaterThanOrEqual(4);

    // Room for roughly three sections. Round-robin: one from each of three libraries.
    const out = runSearch(reg, { query: "streaming events flushing", maxTokens: 900 });
    expect(out.groups.length).toBeGreaterThanOrEqual(3);
    for (const g of out.groups) expect(g.sections).toHaveLength(1);
    // Depth-first on this fixture would return ONE group holding several sections.
    expect(out.groups.reduce((n, g) => n + g.sections.length, 0)).toBe(out.groups.length);
  });

  it("D-39: the rendered response stays inside maxTokens*4 at the default budget and at 200", () => {
    const reg = wideCorpus([6, 6, 6, 6]);
    for (const maxTokens of [4000, 200]) {
      const out = runSearch(reg, { query: "streaming events flushing", maxTokens });
      const rendered = formatSearchResults(out);
      // MEASURED before D-39: 9.9× at the default budget, 97× at 200.
      expect(rendered.length).toBeLessThanOrEqual(maxTokens * 4);
      // …and `--json` obeys the same rule, which is the half that had no bound at all.
      const bodies = out.groups.reduce((n, g) => n + g.sections.reduce((m, s) => m + s.body.length, 0), 0);
      expect(bodies).toBeLessThanOrEqual(maxTokens * 4);
      expect(out.groups.length).toBeGreaterThanOrEqual(1);
    }
  });

  it("D-39: a section far larger than the whole budget is clipped, not emitted whole", () => {
    const name = "one-huge";
    const url = WIDE_URL(name);
    writeCache(name, url, `# ${name}\n\n## Streaming events\n\n${PARAGRAPH.repeat(200)}`);
    const reg: Registry = { entries: new Map([[name, { name, urls: [url] }]]) };
    const out = runSearch(reg, { query: "streaming events flushing", maxTokens: 200 });
    expect(out.groups[0].sections).toHaveLength(1);
    expect(formatSearchResults(out).length).toBeLessThanOrEqual(800);
    expect(out.groups[0].sections[0].body.length).toBeLessThanOrEqual(800);
  });

  it("a generous budget returns every matching section, each with its body", () => {
    warmAll();
    const out = search({ query: "streaming server-sent events object schema", maxTokens: 100_000 });
    const returned = out.groups.reduce((n, g) => n + g.sections.length, 0);
    const matched = out.groups.reduce((n, g) => n + g.matched, 0);
    expect(returned).toBe(matched);
    for (const g of out.groups) for (const s of g.sections) expect(s.body.trim().length).toBeGreaterThan(0);
  });
});

/**
 * PAR-659 · D-36 — the two per-call bounds, each with a case that FAILS if the bound is
 * removed. The quality gate found both surviving mutation (raising MAX_LAZY_INDEX_DOCS to
 * infinity, deleting MAX_RENDERED_LIBRARIES) because nothing exercised the boundary at all.
 */
describe("runSearch · the per-call bounds (PAR-659, D-36)", () => {
  /** `count` tiny cached libraries, all matching the same query. */
  function manyLibraries(count: number): Registry {
    const entries = new Map<string, { name: string; urls: string[] }>();
    for (let i = 0; i < count; i++) {
      const name = `many-${String(i).padStart(3, "0")}`;
      const url = `https://${name}.example.com/llms.txt`;
      writeCache(name, url, `# ${name}\n\n## Streaming events\n\nStream events to the client from ${name}.`);
      entries.set(name, { name, urls: [url] });
    }
    return { entries };
  }

  /** Fixture sizes are LITERALS, not `CONSTANT + n`: a bound raised to infinity must fail this
   *  file in a second, not build an infinite fixture while the suite hangs. */
  const LAZY_FIXTURE = 45;
  const RENDER_FIXTURE = 12;

  it("MAX_LAZY_INDEX_DOCS bounds the tokenizing ONE cold call does, and says which libraries were left", () => {
    expect(MAX_LAZY_INDEX_DOCS).toBeLessThan(LAZY_FIXTURE);
    const reg = manyLibraries(LAZY_FIXTURE);
    const cold = runSearch(reg, { query: "streaming events" });
    expect(cold.tokenized).toBe(MAX_LAZY_INDEX_DOCS); // not all 45 — the bound is what stops it
    expect(cold.searched).toBe(MAX_LAZY_INDEX_DOCS);
    expect(cold.notes.join(" ")).toContain(`at most ${MAX_LAZY_INDEX_DOCS} documents are indexed per call`);
    // Run it again and the rest are taken in, as the note promises.
    const second = runSearch(reg, { query: "streaming events" });
    expect(second.fromIndex).toBe(MAX_LAZY_INDEX_DOCS);
    expect(second.tokenized).toBe(LAZY_FIXTURE - MAX_LAZY_INDEX_DOCS);
    expect(runSearch(reg, { query: "streaming events" }).fromIndex).toBe(LAZY_FIXTURE);
  });

  it("MAX_RENDERED_LIBRARIES caps how many libraries one response can name, however large the budget", () => {
    expect(MAX_RENDERED_LIBRARIES).toBeLessThan(RENDER_FIXTURE);
    const reg = manyLibraries(RENDER_FIXTURE);
    const out = runSearch(reg, { query: "streaming events", maxTokens: 1_000_000 });
    expect(out.matchedLibraries).toBe(RENDER_FIXTURE);
    expect(out.groups).toHaveLength(MAX_RENDERED_LIBRARIES); // not all twelve
    expect(out.notes.join(" ")).toContain(`libraries matched; the ${MAX_RENDERED_LIBRARIES} best are shown`);
  });
});

describe("runSearch · the libraries filter (PAR-659, D-35)", () => {
  it("filters by canonical name", () => {
    warmAll();
    const out = search({ query: "streaming", libraries: ["hono"] });
    expect(out.requested).toBe(1);
    expect(out.configured).toBe(3); // N1: the REGISTRY's size, not the filter's
    expect(out.groups.map((g) => g.library)).toEqual(["hono"]);
    expect(formatSearchResults(out)).toContain("Searched 1 of 1 requested library (3 configured)");
  });

  it("filters by alias", () => {
    warmAll();
    const out = search({ query: "streaming", libraries: ["vercel-ai"] });
    expect(out.groups.map((g) => g.library)).toEqual(["ai-sdk"]);
  });

  it("reports an unknown name in the response instead of failing the search", () => {
    warmAll();
    const out = search({ query: "streaming", libraries: ["hono", "no-such-lib"] });
    expect(out.unknown).toEqual(["no-such-lib"]);
    expect(out.groups.map((g) => g.library)).toEqual(["hono"]);
    expect(formatSearchResults(out)).toContain('Unknown library "no-such-lib" in the filter — ignored.');
  });
});

describe("runSearch · what the response tells the agent (PAR-659, D-35)", () => {
  it("names how many libraries were searched of how many are configured, and suggests warm", () => {
    warmAll(["hono"]);
    const text = formatSearchResults(search({ query: "streaming" }));
    expect(text).toContain("Searched 1 of 3 configured libraries");
    expect(text).toContain("Not cached, so not searched: ai-sdk, next.js.");
    expect(text).toContain("`vibectx warm`");
    expect(text).toContain("get_docs");
  });

  it("omits the warm suggestion when every configured library is cached", () => {
    warmAll();
    const text = formatSearchResults(search({ query: "streaming" }));
    expect(text).toContain("Searched 3 of 3 configured libraries");
    expect(text).not.toContain("Not cached");
  });

  it("carries a Source line per library and a staleness marker for a cached copy past TTL", () => {
    warmAll();
    const stale: Registry = { entries: new Map([["hono", { name: "hono", urls: [HONO_URL], ttlHours: 0 }]]) };
    const text = formatSearchResults(runSearch(stale, { query: "streaming" }));
    expect(text).toContain(`Source: ${HONO_URL}`);
    expect(text).toMatch(/> Stale: cached \d{4}-\d{2}-\d{2}T/);
    expect(text).toContain("vibectx refresh hono");
  });

  it("zero matches is an honest message naming the libraries searched", () => {
    warmAll();
    const out = search({ query: "kubernetes helm chart" });
    expect(out.groups).toEqual([]);
    expect(searchExitCode(out)).toBe(1);
    const text = formatSearchResults(out);
    expect(text).toContain('No sections matched "kubernetes helm chart"');
    expect(text).toContain("searched 3 cached libraries: hono, ai-sdk, next.js");
  });

  it("an empty cache says so rather than pretending to have looked", () => {
    const out = search({ query: "streaming" });
    expect(out.searched).toBe(0);
    expect(formatSearchResults(out)).toContain("no library has a cached document to search");
  });

  it("D-41: an over-long query is bounded at the ranking path itself, whatever the caller did", () => {
    warmAll();
    // MEASURED before this bound: a 200,000-term query built a 200,000-wide `tf` vector per
    // section and exhausted a 2 GB heap — which, in the MCP server, kills every tool at once.
    const huge = Array.from({ length: 200_000 }, (_, i) => `term${i}`).join(" ");
    const out = search({ query: `streaming ${huge}` });
    expect(out.notes.join(" ")).toContain(`clipped to its first ${MAX_QUERY_CHARS} characters`);
    expect(out.query.length).toBeLessThanOrEqual(200);
    // Still a real search: the terms that survived the clip did their work.
    expect(out.groups.length).toBeGreaterThanOrEqual(1);
  });

  it("a query with no searchable terms is a note, not a crash", () => {
    warmAll();
    const out = search({ query: "!!! ???" });
    expect(out.groups).toEqual([]);
    expect(out.notes.join(" ")).toContain("no searchable terms");
  });

  it("searchToolText never throws, even when the cache root cannot be read", () => {
    warmAll();
    expect(searchToolText(registry(), { query: "streaming" })).toContain("Source:");
    process.env.DOCS_CACHE_DIR = join(dir, "does", "not", "exist");
    expect(searchToolText(registry(), { query: "streaming" })).toContain("No sections matched");
  });

  it("the exit code is 0 with hits and 1 without", () => {
    warmAll();
    expect(searchExitCode(search({ query: "streaming" }))).toBe(0);
    expect(searchExitCode(search({ query: "kubernetes" }))).toBe(1);
    expect(search({ query: "streaming" }).schemaVersion).toBe(SEARCH_SCHEMA_VERSION);
  });
});

describe("runSearch · the index is a derived cache (PAR-659, D-33)", () => {
  it("builds the index on the first search and reuses it on the second", () => {
    warmAll();
    const cold = search({ query: "streaming" });
    expect(cold.tokenized).toBe(3);
    expect(cold.fromIndex).toBe(0);
    expect(cold.indexWritten).toBe(true);
    const warm = search({ query: "streaming" });
    expect(warm.tokenized).toBe(0);
    expect(warm.fromIndex).toBe(3);
    expect(warm.indexWritten).toBe(false);
  });

  it("gives the SAME answer with the index, without it, and with it deleted mid-life", () => {
    warmAll();
    const built = formatSearchResults(search({ query: "server-sent events streaming" }));
    const fromIndex = formatSearchResults(search({ query: "server-sent events streaming" }));
    rmSync(searchIndexPath(), { force: true });
    const rebuilt = formatSearchResults(search({ query: "server-sent events streaming" }));
    expect(fromIndex).toBe(built);
    expect(rebuilt).toBe(built);
  });

  it("a hash that does not match the cached document is IGNORED and re-indexed", () => {
    warmAll(["hono"]);
    search({ query: "streaming" }); // builds it
    // A planted entry: a real posting list for text the cache does not hold.
    const planted = indexDocument(HONO_URL, "# Hono\n\n## Kubernetes\n\nhelm chart values", "2026-09-06T06:00:00.000Z")!;
    writeIndex(new Map([["hono", planted]]));
    const out = search({ query: "kubernetes helm chart" });
    expect(out.tokenized).toBe(1); // the plant was refused and the real document re-indexed
    expect(out.groups).toEqual([]); // the cache holds no kubernetes text, so nothing matches
    expect(readIndex().libraries.get("hono")!.hash).toBe(documentHash(HONO_DOC));
  });

  it("an entry whose URL is not the one being served is ignored", () => {
    warmAll(["hono"]);
    const doc = indexDocument("https://example.com/other.txt", HONO_DOC, "2026-09-06T06:00:00.000Z")!;
    writeIndex(new Map([["hono", doc]]));
    const out = search({ query: "streaming" });
    expect(out.tokenized).toBe(1);
    expect(readIndex().libraries.get("hono")!.url).toBe(HONO_URL);
  });

  it("a corrupt index file costs time, never correctness", () => {
    warmAll();
    const good = search({ query: "streaming" });
    mkdirSync(dir, { recursive: true });
    writeFileSync(searchIndexPath(), "{ not json at all", "utf8");
    const out = search({ query: "streaming" });
    expect(out.notes.join(" ")).toMatch(/unreadable/);
    // Same libraries, same sections, same order, same bodies — only the note is new.
    expect(out.groups.map((g) => [g.library, g.sections.map((s) => [s.heading, s.body])])).toEqual(
      good.groups.map((g) => [g.library, g.sections.map((s) => [s.heading, s.body])]),
    );
    expect(formatSearchResults(out).startsWith(formatSearchResults(good).split("\n\nSearched ")[0])).toBe(true);
  });

  it("K2: a NEWER index on disk is neither read nor overwritten; the search still answers", () => {
    warmAll(["hono"]);
    mkdirSync(dir, { recursive: true });
    const foreign = JSON.stringify({ schemaVersion: SEARCH_INDEX_SCHEMA_VERSION + 1, libraries: {} });
    writeFileSync(searchIndexPath(), foreign, "utf8");
    const notes: string[] = [];
    const out = runSearch(registry(), { query: "streaming", warn: (m) => notes.push(m) });
    expect(out.groups[0].library).toBe("hono");
    expect(out.indexWritten).toBe(false);
    expect(readFileSync(searchIndexPath(), "utf8")).toBe(foreign);
    expect(notes.join("")).toMatch(/newer schemaVersion/);
  });
});

describe("runSearch · invalidation on refresh (PAR-659, D-34 — the done-when case)", () => {
  it("invalidating a library drops its posting list and the next search rebuilds it from the cache", () => {
    warmAll();
    search({ query: "streaming" }); // the cold call that builds the index
    expect(search({ query: "streaming" }).fromIndex).toBe(3);
    expect(invalidateIndex("hono")).toBe(true);
    expect([...readIndex().libraries.keys()].sort()).toEqual(["ai-sdk", "next.js"]);

    const after = search({ query: "streaming" });
    expect(after.tokenized).toBe(1); // hono only
    expect(after.fromIndex).toBe(2);
    expect([...readIndex().libraries.keys()].sort()).toEqual(["ai-sdk", "hono", "next.js"]);
  });

  it("a refreshed document is picked up even when nothing invalidated the index", () => {
    warmAll(["hono"]);
    search({ query: "streaming" });
    resetSearchIndexMemo(); // a new process
    writeCache("hono", HONO_URL, `${HONO_DOC}\n\n## Websockets\n\nUpgrade the connection with upgradeWebSocket.`);
    const out = search({ query: "websockets upgrade connection" });
    expect(out.tokenized).toBe(1);
    expect(out.groups[0].sections[0].heading).toBe("Websockets");
    expect(readIndex().libraries.get("hono")!.hash).not.toBe(documentHash(HONO_DOC));
  });
});

/**
 * The README's `search` example is REAL output of this code against a fixture, not a capture
 * from any vendor's documentation site — the same discipline the snippets example follows
 * (PAR-658's honesty finding). `acme-pay` and `acme-edge` are made-up libraries on a
 * reserved documentation domain (RFC 2606). If the renderer changes, this fails and the
 * README must be regenerated.
 */
describe("the README's search example (PAR-659)", () => {
  const PAY_URL = "https://docs.acme-pay.example.com/llms-full.txt";
  const EDGE_URL = "https://docs.acme-edge.example.com/llms-full.txt";
  const PAY = [
    "# Acme Pay",
    "",
    "## Webhooks",
    "",
    "### Listening for events",
    "",
    "Open a server-sent events stream to receive payment events as they happen:",
    "",
    "```js",
    "const events = acme.events.stream({ types: ['payment.succeeded'] });",
    "```",
  ].join("\n");
  const EDGE = [
    "# Acme Edge",
    "",
    "## Streaming responses",
    "",
    "Return a `ReadableStream` from a handler and Acme Edge flushes each chunk as it is produced.",
    "",
    "## Caching",
    "",
    "Set `cache-control` on the response to have the edge keep a copy.",
  ].join("\n");

  it("produces the README's search example verbatim", () => {
    writeCache("acme-pay", PAY_URL, PAY);
    writeCache("acme-edge", EDGE_URL, EDGE);
    const reg: Registry = {
      entries: new Map([
        ["acme-pay", { name: "acme-pay", urls: [PAY_URL] }],
        ["acme-edge", { name: "acme-edge", urls: [EDGE_URL] }],
      ]),
    };
    expect(formatSearchResults(runSearch(reg, { query: "server-sent events streaming" }))).toBe(
      [
        "# acme-pay",
        `Source: ${PAY_URL}`,
        "",
        "## Acme Pay > Webhooks > Listening for events",
        "",
        "Open a server-sent events stream to receive payment events as they happen:",
        "",
        "```js",
        "const events = acme.events.stream({ types: ['payment.succeeded'] });",
        "```",
        "",
        "# acme-edge",
        `Source: ${EDGE_URL}`,
        "",
        "## Acme Edge > Streaming responses",
        "",
        "Return a `ReadableStream` from a handler and Acme Edge flushes each chunk as it is produced.",
        "",
        "Searched 2 of 2 configured libraries; 2 matched.",
      ].join("\n"),
    );
  });
});

/**
 * PAR-659 — the two failure modes the excellence pass went looking for, and neither of which
 * any earlier case would have caught.
 */
describe("runSearch · what the budget reports, and where bodies come from (PAR-659)", () => {
  it("reports how many libraries MATCHED, not how many fitted the budget", () => {
    warmAll();
    const full = search({ query: "streaming server-sent events schema object" });
    expect(full.matchedLibraries).toBeGreaterThanOrEqual(2);

    const tight = search({ query: "streaming server-sent events schema object", maxTokens: 1 });
    expect(tight.groups).toHaveLength(1);
    expect(tight.matchedLibraries).toBe(full.matchedLibraries); // unchanged by the budget
    const text = formatSearchResults(tight);
    expect(text).toContain(`${full.matchedLibraries} matched, 1 shown within the budget`);
  });

  it("renders bodies through the entry it searched, not by name lookup — a registry whose map key differs from the entry name still answers", () => {
    writeCache("hono", HONO_URL, HONO_DOC);
    // The shape refresh.test.ts's S2 cases construct: the map KEY is not the entry's `name`.
    const odd: Registry = { entries: new Map([["hono-under-another-key", { name: "hono", urls: [HONO_URL] }]]) };
    const out = runSearch(odd, { query: "server-sent events streaming" });
    expect(out.groups).toHaveLength(1);
    expect(out.groups[0].library).toBe("hono");
    expect(out.groups[0].sections[0].body).toContain("streamSSE");
  });

  it("S1: a bidi-bearing 1 MB heading is cleaned and clipped in the OUTCOME, not just in the rendered text", () => {
    // MEASURED before this: `--json` copied `heading` and `path` straight out of the document,
    // so a 1 MB heading carrying U+202E (right-to-left override) reached the agent intact —
    // the rendered path obeyed D-30 and the structured one obeyed nothing.
    const url = "https://hostile.example.com/llms-full.txt";
    const hostile = `Streaming ‮${"A".repeat(1_000_000)}`;
    writeCache("hostile", url, `# ${hostile}\n\n## ‮Streaming events\n\nStream events to the client.`);
    const reg: Registry = { entries: new Map([["hostile", { name: "hostile", urls: [url] }]]) };

    const out = runSearch(reg, { query: "streaming events" });
    const section = out.groups[0].sections[0];
    const structured = JSON.stringify(out);
    expect(structured).not.toContain("‮");
    expect(section.heading.length).toBeLessThanOrEqual(200);
    for (const p of section.path) expect(p.length).toBeLessThanOrEqual(200);
    // …and the rendered text, which already obeyed D-30, still does.
    expect(formatSearchResults(out)).not.toContain("‮");
    // The BODY is untouched by cleaning (D-30: the body is the document) — only bounded.
    expect(section.body).toContain("Stream events to the client.");
  });

  it("D-33: every rendered body is text the cache actually holds, even when the index says otherwise", () => {
    warmAll();
    search({ query: "streaming" }); // build the index against the real documents

    // A planted index whose entries carry the RIGHT hashes for the wrong documents: the only
    // way an index can still be used and still be lying about which section is which.
    const swapped = new Map([
      ["hono", indexDocument(HONO_URL, AI_DOC, "2026-09-06T06:00:00.000Z")!],
      ["ai-sdk", indexDocument(AI_URL, HONO_DOC, "2026-09-06T06:00:00.000Z")!],
    ]);
    writeIndex(swapped);

    const out = search({ query: "streaming server-sent events schema object route params" });
    const cached: Record<string, string> = { hono: HONO_DOC, "ai-sdk": AI_DOC, "next.js": NEXT_DOC };
    for (const g of out.groups) {
      for (const s of g.sections) {
        // The invariant D-33 exists for: the body is a substring of THAT library's cached
        // document. No index, planted or otherwise, can put a word here the cache does not hold.
        expect(cached[g.library]).toContain(s.body);
      }
    }
    // And the plant was refused outright — the hashes describe the other library's document.
    expect(out.tokenized).toBe(3);
  });
});
