import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isRegularFile, newerSchemaVersion, writeAtomic } from "./atomic-store.js";
import { cacheRoot, ensureCacheRoot } from "./cache.js";
import { ACTIVITY_LOG_MAX_ENTRIES } from "./limits.js";
import { cleanText, clipText } from "./text.js";

/**
 * D-51 (A20, PAR-729) — VibeCTX's own activity log: `<cacheRoot>/activity.json`, shape
 * `{ schemaVersion: 1, entries: [...] }`. One entry per call through `get_docs`, `search`,
 * `resolve_library` or `refresh` (the write hooks live in those four modules, not here —
 * this module only knows how to persist and read back an entry it is handed).
 *
 * WHAT IT RECORDS, AND WHAT IT NEVER DOES (the whole point of D-51): what was *consulted* —
 * the tool, the library, the topic/query, the document URL, a content HASH, freshness, and
 * the outcome. Never the document TEXT, the same boundary the search index holds (D-33): a
 * hash proves a document was the one served without needing to store what it said. This is
 * what makes the log usable as evidence of a specific consultation claim (the motivating
 * case: a signed Change Record attesting to file contents that were never actually read)
 * without turning the cache directory into a second copy of every document ever served.
 *
 * TRUST BOUNDARY, SAME AS EVERY OTHER STORE HERE (A4). Anything with write access to the
 * cache directory can edit this file, so every field is re-validated on read against the
 * rule it actually has (`toActivityEntry`); an unknown `tool` or `outcome` drops the row
 * (K3 — the vocabulary is closed, and future growth needs a version bump the same way
 * `WARM_STATUSES` does); a corrupt file reads as empty, never thrown.
 *
 * WRITES NEVER THROW (D-13). `recordActivity` is a void function that swallows every error
 * from `mkdirSync` through `writeAtomic` — a full disk, a read-only `$HOME`, a newer
 * schemaVersion on disk — because a log write can never be allowed to turn a successful
 * retrieval into a failed one. This is the same shape as `indexCachedDocument`
 * (`search-index.ts`): best effort, void, silent past one warn line.
 *
 * OFF SWITCH: `VIBECTX_NO_LOG=1` (see `shouldLog`), matching `VIBECTX_NO_AUTOWARM`'s own
 * "anything but empty/0/false turns it off" contract so the two env vars behave alike.
 *
 * BOUNDED (D-51): at most `ACTIVITY_LOG_MAX_ENTRIES`, oldest dropped first — the same
 * least-recently-written-wins shape `cache-evict.ts` uses for cache bytes, sized down for a
 * single small JSON file instead of a directory of documents. Every field below is itself
 * bounded (`MAX_LIBRARY_CHARS`, `MAX_QUERY_CHARS`, `MAX_URL_CHARS`, a fixed-width hash, a
 * closed `tool`/`outcome` vocabulary, one ISO timestamp), so the entry cap is also a byte
 * cap, not a second independent mechanism: MEASURED, one entry at every field's worst-case
 * length, pretty-printed exactly as this module writes it, is 1,032 bytes; `limits.ts`'s
 * `ACTIVITY_LOG_MAX_ENTRIES` entries of that worst case is ~2.06 MiB — see that constant's
 * own comment for the number.
 *
 * COST OF THE READ-MODIFY-WRITE (disclosed, not hidden): unlike `resolved.json` (written on
 * a resolution, which is rare) or a project record (written once per `warm` run), this file
 * is written on every ordinary retrieval — potentially every `get_docs` call an agent makes.
 * Each write re-parses and re-serializes the whole file, bounded by the entry cap above, so
 * the cost is bounded too: MEASURED (`test/activity-log.test.ts`'s own steady-state fixture),
 * a read-modify-write against a file already AT `ACTIVITY_LOG_MAX_ENTRIES` is ~9.6 ms —
 * background bookkeeping next to the fetch or cache read the retrieval itself just did, not a
 * cost that grows once the cap is reached (it is already at its worst case there). Two
 * vibectx processes writing at the same instant can still lose one another's *entry* (last
 * writer wins), the same trade-off `resolved-store.ts` already accepts for the same reason:
 * this is a local, single-user tool, and the file is never corrupted by the race, only
 * occasionally short one row.
 */

export const ACTIVITY_LOG_SCHEMA_VERSION = 1;
const FILE_NAME = "activity.json";

/** Off switch (D-51). Mirrors `shouldAutowarm` (`autowarm.ts`) exactly: anything but an
 *  absent variable, `"0"` or `"false"` turns logging OFF, so the two opt-out variables this
 *  tool ships behave the same way for the same reason — a variable someone set to `0` to
 *  disable something must not be read as enabling it. */
export const ACTIVITY_LOG_OFF_ENV = "VIBECTX_NO_LOG";

export function shouldLog(env: NodeJS.ProcessEnv = process.env): boolean {
  const flag = (env[ACTIVITY_LOG_OFF_ENV] ?? "").trim().toLowerCase();
  return flag === "" || flag === "0" || flag === "false";
}

export const ACTIVITY_TOOLS = ["get_docs", "search", "resolve_library", "refresh"] as const;
export type ActivityTool = (typeof ACTIVITY_TOOLS)[number];

/** Closed vocabulary (K3): `matched` — content was found and served; `no-match` — the
 *  library/document was consulted but the topic or query found nothing in it; `not-cached`
 *  — nothing was available to serve (no cached or fetchable document); `unresolved` — the
 *  library name itself could not be established. Each write hook's own doc comment says
 *  which of the four applies to each of its branches. */
export const ACTIVITY_OUTCOMES = ["matched", "no-match", "not-cached", "unresolved"] as const;
export type ActivityOutcome = (typeof ACTIVITY_OUTCOMES)[number];

/** Longest `library`: npm's published package-name limit, the same bound `project-store.ts`
 *  and `search.ts` already apply to the same kind of field. */
const MAX_LIBRARY_CHARS = 214;
/** Longest `query` (get_docs's `topic`, search's `query`): matches get_docs's own echo bound
 *  (`MAX_ECHOED_TOPIC_CHARS`) — this is a log entry, not the rendered response, but the same
 *  "one short phrase" reasoning applies. */
const MAX_QUERY_CHARS = 200;
/** Longest `url`: matches `search.ts`'s own `MAX_URL_CHARS`. */
const MAX_URL_CHARS = 300;
/** Longest `version`: reserved for a future source (see the field's own comment below);
 *  bounded now so a value from an untrusted future caller cannot inflate the file. */
const MAX_VERSION_CHARS = 100;
/** `documentHash` (`search-index.ts`) is exactly 16 lowercase hex characters. */
const HASH_PATTERN = /^[0-9a-f]{16}$/;

export interface ActivityEntry {
  tool: ActivityTool;
  /** Canonical library name, when the call is scoped to one. Absent for a multi-library
   *  `search` (no single library is "the" one consulted) and for a full (no-argument)
   *  `refresh`. */
  library?: string;
  /** The topic (`get_docs`) or query (`search`), cleaned and clipped — never the document
   *  text itself. */
  query?: string;
  /** The document URL actually consulted, when there is exactly one (absent for a
   *  multi-library `search` and a full `refresh`, for the same reason as `library`).
   *  Validated by SHAPE only, not the fetch-time host allow-list, and with its query string
   *  stripped — see `sanitizeLoggedUrl`'s own comment (PAR-792). */
  url?: string;
  /** `documentHash` (`search-index.ts`) of the document's content — proves WHICH document
   *  without storing what it said (D-33's own boundary, reused here). */
  contentHash?: string;
  /** Reserved: VibeCTX does not track a package's semver today — nothing upstream of this
   *  module resolves one (`ResolveOutcome`/`ResolvedMeta` carry no version field) — so this
   *  is always `undefined` in every entry this version writes. Kept in the schema, not
   *  invented a value for, so a future source can populate it without a schema bump. */
  version?: string;
  /** Whether the consulted copy was fresh (not past its TTL), when that is known. */
  fresh?: boolean;
  outcome: ActivityOutcome;
  /** ISO-8601 UTC instant, `Date.prototype.toISOString`'s own shape — the same one
   *  `project-store.ts` requires of `warmedAt`/`failedAt`. */
  timestamp: string;
}

export function activityLogPath(): string {
  return join(cacheRoot(), FILE_NAME);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** A UTC ISO-8601 instant exactly as `Date.prototype.toISOString` writes it. Mirrors
 *  `project-store.ts`'s own `validIsoInstant` (not imported from there: that copy is
 *  private, and duplicating four lines here is cheaper than exporting a cross-module
 *  dependency for them — see D-48's own precedent for a SHARED primitive, which this is
 *  not: the rule itself, not a compiled RegExp singleton, is what must stay in one piece).
 *
 *  Deliberately NOT byte-identical to `project-store.ts`'s copy: the fractional-seconds
 *  group is bounded to 9 digits here (nanosecond precision — already past anything real
 *  `toISOString` produces), matching `cache-meta.ts`'s `ISO_INSTANT`, not `project-store.ts`'s
 *  or `search-index.ts`'s. `Number.isFinite(Date.parse(…))` is not a length backstop —
 *  MEASURED (`cache-meta.ts`'s own comment): `Date.parse("2020-01-01T00:00:00." +
 *  "1".repeat(10_000) + "Z")` returns a finite timestamp. Left unbounded, a planted entry's
 *  `timestamp` would be the one field nothing else here clips, and `formatActivityLogTable`
 *  pads every OTHER row's cell to the widest column — turning one hostile entry into an
 *  unbounded amount of table output on every `vibectx log`, and, worse, a value this size
 *  written back to disk on every subsequent `recordActivity` call, since a valid row is
 *  never dropped once accepted. `cache-meta.ts`'s own comment names `project-store.ts` and
 *  `search-index.ts` as carrying the unbounded form still; this file must not become a third. */
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/;
function validIsoInstant(value: unknown): value is string {
  return typeof value === "string" && ISO_INSTANT.test(value) && Number.isFinite(Date.parse(value));
}

/** One bounded, cleaned string field, or `undefined` when absent or invalid. */
function cleanField(value: unknown, max: number): string | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  return clipText(value, max);
}

/** Longest raw URL string this module will attempt to parse — a guard before `new URL()`
 *  runs, independent of `MAX_URL_CHARS`'s post-sanitization storage clip. Mirrors
 *  `link-policy.ts`'s own bound for `sanitizeRemoteUrl` (private there, so restated here
 *  rather than exported solely for this one reuse). */
const MAX_RAW_URL_CHARS = 2048;

/**
 * D-51/PAR-792 (security-architect): the persisted `url` is only ever DISPLAYED — `vibectx
 * log` never fetches it, and `test/import-graph.test.ts`'s done-when (c) pins that
 * `activity-log.ts` cannot even reach `fetcher.ts` transitively, so this premise cannot go
 * stale silently — so it is validated by SHAPE (https, well-formed, no userinfo), not by the
 * fetch-time host allow-list `sanitizeRemoteUrl` (`link-policy.ts`) applies. Structurally the
 * same move `cache-meta.ts`'s own `validMetaUrl` makes (its own stated reason is narrower —
 * "the trust decision was already made when the document was written" — but the effect is
 * the same: no host check on a value nothing here re-fetches). Without it, an internal/
 * air-gapped library's document URL (`allowInternalHosts: true`) fails `sanitizeRemoteUrl`'s
 * `isForbiddenHost` check and is silently dropped from the one place meant to evidence it was
 * consulted — exactly the air-gapped deployment this tool's own README courts.
 *
 * Also strips the QUERY STRING, not only the fragment `sanitizeRemoteUrl` already strips: a
 * config-authored `urls` entry carrying `?token=…`/`?api_key=…` (a realistic internal-docs
 * pattern) must not be written into a log file in plaintext. DISCLOSED COST, not costless:
 * the cache key is the FULL url including its query (`urlSlug`, `cache-meta.ts`), so two
 * requests differing only in query (`?v=2` vs `?v=3`) are genuinely different documents that
 * this field can no longer tell apart by `url` alone — `contentHash` still distinguishes
 * them, but a reader scanning by `url` sees one string for two sources, with nothing marking
 * that a query was ever present and removed.
 */
function sanitizeLoggedUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const raw = value.trim();
  if (raw.length === 0 || raw.length > MAX_RAW_URL_CHARS) return undefined;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:") return undefined;
  if (url.username !== "" || url.password !== "") return undefined;
  url.hash = "";
  url.search = "";
  return url.href;
}

/**
 * Validate one persisted row (K1, mirroring `project-store.ts`'s own `toWarmRow`): `tool`
 * and `outcome` must be in their closed vocabularies and `timestamp` a strict ISO instant —
 * any of those failing drops the ROW; `library`, `query`, `url`, `version` are bounded and
 * cleaned — failing drops only that FIELD; `contentHash` must match `documentHash`'s exact
 * shape or is dropped; `fresh` must be a boolean or is dropped. Every surviving string passes
 * through `cleanText` via `clipText`, so no control, bidi or zero-width character reaches a
 * render of this file (S3).
 */
export function toActivityEntry(raw: unknown): ActivityEntry | undefined {
  if (!isRecord(raw)) return undefined;
  const { tool, library, query, url, contentHash, version, fresh, outcome, timestamp } = raw;
  if (typeof tool !== "string" || !(ACTIVITY_TOOLS as readonly string[]).includes(tool)) return undefined;
  if (typeof outcome !== "string" || !(ACTIVITY_OUTCOMES as readonly string[]).includes(outcome)) return undefined;
  if (!validIsoInstant(timestamp)) return undefined;
  const cleanedLibrary = cleanField(library, MAX_LIBRARY_CHARS);
  const cleanedQuery = cleanField(query, MAX_QUERY_CHARS);
  const sanitizedUrl = sanitizeLoggedUrl(url);
  const cleanedVersion = cleanField(version, MAX_VERSION_CHARS);
  // Built in this exact field order (K1): tool, library, query, url, contentHash, version,
  // fresh, outcome, timestamp. This is the ONE place an `ActivityEntry` is ever constructed
  // — both a freshly recorded one (`recordActivity`, via this same function) and one read
  // back off disk — so there is no second "record" shape to keep in lockstep with this one:
  // `writeAtomic`'s write and `vibectx log --json`'s read both serialize these objects
  // directly, and this order is what each promises to keep stable within a schemaVersion.
  const entry: ActivityEntry = { tool: tool as ActivityTool } as ActivityEntry;
  if (cleanedLibrary !== undefined) entry.library = cleanedLibrary;
  if (cleanedQuery !== undefined) entry.query = cleanedQuery;
  if (sanitizedUrl !== undefined) entry.url = clipText(sanitizedUrl, MAX_URL_CHARS);
  if (typeof contentHash === "string" && HASH_PATTERN.test(contentHash)) entry.contentHash = contentHash;
  if (cleanedVersion !== undefined) entry.version = cleanedVersion;
  if (typeof fresh === "boolean") entry.fresh = fresh;
  entry.outcome = outcome as ActivityOutcome;
  entry.timestamp = timestamp;
  return entry;
}

/** Every valid persisted entry, oldest first; `[]` when the file is missing, corrupt, of
 *  another schema, OR (PAR-805) a symlink rather than the regular file `recordActivity` writes
 *  — `isRegularFile` (`atomic-store.ts`, `lstat`, never `stat`) refuses to follow a link planted
 *  at `activity.json`'s own path, the read-side half of the same trust rule every other store in
 *  this cache directory applies to its own file. Deliberately NOT bounded by size the way
 *  `readBoundedRegularFile` (`cache.ts`) bounds a `.md` content read — `activity.json` is capped
 *  by entry count (`ACTIVITY_LOG_MAX_ENTRIES`), not by this read path, and a second, unrelated
 *  size ceiling here would be a second thing to keep in sync with that cap for no benefit. */
export function readActivityEntries(): ActivityEntry[] {
  if (!isRegularFile(activityLogPath())) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(activityLogPath(), "utf8"));
  } catch {
    return [];
  }
  if (!isRecord(parsed) || parsed.schemaVersion !== ACTIVITY_LOG_SCHEMA_VERSION || !Array.isArray(parsed.entries)) return [];
  const out: ActivityEntry[] = [];
  for (const raw of parsed.entries) {
    const e = toActivityEntry(raw);
    if (e) out.push(e);
  }
  return out;
}

/** What a write hook hands in: everything `ActivityEntry` has except `timestamp`, which this
 *  module stamps itself (a caller-supplied clock is a test seam only, `opts.now` below). */
export type ActivityInput = Omit<ActivityEntry, "timestamp">;

/**
 * Append one entry and persist it, bounded to `ACTIVITY_LOG_MAX_ENTRIES` (oldest dropped
 * first). NEVER THROWS (D-13): a failure anywhere — the directory cannot be created, the
 * file cannot be read or written, a newer schemaVersion is on disk — costs one `warn` line
 * and the entry is simply not recorded; the retrieval that triggered this call already
 * succeeded or failed on its own terms before this function was ever reached, and nothing
 * here may change that.
 *
 * A no-op (no directory even created) when `shouldLog` is off, so `VIBECTX_NO_LOG=1` costs
 * nothing at all, not even a stat call.
 */
export function recordActivity(
  input: ActivityInput,
  opts: { env?: NodeJS.ProcessEnv; warn?: (message: string) => void; now?: () => Date } = {},
): void {
  const warn = opts.warn ?? ((m: string) => void process.stderr.write(`${m}\n`));
  try {
    if (!shouldLog(opts.env ?? process.env)) return;
    const now = opts.now ?? (() => new Date());
    const entry = toActivityEntry({ ...input, timestamp: now().toISOString() });
    if (!entry) return; // the caller handed this module a value its own fields cannot hold
    const dir = cacheRoot();
    // PAR-791 (security-architect) originally required 0o700 here specifically, because this
    // file holds what the user asked about — the first thing in the cache directory that does
    // — but noted a real limitation: `mkdirSync` never retroactively `chmod`s an existing
    // directory, and most cache roots already existed by the time a retrieval logged its first
    // entry, since `cache.ts`'s own read/write path almost always creates the root FIRST, with
    // no mode. PAR-805 closes that gap at its source rather than papering over it here: EVERY
    // site that may create the cache root now goes through the same `ensureCacheRoot`
    // (`cache.ts`) this call now also uses, so whichever one actually runs first still produces
    // 0o700 — see that function's own comment for the full rationale, including why a
    // PRE-EXISTING looser root is warned about, not tightened.
    // PAR-859: a symlinked `dir` is now refused by `ensureCacheRoot` itself (warns once, returns
    // `false`) rather than written through silently — a plain `return;`, not falling through to
    // `writeAtomic`, which would otherwise throw against a directory that was never created and
    // land in this function's own outer `catch`, printing a second, redundant "activity not
    // logged" line on top of `ensureCacheRoot`'s own warning for the same refusal.
    if (!ensureCacheRoot(dir, warn)) return;
    const path = activityLogPath();
    const newer = newerSchemaVersion(path, ACTIVITY_LOG_SCHEMA_VERSION);
    if (newer !== undefined) {
      warn(`vibectx: activity not logged — ${path} has a newer schemaVersion ${newer} (this version writes ${ACTIVITY_LOG_SCHEMA_VERSION}); upgrade vibectx or delete the file`);
      return;
    }
    const entries = readActivityEntries();
    entries.push(entry);
    const bounded = entries.length > ACTIVITY_LOG_MAX_ENTRIES ? entries.slice(entries.length - ACTIVITY_LOG_MAX_ENTRIES) : entries;
    // PAR-791: owner-only — self-healing across every write (writeAtomic's own comment), so a
    // file left world-readable by a vibectx version older than this fix is corrected on its
    // very next entry, not merely held steady from here on.
    writeAtomic(path, JSON.stringify({ schemaVersion: ACTIVITY_LOG_SCHEMA_VERSION, entries: bounded }, null, 2), { mode: 0o600 });
  } catch (e) {
    warn(`vibectx: activity not logged: ${cleanText(e instanceof Error ? e.message : String(e))}`);
  }
}

/** `vibectx log --json`'s shape — the one interface every reader (a Workforce gate included,
 *  per D-51) needs, in the same `{ schemaVersion, entries }` envelope every other command
 *  emits. New keys may be appended in a later version; `schemaVersion` is bumped only when
 *  an existing key is renamed, removed or changes meaning (the same rule every other
 *  `--json` surface in this tool documents). */
export interface ActivityLogReport {
  schemaVersion: typeof ACTIVITY_LOG_SCHEMA_VERSION;
  entries: ActivityEntry[];
}

/** The `vibectx log` CLI body's data: every valid entry, oldest first. Never throws (D-13,
 *  the same as `readActivityEntries`, which this wraps). */
export function readActivityLog(): ActivityLogReport {
  return { schemaVersion: ACTIVITY_LOG_SCHEMA_VERSION, entries: readActivityEntries() };
}

/** Human-readable table for `vibectx log` (no `--json`) — the same shape every other
 *  subcommand's table takes: a header, one row per entry, a summary line. `detail` is the
 *  query when there is one, else the url, else nothing — the single most informative field
 *  this entry carries, since showing both would not fit a terminal width. Every cell passes
 *  through `cleanText` (S3): this file is a trust boundary like any other in the cache
 *  directory, and `toActivityEntry` already cleaned each field on read, but the table is the
 *  render boundary and must hold for any `ActivityEntry` it is handed, not only one that
 *  came back through validation. */
export function formatActivityLogTable(entries: ActivityEntry[]): string {
  const header = ["timestamp", "tool", "library", "outcome", "detail"];
  // `timestamp` is clipped here too, not only validated on read (belt-and-braces, matching
  // `delete normalised.ecosystem` in registry.ts's own precedent for a field already
  // guarded upstream): it is the one field `toActivityEntry` accepts by SHAPE rather than
  // by an explicit length bound, and this table must hold for any `ActivityEntry` it is
  // handed, not only one that came back through validation — an unclipped timestamp would
  // otherwise widen every OTHER row's cell to match it (`padEnd` below).
  const rows = entries.map((e) => [clipText(e.timestamp, 40), e.tool, e.library ?? "—", e.outcome, e.query ?? e.url ?? "—"].map(cleanText));
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const render = (cells: string[]) => cells.map((c, i) => (i === cells.length - 1 ? c : c.padEnd(widths[i]))).join("  ");
  return [render(header), ...rows.map(render), "", `${entries.length} entr${entries.length === 1 ? "y" : "ies"}`].join("\n");
}
