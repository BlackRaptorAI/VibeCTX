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
  selectSections,
  splitSections,
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
  /** Cache-only: never touch the network (doctor --offline). */
  offline?: boolean;
}

/** What get_docs did, as data — the text plus the accounting behind its notes,
 *  so `doctor` can classify retrieval without parsing prose. */
export interface GetDocsOutcome {
  /** Exactly the text the get_docs tool responds with. */
  text: string;
  /** The primary document that was served; undefined when nothing was fetched and nothing cached. */
  source?: { url: string; stale: boolean };
  /** looksLikeIndex(primary document). */
  isIndex: boolean;
  /** Sections that matched the topic across the primary document plus followed pages (0 without a topic). */
  matched: number;
  /** Of the sections actually returned under the budget, how many came from a followed page
   *  rather than the primary document. > 0 means following links is what produced the answer. */
  returnedFromFollowed: number;
  /** Followed index links, in follow order. */
  followed: string[];
  /** Index links that were candidates but not followed, by reason. */
  dropped: { outsideOrigin: number; tooLarge: number; unavailable: number };
}

const DEFAULT_BUDGET_TOKENS = 4000;

const sectionKey = (s: { heading: string; body: string }) => `${s.heading}\n${s.body}`;

/**
 * The get_docs tool body, kept out of index.ts so it can be exercised without a
 * transport. Returns the text the tool responds with.
 */
export async function getDocs(entry: LibraryEntry, args: GetDocsArgs): Promise<string> {
  return (await getDocsDetailed(entry, args)).text;
}

/** getDocs with its structured outcome (see GetDocsOutcome). */
export async function getDocsDetailed(entry: LibraryEntry, args: GetDocsArgs): Promise<GetDocsOutcome> {
  const { topic } = args;
  const noDropped = { outsideOrigin: 0, tooLarge: 0, unavailable: 0 };
  const doc = await getLibraryDoc(entry, { offline: args.offline });
  if (!doc) {
    return {
      text: `Could not fetch docs for "${entry.name}" — all candidate URLs unreachable and nothing cached. Candidates tried:\n${entry.urls.join("\n")}`,
      isIndex: false,
      matched: 0,
      returnedFromFollowed: 0,
      followed: [],
      dropped: noDropped,
    };
  }
  const source = { url: doc.url, stale: doc.staleNote !== undefined };
  const isIndex = looksLikeIndex(doc.content);
  const budget = args.maxTokens ?? DEFAULT_BUDGET_TOKENS;
  const prefix = doc.staleNote ? `> ${doc.staleNote}\n\n` : "";

  if (!topic) {
    const toc = doc.content
      .split("\n")
      .filter((l) => /^#{1,3}\s/.test(l))
      .slice(0, 60)
      .join("\n");
    const head = doc.content.slice(0, budget * 4);
    return {
      text: `${prefix}Source: ${doc.url}\n\n${toc ? `Table of contents:\n${toc}\n\n---\n\n` : ""}${head}`,
      source,
      isIndex,
      matched: 0,
      returnedFromFollowed: 0,
      followed: [],
      dropped: noDropped,
    };
  }

  // Topic given: if the doc is an index of links, pull the best-matching pages too.
  let corpus = doc.content;
  const followed: string[] = [];
  const failed: string[] = [];
  const tooLarge: string[] = [];
  let skippedOutsideOrigin = 0;
  if (isIndex) {
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
      const result = await fetchLinkedPage(entry.name, link.url, doc.url, entry.ttlHours, args.offline);
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
  const dropped = { outsideOrigin: skippedOutsideOrigin, tooLarge: tooLarge.length, unavailable: failed.length };

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
    return {
      text: `${prefix}No sections matched "${topic}" in ${entry.name} docs (source: ${doc.url}).${sep}Try broader terms or call get_docs without a topic for the table of contents.`,
      source,
      isIndex,
      matched: 0,
      returnedFromFollowed: 0,
      followed,
      dropped,
    };
  }
  const body = assemble(ranked, budget);
  // Section origin: a returned section is "from a followed page" when it has content and
  // no section of the primary document has the same heading and body. Body-less sections
  // are excluded because the "# <link title>" marker prefixed to each followed page matches
  // the topic by construction without carrying any answer. Only computed when something was followed.
  let returnedFromFollowed = 0;
  if (followed.length > 0) {
    const primaryKeys = new Set(splitSections(doc.content).map(sectionKey));
    returnedFromFollowed = selectSections(ranked, budget).filter(
      (s) => s.body.trim().length > 0 && !primaryKeys.has(sectionKey(s)),
    ).length;
  }
  return {
    text: `${prefix}Source: ${doc.url}${noteBlock}\n\n${body}`,
    source,
    isIndex,
    matched: ranked.length,
    returnedFromFollowed,
    followed,
    dropped,
  };
}
