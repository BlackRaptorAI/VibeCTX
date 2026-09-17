import { lstatSync, mkdirSync, readdirSync, readFileSync, existsSync, renameSync, rmSync, writeFileSync, type Stats } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { tempPathFor, writeAtomic } from "./atomic-store.js";
import { MAX_CONFIG_VALUE_CHARS, MAX_DISPLAY_PATH_CHARS } from "./config.js";
import { clipText } from "./text.js";
import { noteCacheWrite } from "./cache-evict.js";
import {
  type CacheMeta,
  toCacheMeta,
  readMetaFile,
  urlSlug,
  libDirName,
  metaMatchesSlug,
  validEtag,
  MAX_META_FILE_BYTES,
} from "./cache-meta.js";

// D-71 (PAR-749) moved the shared validator, the collision-resistant `urlSlug`/`libDirName`
// transforms and the meta/slug provenance check into `./cache-meta.ts` — the one module both this file
// and `cache-evict.ts` import it from, so neither has to import the other for it. Re-exported
// here for existing callers (`toCacheMeta`, `CacheMeta`, `urlSlug` are part of this module's
// public surface and other files/tests import them from `cache.js`).
export type { CacheMeta };
export { toCacheMeta, urlSlug, libDirName };

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
 *      and deletion — both `enforceCacheSizeCap` (cache-evict.ts) and `dropFollowedPageCache`
 *      (A3, PAR-716) refuse a root that is not a real directory, so nothing is evicted or
 *      dropped through it either.
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

/** Round 2 (security-architect, C1) — the library directory for a ROOT the caller already
 *  has in hand, so a caller that must prove the root is real (D-46) checks and uses the SAME
 *  value rather than one `cacheRoot()` call proving a root a second, later call re-resolves.
 *  `cacheRoot()` is memoised (`resolvedDefaultRoot`) so the two calls agree in practice, but
 *  that agreement is an invariant of `cacheRoot()`'s implementation, not a property this
 *  function's callers should have to depend on.
 *
 *  D-71 (PAR-749): the directory name itself is `libDirName(library)` — folded AND hash-
 *  suffixed, so two library names that fold to the same characters (`foo.bar` / `foo_bar`) no
 *  longer share a directory. */
function libDirIn(root: string, library: string): string {
  // One directory per library; page files keyed by a slug of their URL.
  return join(root, libDirName(library));
}

function libDir(library: string): string {
  return libDirIn(cacheRoot(), library);
}

export function readCache(
  library: string,
  url: string,
  ttlHours: number,
): CacheHit | undefined {
  const dir = libDir(library);
  const slug = urlSlug(url);
  const contentPath = join(dir, `${slug}.md`);
  const metaPath = join(dir, `${slug}.meta.json`);
  // Kept even though both branches below also guard their own read (N1, code-reviewer):
  // without this pair, an ordinary miss (no file at all — the overwhelming common case)
  // would fall through into the same try/catch as real corruption, which is still correct
  // but loses the distinction a future diagnostic would want to draw between "nothing here"
  // and "something here this process cannot trust".
  if (!existsSync(contentPath) || !existsSync(metaPath)) return undefined;
  const meta = readMetaFile(metaPath);
  // A4 supersedes N-6: a bad `fetchedAt` used to read as stale-but-served (ageMs went NaN,
  // and `!(NaN < x)` is true). It now drops the whole meta, so the entry reads as uncached —
  // Gate 3's rule for all four corruption classes, not just this one field.
  if (!meta) return undefined;
  // D-71 (PAR-749, Root 1) — the read-side verification `readCache` never did: a folded slug
  // is a lookup key, not proof of identity, and before this a collision (or a foreign file
  // planted under a name-shaped slug) served ONE document's content under ANOTHER's name,
  // silently, with a meta that passed every A4 check. `urlSlug` is now collision-RESISTANT
  // (D-71 — see its own comment for what that does and doesn't guarantee), which already makes
  // an accidental fold collision astronomically unlikely; THIS check is what actually makes
  // serving the wrong document impossible regardless: a meta whose own `url` does not match
  // the URL actually requested is not this entry, whatever its file name says.
  if (meta.url !== url) return undefined;
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
/** Returns the `fetchedAt` it wrote, or `undefined` on any of the best-effort no-op paths
 *  (A17/PAR-726: callers that need to report exactly when a revalidated document was fetched
 *  read it from here rather than calling `new Date()` a second time, which could disagree
 *  with what actually landed on disk by the width of that second call). */
export function touchCache(library: string, url: string): string | undefined {
  const dir = libDir(library);
  const metaPath = join(dir, `${urlSlug(url)}.meta.json`);
  if (!existsSync(metaPath)) return undefined;
  const meta = readMetaFile(metaPath);
  // Best effort (D-13): a meta this process cannot trust has nothing to refresh. The next
  // `readCache` reports the entry uncached and the next fetch writes a fresh, valid meta.
  if (!meta) return undefined;
  // D-71 (PAR-749, Root 1) — same verification as `readCache`: a meta whose own `url` does
  // not match the URL this call was asked to refresh is not this entry, whatever the file
  // name says. Refreshing it anyway would extend the TTL of a mismatched record.
  if (meta.url !== url) return undefined;
  meta.fetchedAt = new Date().toISOString();
  writeAtomic(metaPath, JSON.stringify(meta, null, 2));
  return meta.fetchedAt;
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
/** Returns the `fetchedAt` it wrote (A17/PAR-726 — see `touchCache`'s doc comment; the same
 *  reasoning applies here: report the timestamp actually persisted, not a freshly-taken one). */
export function writeCache(
  library: string,
  url: string,
  content: string,
  etag?: string,
): string {
  const dir = libDir(library);
  mkdirSync(dir, { recursive: true });
  const slug = urlSlug(url);
  const contentPath = join(dir, `${slug}.md`);
  const metaPath = join(dir, `${slug}.meta.json`);
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
  return meta.fetchedAt;
}

/**
 * A3 (PAR-716) — a successful refresh of a library's primary document drops every OTHER
 * cached page for that library: the pages `get_docs` followed from the OLD primary's link
 * structure. Those pages are keyed by their own URL (`fetchLinkedPage` → `writeCache`) in the
 * same per-library directory `writeCache` uses for the primary document, so a refresh that
 * replaces the primary leaves them sitting there, attributed to link text and a heading path
 * that may no longer exist. Nothing re-validates them until their own TTL expires, so the
 * next `get_docs` on that library can silently blend fresh primary content with a followed
 * page fetched under the document this refresh just replaced.
 *
 * Scope: only pages, keyed by URL, other than one of `keepUrls` — the primary document just
 * written, PLUS every other candidate URL still on the entry (round 1, code-reviewer, S2):
 * `entry.urls[1..n]` are `getLibraryDoc`'s own fallback chain (its "network failed everywhere"
 * loop, `fetcher.ts`), not followed pages, and deleting them turned a future primary-candidate
 * outage into a hard FAILED where the stale fallback used to serve a flagged document. Callers
 * pass the full candidate list, not just the one URL that was just fetched.
 *
 * Called only after a refetch that actually changed something (both `refresh.ts` call sites):
 * the direct-fetch path guards on `fetcher.ts`'s `isDocUnchanged(doc)`, and the
 * resolved-entry re-resolution path guards on `!out.unchanged` (`resolve.ts`'s
 * `ResolveOutcome.unchanged`, itself derived from the same two `DocResult` fields). Before
 * PAR-744 (F-7), NEITHER guard could tell a byte-identical 304 revalidation apart from a
 * genuine fresh fetch — `doc.staleNote` only ever distinguished a failed-network stale-cache
 * fallback, and the resolved-entry path had no staleness signal at all — so an unchanged
 * primary dropped its followed pages on every revalidated refresh. Fixed by adding
 * `DocResult.notModified` (`fetcher.ts`) and threading it through both call sites. ETag-only
 * (round 2, code-reviewer, S3): `fetchUrl` sends `if-none-match` and nothing else, so this only
 * helps a docs site that actually serves an `etag` — a site with no validator at all still
 * drops its followed pages on every scheduled refresh, exactly as before this item.
 *
 * THE COST WAS REAL, NOT ONLY A WASTED RE-FETCH (round 2, code-reviewer, SF-1, on the
 * now-fixed ETag-revalidation case — the earlier wording here claimed the dropped pages are
 * "simply re-fetched next time, never served wrong"; MEASURED false for the offline path and
 * corrected). A page dropped on an unchanged refresh, that used to be served flagged `STALE:`
 * during an upstream outage or under `offline`, reported "Could not fetch N index links"
 * instead — `fetchLinkedPage`'s offline/unavailable branch (its `offline && !hit` case,
 * `fetcher.ts`) had nothing to fall back to once the cached copy was gone. Never a correctness
 * bug (nothing was ever served WRONG), but a real cost against this project's offline-first
 * convention, and it landed on the common ETag-revalidated case above — which is why this was
 * worth fixing rather than merely disclosing.
 *
 * RESIDUAL, disclosed rather than fixed here (round 2, code-reviewer, S6; filed PAR-788):
 * `notModified`/`staleNote` mean "this URL's bytes are unchanged", not "the library's PRIMARY
 * document is unchanged" — `getLibraryDoc` probes `entry.urls` in order and returns the first
 * candidate that succeeds, so if candidate A (long cached, still carrying a valid etag) was
 * failing and candidate B became the primary `get_docs` actually served and followed links
 * from, then A later recovers and revalidates via 304, `doc.url` is A, `notModified` is true,
 * and this function is skipped — leaving B's followed pages attributed to a primary that is no
 * longer A's (or B's) current one. Narrow, and not new IN KIND: the pre-existing `staleNote`
 * fallback has the identical exposure (it also takes the first cached candidate, never
 * specifically the previously-chosen one) — this item adds a second door to the same room, not
 * a new room. No cheap fix: `refresh.ts` does not know which URL was previously primary, and
 * followed pages are not keyed by which primary they were followed from.
 *
 * Best effort (D-13): an unreadable directory or an unremovable file costs a page that
 * outlives its purpose, never a throw — refresh's own result is not this function's to fail.
 *
 * D-46, in full (round 1, code-reviewer, B1; round 2, security-architect, C1): the ROOT is
 * proven a real directory before anything below it is touched, not just the library directory
 * — `cacheRoot()` itself does not make that guarantee (`lstat` on `<symlinked-root>/<library>`
 * answers `isDirectory() true` because it stats the target) — and the checked root is captured
 * once into `root` and threaded through `libDirIn`, so the value proven real is provably the
 * value used, not a second, later `cacheRoot()` call this function has to trust agrees with
 * the first. RESIDUAL, stated rather than silently accepted: an external process could still
 * replace the root or this library's directory with a symlink between the `isRealDirectory`
 * checks and the `readdirSync`/`rmSync` calls below (CWE-367) — the same residual
 * `enforceCacheSizeCap` (cache-evict.ts) carries and does not document either. Bounded two
 * ways: this function's body is entirely synchronous (no `await` inside it for such a race to
 * land in), and `rmSync` on a plain path issues `unlink(2)` on the final path component, which
 * POSIX never resolves through a symlink — so even a same-instant swap of a FILE for a symlink
 * removes the link, not whatever it points at. Round 3 (security-architect, N3): C2 below
 * widens this same window by one `readFileSync` + `JSON.parse` per candidate — the residual's
 * KIND is unchanged (still only the non-final path components are swappable, still fully
 * synchronous), but its DURATION is longer than round 1's version.
 *
 * Below the root, symlinked or non-regular entries are left alone, never followed or removed.
 * A candidate must be a REAL file whose name is one of this library's own `<slug>.md` /
 * `<slug>.meta.json` pairs, its slug not one of `keepUrls`', AND (round 2, security-architect,
 * C2) its `.meta.json` half must exist, be no larger than `MAX_META_FILE_BYTES` (R3 — the same
 * `Stats` the existence check already paid for), pass the SAME validation `readCache` requires
 * (`readMetaFile`/`toCacheMeta`, A4's four corruption classes), AND (round 4, code-reviewer,
 * SF-C — closing security-architect's N1 in full, not just its empty-slug instance) have a
 * `url` field that `urlSlug` maps back to the SAME slug the filename carries — the actual
 * proof that this is the file `writeCache` produced for that URL, not merely A file that
 * happens to sit under a name shaped like one. A lone `.md`, a lone `.meta.json`, an oversized
 * one, one this process cannot trust, or one whose meta names a different URL entirely is left
 * in place for eviction, rather than unlinked on name shape alone (the temp sweep does NOT
 * apply here: `TEMP_FILE_PATTERN` matches neither suffix). This bounds a `VIBECTX_CACHE_DIR`
 * aimed at a real directory this tool does not otherwise own: only files this tool itself
 * wrote — proven, not merely name-shaped — are deleted. `library` itself is also refused when
 * empty, above: `libDirName("")` is no longer able to collapse the scan to `root` (D-71 gave
 * it a non-empty hash suffix regardless of input), but the guard is kept as the documented
 * contract rather than an implementation accident.
 *
 * COLLISION-RESISTANT since D-71 (PAR-749) — previously the finding recorded here, now fixed
 * rather than merely disclosed: `libDirIn`'s `library → directory` mapping used to fold
 * distinct valid names that differ only in a character its regex maps to `_` (e.g. an npm name
 * `foo.bar` and `foo_bar`) onto the SAME directory, EVERY time, so refreshing one could delete
 * the other's cached primary — the SF-C proof above could not catch it, because the deleted
 * pair genuinely WAS one this tool wrote, just for the other library sharing the folded name.
 * `libDirName` now appends a hash of the full library name to the fold, so two distinct names
 * sharing a fold no longer collide in the ordinary case (see `shortHash`'s comment in
 * `cache-meta.ts` for the precise, non-absolute guarantee — a deliberately forced collision on
 * this dimension has no second check to fall back on, unlike the URL dimension's `meta.url`
 * comparison; see `libDirName`'s own comment) — see `test/cache.test.ts`'s "no longer collide"
 * case, which replaced the old characterization test of this same finding.
 */
export function dropFollowedPageCache(
  library: string,
  keepUrls: readonly string[],
  warn: (message: string) => void = toStderr,
): void {
  // Round 3 (security-architect, N1): an empty `library` collapses `libDirIn(root, "")` to
  // `root` itself (`path.join` drops a zero-length segment) — unreachable from this item's own
  // callers (`refresh.ts` always passes a Registry-resolved, non-empty `entry.name`), but this
  // function is exported and guards neither end of its own contract otherwise. Refused here.
  if (library.length === 0) return;
  const root = cacheRoot();
  if (!isRealDirectory(root)) return; // D-46 / C1: prove the ROOT — and use THIS value, not a second cacheRoot() call — before anything below can delete through it
  const dir = libDirIn(root, library);
  if (!isRealDirectory(dir)) return; // nothing cached for this library, or not ours to touch
  const keep = new Set(keepUrls.map(urlSlug));
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  const slugs = new Set<string>();
  for (const name of names) {
    if (name.endsWith(".md")) slugs.add(name.slice(0, -".md".length));
    else if (name.endsWith(".meta.json")) slugs.add(name.slice(0, -".meta.json".length));
  }
  let dropped = 0;
  for (const slug of slugs) {
    // Round 3 (code-reviewer, SF-A, MEASURED): `urlSlug` can never return "" for a non-empty
    // URL (its own `.replace` leaves at least one character per non-empty input), so a literal
    // `.md` / `.meta.json` pair — empty slug — cannot be a file THIS tool wrote under any URL.
    // Cheap early exit before the lstat calls below; SUPERSEDED as the security boundary by the
    // `urlSlug(meta.url) === slug` check further down (round 4, code-reviewer, SF-C), which
    // subsumes this case along with every other malformed slug — kept only as an optimisation.
    if (slug.length === 0 || keep.has(slug)) continue;
    const contentPath = join(dir, `${slug}.md`);
    const metaPath = join(dir, `${slug}.meta.json`);
    let metaStat: Stats;
    try {
      // C2: a candidate must be a REAL file with a META that PARSES — never a lone half of
      // the pair, and never one unlinked on name shape alone.
      if (!lstatSync(contentPath).isFile()) continue;
      metaStat = lstatSync(metaPath);
      if (!metaStat.isFile()) continue;
    } catch {
      continue; // one half vanished, or is a symlink/directory: not ours to touch here
    }
    // Round 2 (security-architect, R3): the same `Stats` already paid for above bounds the
    // read C2 requires — no candidate this tool itself wrote is anywhere near this size (a
    // `CacheMeta` is a URL, an ISO instant and an optional etag), so a directory entry over it
    // is either not this tool's or already unparseable; skip the read+parse either way rather
    // than paying for a `JSON.parse` a directory of many planted files could otherwise force.
    if (metaStat.size > MAX_META_FILE_BYTES) continue;
    const meta = readMetaFile(metaPath);
    if (meta === undefined) continue; // C2: unproven — leave it for eviction
    // Round 4 (code-reviewer, SF-C; closes security-architect's N1 in full, not just the
    // empty-slug instance): a real, parseable pair is STILL not proof this tool wrote it under
    // THIS name — nothing before this line checks that the meta's own `url` is the one that
    // produced `slug`. A directory entry named, say, `my-notes.md` / `my-notes.meta.json`
    // carrying any OTHER valid `CacheMeta` passed every check above and was deleted.
    // `metaMatchesSlug` (D-71, `./cache-meta.js`) is the same `urlSlug` round-trip `writeCache`
    // used to NAME the file in the first place, so requiring it is not a new rule
    // — it is the one this function already claimed to enforce, actually checked. Validated
    // safe for every legitimate pair (including one whose URL is long enough to hit `urlSlug`'s
    // 120-char truncation): `urlSlug` is a pure function of the URL alone, so a slug
    // `writeCache` produced from a URL always round-trips.
    if (!metaMatchesSlug(meta, slug)) continue;
    try {
      rmSync(contentPath, { force: true });
      rmSync(metaPath, { force: true });
      dropped += 1;
    } catch (e) {
      warn(
        `vibectx: could not drop stale followed-page cache file ${clipText(contentPath, MAX_DISPLAY_PATH_CHARS)}: ${clipText(e instanceof Error ? e.message : String(e), MAX_CONFIG_VALUE_CHARS)}`,
      );
    }
  }
  // C3: the delete is otherwise silent on success — say what happened, so a mis-aimed
  // VIBECTX_CACHE_DIR or an unexpectedly empty offline cache has a trail to follow.
  if (dropped > 0) warn(`vibectx: refresh dropped ${dropped} stale followed-page${dropped === 1 ? "" : "s"} for "${clipText(library, MAX_CONFIG_VALUE_CHARS)}"`);
}
