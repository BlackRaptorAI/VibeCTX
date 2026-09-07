import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeCache, readCache, urlSlug } from "../src/cache.js";
import {
  cacheCapBytes,
  cacheEvictionStats,
  enforceCacheSizeCap,
  lastEvictionSummary,
  resetCacheEvictionState,
  DEFAULT_CACHE_MAX_MB,
  EVICTION_SWEEP_BYTES,
} from "../src/cache-evict.js";

/**
 * PAR-652 item 7a — the cache size cap and its LRU eviction. Nothing here is mocked: the
 * documents are real files under a real temporary cache root, and "evicted" means the file
 * is gone from disk and `readCache` no longer serves it.
 */

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "vibectx-evict-"));
  process.env.VIBECTX_CACHE_DIR = dir;
  delete process.env.VIBECTX_CACHE_MAX_MB;
  resetCacheEvictionState();
});
afterEach(() => {
  delete process.env.VIBECTX_CACHE_DIR;
  delete process.env.VIBECTX_CACHE_MAX_MB;
  resetCacheEvictionState();
  rmSync(dir, { recursive: true, force: true });
});

const url = (n: string) => `https://example.com/${n}.md`;
const contentPath = (library: string, n: string) => join(dir, library, `${urlSlug(url(n))}.md`);
const metaPath = (library: string, n: string) => join(dir, library, `${urlSlug(url(n))}.meta.json`);

/** Put a document in the cache and back-date its `fetchedAt` to a known instant. */
function seed(library: string, n: string, bytes: number, fetchedAt: string): void {
  writeCache(library, url(n), "x".repeat(bytes));
  const meta = JSON.parse(readFileSync(metaPath(library, n), "utf8")) as Record<string, unknown>;
  meta.fetchedAt = fetchedAt;
  writeFileSync(metaPath(library, n), JSON.stringify(meta, null, 2), "utf8");
}

describe("cacheCapBytes (VIBECTX_CACHE_MAX_MB)", () => {
  it("defaults to 512 MB — an ASSUMED figure, pinned so a change is deliberate", () => {
    expect(DEFAULT_CACHE_MAX_MB).toBe(512);
    expect(cacheCapBytes({})).toBe(512 * 1024 * 1024);
  });

  it("0 turns the cap off", () => {
    expect(cacheCapBytes({ VIBECTX_CACHE_MAX_MB: "0" })).toBeUndefined();
  });

  it("a typo falls back to the default rather than silently removing the bound", () => {
    expect(cacheCapBytes({ VIBECTX_CACHE_MAX_MB: "lots" })).toBe(512 * 1024 * 1024);
    expect(cacheCapBytes({ VIBECTX_CACHE_MAX_MB: "-5" })).toBe(512 * 1024 * 1024);
    expect(cacheCapBytes({ VIBECTX_CACHE_MAX_MB: "" })).toBe(512 * 1024 * 1024);
  });

  it("accepts a fractional cap", () => {
    expect(cacheCapBytes({ VIBECTX_CACHE_MAX_MB: "0.5" })).toBe(512 * 1024);
  });
});

describe("eviction", () => {
  it("does nothing while the cache is under the cap", () => {
    seed("react", "a", 1000, "2020-01-01T00:00:00.000Z");
    process.env.VIBECTX_CACHE_MAX_MB = "1";
    const summary = enforceCacheSizeCap(dir, { warn: () => {} })!;
    expect(summary.evicted).toEqual([]);
    expect(existsSync(contentPath("react", "a"))).toBe(true);
  });

  it("evicts least-recently-fetched first, and only as many as it takes", () => {
    seed("react", "a", 4000, "2020-01-01T00:00:00.000Z");
    seed("react", "b", 4000, "2021-01-01T00:00:00.000Z");
    seed("zod", "c", 4000, "2022-01-01T00:00:00.000Z");
    resetCacheEvictionState(); // a later run: nothing here was written by "this" run
    process.env.VIBECTX_CACHE_MAX_MB = String(9000 / (1024 * 1024)); // room for roughly two documents
    const notes: string[] = [];
    const summary = enforceCacheSizeCap(dir, { warn: (m) => notes.push(m) })!;

    expect(summary.evicted.map((e) => e.document)).toEqual([urlSlug(url("a"))]);
    expect(summary.evicted[0].fetchedAt).toBe("2020-01-01T00:00:00.000Z");
    expect(summary.totalBytesAfter).toBeLessThanOrEqual(summary.capBytes);
    expect(summary.stillOverCap).toBe(false);
    expect(existsSync(contentPath("react", "a"))).toBe(false);
    expect(existsSync(metaPath("react", "a"))).toBe(false); // the meta goes with the content
    expect(existsSync(contentPath("react", "b"))).toBe(true);
    expect(existsSync(contentPath("zod", "c"))).toBe(true);
    expect(readCache("react", url("a"), 168)).toBeUndefined();
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain("evicted 1");
  });

  it("never evicts a document written in this run, even when it is the oldest", () => {
    seed("react", "old", 4000, "2020-01-01T00:00:00.000Z");
    resetCacheEvictionState(); // "old" now belongs to a previous run
    seed("react", "fresh", 4000, "1999-01-01T00:00:00.000Z"); // written now, back-dated on purpose
    process.env.VIBECTX_CACHE_MAX_MB = String(5000 / (1024 * 1024));
    const summary = enforceCacheSizeCap(dir, { warn: () => {} })!;

    expect(summary.evicted.map((e) => e.document)).toEqual([urlSlug(url("old"))]);
    expect(summary.protectedFromEviction).toBe(1); // "fresh" was older but is this run's
    expect(existsSync(contentPath("react", "fresh"))).toBe(true);
  });

  it("gives up honestly when everything left is protected", () => {
    seed("react", "a", 4000, "2020-01-01T00:00:00.000Z");
    seed("react", "b", 4000, "2021-01-01T00:00:00.000Z");
    process.env.VIBECTX_CACHE_MAX_MB = String(1000 / (1024 * 1024));
    const notes: string[] = [];
    const summary = enforceCacheSizeCap(dir, { warn: (m) => notes.push(m) })!;

    expect(summary.evicted).toEqual([]);
    expect(summary.protectedFromEviction).toBe(2);
    expect(summary.stillOverCap).toBe(true);
    expect(notes.some((n) => n.includes("still"))).toBe(true);
    expect(existsSync(contentPath("react", "a"))).toBe(true);
  });

  it("counts non-document files toward the cap but never evicts them", () => {
    writeFileSync(join(dir, "resolved.json"), "y".repeat(6000), "utf8");
    mkdirSync(join(dir, "projects"), { recursive: true });
    writeFileSync(join(dir, "projects", "p.json"), "z".repeat(1000), "utf8");
    seed("react", "a", 1000, "2020-01-01T00:00:00.000Z");
    resetCacheEvictionState();
    process.env.VIBECTX_CACHE_MAX_MB = String(5000 / (1024 * 1024));
    const summary = enforceCacheSizeCap(dir, { warn: () => {} })!;

    expect(summary.totalBytesBefore).toBeGreaterThan(7000); // the two stores are counted
    expect(summary.evicted.map((e) => e.document)).toEqual([urlSlug(url("a"))]);
    expect(existsSync(join(dir, "resolved.json"))).toBe(true);
    expect(existsSync(join(dir, "projects", "p.json"))).toBe(true);
    expect(summary.stillOverCap).toBe(true); // and the cap gives way rather than the stores
  });

  it("a document whose meta is unreadable sorts as oldest and goes first", () => {
    seed("react", "a", 4000, "2024-01-01T00:00:00.000Z");
    seed("react", "b", 4000, "2020-01-01T00:00:00.000Z");
    writeFileSync(metaPath("react", "a"), "{not json", "utf8");
    resetCacheEvictionState();
    process.env.VIBECTX_CACHE_MAX_MB = String(5000 / (1024 * 1024));
    const summary = enforceCacheSizeCap(dir, { warn: () => {} })!;
    expect(summary.evicted[0].document).toBe(urlSlug(url("a")));
    expect(summary.evicted[0].fetchedAt).toBeUndefined();
  });

  it("never descends or deletes through a symlinked library directory", () => {
    const outside = mkdtempSync(join(tmpdir(), "vibectx-outside-"));
    try {
      writeFileSync(join(outside, `${urlSlug(url("victim"))}.md`), "v".repeat(9000), "utf8");
      writeFileSync(join(outside, `${urlSlug(url("victim"))}.meta.json`), JSON.stringify({ url: url("victim"), fetchedAt: "1999-01-01T00:00:00.000Z" }), "utf8");
      symlinkSync(outside, join(dir, "planted"));
      seed("react", "a", 4000, "2020-01-01T00:00:00.000Z");
      resetCacheEvictionState();
      process.env.VIBECTX_CACHE_MAX_MB = String(1000 / (1024 * 1024));
      const summary = enforceCacheSizeCap(dir, { warn: () => {} })!;
      expect(summary.evicted.map((e) => e.library)).toEqual(["react"]);
      expect(existsSync(join(outside, `${urlSlug(url("victim"))}.md`))).toBe(true);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("is switched off entirely by VIBECTX_CACHE_MAX_MB=0", () => {
    seed("react", "a", 4000, "2020-01-01T00:00:00.000Z");
    resetCacheEvictionState();
    process.env.VIBECTX_CACHE_MAX_MB = "0";
    expect(enforceCacheSizeCap(dir, { warn: () => {} })).toBeUndefined();
    expect(existsSync(contentPath("react", "a"))).toBe(true);
  });
});

describe("the sweep is bounded — writeCache does not stat the world on every write", () => {
  it("sweeps once on the first write of a process, then not again until 16 MiB have been written", () => {
    expect(EVICTION_SWEEP_BYTES).toBe(16 * 1024 * 1024);
    writeCache("react", url("a"), "x".repeat(1000));
    expect(cacheEvictionStats().sweeps).toBe(1); // the first write always sweeps
    for (let i = 0; i < 20; i++) writeCache("react", url(`n${i}`), "x".repeat(1000));
    expect(cacheEvictionStats().sweeps).toBe(1); // 20 KB is nowhere near the threshold
    expect(cacheEvictionStats().bytesSinceSweep).toBe(20 * 1000);
  });

  it("sweeps again once the accumulated bytes cross the threshold", () => {
    writeCache("react", url("a"), "x".repeat(10));
    expect(cacheEvictionStats().sweeps).toBe(1);
    writeCache("react", url("big"), "x".repeat(EVICTION_SWEEP_BYTES + 1));
    expect(cacheEvictionStats().sweeps).toBe(2);
    expect(cacheEvictionStats().bytesSinceSweep).toBe(0);
  });

  it("a write over the cap evicts through writeCache itself, and the summary is readable afterwards", () => {
    seed("react", "old", 4000, "2020-01-01T00:00:00.000Z");
    resetCacheEvictionState(); // "old" belongs to a previous run
    process.env.VIBECTX_CACHE_MAX_MB = String(5000 / (1024 * 1024));
    writeCache("zod", url("new"), "x".repeat(4000)); // first write of this run ⇒ sweeps

    const summary = lastEvictionSummary()!;
    expect(summary.evicted.map((e) => e.library)).toEqual(["react"]);
    expect(existsSync(contentPath("react", "old"))).toBe(false);
    expect(existsSync(contentPath("zod", "new"))).toBe(true); // the document just written survives
  });
});

describe("doctor reports what was evicted", () => {
  it("names the evicted documents, the freed bytes and the cap — and says nothing when nothing was evicted", async () => {
    const { formatDoctorTable, DOCTOR_SCHEMA_VERSION } = await import("../src/doctor.js");
    const report = {
      schemaVersion: DOCTOR_SCHEMA_VERSION,
      generatedAt: "2026-09-07T00:00:00.000Z",
      libraries: [],
      healthy: 0,
      total: 0,
    };

    expect(formatDoctorTable(report)).not.toContain("evicted");

    seed("react", "old", 4000, "2020-01-01T00:00:00.000Z");
    resetCacheEvictionState();
    process.env.VIBECTX_CACHE_MAX_MB = String(5000 / (1024 * 1024));
    writeCache("zod", url("new"), "x".repeat(4000));

    const text = formatDoctorTable(report);
    expect(text).toContain("cache: evicted 1 least-recently-fetched document(s)");
    expect(text).toContain("VIBECTX_CACHE_MAX_MB");
    expect(text).toContain(`react/${urlSlug(url("old"))}`);
  });
});
