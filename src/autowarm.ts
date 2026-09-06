import type { LibraryEntry, Registry } from "./registry.js";
import { getLibraryDoc, type DocResult } from "./fetcher.js";
import { readCache } from "./cache.js";
import { mapLimit } from "./doctor.js";
import { indexCachedDocument } from "./search-index.js";

/**
 * Startup revalidation for the long-lived MCP server (PAR-656, from the PAR-653 comment:
 * "the cache does not warm or refresh itself"). When the server starts — and only then:
 * never under `doctor` / `resolve` / `warm`, never with `--offline` — every CONFIGURED
 * library (default or config; resolved records are left alone) that is uncached or past
 * its TTL is fetched in the background through the ordinary `getLibraryDoc`: an entry with
 * a cached copy is revalidated with `If-None-Match` first (a 304 costs no body), an
 * uncached one is fetched in candidate order. Only the primary document; no index links.
 *
 * Runs at AUTOWARM_CONCURRENCY. server.ts starts it (never awaited on the request path)
 * AFTER the transport is connected, so it never delays the handshake and never blocks a
 * tool call (fetches are async I/O; a concurrent get_docs for the same entry simply
 * fetches too — both write the same content, atomically). Every error is swallowed into one
 * summary line on stderr; the server cannot crash because of it. Opt out with
 * `VIBECTX_NO_AUTOWARM=1`. When the transport closes, the AbortSignal server.ts passes fires
 * and no further entry is scheduled (R4); a fetch already in flight completes on its own
 * (the fetcher's 20 s timeout bounds it; index.ts ends the process after a short grace).
 *
 * Volume, for the record: a first start with an empty cache fetches up to 30 default
 * entries × (their llms.txt candidates + the README fallback) — the same requests
 * `refresh` would make, spread two at a time; a start with a warm cache makes at most one
 * conditional request per stale entry, and none for fresh ones.
 */

export const AUTOWARM_CONCURRENCY = 2;
export const AUTOWARM_OPT_OUT_ENV = "VIBECTX_NO_AUTOWARM";
const DEFAULT_TTL_HOURS = 168;

export interface AutowarmSummary {
  /** Entries that needed warming when the run started. */
  attempted: number;
  cached: number;
  failed: string[];
  /** Entries never scheduled because the transport closed first (R4). */
  aborted: number;
}

const inFlight = new Set<string>();
let started = false;

/** Live state for list_libraries (`warming…`) and tests. */
export function autowarmStatus(): { started: boolean; inFlight: ReadonlySet<string> } {
  return { started, inFlight };
}

/** Test hook. */
export function resetAutowarm(): void {
  inFlight.clear();
  started = false;
}

/** Off when `VIBECTX_NO_AUTOWARM` is set to anything but "", "0" or "false". The server has
 *  no `--offline` mode (that flag belongs to `doctor` / `warm`), so nothing else is consulted;
 *  subcommands never reach this: server.ts alone calls it, on the server path (R5). */
export function shouldAutowarm(env: NodeJS.ProcessEnv): boolean {
  const flag = (env[AUTOWARM_OPT_OUT_ENV] ?? "").trim().toLowerCase();
  return flag === "" || flag === "0" || flag === "false";
}

/** Configured (non-resolved) entries with no fresh cached candidate. */
export function configuredEntriesNeedingWarm(registry: Registry): LibraryEntry[] {
  const out: LibraryEntry[] = [];
  for (const e of registry.entries.values()) {
    if (e.resolved) continue;
    const ttl = e.ttlHours ?? DEFAULT_TTL_HOURS;
    const fresh = e.urls.some((u) => {
      const hit = readCache(e.name, u, ttl);
      return hit !== undefined && !hit.stale;
    });
    if (!fresh) out.push(e);
  }
  return out;
}

/**
 * Warm every entry `configuredEntriesNeedingWarm` returns. Never throws and never rejects:
 * per-entry failures are collected, one summary line goes to `warn` (stderr by default)
 * when anything was attempted, and the summary is returned for tests.
 */
export async function startAutowarm(
  registry: Registry,
  opts: {
    concurrency?: number;
    warn?: (message: string) => void;
    /** Once aborted (the transport closed), no further entry is scheduled (R4). */
    signal?: AbortSignal;
    /** Test seam; defaults to getLibraryDoc. */
    fetchDoc?: (entry: LibraryEntry) => Promise<DocResult | undefined>;
  } = {},
): Promise<AutowarmSummary> {
  started = true;
  const warn = opts.warn ?? ((m: string) => process.stderr.write(m));
  const fetchDoc = opts.fetchDoc ?? ((entry: LibraryEntry) => getLibraryDoc(entry));
  const summary: AutowarmSummary = { attempted: 0, cached: 0, failed: [], aborted: 0 };
  const errors: string[] = [];
  try {
    const targets = configuredEntriesNeedingWarm(registry);
    summary.attempted = targets.length;
    await mapLimit(targets, opts.concurrency ?? AUTOWARM_CONCURRENCY, async (entry) => {
      if (opts.signal?.aborted) {
        summary.aborted += 1;
        return;
      }
      inFlight.add(entry.name);
      try {
        const doc = await fetchDoc(entry);
        // D-34 (PAR-659): the startup autowarm leaves a usable cross-library search index
        // behind, so the first `search` of a session is the fast path. Only the PRIMARY
        // document, and best effort — the index is derived, so a failure here changes nothing
        // about the warm (D-13).
        if (doc) indexCachedDocument(entry.name, doc.url, doc.content, undefined, warn);
        if (doc && !doc.staleNote) summary.cached += 1;
        else summary.failed.push(entry.name);
      } catch (e) {
        summary.failed.push(entry.name);
        errors.push(`${entry.name}: ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        inFlight.delete(entry.name);
      }
    });
  } catch (e) {
    errors.push(e instanceof Error ? e.message : String(e));
  } finally {
    inFlight.clear();
  }
  if (summary.attempted > 0 || errors.length > 0) {
    const failed = summary.failed.length > 0 ? `; not fetched: ${summary.failed.join(", ")}` : "";
    const aborted = summary.aborted > 0 ? `; ${summary.aborted} not started (transport closed)` : "";
    const detail = errors.length > 0 ? ` (${errors.join("; ")})` : "";
    try {
      warn(`vibectx: autowarm cached ${summary.cached}/${summary.attempted} configured libraries${failed}${aborted}${detail}\n`);
    } catch {
      // stderr closed: nothing left to report to
    }
  }
  return summary;
}
