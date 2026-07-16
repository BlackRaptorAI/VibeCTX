import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
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

export function writeCache(
  library: string,
  url: string,
  content: string,
  etag?: string,
): void {
  const dir = libDir(library);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${urlSlug(url)}.md`), content, "utf8");
  const meta: CacheMeta = { url, fetchedAt: new Date().toISOString(), etag };
  writeFileSync(
    join(dir, `${urlSlug(url)}.meta.json`),
    JSON.stringify(meta, null, 2),
    "utf8",
  );
}
