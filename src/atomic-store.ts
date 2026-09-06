import { lstatSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
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

/** True only for a REGULAR file — `lstat`, so a symbolic link answers false rather than being
 *  followed to whatever it points at. Any error (the entry vanished, the directory is
 *  unreadable) answers false: the sweep skips what it cannot positively identify. */
function isRegularFile(path: string): boolean {
  try {
    return lstatSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * Remove orphan temp files directly inside `dir` (not recursive; only names matching
 * TEMP_FILE_PATTERN). Every error is swallowed — a missing directory, an unreadable one, a
 * file another process removed first — because this runs on the startup path.
 *
 * S-C symlink rule: the cache directory is a trust boundary, so a name is removed only when
 * `lstat` says it is a REGULAR FILE. A symlink shaped like a temp file is left alone entirely
 * — the sweep must never be the thing that deletes a path outside the cache, and leaving one
 * dangling link is a smaller harm than the alternative being wrong once.
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
    const path = join(dir, name);
    if (!isRegularFile(path)) continue; // a symlink or a directory is never ours to remove
    try {
      rmSync(path, { force: true });
    } catch {
      /* best effort: another process may have swept it already */
    }
  }
}

/**
 * Sweep every directory this tool writes temp files into: the cache root (resolved.json),
 * `projects/` (project records) and each per-library document directory, which is one level
 * under the root. Nothing deeper is walked and nothing outside the root is touched.
 *
 * S-C symlink rule: descent uses `lstat`, so a SYMLINKED child of the cache root is not a
 * directory as far as this walk is concerned and is never entered — otherwise a link planted
 * in the cache would aim the sweep at temp-shaped files anywhere on the filesystem.
 */
export function sweepCacheTempFiles(root: string): void {
  const sweepRealDir = (path: string): void => {
    try {
      if (!lstatSync(path).isDirectory()) return; // a symlinked child is not descended
    } catch {
      return;
    }
    sweepTempFiles(path);
  };
  sweepTempFiles(root); // the root itself is the caller's, not a name found inside the cache
  sweepRealDir(join(root, "projects"));
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return;
  }
  for (const name of names) {
    if (name === "projects") continue; // already swept above
    sweepRealDir(join(root, name));
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
