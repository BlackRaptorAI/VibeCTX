import { lstatSync, mkdirSync, readdirSync, readFileSync, existsSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { tempPathFor, writeAtomic } from "./atomic-store.js";
// Carried forward, not fixed here (F5, security-architect A4 round 2) — outside A4's
// authorised scope (`src/cache.ts` + tests): `cache-evict.ts`'s `resolveRecency` reads the
// same `.meta.json` files with a laxer check than `toCacheMeta` below (`typeof === "string"`
// plus `Number.isFinite`, no shape or length bound), and its comments at `cache-evict.ts:23`
// and `:272` still assert the N-6 behaviour A4 superseded ("an unparsable fetchedAt reads as
// stale") — now false for `readCache`. LATENT, not live: `EvictedDocument.fetchedAt`
// (`cache-evict.ts:396`) is populated but rendered nowhere today (`doctor.ts:317-320` prints
// only `library`/`document`); it becomes live the moment a future change renders it.
import { noteCacheWrite } from "./cache-evict.js";

export interface CacheMeta {
  url: string;
  fetchedAt: string; // ISO
  etag?: string;
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
 *  forward as a follow-up item, not fixed here: those two files are outside A4's authorised
 *  scope (`src/cache.ts` + tests). */
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/;

/** Longest `url` this file will hold — generous, not load-bearing (see `validMetaUrl`). */
const MAX_META_URL = 2048;
/** Longest `etag` — an HTTP validator token, not free text; well past anything real. */
const MAX_META_ETAG = 512;
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
function validEtag(value: string | undefined): value is string {
  return value !== undefined && value.length <= MAX_META_ETAG && ETAG_SHAPE.test(value);
}

/**
 * Validate one persisted `.meta.json` (A4, PAR-717) — every other store re-validates every
 * field on read because the cache directory is a trust boundary (`resolved-store.ts`,
 * `project-store.ts`, `search-index.ts`); this was the one that did not. ANY failure drops
 * the whole record, so `readCache` reports the entry uncached exactly as a missing file
 * would, rather than serving a document under a meta this process cannot trust:
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
 */
export function toCacheMeta(raw: unknown): CacheMeta | undefined {
  if (!isRecord(raw)) return undefined;
  if (!validMetaUrl(raw.url)) return undefined;
  if (typeof raw.fetchedAt !== "string" || !ISO_INSTANT.test(raw.fetchedAt) || !Number.isFinite(Date.parse(raw.fetchedAt))) {
    return undefined;
  }
  const meta: CacheMeta = { url: raw.url, fetchedAt: raw.fetchedAt };
  if (typeof raw.etag === "string" && validEtag(raw.etag)) meta.etag = raw.etag;
  return meta;
}

/** Parse and validate one `.meta.json`; `undefined` for anything unreadable, truncated,
 *  invalid JSON, wrong-shaped, or carrying a hostile `fetchedAt` (A4's four corruption
 *  classes) — never throws. */
function readCacheMeta(metaPath: string): CacheMeta | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(metaPath, "utf8"));
  } catch {
    return undefined;
  }
  return toCacheMeta(parsed);
}

export interface CacheHit {
  content: string;
  meta: CacheMeta;
  /** True when past TTL — caller decides whether to refetch or serve stale. */
  stale: boolean;
}

/** The cache directory under the user's home. */
export const CACHE_DIR_NAME = ".vibectx";
/** What it was called when the package was `docs-cache-mcp`. Migrated once, see below. */
export const LEGACY_CACHE_DIR_NAME = ".docs-cache-mcp";

export interface CacheRootOptions {
  /** Where the one-off notes go. Defaults to stderr — this is a stdio MCP server, so
   *  stdout belongs to the protocol and nothing else may be written to it. */
  warn?: (message: string) => void;
}

const toStderr = (message: string): void => {
  process.stderr.write(`${message}\n`);
};

/** Once-per-process state: the deprecation note and the migration are each said and done
 *  once, however many times `cacheRoot()` is called (it is called on nearly every path). */
let deprecationNoted = false;
let resolvedDefaultRoot: string | undefined;

/** Test seam: forget what this process has already noted and migrated. */
export function resetCacheRootState(): void {
  deprecationNoted = false;
  resolvedDefaultRoot = undefined;
}

/** Empty is not a directory: an exported-but-empty variable reads as unset rather than as
 *  "cache into the current working directory". */
const configured = (value: string | undefined): string | undefined =>
  value !== undefined && value.length > 0 ? value : undefined;

/** A real directory this tool would be willing to treat as a cache (D-46: lstat, not stat). */
function isRealDirectory(path: string): boolean {
  try {
    return lstatSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Rule 1 keeps an existing `~/.vibectx` and moves nothing — correct, and it used to be
 * SILENT. An EMPTY `~/.vibectx` (a `mkdir`, a dotfile manager, a half-finished earlier run)
 * took that same path, so a full legacy cache sat stranded beside it while the tool
 * re-downloaded every document the user already had, with no way to find out why.
 *
 * One note, and no move: the rule does not change — deciding for the user which of two caches
 * wins is exactly the judgement rule 1 refuses to make — they are just told where the other
 * one is. Best effort throughout; an unreadable directory means nothing is said.
 */
function noteStrandedLegacy(current: string, legacy: string, warn: (message: string) => void): void {
  if (!isRealDirectory(legacy)) return; // only a real directory is a cache worth mentioning
  let currentIsEmpty: boolean;
  try {
    currentIsEmpty = readdirSync(current).length === 0;
  } catch {
    return;
  }
  if (!currentIsEmpty) return; // this user has a cache at the new path and has moved on
  warn(
    `vibectx: ${current} is empty, so the cache at ${legacy} (the old package name) is not being used ` +
      `and nothing was moved. Delete ${current} to have it migrated on the next run, or delete ${legacy} ` +
      `if you no longer want it.`,
  );
}

/**
 * The default root, with the one-time rebrand migration (D-45, PAR-652).
 *
 * The rules, in the order they are checked, because each exists to prevent a specific way
 * of losing someone's cache:
 *   1. `~/.vibectx` already exists → use it and touch nothing. A user who has both
 *      directories has already moved on; overwriting the new one with the old would lose
 *      the newer cache, which is the worst outcome available here. If it is EMPTY and a
 *      legacy cache is sitting beside it, say so once (`noteStrandedLegacy`) — the rule is
 *      unchanged, but it is no longer silent about what it left behind.
 *   2. No `~/.docs-cache-mcp` → use `~/.vibectx`. Nothing to migrate.
 *   3. `~/.docs-cache-mcp` is not a REAL DIRECTORY (D-46, PAR-652b) → rename nothing, say so
 *      once, and degrade exactly as rule 4 does. `existsSync` follows symlinks, so without
 *      this check a link planted at the legacy path passed rule 2 and rule 3 renamed THE LINK
 *      — `renameSync` moves the link itself, so `~/.vibectx` became a symlink aiming wherever
 *      the link aimed, and every cached document and every eviction from then on landed in
 *      whatever directory that was. Measured by the security gate. The link is never followed
 *      into a rename and never removed.
 *      RESIDUAL, stated because it is real: writes during that one run still resolve through
 *      the link. What this closes is the PERMANENT capture (`~/.vibectx` is not made a link)
 *      and deletion — `enforceCacheSizeCap` refuses a root that is not a real directory, so
 *      nothing is evicted through it either.
 *   4. Otherwise rename `~/.docs-cache-mcp` to `~/.vibectx` — a rename, never a copy: a
 *      copy can half-succeed and leave two divergent caches, and a rename either happens
 *      or does not.
 *   5. The rename failed (cross-device, permissions, a race with another process) → keep
 *      using the OLD path for this run and say so once. Degrading is right: the cache is
 *      a cache, but silently starting from an empty one would re-download every document
 *      the user already has.
 */
function defaultCacheRoot(warn: (message: string) => void): string {
  if (resolvedDefaultRoot !== undefined) return resolvedDefaultRoot;
  const home = homedir();
  const current = join(home, CACHE_DIR_NAME);
  const legacy = join(home, LEGACY_CACHE_DIR_NAME);
  resolvedDefaultRoot = current;
  if (existsSync(current)) {
    noteStrandedLegacy(current, legacy, warn);
    return current;
  }
  if (!existsSync(legacy)) return current;
  // D-46: prove the legacy path before renaming it. lstat, not stat — the question is what
  // the ENTRY is, not what it points at. A throw here means it vanished between the two
  // calls, which is rule 2 arriving late: there is nothing to migrate.
  let legacyStats;
  try {
    legacyStats = lstatSync(legacy);
  } catch {
    return current;
  }
  if (!legacyStats.isDirectory()) {
    resolvedDefaultRoot = legacy;
    warn(
      `vibectx: not moving ${legacy} → ${current} — ${legacy} is ` +
        `${legacyStats.isSymbolicLink() ? "a symlink" : "not a directory"}, and only a real directory is moved. ` +
        `Using ${legacy} for this run; nothing was renamed, copied or deleted. ` +
        `Remove it, or set VIBECTX_CACHE_DIR to a real directory.`,
    );
    return resolvedDefaultRoot;
  }
  try {
    renameSync(legacy, current);
    warn(`vibectx: moved the cache directory ${legacy} → ${current} (renamed once; nothing was copied or deleted).`);
  } catch (e) {
    resolvedDefaultRoot = legacy;
    warn(
      `vibectx: could not move the cache directory ${legacy} → ${current} (${e instanceof Error ? e.message : String(e)}); ` +
        `using ${legacy} for this run. Nothing was copied and no cached document was lost.`,
    );
  }
  return resolvedDefaultRoot;
}

/**
 * Where the cache lives: `VIBECTX_CACHE_DIR`, else `DOCS_CACHE_DIR` (deprecated, one note
 * per process), else `~/.vibectx` with the one-time migration above.
 *
 * D-45: the new name wins outright. `DOCS_CACHE_DIR` keeps working through 0.2.x so a
 * shell profile or an MCP client config written against 0.1.x does not silently start
 * caching somewhere else — which would look exactly like a cache that lost everything.
 */
export function cacheRoot(opts: CacheRootOptions = {}): string {
  const warn = opts.warn ?? toStderr;
  const preferred = configured(process.env.VIBECTX_CACHE_DIR);
  if (preferred !== undefined) return preferred;
  const legacyEnv = configured(process.env.DOCS_CACHE_DIR);
  if (legacyEnv !== undefined) {
    if (!deprecationNoted) {
      deprecationNoted = true;
      warn(
        "vibectx: DOCS_CACHE_DIR is deprecated and will stop being read after 0.2.x — " +
          `set VIBECTX_CACHE_DIR instead. Using ${legacyEnv} for this run.`,
      );
    }
    return legacyEnv;
  }
  return defaultCacheRoot(warn);
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
  // Kept even though both branches below also guard their own read (N1, code-reviewer):
  // without this pair, an ordinary miss (no file at all — the overwhelming common case)
  // would fall through into the same try/catch as real corruption, which is still correct
  // but loses the distinction a future diagnostic would want to draw between "nothing here"
  // and "something here this process cannot trust".
  if (!existsSync(contentPath) || !existsSync(metaPath)) return undefined;
  const meta = readCacheMeta(metaPath);
  // A4 supersedes N-6: a bad `fetchedAt` used to read as stale-but-served (ageMs went NaN,
  // and `!(NaN < x)` is true). It now drops the whole meta, so the entry reads as uncached —
  // Gate 3's rule for all four corruption classes, not just this one field.
  if (!meta) return undefined;
  let content: string;
  try {
    content = readFileSync(contentPath, "utf8");
  } catch {
    // Same trust boundary as the meta half, same rule (security-architect, A4 round 1, F1):
    // `existsSync` above returns true for a directory, and a TOCTOU unlink between that check
    // and this read is possible either way. An unreadable content file reads as uncached, not
    // a throw — `configuredEntriesNeedingWarm`'s pre-scan (autowarm.ts) and list_libraries
    // both call this function directly, with no try/catch of their own to fall back on.
    return undefined;
  }
  const ageMs = Date.now() - new Date(meta.fetchedAt).getTime();
  // Negated `<` rather than `>=`: a TTL of 0 means "expire immediately", even when written
  // and read within the same millisecond. `meta.fetchedAt` is now guaranteed a valid ISO
  // instant by `toCacheMeta`, so `ageMs` is never NaN here.
  return {
    content,
    meta,
    stale: !(ageMs < ttlHours * 3600_000),
  };
}

/** Refresh a cache entry's TTL clock without rewriting content — used after a
 *  304 Not Modified revalidation confirms the upstream is unchanged.
 *
 *  Round-trips through `toCacheMeta` (N4, code-reviewer): the rewritten file carries only
 *  the validated, reconstructed fields, so a valid-but-over-length or valid-but-wrong-shape
 *  `etag` that somehow reached disk is silently dropped here rather than merely ignored for
 *  one read. Benign — the field is a revalidation hint, not identity — and consistent with
 *  every write in this file already going through a validator before it lands. */
export function touchCache(library: string, url: string): void {
  const dir = libDir(library);
  const metaPath = join(dir, `${urlSlug(url)}.meta.json`);
  if (!existsSync(metaPath)) return;
  const meta = readCacheMeta(metaPath);
  // Best effort (D-13): a meta this process cannot trust has nothing to refresh. The next
  // `readCache` reports the entry uncached and the next fetch writes a fresh, valid meta.
  if (!meta) return;
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
  // validEtag, not a bare passthrough (write-side asymmetry, security-architect A4 round 2):
  // `etag` here is `res.headers.get("etag")`, already normalised by the Fetch spec so it can
  // never carry a newline — but a nonconforming server's high-byte obs-text or an oversized
  // value would otherwise land on disk unfiltered, cost space against the size cap, and be
  // silently dropped again on the very next read anyway.
  const meta: CacheMeta = { url, fetchedAt: new Date().toISOString() };
  if (validEtag(etag)) meta.etag = etag;
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
  // Only after BOTH renames land: this document now exists and counts toward the cap, and it
  // is protected from eviction for the rest of this run (PAR-652 item 7a). Sweeping is
  // amortised inside noteCacheWrite, which never throws — an unsweepable cache must not fail
  // a write that already succeeded.
  noteCacheWrite(cacheRoot(), contentPath, Buffer.byteLength(content, "utf8"));
}
