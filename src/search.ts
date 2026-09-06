import { clipText } from "./config.js";
import { readCache, type CacheHit } from "./cache.js";
import { cleanText } from "./project-deps.js";
import { resolveLibrary, type LibraryEntry, type Registry } from "./registry.js";
import {
  bm25,
  idf,
  queryIndex,
  renderSection,
  splitSections,
  weighSections,
  type SplitSection,
  type Weighted,
} from "./retrieval.js";
import {
  documentHash,
  indexDocument,
  readIndex,
  shedInThisProcess,
  writeIndex,
  MAX_INDEX_FILE_BYTES,
  MAX_LAZY_INDEX_DOCS,
  type IndexedDocument,
} from "./search-index.js";

/**
 * PAR-659 — `search(query)`: one BM25 query across EVERY cached document, grouped by library.
 *
 * The problem it solves (Linear PAR-659): an agent that does not know which library owns a
 * concept — "how do I stream a response to the client" could be Next.js, the AI SDK or Hono —
 * has to guess a library name before it can ask. `get_docs` needs the name; `search` finds it.
 *
 * D-35 — the semantics, in full:
 *   - CACHE-ONLY, ALWAYS. No fetch, no resolution, no config change on this path, ever. A
 *     library with nothing in the cache is not searched; the response says so and points at
 *     `vibectx warm` / `get_docs`. (A test asserts it with a fetch spy: zero calls.)
 *   - The corpus is every section of every searched document, so IDF is GLOBAL — that is what
 *     lets a rare term pick the right library out of thirty rather than the wordiest one.
 *   - Ranking, field weighting and rendering are PAR-658's, unchanged and unforked: the same
 *     tokenizer, the same BM25 (k1 1.2, b 0.75), the same heading×3 weighting, the same
 *     `renderSection`. A section scored from the on-disk posting list gets the identical
 *     number it would get from `rankSplitSections`.
 *   - Libraries are ordered by their best section's score, sections within a library by score,
 *     ties by document order; library ties keep registry order.
 *   - `libraries?` filters by name or alias through `resolveLibrary`; an unknown name is
 *     REPORTED in the response, never an error — a filter typo must not lose the other hits.
 *   - Every group carries its `Source: <url>` line and a staleness marker when the cached
 *     copy is past TTL, and the response ends with "n of m libraries searched" plus the warm
 *     suggestion when fewer than all are cached.
 *
 * D-33 — nothing here trusts the index. Each document is read from the cache and hashed; the
 * posting list is used only when the hash and the URL both match, and every rendered character
 * is sliced out of the cached document at render time, never out of the index (which holds no
 * text at all — see search-index.ts). A mismatched, missing or corrupt index costs time, never
 * correctness: the document is tokenized on the spot and the file rewritten best effort.
 */

/**
 * Bumped when a `--json` key is renamed, removed or CHANGES MEANING. Adding a key is not a bump.
 *
 * WHERE a key is added is not part of the contract. A JSON object's keys are unordered by the
 * standard, so this promise is about the SET of keys and what each one means; the emitted order
 * is stable and pinned by a test only because a diffable file is worth having. Read keys by
 * NAME — `maxTokens` sits between `query` and `groups`, and `requested` between `configured`
 * and `searched`, precisely because a reader that cares about position was never supported.
 *
 * Version 1 is the first SHIPPED shape, and that is why it is still 1 after this round. Two
 * things happened to the shape in the branch that introduced `search` (PAR-659): `configured`
 * changed from the post-filter scope to the registry's size (N1), and `maxTokens` / `requested`
 * were added mid-object. A meaning change is exactly what a version bump is for — but `search`
 * and its `--json` had not been released when it happened (0.1.3 shipped without the tool), so
 * there was no consumer of version 1 to protect and nothing to distinguish a "version 1" from.
 * Bumping to 2 would have named a version nobody could ever have read, and left the first
 * released shape called 2 for no reason a reader could reconstruct. Recorded here rather than
 * left to be inferred: the NEXT change to `configured`'s meaning is a bump, unconditionally.
 */
export const SEARCH_SCHEMA_VERSION = 1;

/** The same default budget `get_docs` uses, for the same reason: ~4000 tokens is a large but
 *  not overwhelming slice of an agent's context. */
export const DEFAULT_SEARCH_BUDGET_TOKENS = 4000;

/**
 * D-41 — the longest query this path will look at. Everything downstream is linear in the
 * query's length, but "linear" is not "bounded": a 200,000-term query builds a 200,000-entry
 * term index and a 200,000-wide `tf` vector PER SECTION, which is quadratic in practice and
 * MEASURED to exhaust a 2 GB heap — and an out-of-memory in the MCP server kills every tool,
 * not one call. A real question is a handful of words; 1000 characters is far past any of
 * them and far short of the failure. ASSUMED.
 *
 * Enforced in three places on purpose: the MCP schema (a client sees a schema error), the CLI
 * (clipped with a note, because a shell can paste anything), and HERE — so no future caller
 * can reach the ranking path unbounded.
 */
export const MAX_QUERY_CHARS = 1000;

/**
 * Libraries whose sections may appear in one response. The point of `search` is to say WHICH
 * library owns a concept, and a reader cannot act on twenty candidates; capping also bounds
 * the render path, which re-reads and re-splits one cached document per rendered library.
 * ASSUMED.
 */
export const MAX_RENDERED_LIBRARIES = 8;

/** Longest library name and URL rendered into the response (D-30/D-36: every attacker-influenced
 *  string that reaches the output is cleaned and clipped). A name is bounded by npm's 214; a URL
 *  well under 300. ASSUMED. */
const MAX_LIBRARY_CHARS = 214;
const MAX_URL_CHARS = 300;
/** Libraries named individually in the "not cached" line before it switches to a count. ASSUMED. */
const MAX_NAMED_UNCACHED = 8;
/** Longest heading, and longest single ancestor heading, carried on a returned section.
 *  Matches `retrieval.ts`'s MAX_PATH_CHARS, which is what the RENDERED path is clipped to
 *  (S1: the outcome must obey the same rule the rendered text does, because `--json` hands the
 *  outcome to the agent directly). ASSUMED. */
const MAX_HEADING_CHARS = 200;
/** Longest note carried into the footer. Notes quote file paths and parser positions. ASSUMED. */
const MAX_NOTE_CHARS = 300;
/** D-43 — the shortest section excerpt this tool will call an answer: roughly thirty tokens,
 *  one sentence of prose. The ONE section D-35 guarantees is never clipped below it, even when
 *  the whole budget is smaller than that — a header over an empty body is an accounting entry,
 *  not a search result. ASSUMED. */
const MIN_SECTION_BODY_CHARS = 120;

/** How `formatSearchResults` joins what it renders. Named because `selectAcrossLibraries`
 *  prices them: a budget that ignores its own separators is not a budget. */
const BLOCK_JOIN = "\n\n";
const SECTION_JOIN = "\n\n---\n\n";

const DEFAULT_TTL_HOURS = 168;

/** One section returned for a library. `body` is sliced out of the CACHED DOCUMENT at render
 *  time — never out of the index. */
export interface SearchSection extends SplitSection {
  score: number;
  /** Position in `splitSections(cached document)`, which is what makes the body retrievable. */
  sectionIndex: number;
}

export interface SearchGroup {
  library: string;
  /** The cached URL that was searched. */
  url: string;
  /** The cached copy is past this library's TTL. */
  stale: boolean;
  /** Cache meta's `fetchedAt` for that document. */
  fetchedAt: string;
  /** Best section score in this library — what libraries are ordered by. */
  bestScore: number;
  /** Sections scoring above zero, best first (before the budget is applied). */
  matched: number;
  /** The sections actually returned, best first. */
  sections: SearchSection[];
  /** One phrase when this library was handled unusually (tokenized at query time, …). */
  note?: string;
}

export interface SearchOutcome {
  schemaVersion: typeof SEARCH_SCHEMA_VERSION;
  generatedAt: string;
  query: string;
  /** The budget this outcome was built under — `maxTokens`, defaulted. Carried because the
   *  budget is what bounds the rendering, and `formatSearchResults` must divide it exactly as
   *  `runSearch` did (D-39). */
  maxTokens: number;
  /** Groups with at least one returned section, best library first. */
  groups: SearchGroup[];
  /** Libraries the REGISTRY holds — always, filter or no filter. N1: a filtered search that
   *  reported "1 of 1 configured" told the reader nothing about the other twenty-nine. */
  configured: number;
  /** Of those, the ones in scope for this call: all of them, or the `libraries` filter's. */
  requested: number;
  /** Of those, the ones with a cached primary document — the ones actually searched. */
  searched: number;
  /** Their names, registry order. Named in the zero-match message so "nothing matched" is
   *  never mistaken for "nothing was looked at". */
  searchedLibraries: string[];
  /** Of those, how many had at least one matching section — BEFORE the budget was applied.
   *  `groups.length` can be smaller (a small budget, or MAX_RENDERED_LIBRARIES), and reporting
   *  the rendered count as the matched count would understate what the cache actually holds.
   *
   *  K1, stated exactly: for the libraries whose document was re-read to render (at most
   *  MAX_RENDERED_LIBRARIES), this counts only sections the DOCUMENT has, so a planted index
   *  claiming sections that do not exist cannot inflate it. For libraries past that cap the
   *  count is the index's, unverified — checking it would mean splitting every cached document
   *  on every search, which is the cost the index exists to avoid. */
  matchedLibraries: number;
  /** Library names in `libraries` that resolved to nothing. */
  unknown: string[];
  /** Names of in-scope libraries with nothing in the cache, registry order. */
  uncached: string[];
  /** Documents served from the on-disk posting list. */
  fromIndex: number;
  /** Documents tokenized during this call (an absent, stale or refused index entry). */
  tokenized: number;
  /** The index file was rewritten with what this call had to build. */
  indexWritten: boolean;
  /** Everything the reader must see: an unreadable index, a per-call limit reached, … */
  notes: string[];
}

export interface SearchOptions {
  query: string;
  /** Approximate response budget in tokens (default DEFAULT_SEARCH_BUDGET_TOKENS). */
  maxTokens?: number;
  /** Restrict to these libraries, by canonical name or alias. */
  libraries?: string[];
  /**
   * D-41 — the caller ALREADY clipped this query to MAX_QUERY_CHARS and wants it accounted for
   * here. The CLI clips at parse time (a shell can paste a megabyte, and the person at the
   * terminal is told on stderr straight away), which means `runSearch` receives a query that is
   * exactly at the bound and cannot tell it apart from one that was typed that long. A `--json`
   * consumer reads STDOUT and nothing else, so without this the payload described a search of a
   * query the caller never sent. The note is emitted here, once, in the wording every other
   * bounded-input note uses.
   */
  queryClipped?: boolean;
  /** Where index-write notes go (default: stderr). */
  warn?: (message: string) => void;
  /** Test seam: the wall clock for `generatedAt`. */
  now?: () => Date;
}

/** The first cached candidate for an entry: a FRESH one if any, else the first stale one —
 *  the same preference `warm` applies, so the two agree on which document is "the" one. */
function primaryCached(entry: LibraryEntry): { url: string; hit: CacheHit } | undefined {
  const ttl = entry.ttlHours ?? DEFAULT_TTL_HOURS;
  let stale: { url: string; hit: CacheHit } | undefined;
  for (const url of entry.urls) {
    let hit: CacheHit | undefined;
    try {
      hit = readCache(entry.name, url, ttl);
    } catch {
      continue; // an unreadable or corrupt cache entry is one candidate, not a failed search
    }
    if (!hit) continue;
    if (!hit.stale) return { url, hit };
    stale ??= { url, hit };
  }
  return stale;
}

/** The `Weighted` vector of every section of an INDEXED document, over the query terms —
 *  built from the posting lists, tokenizing nothing. The arithmetic downstream is identical
 *  to `weighSections`, because the numbers are the ones `weighSections` produced at index time. */
function weightedFromPostings(doc: IndexedDocument, terms: string[]): Weighted[] {
  const docs: Weighted[] = doc.lengths.map((length) => ({ tf: new Array<number>(terms.length).fill(0), length }));
  for (let t = 0; t < terms.length; t++) {
    const posting = doc.postings.get(terms[t]);
    if (posting === undefined) continue;
    for (let i = 0; i < posting.length; i += 2) docs[posting[i]].tf[t] = posting[i + 1];
  }
  return docs;
}

/** One library's contribution to the corpus, before scoring. */
interface Candidate {
  entry: LibraryEntry;
  url: string;
  fetchedAt: string;
  stale: boolean;
  weighted: Weighted[];
  note?: string;
}

/** IDF per query term over the WHOLE corpus — every section of every searched document. */
function corpusIdfs(candidates: Candidate[], termCount: number): { idfs: number[]; avgLength: number } {
  let sections = 0;
  let totalLength = 0;
  const matching = new Array<number>(termCount).fill(0);
  for (const c of candidates) {
    for (const w of c.weighted) {
      sections += 1;
      totalLength += w.length;
      for (let t = 0; t < termCount; t++) if (w.tf[t] > 0) matching[t] += 1;
    }
  }
  return {
    idfs: matching.map((n) => idf(sections, n)),
    avgLength: sections > 0 && totalLength > 0 ? totalLength / sections : 1,
  };
}

/**
 * D-35's budget rule, made concrete: sections are taken ROUND-ROBIN across libraries — the
 * best library's best section first (so "at least one section from the best-scoring library"
 * holds by construction), then the second library's best, and so on, wrapping until the budget
 * is spent. Depth-first would let one verbose library eat the whole response, which is exactly
 * the failure `search` exists to avoid: the question is *which library*, so breadth is the
 * answer's substance, not a nicety.
 *
 * D-39 — THE BUDGET IS PRICED ON WHAT IS ACTUALLY RETURNED. Every section reaching this
 * function already carries its real heading path and its real body, because they were attached
 * from the cached document BEFORE anything was priced. The earlier order — select, then fetch
 * bodies — priced empty strings: MEASURED, the rendered response ran 9.9× the default budget,
 * 97× at `maxTokens: 200` and 322× on the schema gate's fixture. A budget computed from
 * placeholders is not a budget, it is a decoration.
 *
 * What each section costs is exactly what `formatSearchResults` will emit for it: the rendered
 * block, plus its group's header the first time that group is opened, plus the separator that
 * joins it to what came before. Nothing is estimated.
 *
 * The first section is taken whatever it costs, because D-35 requires at least one section
 * from the best-scoring library; its body was already clipped to the budget, and
 * `formatSearchResults` clips the assembled text as well. That is the same order D-29 settled
 * for snippets: when the budget cannot hold even one block, THE CAP WINS.
 */
function selectAcrossLibraries(groups: SearchGroup[], budget: number): SearchGroup[] {
  const taken = groups.map(() => [] as SearchSection[]);
  const opened = groups.map(() => false);
  let used = 0;
  let any = false;
  for (let round = 0; ; round++) {
    let placed = false;
    for (let g = 0; g < groups.length; g++) {
      const section = groups[g].sections[round];
      if (section === undefined) continue;
      placed = true;
      const cost = opened[g]
        ? SECTION_JOIN.length + renderSection(section).length
        : (any ? BLOCK_JOIN.length : 0) + groupHeader(groups[g]).length + renderSection(section).length;
      if (any && used + cost > budget) continue;
      taken[g].push(section);
      opened[g] = true;
      used += cost;
      any = true;
    }
    if (!placed) break;
  }
  return groups.map((g, i) => ({ ...g, sections: taken[i] })).filter((g) => g.sections.length > 0);
}

/** The lines that open a library's block: its name, then the `Source:` line D-35 requires,
 *  then a staleness marker when the cached copy is past TTL. Both derived fields are cleaned
 *  and clipped (D-30/D-36). */
function groupHeader(group: SearchGroup): string {
  const lines = [`# ${clipText(group.library, MAX_LIBRARY_CHARS)}`, `Source: ${clipText(group.url, MAX_URL_CHARS)}`];
  if (group.stale) {
    lines.push(
      `> Stale: cached ${clipText(group.fetchedAt, 40)}, past this library's TTL — run \`vibectx refresh ${clipText(group.library, MAX_LIBRARY_CHARS)}\` for the current text.`,
    );
  }
  if (group.note) lines.push(`> ${clipText(group.note, 200)}`);
  return `${lines.join("\n")}\n\n`;
}

/** The one line that names the libraries the index has no room for — written when they are
 *  shed (D-40) and again, unchanged, on every later search that tokenizes them instead (D-42).
 *  Names are cleaned and clipped, and the list itself is bounded (D-30/D-36). */
function notIndexedNote(shed: string[]): string {
  const named = shed
    .slice(0, MAX_NAMED_UNCACHED)
    .map((n) => clipText(n, MAX_LIBRARY_CHARS))
    .join(", ");
  return (
    `${shed.length} librar${shed.length === 1 ? "y is" : "ies are"} not indexed (the index file would exceed its ` +
    `${MAX_INDEX_FILE_BYTES}-byte limit): ${named}${shed.length > MAX_NAMED_UNCACHED ? ` and ${shed.length - MAX_NAMED_UNCACHED} more` : ""}` +
    " — they are tokenized at query time on every search"
  );
}

/**
 * Run one cross-library search. Never throws: a library whose cache entry cannot be read is
 * skipped, an unreadable index is a note, an unwritable one is a note. Never touches the
 * network (D-35) and never mutates the registry.
 */
export function runSearch(registry: Registry, opts: SearchOptions): SearchOutcome {
  const now = (opts.now ?? (() => new Date()))();
  const notes: string[] = [];
  const unknown: string[] = [];

  // Scope. A filter name is resolved exactly as get_docs resolves one (canonical, alias, PEP
  // 503 form); an unknown one is reported and dropped, never fatal.
  let scope = [...registry.entries.values()];
  if (opts.libraries !== undefined) {
    const chosen = new Map<string, LibraryEntry>();
    for (const raw of opts.libraries) {
      const entry = resolveLibrary(registry, raw);
      if (!entry) unknown.push(clipText(raw, MAX_LIBRARY_CHARS));
      else chosen.set(entry.name, entry);
    }
    scope = scope.filter((e) => chosen.has(e.name));
  }

  // D-41: bound the query before anything is built out of it. A clip, not an error — the
  // first 1000 characters of a pasted essay are still a searchable question.
  const query = opts.query.length > MAX_QUERY_CHARS ? opts.query.slice(0, MAX_QUERY_CHARS) : opts.query;
  if (query.length < opts.query.length || opts.queryClipped) {
    notes.push(`the query was clipped to its first ${MAX_QUERY_CHARS} characters`);
  }

  const base: SearchOutcome = {
    schemaVersion: SEARCH_SCHEMA_VERSION,
    generatedAt: now.toISOString(),
    query: clipText(query, 200),
    maxTokens: opts.maxTokens ?? DEFAULT_SEARCH_BUDGET_TOKENS,
    groups: [],
    // N1: `configured` is the REGISTRY's size, whether or not a filter narrowed this call.
    // "Searched 1 of 1 configured library" after naming two libraries was true of the filter
    // and false of the reader's question. That is a CHANGE OF MEANING against the first cut of
    // this key, which is what `SEARCH_SCHEMA_VERSION` exists to signal — it stayed 1 only
    // because it happened in-branch, before `search --json` was released to anyone (the note on
    // the constant records why, and that the next such change is a bump).
    configured: registry.entries.size,
    requested: scope.length,
    searched: 0,
    searchedLibraries: [],
    matchedLibraries: 0,
    unknown,
    uncached: [],
    fromIndex: 0,
    tokenized: 0,
    indexWritten: false,
    notes,
  };

  const { terms, index: termIndex } = queryIndex(query);
  if (terms.length === 0) {
    notes.push("the query has no searchable terms");
    return base;
  }

  const loaded = readIndex();
  if (loaded.problem) notes.push(loaded.problem);

  const candidates: Candidate[] = [];
  const uncached: string[] = [];
  const rebuilt = new Map<string, IndexedDocument>();
  /** D-42: libraries a previous call in this process already shed — not rebuilt here, but named. */
  const shedAgain: string[] = [];
  let lazyBudget = MAX_LAZY_INDEX_DOCS;
  let deferred = 0;

  for (const entry of scope) {
    const cached = primaryCached(entry);
    if (!cached) {
      uncached.push(entry.name);
      continue;
    }
    const { url, hit } = cached;
    const stored = loaded.libraries.get(entry.name);
    const hash = documentHash(hit.content);
    // D-33: the posting list is used ONLY when it describes exactly this text at exactly this
    // URL. Anything else — refreshed behind the index's back, hand-edited, planted — is ignored.
    if (stored !== undefined && stored.url === url && stored.hash === hash) {
      candidates.push({ entry, url, fetchedAt: hit.meta.fetchedAt, stale: hit.stale, weighted: weightedFromPostings(stored, terms) });
      base.fromIndex += 1;
      continue;
    }
    if (lazyBudget <= 0) {
      deferred += 1;
      continue;
    }
    lazyBudget -= 1;
    base.tokenized += 1;
    const sections = splitSections(hit.content);
    // D-42: a posting list `writeIndex` already shed for this exact text is one it would shed
    // again — building it would cost a full tokenization and then rewrite the whole file for no
    // change. It is not built, so `rebuilt` stays empty and nothing is written; the library is
    // searched exactly as the too-large case is, and named in the notes below just the same.
    const shedAlready = shedInThisProcess(entry.name, hash);
    const built = shedAlready ? undefined : indexDocument(url, hit.content, hit.meta.fetchedAt, sections);
    if (built) {
      rebuilt.set(entry.name, built);
      candidates.push({ entry, url, fetchedAt: hit.meta.fetchedAt, stale: hit.stale, weighted: weightedFromPostings(built, terms) });
    } else {
      // D-36: too large (or too varied) to index, or D-42: shed to keep the file readable.
      // Searched anyway, by direct tokenization, and the response says so for that library so
      // nobody reads the slower answer as a cheaper one.
      if (shedAlready) shedAgain.push(entry.name);
      candidates.push({
        entry,
        url,
        fetchedAt: hit.meta.fetchedAt,
        stale: hit.stale,
        weighted: weighSections(sections, termIndex),
        note: shedAlready
          ? "not indexed (the index file would exceed its limit): tokenized at query time, so this library is slower to search"
          : "not indexed (document too large): tokenized at query time, so this library is slower to search",
      });
    }
  }

  base.searched = candidates.length;
  base.searchedLibraries = candidates.map((c) => c.entry.name);
  base.uncached = uncached;
  if (deferred > 0) {
    notes.push(
      `${deferred} librar${deferred === 1 ? "y was" : "ies were"} not searched: at most ${MAX_LAZY_INDEX_DOCS} documents are indexed per call — run the search again to take in the rest`,
    );
  }

  // D-33: whatever had to be rebuilt is written back best effort. A write failure is a note on
  // the response, never a failed search — the next call simply rebuilds it again (D-13).
  if (rebuilt.size > 0) {
    const merged = new Map(loaded.libraries);
    for (const [name, doc] of rebuilt) merged.set(name, doc);
    // D-40: the file would have been bigger than the one `readIndex` accepts, so the biggest
    // entries were left out rather than written into a file nothing could ever read again.
    // The reader is told, because "this library is slower every time" is not a detail.
    base.indexWritten = writeIndex(merged, opts.warn, (shed) => notes.push(notIndexedNote(shed)));
    if (!base.indexWritten) notes.push("search index not updated; this search was answered by tokenizing the documents");
  }
  // D-42: the ones shed on an EARLIER call are named by exactly the same line. Nothing was
  // rebuilt or rewritten for them this time, and that is the point — but a library that is
  // tokenized on every search must say so on every search, not only on the search that shed it.
  if (shedAgain.length > 0) notes.push(notIndexedNote(shedAgain));

  if (candidates.length === 0) return base;

  const { idfs, avgLength } = corpusIdfs(candidates, terms.length);
  const groups: SearchGroup[] = [];
  for (const c of candidates) {
    const sections: SearchSection[] = [];
    for (let sid = 0; sid < c.weighted.length; sid++) {
      const score = bm25(c.weighted[sid], idfs, avgLength);
      if (score > 0) sections.push({ heading: "", body: "", level: 0, path: [], score, sectionIndex: sid });
    }
    if (sections.length === 0) continue;
    sections.sort((a, b) => b.score - a.score || a.sectionIndex - b.sectionIndex);
    const group: SearchGroup = {
      library: c.entry.name,
      url: c.url,
      stale: c.stale,
      fetchedAt: c.fetchedAt,
      bestScore: sections[0].score,
      matched: sections.length,
      sections,
    };
    if (c.note) group.note = c.note;
    groups.push(group);
  }
  // Libraries by their best section; registry order breaks ties (the candidate list is in it).
  const order = new Map(candidates.map((c, i) => [c.entry.name, i]));
  groups.sort((a, b) => b.bestScore - a.bestScore || order.get(a.library)! - order.get(b.library)!);
  base.matchedLibraries = groups.length;
  if (groups.length > MAX_RENDERED_LIBRARIES) {
    notes.push(`${groups.length} libraries matched; the ${MAX_RENDERED_LIBRARIES} best are shown`);
    groups.length = MAX_RENDERED_LIBRARIES;
  }

  // Bodies come from the CACHED DOCUMENT, re-read and re-split here — never from the index,
  // which holds no text. D-39: this happens BEFORE the budget is spent, so what the budget
  // prices is what the reader will actually be handed.
  //
  // Three things this must survive. A section id the document no longer has is DROPPED rather
  // than guessed at: between the scan above and this read, another process (a `refresh`, a
  // get_docs fetch) may have replaced the document — or a planted index may be claiming
  // sections that never existed (K1) — and the honest answer is fewer sections, never a
  // section chosen by position out of a document nobody scored. The cache is re-read through
  // the CANDIDATE's own entry, not by looking the library name up in the registry map — a
  // registry whose map KEY differs from its entry's `name` (which the S2 cases in
  // refresh.test.ts construct) would otherwise silently render no sections at all. And every
  // heading and ancestor heading is cleaned and clipped HERE (S1), so `--json` obeys the same
  // D-30 rule the rendered text does; bodies are clipped but never cleaned, because the body
  // IS the document and laundering a control character inside a code sample would corrupt the
  // answer the agent asked for.
  const budget = sectionBudgetChars(base);
  const byLibrary = new Map(candidates.map((c) => [c.entry.name, c]));
  const withBodies: SearchGroup[] = [];
  for (const group of groups) {
    const candidate = byLibrary.get(group.library);
    let split: SplitSection[] = [];
    try {
      const hit = candidate ? readCache(candidate.entry.name, group.url, candidate.entry.ttlHours ?? DEFAULT_TTL_HOURS) : undefined;
      if (hit) split = splitSections(hit.content);
    } catch {
      split = [];
    }
    const sections = group.sections
      .filter((s) => split[s.sectionIndex] !== undefined)
      .map((s) => {
        const real = split[s.sectionIndex];
        const section = {
          ...s,
          heading: clipText(real.heading, MAX_HEADING_CHARS),
          path: real.path.map((p) => clipText(p, MAX_HEADING_CHARS)),
          level: real.level,
          body: real.body,
        };
        // D-43: the footer's reservation may leave `budget` at or near zero. The section that
        // D-35 guarantees is clipped to what the budget holds ONCE THE FOOTER IS GIVEN UP for
        // it — never to nothing — so the allowance here is the larger of the two.
        const allow = Math.max(budget, guaranteeBodyChars(base, group, section));
        return { ...section, body: real.body.length > allow ? real.body.slice(0, allow) : real.body };
      });
    // K1: `matched` is now a count of sections the DOCUMENT has, not of postings the index
    // claims. MEASURED before this: a hash-matching index carrying 50 `lengths` on a
    // two-section document reported `matched: 50`.
    if (sections.length > 0) withBodies.push({ ...group, matched: sections.length, sections });
  }
  base.matchedLibraries -= groups.length - withBodies.length;
  base.groups = selectAcrossLibraries(withBodies, budget);
  return base;
}

/** 0 when the search returned at least one section, 1 when it did not. */
export function searchExitCode(outcome: SearchOutcome): 0 | 1 {
  return outcome.groups.length > 0 ? 0 : 1;
}

/**
 * The closing accounting D-35 asks for: how many libraries were searched out of how many are
 * configured, and — when fewer than all are cached — how to cache the rest.
 *
 * `shown` is a parameter rather than `outcome.groups.length` so the budget arithmetic can price
 * this block BEFORE selection has decided what is shown; see `footerReserve`.
 *
 * N1: with a filter in play the line reports against BOTH numbers. "Searched 1 of 1 configured
 * library" was arithmetic about the filter, not information about the cache.
 */
function footerLines(outcome: SearchOutcome, shown: number): string[] {
  const filtered = outcome.requested !== outcome.configured;
  const scope = filtered
    ? `Searched ${outcome.searched} of ${outcome.requested} requested librar${outcome.requested === 1 ? "y" : "ies"} (${outcome.configured} configured)`
    : `Searched ${outcome.searched} of ${outcome.configured} configured librar${outcome.configured === 1 ? "y" : "ies"}`;
  const lines = [
    scope +
      `${outcome.matchedLibraries > 0 ? `; ${outcome.matchedLibraries} matched` : ""}` +
      `${shown > 0 && shown < outcome.matchedLibraries ? `, ${shown} shown within the budget` : ""}.`,
  ];
  if (outcome.uncached.length > 0) {
    const named =
      outcome.uncached.length <= MAX_NAMED_UNCACHED
        ? outcome.uncached.map((n) => clipText(n, MAX_LIBRARY_CHARS)).join(", ")
        : `${outcome.uncached.slice(0, MAX_NAMED_UNCACHED).map((n) => clipText(n, MAX_LIBRARY_CHARS)).join(", ")} and ${outcome.uncached.length - MAX_NAMED_UNCACHED} more`;
    lines.push(
      `Not cached, so not searched: ${named}. Run \`vibectx warm\` in your project to cache your dependencies' docs, or call get_docs for one library.`,
    );
  }
  for (const name of outcome.unknown) lines.push(`Unknown library "${name}" in the filter — ignored.`);
  for (const note of outcome.notes) lines.push(`note: ${clipText(note, MAX_NOTE_CHARS)}`);
  return lines;
}

/**
 * D-39 — how much of the budget the SECTIONS get. The accounting footer is not optional (it is
 * what stops "nothing matched" being read as "nothing was looked at"), so it is reserved out of
 * the budget rather than added on top of it, and the same reservation is computed in
 * `runSearch` and in `formatSearchResults` from the same fields — otherwise the two would
 * divide the budget differently and the guarantee would be a coincidence.
 *
 * `matchedLibraries - 1` is the largest `shown` the footer's optional clause can ever carry
 * (the clause only appears when `shown < matchedLibraries`), so this is an upper bound, never
 * an under-estimate.
 */
function footerReserve(outcome: SearchOutcome): number {
  return footerLines(outcome, Math.max(1, outcome.matchedLibraries - 1)).join("\n").length + BLOCK_JOIN.length;
}

/** D-43 rung 3 — the accounting compressed to one line, for a budget that can hold the answer
 *  and a line of accounting but not both in full. It keeps the two numbers that stop "nothing
 *  matched" being read as "nothing was looked at" (how many libraries were searched, of how
 *  many configured) and says outright that the rest was dropped, so a reader is never told a
 *  short footer is the whole story. */
function shortFooterLine(outcome: SearchOutcome, shown: number): string {
  return (
    `Searched ${outcome.searched}/${outcome.configured} libraries; ${outcome.matchedLibraries} matched, ` +
    `${shown} shown. (Accounting shortened to fit the budget.)`
  );
}

/** The one line a response that could not fit its own irreducible minimum owes the reader. */
function overshootNote(length: number, budgetChars: number): string {
  return (
    `> Over budget: the smallest answer search can give (one library, one section) is ${length} characters, ` +
    `against the ${budgetChars} this budget allows.`
  );
}

/** The characters the rendered library blocks may occupy with the accounting footer paid for
 *  in full. Zero when the footer alone fills the budget — which is not the end of the story:
 *  `guaranteeBodyChars` and the ladder in `formatSearchResults` are what keep a zero here from
 *  emptying the response (D-43). */
function sectionBudgetChars(outcome: SearchOutcome): number {
  return Math.max(0, outcome.maxTokens * 4 - footerReserve(outcome));
}

/**
 * D-43 — the body allowance of the ONE section D-35 guarantees, priced as if the footer had
 * already been given up for it: the whole budget, less this library's header (its name and the
 * `Source:` line, both mandatory) and the section's own heading. Never below
 * MIN_SECTION_BODY_CHARS, which is the point at which the budget stops being able to buy an
 * answer at all and the response overshoots and says so.
 */
function guaranteeBodyChars(outcome: SearchOutcome, group: SearchGroup, section: SplitSection): number {
  const fixed = groupHeader(group).length + renderSection({ ...section, body: "" }).length;
  return Math.max(MIN_SECTION_BODY_CHARS, outcome.maxTokens * 4 - fixed);
}

/** The irreducible minimum D-43 protects: the best library's header, its `Source:` line, the
 *  best section's heading and MIN_SECTION_BODY_CHARS of that section's body. Every rendered
 *  response starts with exactly these characters, so a response clipped to any length at or
 *  above this one still contains them. */
function irreducibleMinimum(outcome: SearchOutcome): string {
  const best = outcome.groups[0];
  const section = best.sections[0];
  if (section === undefined) return groupHeader(best);
  return groupHeader(best) + renderSection({ ...section, body: section.body.slice(0, MIN_SECTION_BODY_CHARS) });
}

/** As many whole library blocks as `room` holds, best library first and always at least one —
 *  clipped to `room` when even the first block is larger than it, which is the only way a
 *  block is ever cut mid-way. Returns what was emitted AND how many libraries it holds, so the
 *  footer's `n shown` counts blocks in the text rather than blocks that were selected. */
function packBlocks(blocks: string[], room: number): { text: string; shown: number } {
  let text = "";
  let shown = 0;
  for (const block of blocks) {
    const next = shown === 0 ? block : `${text}${BLOCK_JOIN}${block}`;
    if (next.length > room) break;
    text = next;
    shown += 1;
  }
  return shown === 0 ? { text: blocks[0].slice(0, room), shown: 1 } : { text, shown };
}

/** Human-readable result; the same text the CLI prints and the MCP `search` tool returns. */
export function formatSearchResults(outcome: SearchOutcome): string {
  const blocks = outcome.groups.map(
    (group) => groupHeader(group) + group.sections.map((s) => renderSection(s)).join(SECTION_JOIN),
  );
  if (blocks.length === 0) {
    // D-35: an honest zero-match message NAMES what was searched, so "nothing matched" can
    // never be read as "nothing was looked at".
    const named = outcome.searchedLibraries.map((n) => clipText(n, MAX_LIBRARY_CHARS));
    const where =
      named.length === 0
        ? "no library has a cached document to search"
        : `searched ${named.length} cached librar${named.length === 1 ? "y" : "ies"}: ${
            named.length <= MAX_NAMED_UNCACHED ? named.join(", ") : `${named.slice(0, MAX_NAMED_UNCACHED).join(", ")} and ${named.length - MAX_NAMED_UNCACHED} more`
          }`;
    return [
      `No sections matched "${outcome.query}" — ${where}.`,
      "Try broader terms, or get_docs for one library.",
      "",
      ...footerLines(outcome, 0),
    ].join("\n");
  }
  // D-43 — THE ANSWER OUTRANKS THE ACCOUNTING. `selectAcrossLibraries` priced every block
  // exactly against a budget that had the footer reserved out of it; what is left here is the
  // case where that reservation and the guarantee cannot both be paid. The order of sacrifice
  // is: other libraries (already dropped by selection), then the section body (already clipped
  // by `guaranteeBodyChars`), then the footer — shortened to one line, then dropped — and never
  // the section. MEASURED before this: at `--max-tokens 20` the footer was reserved first, the
  // sections floored at zero and the body sliced to nothing, so 249 characters of pure
  // accounting came back claiming "1 shown within the budget" over no library block at all.
  const total = outcome.maxTokens * 4;
  const minimum = irreducibleMinimum(outcome);
  const rungs: { reserve: number; tail: (shown: number) => string }[] = [
    { reserve: footerReserve(outcome), tail: (shown) => BLOCK_JOIN + footerLines(outcome, shown).join("\n") },
    {
      reserve: BLOCK_JOIN.length + shortFooterLine(outcome, Math.max(1, outcome.matchedLibraries - 1)).length,
      tail: (shown) => BLOCK_JOIN + shortFooterLine(outcome, shown),
    },
    { reserve: 0, tail: () => "" },
  ];
  for (const rung of rungs) {
    // Each reserve is an UPPER bound on what its tail can render (both footers are longest at
    // the largest `shown` they can ever carry), so a rung that fits here fits when rendered:
    // `text` + `tail` never exceeds the budget.
    const room = total - rung.reserve;
    if (room < minimum.length) continue;
    const { text, shown } = packBlocks(blocks, room);
    return text + rung.tail(shown);
  }
  // Not even the minimum fits. It goes out anyway — that is what D-35 guarantees and what D-43
  // ranks above the accounting — and the response says, in one line, that it is over budget.
  return `${minimum}${BLOCK_JOIN}${overshootNote(minimum.length, total)}`;
}

/** The MCP `search` tool body: the formatted results for `query`. Never throws. */
export function searchToolText(registry: Registry, opts: SearchOptions): string {
  try {
    return formatSearchResults(runSearch(registry, opts));
  } catch (e) {
    return cleanText(`search failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}
