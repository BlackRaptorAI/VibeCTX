import { readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The file-write discipline every store in the cache directory shares (S4 / S-C, PAR-656):
 * the document cache (src/cache.ts), the resolution store (src/resolved-store.ts) and the
 * project records (src/project-store.ts).
 *
 * Write: never write a final path in place. Write a temp file beside the target and rename
 * over it, so a concurrent reader — another vibectx process on the same cache, the startup
 * autowarm beside a tool call — sees the old file or the new one, never a partial one.
 *
 * Sweep: a process killed between `writeFileSync` and `renameSync` leaves the temp file
 * behind, and nothing ever reads or removes it. `sweepTempFiles` deletes those orphans;
 * `sweepCacheTempFiles` runs it over the directories this tool writes temp files into.
 * Best effort throughout: a sweep that cannot run must never fail a warm or a server start.
 */

/** Suffix every temp file here carries: `<target>.<pid>.<ms>.tmp`. */
export const tempPathFor = (path: string): string => `${path}.${process.pid}.${Date.now()}.tmp`;

/** Matches exactly the names `tempPathFor` produces — `.<digits>.<digits>.tmp` — so a file a
 *  person happens to have called `notes.tmp` is never swept. */
export const TEMP_FILE_PATTERN = /\.\d+\.\d+\.tmp$/;

/** Write `path` via a temp file in the same directory and an atomic rename. The temp file is
 *  removed if the write fails. */
export function writeAtomic(path: string, data: string): void {
  const tmp = tempPathFor(path);
  try {
    writeFileSync(tmp, data, "utf8");
    renameSync(tmp, path);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

/**
 * Remove orphan temp files directly inside `dir` (not recursive; only names matching
 * TEMP_FILE_PATTERN). Every error is swallowed — a missing directory, an unreadable one, a
 * file another process removed first — because this runs on the startup path.
 */
export function sweepTempFiles(dir: string): void {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (!TEMP_FILE_PATTERN.test(name)) continue;
    try {
      rmSync(join(dir, name), { force: true });
    } catch {
      /* best effort: another process may have swept it already */
    }
  }
}

/**
 * Sweep every directory this tool writes temp files into: the cache root (resolved.json),
 * `projects/` (project records) and each per-library document directory, which is one level
 * under the root. Nothing deeper is walked and nothing outside the root is touched.
 */
export function sweepCacheTempFiles(root: string): void {
  sweepTempFiles(root);
  sweepTempFiles(join(root, "projects"));
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return;
  }
  for (const name of names) {
    const child = join(root, name);
    try {
      if (!statSync(child).isDirectory()) continue;
    } catch {
      continue;
    }
    sweepTempFiles(child);
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * The on-disk file's `schemaVersion` when it parses and is NEWER than `ours` (K2); undefined
 * when the file is absent, corrupt, ours, or older. A newer file was written by a newer
 * vibectx and is not ours to rewrite; an older one is ours to replace.
 */
export function newerSchemaVersion(path: string, ours: number): string | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (isRecord(parsed) && typeof parsed.schemaVersion === "number" && parsed.schemaVersion > ours) return String(parsed.schemaVersion);
  } catch {
    return undefined;
  }
  return undefined;
}
