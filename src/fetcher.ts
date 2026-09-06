import type { LibraryEntry } from "./registry.js";
import { readCache, writeCache, touchCache } from "./cache.js";
import { isAllowedLink, isForbiddenHost, type LinkPolicy } from "./link-policy.js";

export { isAllowedLink, type LinkPolicy } from "./link-policy.js";

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

export interface FetchOutcome {
  /** `refused`: a redirect target or the final URL failed the guard (left the allowed
   *  hosts, or was not https on a public host) — never requested, body never read.
   *  `too-large`: exceeded `maxBytes`. `miss`: HTTP failure, > MAX_REDIRECT_HOPS, or no Location. */
  status: "ok" | "not-modified" | "miss" | "refused" | "too-large";
  body?: string;
  etag?: string;
}

export interface FetchOptions {
  etag?: string;
  /** Hard cap on the downloaded body; enforced via Content-Length and while streaming. */
  maxBytes: number;
  /** When set, the response's final URL must pass `isAllowedLink` against this source
   *  document and policy — the same function the pre-fetch guard applied to the link. */
  linkGuard?: { sourceUrl: string; policy?: LinkPolicy };
  /** When set, the FIRST URL is content-derived too (resolved entries, registry metadata):
   *  the final URL must be https on a non-forbidden host even when no redirect happened.
   *  Redirect targets are held to that baseline for every caller (see hopAllowed). */
  publicFinalUrl?: boolean;
}

/** https on a host `isForbiddenHost` does not name; false for anything unparseable. */
export function isPublicHttpsUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && !isForbiddenHost(u.hostname);
  } catch {
    return false;
  }
}

/** Redirect hops followed per request; beyond this the fetch is a miss. */
export const MAX_REDIRECT_HOPS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/**
 * May a redirect target (or the final URL) be requested under `opts`? Every redirect
 * target — whoever configured the first URL — must be https on a public host: an
 * operator's curated primary may redirect across hosts (D-04) but never to http, an IP
 * literal or localhost. On top of that, the caller's guard applies: `linkGuard` runs
 * `isAllowedLink` (the same function as the pre-fetch check); `publicFinalUrl` is the
 * baseline itself.
 */
function hopAllowed(target: string, opts: FetchOptions): boolean {
  if (!isPublicHttpsUrl(target)) return false;
  if (opts.linkGuard !== undefined && !isAllowedLink(target, opts.linkGuard.sourceUrl, opts.linkGuard.policy)) return false;
  return true;
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

/** One capped, timed-out GET. Exported for the resolver's registry-metadata lookups
 *  (which need the same byte cap and HTML-as-200 detection); everything else goes
 *  through getLibraryDoc / fetchLinkedPage. */
export async function fetchUrl(url: string, opts: FetchOptions): Promise<FetchOutcome> {
  try {
    const headers: Record<string, string> = {
      "user-agent":
        "vibectx/0.1.3 (+https://github.com/BlackRaptorAI/VibeCTX)",
    };
    if (opts.etag) headers["if-none-match"] = opts.etag;
    // Redirects are followed by hand (S1, PAR-655 security gate): with redirect:"follow"
    // the runtime would issue the request to the Location before any check could run —
    // a blind SSRF for a 302 to http://127.0.0.1/. Each Location is checked BEFORE it is
    // requested; on refusal no request is made.
    if (opts.publicFinalUrl && !isPublicHttpsUrl(url)) return { status: "refused" }; // content-derived first URL: check before requesting
    let current = url;
    let res: Response;
    for (let hop = 0; ; hop++) {
      res = await fetch(current, {
        headers,
        redirect: "manual",
        signal: AbortSignal.timeout(20_000),
      });
      if (!REDIRECT_STATUSES.has(res.status)) break;
      const location = res.headers.get("location");
      await res.body?.cancel();
      if (location === null || hop >= MAX_REDIRECT_HOPS) return { status: "miss" };
      let next: string;
      try {
        next = new URL(location, current).href; // relative Locations resolve against the current URL
      } catch {
        return { status: "miss" };
      }
      if (!hopAllowed(next, opts)) return { status: "refused" };
      current = next;
    }
    // Final-URL check kept: should a runtime report a different res.url, judge that too.
    // (No redirect happened when res.url equals the operator's own first URL.)
    const final = res.url || current;
    if (final !== url && !hopAllowed(final, opts)) {
      await res.body?.cancel();
      return { status: "refused" };
    }
    if (opts.linkGuard !== undefined && !isAllowedLink(final, opts.linkGuard.sourceUrl, opts.linkGuard.policy)) {
      await res.body?.cancel();
      return { status: "refused" };
    }
    if (opts.publicFinalUrl && !isPublicHttpsUrl(final)) {
      await res.body?.cancel();
      return { status: "refused" };
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
  opts: { forceRefresh?: boolean; /** Cache-only: the network is never attempted. */ offline?: boolean } = {},
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
  if (!opts.offline) {
    for (const url of entry.urls) {
      const cached = readCache(entry.name, url, ttl);
      // No origin pin here: primary URLs legitimately redirect across hosts
      // (docs.anthropic.com → platform.claude.com) — D-04; redirect targets must still be https
      // on a public host (fetchUrl). A resolved entry's URLs came from package metadata, so
      // its first URL is held to that baseline as well.
      const out = await fetchUrl(url, {
        etag: cached?.meta.etag,
        maxBytes: PRIMARY_DOC_MAX_BYTES,
        publicFinalUrl: entry.resolved !== undefined,
      });
      if (out.status === "not-modified" && cached) {
        touchCache(entry.name, url); // content unchanged upstream: refresh the TTL
        return { content: cached.content, url };
      }
      if (out.status === "ok" && out.body !== undefined) {
        writeCache(entry.name, url, out.body, out.etag);
        return { content: out.body, url };
      }
    }
  }

  // Network failed everywhere (or offline): serve stale cache if any candidate has one.
  for (const url of entry.urls) {
    const hit = readCache(entry.name, url, ttl);
    if (hit) {
      return {
        content: hit.content,
        url,
        staleNote: opts.offline
          ? `STALE: served from cache fetched ${hit.meta.fetchedAt}; offline mode, network not attempted.`
          : `STALE: served from cache fetched ${hit.meta.fetchedAt}; all candidate URLs unreachable just now.`,
      };
    }
  }
  return undefined;
}

export type LinkedPageResult =
  | { status: "ok"; page: DocResult }
  /** Guard refusal: link outside the allowed hosts (see link-policy.ts), before or after redirects. */
  | { status: "refused" }
  /** Response exceeded LINKED_PAGE_MAX_BYTES; nothing cached. */
  | { status: "too-large" }
  /** Network / HTTP failure with nothing cached to fall back on. */
  | { status: "unavailable" };

/** Fetch a single linked page (for llms.txt index files), cache-backed with the
 *  same revalidation policy. Refuses links the allowed-host policy rejects (the source
 *  document's host plus `policy.allowedHosts`; https only) both before the fetch and
 *  after redirects; refused responses are never read or cached. Without a policy this
 *  is the 0.1.3 same-origin rule. With `offline`, the network is never attempted: cached
 *  pages (fresh or stale) are served and anything else is `unavailable`. */
export async function fetchLinkedPage(
  library: string,
  url: string,
  sourceUrl: string,
  ttlHours = DEFAULT_TTL_HOURS,
  offline = false,
  policy?: LinkPolicy,
): Promise<LinkedPageResult> {
  if (!isAllowedLink(url, sourceUrl, policy)) return { status: "refused" };
  const hit = readCache(library, url, ttlHours);
  if (hit && !hit.stale) return { status: "ok", page: { content: hit.content, url } };
  if (offline) {
    if (!hit) return { status: "unavailable" };
    return {
      status: "ok",
      page: { content: hit.content, url, staleNote: `STALE: served from cache fetched ${hit.meta.fetchedAt}.` },
    };
  }
  const out = await fetchUrl(url, {
    etag: hit?.meta.etag,
    maxBytes: LINKED_PAGE_MAX_BYTES,
    linkGuard: { sourceUrl, policy },
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
