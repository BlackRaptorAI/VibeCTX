import { lstatSync, mkdirSync, readdirSync, readFileSync, existsSync, renameSync, rmSync, writeFileSync, type Stats } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { tempPathFor, writeAtomic } from "./atomic-store.js";
import { sanitizeRemoteUrl } from "./link-policy.js";
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

/** PAR-786 — roots `writeCache` has already refused because they are a symlink or another
 *  non-directory, said once per distinct root per process, mirroring `cache-evict.ts`'s
 *  `refusedRoots` for the identical reason: a warm run calling `writeCache` for twenty
 *  libraries against the same misconfigured `VIBECTX_CACHE_DIR` must print one line, not
 *  twenty identical ones. */
const refusedWriteRoots = new Set<string>();

/** Test seam: forget what this process has already noted and migrated. */
export function resetCacheRootState(): void {
  deprecationNoted = false;
  resolvedDefaultRoot = undefined;
  refusedWriteRoots.clear();
}

/** Empty is not a directory: an exported-but-empty variable reads as unset rather than as
 *  "cache into the current working directory". */
const configured = (value: string | undefined): string | undefined =>
  value !== undefined && value.length > 0 ? value : undefined;

/** A real directory this tool would be willing to treat as a cache (D-46: lstat, not stat).
 *
 *  PAR-786 (findings F-2a/F-2b) — exported: this was
 *  `dropFollowedPageCache`'s own guard alone until this item, which reuses it for `readCache`
 *  and `writeCache` (below) so a symlinked root or library directory reads/writes exactly as a
 *  missing one does, the same D-46 rule `cache-evict.ts`'s `rootIsSweepable` already applies to
 *  eviction. Also exported for reuse by `activity-log.ts` (a later item, PAR-805, which already
 *  imports `cacheRoot` from this same file — no circular-import risk). */
export function isRealDirectory(path: string): boolean {
  try {
    return lstatSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** PAR-786 write-side guard: does something already sit at `path` that is NOT a real directory?
 *  `false` both when `path` does not exist at all (nothing to refuse — the caller creates a
 *  fresh, real chain exactly as it always has) and when it IS already a real directory (the
 *  ordinary, overwhelmingly common case). `true` only when `lstat` finds an ENTRY there that is
 *  not a directory — a symlink, most importantly, but also, defensively, any other
 *  non-directory node. `lstat`, never `stat`: the question is what the ENTRY at this exact path
 *  is, never what it resolves to (D-46's rule, applied here to the WRITE side for the first
 *  time — see `writeCache`'s own comment for what this closes). */
function existsAsNonDirectory(path: string): boolean {
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    return false;
  }
  return !stat.isDirectory();
}

/** PAR-786: is a symlink already planted at exactly this leaf? Checked BEFORE `mkdirSync` runs,
 *  regardless of what the link points to — MEASURED (this file's own investigation, folded into
 *  PAR-786, correcting an earlier assumption in the issue this closes): a symlink leaf pointing
 *  at an EXISTING real directory does not make `mkdirSync(dir, { recursive: true })` throw at
 *  all — Node's recursive `mkdir` sees `EEXIST` on the raw syscall, then `stat`s (follows the
 *  link) to check whether what is already there is a directory, and a real directory at the far
 *  end of the link reads as "already exists, nothing to do" — SUCCESS, silently, with every
 *  subsequent write in `writeCache` resolving through the link into that directory. Only a
 *  DANGLING symlink leaf throws (`ENOENT`, since the followed `stat` fails); a symlink to an
 *  existing FILE throws too, but as `EEXIST` — indistinguishable by error code from the
 *  pre-existing "library directory position is a plain file" case this function has always
 *  thrown for (see `test/cache.test.ts`'s "a failed write (the library dir is a file) throws"
 *  case). Catching by error code after the fact would therefore either miss the dangerous
 *  existing-directory shape entirely (it never throws) or have to swallow the plain-file case
 *  this function must keep throwing for. Checking the leaf's own `lstat` up front sidesteps all
 *  three shapes uniformly, with one rule: a plain file at this exact leaf is untouched by this
 *  check and still throws out of `mkdirSync` exactly as it always has; only a SYMLINK here is
 *  new to PAR-786. */
function isSymlinkAt(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

/** Longest cache CONTENT file this process will read back (PAR-786, finding F-10). Mirrors
 *  `PRIMARY_DOC_MAX_BYTES` (`src/fetcher.ts`, 25 MiB) as a SEPARATE constant, not an import:
 *  `fetcher.ts` imports `{ readCache, writeCache, touchCache }` from THIS file, so importing the
 *  other way would be circular. `PRIMARY_DOC_MAX_BYTES` is `fetchUrl`'s own `maxBytes` bound —
 *  applied by the CALLER (`getLibraryDoc`/`fetchLinkedPage`, `fetcher.ts`) to what a live fetch
 *  may hand to `writeCache` — not a bound `writeCache` itself enforces; `writeCache` has no size
 *  check of its own on `content` and writes whatever it is given. This constant is the READ-side
 *  backstop for a `.md` file that reached disk some other way regardless (a planted or corrupted
 *  file, or a stale write from a build that had a different `PRIMARY_DOC_MAX_BYTES`) — see
 *  `test/cache-content-size.test.ts`'s boundary assertion that this stays `>=`
 *  `PRIMARY_DOC_MAX_BYTES`, so raising the write-side bound alone can never silently make every
 *  large document permanently uncacheable. F-10 measured a planted 31,457,287-byte `.md` file
 *  read wholesale and served in full before this existed. */
export const MAX_CACHED_CONTENT_BYTES = 25 * 1024 * 1024;

/** A real, regular file (never a symlink — `lstat`, not `stat`, so the ENTRY at this exact path
 *  decides, never what it points at) no larger than `maxBytes`. Returns its contents as utf8, or
 *  `undefined` for anything else: missing, a symlink, a directory, oversized, or unreadable all
 *  read the same as "not cached" to the caller, matching the trust rule A4 already applies to
 *  `.meta.json` (`readMetaFile`, `cache-meta.ts`) and now applies to this file's other half
 *  (PAR-786, findings F-2a/F-10). The size check runs BEFORE any read — an oversized file costs
 *  one `lstat`, never a `readFileSync` (`test/cache-content-size.test.ts` proves this by call
 *  count, not merely by return value). Exported for reuse by `activity-log.ts` (PAR-805, a later
 *  item).
 *
 *  DISCLOSED TOCTOU, for parity with `writeCache`'s own honest disclosure of its analogous
 *  window: `lstatSync` then `readFileSync` is two syscalls, not one — a real file swapped for a
 *  symlink by a concurrent process in the gap between them would be FOLLOWED by the second call,
 *  since `readFileSync` (unlike `lstatSync`) has no way to insist "only if this is still not a
 *  link." Bounded the same way the write side's residual is: this function's body is entirely
 *  synchronous (no `await` for such a race to land in). Left as a disclosed residual, not closed
 *  here — closing it fully would need `openSync(path, O_RDONLY | O_NOFOLLOW)` + `fstatSync` +
 *  reading by file descriptor, which is POSIX-only and out of this issue's scope. */
export function readBoundedRegularFile(path: string, maxBytes: number): string | undefined {
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    return undefined;
  }
  if (!stat.isFile() || stat.size > maxBytes) return undefined;
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
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

export function readCache(
  library: string,
  url: string,
  ttlHours: number,
): CacheHit | undefined {
  // PAR-786 (finding F-2a) — mirrors the D-46
  // leaf-`lstat` policy `dropFollowedPageCache` and `enforceCacheSizeCap` (`cache-evict.ts`)
  // already apply to DELETION: the ROOT, then the LIBRARY DIRECTORY, must each be proven a
  // real directory before anything below either is trusted, not just the two files at the
  // leaf (which is all this function checked before this item — F-2a: the content file had no
  // `lstat` guard at all). `isRealDirectory` returning `false` for a root or library directory
  // that does not exist yet is exactly right — nothing is cached either way, so an absent
  // cache and a refused symlinked one report the identical outward "uncached" result,
  // silently, matching this function's existing philosophy (see the corruption classes below)
  // that anything this process cannot trust is reported as a miss, never a special error.
  // `root` is resolved ONCE and threaded through `libDirIn` (not `libDir`, which calls
  // `cacheRoot()` again internally) so the value proven real is provably the value used — the
  // same discipline `dropFollowedPageCache` already follows, for the same reason (D-46's
  // comment there).
  const root = cacheRoot();
  if (!isRealDirectory(root)) return undefined;
  const dir = libDirIn(root, library);
  if (!isRealDirectory(dir)) return undefined;
  const slug = urlSlug(url);
  const contentPath = join(dir, `${slug}.md`);
  const metaPath = join(dir, `${slug}.meta.json`);
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
  // PAR-786 (F-2a, F-10) — the same bounded, symlink-refusing read `.meta.json` already gets
  // via `readMetaFile` (`cache-meta.ts`), now applied to the content half: `readBoundedRegularFile`
  // refuses a symlink (a secret file swapped in for this entry's `.md` — Attack 1 in the
  // finding), a dangling link, a directory, or anything over `MAX_CACHED_CONTENT_BYTES` — the
  // read-side ceiling `.meta.json` has always had but the content file never did (F-10: a
  // planted 31 MB `.md` was returned in full, 58 ms, before this). Same trust boundary as the
  // meta half, same rule (security-architect, A4 round 1, F1): an unreadable, oversized or
  // untrustworthy content file reads as uncached, not a throw — `configuredEntriesNeedingWarm`'s
  // pre-scan (autowarm.ts) and list_libraries both call this function directly, with no
  // try/catch of their own to fall back on.
  const content = readBoundedRegularFile(contentPath, MAX_CACHED_CONTENT_BYTES);
  if (content === undefined) return undefined;
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
 *  with what actually landed on disk by the width of that second call).
 *
 *  `finalUrl` (PAR-776, D-74): a 304 revalidation still follows redirects to reach the server
 *  that answered it, and that final URL can change between fetches even though the CONTENT
 *  (per the etag) has not — a site's redirect target moving is not a content change. Passing
 *  the newly observed value here keeps a long-lived, repeatedly-revalidated entry's `finalUrl`
 *  from going stale itself. `undefined` (the caller observed no redirect, or has nothing new
 *  to report) leaves whatever was already persisted untouched rather than erasing it.
 *
 *  PAR-786 (security-architect review round) — this is a THIRD read/write path through the same
 *  `.meta.json`, reachable on every 304 revalidation (`fetcher.ts`'s `getLibraryDoc`/
 *  `fetchLinkedPage`), and it was the one this item's first pass missed: `readMetaFile` already
 *  made the meta FILE itself symlink-safe (its own `lstat`, `cache-meta.ts`), but nothing here
 *  checked the ROOT or the LIBRARY DIRECTORY above it — `existsSync(metaPath)` follows a symlink
 *  through every path component, so a symlinked root or library directory let this function
 *  read AND rewrite a `.meta.json` on the far side of the link. Brought under the identical
 *  policy `readCache` uses, for the identical reason (D-46/D-83): a symlinked root or library
 *  directory reports the same outward "nothing to touch" result a missing one does, silently. */
export function touchCache(library: string, url: string, finalUrl?: string): string | undefined {
  const root = cacheRoot();
  if (!isRealDirectory(root)) return undefined;
  const dir = libDirIn(root, library);
  if (!isRealDirectory(dir)) return undefined;
  const metaPath = join(dir, `${urlSlug(url)}.meta.json`);
  const meta = readMetaFile(metaPath);
  // Best effort (D-13): a meta this process cannot trust has nothing to refresh. The next
  // `readCache` reports the entry uncached and the next fetch writes a fresh, valid meta.
  if (!meta) return undefined;
  // D-71 (PAR-749, Root 1) — same verification as `readCache`: a meta whose own `url` does
  // not match the URL this call was asked to refresh is not this entry, whatever the file
  // name says. Refreshing it anyway would extend the TTL of a mismatched record.
  if (meta.url !== url) return undefined;
  meta.fetchedAt = new Date().toISOString();
  // Stored only when it actually differs from `url` (matching `writeCache`'s own rule below) —
  // an entry that has never redirected stays byte-for-byte the same file shape it always was,
  // and a redirect that stops happening on this revalidation correctly clears the old value
  // rather than leaving a now-false "redirected from" fact behind. `sanitizeRemoteUrl`-validated
  // for the same reason `writeCache` validates it (security-architect, PAR-776 round 1, B-1) —
  // an oversized or malformed value is dropped, not written, rather than risking this entry's
  // `.meta.json` growing past `MAX_META_FILE_BYTES` on a revalidation.
  if (finalUrl !== undefined) {
    if (finalUrl !== url) {
      const clean = sanitizeRemoteUrl(finalUrl);
      if (clean !== undefined) meta.finalUrl = clean;
      else delete meta.finalUrl;
    } else {
      delete meta.finalUrl;
    }
  }
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
 *  reasoning applies here: report the timestamp actually persisted, not a freshly-taken one).
 *
 *  `finalUrl` (PAR-776, D-74): the URL the content was ACTUALLY fetched from, when `fetchUrl`
 *  followed a redirect away from `url` (the candidate this write is keyed by). Persisted only
 *  when it differs from `url` — the common, non-redirected case writes exactly the same file
 *  shape it always did — so a later CACHE HIT (no network call at all) can still tell `readCache`
 *  callers where the document's relative links and host policy should resolve against, not only
 *  the live fetch that first observed the redirect. Validated with `sanitizeRemoteUrl` even
 *  though it comes from `fetchUrl`'s own internal redirect-following (already held to the same
 *  https/non-forbidden-host bound `hopAllowed` enforces on every hop) — not to re-decide the
 *  host, but to bound its LENGTH the way `validEtag` already bounds `etag`'s (security-architect,
 *  PAR-776 round 1, B-1: an unbounded `Location` header written here can push a single entry's
 *  `.meta.json` past `MAX_META_FILE_BYTES`, making the WHOLE entry — not just its redirect
 *  awareness — permanently unreadable, defeating offline fallback for it). Dropped alone on
 *  rejection, exactly like an invalid `etag`: the entry still writes, just without the
 *  redirect-aware extra. */
/** PAR-786 (findings F-2b, N-b1) — refuses to write through a symlinked cache root or a
 *  symlinked library directory, silently for the caller (never throws) but not silently for the
 *  operator: `warn` (defaulting to this file's `toStderr`, the pattern `dropFollowedPageCache`
 *  already uses) is called once per distinct refused ROOT per process (`refusedWriteRoots`,
 *  mirroring `cache-evict.ts`'s `refusedRoots`) and, more cheaply, once per refused CALL for a
 *  symlinked library directory — that shape is rarer (it needs the root to already be right AND
 *  the one library's directory specifically planted), so a per-call note was judged not worth a
 *  second dedupe set; documented here rather than left implicit.
 *
 *  The root and library-directory checks run BEFORE `mkdirSync`, not after: MEASURED,
 *  `mkdirSync(dir, { recursive: true })` where the ROOT is a symlink succeeds SILENTLY and
 *  creates the library directory and both files INSIDE the symlink's target — no exception to
 *  catch afterward. Before this item, the only warning anywhere came from `cache-evict.ts`'s
 *  sweep (`noteCacheWrite` → `enforceCacheSizeCap` → `rootIsSweepable`), fired only when a sweep
 *  threshold happened to trigger, AFTER both renames had already landed — by then its wording
 *  ("Nothing was evicted and the link was not followed") was already FALSE: the write had gone
 *  through. Checking here means that when either of THESE two checks' warnings fires, the write
 *  genuinely has not happened yet — "nothing was written" is true at the moment it is printed.
 *  (There is a THIRD, later refusal path too — the post-`mkdirSync` TOCTOU recheck below — for
 *  which "nothing was created" no longer holds, since by definition `mkdirSync` already ran; see
 *  that check's own comment.)
 *
 *  On every refusal, whichever of the three checks catches it: `noteCacheWrite` is never called
 *  and nothing is written to `contentPath`/`metaPath`, and the return value is
 *  `new Date().toISOString()` computed once up front — safe because no caller re-reads the cache
 *  to get the content it just tried to write: `fetcher.ts`'s `getLibraryDoc`/`fetchLinkedPage`
 *  serve the in-memory fetched body they already have this round-trip, and use `writeCache`'s
 *  return only as the `fetchedAt` shown to the caller (confirmed by reading `fetcher.ts:340-400`
 *  and `:480-490` before relying on this). */
export function writeCache(
  library: string,
  url: string,
  content: string,
  etag?: string,
  finalUrl?: string,
  warn: (message: string) => void = toStderr,
): string {
  const fallbackFetchedAt = new Date().toISOString();
  const root = cacheRoot();
  // Deliberately ANY non-directory here, not "a symlink specifically" (`existsAsNonDirectory`,
  // not `isSymlinkAt` — contrast the LIBRARY-directory check below, which uses `isSymlinkAt` and
  // still lets a plain file at that narrower position throw, unchanged, out of `mkdirSync`).
  // The two are allowed to differ on purpose (code-reviewer, S2, PAR-786): a wrong ROOT is a
  // whole-cache misconfiguration — nothing under `VIBECTX_CACHE_DIR` is usable regardless of
  // which library asked — so it should degrade to "nothing persists this run" for every write,
  // not crash whichever request happens to go first. A plain file colliding with one specific
  // LIBRARY's directory position is narrow enough (one library, one name) that surfacing it as
  // an exception remains the more useful signal, and is the function's pre-existing behaviour
  // (`test/cache.test.ts`'s "library dir is a file" case) — not something this item changes.
  if (existsAsNonDirectory(root)) {
    if (!refusedWriteRoots.has(root)) {
      refusedWriteRoots.add(root);
      warn(
        `vibectx: refusing to cache into ${clipText(root, MAX_DISPLAY_PATH_CHARS)} — it is a symlink or another ` +
          `non-directory, not a real directory. Nothing was written. Remove it, or point VIBECTX_CACHE_DIR at a ` +
          `real directory.`,
      );
    }
    return fallbackFetchedAt;
  }
  const dir = libDirIn(root, library);
  // See `isSymlinkAt`'s own comment for why this is checked here, before `mkdirSync`, rather
  // than by catching whatever `mkdirSync` throws: a symlink leaf pointing at an existing real
  // directory does not throw at all.
  if (isSymlinkAt(dir)) {
    warn(
      `vibectx: refusing to cache "${clipText(library, MAX_CONFIG_VALUE_CHARS)}" into ` +
        `${clipText(dir, MAX_DISPLAY_PATH_CHARS)} — that path is a symlink, not a directory vibectx created. ` +
        `Nothing was written.`,
    );
    return fallbackFetchedAt;
  }
  // Unchanged from before this item: a plain file already at this exact leaf still throws
  // EEXIST out of mkdirSync here, exactly as `test/cache.test.ts`'s "library dir is a file"
  // case has always required.
  mkdirSync(dir, { recursive: true });
  // Belt-and-suspenders against a TOCTOU between the `isSymlinkAt` check above and the writes
  // below (an external process replacing `dir` with a symlink in that window) — the same
  // residual `dropFollowedPageCache` documents and does not close either; cheap, since this
  // function already pays for the shape of this check elsewhere in the file.
  //
  // DISCLOSED, NOT TESTED (R5/R9 mutation check, PAR-786): removing this check alone, with
  // `isSymlinkAt` above left intact, makes no test in the suite fail — every reachable,
  // single-threaded test scenario that would trip this check is already caught by
  // `isSymlinkAt` first, since nothing changes `dir`'s own leaf between that check and
  // `mkdirSync` in a synchronous test. This line exists ONLY for the genuine multi-process race
  // (CWE-367) `dropFollowedPageCache`'s own comment names and does not close either — real, but
  // not exercisable from a single synchronous test process. Kept rather than removed: cheap
  // (one `lstat` this function already has the shape to do), and the alternative (dropping it)
  // would be quietly narrowing coverage of a real, if rare, race.
  if (!isRealDirectory(dir)) {
    warn(
      `vibectx: refusing to cache "${clipText(library, MAX_CONFIG_VALUE_CHARS)}" into ` +
        `${clipText(dir, MAX_DISPLAY_PATH_CHARS)} — it is not a real directory. Nothing was written.`,
    );
    return fallbackFetchedAt;
  }
  const slug = urlSlug(url);
  const contentPath = join(dir, `${slug}.md`);
  const metaPath = join(dir, `${slug}.meta.json`);
  // validEtag, not a bare passthrough (write-side asymmetry, security-architect A4 round 2):
  // `etag` here is `res.headers.get("etag")`, already normalised by the Fetch spec so it can
  // never carry a newline — but a nonconforming server's high-byte obs-text or an oversized
  // value would otherwise land on disk unfiltered, cost space against the size cap, and be
  // silently dropped again on the very next read anyway.
  const meta: CacheMeta = { url, fetchedAt: fallbackFetchedAt };
  if (validEtag(etag)) meta.etag = etag;
  if (finalUrl !== undefined && finalUrl !== url) {
    const clean = sanitizeRemoteUrl(finalUrl);
    if (clean !== undefined) meta.finalUrl = clean;
  }
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
  // a write that already succeeded. `root`, not a second `cacheRoot()` call: the value this
  // function already proved real above.
  noteCacheWrite(root, contentPath, Buffer.byteLength(content, "utf8"));
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
