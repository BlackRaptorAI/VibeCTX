import { clipText } from "./config.js";
import { tokenize } from "./tokenize.js";

/** A heading and the text under it, with where it sits in the heading tree (D-25). */
export interface SplitSection {
  heading: string;
  body: string;
  /** Markdown heading level, 1–6; 0 for the synthetic "(intro)" section. */
  level: number;
  /** Ancestor headings, nearest last. `[]` for a top-level heading and for "(intro)". */
  path: string[];
}

export interface Section extends SplitSection {
  score: number;
}

/** An opening or closing code-fence line (D-25/D-26). */
interface Fence {
  /** "`" or "~". */
  char: string;
  /** How many fence characters; a closer needs at least as many as its opener. */
  count: number;
  /** Everything after the fence run — the info string on an opener. */
  info: string;
}

/** Longest indentation a fence may carry before it is indented code, per CommonMark. */
const MAX_FENCE_INDENT = 3;
const MIN_FENCE_CHARS = 3;

/**
 * Classify one line as a code fence, with a hand-written scanner: at most
 * MAX_FENCE_INDENT spaces, then a run of at least MIN_FENCE_CHARS backticks or
 * tildes. A backtick fence's info string may not contain a backtick (CommonMark),
 * which is what keeps an inline `` `code` `` span from opening a block.
 */
function fenceInfo(line: string): Fence | undefined {
  let i = 0;
  while (i < line.length && line[i] === " ") i += 1;
  if (i > MAX_FENCE_INDENT) return undefined;
  const char = line[i];
  if (char !== "`" && char !== "~") return undefined;
  let count = 0;
  while (i + count < line.length && line[i + count] === char) count += 1;
  if (count < MIN_FENCE_CHARS) return undefined;
  const info = line.slice(i + count);
  if (char === "`" && info.includes("`")) return undefined;
  return { char, count, info };
}

function closesFence(line: string, open: Fence): boolean {
  const f = fenceInfo(line);
  return f !== undefined && f.char === open.char && f.count >= open.count && f.info.trim() === "";
}

const MAX_HEADING_LEVEL = 6;

/**
 * Split a markdown document on headings. Text before the first heading becomes an
 * "(intro)" section.
 *
 * D-25: every section carries its `level` and the `path` of ancestor headings, so an
 * H4 no longer loses the H2/H3 it lives under — both for ranking (ancestors are a
 * weak field, see rankSections) and for rendering. A `#` line inside a fenced code
 * block is code, not a heading; the fence scanner above is what tells them apart.
 */
export function splitSections(markdown: string): SplitSection[] {
  const lines = markdown.split("\n");
  const sections: { heading: string; body: string[]; level: number; path: string[] }[] = [];
  let current = { heading: "(intro)", body: [] as string[], level: 0, path: [] as string[] };
  // stack[level] = the heading currently open at that level; holes are allowed
  // (an H1 followed by an H3 has nothing at level 2).
  const stack: (string | undefined)[] = new Array(MAX_HEADING_LEVEL + 1).fill(undefined);
  let open: Fence | undefined;
  for (const line of lines) {
    if (open) {
      if (closesFence(line, open)) open = undefined;
      current.body.push(line);
      continue;
    }
    const fence = fenceInfo(line);
    if (fence) {
      open = fence;
      current.body.push(line);
      continue;
    }
    const m = /^(#{1,6})\s+(.+)/.exec(line);
    if (m) {
      if (current.body.some((l) => l.trim()) || current.heading !== "(intro)") {
        sections.push(current);
      }
      const level = m[1].length;
      const heading = m[2].trim();
      const path = stack.slice(1, level).filter((h): h is string => h !== undefined);
      stack[level] = heading;
      // A shallower heading resets everything below it: "## B" after "### A" is a
      // sibling of A's parent, so A must not stay in the path.
      for (let deeper = level + 1; deeper <= MAX_HEADING_LEVEL; deeper++) stack[deeper] = undefined;
      current = { heading, body: [], level, path };
    } else {
      current.body.push(line);
    }
  }
  sections.push(current);
  return sections
    .map((s) => ({ heading: s.heading, body: s.body.join("\n").trim(), level: s.level, path: s.path }))
    .filter((s) => s.body.length > 0 || s.heading !== "(intro)");
}

/** D-24: Okapi BM25 term-frequency saturation. */
const BM25_K1 = 1.2;
/** D-24: Okapi BM25 length normalization. */
const BM25_B = 0.75;
/** D-24 (BM25F-lite): a term in the section's own heading counts this many times.
 *  Ancestor-path headings and body text count once. */
const HEADING_WEIGHT = 3;

/** ln(1 + (N − n + 0.5) / (n + 0.5)) — the standard non-negative BM25 IDF. */
function idf(docCount: number, matching: number): number {
  return Math.log(1 + (docCount - matching + 0.5) / (matching + 0.5));
}

/** Per-document term frequencies for the query terms only, plus the document length.
 *  Counting only the query's terms is what keeps a 5 MB corpus linear and allocation-free
 *  beyond the token arrays themselves. */
interface Weighted {
  tf: number[];
  length: number;
}

function weigh(fields: { tokens: string[]; weight: number }[], index: Map<string, number>): Weighted {
  const tf = new Array<number>(index.size).fill(0);
  let length = 0;
  for (const { tokens, weight } of fields) {
    length += tokens.length;
    for (const token of tokens) {
      const at = index.get(token);
      if (at !== undefined) tf[at] += weight;
    }
  }
  return { tf, length };
}

/** BM25 score of one weighted document against every query term. */
function bm25(doc: Weighted, idfs: number[], avgLength: number): number {
  let score = 0;
  for (let t = 0; t < idfs.length; t++) {
    const tf = doc.tf[t];
    if (tf === 0) continue;
    const norm = BM25_K1 * (1 - BM25_B + (BM25_B * doc.length) / avgLength);
    score += idfs[t] * ((tf * (BM25_K1 + 1)) / (tf + norm));
  }
  return score;
}

/** IDF per query term over a set of weighted documents. */
function idfsOver(docs: Weighted[], termCount: number): number[] {
  const idfs = new Array<number>(termCount).fill(0);
  for (let t = 0; t < termCount; t++) {
    let matching = 0;
    for (const d of docs) if (d.tf[t] > 0) matching += 1;
    idfs[t] = idf(docs.length, matching);
  }
  return idfs;
}

function averageLength(docs: Weighted[]): number {
  if (docs.length === 0) return 1;
  const total = docs.reduce((n, d) => n + d.length, 0);
  return total > 0 ? total / docs.length : 1;
}

/** Query terms, deduplicated, with the index tokenized documents are counted against. */
function queryIndex(query: string): { terms: string[]; index: Map<string, number> } {
  const terms = [...new Set(tokenize(query))];
  return { terms, index: new Map(terms.map((t, i) => [t, i])) };
}

/** Weigh each split section: own heading x HEADING_WEIGHT, ancestor path x1, body x1. */
function weighSections(sections: SplitSection[], index: Map<string, number>): Weighted[] {
  return sections.map((s) =>
    weigh(
      [
        { tokens: tokenize(s.heading), weight: HEADING_WEIGHT },
        { tokens: s.path.length ? tokenize(s.path.join(" ")) : [], weight: 1 },
        { tokens: tokenize(s.body), weight: 1 },
      ],
      index,
    ),
  );
}

/**
 * D-24: rank a document's sections against the query with Okapi BM25 (k1 = 1.2,
 * b = 0.75), the corpus being exactly the sections of this call's document — primary
 * plus any followed pages. Field weighting is BM25F-lite: a term in the section's own
 * heading counts three times, one in an ancestor heading or the body once.
 *
 * Why BM25 and not the old overlap count: IDF is what lets a rare term ("upsert")
 * outrank a common one ("query") instead of both scoring 1, and length normalization
 * is what stops a long section winning on bulk. Sections scoring 0 are dropped, so
 * the "No sections matched" path is unchanged. Ties keep document order.
 */
export function rankSections(markdown: string, query: string): Section[] {
  return rankSplitSections(splitSections(markdown), query);
}

/**
 * `rankSections` over sections that were already split — the form get_docs uses, because
 * D-31 splits the primary document and every followed page SEPARATELY and concatenates
 * the section lists. Splitting once over concatenated text let an unclosed fence in one
 * document swallow the next one whole.
 */
export function rankSplitSections(sections: SplitSection[], query: string): Section[] {
  const { terms, index } = queryIndex(query);
  if (terms.length === 0) return [];
  const docs = weighSections(sections, index);
  const idfs = idfsOver(docs, terms.length);
  const avg = averageLength(docs);
  return sections
    .map((s, i) => ({ ...s, score: bm25(docs[i], idfs, avg), order: i }))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || a.order - b.order)
    .map(({ order: _order, ...s }) => s);
}

/* ------------------------------------------------------------------ *
 * D-30 — what gets sanitised, and what deliberately does not.
 *
 * Every field VibeCTX composes a line out of — the heading path, a snippet's language
 * and its context line — is a DERIVED field: the document supplies the text, we supply
 * the markdown around it. Those get the same treatment `list_libraries` rows and `warm`
 * rows already get: control, C1, bidi and zero-width characters stripped, then clipped.
 *
 * Section BODIES are NOT cleaned. The body IS the document: a control character inside a
 * code sample is part of the sample, and laundering it would corrupt the answer the
 * agent asked for. The asymmetry is deliberate — sanitise what we compose, quote what we
 * were given — and both halves are pinned by tests.
 * ------------------------------------------------------------------ */

/** D-30 field caps: long enough for a real heading path, short enough that no derived
 *  field can dominate a response. ASSUMED, matching MAX_LIBRARY_FIELD_CHARS. */
const MAX_PATH_CHARS = 200;
const MAX_CONTEXT_CHARS = 200;
const MAX_LANG_CHARS = 20;

/**
 * A derived field, made safe to place in rendered markdown: control, C1, bidi and
 * zero-width characters removed and the text clipped (`clipText`, the same helper the
 * library table uses — stripping controls also flattens it to one line), then any run of
 * three or more backticks or tildes collapsed to two, which is inert in every position.
 * That last step is what stops a heading, a context line or an info string from opening
 * or closing a fenced block of its own. Both regexes are one character class with one
 * quantifier: linear on any input.
 */
function renderField(text: string, max: number): string {
  return clipText(text, max).replace(/`{3,}/g, "``").replace(/~{3,}/g, "~~");
}

/**
 * The language, made safe to sit ON a fence opener. `renderField` is not enough here:
 * every other derived field is rendered on a line of its own, but the language is
 * CONCATENATED onto the opener, so a backtick it kept would lengthen the opener's own
 * fence run past the closer's — a tilde-fenced block whose info string is ```` ```js ````
 * rendered a 5-backtick opener against a 3-backtick closer, and the rest of the response
 * was swallowed. Fence characters are therefore removed outright rather than collapsed:
 * a language identifier never contains a backtick or a tilde, so nothing real is lost.
 * Stripped BEFORE clipping, so the clip cannot re-expose one at the cut.
 */
function renderLang(lang: string): string {
  return renderField(lang.replace(/[`~]/g, ""), MAX_LANG_CHARS);
}

/** The heading line D-25 renders: ancestors joined with " > ", the section's own
 *  heading last. Top-level sections and "(intro)" render as they always did. */
export function headingPath(s: { heading: string; path: string[] }): string {
  return s.path.length > 0 ? `${s.path.join(" > ")} > ${s.heading}` : s.heading;
}

/** The heading path as it is rendered: derived, so cleaned and clipped (D-30). */
function renderedPath(s: { heading: string; path: string[] }): string {
  return renderField(headingPath(s), MAX_PATH_CHARS);
}

export function renderSection(s: SplitSection): string {
  return `## ${renderedPath(s)}\n\n${s.body}`;
}

/** The leading run of `sections` that fits a rough token budget (~4 chars per
 *  token); always at least one section. This is exactly what `assemble` renders,
 *  exposed so callers can reason about which sections were returned. */
export function selectSections(sections: Section[], maxTokens: number): Section[] {
  const budget = maxTokens * 4;
  const chosen: Section[] = [];
  let used = 0;
  for (const s of sections) {
    const chunk = renderSection(s);
    if (used + chunk.length > budget && chosen.length > 0) break;
    chosen.push(s);
    used += chunk.length;
  }
  return chosen;
}

/** Assemble top sections under a rough token budget (~4 chars per token). */
export function assemble(sections: Section[], maxTokens: number): string {
  const budget = maxTokens * 4;
  return selectSections(sections, maxTokens)
    .map((s) => {
      const chunk = renderSection(s);
      return chunk.length > budget ? chunk.slice(0, budget) : chunk;
    })
    .join("\n\n---\n\n");
}

/* ------------------------------------------------------------------ *
 * D-26 — snippets mode: the same document, cut at code blocks instead
 * of at headings, for the question that is really "show me the call".
 * ------------------------------------------------------------------ */

/** One fenced code block, with enough around it to be pasted and understood. */
export interface Snippet {
  /** The info string's first word, lowercased; "" when the fence carried none. */
  lang: string;
  /** The block's contents, fences excluded, indentation as written. */
  code: string;
  /** The heading of the section the block sits in. */
  heading: string;
  /** That section's ancestor headings, nearest last (D-25). */
  path: string[];
  /** One line of orientation: the nearest prose line above the fence in the same
   *  section, or the section heading when the fence opens the section. */
  context: string;
  /** Index of the containing section in `splitSections(markdown)`. */
  sectionIndex: number;
  score: number;
}

/** A block shorter than this many non-empty lines is noise (a bare command, a lone
 *  identifier) unless the query names it exactly — see `hitsExactly`. */
const MIN_SNIPPET_LINES = 2;
/** D-26: the code block's own BM25 contribution counts double against its section's. */
const SNIPPET_CODE_WEIGHT = 2;

function nonEmptyLineCount(code: string): number {
  let n = 0;
  for (const line of code.split("\n")) if (line.trim().length > 0) n += 1;
  return n;
}

/** First word of a fence info string, lowercased; "" when there is none. */
function fenceLang(info: string): string {
  const trimmed = info.trim();
  if (trimmed.length === 0) return "";
  let end = 0;
  while (end < trimmed.length && !/\s/.test(trimmed[end])) end += 1;
  return trimmed.slice(0, end).toLowerCase();
}

/**
 * Every fenced code block in the document, in document order, each tied to the
 * section it lives in (D-26). Scores are 0 here; `rankSnippets` fills them in.
 * An unclosed fence runs to the end of its section, which is what a truncated
 * document does in practice.
 */
export function extractSnippets(markdown: string): Snippet[] {
  return extractSnippetsFrom(splitSections(markdown));
}

/** `extractSnippets` over sections that were already split (D-31). `sectionIndex` refers
 *  to the list passed in. */
export function extractSnippetsFrom(sections: SplitSection[]): Snippet[] {
  const snippets: Snippet[] = [];
  for (let sectionIndex = 0; sectionIndex < sections.length; sectionIndex++) {
    const section = sections[sectionIndex];
    const lines = section.body.split("\n");
    let proseFrom = 0; // first line not already consumed by an earlier block
    let i = 0;
    while (i < lines.length) {
      const open = fenceInfo(lines[i]);
      if (!open) {
        i += 1;
        continue;
      }
      let end = i + 1;
      while (end < lines.length && !closesFence(lines[end], open)) end += 1;
      // Nearest non-empty line above the fence that is neither code nor a fence.
      let context = section.heading;
      for (let back = i - 1; back >= proseFrom; back--) {
        if (lines[back].trim().length === 0) continue;
        if (fenceInfo(lines[back]) === undefined) context = lines[back].trim();
        break;
      }
      snippets.push({
        lang: fenceLang(open.info),
        code: lines.slice(i + 1, end).join("\n"),
        heading: section.heading,
        path: section.path,
        context,
        sectionIndex,
        score: 0,
      });
      i = end + 1;
      proseFrom = i;
    }
  }
  return snippets;
}

/** Does the block name every query term outright? The escape hatch that keeps a
 *  one-liner like `await prisma.user.upsert({ … })` from being dropped as too short. */
function hitsExactly(code: string, terms: string[]): boolean {
  if (terms.length === 0) return false;
  const present = new Set(tokenize(code));
  return terms.every((t) => present.has(t));
}

/**
 * D-26: rank the document's code blocks. A snippet's score is its containing
 * section's BM25 score plus twice a BM25 over the code blocks themselves — so the
 * section supplies the topic and the code supplies the proof. Blocks under
 * MIN_SNIPPET_LINES non-empty lines are dropped unless the query hits them exactly.
 * Blocks scoring 0 are dropped, mirroring `rankSections`; ties keep document order.
 */
export function rankSnippets(markdown: string, query: string): Snippet[] {
  return rankSplitSnippets(splitSections(markdown), query);
}

/** `rankSnippets` over sections that were already split (D-31). */
export function rankSplitSnippets(sections: SplitSection[], query: string): Snippet[] {
  const { terms, index } = queryIndex(query);
  if (terms.length === 0) return [];
  const sectionDocs = weighSections(sections, index);
  const sectionIdfs = idfsOver(sectionDocs, terms.length);
  const sectionAvg = averageLength(sectionDocs);
  const sectionScores = sectionDocs.map((d) => bm25(d, sectionIdfs, sectionAvg));

  const candidates = extractSnippetsFrom(sections).filter(
    (s) => nonEmptyLineCount(s.code) >= MIN_SNIPPET_LINES || hitsExactly(s.code, terms),
  );
  if (candidates.length === 0) return [];
  const codeDocs = candidates.map((s) => weigh([{ tokens: tokenize(s.code), weight: 1 }], index));
  const codeIdfs = idfsOver(codeDocs, terms.length);
  const codeAvg = averageLength(codeDocs);

  return candidates
    .map((s, i) => ({
      ...s,
      score: sectionScores[s.sectionIndex] + SNIPPET_CODE_WEIGHT * bm25(codeDocs[i], codeIdfs, codeAvg),
      order: i,
    }))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || a.order - b.order)
    .map(({ order: _order, ...s }) => s);
}

/** The longest run of backticks anywhere in `code`. One linear pass. */
function longestBacktickRun(code: string): number {
  let longest = 0;
  let run = 0;
  for (let i = 0; i < code.length; i++) {
    if (code.charCodeAt(i) === 96) {
      run += 1;
      if (run > longest) longest = run;
    } else {
      run = 0;
    }
  }
  return longest;
}

/**
 * D-28: the fence for this block — a backtick run one longer than the longest run in
 * EITHER of the two things the block renders, the code and the language that rides on
 * the opener, never fewer than three. Backticks rather than tildes so a `~~~` inside the
 * code is inert too. Taking the language into account is belt-and-braces: `renderLang`
 * already strips fence characters, so its run is 0 today — but the width is computed
 * over everything the block renders, so neither route can widen the opener alone.
 *
 * This is what makes the rendered block well-formed markdown for ANY code content, which
 * is a test (`snippet rendering is inescapable and bounded`), not a claim in a comment.
 */
function fenceFor(code: string, lang: string): string {
  const run = Math.max(longestBacktickRun(code), longestBacktickRun(lang));
  return "`".repeat(Math.max(MIN_FENCE_CHARS, run + 1));
}

function renderSnippet(s: Snippet): string {
  const lang = renderLang(s.lang);
  const fence = fenceFor(s.code, lang);
  const context = renderField(s.context, MAX_CONTEXT_CHARS);
  return `### ${renderedPath(s)}\n${context}\n\n${fence}${lang}\n${s.code}\n${fence}`;
}

/** The leading run of `snippets` that fits the token budget; always at least one,
 *  truncated body and all, so a matching snippet is never silently swallowed. */
export function selectSnippets(snippets: Snippet[], maxTokens: number): Snippet[] {
  const budget = maxTokens * 4;
  const chosen: Snippet[] = [];
  let used = 0;
  for (const s of snippets) {
    const chunk = renderSnippet(s);
    if (used + chunk.length > budget && chosen.length > 0) break;
    chosen.push(s);
    used += chunk.length;
  }
  return chosen;
}

/**
 * D-29: one assembled snippet, never longer than `budget` characters. Two steps, both
 * needed:
 *
 *   1. cut the CODE so the block still closes its own fence — the readable truncation,
 *      and the one that fires for an ordinary long example (D-28: the truncated path
 *      uses the same fence width, because the fence is recomputed from the cut code,
 *      which can only need a shorter run);
 *   2. clip whatever comes out to `budget`, exactly as `assemble` does — the guarantee.
 *
 * Step 2 is what makes the cap hold when the OVERHEAD alone is over budget: a snippet
 * whose heading path, context line and language are all attacker-supplied is bounded at
 * 200 + 200 + 20 characters by D-30, but `maxTokens` can be smaller than that. No field
 * escapes the cap; a caller asking for 100 tokens gets at most 400 characters.
 */
function clipSnippet(s: Snippet, budget: number): string {
  let chunk = renderSnippet(s);
  if (chunk.length > budget) {
    // Two passes at most: bounding the code bounds the fence, and a shorter fence only
    // frees more room, so the second pass cannot need a third.
    let code = s.code.slice(0, Math.max(0, budget));
    chunk = renderSnippet({ ...s, code });
    if (chunk.length > budget) {
      code = code.slice(0, Math.max(0, budget - (chunk.length - code.length)));
      chunk = renderSnippet({ ...s, code });
    }
  }
  return chunk.length > budget ? chunk.slice(0, budget) : chunk;
}

/** Assemble top snippets under a rough token budget (~4 chars per token). An
 *  over-budget block is cut inside the fence and the fence closed, and the result is
 *  clipped to the budget whatever the derived fields hold (D-28, D-29). */
export function assembleSnippets(snippets: Snippet[], maxTokens: number): string {
  const budget = maxTokens * 4;
  return selectSnippets(snippets, maxTokens)
    .map((s) => clipSnippet(s, budget))
    .join("\n\n");
}

/** Non-image markdown link `[title](href)`; href may be absolute or relative.
 *  Both classes exclude the delimiters `[`, `]`, `(`, `)` (and the href class
 *  whitespace) so a run of unmatched openers — `[[[[` or `[a]([a]([a](` — cannot
 *  be re-scanned from every position (quadratic backtracking on hostile input).
 *  Cost: an href containing `(`, `[` or `]` is skipped; it was truncated before. */
const LINK_RE = /(?<!!)\[([^\[\]]+)\]\(([^()\[\]\s]+)\)/g;

/** A followable href: anything except a same-document anchor. */
function isFollowableHref(href: string): boolean {
  return !href.startsWith("#");
}

/** How many non-empty lines looksLikeIndex samples. Size-independent on purpose:
 *  fastify's llms.txt is >100 KB and was rejected by a byte cap (PAR-706). */
const INDEX_SAMPLE_LINES = 200;
const INDEX_LINK_DENSITY = 0.4;

/**
 * Heuristic: an llms.txt INDEX file is mostly a link list rather than prose.
 * Detect by markdown-link density over the first INDEX_SAMPLE_LINES non-empty
 * lines so the caller can follow the best links. Relative links count; anchor-only
 * links (`#section`, as in a README table of contents) do not.
 */
export function looksLikeIndex(markdown: string): boolean {
  const lines = markdown
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .slice(0, INDEX_SAMPLE_LINES);
  if (lines.length === 0) return false;
  let linkLines = 0;
  for (const line of lines) {
    for (const m of line.matchAll(LINK_RE)) {
      if (isFollowableHref(m[2])) {
        linkLines += 1;
        break;
      }
    }
  }
  return linkLines / lines.length > INDEX_LINK_DENSITY;
}

/**
 * Extract every followable (title, url) link in document order, resolving
 * relative hrefs against `sourceUrl`. Keeps http(s) targets only and the first
 * occurrence of each resolved URL.
 */
export function extractLinks(
  markdown: string,
  sourceUrl: string,
): { title: string; url: string }[] {
  const seen = new Set<string>();
  const links: { title: string; url: string }[] = [];
  for (const m of markdown.matchAll(LINK_RE)) {
    const title = m[1];
    const href = m[2];
    if (!isFollowableHref(href)) continue;
    let url: string;
    try {
      const resolved = new URL(href, sourceUrl);
      if (resolved.protocol !== "https:" && resolved.protocol !== "http:") continue;
      url = resolved.href;
    } catch {
      continue;
    }
    if (seen.has(url)) continue;
    seen.add(url);
    links.push({ title, url });
  }
  return links;
}

/** Links best-matched to the query first (ties keep document order), up to `limit`.
 *  Only links sharing at least one token with the query are returned. */
export function rankLinks(
  markdown: string,
  query: string,
  sourceUrl: string,
  limit: number,
): { title: string; url: string }[] {
  const terms = new Set(tokenize(query));
  return extractLinks(markdown, sourceUrl)
    .map((link, order) => {
      let score = 0;
      for (const t of tokenize(link.title + " " + link.url)) if (terms.has(t)) score += 1;
      return { ...link, score, order };
    })
    .filter((l) => l.score > 0)
    .sort((a, b) => b.score - a.score || a.order - b.order)
    .slice(0, limit)
    .map(({ title, url }) => ({ title, url }));
}

/** An index with more links than this gets the larger follow budget. */
const LARGE_INDEX_LINKS = 200;

/** How many index links get_docs follows for a topic: 3 by default, 5 when the
 *  index is large (a big index spreads a topic across more pages). */
export function followLimit(linkCount: number): number {
  return linkCount > LARGE_INDEX_LINKS ? 5 : 3;
}

/** Stop following index links once this much linked content has been pulled in. */
export const MAX_FOLLOWED_BYTES = 2_000_000;
