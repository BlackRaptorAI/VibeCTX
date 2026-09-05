import type { LibraryEntry } from "./registry.js";
import { readCache, writeCache, touchCache } from "./cache.js";

export interface DocResult {
  content: string;
  url: string;
  /** Present when the network failed and cached content past its TTL was served. */
  staleNote?: string;
}

const DEFAULT_TTL_HOURS = 168; // 7 days

/** Largest primary document (llms-full.txt etc.) we will download. Prisma's
 *  llms-full.txt is ~5 MB (CITED: PAR-706 rework note), so this leaves headroom. */
export const PRIMARY_DOC_MAX_BYTES = 25 * 1024 * 1024;
/** Largest single followed index page we will download. */
export const LINKED_PAGE_MAX_BYTES = 2 * 1024 * 1024;

interface FetchOutcome {
  /** `refused`: the response's final URL (after redirects) left the allowed origin
   *  or was not https — body never read. `too-large`: exceeded `maxBytes`. */
  status: "ok" | "not-modified" | "miss" | "refused" | "too-large";
  body?: string;
  etag?: string;
}

interface FetchOptions {
  etag?: string;
  /** Hard cap on the downloaded body; enforced via Content-Length and while streaming. */
  maxBytes: number;
  /** When set, the response's final URL must be https on exactly this origin. */
  allowedOrigin?: string;
}

/** Read a body up to `maxBytes`; `undefined` once the cap is exceeded (the stream
 *  is cancelled so no further bytes are pulled). */
async function readBodyCapped(res: Response, maxBytes: number): Promise<string | undefined> {
  if (!res.body) {
    const text = await res.text();
    return text.length > maxBytes ? undefined : text;
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      return undefined;
    }
    chunks.push(value);
  }
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    joined.set(c, offset);
    offset += c.byteLength;
  }
  return new TextDecoder().decode(joined);
}

async function fetchUrl(url: string, opts: FetchOptions): Promise<FetchOutcome> {
  try {
    const headers: Record<string, string> = {
      "user-agent":
        "vibectx/0.1 (+https://github.com/BlackRaptorAI/VibeCTX)",
    };
    if (opts.etag) headers["if-none-match"] = opts.etag;
    const res = await fetch(url, {
      headers,
      redirect: "follow",
      signal: AbortSignal.timeout(20_000),
    });
    if (opts.allowedOrigin !== undefined) {
      // The pre-fetch guard saw the link URL; redirects can move it. Re-check
      // where the chain actually ended before touching the body.
      const final = new URL(res.url || url);
      if (final.protocol !== "https:" || final.origin !== opts.allowedOrigin) {
        await res.body?.cancel();
        return { status: "refused" };
      }
    }
    if (res.status === 304) return { status: "not-modified" };
    if (!res.ok) return { status: "miss" };
    const declared = Number(res.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > opts.maxBytes) {
      await res.body?.cancel();
      return { status: "too-large" };
    }
    const type = res.headers.get("content-type") ?? "";
    const body = await readBodyCapped(res, opts.maxBytes);
    if (body === undefined) return { status: "too-large" };
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
    // No origin pin here: primary URLs legitimately redirect across hosts
    // (docs.anthropic.com → platform.claude.com); they are operator-configured, not content-derived.
    const out = await fetchUrl(url, { etag: cached?.meta.etag, maxBytes: PRIMARY_DOC_MAX_BYTES });
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

export type LinkedPageResult =
  | { status: "ok"; page: DocResult }
  /** Guard refusal: link outside the source origin, before or after redirects. */
  | { status: "refused" }
  /** Response exceeded LINKED_PAGE_MAX_BYTES; nothing cached. */
  | { status: "too-large" }
  /** Network / HTTP failure with nothing cached to fall back on. */
  | { status: "unavailable" };

/** Fetch a single linked page (for llms.txt index files), cache-backed with the
 *  same revalidation policy. Refuses links outside the source document's origin
 *  both before the fetch and after redirects; refused responses are never read or cached. */
export async function fetchLinkedPage(
  library: string,
  url: string,
  sourceUrl: string,
  ttlHours = DEFAULT_TTL_HOURS,
): Promise<LinkedPageResult> {
  if (!isAllowedLink(url, sourceUrl)) return { status: "refused" };
  const hit = readCache(library, url, ttlHours);
  if (hit && !hit.stale) return { status: "ok", page: { content: hit.content, url } };
  const out = await fetchUrl(url, {
    etag: hit?.meta.etag,
    maxBytes: LINKED_PAGE_MAX_BYTES,
    allowedOrigin: new URL(sourceUrl).origin,
  });
  if (out.status === "refused") return { status: "refused" };
  if (out.status === "too-large") return { status: "too-large" };
  if (out.status === "not-modified" && hit) {
    touchCache(library, url);
    return { status: "ok", page: { content: hit.content, url } };
  }
  if (out.status === "ok" && out.body !== undefined) {
    writeCache(library, url, out.body, out.etag);
    return { status: "ok", page: { content: out.body, url } };
  }
  if (hit) {
    return {
      status: "ok",
      page: {
        content: hit.content,
        url,
        staleNote: `STALE: served from cache fetched ${hit.meta.fetchedAt}.`,
      },
    };
  }
  return { status: "unavailable" };
}

/** Simple form of fetchLinkedPage: the page, or `undefined` for any refusal or failure. */
export async function getLinkedPage(
  library: string,
  url: string,
  sourceUrl: string,
  ttlHours = DEFAULT_TTL_HOURS,
): Promise<DocResult | undefined> {
  const result = await fetchLinkedPage(library, url, sourceUrl, ttlHours);
  return result.status === "ok" ? result.page : undefined;
}
