import { lstatSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

/**
 * PAR-652 item 7a — a total size cap on the cache, with least-recently-used eviction.
 *
 * Nothing bounded the cache before this. `vibectx warm` on a large project caches one
 * primary document per dependency, each up to the 25 MiB `PRIMARY_DOC_MAX_BYTES`, and
 * nothing ever removed one — a cache is not supposed to be able to fill a laptop.
 *
 * WHAT COUNTS AND WHAT IS EVICTED ARE DIFFERENT SETS, deliberately.
 *   Counted toward the cap: every regular file under the cache root, including
 *   `index.json`, `resolved.json` and `projects/*.json` — because the cap is a promise
 *   about disk, and a promise that ignores half the directory is not one.
 *   Evictable: only library DOCUMENTS — a `<slug>.md` with its `<slug>.meta.json`, inside a
 *   per-library directory. Those are re-fetchable from the network; a resolution record or
 *   a project record is not, and the index rebuilds itself from documents anyway.
 *
 * RECENCY is `meta.fetchedAt`, which `touchCache` already refreshes on every 304
 * revalidation — so a document that is still being used keeps moving to the back of the
 * queue even when its bytes never change. A meta file that cannot be read or parsed sorts
 * as oldest: it is the same judgement `readCache` makes (an unparsable `fetchedAt` reads as
 * stale, N-6), and a document whose meta is corrupt is exactly the one to drop first.
 *
 * KNOWN LIMIT — two vibectx processes on one cache. `writtenThisRun` is per-process, so
 * this process can evict a document the other one fetched seconds ago. That is a wasted
 * refetch, not a correctness problem: the other process already returned the content it
 * fetched, and every reader re-reads from disk and treats a missing file as a miss
 * (`readCache` requires both files to exist; `search` skips a group whose body it cannot
 * re-read). Sharing the protected set would need a file two processes agree on — the
 * mutable-shared-state bug class this cache is built to avoid — so it is not shared.
 *
 * SYMLINKS are never followed and never removed — `lstat` decides what is a directory and
 * what is a regular file, the same rule the temp sweep in `atomic-store.ts` applies. The
 * cache directory is a trust boundary: a link planted in it must not be able to aim a
 * delete anywhere else.
 */

/** Default cap. ASSUMED: 512 MB is roughly 20 documents at the 25 MiB primary cap, which is
 *  a warmed medium project, and small enough that no one notices it on a modern disk.
 *  There is no measurement behind the number — challenge it. */
export const DEFAULT_CACHE_MAX_MB = 512;

/**
 * How many bytes may be written between full sweeps. ASSUMED.
 *
 * The alternative designs were: stat the whole cache on every write (a warm run writes
 * hundreds of documents, so that is hundreds of full directory walks — the "stat the world"
 * the brief rules out), or keep a running total in a sidecar file (a second piece of
 * mutable state that two concurrent vibectx processes would have to agree on, which is the
 * bug class `atomic-store.ts` exists to avoid).
 *
 * What is here instead: accumulate the bytes THIS process has written and sweep when they
 * exceed this threshold — plus once on the first write, so a process that starts against an
 * already-oversized cache fixes it immediately rather than after 16 MiB of new work. The
 * cost of a sweep is one `lstat` per file; amortised over 16 MiB of writes it is noise
 * beside the writes themselves. The price is the overshoot: between sweeps the cache may
 * exceed the cap by up to this threshold plus one document.
 */
export const EVICTION_SWEEP_BYTES = 16 * 1024 * 1024;

/** A file inside the cache that is never evicted, whatever its age. */
const NEVER_EVICT_DIRS = new Set(["projects"]);

export interface EvictedDocument {
  library: string;
  /** The document file's name inside the library directory (the URL slug), not the URL. */
  document: string;
  bytes: number;
  /** `meta.fetchedAt`, or `undefined` when the meta was missing or unreadable. */
  fetchedAt?: string;
}

export interface EvictionSummary {
  sweptAt: string;
  capBytes: number;
  totalBytesBefore: number;
  totalBytesAfter: number;
  evicted: EvictedDocument[];
  /** Documents that were older than the ones evicted but were written by THIS run. */
  protectedFromEviction: number;
  /** True when the cache is still over the cap after evicting everything it was allowed to. */
  stillOverCap: boolean;
}

interface CandidateDocument {
  library: string;
  document: string;
  contentPath: string;
  metaPath: string;
  bytes: number;
  fetchedAtMs: number;
  fetchedAt?: string;
}

let writtenThisRun = new Set<string>();
let bytesSinceSweep = 0;
let sweeps = 0;
let sweptEver = false;
let lastSummary: EvictionSummary | undefined;

/** Test seam and per-process reset: forget which documents this run wrote and what it swept. */
export function resetCacheEvictionState(): void {
  writtenThisRun = new Set<string>();
  bytesSinceSweep = 0;
  sweeps = 0;
  sweptEver = false;
  lastSummary = undefined;
}

/** How much sweeping this process has actually done — for tests and for the debug log. */
export function cacheEvictionStats(): { sweeps: number; bytesSinceSweep: number } {
  return { sweeps, bytesSinceSweep };
}

/** The last sweep that evicted something, or `undefined` if none has. `doctor` reports it. */
export function lastEvictionSummary(): EvictionSummary | undefined {
  return lastSummary;
}

/**
 * The cap in bytes, or `undefined` when it is switched off. `VIBECTX_CACHE_MAX_MB` accepts
 * a fractional value (a cap in the kilobytes is only useful to a test, but refusing it
 * would be arbitrary); `0` turns the cap off entirely; anything unparsable or negative
 * falls back to the default rather than silently disabling the cap — a typo must not be a
 * way to lose the bound.
 */
export function cacheCapBytes(env: NodeJS.ProcessEnv = process.env): number | undefined {
  const raw = env.VIBECTX_CACHE_MAX_MB;
  if (raw === undefined || raw.trim().length === 0) return DEFAULT_CACHE_MAX_MB * 1024 * 1024;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_CACHE_MAX_MB * 1024 * 1024;
  if (parsed === 0) return undefined;
  return Math.floor(parsed * 1024 * 1024);
}

/** A REGULAR file's size, or `undefined` for a symlink, a directory or anything unreadable. */
function regularFileBytes(path: string): number | undefined {
  try {
    const st = lstatSync(path);
    return st.isFile() ? st.size : undefined;
  } catch {
    return undefined;
  }
}

function isRealDirectory(path: string): boolean {
  try {
    return lstatSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** Walk the cache root one level deep: its own files, then each real library directory. */
function scanCache(root: string): { totalBytes: number; candidates: CandidateDocument[] } {
  let totalBytes = 0;
  const candidates: CandidateDocument[] = [];
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return { totalBytes: 0, candidates: [] };
  }
  for (const name of names) {
    const path = join(root, name);
    const fileBytes = regularFileBytes(path);
    if (fileBytes !== undefined) {
      totalBytes += fileBytes; // index.json, resolved.json: counted, never evicted
      continue;
    }
    if (!isRealDirectory(path)) continue; // a symlinked child is not descended
    let children: string[];
    try {
      children = readdirSync(path);
    } catch {
      continue;
    }
    const sizes = new Map<string, number>();
    for (const child of children) {
      const bytes = regularFileBytes(join(path, child));
      if (bytes === undefined) continue;
      totalBytes += bytes;
      sizes.set(child, bytes);
    }
    if (NEVER_EVICT_DIRS.has(name)) continue;
    for (const [child, bytes] of sizes) {
      if (!child.endsWith(".md")) continue;
      const slug = child.slice(0, -".md".length);
      const metaName = `${slug}.meta.json`;
      const metaBytes = sizes.get(metaName);
      if (metaBytes === undefined) continue; // a document without its meta is not one readCache serves
      const metaPath = join(path, metaName);
      let fetchedAt: string | undefined;
      let fetchedAtMs = 0; // unreadable or unparsable meta sorts as oldest, as readCache treats it
      try {
        const parsed = JSON.parse(readFileSync(metaPath, "utf8")) as { fetchedAt?: unknown };
        if (typeof parsed.fetchedAt === "string") {
          const ms = new Date(parsed.fetchedAt).getTime();
          if (Number.isFinite(ms)) {
            fetchedAt = parsed.fetchedAt;
            fetchedAtMs = ms;
          }
        }
      } catch {
        /* oldest */
      }
      candidates.push({
        library: name,
        document: slug,
        contentPath: join(path, child),
        metaPath,
        bytes: bytes + metaBytes,
        fetchedAtMs,
        fetchedAt,
      });
    }
  }
  return { totalBytes, candidates };
}

/**
 * Bring the cache under the cap, evicting least-recently-fetched documents first and never
 * one this run wrote. Returns the summary, or `undefined` when the cap is off.
 *
 * Never throws: a cache that cannot be swept must not fail the write that triggered it.
 */
export function enforceCacheSizeCap(
  root: string,
  opts: { env?: NodeJS.ProcessEnv; warn?: (message: string) => void } = {},
): EvictionSummary | undefined {
  const env = opts.env ?? process.env;
  const capBytes = cacheCapBytes(env);
  sweeps += 1;
  bytesSinceSweep = 0;
  sweptEver = true;
  if (capBytes === undefined) return undefined;
  const warn = opts.warn ?? ((m: string) => process.stderr.write(`${m}\n`));
  const { totalBytes, candidates } = scanCache(root);
  const summary: EvictionSummary = {
    sweptAt: new Date().toISOString(),
    capBytes,
    totalBytesBefore: totalBytes,
    totalBytesAfter: totalBytes,
    evicted: [],
    protectedFromEviction: 0,
    stillOverCap: false,
  };
  if (totalBytes <= capBytes) return summary;

  candidates.sort((a, b) => a.fetchedAtMs - b.fetchedAtMs || a.contentPath.localeCompare(b.contentPath));
  let running = totalBytes;
  for (const doc of candidates) {
    if (running <= capBytes) break;
    if (writtenThisRun.has(doc.contentPath)) {
      // Evicting what this run just fetched would make a warm loop fetch, evict, and fetch
      // again for ever, and would make `get_docs` able to return a document it had already
      // deleted. The cap gives way instead; `stillOverCap` says so.
      summary.protectedFromEviction += 1;
      continue;
    }
    try {
      rmSync(doc.contentPath, { force: true });
      rmSync(doc.metaPath, { force: true });
    } catch {
      continue; // another process may have removed it first; it is still counted as present
    }
    running -= doc.bytes;
    summary.evicted.push({ library: doc.library, document: doc.document, bytes: doc.bytes, fetchedAt: doc.fetchedAt });
  }
  summary.totalBytesAfter = running;
  summary.stillOverCap = running > capBytes;
  if (summary.evicted.length > 0) {
    lastSummary = summary;
    warn(
      `vibectx: cache over ${formatBytes(capBytes)} — evicted ${summary.evicted.length} least-recently-fetched ` +
        `document${summary.evicted.length === 1 ? "" : "s"} (${formatBytes(totalBytes - running)} freed, ` +
        `now ${formatBytes(running)}).`,
    );
  }
  if (summary.stillOverCap) {
    warn(
      `vibectx: cache is still ${formatBytes(running)} against a ${formatBytes(capBytes)} cap — ` +
        `${summary.protectedFromEviction} document(s) fetched by this run are not evictable. Raise VIBECTX_CACHE_MAX_MB.`,
    );
  }
  return summary;
}

/** Human-sized bytes for the one stderr line and the doctor row. */
export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

/**
 * Called by `writeCache` after both renames land: record the document as this run's, and
 * sweep only when enough has been written since the last sweep (or this is the first write
 * of the process). Best effort — never throws into the write path.
 */
export function noteCacheWrite(root: string, contentPath: string, bytes: number): EvictionSummary | undefined {
  writtenThisRun.add(contentPath);
  bytesSinceSweep += bytes;
  if (sweptEver && bytesSinceSweep < EVICTION_SWEEP_BYTES) return undefined;
  try {
    return enforceCacheSizeCap(root);
  } catch {
    return undefined;
  }
}
