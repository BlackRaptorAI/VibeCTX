import { mkdirSync, readFileSync, existsSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { tempPathFor, writeAtomic } from "./atomic-store.js";

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

/**
 * The default root, with the one-time rebrand migration (D-45, PAR-652).
 *
 * The rules, in the order they are checked, because each exists to prevent a specific way
 * of losing someone's cache:
 *   1. `~/.vibectx` already exists → use it and touch nothing. A user who has both
 *      directories has already moved on; overwriting the new one with the old would lose
 *      the newer cache, which is the worst outcome available here.
 *   2. No `~/.docs-cache-mcp` → use `~/.vibectx`. Nothing to migrate.
 *   3. Otherwise rename `~/.docs-cache-mcp` to `~/.vibectx` — a rename, never a copy: a
 *      copy can half-succeed and leave two divergent caches, and a rename either happens
 *      or does not.
 *   4. The rename failed (cross-device, permissions, a race with another process) → keep
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
  if (existsSync(current) || !existsSync(legacy)) return current;
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
}
