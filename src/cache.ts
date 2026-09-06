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

export function cacheRoot(): string {
  return process.env.DOCS_CACHE_DIR ?? join(homedir(), ".docs-cache-mcp");
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
  // >= so a TTL of 0 means "expire immediately" even when written and read
  // within the same millisecond.
  return {
    content: readFileSync(contentPath, "utf8"),
    meta,
    stale: ageMs >= ttlHours * 3600_000,
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
