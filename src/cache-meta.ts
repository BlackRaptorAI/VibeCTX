import { lstatSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { sanitizeRemoteUrl } from "./link-policy.js";

/**
 * D-71 (PAR-749) — the ONE shared answer to "does this file belong to this key?". Every
 * `.meta.json` PARSE in the cache layer goes through `readMetaFile`/`toCacheMeta` here:
 * directly, from `cache.ts`'s `readCache`, `touchCache` and `dropFollowedPageCache`, and from
 * `cache-evict.ts`'s `resolveRecency` (in turn called by `enforceCacheSizeCap` — it has no
 * meta-parsing call of its own, since its DELETE decision deliberately does not need the
 * provenance proof `dropFollowedPageCache` does; see `enforceCacheSizeCap`'s own docstring).
 * `writeCache` participates by construction, not by calling into this module: it always writes
 * a meta whose `url` is the one just fetched, under the name `urlSlug`/`libDirName` derive from
 * that same URL. Extracted to its own module (rather than left in `cache.ts`, which
 * `cache-evict.ts` already has a reverse import relationship with via `noteCacheWrite`) so
 * neither file has to import the other for it.
 *
 * Two roots, one file:
 *   Root 1 — `urlSlug`/`libDirName` were lossy name folds used as storage keys with no
 *   collision check: two distinct URLs (or library names) differing only in a character the
 *   fold maps to `_` produced the SAME file name, and nothing on the read side compared a
 *   record's own identity against what was actually requested. Two independent fixes, both
 *   present: the folds now append a short hash of the FULL input (collision-RESISTANT, not a
 *   mathematical guarantee — see `urlSlug`'s own comment for what is and isn't load-bearing
 *   about that), and `readCache`/`touchCache` (`cache.ts`) additionally compare the meta's own
 *   `url` against the URL actually requested, which is what actually makes serving the wrong
 *   document impossible on the URL dimension regardless of hash collisions.
 *   Root 2 — `.meta.json` had four readers at four different trust levels (a strict
 *   per-field validator in `cache.ts`, a provenance round-trip in `dropFollowedPageCache`, a
 *   lax ad-hoc parse in `cache-evict.ts`'s recency read, and no check at all in
 *   `enforceCacheSizeCap`'s eviction decision). `toCacheMeta`/`readMetaFile` are now the one
 *   validator every reader calls, at the one trust level (including the `MAX_META_FILE_BYTES`
 *   size bound, enforced inside `readMetaFile` itself so every caller gets it for free).
 */

export interface CacheMeta {
  url: string;
  fetchedAt: string; // ISO
  etag?: string;
  /** PAR-776 (D-74) — the URL the content actually came from, when a redirect moved it away
   *  from `url` (the candidate URL this entry is keyed and requested by). Absent when there
   *  was no redirect, or when the writer never observed one (a cache-only path with nothing to
   *  report). `url` above stays the CANDIDATE throughout — the lookup key `readCache`/
   *  `touchCache` verify against and the identity `search-index.ts` correlates against — never
   *  overloaded to mean "wherever this ended up"; this field exists precisely so callers that
   *  need to resolve relative links or apply the host policy against the document's real
   *  origin (`get-docs.ts`) have a persisted answer on a CACHE HIT, not only on the live fetch
   *  that first observed it. UNLIKE `url`, this DOES gate something on read: `get-docs.ts` uses
   *  it as the same-origin base for `isAllowedLink`'s host-policy check (`link-policy.ts`'s
   *  same-origin rule grants a document's own host unconditionally), so a `.meta.json` this
   *  process cannot trust must never hand a caller an attacker-chosen host to trust as that
   *  origin — see `toCacheMeta`'s validation below (code-reviewer, PAR-776 round 1, B1: a value
   *  merely shaped like a URL is not enough here, unlike `url` itself, which is never used this
   *  way). A stale or missing `finalUrl` still costs a caller only its redirect-aware behaviour,
   *  never a wrong document served — that guarantee is unchanged. */
  finalUrl?: string;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** The same strict UTC-instant SHAPE `project-store.ts` and `search-index.ts` use for their
 *  own `warmedAt` / `fetchedAt` — `Date.parse` alone takes a string carrying a bidi override
 *  (e.g. U+202E), and this file's `fetchedAt` is rendered verbatim in the list_libraries
 *  footer and in every get_docs `STALE:` note.
 *
 *  NOT byte-identical to those two, and that gap is itself a finding, not a design choice:
 *  the fractional-seconds group here is bounded to 9 digits (nanosecond precision — already
 *  past anything real `toISOString` produces), because `Number.isFinite(Date.parse(…))` is
 *  not a backstop against length — MEASURED, `Date.parse("2020-01-01T00:00:00." + "1".repeat(10_000) + "Z")`
 *  returns a finite timestamp. `project-store.ts:194` and `search-index.ts:197` still carry
 *  the unbounded `(\.\d+)?` (code-reviewer, A4 round 2, S2) — `project-store.ts`'s `warmedAt`
 *  is the more exposed of the two, since it renders through `cleanText`
 *  (`project-deps.ts:119-121`), which strips control/bidi but does not clip length. Carried
 *  forward as a follow-up item, not fixed here: those two files are outside this item's
 *  authorised scope (`src/cache-meta.ts`, `src/cache.ts`, `src/cache-evict.ts` + tests).
 *
 *  Exported (A19/PAR-728, security-architect S-3a) so `doctor-store.ts`'s `checkedAt` — a new
 *  use site, not one of the two pre-existing unbounded ones above — reuses this shared shape
 *  (D-48: one definition, not a local variant per module) rather than adding a third copy of
 *  the same unbounded-length gap this comment already tracks. */
export const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/;

/** Longest `url` this file will hold — generous, not load-bearing (see `validMetaUrl`). */
const MAX_META_URL = 2048;
/** Longest `etag` — an HTTP validator token, not free text; well past anything real. */
const MAX_META_ETAG = 512;
/** Round 2 (security-architect, R3) — longest `.meta.json` file this cache will read before
 *  parsing it. A real one is a URL, an ISO instant, an optional etag and (PAR-776) an optional
 *  SECOND url (`finalUrl`); this is generous headroom over `MAX_META_URL` × 2 + `MAX_META_ETAG`
 *  plus JSON overhead, not a measured figure — bumped from the original 4096 when `finalUrl`
 *  was added, since two 2048-character URL fields plus a 512-character etag no longer fit
 *  inside the old bound even before JSON overhead (round 1 self-review, before this shipped:
 *  4096 was sized for exactly one `MAX_META_URL`, and adding a second field without revisiting
 *  it would have made every real redirected entry with a long candidate AND a long final URL
 *  silently unreadable — the same class of self-inflicted bound this file exists to avoid).
 *  Enforced inside `readMetaFile` itself (D-71 round 2, code-reviewer/security-architect B1/S1)
 *  rather than left to each caller to apply separately — every `.meta.json` reader in the
 *  cache layer gets the bound this way, not just the one (`dropFollowedPageCache`) that used
 *  to apply it by hand against a `Stats` it happened to already have. */
export const MAX_META_FILE_BYTES = 8192;
/** Deliberately a STRICT SUBSET of RFC 9110 §5.5's field-value grammar (`field-vchar = VCHAR
 *  / obs-text`, `obs-text = %x80-FF`, leading/trailing whitespace excluded) — printable ASCII
 *  only, no HTAB, no high-byte `obs-text`, no leading or trailing space (security-architect,
 *  A4 round 2: confirmed against the RFC text). Neither exclusion is exploitable — a
 *  nonconforming server's etag is dropped, costing one extra full refetch, never a wrong
 *  answer — and every etag actually seen in this codebase (`test/fetcher.test.ts:391-422`:
 *  `"abc123"`, `"v1"`, `"v2"`) is well inside it.
 *
 *  A hostile `etag` outside this set makes `fetch` throw at header construction the moment it
 *  is next sent as `If-None-Match` (`fetcher.ts:131`) — `fetchUrl`'s try/catch turns that into
 *  a `miss`, but the SAME corrupt etag is re-read from this file on every following attempt
 *  (including `vibectx refresh`'s `forceRefresh`, which still reads the cached etag first), so
 *  tolerating the throw is not tolerating its consequence: the entry pins stale forever and is
 *  misreported as "all candidate URLs unreachable" — MEASURED against a real local server
 *  (code-reviewer, A4 round 2, S1). Validating the shape here, once, is cheaper than that
 *  failure mode. `+` rather than `*`: an etag is either absent or a real token, never present
 *  as an empty string, so the length check below has no empty-string case left to catch. */
const ETAG_SHAPE = /^[\x21-\x7e]+$/;

function validMetaUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_META_URL) return false;
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

/** Shared by `toCacheMeta` (read) and `writeCache` (write) — one rule, checked on both sides
 *  of the file, so `toCacheMeta`'s claim that it "only asks whether the file is what
 *  `writeCache` would have produced" is actually true rather than aspirational (write-side
 *  asymmetry, security-architect, A4 round 2). Before this, `writeCache` stored whatever
 *  `res.headers.get("etag")` returned verbatim: never the newline case (an HTTP response
 *  header value cannot itself carry one), but a nonconforming server's high-byte `obs-text` or
 *  an oversized value would still have reached disk, bloated the size cap, and been silently
 *  dropped again on the very next read. */
export function validEtag(value: string | undefined): value is string {
  return value !== undefined && value.length <= MAX_META_ETAG && ETAG_SHAPE.test(value);
}

/**
 * Validate one persisted `.meta.json` (A4, PAR-717; shared beyond `cache.ts` since D-71,
 * PAR-749) — every other store re-validates every field on read because the cache directory
 * is a trust boundary (`resolved-store.ts`, `project-store.ts`, `search-index.ts`); this was
 * the one that did not. ANY failure drops the whole record, so a reader reports the entry
 * uncached exactly as a missing file would, rather than trusting a meta this process cannot
 * verify:
 *
 *   url        a parseable URL string, ≤ 2048 characters. Not held to the fetch-time host
 *              policy (`sanitizeRemoteUrl`'s forbidden-host check) — an entry cached under
 *              `allowInternalHosts: true` (D-47) legitimately has an internal-host URL here,
 *              and that trust decision was already made when the document was written; this
 *              function only asks whether the file is what `writeCache` would have produced.
 *   fetchedAt  a strict ISO-8601 UTC instant — the one field this file renders verbatim
 *   etag       ≤ 512 characters and HTTP field-value characters only (see `ETAG_SHAPE`) when
 *              present. Dropped alone, not the whole record: it is a revalidation hint (sent
 *              back as `If-None-Match`), not part of the entry's identity — but a shape check
 *              is not optional here (see `ETAG_SHAPE`'s comment for the stale-forever failure
 *              mode a merely-length-bounded etag still allows).
 *   finalUrl   (PAR-776) STRICTER than `url` above, deliberately: `sanitizeRemoteUrl`
 *              (`link-policy.ts`) — https only, no userinfo, ≤ 2048 characters, and the host
 *              must clear `isForbiddenHost` — rather than the merely-parseable `validMetaUrl`
 *              bound `url` gets. Not a stricter check for its own sake: `get-docs.ts` uses
 *              `finalUrl` as the same-origin base for `isAllowedLink`'s host-policy check, which
 *              grants a document's own host unconditionally (`link-policy.ts`), so accepting a
 *              value merely shaped like a URL here would let a hand-edited or corrupted
 *              `.meta.json` hand a caller an attacker-chosen "trusted" origin — a live fetch's
 *              redirect can never legitimately produce a `finalUrl` this check would reject
 *              (`fetcher.ts`'s `hopAllowed` enforces exactly this same rule, unconditionally, on
 *              every redirect hop and the final URL, even for an `allowInternalHosts` candidate —
 *              see D-74 in `.vibectx-plan/DECISIONS.md`). Dropped alone, not the whole record,
 *              for the same reason `etag` is: it is provenance about where the fetch landed, not
 *              part of this entry's identity (`url`, the CANDIDATE, is what `readCache`/
 *              `touchCache` verify against) — a missing or rejected `finalUrl` costs a caller
 *              its redirect-aware relative-link/host-policy behaviour for this one read, never a
 *              wrong document served (code-reviewer, PAR-776 round 1, B1).
 */
export function toCacheMeta(raw: unknown): CacheMeta | undefined {
  if (!isRecord(raw)) return undefined;
  if (!validMetaUrl(raw.url)) return undefined;
  if (typeof raw.fetchedAt !== "string" || !ISO_INSTANT.test(raw.fetchedAt) || !Number.isFinite(Date.parse(raw.fetchedAt))) {
    return undefined;
  }
  const meta: CacheMeta = { url: raw.url, fetchedAt: raw.fetchedAt };
  if (typeof raw.etag === "string" && validEtag(raw.etag)) meta.etag = raw.etag;
  if (typeof raw.finalUrl === "string") {
    const clean = sanitizeRemoteUrl(raw.finalUrl);
    if (clean !== undefined) meta.finalUrl = clean;
  }
  return meta;
}

/** Parse and validate one `.meta.json`; `undefined` for anything unreadable, truncated,
 *  invalid JSON, wrong-shaped, or carrying a hostile `fetchedAt` (A4's four corruption
 *  classes) — never throws. The one function every `.meta.json` reader in `cache.ts` and
 *  `cache-evict.ts` calls (D-71) — there is no longer a second, laxer parse anywhere.
 *
 *  Bounded at `MAX_META_FILE_BYTES` (code-reviewer, D-71 round 1) — the size check used to be
 *  paid only by `dropFollowedPageCache`, which reused an `lstat` it already needed; every
 *  OTHER reader (`readCache`, `touchCache`, and `cache-evict.ts`'s `resolveRecency`) went
 *  through this same function with no bound at all, so a planted multi-megabyte `.meta.json`
 *  was fully read and `JSON.parse`d by all three before this. `lstatSync`, not `statSync` or
 *  `existsSync`, for the same reason every other check in this cache does: the question is
 *  what the directory ENTRY is, never what a symlink at that name points at. */
export function readMetaFile(metaPath: string): CacheMeta | undefined {
  let parsed: unknown;
  try {
    const stat = lstatSync(metaPath);
    if (!stat.isFile() || stat.size > MAX_META_FILE_BYTES) return undefined;
    parsed = JSON.parse(readFileSync(metaPath, "utf8"));
  } catch {
    return undefined;
  }
  return toCacheMeta(parsed);
}

/** Short, deterministic fingerprint of the raw input — 12 hex characters, 48 bits of a SHA-256
 *  digest. NOT a mathematical injectivity guarantee (security-architect, D-71 round 2, S2) —
 *  a 48-bit digest can theoretically collide, and a DELIBERATE second-preimage against a
 *  specific input is within reach of an attacker who controls the input (feasible on
 *  commodity hardware, though not cheap). What it buys is COLLISION RESISTANCE for the
 *  ordinary case this cache actually faces: at the scale of a single user's local cache
 *  (thousands, not billions, of entries) an ACCIDENTAL collision between two unrelated inputs
 *  is astronomically unlikely (~10⁻⁷ at 10,000 entries, by the birthday bound). On the URL
 *  dimension that is deliberately not the only defense — see `urlSlug`'s own comment for the
 *  read-side check that actually closes the gap a forced collision would otherwise leave. */
function shortHash(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex").slice(0, 12);
}

/**
 * D-71 (PAR-749, Root 1) — a cache storage key derived from a URL. Before this, every
 * non-alphanumeric character folded to `_` with NO collision check at all, so `https://x.dev/a-b`
 * and `https://x.dev/a_b` produced the identical slug `https___x_dev_a_b` deterministically,
 * every time. Appending `shortHash`'s digest of the FULL, untruncated input makes an
 * ACCIDENTAL collision between two unrelated URLs collision-resistant rather than certain for
 * any pair sharing a fold (including two URLs sharing a 120-character common prefix before the
 * fold, the truncation-collision case the fold-only version also had) — see `shortHash`'s own
 * comment for exactly what that resistance does and does not guarantee.
 *
 * The load-bearing guarantee on THIS dimension is not the hash alone: `readCache` and
 * `touchCache` (`cache.ts`) additionally compare the meta's own `url` field against the URL
 * actually requested, and treat a mismatch as a miss. Even in the near-impossible event of a
 * forced slug collision, the result is a cache miss and a re-fetch — never the wrong document
 * served under the wrong identity. The folded prefix (still capped at 120 characters) stays
 * for a human glancing at the cache directory; it carries none of the uniqueness guarantee.
 */
export function urlSlug(url: string): string {
  return `${url.replace(/[^a-z0-9]/gi, "_").slice(0, 120)}_${shortHash(url)}`;
}

/**
 * D-71 (PAR-749, Root 1) — the library-directory half of the same fix. `libDirIn`'s fold
 * (`[^a-z0-9_-]` → `_`) let two distinct, independently valid npm names — `foo.bar` and
 * `foo_bar` — share one directory; refreshing one could delete the other's cached primary (see
 * `dropFollowedPageCache`'s history). Collision-resistant for the same reason `urlSlug` is
 * (see `shortHash`'s comment) — but UNLIKE the URL dimension, there is no second, independent
 * check on this one: a library name is not itself stored in `.meta.json`, so a forced
 * directory-name collision has no `readCache`-style equality check to fall back on. Accepted:
 * the attacker's input space here (a package/library name reaching a user's own dependency
 * list or `vibectx.config.json`) is far narrower than an arbitrary URL, and the worst case is
 * loss of re-fetchable cache (availability), never wrong content served as right. Capped at
 * 120 characters before the hash, matching `urlSlug`, so an unbounded library name (nothing
 * enforces a maximum length on one — security-architect, D-71 round 2, S4) cannot push the
 * directory name toward a filesystem `NAME_MAX`; the hash is still of the FULL, uncapped name,
 * so truncating the visible prefix costs nothing on the collision-resistance side.
 */
export function libDirName(library: string): string {
  return `${library.replace(/[^a-z0-9_-]/gi, "_").slice(0, 120)}_${shortHash(library)}`;
}

/**
 * D-71 (PAR-749, Root 1) — the read-side half: does this `.meta.json`'s OWN `url` actually
 * map, via `urlSlug`, to the slug its file name carries? `urlSlug` is a pure function of the
 * URL alone, so a slug `writeCache` produced from a URL always round-trips; a mismatch means
 * this file was not written for the URL it claims to describe (or, before this item, a
 * genuine fold collision) — either way, not proof this is the record being asked for.
 *
 * `dropFollowedPageCache` uses this spelling of the rule because it has no request URL to
 * compare against — only a filename it is deciding whether to delete, and the URL a candidate
 * SHOULD have (via the slug it is named for) is all there is to check it against.
 * `readCache`/`touchCache` (`cache.ts`) spell the SAME rule as a direct `meta.url !== url`
 * instead, because they DO have the actual requested URL in hand — a strictly stronger check
 * than round-tripping through `urlSlug`, since it does not depend on `urlSlug` staying
 * collision-resistant to be correct. Both are the same rule, "does this record match what was
 * asked for", checked the strongest way each caller's inputs allow.
 */
export function metaMatchesSlug(meta: CacheMeta, slug: string): boolean {
  return urlSlug(meta.url) === slug;
}
