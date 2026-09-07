import { lstatSync, mkdirSync, readdirSync, readFileSync, existsSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { tempPathFor, writeAtomic } from "./atomic-store.js";
import { noteCacheWrite } from "./cache-evict.js";

export interface CacheMeta {
  url: string;
  fetchedAt: string; // ISO
  etag?: string;
}

export interface CacheHit {
  content: string;
  meta: CacheMeta;
  /** True when past TTL — caller decides whether to refetch or serve stale. */
  stale: boolean;
}

/** The cache directory under the user's home. */
export const CACHE_DIR_NAME = ".vibectx";
/** What it was called when the package was `docs-cache-mcp`. Migrated once, see below. */
export const LEGACY_CACHE_DIR_NAME = ".docs-cache-mcp";

export interface CacheRootOptions {
  /** Where the one-off notes go. Defaults to stderr — this is a stdio MCP server, so
   *  stdout belongs to the protocol and nothing else may be written to it. */
  warn?: (message: string) => void;
}

const toStderr = (message: string): void => {
  process.stderr.write(`${message}\n`);
};

/** Once-per-process state: the deprecation note and the migration are each said and done
 *  once, however many times `cacheRoot()` is called (it is called on nearly every path). */
let deprecationNoted = false;
let resolvedDefaultRoot: string | undefined;

/** Test seam: forget what this process has already noted and migrated. */
export function resetCacheRootState(): void {
  deprecationNoted = false;
  resolvedDefaultRoot = undefined;
}

/** Empty is not a directory: an exported-but-empty variable reads as unset rather than as
 *  "cache into the current working directory". */
const configured = (value: string | undefined): string | undefined =>
  value !== undefined && value.length > 0 ? value : undefined;

/** A real directory this tool would be willing to treat as a cache (D-46: lstat, not stat). */
function isRealDirectory(path: string): boolean {
  try {
    return lstatSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Rule 1 keeps an existing `~/.vibectx` and moves nothing — correct, and it used to be
 * SILENT. An EMPTY `~/.vibectx` (a `mkdir`, a dotfile manager, a half-finished earlier run)
 * took that same path, so a full legacy cache sat stranded beside it while the tool
 * re-downloaded every document the user already had, with no way to find out why.
 *
 * One note, and no move: the rule does not change — deciding for the user which of two caches
 * wins is exactly the judgement rule 1 refuses to make — they are just told where the other
 * one is. Best effort throughout; an unreadable directory means nothing is said.
 */
function noteStrandedLegacy(current: string, legacy: string, warn: (message: string) => void): void {
  if (!isRealDirectory(legacy)) return; // only a real directory is a cache worth mentioning
  let currentIsEmpty: boolean;
  try {
    currentIsEmpty = readdirSync(current).length === 0;
  } catch {
    return;
  }
  if (!currentIsEmpty) return; // this user has a cache at the new path and has moved on
  warn(
    `vibectx: ${current} is empty, so the cache at ${legacy} (the old package name) is not being used ` +
      `and nothing was moved. Delete ${current} to have it migrated on the next run, or delete ${legacy} ` +
      `if you no longer want it.`,
  );
}

/**
 * The default root, with the one-time rebrand migration (D-45, PAR-652).
 *
 * The rules, in the order they are checked, because each exists to prevent a specific way
 * of losing someone's cache:
 *   1. `~/.vibectx` already exists → use it and touch nothing. A user who has both
 *      directories has already moved on; overwriting the new one with the old would lose
 *      the newer cache, which is the worst outcome available here. If it is EMPTY and a
 *      legacy cache is sitting beside it, say so once (`noteStrandedLegacy`) — the rule is
 *      unchanged, but it is no longer silent about what it left behind.
 *   2. No `~/.docs-cache-mcp` → use `~/.vibectx`. Nothing to migrate.
 *   3. `~/.docs-cache-mcp` is not a REAL DIRECTORY (D-46, PAR-652b) → rename nothing, say so
 *      once, and degrade exactly as rule 4 does. `existsSync` follows symlinks, so without
 *      this check a link planted at the legacy path passed rule 2 and rule 3 renamed THE LINK
 *      — `renameSync` moves the link itself, so `~/.vibectx` became a symlink aiming wherever
 *      the link aimed, and every cached document and every eviction from then on landed in
 *      whatever directory that was. Measured by the security gate. The link is never followed
 *      into a rename and never removed.
 *      RESIDUAL, stated because it is real: writes during that one run still resolve through
 *      the link. What this closes is the PERMANENT capture (`~/.vibectx` is not made a link)
 *      and deletion — `enforceCacheSizeCap` refuses a root that is not a real directory, so
 *      nothing is evicted through it either.
 *   4. Otherwise rename `~/.docs-cache-mcp` to `~/.vibectx` — a rename, never a copy: a
 *      copy can half-succeed and leave two divergent caches, and a rename either happens
 *      or does not.
 *   5. The rename failed (cross-device, permissions, a race with another process) → keep
 *      using the OLD path for this run and say so once. Degrading is right: the cache is
 *      a cache, but silently starting from an empty one would re-download every document
 *      the user already has.
 */
function defaultCacheRoot(warn: (message: string) => void): string {
  if (resolvedDefaultRoot !== undefined) return resolvedDefaultRoot;
  const home = homedir();
  const current = join(home, CACHE_DIR_NAME);
  const legacy = join(home, LEGACY_CACHE_DIR_NAME);
  resolvedDefaultRoot = current;
  if (existsSync(current)) {
    noteStrandedLegacy(current, legacy, warn);
    return current;
  }
  if (!existsSync(legacy)) return current;
  // D-46: prove the legacy path before renaming it. lstat, not stat — the question is what
  // the ENTRY is, not what it points at. A throw here means it vanished between the two
  // calls, which is rule 2 arriving late: there is nothing to migrate.
  let legacyStats;
  try {
    legacyStats = lstatSync(legacy);
  } catch {
    return current;
  }
  if (!legacyStats.isDirectory()) {
    resolvedDefaultRoot = legacy;
    warn(
      `vibectx: not moving ${legacy} → ${current} — ${legacy} is ` +
        `${legacyStats.isSymbolicLink() ? "a symlink" : "not a directory"}, and only a real directory is moved. ` +
        `Using ${legacy} for this run; nothing was renamed, copied or deleted. ` +
        `Remove it, or set VIBECTX_CACHE_DIR to a real directory.`,
    );
    return resolvedDefaultRoot;
  }
  try {
    renameSync(legacy, current);
    warn(`vibectx: moved the cache directory ${legacy} → ${current} (renamed once; nothing was copied or deleted).`);
  } catch (e) {
    resolvedDefaultRoot = legacy;
    warn(
      `vibectx: could not move the cache directory ${legacy} → ${current} (${e instanceof Error ? e.message : String(e)}); ` +
        `using ${legacy} for this run. Nothing was copied and no cached document was lost.`,
    );
  }
  return resolvedDefaultRoot;
}

/**
 * Where the cache lives: `VIBECTX_CACHE_DIR`, else `DOCS_CACHE_DIR` (deprecated, one note
 * per process), else `~/.vibectx` with the one-time migration above.
 *
 * D-45: the new name wins outright. `DOCS_CACHE_DIR` keeps working through 0.2.x so a
 * shell profile or an MCP client config written against 0.1.x does not silently start
 * caching somewhere else — which would look exactly like a cache that lost everything.
 */
export function cacheRoot(opts: CacheRootOptions = {}): string {
  const warn = opts.warn ?? toStderr;
  const preferred = configured(process.env.VIBECTX_CACHE_DIR);
  if (preferred !== undefined) return preferred;
  const legacyEnv = configured(process.env.DOCS_CACHE_DIR);
  if (legacyEnv !== undefined) {
    if (!deprecationNoted) {
      deprecationNoted = true;
      warn(
        "vibectx: DOCS_CACHE_DIR is deprecated and will stop being read after 0.2.x — " +
          `set VIBECTX_CACHE_DIR instead. Using ${legacyEnv} for this run.`,
      );
    }
    return legacyEnv;
  }
  return defaultCacheRoot(warn);
}

function libDir(library: string): string {
  // One directory per library; page files keyed by a slug of their URL.
  return join(cacheRoot(), library.replace(/[^a-z0-9_-]/gi, "_"));
}

export function urlSlug(url: string): string {
  return url.replace(/[^a-z0-9]/gi, "_").slice(0, 120);
}

export function readCache(
  library: string,
  url: string,
  ttlHours: number,
): CacheHit | undefined {
  const dir = libDir(library);
  const contentPath = join(dir, `${urlSlug(url)}.md`);
  const metaPath = join(dir, `${urlSlug(url)}.meta.json`);
  if (!existsSync(contentPath) || !existsSync(metaPath)) return undefined;
  const meta = JSON.parse(readFileSync(metaPath, "utf8")) as CacheMeta;
  const ageMs = Date.now() - new Date(meta.fetchedAt).getTime();
  // Negated `<` rather than `>=` (N-6): an unparsable or missing `fetchedAt` makes ageMs NaN,
  // and every comparison with NaN is false — under `>=` that read as FRESH FOREVER, so a
  // corrupt meta file pinned a document in the cache with no way to age out. Now it reads as
  // stale and the next fetch revalidates it. `>=` semantics otherwise: a TTL of 0 means
  // "expire immediately", even when written and read within the same millisecond.
  return {
    content: readFileSync(contentPath, "utf8"),
    meta,
    stale: !(ageMs < ttlHours * 3600_000),
  };
}

/** Refresh a cache entry's TTL clock without rewriting content — used after a
 *  304 Not Modified revalidation confirms the upstream is unchanged. */
export function touchCache(library: string, url: string): void {
  const dir = libDir(library);
  const metaPath = join(dir, `${urlSlug(url)}.meta.json`);
  if (!existsSync(metaPath)) return;
  const meta = JSON.parse(readFileSync(metaPath, "utf8")) as CacheMeta;
  meta.fetchedAt = new Date().toISOString();
  writeAtomic(metaPath, JSON.stringify(meta, null, 2));
}

/**
 * Both files are staged as temp files first, then renamed back to back — content, then meta
 * (N-5, PAR-656). Renaming is the only work between the two, so the window in which a
 * concurrent reader sees NEW content beside OLD meta (an etag that no longer describes the
 * document, an under-stated age) is two syscalls wide instead of a whole file write. It is
 * not zero: POSIX has no two-file atomic rename, and closing it entirely would need a single
 * content+meta file, which is a format change. Accepted, and bounded to a single-user local
 * cache where the loss is at worst one wasted revalidation.
 *
 * A crash before the second rename leaves the previous meta (or, on a first write, content
 * with no meta at all, which readCache reports as a miss — both files are required), so no
 * reader ever observes a partially written file.
 */
export function writeCache(
  library: string,
  url: string,
  content: string,
  etag?: string,
): void {
  const dir = libDir(library);
  mkdirSync(dir, { recursive: true });
  const contentPath = join(dir, `${urlSlug(url)}.md`);
  const metaPath = join(dir, `${urlSlug(url)}.meta.json`);
  const meta: CacheMeta = { url, fetchedAt: new Date().toISOString(), etag };
  const contentTmp = tempPathFor(contentPath);
  const metaTmp = tempPathFor(metaPath);
  try {
    writeFileSync(contentTmp, content, "utf8");
    writeFileSync(metaTmp, JSON.stringify(meta, null, 2), "utf8");
    renameSync(contentTmp, contentPath);
    renameSync(metaTmp, metaPath);
  } catch (e) {
    rmSync(contentTmp, { force: true });
    rmSync(metaTmp, { force: true });
    throw e;
  }
  // Only after BOTH renames land: this document now exists and counts toward the cap, and it
  // is protected from eviction for the rest of this run (PAR-652 item 7a). Sweeping is
  // amortised inside noteCacheWrite, which never throws — an unsweepable cache must not fail
  // a write that already succeeded.
  noteCacheWrite(cacheRoot(), contentPath, Buffer.byteLength(content, "utf8"));
}
