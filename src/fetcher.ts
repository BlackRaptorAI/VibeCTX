import type { LibraryEntry } from "./registry.js";
import { readCache, writeCache, touchCache } from "./cache.js";
import { isAllowedLink, isForbiddenHost, type LinkPolicy } from "./link-policy.js";
import { USER_AGENT } from "./version.js";
import { classifyFetchError, debugEvent } from "./debug.js";

export { isAllowedLink, type LinkPolicy } from "./link-policy.js";

export interface DocResult {
  content: string;
  /** The CANDIDATE URL this document was requested under — one of `entry.urls`, or the link
   *  extracted from an index page. Stays the cache/search-index key throughout (D-74, PAR-776):
   *  `writeCache`/`readCache` are keyed by this value, and `search-index.ts`'s hash+url gate
   *  correlates against it, so it must never be silently replaced by `finalUrl` below — doing
   *  so would make every redirected document's index entry permanently "not this URL" and
   *  force a full re-tokenization on every search, forever. */
  url: string;
  /** PAR-776 (D-74) — the URL this content was ACTUALLY served from: `url` above unless a
   *  redirect moved the fetch elsewhere, in which case this is where it landed. `get-docs.ts`
   *  uses THIS, not `url`, to resolve the document's own relative links and to decide which
   *  hosts its followed links may reach — a primary document that redirects cross-host used to
   *  resolve its relative links against the ORIGINAL host, which is wrong (they were never
   *  served from there) and could refuse a link that is actually same-origin with the document
   *  as fetched, or (less likely, but not excluded) allow one that is not. Equal to `url` when
   *  there was no redirect, including every cache-hit path that never asked the network at all
   *  and has no live `fetchUrl` result to consult — see `cache-meta.ts`'s `CacheMeta.finalUrl`
   *  for how this survives past the fetch that first observed it. */
  finalUrl: string;
  /** A17/PAR-726: when this document's cache meta was last written, ISO — the exact value
   *  persisted by `writeCache`/`touchCache`, not a freshly-taken `new Date()` that could
   *  disagree with it. */
  fetchedAt: string;
  /** A17/PAR-726: past this document's TTL. Structurally identical to `staleNote !== undefined`
   *  today (every path below that omits `staleNote` also served a definitely-fresh copy), kept
   *  as its own field rather than re-derived so a caller reads staleness without parsing prose.
   *  Distinct from `notModified` below, not a THIRD copy of the same fact (code-reviewer, A17
   *  round 1, S4): `stale`/`staleNote` answer "is this copy past TTL" (true only on the
   *  network-unreachable fallback path); `notModified` answers "was THIS fetch a 304
   *  revalidation of already-fresh content" (true only on that path) — the two conditions are
   *  mutually exclusive by construction, never set together. */
  stale: boolean;
  /** PAR-744 (F-7) — true when this content is the SAME bytes already cached, confirmed by a
   *  304 Not Modified revalidation rather than downloaded fresh. `refresh.ts` uses this
   *  (alongside `staleNote`, see `isDocUnchanged` below) to decide whether a refresh actually
   *  changed anything: a caller that drops a library's followed-page cache on every
   *  "successful" refresh, without this distinction, drops it even when nothing changed (see
   *  `dropFollowedPageCache`'s own doc comment in cache.ts). ETag-only (code-reviewer, round
   *  1, S3): `fetchUrl` sends `if-none-match` and nothing else — no `if-modified-since` /
   *  `last-modified` support exists anywhere in this codebase — so a docs site that serves no
   *  `etag` can never produce a 304 here and still drops its followed pages on every refresh,
   *  exactly as before this item. */
  notModified?: true;
  /** Present when the network failed and cached content past its TTL was served. */
  staleNote?: string;
}

/** PAR-744 (F-7, code-reviewer round 1, N1) — the one predicate for "this `DocResult` is not
 *  NEW content", used identically by both `refresh.ts` (guarding the direct-fetch drop) and
 *  `resolve.ts` (deriving `ResolveOutcome.unchanged` for the resolved-entry drop), so the two
 *  guards are structurally the same rule rather than two hand-written spellings that happen to
 *  agree. True for a 304 revalidation (`notModified`) or a stale-cache fallback because the
 *  network was unreachable (`staleNote`) — in both cases the primary document on disk was not
 *  rewritten (see `dropFollowedPageCache`'s doc comment in cache.ts for why that is the
 *  correct predicate, not "did the origin server confirm nothing changed"). */
export function isDocUnchanged(doc: Pick<DocResult, "notModified" | "staleNote">): boolean {
  return doc.notModified === true || doc.staleNote !== undefined;
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
  /** A16/PAR-725 — the response's HTTP status code, set only on the `"http-status"` miss
   *  reason (a real response was received and `!res.ok`). Every OTHER `miss` reason (a
   *  redirect loop, an unparsable Location, html-served-as-200, a thrown network error) has
   *  no real status to report and leaves this undefined — a caller that needs "was this
   *  genuinely a 404" (the registry-metadata existence check `resolve.ts` needs to
   *  distinguish "package does not exist" from "network unreachable") must check this field,
   *  not merely `status === "miss"`, which conflates both. */
  httpStatus?: number;
  /** PAR-776 (D-74) — the URL this request actually landed on after following redirects
   *  (`final` below), present whenever a response was actually obtained (`ok` and
   *  `not-modified` — a 304 still follows redirects to reach whichever server answered it).
   *  Equal to the requested `url` when nothing redirected. Absent on `refused`/`too-large`/
   *  `miss`: no content was ever accepted from those, so there is nothing for a caller to
   *  attribute to a "final" URL. */
  finalUrl?: string;
  /** PAR-832a — set only on the `"html-not-text"` miss reason: a real (usually 200) response
   *  came back, but it was an HTML page, not the text/markdown content this tool reads. This
   *  is the one miss reason `fetchLinkedPage` treats as potentially recoverable (retry with a
   *  `.md`-suffixed URL) — every other miss reason (a genuine HTTP error, a timeout, a DNS
   *  failure, a redirect loop) is not: retrying those would not plausibly change the outcome,
   *  only spend a second request finding that out. */
  htmlNotText?: true;
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
  /** PAR-832a — sent as the `Accept` header, when set; absent (the default) sends no `Accept`
   *  header at all, exactly as before this option existed. SCOPE: `fetchLinkedPage` sets this
   *  for followed index links; `getLibraryDoc` (the primary-document path) deliberately never
   *  does — content negotiation on the primary path could change what gets cached for a
   *  library that already works today, a far larger blast radius than the followed-link gap
   *  this exists to close. */
  accept?: string;
}

/** https, no userinfo, on a host `isForbiddenHost` does not name; false for anything
 *  unparseable. The userinfo check (security-architect, PAR-776 round 1, N-3) matches every
 *  other URL-trust gate in this codebase (`link-policy.ts`'s `sanitizeRemoteUrl`,
 *  `validateLibraryUrl`, `isAllowedLink`) — this was the one gate in the redirect path that
 *  didn't, so a hop or final URL carrying `user:pass@` (the redirecting server's own, not the
 *  caller's) was accepted, then persisted (`cache.ts`'s `finalUrl`) and rendered into the
 *  response. Not a credential-theft primitive either way — this process never had a credential
 *  of its own to leak — but there's no reason this one check should be the odd one out. */
export function isPublicHttpsUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && u.username === "" && u.password === "" && !isForbiddenHost(u.hostname);
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
  // PAR-652 item 7b: VIBECTX_DEBUG diagnostics are ADDITIVE — every `debugEvent` below is a
  // stderr line and nothing else. No policy, redirect decision, byte cap or returned value
  // in this function is read from, or changed by, any of them. Nor can one THROW past a
  // return: `debugEvent` never raises (PAR-652b), which is what makes the call in the catch
  // block below safe — a diagnostic must not turn a handled failure into an unhandled one.
  //
  // Three event names, one per outcome, and `reason` names the specific cause within it
  // (PAR-652c, review R4 — `refused` and `too-large` used to return silently while the README
  // promised a line for every fetch failure, so the two outcomes a user is most likely to need
  // explained were the two with nothing to explain them):
  //   fetch.miss       http-status · html-not-text · empty-body · redirect-no-location ·
  //                    redirect-hops · redirect-unparsable · and the thrown-error reasons
  //                    `classifyFetchError` returns (timeout, dns, connection-refused, …)
  //   fetch.refused    not-public · redirect-host · final-host · link-policy
  //   fetch.too-large  content-length (declared, refused before the body is read) · body-cap
  //                    (the cap hit mid-stream, so the true size is unknown)
  // A `refused` line names the target it refused in `to=` when a redirect moved it — that is
  // the whole diagnostic value, and it is the URL the guard already decided against, never a
  // URL that was fetched. Every return path in this function now emits exactly one line.
  const startedAt = Date.now();
  try {
    const headers: Record<string, string> = {
      "user-agent": USER_AGENT, // src/version.ts — the manifest's version, not a second copy of it
    };
    if (opts.etag) headers["if-none-match"] = opts.etag;
    if (opts.accept) headers["accept"] = opts.accept;
    // Redirects are followed by hand (S1, PAR-655 security gate): with redirect:"follow"
    // the runtime would issue the request to the Location before any check could run —
    // a blind SSRF for a 302 to http://127.0.0.1/. Each Location is checked BEFORE it is
    // requested; on refusal no request is made.
    if (opts.publicFinalUrl && !isPublicHttpsUrl(url)) {
      // content-derived first URL: checked before requesting, so no request is made
      debugEvent("fetch.refused", { url, reason: "not-public", ms: Date.now() - startedAt });
      return { status: "refused" };
    }
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
      if (location === null || hop >= MAX_REDIRECT_HOPS) {
        debugEvent("fetch.miss", {
          url,
          reason: location === null ? "redirect-no-location" : "redirect-hops",
          status: res.status,
          ms: Date.now() - startedAt,
        });
        return { status: "miss" };
      }
      let next: string;
      try {
        next = new URL(location, current).href; // relative Locations resolve against the current URL
      } catch {
        debugEvent("fetch.miss", { url, reason: "redirect-unparsable", status: res.status, ms: Date.now() - startedAt });
        return { status: "miss" };
      }
      if (!hopAllowed(next, opts)) {
        debugEvent("fetch.refused", { url, reason: "redirect-host", to: next, status: res.status, ms: Date.now() - startedAt });
        return { status: "refused" };
      }
      current = next;
    }
    // Final-URL check kept: should a runtime report a different res.url, judge that too.
    // (No redirect happened when res.url equals the operator's own first URL.)
    const final = res.url || current;
    if (final !== url && !hopAllowed(final, opts)) {
      await res.body?.cancel();
      debugEvent("fetch.refused", { url, reason: "final-host", to: final, status: res.status, ms: Date.now() - startedAt });
      return { status: "refused" };
    }
    if (opts.linkGuard !== undefined && !isAllowedLink(final, opts.linkGuard.sourceUrl, opts.linkGuard.policy)) {
      await res.body?.cancel();
      debugEvent("fetch.refused", { url, reason: "link-policy", to: final, status: res.status, ms: Date.now() - startedAt });
      return { status: "refused" };
    }
    if (opts.publicFinalUrl && !isPublicHttpsUrl(final)) {
      await res.body?.cancel();
      debugEvent("fetch.refused", { url, reason: "not-public", to: final, status: res.status, ms: Date.now() - startedAt });
      return { status: "refused" };
    }
    if (res.status === 304) return { status: "not-modified", finalUrl: final };
    if (!res.ok) {
      debugEvent("fetch.miss", { url, reason: "http-status", status: res.status, ms: Date.now() - startedAt });
      return { status: "miss", httpStatus: res.status };
    }
    const declared = Number(res.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > opts.maxBytes) {
      await res.body?.cancel();
      debugEvent("fetch.too-large", {
        url,
        reason: "content-length",
        bytes: declared,
        limit: opts.maxBytes,
        ms: Date.now() - startedAt,
      });
      return { status: "too-large" };
    }
    const type = res.headers.get("content-type") ?? "";
    const body = await readBodyCapped(res, opts.maxBytes);
    if (body === undefined) {
      // No declared length, or a lying one: the cap was hit while streaming, so the exact
      // size is unknown — `limit` is what is known and `bytes` is deliberately absent.
      debugEvent("fetch.too-large", { url, reason: "body-cap", limit: opts.maxBytes, ms: Date.now() - startedAt });
      return { status: "too-large" };
    }
    if (type.includes("text/html") && !url.endsWith(".md")) {
      // Some sites serve their 404 page with 200; a real llms.txt is plain text.
      if (body.slice(0, 500).toLowerCase().includes("<!doctype html")) {
        debugEvent("fetch.miss", { url, reason: "html-not-text", status: res.status, ms: Date.now() - startedAt });
        return { status: "miss", htmlNotText: true };
      }
    }
    if (body.trim().length === 0) {
      debugEvent("fetch.miss", { url, reason: "empty-body", status: res.status, ms: Date.now() - startedAt });
      return { status: "miss" };
    }
    return { status: "ok", body, etag: res.headers.get("etag") ?? undefined, finalUrl: final };
  } catch (e) {
    // The one place a 404, a timeout and a DNS failure stop being distinguishable. They stay
    // one `miss` to the caller — the diagnostic line is what tells them apart.
    const failure = classifyFetchError(e);
    debugEvent("fetch.miss", {
      url,
      reason: failure.reason,
      code: failure.code,
      error: failure.message,
      ms: Date.now() - startedAt,
    });
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
      // PAR-776 (D-74): `hit.meta.finalUrl` is the redirect target this same document last
      // landed on, PERSISTED from whichever fetch first observed it — a fresh cache hit makes
      // no network call at all, so this is the only way it can still be reported here.
      if (hit && !hit.stale) return { content: hit.content, url, finalUrl: hit.meta.finalUrl ?? url, fetchedAt: hit.meta.fetchedAt, stale: false };
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
        // content unchanged upstream: refresh the TTL. touchCache can no-op (a concurrent
        // evict/corruption between the read above and here) — cached.meta.fetchedAt is the
        // last value this process actually knows to be true in that case. `out.finalUrl` is
        // passed through so a redirect target that changed since the last fetch (or newly
        // appeared/disappeared) is re-persisted on every revalidation, not just the first fetch.
        const touchedAt = touchCache(entry.name, url, out.finalUrl) ?? cached.meta.fetchedAt;
        return { content: cached.content, url, finalUrl: out.finalUrl ?? cached.meta.finalUrl ?? url, fetchedAt: touchedAt, stale: false, notModified: true };
      }
      if (out.status === "ok" && out.body !== undefined) {
        const fetchedAt = writeCache(entry.name, url, out.body, out.etag, out.finalUrl);
        return { content: out.body, url, finalUrl: out.finalUrl ?? url, fetchedAt, stale: false };
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
        finalUrl: hit.meta.finalUrl ?? url,
        fetchedAt: hit.meta.fetchedAt,
        stale: true,
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

/** PAR-832a — sent on the FIRST attempt only (see `fetchLinkedPage`): several doc-site
 *  frameworks serve raw markdown for exactly this header on a page whose default response is
 *  the rendered HTML (MEASURED against hono.dev, motion.dev and nextjs.org's own non-tutorial
 *  pages, 2026-09-18) — the `.md`-suffix retry below is a second, independent convention
 *  (MEASURED against ui.shadcn.com, which does not negotiate on `Accept` but does serve
 *  markdown at the same path plus `.md`) for sites that use that one instead. Neither is
 *  universal; together they cover every site convention found in the PAR-832 investigation
 *  except next.js's own `/learn/*` interactive-tutorial pages, which have no markdown form on
 *  next.js's own site under either convention — not a gap either strategy can close. */
const LINKED_PAGE_ACCEPT = "text/markdown, text/plain;q=0.9, */*;q=0.1";

/** PAR-832a — `url` with `.md` appended to its PATH (not its query string or fragment), via
 *  `URL` parsing rather than string concatenation, so a URL carrying `?foo=bar` becomes
 *  `...page.md?foo=bar`, never the wrong `...page?foo=bar.md`. Returns undefined for a URL
 *  `new URL` cannot parse — should not happen (`url` already passed `isAllowedLink`, which
 *  requires a parseable URL), but this function makes no assumption about that itself. */
function withMdSuffix(url: string): string | undefined {
  try {
    const u = new URL(url);
    u.pathname = `${u.pathname}.md`;
    return u.href;
  } catch {
    return undefined;
  }
}

/** Fetch a single linked page (for llms.txt index files), cache-backed with the
 *  same revalidation policy. Refuses links the allowed-host policy rejects (the source
 *  document's host plus `policy.allowedHosts`; https only) both before the fetch and
 *  after redirects; refused responses are never read or cached. Without a policy this
 *  is the 0.1.3 same-origin rule. With `offline`, the network is never attempted: cached
 *  pages (fresh or stale) are served and anything else is `unavailable`.
 *
 *  PAR-832a — the first attempt asks for markdown via `Accept` (`LINKED_PAGE_ACCEPT`); if the
 *  response is HTML anyway (`FetchOutcome.htmlNotText`), and `url` does not already end in
 *  `.md`, this recurses EXACTLY ONCE with a `.md`-suffixed URL — never a loop, since that URL
 *  always ends in `.md` and so can never take this branch again on its own recursive call.
 *  The recursive call re-runs this function's own `isAllowedLink` check on the NEW url from
 *  its own top, the same check any other followed link gets — the retry URL is never trusted
 *  because its parent already passed. Budget: this at most DOUBLES the network requests one
 *  followed-link ATTEMPT can cost (one negotiated request, one `.md` retry) — it does not
 *  increase how many DISTINCT links `get-docs.ts`'s `followLimit()` allows a single call to
 *  attempt, so the existing per-call link budget is unchanged; each attempted link can now
 *  cost up to 2 requests instead of 1. */
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
  if (hit && !hit.stale) return { status: "ok", page: { content: hit.content, url, finalUrl: hit.meta.finalUrl ?? url, fetchedAt: hit.meta.fetchedAt, stale: false } };
  if (offline) {
    if (!hit) return { status: "unavailable" };
    return {
      status: "ok",
      page: {
        content: hit.content,
        url,
        finalUrl: hit.meta.finalUrl ?? url,
        fetchedAt: hit.meta.fetchedAt,
        stale: true,
        staleNote: `STALE: served from cache fetched ${hit.meta.fetchedAt}.`,
      },
    };
  }
  const out = await fetchUrl(url, {
    etag: hit?.meta.etag,
    maxBytes: LINKED_PAGE_MAX_BYTES,
    linkGuard: { sourceUrl, policy },
    accept: LINKED_PAGE_ACCEPT,
  });
  if (out.status === "refused") return { status: "refused" };
  if (out.status === "too-large") return { status: "too-large" };
  if (out.status === "not-modified" && hit) {
    // See getLibraryDoc's identical comment: touchCache's no-op fallback is hit.meta.fetchedAt.
    // `out.finalUrl` re-persists a redirect target that may have changed since the last fetch.
    const touchedAt = touchCache(library, url, out.finalUrl) ?? hit.meta.fetchedAt;
    // PAR-744 (F-7, code-reviewer round 1, S5): no production caller reads `notModified` on a
    // followed page today — `get-docs.ts`'s only consumer of a `LinkedPageResult` reads
    // `.page.content`, never `.page.notModified`. Set anyway for `DocResult` symmetry with
    // `getLibraryDoc`, so a future caller that DOES need "was this followed page actually
    // re-fetched" does not have to add a fifth status variant to get it. Covered by
    // `test/fetcher.test.ts`.
    return { status: "ok", page: { content: hit.content, url, finalUrl: out.finalUrl ?? hit.meta.finalUrl ?? url, fetchedAt: touchedAt, stale: false, notModified: true } };
  }
  if (out.status === "ok" && out.body !== undefined) {
    const fetchedAt = writeCache(library, url, out.body, out.etag, out.finalUrl);
    return { status: "ok", page: { content: out.body, url, finalUrl: out.finalUrl ?? url, fetchedAt, stale: false } };
  }
  if (out.status === "miss" && out.htmlNotText && !url.endsWith(".md")) {
    const mdUrl = withMdSuffix(url);
    // A distinct URL, so it gets its OWN cache entry — never mixed with `url`'s. `readCache`
    // above already proved `hit` (if any) is for `url`, not `mdUrl`; the recursive call reads
    // and writes strictly under `mdUrl` from here, keeping the two URLs' cached content
    // (and, per D-71/PAR-749, their on-disk keys) never conflated.
    if (mdUrl !== undefined) return fetchLinkedPage(library, mdUrl, sourceUrl, ttlHours, offline, policy);
  }
  if (hit) {
    return {
      status: "ok",
      page: {
        content: hit.content,
        url,
        finalUrl: hit.meta.finalUrl ?? url,
        fetchedAt: hit.meta.fetchedAt,
        stale: true,
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
