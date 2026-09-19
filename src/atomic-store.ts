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

/** Matches exactly the names `tempPathFor` produces — `.<pid>.<ms>.tmp` — so a file a person
 *  happens to have called `notes.tmp` is never swept. The second group is the `<ms>` stamp. */
export const TEMP_FILE_PATTERN = /\.\d+\.(\d+)\.tmp$/;

/** A temp file is only an ORPHAN once it is old enough that no writer could still be inside
 *  `writeAtomic`. Below this age it is assumed to be a concurrent writer's in-flight file —
 *  another vibectx process on the same cache, the startup autowarm beside a tool call — and
 *  sweeping it would delete the data that process is about to rename into place. One minute
 *  is far beyond any write here (ASSUMED: the largest document is a few MB) and far below
 *  the interval at which orphans matter, since nothing reads them. */
export const SWEEP_MIN_AGE_MS = 60_000;

/** Write `path` via a temp file in the same directory and an atomic rename. The temp file is
 *  removed if the write fails.
 *
 *  `opts.mode` (PAR-791, defaulted to `0o600` by PAR-862): the permission bits the TEMP file is
 *  created with. PAR-862 — every actual caller in this codebase already passes `{ mode: 0o600 }`
 *  explicitly (CONFIRMED: `grep -rln "writeAtomic(" src/*.ts` finds exactly six call sites —
 *  `activity-log.ts`, `cache.ts`, `doctor-store.ts`, `project-store.ts`, `resolved-store.ts`, and
 *  this file's own `writeIndex` caller in `search-index.ts` — every one already `0o600`, none
 *  outside the cache directory), so this default changes no CURRENT caller's behaviour; it exists
 *  so a FUTURE store added to this cache directory that forgets to pass `mode` still gets
 *  owner-only rather than the platform default (`0o666` minus umask) — the same "one shared
 *  function, not six places to remember it" reasoning `ensureCacheRoot` already applies to
 *  directory creation, now applied to file creation too. `renameSync` replaces whatever
 *  permissions `path` already had with the temp file's, so an existing world-readable file from
 *  before a caller started passing (or defaulting to) `mode` is corrected on its very next write,
 *  not merely held steady. Only affects file CREATION (POSIX `open()`'s mode is ignored when the
 *  path already exists) — moot here, since `tempPathFor` names each temp file uniquely
 *  (`<pid>.<ms>`), so it is always newly created.
 *
 *  `flag: "wx"` (PAR-860, `O_CREAT|O_EXCL`): the default `writeFileSync` flag (`"w"`,
 *  `O_WRONLY|O_CREAT|O_TRUNC`) FOLLOWS a symlink already sitting at the destination — and
 *  `tempPathFor`'s name is predictable to within a process id and a millisecond
 *  (`${path}.${pid}.${Date.now()}.tmp`), so an attacker who can predict or race that name could
 *  plant a symlink there ahead of a write. `wx` refuses to open ANY existing entry at that exact
 *  path, symlink or not, even a dangling one — POSIX: `open()` with `O_CREAT|O_EXCL` on a path
 *  naming a symbolic link fails `EEXIST` regardless of what the link points to, never following
 *  it. Safe against a false failure: a genuine collision needs two writes to the IDENTICAL path
 *  in the IDENTICAL millisecond from the IDENTICAL process, and every caller here is
 *  single-threaded and synchronous, so no two calls to this function can ever race each other
 *  within one process, and `tempPathFor`'s own `<pid>` component rules out a collision ACROSS
 *  processes too. The existing `catch` below is already correct for the refusal case: `rmSync` on
 *  a symlink removes the link itself, never the target it points to, so cleanup after a refused
 *  write never touches whatever a planted link aimed at. */
export function writeAtomic(path: string, data: string, opts: { mode?: number } = {}): void {
  const tmp = tempPathFor(path);
  try {
    writeFileSync(tmp, data, { encoding: "utf8", mode: opts.mode ?? 0o600, flag: "wx" });
    renameSync(tmp, path);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

/** True only for a REGULAR file — `lstat`, so a symbolic link answers false rather than being
 *  followed to whatever it points at. Any error (the entry vanished, the directory is
 *  unreadable) answers false: the sweep skips what it cannot positively identify.
 *
 *  Exported (PAR-805): originally private to this file's own temp-file sweep, now reused as the
 *  read-side symlink guard for `newerSchemaVersion` below and for `activity-log.ts`'s
 *  `readActivityEntries` — the same check, not a second implementation of it. */
export function isRegularFile(path: string): boolean {
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
 *
 * Age rule: a name whose embedded `<ms>` is within the last SWEEP_MIN_AGE_MS — or ahead of
 * our clock — is skipped. Two vibectx processes share one cache, so the file a sweep sees may
 * be a write still in flight, and deleting it would make the other process's rename fail on
 * work it had already done. Waiting a minute costs nothing: nothing reads a temp file.
 */
export function sweepTempFiles(dir: string): void {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  const now = Date.now();
  for (const name of names) {
    const stamped = TEMP_FILE_PATTERN.exec(name);
    if (!stamped) continue;
    if (now - Number(stamped[1]) < SWEEP_MIN_AGE_MS) continue; // a writer may still be inside writeAtomic
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
 * when the file is absent, corrupt, ours, older, or (PAR-805) a symlink rather than a regular
 * file. This function is SHARED across every store in the cache directory that carries a
 * `schemaVersion` (`resolved-store.ts`, `search-index.ts`, `project-store.ts`,
 * `doctor-store.ts`, `activity-log.ts` — `cache.ts`'s own `touchCache` does not call this, since
 * a TTL revalidation never changes a record's schema), so the symlink guard here closes the
 * SCHEMA-PROBE read for all five callers in one place, the same way `writeAtomic` above closes
 * the write side for all of them in one place.
 * `isRegularFile` (this file, `lstat`, never `stat`) — a symlink planted at any of these paths
 * is refused the same way a missing or corrupt file already was: as "nothing newer here",
 * never followed. Deliberately NOT bounded by size: this is also `index.json`'s schema check,
 * and a legitimately large index (many libraries' tokenized text) must not be refused merely
 * for being big — symlink-safety and size-bounding are separate concerns, and this function
 * only owns the former.
 *
 * SCOPE, AS OF PAR-859 (previously "NOT CLOSED BY THIS ITEM", PAR-805 review round — this
 * function only ever guarded the SCHEMA-VERSION PROBE, never each store's own DATA read, and that
 * gap is now closed at each store's own read function, not here): `readResolvedEntries`
 * (`resolved-store.ts`), `readDoctorVerdicts` (`doctor-store.ts`), `readProjectRecord`
 * (`project-store.ts`) and `search-index.ts`'s `readIndex` each now carry their OWN symlink guard
 * at the top of their own function — `isRegularFile` directly for the first three, the same
 * leaf-`lstat`-does-double-duty idiom `cache-meta.ts`'s `readMetaFile` established for `readIndex`
 * (which already did its own size check and so gets its own `lstat`, not a call through
 * `isRegularFile`, to avoid a second syscall). `readActivityEntries` (`activity-log.ts`) closed
 * first, in PAR-805, the same way the first three do here. For `resolved-store.ts` specifically
 * the exposure this closes was worse than "served and discarded": `saveResolvedEntry` calls
 * `readResolvedEntries()` internally to merge a new entry into the existing list before writing
 * back — before PAR-859, a planted symlink at `resolved.json` had its content READ, MERGED, AND
 * PERSISTED into the real file on the very next save (the rename replaces the symlink with a real
 * file holding the poisoned data), not merely read once and thrown away.
 * `doctor-store.ts`'s `saveDoctorVerdicts` has the identical read-merge-persist shape (it also
 * calls `readDoctorVerdicts()` to merge before writing back) and is closed by the same guard, for
 * the same reason — see `test/doctor-store.test.ts`'s equivalent poisoning test.
 * `project-store.ts`'s `writeProjectRecord` does NOT read-merge-persist (CONFIRMED by reading it:
 * it serialises the `record` argument it was handed directly, with no internal read of the
 * existing file) — its own `readProjectRecord` guard closes only the plain "served and discarded"
 * exposure, which is what its own test proves.
 */
export function newerSchemaVersion(path: string, ours: number): string | undefined {
  if (!isRegularFile(path)) return undefined;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (isRecord(parsed) && typeof parsed.schemaVersion === "number" && parsed.schemaVersion > ours) return String(parsed.schemaVersion);
  } catch {
    return undefined;
  }
  return undefined;
}
