import type { LibraryEntry } from "./registry.js";
import { getLibraryDoc, getLinkedPage, isAllowedLink } from "./fetcher.js";
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
  let skippedOutsideOrigin = 0;
  if (looksLikeIndex(doc.content)) {
    const limit = followLimit(extractLinks(doc.content, doc.url).length);
    let followedBytes = 0;
    for (const link of rankLinks(doc.content, topic, doc.url, limit)) {
      if (followedBytes >= MAX_FOLLOWED_BYTES) break;
      // Pre-check so a guard refusal is reported, not confused with a network failure.
      // getLinkedPage re-checks; this is the visible layer, that one is the safety layer.
      if (!isAllowedLink(link.url, doc.url)) {
        skippedOutsideOrigin += 1;
        continue;
      }
      const page = await getLinkedPage(entry.name, link.url, doc.url, entry.ttlHours);
      if (page) {
        corpus += `\n\n# ${link.title}\n\n${page.content}`;
        followed.push(link.url);
        followedBytes += page.content.length;
      } else {
        failed.push(link.url);
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
