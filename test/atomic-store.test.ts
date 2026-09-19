import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newerSchemaVersion, isRegularFile } from "../src/atomic-store.js";

/**
 * PAR-805 — `newerSchemaVersion` is shared by every store in the cache directory that carries a
 * schema version (`resolved-store.ts`, `search-index.ts`, `project-store.ts`,
 * `doctor-store.ts`, `activity-log.ts` — `cache.ts`'s own `touchCache` does NOT call this
 * function at all, since a TTL revalidation never changes a record's schema; do not add it back
 * to this list), and before this item it called a bare `readFileSync(path, "utf8")` with no
 * `lstat` guard at all — a symlink planted at any of those files' paths was followed and its
 * target's bytes parsed as if they were that store's own schema-versioned file. `isRegularFile`
 * (this file, already used by `sweepTempFiles` for the identical reason) is reused here rather
 * than re-implemented, and exported so `activity-log.ts`'s `readActivityEntries` can apply the
 * same guard to its own read (`test/activity-log.test.ts` covers that call site).
 *
 * SCOPE NOTE (code-reviewer, PAR-805 review round): this guard closes only the SCHEMA-VERSION
 * PROBE for the five callers above — each store's own DATA read (`readResolvedEntries`,
 * `readDoctorVerdicts`, `readProjectRecord`, and `search-index.ts`'s `readIndex`) is still
 * unguarded and is PAR-859's scope, not this item's (see `atomic-store.ts`'s own comment on
 * `newerSchemaVersion` for the full account). `readActivityEntries` is the one exception — it
 * calls `isRegularFile` directly on its own data read, not through this function.
 */

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "vibectx-atomic-store-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("isRegularFile", () => {
  it("true for a real file, false for a symlink, a directory, or a missing path", () => {
    const file = join(dir, "real.json");
    writeFileSync(file, "{}", "utf8");
    const link = join(dir, "link.json");
    symlinkSync(file, link);
    expect(isRegularFile(file)).toBe(true);
    expect(isRegularFile(link)).toBe(false);
    expect(isRegularFile(join(dir, "does-not-exist"))).toBe(false);
    expect(isRegularFile(dir)).toBe(false); // dir itself is a directory, not a file
  });
});

describe("newerSchemaVersion", () => {
  it("reports a newer schemaVersion when the file parses and is genuinely newer", () => {
    const path = join(dir, "store.json");
    writeFileSync(path, JSON.stringify({ schemaVersion: 5 }), "utf8");
    expect(newerSchemaVersion(path, 1)).toBe("5");
  });

  it("undefined for a missing, corrupt, equal, or older file", () => {
    const path = join(dir, "store.json");
    expect(newerSchemaVersion(path, 1)).toBeUndefined(); // missing
    writeFileSync(path, "{ not json", "utf8");
    expect(newerSchemaVersion(path, 1)).toBeUndefined(); // corrupt
    writeFileSync(path, JSON.stringify({ schemaVersion: 1 }), "utf8");
    expect(newerSchemaVersion(path, 1)).toBeUndefined(); // equal
    writeFileSync(path, JSON.stringify({ schemaVersion: 1 }), "utf8");
    expect(newerSchemaVersion(path, 2)).toBeUndefined(); // older
  });

  /**
   * PAR-805 (mutation target: newerSchemaVersion's isRegularFile guard) — a symlink planted at
   * `path`, pointing at a sibling file that WOULD report a newer schemaVersion if read, must
   * still report `undefined`: refused the same way a missing file already is, never followed.
   */
  it("refuses a symlink planted at path, even when the target genuinely has a newer schemaVersion", () => {
    const target = join(dir, "target.json");
    writeFileSync(target, JSON.stringify({ schemaVersion: 999 }), "utf8");
    const linked = join(dir, "store.json");
    symlinkSync(target, linked);

    expect(newerSchemaVersion(linked, 1)).toBeUndefined();
  });

  it("refuses a symlink pointing at a directory too, without throwing", () => {
    const subdir = join(dir, "subdir");
    const linked = join(dir, "store.json");
    mkdirSync(subdir);
    symlinkSync(subdir, linked);

    expect(() => newerSchemaVersion(linked, 1)).not.toThrow();
    expect(newerSchemaVersion(linked, 1)).toBeUndefined();
  });

  it("refuses a dangling symlink cleanly, no throw", () => {
    const linked = join(dir, "store.json");
    symlinkSync(join(dir, "does-not-exist-anywhere"), linked);

    expect(() => newerSchemaVersion(linked, 1)).not.toThrow();
    expect(newerSchemaVersion(linked, 1)).toBeUndefined();
  });
});
