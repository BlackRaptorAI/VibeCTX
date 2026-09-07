import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeCache, readCache, urlSlug } from "../src/cache.js";
import {
  cacheCapBytes,
  cacheEvictionStats,
  enforceCacheSizeCap,
  lastEvictionSummary,
  noteCacheWrite,
  resetCacheEvictionState,
  sweepThresholdBytes,
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

  it("never evicts the document whose own write triggered the sweep, even when it is the oldest", () => {
    // R3 narrowed "written in this run" to "written since the last sweep" — this is the case
    // the protection actually exists for, and it is unchanged: a write cannot be undone by the
    // sweep that same write triggers. Written by hand rather than through `seed` so that its
    // `fetchedAt` is already the oldest at the moment the sweep runs (`seed` back-dates the
    // meta only after `writeCache` has returned, i.e. after the sweep).
    seed("react", "old", 4000, "2020-01-01T00:00:00.000Z");
    resetCacheEvictionState(); // "old" now belongs to a previous run
    mkdirSync(join(dir, "react"), { recursive: true });
    writeFileSync(contentPath("react", "fresh"), "x".repeat(4000), "utf8");
    writeFileSync(metaPath("react", "fresh"), JSON.stringify({ url: url("fresh"), fetchedAt: "1999-01-01T00:00:00.000Z" }), "utf8");
    process.env.VIBECTX_CACHE_MAX_MB = String(5000 / (1024 * 1024));
    const summary = noteCacheWrite(dir, contentPath("react", "fresh"), 4000)!;

    expect(summary.evicted.map((e) => e.document)).toEqual([urlSlug(url("old"))]);
    expect(summary.protectedFromEviction).toBe(1); // "fresh" was older but is this write
    expect(existsSync(contentPath("react", "fresh"))).toBe(true);
  });

  it("gives up honestly when everything left is protected", () => {
    resetCacheEvictionState();
    enforceCacheSizeCap(dir, { warn: () => {} }); // the process has swept once already
    seed("react", "a", 4000, "2020-01-01T00:00:00.000Z"); // both writes land in the same
    seed("react", "b", 4000, "2021-01-01T00:00:00.000Z"); // window, so both are protected
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

/**
 * PAR-652c review R3, MEASURED by the review gate before this change: twelve 1 MiB documents
 * written by ONE long-lived process against a 2 MB cap left 12,583,948 bytes on disk, zero
 * evictions and not one stderr line. Two mechanisms combined to produce that:
 *
 *   1. `writtenThisRun` never cleared, so in a server (which is one process for days) every
 *      document ever written was permanently protected — the protection was written for the
 *      warm loop and quietly became "the cap does not apply to this process".
 *   2. the sweep threshold was a flat 16 MiB, so 12 MiB of writes never triggered a second
 *      sweep at all. Fixing (1) alone would still have measured zero evictions.
 *
 * Both are closed here. The protection is now scoped to the write that triggered the sweep
 * (the fetch-evict-refetch loop it exists to prevent is a within-one-write problem), and the
 * threshold never exceeds half the cap, so the overshoot is bounded by the cap rather than by
 * a constant chosen for a 512 MB one.
 */
describe("a long-running process respects its cap (R3)", () => {
  /** Every regular byte under the cache root — the same set the cap counts. */
  function bytesOnDisk(root: string): number {
    let total = 0;
    for (const name of readdirSync(root)) {
      const path = join(root, name);
      const st = lstatSync(path);
      if (st.isFile()) total += st.size;
      else if (st.isDirectory()) for (const child of readdirSync(path)) total += lstatSync(join(path, child)).size;
    }
    return total;
  }

  it("twelve 1 MiB documents against a 2 MB cap end under the cap, not 6× over it", () => {
    process.env.VIBECTX_CACHE_MAX_MB = "2";
    resetCacheEvictionState();
    const notes: string[] = [];
    const warn = vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      notes.push(String(chunk));
      return true;
    });
    try {
      for (let i = 0; i < 12; i++) writeCache("react", url(`doc${i}`), "x".repeat(1024 * 1024));
    } finally {
      warn.mockRestore();
    }

    const cap = 2 * 1024 * 1024;
    // The bound the design promises: the cap, plus the sweep threshold (half the cap) it may
    // accumulate between sweeps, plus the one document that triggered the last sweep.
    expect(bytesOnDisk(dir)).toBeLessThanOrEqual(cap + cap / 2 + 1024 * 1024 + 4096);
    expect(bytesOnDisk(dir)).toBeLessThan(12 * 1024 * 1024); // the measured failure, ruled out
    expect(notes.filter((n) => n.includes("evicted")).length).toBeGreaterThan(0);
    expect(lastEvictionSummary()!.evicted.length).toBeGreaterThan(0);
    // The oldest documents went and the newest survived: this is LRU, not "delete something".
    expect(existsSync(contentPath("react", "doc0"))).toBe(false);
    expect(existsSync(contentPath("react", "doc11"))).toBe(true);
  });

  it("a document's protection lasts one sweep, not the life of the process", () => {
    process.env.VIBECTX_CACHE_MAX_MB = "1"; // roomy: sweep 1 evicts nothing
    resetCacheEvictionState();
    seed("react", "a", 4000, "2020-01-01T00:00:00.000Z"); // first write of the process ⇒ sweep 1

    // Squeeze the cap and write again, in the SAME process. Before R3, "a" was written by this
    // process and was therefore unevictable for ever; now its protection ended at sweep 1.
    process.env.VIBECTX_CACHE_MAX_MB = String(5000 / (1024 * 1024));
    const notes: string[] = [];
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      notes.push(String(chunk));
      return true;
    });
    try {
      seed("react", "b", 600_000, "2022-01-01T00:00:00.000Z"); // crosses the threshold ⇒ sweep 2
    } finally {
      stderr.mockRestore();
    }

    expect(cacheEvictionStats().sweeps).toBe(2);
    const summary = lastEvictionSummary()!;
    expect(summary.evicted.map((e) => e.document)).toEqual([urlSlug(url("a"))]);
    expect(summary.protectedFromEviction).toBe(1); // "b", the write that triggered this sweep
    expect(existsSync(contentPath("react", "a"))).toBe(false);
    expect(existsSync(contentPath("react", "b"))).toBe(true);
    expect(notes.some((n) => n.includes("evicted 1"))).toBe(true);
  });

  it("the sweep threshold is the smaller of 16 MiB and half the cap", () => {
    expect(sweepThresholdBytes({})).toBe(EVICTION_SWEEP_BYTES); // 512 MB default: unchanged
    expect(sweepThresholdBytes({ VIBECTX_CACHE_MAX_MB: "2" })).toBe(1024 * 1024);
    expect(sweepThresholdBytes({ VIBECTX_CACHE_MAX_MB: "0" })).toBe(EVICTION_SWEEP_BYTES); // cap off
    expect(sweepThresholdBytes({ VIBECTX_CACHE_MAX_MB: "0.000001" })).toBe(1); // never zero
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

/**
 * D-46 (oversight, PAR-652b) — the cache root must be PROVEN a real directory this tool
 * owns before a single `rmSync` runs.
 *
 * The security gate measured the alternative: with a symlink planted in the root position,
 * `enforceCacheSizeCap` walked through it and deleted `Documents/project/thesis.md` — a real
 * file it had never written. `scanCache` already refused to descend a symlinked LIBRARY
 * directory; the root itself was the one position where nothing checked.
 */
describe("D-46: the cache root is refused unless it is a real directory", () => {
  /** A directory of real user files, shaped so eviction would treat one as a document. */
  function userFiles(): { home: string; thesis: string; notes: string } {
    const home = mkdtempSync(join(tmpdir(), "vibectx-userfiles-"));
    mkdirSync(join(home, "project"), { recursive: true });
    const thesis = join(home, "project", "thesis.md");
    writeFileSync(thesis, "# My thesis\n" + "words ".repeat(2000), "utf8");
    writeFileSync(
      join(home, "project", "thesis.meta.json"),
      JSON.stringify({ url: "https://example.com/thesis.md", fetchedAt: "1999-01-01T00:00:00.000Z" }),
      "utf8",
    );
    const notes = join(home, "notes.md");
    writeFileSync(notes, "keep me", "utf8");
    return { home, thesis, notes };
  }

  it("evicts nothing at all through a symlinked root, and says so once", () => {
    const { home, thesis, notes } = userFiles();
    const parent = mkdtempSync(join(tmpdir(), "vibectx-linkroot-"));
    try {
      const linked = join(parent, "root");
      symlinkSync(home, linked);
      resetCacheEvictionState();
      process.env.VIBECTX_CACHE_MAX_MB = String(1000 / (1024 * 1024)); // far under: it WOULD evict

      const said: string[] = [];
      expect(enforceCacheSizeCap(linked, { warn: (m) => said.push(m) })).toBeUndefined();

      expect(existsSync(thesis)).toBe(true); // zero unlinks outside the real cache
      expect(existsSync(notes)).toBe(true);
      expect(existsSync(join(home, "project", "thesis.meta.json"))).toBe(true);
      expect(lastEvictionSummary()).toBeUndefined();
      expect(said).toHaveLength(1);
      expect(said[0]).toContain("symlink");
      expect(said[0]).toContain(linked);
    } finally {
      rmSync(parent, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("says it ONCE per root, however many sweeps run against it", () => {
    const { home } = userFiles();
    const parent = mkdtempSync(join(tmpdir(), "vibectx-linkroot-"));
    try {
      const linked = join(parent, "root");
      symlinkSync(home, linked);
      resetCacheEvictionState();
      process.env.VIBECTX_CACHE_MAX_MB = String(1000 / (1024 * 1024));
      const said: string[] = [];
      const warn = (m: string) => said.push(m);
      enforceCacheSizeCap(linked, { warn });
      enforceCacheSizeCap(linked, { warn });
      enforceCacheSizeCap(linked, { warn });
      expect(said).toHaveLength(1);
      expect(said[0]).toContain("symlink");
    } finally {
      rmSync(parent, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("refuses a root that exists but is not a directory", () => {
    const parent = mkdtempSync(join(tmpdir(), "vibectx-fileroot-"));
    try {
      const asFile = join(parent, "root");
      writeFileSync(asFile, "not a cache", "utf8");
      resetCacheEvictionState();
      process.env.VIBECTX_CACHE_MAX_MB = String(1 / (1024 * 1024));
      const said: string[] = [];
      expect(enforceCacheSizeCap(asFile, { warn: (m) => said.push(m) })).toBeUndefined();
      expect(said).toHaveLength(1);
      expect(said[0]).toContain("not a directory");
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it("a root that does not exist yet is not an attack — no note, nothing evicted", () => {
    const missing = join(dir, "no-such-cache");
    resetCacheEvictionState();
    process.env.VIBECTX_CACHE_MAX_MB = String(1 / (1024 * 1024));
    const said: string[] = [];
    const summary = enforceCacheSizeCap(missing, { warn: (m) => said.push(m) })!;
    expect(summary.evicted).toEqual([]);
    expect(said).toEqual([]);
  });

  it("still evicts normally on a real root — the guard costs the good case nothing", () => {
    seed("react", "a", 4000, "2020-01-01T00:00:00.000Z");
    seed("react", "b", 4000, "2021-01-01T00:00:00.000Z");
    resetCacheEvictionState();
    process.env.VIBECTX_CACHE_MAX_MB = String(5000 / (1024 * 1024));
    const said: string[] = [];
    const summary = enforceCacheSizeCap(dir, { warn: (m) => said.push(m) })!;
    expect(summary.evicted.map((e) => e.document)).toEqual([urlSlug(url("a"))]);
    expect(existsSync(contentPath("react", "a"))).toBe(false);
    expect(existsSync(contentPath("react", "b"))).toBe(true);
    expect(said.some((m) => m.includes("symlink"))).toBe(false);
  });
});
