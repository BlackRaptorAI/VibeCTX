import { realpathSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { DEFAULT_REGISTRY, installResolvedEntry, type LibraryEntry, type Registry } from "./registry.js";
import { lookupLibrary, resolvePackage, MAX_RESOLUTIONS_PER_HOUR } from "./resolve.js";
import { getLibraryDoc } from "./fetcher.js";
import { readCache, cacheRoot, type CacheHit } from "./cache.js";
import { sweepCacheTempFiles } from "./atomic-store.js";
import { openIndexSession, type IndexSession } from "./search-index.js";
import { mapLimit } from "./doctor.js";
import { cleanText, discoverProjectDependencies, isDeniedDependency, MANIFEST_FILES, type DependencyEcosystem, type ProjectDependency } from "./project-deps.js";
import { CACHED_STATUSES, makeWarmRow, normaliseProjectDir, PROJECT_RECORD_SCHEMA_VERSION, readProjectRecord, writeProjectRecord, type WarmRow, type WarmStatus } from "./project-store.js";

export type { WarmRow, WarmStatus } from "./project-store.js";

/**
 * `vibectx warm` (PAR-656) — read the project's dependency manifests and put every
 * dependency's primary document in the cache, so `get_docs` answers for the whole stack
 * offline. Transport-free: the CLI, the MCP `warm_project` tool and the tests all render
 * `runWarm`'s report.
 *
 * Per dependency, in order:
 *   1. on DEPENDENCY_DENYLIST → `denied (noise list)`; nothing fetched.
 *   2. a registry hit (`lookupLibrary`: curated name, alias, config, PEP 503 form, or a
 *      persisted resolution) with a FRESH cached document → `already fresh`; no network.
 *   3. a registry hit otherwise → `getLibraryDoc(entry)` — etag revalidation when stale,
 *      full fetch when uncached → `cached`; a stale copy kept because the network failed,
 *      or nothing at all → `unreachable`.
 *   4. no registry hit → `resolvePackage(name, { ecosystem })`, the ecosystem being the one
 *      the manifest implies (package.json → npm, pyproject / requirements → PyPI), which
 *      halves the metadata fetches and removes the same-name-on-both-registries ambiguity
 *      → `resolved+cached` (the entry joins the live registry and resolved.json, and the
 *      chosen document is already cached); the per-hour resolution cap is NOT bypassed —
 *      once it is hit the remaining unknown names are `skipped (rate cap)` and the run goes
 *      on; anything else → `unresolved` with the resolver's attempt summary and a
 *      `failedAt` clock.
 *   5. negative memo (R3): a name the project record shows `unresolved` with `failedAt` in
 *      the last RECENT_FAILURE_HOURS is `unresolved (recent)` — no resolution slot spent, the
 *      original `failedAt` carried over so the window never slides — unless `force`. The
 *      memo never applies to a name the registry now knows.
 *
 * D-11 (oversight, 2026-09-06): registry entries match by name regardless of ecosystem.
 * When the manifest's ecosystem differs from the entry's evident one — a default entry is
 * the npm package by the NAMING RULE; a resolved entry is `resolved.source`; a config entry
 * has none — the row carries `curated entry is the <npm|pypi> package` (or `resolved entry
 * is …`), so a Python project asking for `stripe` sees it got stripe-node. An `ecosystem`
 * field on entries is a queued follow-up.
 *
 * D-10 (oversight, 2026-09-06, amended): the MCP tool (`warmToolText`) accepts only the
 * server's working directory or a directory beneath it, decided on REAL paths — a symlink
 * inside the working directory that points elsewhere is refused (S-A). The CLI is
 * unrestricted (the user typed it).
 *
 * Every table cell passes through `cleanText` before rendering (S3).
 *
 * Only the PRIMARY document is cached: index links are not followed during warm (get_docs
 * follows them on demand, per topic). A resolved entry already in the registry is warmed
 * like any entry, never re-resolved (that is `refresh`'s job).
 *
 * Concurrency: WARM_CONCURRENCY names at once through the shared `mapLimit`; no per-host
 * serialisation (a scaffold's names spread over npm, GitHub and a few docs hosts). Names
 * that map to the same registry entry (`react` + `react-dom`) share one fetch per run.
 *
 * `offline`: a cache-only report — fresh → `already fresh`, stale → `cached` (noted),
 * uncached → `unreachable`, unknown → `unresolved`; no network, no project record.
 *
 * Exit code (warmExitCode): 0 when every attempted (non-denied) name is `cached`,
 * `already fresh` or `resolved+cached`; 1 otherwise — `skipped (rate cap)` counts as not
 * cached, because the promise is "your stack's docs are on disk" and they are not yet.
 */

/** Names warmed at once. Bounds fan-out to remote hosts (same reasoning as DOCTOR_CONCURRENCY). */
export const WARM_CONCURRENCY = 4;

/** The `--json` report's schema version. K2: ONE constant governs both the report and the
 *  on-disk project record, because they carry the same rows — this is a re-export of
 *  PROJECT_RECORD_SCHEMA_VERSION, so the two can never drift. Bumped when a key is renamed,
 *  removed or changes meaning, and when a WarmStatus value is added or removed (K3: readers
 *  drop rows with an unknown status). New keys may be appended. */
export const WARM_SCHEMA_VERSION = PROJECT_RECORD_SCHEMA_VERSION;

/** How long an `unresolved` outcome in the project record short-circuits the next run (R3). ASSUMED. */
export const RECENT_FAILURE_HOURS = 24;

export interface WarmReport {
  schemaVersion: typeof WARM_SCHEMA_VERSION;
  generatedAt: string;
  /** Absolute, normalised project directory. */
  dir: string;
  offline: boolean;
  /** Manifests read, relative to `dir`, in read order. */
  manifests: string[];
  /** Discovery notes: files not read, includes skipped, parse failures. */
  notes: string[];
  dependencies: WarmRow[];
  /** Rows whose status is cached / already fresh / resolved+cached. */
  cached: number;
  /** Rows not denied (the denominator of the summary line). */
  attempted: number;
  denied: number;
  /** Every discovered dependency, denied ones included. */
  total: number;
}

export interface WarmOptions {
  /** Project directory (default: the process's working directory). */
  dir?: string;
  /** Cache-only report; the network is never attempted and no record is written. */
  offline?: boolean;
  /** Clock for the resolver's sliding-hour cap (tests). */
  now?: () => Date;
  /** Names in flight at once (default WARM_CONCURRENCY). */
  concurrency?: number;
  /** Where the resolver's save notes go (default stderr). */
  warn?: (message: string) => void;
  /** Retry names the project record marks `unresolved` within RECENT_FAILURE_HOURS (R3). */
  force?: boolean;
}

const DEFAULT_TTL_HOURS = 168;

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** First fresh cached candidate, else the first stale one, for an entry — without touching the
 *  network. The HIT is carried out with it (PAR-659): warm is the one place that has both the
 *  document text and its cache meta in hand, so it is where the search index is kept current
 *  without a second read. */
function cachedState(entry: LibraryEntry): { fresh?: { url: string; hit: CacheHit }; stale?: { url: string; hit: CacheHit } } {
  const ttl = entry.ttlHours ?? DEFAULT_TTL_HOURS;
  let stale: { url: string; hit: CacheHit } | undefined;
  for (const url of entry.urls) {
    const hit = readCache(entry.name, url, ttl);
    if (!hit) continue;
    if (!hit.stale) return { fresh: { url, hit } };
    stale ??= { url, hit };
  }
  return { stale };
}

/**
 * D-34 (PAR-659): keep the cross-library search index current for the document this run put
 * (or found) in the cache, so `warm` leaves a USABLE index behind and the first `search` after
 * it is the fast path rather than a full re-tokenization of the whole stack.
 *
 * Only the PRIMARY document, never a followed index page. Best effort throughout: the index is
 * a derived cache, so a failure here changes the warm row not at all (D-13).
 *
 * R2: the whole run shares ONE session, so the index file is read once and written once
 * instead of once per library. MEASURED before that: 7,529 ms added to an already-fresh
 * 30-library / 150 MB warm for zero index change.
 */
function indexWarmed(session: IndexSession, entry: LibraryEntry, url: string, content: string, fetchedAt?: string): void {
  session.add(entry.name, url, content, fetchedAt);
}

type Outcome = Pick<WarmRow, "status" | "url" | "note">;

/** One run's state: the per-entry memo (names sharing an entry share one fetch) and the
 *  recent-failure memo read from the previous project record. */
type RunState = { entryJobs: Map<string, Promise<Outcome>>; recent: Map<string, WarmRow>; nowMs: number; index: IndexSession };

const memoKey = (ecosystem: DependencyEcosystem, name: string) => `${ecosystem}:${name}`;

/** D-11: the ecosystem an entry evidently belongs to, when that can be known. */
function evidentEcosystem(entry: LibraryEntry): DependencyEcosystem | undefined {
  if (entry.resolved) return entry.resolved.source;
  // A shipped default (or its D-06 alias-trimmed copy, which shares the same `urls` array) is
  // the npm package by the NAMING RULE; a config entry — even one overriding a default's
  // name — brings its own urls and has no evident ecosystem.
  return DEFAULT_REGISTRY.some((d) => d.urls === entry.urls) ? "npm" : undefined;
}

function ecosystemNote(entry: LibraryEntry, dep: ProjectDependency): string | undefined {
  const evident = evidentEcosystem(entry);
  if (evident === undefined || evident === dep.ecosystem) return undefined;
  return entry.resolved
    ? `resolved entry is the ${evident} package (resolve it again with --${dep.ecosystem} to switch)`
    : `curated entry is the ${evident} package`;
}

/** Warm one registry entry: fresh cache → no network; else getLibraryDoc (etag-first). */
async function warmEntry(entry: LibraryEntry, opts: WarmOptions, session: IndexSession): Promise<Outcome> {
  const { fresh, stale } = cachedState(entry);
  if (fresh) {
    indexWarmed(session, entry, fresh.url, fresh.hit.content, fresh.hit.meta.fetchedAt);
    return { status: "already fresh", url: fresh.url };
  }
  if (opts.offline) {
    if (!stale) return { status: "unreachable", note: "not cached; offline" };
    indexWarmed(session, entry, stale.url, stale.hit.content, stale.hit.meta.fetchedAt);
    return { status: "cached", url: stale.url, note: `stale copy from ${stale.hit.meta.fetchedAt}; offline` };
  }
  const doc = await getLibraryDoc(entry);
  if (!doc) return { status: "unreachable", note: "all candidate URLs unreachable" };
  if (doc.staleNote) {
    indexWarmed(session, entry, doc.url, doc.content, stale?.hit.meta.fetchedAt);
    return { status: "unreachable", url: doc.url, note: `stale copy from ${stale?.hit.meta.fetchedAt ?? "earlier"} kept; all candidate URLs unreachable just now` };
  }
  indexWarmed(session, entry, doc.url, doc.content, undefined);
  return { status: "cached", url: doc.url };
}

async function warmOneUnguarded(registry: Registry, dep: ProjectDependency, opts: WarmOptions, run: RunState): Promise<WarmRow> {
  const base = { name: dep.name, ecosystem: dep.ecosystem, source: dep.source };
  if (isDeniedDependency(dep.name, dep.ecosystem)) return makeWarmRow({ ...base, status: "denied (noise list)" });

  const entry = lookupLibrary(registry, dep.name);
  if (entry) {
    let job = run.entryJobs.get(entry.name);
    if (!job) {
      job = warmEntry(entry, opts, run.index);
      run.entryJobs.set(entry.name, job);
    }
    const outcome = await job;
    const notes = [outcome.note, ecosystemNote(entry, dep)].filter((n): n is string => n !== undefined);
    return makeWarmRow({ ...base, library: entry.name, status: outcome.status, url: outcome.url, note: notes.length > 0 ? notes.join("; ") : undefined });
  }

  if (opts.offline) return makeWarmRow({ ...base, status: "unresolved", note: "not in the registry; offline, not resolved" });

  // R3: a recent failure is reported, not retried, unless forced.
  const previous = run.recent.get(memoKey(dep.ecosystem, dep.name));
  if (previous?.failedAt !== undefined && !opts.force) {
    const ageHours = (run.nowMs - Date.parse(previous.failedAt)) / 3600_000;
    const why = previous.note ? ` (${previous.note})` : "";
    return makeWarmRow({
      ...base,
      status: "unresolved (recent)",
      note: `unresolved ${ageHours.toFixed(1)} h ago${why}; retried after ${RECENT_FAILURE_HOURS} h, or now with --force`,
      failedAt: previous.failedAt,
    });
  }

  const out = await resolvePackage(dep.name, { ecosystem: dep.ecosystem, now: opts.now, warn: opts.warn });
  if (out.ok && out.entry) {
    // S2: a resolved entry never displaces a curated one; the lookup above missed, so this installs.
    installResolvedEntry(registry, out.entry);
    return makeWarmRow({ ...base, library: out.entry.name, status: "resolved+cached", url: out.chosen });
  }
  if (out.limited) {
    return makeWarmRow({ ...base, status: "skipped (rate cap)", note: `resolution limit reached (${MAX_RESOLUTIONS_PER_HOUR} per hour per process); run warm again later` });
  }
  return makeWarmRow({ ...base, status: "unresolved", note: out.attempts.join("; "), failedAt: new Date(run.nowMs).toISOString() });
}

/** One dependency's row. Never throws: an unexpected error (EACCES on the cache, a corrupt
 *  meta.json) becomes an `unreachable` row carrying the message, so one bad name cannot
 *  take down the run. */
async function warmOne(registry: Registry, dep: ProjectDependency, opts: WarmOptions, run: RunState): Promise<WarmRow> {
  try {
    return await warmOneUnguarded(registry, dep, opts, run);
  } catch (e) {
    return makeWarmRow({ name: dep.name, ecosystem: dep.ecosystem, source: dep.source, status: "unreachable", note: `error: ${errorMessage(e)}` });
  }
}

/** Rows of the previous record that count as a recent failure (R3), keyed by ecosystem:name. */
function recentFailures(dir: string, nowMs: number): Map<string, WarmRow> {
  const memo = new Map<string, WarmRow>();
  const record = readProjectRecord(dir);
  if (!record) return memo;
  for (const row of record.dependencies) {
    if (row.status !== "unresolved" && row.status !== "unresolved (recent)") continue;
    if (row.failedAt === undefined) continue;
    const age = nowMs - Date.parse(row.failedAt);
    if (age >= 0 && age < RECENT_FAILURE_HOURS * 3600_000) memo.set(memoKey(row.ecosystem, row.name), row);
  }
  return memo;
}

/**
 * D-19 (PAR-657): the discovered config files the registry could not load, as report notes.
 * A warm run that quietly fell back to the shipped defaults — because the project's committed
 * `vibectx.config.json` was skipped — otherwise reads as a clean run, and a `--json` consumer
 * never sees the stderr line the loader wrote. Appended to the existing `notes[]`, which is
 * an additive change: no `schemaVersion` bump (README: new keys may be appended, and this
 * adds no key at all).
 */
function configNotes(registry: Registry): string[] {
  const notes: string[] = [];
  for (const file of registry.config?.files ?? []) {
    if (file.error === undefined) continue;
    notes.push(`config: ${file.display ?? file.path} (${file.scope}) not loaded: ${file.error}`);
  }
  return notes;
}

/**
 * Warm a project. Throws (→ CLI exit 2) when `dir` is not a directory or holds no manifest
 * discovery can read; every per-name problem is a row, never an exception. Writes the
 * project record unless `offline`.
 */
export async function runWarm(registry: Registry, opts: WarmOptions = {}): Promise<WarmReport> {
  sweepCacheTempFiles(cacheRoot()); // S-C: clear temp files a killed run left behind
  const dir = normaliseProjectDir(opts.dir ?? process.cwd());
  const discovery = discoverProjectDependencies(dir);
  if (discovery.manifests.length === 0) {
    const why = discovery.notes.length > 0 ? ` (${discovery.notes.join("; ")})` : "";
    throw new Error(`no dependency manifest in ${dir}${why}; looked for ${MANIFEST_FILES.join(", ")}`);
  }
  const nowMs = (opts.now ?? (() => new Date()))().getTime();
  const warn = opts.warn ?? ((m: string) => process.stderr.write(m));
  const run: RunState = {
    entryJobs: new Map(),
    recent: opts.offline ? new Map() : recentFailures(dir, nowMs),
    nowMs,
    index: openIndexSession(warn),
  };
  let rows: WarmRow[];
  try {
    rows = await mapLimit(discovery.dependencies, opts.concurrency ?? WARM_CONCURRENCY, (dep) => warmOne(registry, dep, opts, run));
  } finally {
    // R2: one write for the whole run, and it happens even when the run threw — a half-warmed
    // cache with an index describing it is strictly better than one with no index at all.
    run.index.flush();
  }
  const cached = rows.filter((r) => CACHED_STATUSES.has(r.status)).length;
  const denied = rows.filter((r) => r.status === "denied (noise list)").length;
  const report: WarmReport = {
    schemaVersion: WARM_SCHEMA_VERSION,
    generatedAt: new Date(nowMs).toISOString(),
    dir,
    offline: opts.offline === true,
    manifests: discovery.manifests,
    notes: [...discovery.notes, ...configNotes(registry)],
    dependencies: rows,
    cached,
    attempted: rows.length - denied,
    denied,
    total: rows.length,
  };
  if (!report.offline) {
    // D-13 (oversight, 2026-09-06): the record is a memo, not the product. An unwritable
    // cache costs the next run one resolution retry — it must never cost the user the report
    // they asked for, so a failure is a warn line plus a note, and the exit code is unchanged.
    try {
      // K2: a file written by a NEWER vibectx is not ours to overwrite. writeProjectRecord
      // says so on stderr and returns false — the report gets the same sentence, because a
      // `--json` consumer never sees stderr and would otherwise read a run that silently
      // kept no memo as one that wrote one.
      const written = writeProjectRecord({ schemaVersion: PROJECT_RECORD_SCHEMA_VERSION, dir, manifests: report.manifests, dependencies: rows, warmedAt: report.generatedAt }, opts.warn);
      if (!written) report.notes.push("project record not written: newer schema on disk");
    } catch (e) {
      const reason = cleanText(errorMessage(e));
      report.notes.push(`project record not written: ${reason}`);
      (opts.warn ?? ((m: string) => process.stderr.write(m)))(`vibectx: project record not written: ${reason}\n`);
    }
  }
  return report;
}

/** 0 when every attempted name is cached (fresh, fetched or resolved), else 1. */
export function warmExitCode(report: WarmReport): 0 | 1 {
  return report.cached === report.attempted ? 0 : 1;
}

/** Human-readable table; the same text the CLI prints and the MCP warm_project tool returns. */
export function formatWarmTable(report: WarmReport): string {
  const header = ["dependency", "library", "status", "url"];
  const rows = report.dependencies.map((d) => [d.name, d.library ?? "—", d.status, d.url ?? "—"].map(cleanText)); // S3
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const render = (cells: string[]) => cells.map((c, i) => (i === cells.length - 1 ? c : c.padEnd(widths[i]))).join("  ");
  const summary = `${report.cached}/${report.attempted} dependencies cached${report.denied > 0 ? ` · ${report.denied} denied (noise list)` : ""}`;
  const lines = [
    `vibectx warm · ${report.dir}${report.offline ? " · offline" : ""} · cache ${cacheRoot()}`,
    `manifests: ${report.manifests.join(", ")}`,
    "",
    render(header),
    ...rows.map(render),
    "",
    summary,
  ];
  for (const d of report.dependencies) {
    if (!d.note) continue;
    const mark = CACHED_STATUSES.has(d.status) ? "·" : "✗"; // a cached row can still carry the D-11 note
    if (d.status !== "denied (noise list)") lines.push(cleanText(`${mark} ${d.name}: ${d.note}`));
  }
  for (const n of report.notes) lines.push(cleanText(`note: ${n}`));
  return lines.join("\n");
}

/** `target` is `base` or beneath it, comparing whole path components (so `/a/proj-evil` is
 *  NOT beneath `/a/proj`). */
function beneath(target: string, base: string): boolean {
  return target === base || target.startsWith(base.endsWith(sep) ? base : base + sep);
}

/**
 * The real path of `path` when it exists; otherwise the real path of its nearest EXISTING
 * ancestor with the remaining components appended. A path that does not exist yet still gets
 * a real answer, because every symlink on the part of it that does exist has been resolved:
 * `cwd/link/nope` with `link -> /elsewhere` answers `/elsewhere/nope`, not `cwd/link/nope`.
 *
 * undefined only when nothing on the chain up to the filesystem root can be resolved — a
 * broken filesystem, not a path question. Callers must refuse on undefined rather than guess.
 */
function realWithNonExistentTail(path: string): string | undefined {
  const tail: string[] = [];
  let current = path;
  for (;;) {
    try {
      const real = realpathSync(current);
      return tail.length === 0 ? real : join(real, ...tail);
    } catch {
      const parent = dirname(current);
      if (parent === current) return undefined; // reached the root and even it did not resolve
      tail.unshift(basename(current));
      current = parent;
    }
  }
}

/**
 * D-10 (amended by oversight, 2026-09-06): is `dir` the working directory or beneath it,
 * decided on REAL paths? The target's real path must be the working directory's real path or
 * beneath it, compared component-wise, so a symlink inside the working directory pointing
 * anywhere else on the filesystem is refused (S-A) and a sibling that merely shares the prefix
 * (`/a/proj-evil` against `/a/proj`) is refused too. The working directory may itself be
 * reached through a symlink: both sides are resolved.
 *
 * A target that does not exist is decided on the SAME real basis, never lexically: the nearest
 * existing ancestor is resolved and the missing tail appended (S-A). A lexical fallback would
 * have made `cwd/link/nope` — a path whose every existing component says "outside" — read as
 * contained, and handed the whole subtree behind the link to discovery. So `cwd/link/nope` is
 * refused, while `cwd/sub/nope` under a real subdirectory is still allowed through to
 * discovery's honest "not a directory" / "no dependency manifest".
 */
export function isWithinCwd(dir: string, cwd = process.cwd()): boolean {
  const base = realWithNonExistentTail(resolve(cwd));
  const real = realWithNonExistentTail(resolve(dir));
  if (base === undefined || real === undefined) return false; // undecidable: refuse
  return beneath(real, base);
}

/** The MCP `warm_project` tool body: the table for `dir` (default: the server's working
 *  directory, and only that directory or one beneath it — D-10), or the one-line reason it
 *  could not run. Never throws. No `force`: D-12 makes retrying a recent resolution failure
 *  a CLI flag (`vibectx warm --force`), so a model cannot spend the resolution budget on
 *  names the last run already proved unresolvable. */
export async function warmToolText(registry: Registry, dir?: string): Promise<string> {
  const cwd = process.cwd();
  const target = dir ?? cwd;
  if (!isWithinCwd(target, cwd)) {
    return cleanText(`${resolve(target)} is outside the project directory (${cwd}); warm_project only reads the server's working directory or a directory beneath it`);
  }
  try {
    return formatWarmTable(await runWarm(registry, { dir: target }));
  } catch (e) {
    return cleanText(errorMessage(e));
  }
}
