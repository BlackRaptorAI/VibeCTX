import type { LibraryEntry } from "./registry.js";
import { readCache, writeCache, touchCache } from "./cache.js";

export interface DocResult {
  content: string;
  url: string;
  /** Present when the network failed and cached content past its TTL was served. */
  staleNote?: string;
}

const DEFAULT_TTL_HOURS = 168; // 7 days

interface FetchOutcome {
  status: "ok" | "not-modified" | "miss";
  body?: string;
  etag?: string;
}

async function fetchUrl(url: string, etag?: string): Promise<FetchOutcome> {
  try {
    const headers: Record<string, string> = {
      "user-agent":
        "vibectx/0.1 (+https://github.com/BlackRaptorAI/VibeCTX)",
    };
    if (etag) headers["if-none-match"] = etag;
    const res = await fetch(url, {
      headers,
      redirect: "follow",
      signal: AbortSignal.timeout(20_000),
    });
    if (res.status === 304) return { status: "not-modified" };
    if (!res.ok) return { status: "miss" };
    const type = res.headers.get("content-type") ?? "";
    const body = await res.text();
    if (type.includes("text/html") && !url.endsWith(".md")) {
      // Some sites serve their 404 page with 200; a real llms.txt is plain text.
      if (body.slice(0, 500).toLowerCase().includes("<!doctype html")) {
        return { status: "miss" };
      }
    }
    if (body.trim().length === 0) return { status: "miss" };
    return { status: "ok", body, etag: res.headers.get("etag") ?? undefined };
  } catch {
    return { status: "miss" };
  }
}

/**
 * Resolve a library's primary document: probe candidate URLs in order,
 * serving from cache within TTL, revalidating with If-None-Match when stale
 * (a 304 refreshes the TTL without re-downloading), and serving stale content
 * (flagged) when the network is unavailable.
 */
export async function getLibraryDoc(
  entry: LibraryEntry,
  opts: { forceRefresh?: boolean } = {},
): Promise<DocResult | undefined> {
  const ttl = entry.ttlHours ?? DEFAULT_TTL_HOURS;

  if (!opts.forceRefresh) {
    for (const url of entry.urls) {
      const hit = readCache(entry.name, url, ttl);
      if (hit && !hit.stale) return { content: hit.content, url };
    }
  }

  // Cache miss, stale, or forced: try the network in candidate order,
  // revalidating against any cached etag first.
  for (const url of entry.urls) {
    const cached = readCache(entry.name, url, ttl);
    const out = await fetchUrl(url, cached?.meta.etag);
    if (out.status === "not-modified" && cached) {
      touchCache(entry.name, url); // content unchanged upstream: refresh the TTL
      return { content: cached.content, url };
    }
    if (out.status === "ok" && out.body !== undefined) {
      writeCache(entry.name, url, out.body, out.etag);
      return { content: out.body, url };
    }
  }

  // Network failed everywhere: serve stale cache if any candidate has one.
  for (const url of entry.urls) {
    const hit = readCache(entry.name, url, ttl);
    if (hit) {
      return {
        content: hit.content,
        url,
        staleNote: `STALE: served from cache fetched ${hit.meta.fetchedAt}; all candidate URLs unreachable just now.`,
      };
    }
  }
  return undefined;
}

/**
 * Guard for followed index links: https-only, and confined to the origin of
 * the source document. Content-derived URLs are untrusted input — without
 * this, a compromised docs page could steer fetches at internal endpoints.
 */
export function isAllowedLink(linkUrl: string, sourceUrl: string): boolean {
  try {
    const link = new URL(linkUrl);
    const source = new URL(sourceUrl);
    return link.protocol === "https:" && link.origin === source.origin;
  } catch {
    return false;
  }
}

/** Fetch a single linked page (for llms.txt index files), cache-backed with the
 *  same revalidation policy. Rejects links outside the source document's origin. */
export async function getLinkedPage(
  library: string,
  url: string,
  sourceUrl: string,
  ttlHours = DEFAULT_TTL_HOURS,
): Promise<DocResult | undefined> {
  if (!isAllowedLink(url, sourceUrl)) return undefined;
  const hit = readCache(library, url, ttlHours);
  if (hit && !hit.stale) return { content: hit.content, url };
  const out = await fetchUrl(url, hit?.meta.etag);
  if (out.status === "not-modified" && hit) {
    touchCache(library, url);
    return { content: hit.content, url };
  }
  if (out.status === "ok" && out.body !== undefined) {
    writeCache(library, url, out.body, out.etag);
    return { content: out.body, url };
  }
  if (hit) {
    return {
      content: hit.content,
      url,
      staleNote: `STALE: served from cache fetched ${hit.meta.fetchedAt}.`,
    };
  }
  return undefined;
}
