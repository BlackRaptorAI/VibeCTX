import type { LibraryEntry } from "./registry.js";
import {
  getLibraryDoc,
  fetchLinkedPage,
  isAllowedLink,
  LINKED_PAGE_MAX_BYTES,
} from "./fetcher.js";
import {
  rankSections,
  assemble,
  looksLikeIndex,
  rankLinks,
  extractLinks,
  followLimit,
  MAX_FOLLOWED_BYTES,
} from "./retrieval.js";

export interface GetDocsArgs {
  topic?: string;
  /** Approximate response budget in tokens (default 4000). */
  maxTokens?: number;
}

const DEFAULT_BUDGET_TOKENS = 4000;

/**
 * The get_docs tool body, kept out of index.ts so it can be exercised without a
 * transport. Returns the text the tool responds with.
 */
export async function getDocs(entry: LibraryEntry, args: GetDocsArgs): Promise<string> {
  const { topic } = args;
  const doc = await getLibraryDoc(entry);
  if (!doc) {
    return `Could not fetch docs for "${entry.name}" — all candidate URLs unreachable and nothing cached. Candidates tried:\n${entry.urls.join("\n")}`;
  }
  const budget = args.maxTokens ?? DEFAULT_BUDGET_TOKENS;
  const prefix = doc.staleNote ? `> ${doc.staleNote}\n\n` : "";

  if (!topic) {
    const toc = doc.content
      .split("\n")
      .filter((l) => /^#{1,3}\s/.test(l))
      .slice(0, 60)
      .join("\n");
    const head = doc.content.slice(0, budget * 4);
    return `${prefix}Source: ${doc.url}\n\n${toc ? `Table of contents:\n${toc}\n\n---\n\n` : ""}${head}`;
  }

  // Topic given: if the doc is an index of links, pull the best-matching pages too.
  let corpus = doc.content;
  const followed: string[] = [];
  const failed: string[] = [];
  const tooLarge: string[] = [];
  let skippedOutsideOrigin = 0;
  if (looksLikeIndex(doc.content)) {
    const limit = followLimit(extractLinks(doc.content, doc.url).length);
    // Rank every matching link, drop guard-refused ones (counted for the note),
    // THEN take the budget — so cross-origin links never crowd out followable ones.
    // fetchLinkedPage re-checks the guard; this is the visible layer, that one is the safety layer.
    const candidates = rankLinks(doc.content, topic, doc.url, Number.POSITIVE_INFINITY);
    const allowed = candidates.filter((link) => {
      const ok = isAllowedLink(link.url, doc.url);
      if (!ok) skippedOutsideOrigin += 1;
      return ok;
    });
    let followedBytes = 0;
    for (const link of allowed.slice(0, limit)) {
      if (followedBytes >= MAX_FOLLOWED_BYTES) break;
      const result = await fetchLinkedPage(entry.name, link.url, doc.url, entry.ttlHours);
      switch (result.status) {
        case "ok":
          corpus += `\n\n# ${link.title}\n\n${result.page.content}`;
          followed.push(link.url);
          followedBytes += result.page.content.length;
          break;
        case "refused": // redirect escaped the origin
          skippedOutsideOrigin += 1;
          break;
        case "too-large":
          tooLarge.push(link.url);
          break;
        case "unavailable":
          failed.push(link.url);
          break;
      }
    }
  }

  const notes: string[] = [];
  if (followed.length) notes.push(`Followed index links: ${followed.join(", ")}`);
  if (skippedOutsideOrigin > 0) {
    notes.push(
      `Skipped ${skippedOutsideOrigin} index links outside ${new URL(doc.url).origin} (same-origin https only)`,
    );
  }
  if (tooLarge.length) {
    notes.push(
      `Skipped ${tooLarge.length} index links larger than ${LINKED_PAGE_MAX_BYTES / (1024 * 1024)} MiB: ${tooLarge.join(", ")}`,
    );
  }
  if (failed.length) notes.push(`Could not fetch ${failed.length} index links: ${failed.join(", ")}`);
  const noteBlock = notes.length ? `\n${notes.join("\n")}` : "";

  const ranked = rankSections(corpus, topic);
  if (ranked.length === 0) {
    const sep = noteBlock ? `${noteBlock}\n` : " ";
    return `${prefix}No sections matched "${topic}" in ${entry.name} docs (source: ${doc.url}).${sep}Try broader terms or call get_docs without a topic for the table of contents.`;
  }
  const body = assemble(ranked, budget);
  return `${prefix}Source: ${doc.url}${noteBlock}\n\n${body}`;
}
