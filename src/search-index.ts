import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { newerSchemaVersion, writeAtomic } from "./atomic-store.js";
import { cacheRoot } from "./cache.js";
import { sanitizeRemoteUrl } from "./link-policy.js";
import { splitSections, HEADING_WEIGHT, type SplitSection } from "./retrieval.js";
import { MAX_TOKEN_CHARS, tokenize } from "./tokenize.js";

/**
 * PAR-659 — the inverted index behind cross-library `search`: `<cacheRoot>/index.json`,
 * shape `{ schemaVersion: 1, libraries: { "<name>": { url, fetchedAt, hash, lengths, postings } } }`.
 *
 * D-33 — THE INDEX IS A DERIVED CACHE, NEVER A SOURCE OF TRUTH. It exists only so `search`
 * does not re-tokenize 30 × llms-full.txt on every call; every byte it holds can be rebuilt
 * from the document cache, and nothing it holds is ever rendered.
 *
 * What that costs it, deliberately: a posting list carries NO TEXT. Per document it stores
 * the source URL, the document's `fetchedAt` and a content hash — the three D-33 asks for —
 * plus, per section, one number (its token length) and, per term, the sections it occurs in
 * with their weighted frequency. Heading paths and bodies are NOT stored. `search` re-reads
 * the cached document and re-splits it to render, so every character it prints comes from
 * the cache. That is stronger than the hash check alone: an attacker who plants an index
 * whose hash matches the cached document still cannot put one word into the output, because
 * there are no words in the file to put there. What a planted index CAN do is mis-rank —
 * claim a term occurs where it does not — which is a quality bug, not a disclosure.
 *
 * The hash check is what closes the remaining gap. On read, an entry is used only when
 * sha256(cached document)[0..16) equals its `hash` AND its `url` is the URL being served AND
 * its `lengths` has exactly as many entries as the document has sections. Anything else —
 * a stale entry, a hand-edited one, a planted one, a document refreshed behind the index's
 * back — is IGNORED and the document is re-tokenized on the spot (slower, correct), then
 * written back best effort. A write failure is a note, never a failed search (D-13).
 *
 * File discipline is the one every store in the cache directory shares (`atomic-store.ts`):
 * temp file + rename on write; validate-on-read against the rule each field actually has,
 * with a bad ENTRY dropped and a bad ENVELOPE rejecting the whole file; a NEWER
 * `schemaVersion` on disk is never overwritten (K2).
 *
 * D-34 — WHAT GETS INDEXED. Only libraries the current registry knows (curated, config or
 * resolved), and only their PRIMARY cached document — never a followed index page, which is
 * per-query and would make the file unbounded. One posting list per library.
 */

/** Bumped when a key is renamed, removed or changes meaning — and when the WEIGHTING changes,
 *  because a posting list scored under different field weights is silently wrong rather than
 *  unreadable. Version 1 is the first shipped shape (0.2.0). */
export const SEARCH_INDEX_SCHEMA_VERSION = 1;

const FILE_NAME = "index.json";

/** Largest document that is INDEXED. Above this, `search` tokenizes it at query time and says
 *  so for that library — the posting list for a document this size is itself megabytes, and the
 *  time to write it is time the search is not answering. ASSUMED: the largest primary document
 *  seen in the wild is Prisma's ~5 MB llms-full.txt (CITED: PAR-706 rework note), so 8 MiB
 *  leaves headroom while keeping the file bounded. */
export const MAX_INDEXED_DOC_BYTES = 8 * 1024 * 1024;

/** Largest index file that is READ. Above it the file is refused whole and every document is
 *  tokenized at query time. ASSUMED: 30 libraries × a posting list for an 8 MiB document is
 *  far under this, so anything larger is a mistake or a plant, and parsing it would cost more
 *  than rebuilding it. */
export const MAX_INDEX_FILE_BYTES = 64 * 1024 * 1024;

/** Documents one `search` call may tokenize (a cold cache, a refreshed library, a hash
 *  mismatch). Bounds the worst case: a first search over 30 uncached-index libraries does at
 *  most this much work, and the response says which libraries were left out. ASSUMED. */
export const MAX_LAZY_INDEX_DOCS = 40;

/** Numbers one document's posting lists may hold ([sectionId, tf] pairs, flattened). A
 *  document of pathological vocabulary — a few million distinct tokens — would otherwise
 *  produce a file larger than the document it describes. Refusing to index it costs one
 *  tokenization per search of that library and nothing else. ASSUMED. */
export const MAX_POSTING_NUMBERS_PER_DOC = 4_000_000;

/** Longest library name accepted as a key: npm's published package-name limit, as everywhere else. */
const MAX_NAME = 214;
/** Sections one indexed document may have. A 5 MB llms-full.txt runs to a few thousand. ASSUMED. */
const MAX_SECTIONS = 200_000;

/** One indexed document. `postings` maps a STEMMED token (`tokenize`'s output) to a flat
 *  `[sectionId, weightedTf, sectionId, weightedTf, …]` list in ascending section order. */
export interface IndexedDocument {
  /** The cached URL this posting list describes. Used to REFUSE the entry when `search` is
   *  serving another URL for the library; never rendered. */
  url: string;
  /** The cache meta's `fetchedAt` at index time. Provenance; never rendered. */
  fetchedAt: string;
  /** `documentHash` of the text that was indexed. The gate on every use. */
  hash: string;
  /** Per section, the token count `retrieval.ts` computes for BM25 length normalisation
   *  (heading + ancestor path + body, UNWEIGHTED — exactly what `weigh` sums). */
  lengths: number[];
  postings: Map<string, number[]>;
}

/** The index as loaded: what survived validation, plus the one line explaining a file that
 *  did not. `problem` is a note on the response, never an error — a search always works. */
export interface LoadedIndex {
  libraries: Map<string, IndexedDocument>;
  problem?: string;
}

export function searchIndexPath(): string {
  return join(cacheRoot(), FILE_NAME);
}

/** The content hash D-33 requires: the first 16 hex characters of SHA-256 over the document
 *  text. 64 bits of collision resistance for a local cache whose only writer is this tool —
 *  the hash detects a document that CHANGED, and shortens the file by 48 characters per entry. */
export function documentHash(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex").slice(0, 16);
}

/**
 * Build the posting list for one document. Weighting is `retrieval.ts`'s, term for term:
 * the section's own heading counts HEADING_WEIGHT times, its ancestor path and its body once,
 * and `length` is the UNWEIGHTED total — so a score computed from these postings equals the
 * score `rankSplitSections` computes for the same section (pinned by a test).
 *
 * undefined when the document is over MAX_INDEXED_DOC_BYTES or its vocabulary is over
 * MAX_POSTING_NUMBERS_PER_DOC: the caller then searches it by direct tokenization instead.
 */
export function indexDocument(url: string, text: string, fetchedAt: string, sections?: SplitSection[]): IndexedDocument | undefined {
  if (Buffer.byteLength(text, "utf8") > MAX_INDEXED_DOC_BYTES) return undefined;
  const split = sections ?? splitSections(text);
  if (split.length > MAX_SECTIONS) return undefined;
  const lengths: number[] = new Array(split.length).fill(0);
  const postings = new Map<string, number[]>();
  let numbers = 0;
  for (let sid = 0; sid < split.length; sid++) {
    const s = split[sid];
    const fields: { tokens: string[]; weight: number }[] = [
      { tokens: tokenize(s.heading), weight: HEADING_WEIGHT },
      { tokens: s.path.length ? tokenize(s.path.join(" ")) : [], weight: 1 },
      { tokens: tokenize(s.body), weight: 1 },
    ];
    // One tf map per section, then flushed into the posting lists: postings stay in ascending
    // section order without a sort, which is what makes the file byte-stable.
    const tf = new Map<string, number>();
    for (const { tokens, weight } of fields) {
      lengths[sid] += tokens.length;
      for (const token of tokens) tf.set(token, (tf.get(token) ?? 0) + weight);
    }
    for (const [token, count] of tf) {
      let posting = postings.get(token);
      if (posting === undefined) {
        posting = [];
        postings.set(token, posting);
      }
      posting.push(sid, count);
      numbers += 2;
      if (numbers > MAX_POSTING_NUMBERS_PER_DOC) return undefined;
    }
  }
  return { url, fetchedAt, hash: documentHash(text), lengths, postings };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** The same strict UTC instant `project-store.ts` accepts — `Date.parse` alone takes
 *  `2020-01-01 (‮evil)`, and a timestamp off a trust boundary is validated by SHAPE first. */
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const HASH_SHAPE = /^[0-9a-f]{16}$/;

function isPositiveInt(v: unknown, max: number): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= max;
}

/**
 * Validate one persisted document entry (D-33). Every field is re-checked against the rule
 * that field actually has; ANY failure drops the whole ENTRY, because a posting list that is
 * wrong in one place ranks wrongly everywhere:
 *
 *   url       an https URL that passes `sanitizeRemoteUrl`
 *   fetchedAt a strict ISO-8601 UTC instant
 *   hash      exactly 16 lowercase hex characters
 *   lengths   an array of ≤ MAX_SECTIONS non-negative integers
 *   postings  an object whose keys are ≤ MAX_TOKEN_CHARS characters and whose values are
 *             even-length arrays of non-negative integers, each section id inside `lengths`
 *             and each frequency ≥ 1
 *
 * `postings` is read through `Object.entries` into a Map, so a `__proto__` (or `constructor`)
 * key is data here and can never become a prototype write.
 */
export function toIndexedDocument(raw: unknown): IndexedDocument | undefined {
  if (!isRecord(raw)) return undefined;
  const url = sanitizeRemoteUrl(raw.url);
  if (url === undefined) return undefined;
  if (typeof raw.fetchedAt !== "string" || !ISO_INSTANT.test(raw.fetchedAt) || !Number.isFinite(Date.parse(raw.fetchedAt))) return undefined;
  if (typeof raw.hash !== "string" || !HASH_SHAPE.test(raw.hash)) return undefined;
  if (!Array.isArray(raw.lengths) || raw.lengths.length > MAX_SECTIONS) return undefined;
  const lengths: number[] = [];
  for (const n of raw.lengths) {
    if (!isPositiveInt(n, Number.MAX_SAFE_INTEGER)) return undefined;
    lengths.push(n);
  }
  if (!isRecord(raw.postings)) return undefined;
  const postings = new Map<string, number[]>();
  let numbers = 0;
  for (const [term, list] of Object.entries(raw.postings)) {
    if (term.length === 0 || term.length > MAX_TOKEN_CHARS) return undefined;
    if (!Array.isArray(list) || list.length === 0 || list.length % 2 !== 0) return undefined;
    numbers += list.length;
    if (numbers > MAX_POSTING_NUMBERS_PER_DOC) return undefined;
    for (let i = 0; i < list.length; i += 2) {
      if (!isPositiveInt(list[i], lengths.length - 1)) return undefined;
      if (!isPositiveInt(list[i + 1], Number.MAX_SAFE_INTEGER) || list[i + 1] === 0) return undefined;
    }
    postings.set(term, list as number[]);
  }
  return { url, fetchedAt: raw.fetchedAt, hash: raw.hash, lengths, postings };
}

/** A library key is accepted only in the folded form the registry stores (`resolveLibrary`
 *  compares lowercase, trimmed), so `React` can never sit beside `react` in this file. */
function validLibraryKey(key: string): boolean {
  return key.length > 0 && key.length <= MAX_NAME && key === key.trim().toLowerCase();
}

/**
 * Load the index. Never throws and never reports a failure as an error: a missing, oversized,
 * unparsable or foreign-version file simply loads as EMPTY with a `problem` line, and `search`
 * carries on by tokenizing what it needs.
 *
 * Envelope failures reject the whole file (K1): not an object, `schemaVersion` ≠ ours,
 * `libraries` not an object. Entry failures drop that library only.
 */
export function readIndex(): LoadedIndex {
  const path = searchIndexPath();
  const empty = new Map<string, IndexedDocument>();
  let size: number;
  try {
    size = statSync(path).size;
  } catch {
    return { libraries: empty }; // no file yet is the ordinary first-run state, not a problem
  }
  if (size > MAX_INDEX_FILE_BYTES) {
    return { libraries: empty, problem: `search index ignored: ${path} is ${size} bytes, over the ${MAX_INDEX_FILE_BYTES}-byte limit` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    return { libraries: empty, problem: `search index unreadable (${e instanceof Error ? e.message : String(e)}); rebuilt as needed` };
  }
  if (!isRecord(parsed) || !isRecord(parsed.libraries)) {
    return { libraries: empty, problem: "search index ignored: not a valid index file; rebuilt as needed" };
  }
  if (parsed.schemaVersion !== SEARCH_INDEX_SCHEMA_VERSION) {
    return {
      libraries: empty,
      problem: `search index ignored: schemaVersion ${String(parsed.schemaVersion)} (this version reads ${SEARCH_INDEX_SCHEMA_VERSION})`,
    };
  }
  const libraries = new Map<string, IndexedDocument>();
  let dropped = 0;
  for (const [key, value] of Object.entries(parsed.libraries)) {
    if (!validLibraryKey(key)) {
      dropped += 1;
      continue;
    }
    const doc = toIndexedDocument(value);
    if (doc === undefined) {
      dropped += 1;
      continue;
    }
    libraries.set(key, doc);
  }
  return dropped > 0 ? { libraries, problem: `search index: ${dropped} invalid entr${dropped === 1 ? "y" : "ies"} dropped; rebuilt as needed` } : { libraries };
}

/** Serialise one entry with its keys in the documented order and its terms sorted, so two
 *  writes of the same data produce identical bytes (a diffable, cache-friendly file). */
function toRecord(doc: IndexedDocument): Record<string, unknown> {
  const postings: Record<string, number[]> = {};
  for (const term of [...doc.postings.keys()].sort()) postings[term] = doc.postings.get(term)!;
  return { url: doc.url, fetchedAt: doc.fetchedAt, hash: doc.hash, lengths: doc.lengths, postings };
}

/**
 * Write the index atomically (temp file + rename). Returns false, with a note via `warn`, when
 * the file on disk belongs to a NEWER schema version — that file is not ours to rewrite (K2) —
 * and false when the write itself fails, because an unwritable cache must cost a slower search
 * and nothing else (D-13). Never throws.
 */
export function writeIndex(libraries: Map<string, IndexedDocument>, warn: (message: string) => void = (m) => process.stderr.write(m)): boolean {
  const path = searchIndexPath();
  try {
    mkdirSync(cacheRoot(), { recursive: true });
    const newer = newerSchemaVersion(path, SEARCH_INDEX_SCHEMA_VERSION);
    if (newer !== undefined) {
      warn(
        `vibectx: not writing the search index — ${path} has a newer schemaVersion ${newer} (this version writes ${SEARCH_INDEX_SCHEMA_VERSION}); upgrade vibectx or delete the file\n`,
      );
      return false;
    }
    const body: Record<string, unknown> = {};
    for (const name of [...libraries.keys()].sort()) body[name] = toRecord(libraries.get(name)!);
    writeAtomic(path, JSON.stringify({ schemaVersion: SEARCH_INDEX_SCHEMA_VERSION, libraries: body }, null, 0));
    return true;
  } catch (e) {
    warn(`vibectx: search index not written: ${e instanceof Error ? e.message : String(e)}\n`);
    return false;
  }
}

/**
 * D-34 — what `refresh` does to the index: DELETE the library's posting list and write the
 * file back. The next write (warm, autowarm, get_docs) or the next `search` rebuilds it from
 * whatever the cache then holds. Deleting rather than rebuilding here is deliberate: refresh
 * may fail, and an entry deleted is an entry that cannot be stale, while an entry rebuilt from
 * a document the refresh did not replace is work done twice.
 *
 * Returns true when the file was rewritten. Absent library, absent file, unwritable cache: false.
 */
export function invalidateIndex(library: string, warn: (message: string) => void = (m) => process.stderr.write(m)): boolean {
  const key = library.trim().toLowerCase();
  const { libraries } = readIndex();
  if (!libraries.delete(key)) return false;
  memo.delete(key);
  return writeIndex(libraries, warn);
}

/**
 * The in-process memo behind `indexCachedDocument`: library → the hash this process last
 * wrote. Without it, every get_docs call on a warm cache would parse the whole index file to
 * discover it had nothing to do. Reset by `resetSearchIndexMemo` (tests).
 */
const memo = new Map<string, string>();

/** Test hook — and the seam the server would use if it ever reloaded the cache root. */
export function resetSearchIndexMemo(): void {
  memo.clear();
}

/**
 * D-34 (a) — the incremental hook every writer of a PRIMARY cached document calls: `warm`,
 * the startup autowarm, `get_docs`. Cheap and silent when there is nothing to do (the memo
 * says this process already indexed this exact text), best effort when there is.
 *
 * Never throws and never blocks the caller's own result: a document too large to index, an
 * unwritable cache, a newer schema on disk — each leaves the caller's fetch exactly as
 * successful as it was and the index exactly as usable as it was (D-13).
 */
export function indexCachedDocument(
  library: string,
  url: string,
  text: string,
  fetchedAt?: string,
  warn: (message: string) => void = (m) => process.stderr.write(m),
): void {
  const key = library.trim().toLowerCase();
  if (!validLibraryKey(key)) return;
  try {
    const hash = documentHash(text);
    if (memo.get(key) === hash) return;
    const { libraries } = readIndex();
    const existing = libraries.get(key);
    if (existing && existing.hash === hash && existing.url === url) {
      memo.set(key, hash);
      return;
    }
    // `fetchedAt` is provenance only — it is never rendered and never gates anything (the HASH
    // does). A caller that has the cache meta to hand passes it; one that does not (get_docs,
    // which holds the document but not its meta) lets it default to the indexing instant rather
    // than paying a second full read of a multi-megabyte file for a field nobody reads.
    const doc = indexDocument(url, text, fetchedAt ?? new Date().toISOString());
    if (doc === undefined) return; // too large to index; search tokenizes it at query time (D-36)
    libraries.set(key, doc);
    if (writeIndex(libraries, warn)) memo.set(key, hash);
  } catch (e) {
    warn(`vibectx: search index not updated for "${key}": ${e instanceof Error ? e.message : String(e)}\n`);
  }
}
