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
const { openIndexSession, readIndex, resetSearchIndexMemo, searchIndexPath, writeIndex, indexDocument, documentHash } =
  await import("../src/search-index.js");
const { runWarm } = await import("../src/warm.js");
type Registry = import("../src/registry.js").Registry;

let cache: string;
let project: string;

beforeEach(() => {
  cache = mkdtempSync(join(tmpdir(), "vibectx-session-cache-"));
  project = mkdtempSync(join(tmpdir(), "vibectx-session-proj-"));
  process.env.DOCS_CACHE_DIR = cache;
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
  delete process.env.DOCS_CACHE_DIR;
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
});
