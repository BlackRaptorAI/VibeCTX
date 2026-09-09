/**
 * Allowed-host link policy (PAR-655). The single source of truth for "may a
 * content-derived URL be fetched?": the pre-check in get-docs.ts, the guard at the
 * top of fetchLinkedPage and the post-redirect check inside fetchUrl all call
 * `isAllowedLink`, so no caller can apply a weaker rule than another.
 *
 * Content-derived URLs (index links, redirect targets, package-registry metadata)
 * are untrusted input. Without this, a compromised docs page or a malicious package
 * could steer fetches at internal endpoints.
 *
 * This file is also the sole owner of the URL trust decision for a config-authored
 * library entry's `urls` (D-49): `config.ts` calls `validateLibraryUrl` rather than
 * re-implementing any part of the host check. Records D-47 / D-49.
 */

export interface LinkPolicy {
  /** Extra hosts a followed link may target. Bare hostnames, folded lowercase;
   *  `*.example.com` matches any subdomain (not the apex). Malformed entries are
   *  ignored by the matcher (they never match) and rejected by config validation. */
  allowedHosts?: string[];
}

const IPV4_RE = /^\d{1,3}(\.\d{1,3}){3}$/;
const LABEL_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const MAX_HOST_LENGTH = 253;
/** Metadata URL values longer than this are dropped unread. */
const MAX_REMOTE_URL_LENGTH = 2048;

/**
 * Hosts that are never fetched from a content-derived URL, whatever any allow-list
 * says: IP literals (v4, and v6 in either `[::1]` or bare form), `localhost` and its
 * subdomains, `.local` / `.internal` names, single-label names (which only
 * resolve inside a private search domain), and any host with a trailing dot.
 * Compared after lowercasing. Note that
 * the WHATWG URL parser normalises decimal / hex / short IPv4 forms
 * (`2130706433`, `0x7f.1`) to dotted quads before this sees them.
 */
export function isForbiddenHost(hostname: string): boolean {
  const h = hostname.trim().toLowerCase();
  if (h.length === 0) return true;
  if (h.endsWith(".")) return true; // "localhost." / "x.internal." would slip past the suffix checks; a trailing dot has no legitimate use here
  if (h.startsWith("[") || h.includes(":")) return true; // IPv6 literal
  if (IPV4_RE.test(h)) return true;
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  if (h.endsWith(".local") || h.endsWith(".internal")) return true;
  if (!h.includes(".")) return true;
  return false;
}

/**
 * Validate one `allowedHosts` entry (config or persisted) and return its folded form.
 * Accepts a bare hostname of at least two labels, optionally prefixed by exactly one
 * `*.`; rejects schemes, paths, ports, userinfo, other wildcard positions, IP
 * literals and every host `isForbiddenHost` names. Throws with a message that
 * starts with `allowedHosts:` so config errors read naturally.
 */
export function normaliseAllowedHost(raw: unknown): string {
  const shown = typeof raw === "string" ? raw : JSON.stringify(raw);
  const fail = (why: string): never => {
    throw new Error(`allowedHosts: "${shown}" ${why}`);
  };
  if (typeof raw !== "string") return fail("must be a string");
  const value = raw.trim().toLowerCase();
  if (value.length === 0) return fail("is empty");
  let wildcard = false;
  let host = value;
  if (host.startsWith("*.")) {
    wildcard = true;
    host = host.slice(2);
  }
  if (host.includes("*")) return fail("may only use a single leading *. wildcard");
  if (/[:/@?#\\\s]/.test(host)) return fail("must be a bare hostname (no scheme, port, path or userinfo)");
  if (host.length > MAX_HOST_LENGTH) return fail(`is longer than ${MAX_HOST_LENGTH} characters`);
  const labels = host.split(".");
  if (labels.length < 2) {
    return fail(wildcard ? "needs at least two labels after the *. wildcard" : "must have at least two labels (no single-label hosts)");
  }
  for (const label of labels) if (!LABEL_RE.test(label)) return fail("is not a valid hostname");
  if (isForbiddenHost(host)) return fail("is a private, loopback or non-routable host");
  return wildcard ? `*.${host}` : host;
}

/**
 * Validate one library `urls` entry (D-47, D-49): must be a non-empty string that parses
 * as `https:`, carries no userinfo, and whose host `isForbiddenHost` does not name — unless
 * the config author set `allowInternalHosts` on that entry, the explicit per-entry opt-in for
 * the air-gapped / internal-docs case (documented in README.md's config-field reference).
 * This is the sole gate between a committed `vibectx.config.json` and the fetch
 * `startAutowarm` makes at server startup with no user action. The opt-in reaches only THIS
 * entry's own primary fetch: it is not threaded into `isAllowedLink`, so an internal entry's
 * followed index links are still refused. Throws with a message that starts with `urls:` so
 * config errors read naturally; returns nothing on success.
 */
export function validateLibraryUrl(raw: unknown, opts?: { allowInternalHosts?: boolean }): void {
  const shown = typeof raw === "string" ? raw : JSON.stringify(raw);
  const fail = (why: string): never => {
    throw new Error(`urls: "${shown}" ${why}`);
  };
  if (typeof raw !== "string" || raw.trim().length === 0) return fail("must be a non-empty string");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return fail("must be a valid URL");
  }
  if (url.protocol !== "https:") return fail("must use https:");
  if (url.username !== "" || url.password !== "") return fail("must not include userinfo");
  if (!opts?.allowInternalHosts && isForbiddenHost(url.hostname)) return fail("is a private, loopback or non-routable host");
}

/** `pattern` is a value `normaliseAllowedHost` returned; `host` is a lowercase hostname. */
function hostMatchesPattern(host: string, pattern: string): boolean {
  if (pattern.startsWith("*.")) {
    const suffix = pattern.slice(1); // ".example.com"
    return host.length > suffix.length && host.endsWith(suffix);
  }
  return host === pattern;
}

/**
 * May `linkUrl`, found in the document at `sourceUrl`, be fetched?
 *
 * - `https:` only; no userinfo; the target host must not be forbidden (see
 *   `isForbiddenHost`) — that holds even when the source document itself lives there.
 * - The source document's own host is always allowed, on the source's port exactly
 *   (an explicit non-default port must match; this is the 0.1.3 same-origin rule).
 * - Any other host must match an entry of `policy.allowedHosts` and use the default
 *   port. Policy entries are validated on the way in; a malformed one never matches.
 *
 * Path and query are not restricted. Returns false for anything unparseable.
 */
export function isAllowedLink(linkUrl: string, sourceUrl: string, policy?: LinkPolicy): boolean {
  let link: URL;
  let source: URL;
  try {
    link = new URL(linkUrl);
    source = new URL(sourceUrl);
  } catch {
    return false;
  }
  if (link.protocol !== "https:") return false;
  if (link.username !== "" || link.password !== "") return false;
  const host = link.hostname.toLowerCase();
  if (isForbiddenHost(host)) return false;
  if (host === source.hostname.toLowerCase()) return link.port === source.port;
  if (link.port !== "") return false;
  for (const raw of policy?.allowedHosts ?? []) {
    let pattern: string;
    try {
      pattern = normaliseAllowedHost(raw);
    } catch {
      continue;
    }
    if (hostMatchesPattern(host, pattern)) return true;
  }
  return false;
}

/**
 * Two-part public suffixes under which the registrable domain is three labels long.
 * Deliberately small — no dependency on the Public Suffix List. Anything not listed
 * here is treated as a one-part suffix, so `docs.foo.co.jp`-style hosts under an
 * unlisted country suffix derive `docs.co.jp` rather than `docs.foo.co.jp` (a host
 * that either does not exist or is not the project's; harmless but useless).
 */
const TWO_PART_SUFFIXES = new Set([
  "co.uk", "org.uk", "ac.uk", "gov.uk", "me.uk", "net.uk",
  "com.au", "net.au", "org.au", "edu.au",
  "co.nz", "net.nz", "org.nz",
  "co.jp", "ne.jp", "or.jp", "ac.jp",
  "co.kr", "co.za", "co.in", "co.il",
  "com.br", "net.br", "org.br",
  "com.cn", "net.cn", "org.cn",
  "com.mx", "com.ar", "com.tr", "com.sg", "com.hk", "com.tw",
  "github.io", "gitlab.io", "netlify.app", "vercel.app", "pages.dev", "web.app",
  "firebaseapp.com", "herokuapp.com", "readthedocs.io", "azurewebsites.net",
  "cloudfront.net", "amazonaws.com",
]);

/**
 * Conservative registrable domain: the last two labels, or the last three when the
 * last two are a listed two-part suffix. Undefined for forbidden hosts (IPs,
 * localhost, single labels) and for a bare suffix (`co.uk`).
 */
export function registrableDomain(hostname: string): string | undefined {
  const host = hostname.trim().toLowerCase();
  if (isForbiddenHost(host)) return undefined;
  const labels = host.split(".");
  if (labels.some((l) => l.length === 0)) return undefined;
  const lastTwo = labels.slice(-2).join(".");
  if (TWO_PART_SUFFIXES.has(lastTwo)) return labels.length >= 3 ? labels.slice(-3).join(".") : undefined;
  return lastTwo;
}

/**
 * Parse an attacker-influenced URL value (package metadata, persisted records):
 * must be a string of at most 2048 characters that parses as `https:` with no
 * userinfo and a non-forbidden host. Returns the normalised href without its
 * fragment, or undefined — callers skip a bad value, never fail on it.
 */
export function sanitizeRemoteUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const raw = value.trim();
  if (raw.length === 0 || raw.length > MAX_REMOTE_URL_LENGTH) return undefined;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:") return undefined;
  if (url.username !== "" || url.password !== "") return undefined;
  if (isForbiddenHost(url.hostname)) return undefined;
  url.hash = "";
  return url.href;
}

/**
 * The hosts a *resolved* entry may follow links to, derived from its metadata and
 * never from anything it stored: the homepage host, the docs-URL host and
 * `docs.<registrable domain of the homepage>`. Deduplicated, forbidden hosts
 * dropped, non-https input ignored. Recomputed on every load of resolved.json so a
 * persisted record cannot widen its own allow-list.
 */
export function derivedAllowedHosts(meta: { homepage?: string; docsUrl?: string }): string[] {
  const hosts: string[] = [];
  const add = (h: string | undefined) => {
    if (h && !isForbiddenHost(h) && !hosts.includes(h)) hosts.push(h);
  };
  const homepage = sanitizeRemoteUrl(meta.homepage);
  const docs = sanitizeRemoteUrl(meta.docsUrl);
  if (homepage) add(new URL(homepage).hostname);
  if (docs) add(new URL(docs).hostname);
  if (homepage) {
    const reg = registrableDomain(new URL(homepage).hostname);
    if (reg) add(`docs.${reg}`);
  }
  return hosts;
}
