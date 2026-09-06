import type { LibraryEntry, Registry } from "./registry.js";
import { getDocsDetailed } from "./get-docs.js";
import { readCache, cacheRoot } from "./cache.js";
import { looksLikeIndex } from "./retrieval.js";

/**
 * `vibectx doctor` — proves retrieval works per library by running each entry's
 * probe queries through the same code path get_docs uses, and classifying what
 * came back. Transport-free: the CLI and the MCP tool both render `runDoctor`'s
 * report. It measures retrieval (did a section come back?), not correctness.
 */

/**
 * How the primary document was classified:
 * - `index-only`   — structure: `looksLikeIndex` (link-dense) regardless of URL.
 *                    Answers depend on following links.
 * - `readme`       — not an index, and the resolved URL is README-style: host is
 *                    raw.githubusercontent.com, or the last path segment is
 *                    README(.ext); OR the URL carries no llms.txt provenance (last
 *                    path segment is not `llms.txt` / `llms-<suffix>.txt`). Curated
 *                    fallback pages land here.
 * - `full-text`    — not an index, at an `llms.txt` / `llms-*.txt` URL: prose served whole.
 * - `unreachable`  — nothing could be fetched and nothing is cached.
 */
export type SourceKind = "full-text" | "index-only" | "readme" | "unreachable";

/**
 * - `answered`       — get_docs returned ≥ 1 section for the probe.
 * - `index-followed` — answered, and at least one returned section came from a
 *                      followed index page (the index alone would have returned
 *                      only its link list).
 * - `no match`       — get_docs returned no sections.
 */
export type ProbeStatus = "answered" | "index-followed" | "no match";

export interface ProbeResult {
  query: string;
  /** True when no probeQueries were configured and the query was derived from the description. */
  derived: boolean;
  status: ProbeStatus;
  /** Index links followed for this probe. */
  followed: number;
  /** Index links that were candidates but not followed (outside origin, too large, or unavailable). */
  dropped: number;
}

export interface LibraryReport {
  library: string;
  kind: SourceKind;
  /** Resolved primary URL; null when unreachable. */
  url: string | null;
  /** Age of the cached primary document in hours (one decimal); null when not cached. */
  cacheAgeHours: number | null;
  /** True when the cache entry is past its TTL. */
  stale: boolean;
  ttlHours: number;
  probes: ProbeResult[];
  /** Totals across probes. */
  followed: number;
  dropped: number;
  healthy: boolean;
  /** Why the library is unhealthy; empty when healthy. */
  reasons: string[];
}

export interface DoctorReport {
  generatedAt: string;
  libraries: LibraryReport[];
  healthy: number;
  total: number;
}

export interface DoctorOptions {
  /** Check only this library. */
  library?: string;
  /** Cache-only: the network is never touched; not-cached libraries are reported unreachable. */
  offline?: boolean;
}

const DEFAULT_TTL_HOURS = 168;
/** A cache entry older than this many TTLs marks the library unhealthy (boundary inclusive:
 *  age >= 2 x TTL). Not applied when ttlHours is 0 — that means "always revalidate", and
 *  cache.ts marks such entries stale the moment they are written. */
const STALE_TTL_MULTIPLE = 2;
/** Libraries checked at once. Bounds fan-out to remote hosts (security finding, PAR-707 review). */
export const DOCTOR_CONCURRENCY = 3;

const README_BASENAME = /^readme(\.[a-z0-9]+)?$/i;
const LLMS_TXT_BASENAME = /^llms(-[a-z0-9]+)?\.txt$/i;

function lastPathSegment(url: string): string | undefined {
  try {
    const path = new URL(url).pathname;
    return decodeURIComponent(path.slice(path.lastIndexOf("/") + 1));
  } catch {
    return undefined;
  }
}

function kindFromStructure(url: string, isIndex: boolean): SourceKind {
  if (isIndex) return "index-only";
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return "readme"; // unparseable: no llms.txt provenance can be established
  }
  const base = lastPathSegment(url) ?? "";
  if (host === "raw.githubusercontent.com" || README_BASENAME.test(base)) return "readme";
  return LLMS_TXT_BASENAME.test(base) ? "full-text" : "readme";
}

/** Classify a fetched (or cached) primary document — see SourceKind for the rule. */
export function classifySourceKind(url: string, content: string): SourceKind {
  return kindFromStructure(url, looksLikeIndex(content));
}

function words(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1);
}

/** Probe for an entry without probeQueries: its description minus the library's
 *  own name tokens; the name itself when that leaves nothing. */
export function deriveProbeQuery(entry: LibraryEntry): string {
  const nameTokens = new Set(words(entry.name));
  const rest = words(entry.description ?? "").filter((t) => !nameTokens.has(t));
  return rest.length > 0 ? rest.join(" ") : entry.name;
}

function probeQueriesFor(entry: LibraryEntry): { query: string; derived: boolean }[] {
  if (entry.probeQueries && entry.probeQueries.length > 0) {
    return entry.probeQueries.map((query) => ({ query, derived: false }));
  }
  return [{ query: deriveProbeQuery(entry), derived: true }];
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** One library's row. Never throws: an unexpected error (unreadable cache file, EACCES on
 *  write, corrupt meta.json) becomes an `unreachable` row carrying the message, so one bad
 *  library cannot take down the whole report. */
async function checkLibrary(entry: LibraryEntry, offline: boolean): Promise<LibraryReport> {
  try {
    return await checkLibraryUnguarded(entry, offline);
  } catch (e) {
    return {
      library: entry.name,
      kind: "unreachable",
      url: null,
      cacheAgeHours: null,
      stale: false,
      ttlHours: entry.ttlHours ?? DEFAULT_TTL_HOURS,
      probes: [],
      followed: 0,
      dropped: 0,
      healthy: false,
      reasons: [`error: ${errorMessage(e)}`],
    };
  }
}

async function checkLibraryUnguarded(entry: LibraryEntry, offline: boolean): Promise<LibraryReport> {
  const ttlHours = entry.ttlHours ?? DEFAULT_TTL_HOURS;
  const probes: ProbeResult[] = [];
  let source: { url: string; stale: boolean } | undefined;
  let isIndex = false;

  for (const { query, derived } of probeQueriesFor(entry)) {
    const out = await getDocsDetailed(entry, { topic: query, offline });
    if (!out.source) {
      // Nothing fetched, nothing cached: later probes would fail identically.
      source = undefined;
      probes.length = 0;
      break;
    }
    source = out.source;
    isIndex = out.isIndex;
    const status: ProbeStatus =
      out.matched === 0 ? "no match" : out.returnedFromFollowed > 0 ? "index-followed" : "answered";
    probes.push({
      query,
      derived,
      status,
      followed: out.followed.length,
      dropped: out.dropped.outsideOrigin + out.dropped.tooLarge + out.dropped.unavailable,
    });
  }

  const kind: SourceKind = source ? kindFromStructure(source.url, isIndex) : "unreachable";
  // Read the cache AFTER probing so a refresh that just succeeded shows as fresh.
  const hit = source ? readCache(entry.name, source.url, ttlHours) : undefined;
  const cacheAgeHours = hit
    ? Math.round(((Date.now() - new Date(hit.meta.fetchedAt).getTime()) / 3600_000) * 10) / 10
    : null;
  const stale = hit?.stale ?? false;
  const followed = probes.reduce((n, p) => n + p.followed, 0);
  const dropped = probes.reduce((n, p) => n + p.dropped, 0);

  const reasons: string[] = [];
  if (kind === "unreachable") reasons.push("unreachable: nothing fetched and nothing cached");
  if (kind === "index-only" && followed === 0) {
    reasons.push("index-only, no links followed (answered from the link list at best)");
  }
  for (const p of probes) if (p.status === "no match") reasons.push(`no match: "${p.query}"`);
  if (ttlHours > 0 && cacheAgeHours !== null && cacheAgeHours >= STALE_TTL_MULTIPLE * ttlHours) {
    reasons.push(`stale ${cacheAgeHours}h, over ${STALE_TTL_MULTIPLE}x TTL (${ttlHours}h)`);
  }

  return {
    library: entry.name,
    kind,
    url: source?.url ?? null,
    cacheAgeHours,
    stale,
    ttlHours,
    probes,
    followed,
    dropped,
    healthy: reasons.length === 0,
    reasons,
  };
}

/** Map with at most `limit` calls in flight; results in input order. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

function unknownLibraryMessage(registry: Registry, library: string): string {
  return `Unknown library "${library}". Known: ${[...registry.entries.keys()].join(", ")}`;
}

/** Run the doctor over the registry (or one library). Up to DOCTOR_CONCURRENCY
 *  libraries are checked at once; the report keeps registry order. */
export async function runDoctor(registry: Registry, opts: DoctorOptions = {}): Promise<DoctorReport> {
  let entries = [...registry.entries.values()];
  if (opts.library !== undefined) {
    const one = registry.entries.get(opts.library);
    if (!one) throw new Error(unknownLibraryMessage(registry, opts.library));
    entries = [one];
  }
  const libraries = await mapLimit(entries, DOCTOR_CONCURRENCY, (e) => checkLibrary(e, opts.offline === true));
  return {
    generatedAt: new Date().toISOString(),
    libraries,
    healthy: libraries.filter((l) => l.healthy).length,
    total: libraries.length,
  };
}

/** The MCP `doctor` tool body: the table for the registry or one library, or the
 *  unknown-library message (no probe is run in that case). */
export async function doctorToolText(registry: Registry, library?: string): Promise<string> {
  if (library !== undefined && !registry.entries.has(library)) return unknownLibraryMessage(registry, library);
  return formatDoctorTable(await runDoctor(registry, { library }));
}

/** 0 when every checked library is healthy, else 1. */
export function doctorExitCode(report: DoctorReport): 0 | 1 {
  return report.healthy === report.total ? 0 : 1;
}

function describeProbes(probes: ProbeResult[]): string {
  if (probes.length === 0) return "—";
  if (probes.length === 1) {
    const p = probes[0];
    return `"${p.query}"${p.derived ? " (derived)" : ""} → ${p.status}`;
  }
  const counts = new Map<ProbeStatus, number>();
  for (const p of probes) counts.set(p.status, (counts.get(p.status) ?? 0) + 1);
  const parts = [...counts.entries()].map(([status, n]) => `${n} ${status}`);
  return `${probes.length} probes: ${parts.join(", ")}`;
}

function describeCache(lib: LibraryReport): string {
  if (lib.cacheAgeHours === null) return "—";
  return `${lib.cacheAgeHours.toFixed(1)}h${lib.stale ? " stale" : ""}`;
}

/** Human-readable table; the same text the CLI prints and the MCP doctor tool returns. */
export function formatDoctorTable(report: DoctorReport): string {
  const header = ["library", "kind", "cache", "probe", "links", "mark"];
  const rows = report.libraries.map((lib) => [
    lib.library,
    lib.kind,
    describeCache(lib),
    describeProbes(lib.probes),
    `${lib.followed}/${lib.dropped}`,
    lib.healthy ? "✓" : "✗",
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const render = (cells: string[]) =>
    cells.map((c, i) => (i === cells.length - 1 ? c : c.padEnd(widths[i]))).join("  ");
  const lines = [
    `vibectx doctor · ${report.generatedAt} · cache ${cacheRoot()}`,
    "",
    render(header),
    ...rows.map(render),
    "",
    `${report.healthy}/${report.total} libraries healthy`,
  ];
  for (const lib of report.libraries) {
    if (!lib.healthy) lines.push(`✗ ${lib.library}: ${lib.reasons.join("; ")}`);
  }
  return lines.join("\n");
}
