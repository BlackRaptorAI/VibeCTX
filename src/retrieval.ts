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

/** Assemble top sections under a rough token budget (~4 chars per token). */
export function assemble(sections: Section[], maxTokens: number): string {
  const budget = maxTokens * 4;
  const parts: string[] = [];
  let used = 0;
  for (const s of sections) {
    const chunk = `## ${s.heading}\n\n${s.body}`;
    if (used + chunk.length > budget && parts.length > 0) break;
    parts.push(chunk.length > budget ? chunk.slice(0, budget) : chunk);
    used += chunk.length;
  }
  return parts.join("\n\n---\n\n");
}

/**
 * Heuristic: an llms.txt INDEX file is mostly a link list rather than prose.
 * Detect by markdown-link density so the caller can follow the best links.
 */
export function looksLikeIndex(markdown: string): boolean {
  const lines = markdown.split("\n").filter((l) => l.trim().length > 0);
  if (lines.length === 0) return false;
  const linkLines = lines.filter((l) => /\[[^\]]+\]\(https?:\/\/[^)]+\)/.test(l)).length;
  return linkLines / lines.length > 0.4 && markdown.length < 100_000;
}

/** Extract (title, url) markdown links, best-matched to the query first. */
export function rankLinks(
  markdown: string,
  query: string,
  limit: number,
): { title: string; url: string }[] {
  const terms = new Set(tokenize(query));
  const links: { title: string; url: string; score: number }[] = [];
  const re = /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(markdown)) !== null) {
    const title = m[1];
    const url = m[2];
    let score = 0;
    for (const t of tokenize(title + " " + url)) if (terms.has(t)) score += 1;
    links.push({ title, url, score });
  }
  return links
    .filter((l) => l.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ title, url }) => ({ title, url }));
}
