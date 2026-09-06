import { mkdirSync, readFileSync, writeFileSync, existsSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

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

/** Write `path` via a temp file in the same directory and an atomic rename, so a
 *  concurrent reader (another vibectx process on the same cache, the startup autowarm
 *  beside a tool call) sees the old file or the new one, never a partial one (S4, PAR-656).
 *  The temp file is removed if the write fails. */
function writeAtomic(path: string, data: string): void {
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(tmp, data, "utf8");
    renameSync(tmp, path);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
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

/** Content first, then meta — each atomically. A crash between the two leaves content
 *  without meta, which readCache reports as a miss (both files are required), so no
 *  reader can observe a torn pair. */
export function writeCache(
  library: string,
  url: string,
  content: string,
  etag?: string,
): void {
  const dir = libDir(library);
  mkdirSync(dir, { recursive: true });
  writeAtomic(join(dir, `${urlSlug(url)}.md`), content);
  const meta: CacheMeta = { url, fetchedAt: new Date().toISOString(), etag };
  writeAtomic(join(dir, `${urlSlug(url)}.meta.json`), JSON.stringify(meta, null, 2));
}
