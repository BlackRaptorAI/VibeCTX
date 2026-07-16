import type { LibraryEntry } from "./registry.js";
import { readCache, writeCache } from "./cache.js";

export interface DocResult {
  content: string;
  url: string;
  /** Present when the network failed and cached content past its TTL was served. */
  staleNote?: string;
}

const DEFAULT_TTL_HOURS = 168; // 7 days

async function fetchUrl(url: string): Promise<string | undefined> {
  try {
    const res = await fetch(url, {
      headers: { "user-agent": "docs-cache-mcp/0.1 (+https://github.com/BlackRaptorAI/docs-cache-mcp)" },
      redirect: "follow",
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) return undefined;
    const type = res.headers.get("content-type") ?? "";
    // llms.txt and raw markdown are text; reject binary/HTML-only responses of trivial size.
    const body = await res.text();
    if (type.includes("text/html") && !url.endsWith(".md")) {
      // Some sites serve their 404 page with 200; a real llms.txt is plain text.
      if (body.slice(0, 500).toLowerCase().includes("<!doctype html")) return undefined;
    }
    return body.trim().length > 0 ? body : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Resolve a library's primary document: probe candidate URLs in order,
 * serving from cache within TTL, refreshing when stale, and serving stale
 * content (flagged) when the network is unavailable.
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

  // Cache miss, stale, or forced: try the network in candidate order.
  for (const url of entry.urls) {
    const body = await fetchUrl(url);
    if (body !== undefined) {
      writeCache(entry.name, url, body);
      return { content: body, url };
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

/** Fetch a single linked page (for llms.txt index files), cache-backed with the same policy. */
export async function getLinkedPage(
  library: string,
  url: string,
  ttlHours = DEFAULT_TTL_HOURS,
): Promise<DocResult | undefined> {
  const hit = readCache(library, url, ttlHours);
  if (hit && !hit.stale) return { content: hit.content, url };
  const body = await fetchUrl(url);
  if (body !== undefined) {
    writeCache(library, url, body);
    return { content: body, url };
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
