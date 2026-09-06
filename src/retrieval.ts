export interface Section {
  heading: string;
  body: string;
  score: number;
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1);
}

/** Split a markdown document on headings. Text before the first heading becomes a "(intro)" section. */
export function splitSections(markdown: string): { heading: string; body: string }[] {
  const lines = markdown.split("\n");
  const sections: { heading: string; body: string[] }[] = [];
  let current = { heading: "(intro)", body: [] as string[] };
  for (const line of lines) {
    const m = /^(#{1,6})\s+(.+)/.exec(line);
    if (m) {
      if (current.body.some((l) => l.trim()) || current.heading !== "(intro)") {
        sections.push(current);
      }
      current = { heading: m[2].trim(), body: [] };
    } else {
      current.body.push(line);
    }
  }
  sections.push(current);
  return sections
    .map((s) => ({ heading: s.heading, body: s.body.join("\n").trim() }))
    .filter((s) => s.body.length > 0 || s.heading !== "(intro)");
}

/**
 * Score sections by keyword overlap with the query. Heading hits weigh 3x body
 * hits; body hits are normalized by log(section length) so long sections don't
 * win on bulk alone.
 */
export function rankSections(markdown: string, query: string): Section[] {
  const terms = [...new Set(tokenize(query))];
  if (terms.length === 0) return [];
  return splitSections(markdown)
    .map((s) => {
      const headingTokens = new Set(tokenize(s.heading));
      const bodyTokens = tokenize(s.body);
      const bodyCounts = new Map<string, number>();
      for (const t of bodyTokens) bodyCounts.set(t, (bodyCounts.get(t) ?? 0) + 1);
      let score = 0;
      for (const term of terms) {
        if (headingTokens.has(term)) score += 3;
        const c = bodyCounts.get(term) ?? 0;
        if (c > 0) score += 1 + Math.min(c, 5) / (1 + Math.log(1 + bodyTokens.length));
      }
      return { heading: s.heading, body: s.body, score };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score);
}

function renderSection(s: Section): string {
  return `## ${s.heading}\n\n${s.body}`;
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
