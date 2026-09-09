import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * PAR-659 · R2 — ONE RUN, ONE READ.
 *
 * `warm` and the startup autowarm write thirty primary documents in a row. The first cut called
 * `indexCachedDocument` per library, and each call parsed the WHOLE index file to find out
 * whether it had anything to do — MEASURED by the review gate: 7,529 ms added to an
 * already-fresh 30-library / 150 MB warm for zero index change.
 *
 * Counting reads is the only honest way to pin that, because the cost is invisible in the
 * result: the index is byte-identical either way. `node:fs` is wrapped here with a counter that
 * delegates to the real implementation, so every module in the run — search-index, atomic-store,
 * cache — reads through it and nothing else changes.
 */

const reads = vi.hoisted(() => ({ index: 0 }));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const readFileSync = (path: unknown, ...rest: unknown[]) => {
    if (typeof path === "string" && path.endsWith("index.json")) reads.index += 1;
    return (actual.readFileSync as (...a: unknown[]) => unknown)(path, ...rest);
  };
  return { ...actual, default: { ...actual, readFileSync }, readFileSync };
});

const { writeCache } = await import("../src/cache.js");
const {
  openIndexSession,
  readIndex,
  resetSearchIndexMemo,
  searchIndexPath,
  writeIndex,
  indexDocument,
  documentHash,
  MAX_INDEX_FILE_BYTES,
  SEARCH_INDEX_SCHEMA_VERSION,
} = await import("../src/search-index.js");
const { RETRIEVAL_VERSION } = await import("../src/tokenize.js");
const { runWarm } = await import("../src/warm.js");
type Registry = import("../src/registry.js").Registry;

let cache: string;
let project: string;

beforeEach(() => {
  cache = mkdtempSync(join(tmpdir(), "vibectx-session-cache-"));
  project = mkdtempSync(join(tmpdir(), "vibectx-session-proj-"));
  process.env.VIBECTX_CACHE_DIR = cache;
  resetSearchIndexMemo();
  reads.index = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("this run is offline");
    }),
  );
});

afterEach(() => {
  delete process.env.VIBECTX_CACHE_DIR;
  rmSync(cache, { recursive: true, force: true });
  rmSync(project, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

const LIBRARIES = 12;

/** A project whose dependencies are all cached already — the shape R2's measurement was taken on. */
function cachedProject(): Registry {
  const entries = new Map<string, { name: string; urls: string[] }>();
  const deps: Record<string, string> = {};
  for (let i = 0; i < LIBRARIES; i++) {
    const name = `lib-${i}`;
    const url = `https://lib${i}.example.com/llms.txt`;
    writeCache(name, url, `# ${name}\n\n## Streaming\n\nStream server-sent events to the client from ${name}.`);
    entries.set(name, { name, urls: [url] });
    deps[name] = "1";
  }
  writeFileSync(join(project, "package.json"), JSON.stringify({ name: "app", dependencies: deps }), "utf8");
  return { entries };
}

describe("R2 · one index read per run, not one per library (PAR-659)", () => {
  it("a 12-library warm reads the index a handful of times, not once per library", async () => {
    const registry = cachedProject();
    const report = await runWarm(registry, { dir: project, offline: true });
    expect(report.cached).toBe(LIBRARIES);

    // Session: one lazy read on the first library, one read at flush, one inside the write's
    // newer-schemaVersion check. Per-library it was three times TWELVE.
    expect(reads.index).toBeLessThanOrEqual(4);
    expect(readIndex().libraries.size).toBe(LIBRARIES);
  });

  it("an ALREADY-FRESH second warm reads the index once and writes nothing — the case that cost 7.5 s", async () => {
    const registry = cachedProject();
    await runWarm(registry, { dir: project, offline: true });
    resetSearchIndexMemo(); // a new process: the memo cannot short-circuit anything
    const before = readIndex().libraries.size;
    reads.index = 0;

    await runWarm(registry, { dir: project, offline: true });
    expect(reads.index).toBeLessThanOrEqual(2); // the lazy read, and nothing more to do
    expect(readIndex().libraries.size).toBe(before);
  });

  it("the flush MERGES rather than clobbers: an entry written by another process survives", () => {
    writeCache("mine", "https://mine.example.com/llms.txt", "# Mine\n\n## Streaming\n\nStream events.");
    const session = openIndexSession(() => {});
    session.add("mine", "https://mine.example.com/llms.txt", "# Mine\n\n## Streaming\n\nStream events.");

    // …and now "another process" writes an entry this session has never heard of, AFTER the
    // session took its snapshot.
    const theirs = indexDocument("https://theirs.example.com/llms.txt", "# Theirs\n\n## Caching\n\nCache it.", "2026-09-06T00:00:00.000Z")!;
    const merged = readIndex().libraries;
    merged.set("theirs", theirs);
    writeIndex(merged, () => {});

    expect(session.flush()).toBe(true);
    const after = readIndex().libraries;
    expect([...after.keys()].sort()).toEqual(["mine", "theirs"]);
    expect(after.get("theirs")!.hash).toBe(documentHash("# Theirs\n\n## Caching\n\nCache it."));
  });

  it("flushing twice writes once; flushing an empty session writes nothing", () => {
    const session = openIndexSession(() => {});
    expect(session.flush()).toBe(false);
    session.add("solo", "https://solo.example.com/llms.txt", "# Solo\n\n## Streaming\n\nStream events.");
    expect(session.flush()).toBe(true);
    expect(session.flush()).toBe(false);
    expect([...readIndex().libraries.keys()]).toEqual(["solo"]);
    expect(searchIndexPath().endsWith("index.json")).toBe(true);
  });

  /** A3 (PAR-716), round 2 (test-auditor, F5) — `remove()` mirrors `add()`'s `validLibraryKey`
   *  guard, but no caller in this codebase ever offers `remove()` an invalid key (`refresh.ts`
   *  only ever passes a Registry-resolved `entry.name`), so the guard is unreachable through
   *  integration tests. Direct unit test instead. */
  it("remove() ignores an invalid key rather than forcing a read+write for a delete that could never match anything", () => {
    const session = openIndexSession(() => {});
    session.remove(""); // empty after trim: not a valid library key
    session.remove("   ");
    expect(session.flush()).toBe(false); // nothing pending — the invalid removals never landed
    expect(readIndex().libraries.size).toBe(0);
  });

  it("remove() supersedes a PRIOR add() in the same session — the last call for a library wins", () => {
    const session = openIndexSession(() => {});
    session.add("solo", "https://solo.example.com/llms.txt", "# Solo\n\n## Streaming\n\nStream events.");
    session.remove("solo");
    expect(session.flush()).toBe(true); // the removal still needs a write, even though nothing survives it
    expect(readIndex().libraries.has("solo")).toBe(false);
  });
});

/**
 * PAR-659 · D-42 — THE MEMO RECORDS WHAT WAS WRITTEN, NOT WHAT WAS OFFERED.
 *
 * `flush()` set the in-process memo for every pending entry whenever `writeIndex` returned
 * true — and `writeIndex` returns true when it SHED entries to stay inside the read limit, so a
 * library that never reached the file was recorded as though it had. The next session in that
 * process then short-circuited on the memo, put nothing in `pending`, and `flush()` returned
 * false: a warm or a get_docs reporting "nothing to do" about a library the index does not
 * hold. Whether a payload sheds depends on what else is in the file, so the honest behaviour is
 * to offer it again — the per-process shed memo (D-42, search-index.ts) is what stops the
 * SEARCH path paying for it on every call.
 */
describe("D-42 · the session memo records only entries that were written (PAR-659)", () => {
  const AT = "2026-09-06T00:00:00.000Z";
  const URL_ = "https://shed.example.com/llms-full.txt";

  /** A document with globally unique vocabulary: its posting list is the file's largest entry. */
  function uniqueDoc(sections: number): string {
    const lines = ["# shed", ""];
    for (let s = 0; s < sections; s++) {
      lines.push(`## shedding heading ${s}`, "");
      for (let p = 0; p < 4; p++) {
        const words: string[] = [];
        for (let k = 0; k < 30; k++) words.push(`shedword${s}x${p}y${k}`);
        lines.push(words.join(" "), "");
      }
    }
    return lines.join("\n");
  }

  /** An index file just under the read limit, in entries each far smaller than `entryBytes`, so
   *  the entry the session offers is the largest and therefore the one D-40 sheds. */
  function plantNearlyFull(entryBytes: number): void {
    const SECTIONS = 1000;
    const lengths = new Array(SECTIONS).fill(1).join(",");
    const chunk = Array.from({ length: SECTIONS }, (_, i) => `${i},1`).join(",");
    const head = `{"url":"https://planted.example.com/llms.txt","fetchedAt":"${AT}","hash":"0123456789abcdef","lengths":[${lengths}],"postings":{"t":[`;
    const parts: string[] = [];
    let bytes = head.length + 3;
    while (bytes < Math.floor(entryBytes / 10)) {
      parts.push(chunk);
      bytes += chunk.length + 1;
    }
    const entry = `${head}${parts.join(",")}]}}`;
    const count = Math.floor((MAX_INDEX_FILE_BYTES - Math.floor(entryBytes / 2)) / (entry.length + 8));
    const libraries = Array.from({ length: count }, (_, i) => `"p${i}":${entry}`).join(",");
    writeFileSync(
      searchIndexPath(),
      `{"schemaVersion":${SEARCH_INDEX_SCHEMA_VERSION},"retrievalVersion":${RETRIEVAL_VERSION},"libraries":{${libraries}}}`,
      "utf8",
    );
  }

  it("a SHED library is offered again by the next session, not reported as already written", () => {
    const doc = uniqueDoc(400);
    const built = indexDocument(URL_, doc, AT)!;
    const postings: Record<string, number[]> = {};
    for (const [term, list] of built.postings) postings[term] = list;
    plantNearlyFull(
      Buffer.byteLength(
        JSON.stringify({ url: built.url, fetchedAt: built.fetchedAt, hash: built.hash, lengths: built.lengths, postings }),
        "utf8",
      ) + 8,
    );
    expect(readIndex().problem).toBeUndefined(); // the fixture is a file this build reads

    const notes: string[] = [];
    const first = openIndexSession((m) => notes.push(m));
    first.add("shed", URL_, doc, AT);
    expect(first.flush()).toBe(true); // the file WAS written — without this entry
    expect(notes.join("")).toMatch(/would exceed the \d+-byte limit/);
    expect(readIndex().libraries.has("shed")).toBe(false);

    // The claim: the memo did not record it, so this session has work to do. Before the fix
    // `flush()` returned false here — "nothing to do" about a library the file does not hold.
    const second = openIndexSession(() => {});
    second.add("shed", URL_, doc, AT);
    expect(second.flush()).toBe(true);
    // …and a library that WAS written is still short-circuited: the memo keeps its purpose.
    const third = openIndexSession(() => {});
    third.add("mine", "https://mine.example.com/llms.txt", "# Mine\n\n## Streaming\n\nStream events.");
    expect(third.flush()).toBe(true);
    const fourth = openIndexSession(() => {});
    fourth.add("mine", "https://mine.example.com/llms.txt", "# Mine\n\n## Streaming\n\nStream events.");
    expect(fourth.flush()).toBe(false);
  }, 300_000);
});
