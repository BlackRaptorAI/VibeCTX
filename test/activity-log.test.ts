import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync, readdirSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  recordActivity,
  readActivityEntries,
  readActivityLog,
  toActivityEntry,
  formatActivityLogTable,
  activityLogPath,
  shouldLog,
  ACTIVITY_LOG_SCHEMA_VERSION,
  ACTIVITY_LOG_OFF_ENV,
  ACTIVITY_TOOLS,
  ACTIVITY_OUTCOMES,
  type ActivityEntry,
} from "../src/activity-log.js";
import { ACTIVITY_LOG_MAX_ENTRIES } from "../src/limits.js";
import { writeAtomic } from "../src/atomic-store.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "vibectx-activity-log-"));
  process.env.VIBECTX_CACHE_DIR = dir;
});

afterEach(() => {
  delete process.env.VIBECTX_CACHE_DIR;
  delete process.env[ACTIVITY_LOG_OFF_ENV];
  rmSync(dir, { recursive: true, force: true });
});

const base: Omit<ActivityEntry, "timestamp"> = {
  tool: "get_docs",
  library: "react",
  query: "useEffect cleanup",
  url: "https://react.dev/llms-full.txt",
  contentHash: "0123456789abcdef",
  fresh: true,
  outcome: "matched",
};

describe("shouldLog (D-51: off switch, mirrors shouldAutowarm exactly)", () => {
  it("on by default; off only for an explicit truthy value; '0'/'false'/'' stay on", () => {
    expect(shouldLog({})).toBe(true);
    expect(shouldLog({ VIBECTX_NO_LOG: "1" })).toBe(false);
    expect(shouldLog({ VIBECTX_NO_LOG: "true" })).toBe(false);
    expect(shouldLog({ VIBECTX_NO_LOG: "yes" })).toBe(false);
    expect(shouldLog({ VIBECTX_NO_LOG: "0" })).toBe(true);
    expect(shouldLog({ VIBECTX_NO_LOG: "false" })).toBe(true);
    expect(shouldLog({ VIBECTX_NO_LOG: "" })).toBe(true);
  });
});

describe("activity log (<cacheRoot>/activity.json)", () => {
  it("lives under the cache root and reads as empty when absent", () => {
    expect(activityLogPath()).toBe(join(dir, "activity.json"));
    expect(readActivityEntries()).toEqual([]);
  });

  /**
   * PAR-805 (mutation target: readActivityEntries's isRegularFile guard) — before this,
   * `readActivityEntries` called a bare `readFileSync(activityLogPath(), "utf8")` with no
   * `lstat` guard at all, so a symlink planted at `activity.json`'s own path was followed and
   * its target's bytes parsed as if they were the log. `isRegularFile` (`atomic-store.ts`)
   * refuses it the same way a missing or corrupt file already reads: as `[]`, never a throw.
   */
  it("PAR-805: readActivityEntries refuses a symlink planted at activity.json's own path — reads back empty, not through the link", () => {
    recordActivity(base, { now: () => new Date("2026-09-17T18:00:00.000Z") });
    expect(readActivityEntries()).toHaveLength(1); // the real file round-trips first
    const sibling = join(dir, "sibling.json");
    writeFileSync(sibling, JSON.stringify({ schemaVersion: ACTIVITY_LOG_SCHEMA_VERSION, entries: [{ ...base, timestamp: "2020-01-01T00:00:00.000Z" }] }), "utf8");
    rmSync(activityLogPath(), { force: true });
    symlinkSync(sibling, activityLogPath());

    let entries: ReturnType<typeof readActivityEntries>;
    expect(() => {
      entries = readActivityEntries();
    }).not.toThrow();
    expect(entries!).toEqual([]);
  });

  it("round-trips an entry, creating the cache root, in the documented key order, and leaves no temp file behind", () => {
    recordActivity(base, { now: () => new Date("2026-09-17T18:00:00.000Z") });
    expect(readdirSync(dir)).toEqual(["activity.json"]);
    const raw = JSON.parse(readFileSync(join(dir, "activity.json"), "utf8"));
    expect(raw.schemaVersion).toBe(ACTIVITY_LOG_SCHEMA_VERSION);
    expect(raw.entries).toHaveLength(1);
    expect(Object.keys(raw.entries[0])).toEqual(["tool", "library", "query", "url", "contentHash", "fresh", "outcome", "timestamp"]);
    expect(readActivityEntries()).toEqual([{ ...base, timestamp: "2026-09-17T18:00:00.000Z" }]);
  });

  it("PAR-791: activity.json is written owner-only (0600), and the cache root it creates is 0700", () => {
    recordActivity(base);
    expect(statSync(join(dir, "activity.json")).mode & 0o777).toBe(0o600);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });

  it("PAR-791: the 0700 mode is really applied by recordActivity's own mkdirSync, not merely true of a temp directory that already happened to be 0700", () => {
    // `dir` (this file's beforeEach fixture) is an mkdtempSync directory, already 0700 by
    // Node's own default — asserting against it alone cannot tell "recordActivity passed
    // mode: 0o700" apart from "the directory was 0700 anyway". A nested directory ONLY
    // recordActivity's mkdirSync can create proves the option is live, not merely believed.
    const nested = join(dir, "nested-root");
    process.env.VIBECTX_CACHE_DIR = nested;
    try {
      expect(existsSync(nested)).toBe(false);
      recordActivity(base);
      expect(statSync(nested).mode & 0o777).toBe(0o700);
    } finally {
      process.env.VIBECTX_CACHE_DIR = dir;
    }
  });

  it("PAR-791: a file left world-readable by an older version is corrected to 0600 on its next write (writeAtomic's rename replaces the mode, not just the bytes)", () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "activity.json"), JSON.stringify({ schemaVersion: ACTIVITY_LOG_SCHEMA_VERSION, entries: [] }), "utf8");
    chmodSync(join(dir, "activity.json"), 0o644);
    expect(statSync(join(dir, "activity.json")).mode & 0o777).toBe(0o644);
    recordActivity(base);
    expect(statSync(join(dir, "activity.json")).mode & 0o777).toBe(0o600);
  });

  it("writeAtomic (atomic-store.ts): an explicit mode is applied to the file; omitting it now defaults to 0600 (PAR-862 — supersedes this test's own PAR-791-era version, which pinned that omitting `mode` kept whatever the platform default was; every actual caller in this codebase already passes 0o600 explicitly, so this default only protects a FUTURE caller that forgets to)", () => {
    const withMode = join(dir, "with-mode.json");
    writeAtomic(withMode, "{}", { mode: 0o600 });
    expect(statSync(withMode).mode & 0o777).toBe(0o600);
    const withoutMode = join(dir, "without-mode.json");
    writeAtomic(withoutMode, "{}");
    expect(statSync(withoutMode).mode & 0o777).toBe(0o600);
  });

  it("appends in call order (oldest first)", () => {
    recordActivity({ ...base, library: "one" }, { now: () => new Date("2026-09-17T18:00:00.000Z") });
    recordActivity({ ...base, library: "two" }, { now: () => new Date("2026-09-17T18:00:01.000Z") });
    recordActivity({ ...base, library: "three" }, { now: () => new Date("2026-09-17T18:00:02.000Z") });
    expect(readActivityEntries().map((e) => e.library)).toEqual(["one", "two", "three"]);
  });

  it("`vibectx log`'s VIBECTX_NO_LOG=1 costs nothing — the directory is never even created", () => {
    process.env[ACTIVITY_LOG_OFF_ENV] = "1";
    recordActivity(base);
    expect(existsSync(dir)).toBe(true); // the temp dir itself exists (mkdtempSync made it)
    expect(existsSync(join(dir, "activity.json"))).toBe(false);
  });

  it("ignores a corrupt file on read and overwrites it on the next write", () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "activity.json"), "{ not json", "utf8");
    expect(readActivityEntries()).toEqual([]);
    recordActivity(base);
    expect(readActivityEntries()).toHaveLength(1);
  });

  it("ignores a file of the wrong shape", () => {
    writeFileSync(join(dir, "activity.json"), JSON.stringify([base]), "utf8");
    expect(readActivityEntries()).toEqual([]);
  });

  it("K2: a file of a NEWER schemaVersion is never read from and never overwritten; a note is warned", () => {
    const future = JSON.stringify({ schemaVersion: ACTIVITY_LOG_SCHEMA_VERSION + 1, entries: [{ future: true }] });
    writeFileSync(join(dir, "activity.json"), future, "utf8");
    expect(readActivityEntries()).toEqual([]);
    const notes: string[] = [];
    recordActivity(base, { warn: (m) => notes.push(m) });
    expect(readFileSync(join(dir, "activity.json"), "utf8")).toBe(future);
    expect(notes.join("")).toMatch(new RegExp(`newer schemaVersion ${ACTIVITY_LOG_SCHEMA_VERSION + 1}`));
  });

  it("D-13: never throws, even when the cache directory is unwritable — the retrieval that triggered it is unaffected", () => {
    mkdirSync(dir, { recursive: true });
    chmodSync(dir, 0o500);
    try {
      const notes: string[] = [];
      expect(() => recordActivity(base, { warn: (m) => notes.push(m) })).not.toThrow();
      expect(notes.join("")).toMatch(/activity not logged/);
    } finally {
      chmodSync(dir, 0o700);
    }
  });

  describe("D-51/K3: closed vocabularies and per-field validation on read (mirroring project-store.ts's toWarmRow)", () => {
    it("an unknown tool or outcome drops the ROW", () => {
      expect(toActivityEntry({ ...base, timestamp: "2026-09-17T18:00:00.000Z", tool: "delete_everything" })).toBeUndefined();
      expect(toActivityEntry({ ...base, timestamp: "2026-09-17T18:00:00.000Z", outcome: "definitely-matched" })).toBeUndefined();
    });

    it("every declared tool and outcome is individually accepted", () => {
      for (const tool of ACTIVITY_TOOLS) {
        expect(toActivityEntry({ tool, outcome: "matched", timestamp: "2026-09-17T18:00:00.000Z" })?.tool).toBe(tool);
      }
      for (const outcome of ACTIVITY_OUTCOMES) {
        expect(toActivityEntry({ tool: "search", outcome, timestamp: "2026-09-17T18:00:00.000Z" })?.outcome).toBe(outcome);
      }
    });

    it("a missing or malformed timestamp drops the ROW; a strict ISO instant is required", () => {
      for (const timestamp of [undefined, "", "not a date", "2026-09-17", "2026-09-17T18:00:00", "2026-09-17 (‮evil)"]) {
        expect(toActivityEntry({ tool: "get_docs", outcome: "matched", timestamp }), String(timestamp)).toBeUndefined();
      }
      expect(toActivityEntry({ tool: "get_docs", outcome: "matched", timestamp: "2026-09-17T18:00:00.123Z" })).toBeDefined();
    });

    it("security-architect B1: an unbounded fractional-seconds timestamp is REJECTED, not merely validated by Date.parse — the one field nothing else here length-bounds", () => {
      // Date.parse alone is not a length backstop (MEASURED, cache-meta.ts's own comment):
      // Date.parse("2020-01-01T00:00:00." + "1".repeat(10_000) + "Z") returns a finite
      // timestamp. ISO_INSTANT's shape check must reject the length before Date.parse ever
      // runs, matching cache-meta.ts's bounded (\.\d{1,9})? — not project-store.ts's or
      // search-index.ts's still-unbounded copies, which this file must not become a third of.
      const hostile = `2026-09-17T18:00:00.${"1".repeat(10_000)}Z`;
      expect(Number.isFinite(Date.parse(hostile))).toBe(true); // the trap: Date.parse alone accepts it
      expect(toActivityEntry({ tool: "get_docs", outcome: "matched", timestamp: hostile })).toBeUndefined();
      // Nanosecond precision (9 digits) still passes; a 10th digit is already past anything
      // real `toISOString` produces and is refused.
      expect(toActivityEntry({ tool: "get_docs", outcome: "matched", timestamp: "2026-09-17T18:00:00.123456789Z" })).toBeDefined();
      expect(toActivityEntry({ tool: "get_docs", outcome: "matched", timestamp: "2026-09-17T18:00:00.1234567890Z" })).toBeUndefined();
    });

    it("an oversized library/query/url/version is CLIPPED, not dropped; the row survives", () => {
      const e = toActivityEntry({
        tool: "search",
        outcome: "matched",
        timestamp: "2026-09-17T18:00:00.000Z",
        library: "l".repeat(500),
        query: "q".repeat(500),
        url: `https://example.com/${"u".repeat(500)}`,
        version: "v".repeat(500),
      });
      expect(e).toBeDefined();
      expect(e!.library!.length).toBeLessThanOrEqual(214);
      expect(e!.query!.length).toBeLessThanOrEqual(200);
      expect(e!.url!.length).toBeLessThanOrEqual(300);
      expect(e!.version!.length).toBeLessThanOrEqual(100);
    });

    it("a non-https or malformed url drops only that FIELD", () => {
      for (const url of ["http://insecure.example.com/x", "not a url at all", "https://u:p@example.com/x", "ftp://example.com/x", ""]) {
        expect(toActivityEntry({ tool: "get_docs", outcome: "matched", timestamp: "2026-09-17T18:00:00.000Z", url })?.url, url).toBeUndefined();
      }
    });

    it("PAR-792: an internal/forbidden-host url is KEPT — validated by shape only, not the fetch-time host allow-list, so an allowInternalHosts entry's consultation is still evidenced", () => {
      const e = toActivityEntry({
        tool: "get_docs",
        outcome: "matched",
        timestamp: "2026-09-17T18:00:00.000Z",
        url: "https://169.254.169.254/x",
      });
      expect(e?.url).toBe("https://169.254.169.254/x");
      const e2 = toActivityEntry({
        tool: "get_docs",
        outcome: "matched",
        timestamp: "2026-09-17T18:00:00.000Z",
        url: "https://docs.internal/llms.txt",
      });
      expect(e2?.url).toBe("https://docs.internal/llms.txt");
    });

    it("PAR-792: the url's query string is stripped (may carry a token/secret); the fragment is stripped too", () => {
      const e = toActivityEntry({
        tool: "get_docs",
        outcome: "matched",
        timestamp: "2026-09-17T18:00:00.000Z",
        url: "https://example.com/docs/llms.txt?token=super-secret&x=1#section",
      });
      expect(e?.url).toBe("https://example.com/docs/llms.txt");
      expect(e?.url).not.toContain("token");
      expect(e?.url).not.toContain("super-secret");
    });

    it("contentHash must match documentHash's exact 16-hex shape, or is dropped", () => {
      expect(toActivityEntry({ tool: "get_docs", outcome: "matched", timestamp: "2026-09-17T18:00:00.000Z", contentHash: "not-hex-at-all!!" })?.contentHash).toBeUndefined();
      expect(toActivityEntry({ tool: "get_docs", outcome: "matched", timestamp: "2026-09-17T18:00:00.000Z", contentHash: "0123456789ABCDEF" })?.contentHash).toBeUndefined(); // uppercase: documentHash never emits this
      expect(toActivityEntry({ tool: "get_docs", outcome: "matched", timestamp: "2026-09-17T18:00:00.000Z", contentHash: "0123456789abcdef" })?.contentHash).toBe("0123456789abcdef");
    });

    it("a non-boolean fresh is dropped", () => {
      expect(toActivityEntry({ tool: "get_docs", outcome: "matched", timestamp: "2026-09-17T18:00:00.000Z", fresh: "yes" })?.fresh).toBeUndefined();
    });

    it("every surviving string is cleaned of control/bidi characters (S3)", () => {
      const e = toActivityEntry({
        tool: "search",
        outcome: "matched",
        timestamp: "2026-09-17T18:00:00.000Z",
        library: "re​act",
        query: "hooks‮evil",
      });
      expect(e?.library).toBe("react");
      expect(e?.query).toBe("hooksevil");
    });

    it("not a record, or missing required fields, drops the row entirely", () => {
      expect(toActivityEntry(null)).toBeUndefined();
      expect(toActivityEntry("a string")).toBeUndefined();
      expect(toActivityEntry([])).toBeUndefined();
      expect(toActivityEntry({})).toBeUndefined();
    });

    it("skips malformed records and keeps the valid ones, from a hand-written file", () => {
      writeFileSync(
        join(dir, "activity.json"),
        JSON.stringify({
          schemaVersion: 1,
          entries: [
            { tool: "get_docs", outcome: "matched", timestamp: "2026-09-17T18:00:00.000Z", library: "good" },
            null,
            "string",
            { tool: "bogus", outcome: "matched", timestamp: "2026-09-17T18:00:00.000Z" },
            { tool: "get_docs", outcome: "bogus", timestamp: "2026-09-17T18:00:00.000Z" },
            { tool: "get_docs", outcome: "matched" }, // no timestamp
          ],
        }),
        "utf8",
      );
      expect(readActivityEntries().map((e) => e.library)).toEqual(["good"]);
    });
  });

  describe("D-51: bounded — oldest dropped first once the cap is exceeded", () => {
    /** Seeds the file directly (one write, not ACTIVITY_LOG_MAX_ENTRIES real ones) with a
     *  full-length, already-valid entry list, so this test exercises exactly the same
     *  `recordActivity` trim logic a real fill-up would without paying its real cost:
     *  ACTIVITY_LOG_MAX_ENTRIES real read-modify-write cycles is precisely the O(n) per-call
     *  cost this module's own top comment discloses, and paying it 2,000 times over in a
     *  test is minutes, not milliseconds — a property of the design being tested, not a
     *  test bug, so the fix is to seed once rather than to shrink what is being proven. */
    function seedFull(): void {
      const entries = Array.from({ length: ACTIVITY_LOG_MAX_ENTRIES }, (_, i) => ({
        ...base,
        library: `lib-${i}`,
        timestamp: new Date(2026, 0, 1, 0, 0, i).toISOString(),
      }));
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "activity.json"), JSON.stringify({ schemaVersion: ACTIVITY_LOG_SCHEMA_VERSION, entries }), "utf8");
    }

    it("a write past the cap drops the single oldest entry and appends the new one", () => {
      seedFull();
      expect(readActivityEntries()).toHaveLength(ACTIVITY_LOG_MAX_ENTRIES);
      recordActivity({ ...base, library: "newest" }, { now: () => new Date(2026, 0, 1, 1, 0, 0) });
      const entries = readActivityEntries();
      expect(entries).toHaveLength(ACTIVITY_LOG_MAX_ENTRIES);
      expect(entries[0].library).toBe("lib-1"); // lib-0, the oldest, is gone
      expect(entries[entries.length - 1].library).toBe("newest");
    });

    it("a file already OVER the cap (hand-edited, or from an older version with no cap) is trimmed to it on the next write", () => {
      seedFull();
      const over = JSON.parse(readFileSync(join(dir, "activity.json"), "utf8"));
      over.entries.push({ ...base, library: "extra-1", timestamp: "2026-01-01T00:33:20.000Z" }, { ...base, library: "extra-2", timestamp: "2026-01-01T00:33:21.000Z" });
      writeFileSync(join(dir, "activity.json"), JSON.stringify(over), "utf8");
      expect(readActivityEntries()).toHaveLength(ACTIVITY_LOG_MAX_ENTRIES + 2);
      recordActivity({ ...base, library: "newest" }, { now: () => new Date(2026, 0, 2, 0, 0, 0) });
      expect(readActivityEntries()).toHaveLength(ACTIVITY_LOG_MAX_ENTRIES);
    });
  });

  describe("D-33's own boundary, reused: no document TEXT is representable at all", () => {
    it("ActivityInput has no field a caller could pour document content into — every string field is bounded and hashed, not held whole", () => {
      // Not a runtime assertion (TypeScript already enforces the shape) — this pins the CONTRACT
      // in a test that fails loudly if a future edit ever adds a `text`/`content`/`body` field.
      const e = toActivityEntry({ ...base, timestamp: "2026-09-17T18:00:00.000Z" })!;
      expect(Object.keys(e).sort()).toEqual(["contentHash", "fresh", "library", "outcome", "query", "timestamp", "tool", "url"].sort());
    });
  });

  describe("readActivityLog / formatActivityLogTable (`vibectx log`'s own data and render)", () => {
    it("readActivityLog wraps the entries in the shared schemaVersion envelope", () => {
      recordActivity(base, { now: () => new Date("2026-09-17T18:00:00.000Z") });
      expect(readActivityLog()).toEqual({ schemaVersion: ACTIVITY_LOG_SCHEMA_VERSION, entries: [{ ...base, timestamp: "2026-09-17T18:00:00.000Z" }] });
    });

    it("formats a header, one row per entry and a summary count", () => {
      const entries: ActivityEntry[] = [
        { tool: "get_docs", library: "react", query: "hooks", outcome: "matched", timestamp: "2026-09-17T18:00:00.000Z" },
        { tool: "search", outcome: "no-match", timestamp: "2026-09-17T18:00:01.000Z" },
      ];
      const table = formatActivityLogTable(entries);
      expect(table).toContain("timestamp");
      expect(table).toContain("react");
      expect(table).toContain("2 entries");
    });

    it("cleans control/bidi characters at the render boundary even for an entry that bypassed validation", () => {
      const hostile: ActivityEntry = {
        tool: "get_docs",
        library: "re​act",
        outcome: "matched",
        timestamp: "2026-09-17T18:00:00.000Z",
      };
      expect(formatActivityLogTable([hostile])).not.toMatch(/[​‮]/);
    });

    it("security-architect B1: clips an oversized timestamp at the render boundary too, even for an entry that bypassed validation — an unclipped one would widen every OTHER row's cell to match it", () => {
      const hostile: ActivityEntry = {
        tool: "get_docs",
        outcome: "matched",
        timestamp: `2026-01-01T00:00:00.${"1".repeat(50_000)}Z`,
      };
      const table = formatActivityLogTable([hostile, { tool: "search", outcome: "no-match", timestamp: "2026-01-01T00:00:01.000Z" }]);
      expect(table.length).toBeLessThan(1000); // not tens of KB padded to the hostile row's width
    });

    it("an empty log formats to a header and a zero-entry summary", () => {
      expect(formatActivityLogTable([])).toContain("0 entries");
    });
  });
});
