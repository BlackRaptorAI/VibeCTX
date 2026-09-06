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
  SEARCH_INDEX_SCHEMA_VERSION,
} from "../src/search-index.js";
import { formatSearchResults, runSearch, searchExitCode, searchToolText, SEARCH_SCHEMA_VERSION } from "../src/search.js";

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

describe("runSearch · the budget (PAR-659, D-35)", () => {
  it("always returns at least one section from the best-scoring library, however small the budget", () => {
    warmAll();
    const out = search({ query: "server-sent events streaming", maxTokens: 1 });
    expect(out.groups).toHaveLength(1);
    expect(out.groups[0].sections).toHaveLength(1);
    expect(out.groups[0].sections[0].body.length).toBeGreaterThan(0);
  });

  it("spends the budget ACROSS libraries, not depth-first into the first one", () => {
    warmAll();
    // A budget with room for a few sections: the second library must get one before the first
    // library gets its second.
    const out = search({ query: "server-sent events streaming", maxTokens: 60 });
    expect(out.groups.length).toBeGreaterThanOrEqual(2);
    expect(out.groups[0].sections).toHaveLength(1);
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

describe("runSearch · the libraries filter (PAR-659, D-35)", () => {
  it("filters by canonical name", () => {
    warmAll();
    const out = search({ query: "streaming", libraries: ["hono"] });
    expect(out.configured).toBe(1);
    expect(out.groups.map((g) => g.library)).toEqual(["hono"]);
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
