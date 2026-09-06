import { installResolvedEntry, type LibraryEntry, type Registry } from "./registry.js";
import { lookupLibrary, resolvePackage, MAX_RESOLUTIONS_PER_HOUR } from "./resolve.js";
import { getLibraryDoc } from "./fetcher.js";
import { readCache, cacheRoot } from "./cache.js";
import { mapLimit } from "./doctor.js";
import { discoverProjectDependencies, isDeniedDependency, MANIFEST_FILES, type ProjectDependency } from "./project-deps.js";
import { CACHED_STATUSES, normaliseProjectDir, writeProjectRecord, type WarmRow, type WarmStatus } from "./project-store.js";

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
 *      on; anything else → `unresolved` with the resolver's attempt summary.
 *
 * Only the PRIMARY document is cached: index links are not followed during warm (get_docs
 * follows them on demand, per topic). A resolved entry already in the registry is warmed
 * like any entry, never re-resolved (that is `refresh`'s job).
 *
 * Concurrency: WARM_CONCURRENCY names at once through the shared `mapLimit`; no per-host
 * serialisation (a scaffold's names spread over npm, GitHub and a few docs hosts).
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

/** Bumped when a key is renamed, removed or changes meaning; new keys may be appended. */
export const WARM_SCHEMA_VERSION = 1;

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
}

const DEFAULT_TTL_HOURS = 168;

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** First fresh cached candidate, else the first stale one, for an entry — without touching the network. */
function cachedState(entry: LibraryEntry): { freshUrl?: string; stale?: { url: string; fetchedAt: string } } {
  const ttl = entry.ttlHours ?? DEFAULT_TTL_HOURS;
  let stale: { url: string; fetchedAt: string } | undefined;
  for (const url of entry.urls) {
    const hit = readCache(entry.name, url, ttl);
    if (!hit) continue;
    if (!hit.stale) return { freshUrl: url };
    stale ??= { url, fetchedAt: hit.meta.fetchedAt };
  }
  return { stale };
}

async function warmOneUnguarded(registry: Registry, dep: ProjectDependency, opts: WarmOptions): Promise<WarmRow> {
  const row: WarmRow = { name: dep.name, ecosystem: dep.ecosystem, source: dep.source, status: "unresolved" };
  if (isDeniedDependency(dep.name, dep.ecosystem)) return { ...row, status: "denied (noise list)" };

  const entry = lookupLibrary(registry, dep.name);
  if (entry) {
    row.library = entry.name;
    const { freshUrl, stale } = cachedState(entry);
    if (freshUrl) return { ...row, status: "already fresh", url: freshUrl };
    if (opts.offline) {
      return stale
        ? { ...row, status: "cached", url: stale.url, note: `stale copy from ${stale.fetchedAt}; offline` }
        : { ...row, status: "unreachable", note: "not cached; offline" };
    }
    const doc = await getLibraryDoc(entry);
    if (!doc) return { ...row, status: "unreachable", note: "all candidate URLs unreachable" };
    if (doc.staleNote) {
      return { ...row, status: "unreachable", url: doc.url, note: `stale copy from ${stale?.fetchedAt ?? "earlier"} kept; all candidate URLs unreachable just now` };
    }
    return { ...row, status: "cached", url: doc.url };
  }

  if (opts.offline) return { ...row, status: "unresolved", note: "not in the registry; offline, not resolved" };
  const out = await resolvePackage(dep.name, { ecosystem: dep.ecosystem, now: opts.now, warn: opts.warn });
  if (out.ok && out.entry) {
    // S2: a resolved entry never displaces a curated one; the lookup above missed, so this installs.
    installResolvedEntry(registry, out.entry);
    return { ...row, library: out.entry.name, status: "resolved+cached", url: out.chosen };
  }
  if (out.limited) {
    return { ...row, status: "skipped (rate cap)", note: `resolution limit reached (${MAX_RESOLUTIONS_PER_HOUR} per hour per process); run warm again later` };
  }
  return { ...row, status: "unresolved", note: out.attempts.join("; ") };
}

/** One dependency's row. Never throws: an unexpected error (EACCES on the cache, a corrupt
 *  meta.json) becomes an `unreachable` row carrying the message, so one bad name cannot
 *  take down the run. */
async function warmOne(registry: Registry, dep: ProjectDependency, opts: WarmOptions): Promise<WarmRow> {
  try {
    return await warmOneUnguarded(registry, dep, opts);
  } catch (e) {
    return { name: dep.name, ecosystem: dep.ecosystem, source: dep.source, status: "unreachable", note: `error: ${errorMessage(e)}` };
  }
}

/**
 * Warm a project. Throws (→ CLI exit 2) when `dir` is not a directory or holds no manifest
 * discovery can read; every per-name problem is a row, never an exception. Writes the
 * project record unless `offline`.
 */
export async function runWarm(registry: Registry, opts: WarmOptions = {}): Promise<WarmReport> {
  const dir = normaliseProjectDir(opts.dir ?? process.cwd());
  const discovery = discoverProjectDependencies(dir);
  if (discovery.manifests.length === 0) {
    const why = discovery.notes.length > 0 ? ` (${discovery.notes.join("; ")})` : "";
    throw new Error(`no dependency manifest in ${dir}${why}; looked for ${MANIFEST_FILES.join(", ")}`);
  }
  const rows = await mapLimit(discovery.dependencies, opts.concurrency ?? WARM_CONCURRENCY, (dep) => warmOne(registry, dep, opts));
  const cached = rows.filter((r) => CACHED_STATUSES.has(r.status)).length;
  const denied = rows.filter((r) => r.status === "denied (noise list)").length;
  const report: WarmReport = {
    schemaVersion: WARM_SCHEMA_VERSION,
    generatedAt: (opts.now ?? (() => new Date()))().toISOString(),
    dir,
    offline: opts.offline === true,
    manifests: discovery.manifests,
    notes: discovery.notes,
    dependencies: rows,
    cached,
    attempted: rows.length - denied,
    denied,
    total: rows.length,
  };
  if (!report.offline) {
    writeProjectRecord({ schemaVersion: 1, dir, manifests: report.manifests, dependencies: rows, warmedAt: report.generatedAt }, opts.warn);
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
  const rows = report.dependencies.map((d) => [d.name, d.library ?? "—", d.status, d.url ?? "—"]);
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
    if (!CACHED_STATUSES.has(d.status) && d.status !== "denied (noise list)" && d.note) lines.push(`✗ ${d.name}: ${d.note}`);
  }
  for (const n of report.notes) lines.push(`note: ${n}`);
  return lines.join("\n");
}

/** The MCP `warm_project` tool body: the table for `dir` (default: the server's working
 *  directory), or the one-line reason it could not run. Never throws. */
export async function warmToolText(registry: Registry, dir?: string): Promise<string> {
  try {
    return formatWarmTable(await runWarm(registry, { dir }));
  } catch (e) {
    return errorMessage(e);
  }
}
