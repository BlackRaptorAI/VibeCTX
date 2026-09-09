import { installResolvedEntry, nearestLibraryName, resolveLibrary, unknownLibraryMessage, type LibraryEntry, type Registry } from "./registry.js";
import { lookupLibrary, resolvePackage, type ResolveOutcome } from "./resolve.js";
import {
  getLibraryDoc,
  fetchLinkedPage,
  isAllowedLink,
  LINKED_PAGE_MAX_BYTES,
} from "./fetcher.js";
import {
  rankSplitSections,
  assemble,
  selectSections,
  splitSections,
  rankSplitSnippets,
  assembleSnippets,
  selectSnippets,
  looksLikeIndex,
  rankLinks,
  extractLinks,
  followLimit,
  MAX_FOLLOWED_BYTES,
  type SplitSection,
} from "./retrieval.js";
import { indexCachedDocument } from "./search-index.js";

/** D-26: what a topic search returns — whole matching sections (the default), or just
 *  the runnable code blocks inside them. */
export type GetDocsMode = "sections" | "snippets";

export interface GetDocsArgs {
  topic?: string;
  /** Approximate response budget in tokens (default 4000). */
  maxTokens?: number;
  /** Cache-only: never touch the network (doctor --offline). */
  offline?: boolean;
  /** "sections" (default) or "snippets" (D-26). Only meaningful with a topic: without
   *  one, both modes return the table of contents and the document head. */
  mode?: GetDocsMode;
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
  /** Sections — or, in snippets mode, code blocks — that matched the topic across the
   *  primary document plus followed pages (0 without a topic). */
  matched: number;
  /** Of the sections actually returned under the budget, how many came from a followed page
   *  rather than the primary document. > 0 means following links is what produced the answer. */
  returnedFromFollowed: number;
  /** Followed index links, in follow order. */
  followed: string[];
  /** Index links that were candidates but not followed, by reason. `outsideOrigin` counts
   *  links the allowed-host policy refused (before or after redirects); the key keeps its
   *  0.1.3 name because doctor's JSON sums it. */
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

/** The MCP `get_docs` tool body: resolve `library` (canonical name or alias) and run
 *  getDocs. An unknown name is resolved implicitly through resolve_library (PAR-655) —
 *  npm / PyPI metadata → llms.txt → GitHub README — and, when that works, the entry
 *  joins the live registry so the next call is a plain hit; when it does not, the
 *  could-not-resolve line is returned. Offline, an unknown name gets the unknown-library
 *  text without touching the network. */
export async function getDocsToolText(
  registry: Registry,
  args: GetDocsArgs & { library: string },
): Promise<string> {
  const { library, ...rest } = args;
  let entry = lookupLibrary(registry, library);
  let provenance = "";
  if (!entry) {
    if (rest.offline) return unknownLibraryMessage(registry, library);
    const out = await resolvePackage(library);
    if (!out.ok || !out.entry) return out.text;
    // S2: a resolved entry never replaces a curated one; if a curated entry owns the name
    // (it cannot, since the lookup above missed — but the guard is the invariant), serve that.
    entry = installResolvedEntry(registry, out.entry) ? out.entry : (resolveLibrary(registry, out.entry.name) ?? out.entry);
    provenance = `${provenanceLine(registry, library, out)}\n`;
  }
  return provenance + (await getDocs(entry, rest));
}

/** R3: one line the agent sees before docs that were resolved on this very call — where
 *  the package came from, its own (untrusted) description, and a nearby curated name
 *  when the request looks like a typo of one.
 *
 *  A5 (PAR-718): also the ONLY place `get_docs`'s implicit-resolution path surfaces
 *  `out.saved === false` (a write failure the process could not avoid — a read-only
 *  `$HOME` or a full disk — now caught in `resolvePackage` instead of thrown). The
 *  document is still returned and the call still exits 0: the resolution lives in memory
 *  for the rest of this process even when `resolved.json` could not be written, so losing
 *  the save is not losing the answer. */
function provenanceLine(registry: Registry, requested: string, out: ResolveOutcome): string {
  const label = out.source === "pypi" ? "PyPI" : "npm";
  const facts: string[] = [];
  if (out.entry?.description) facts.push(`(package-supplied) description: ${out.entry.description}`);
  if (out.homepage) facts.push(`homepage ${out.homepage}`);
  if (out.docsUrl) facts.push(`docs ${out.docsUrl}`);
  if (out.repository) facts.push(`repository github.com/${out.repository.owner}/${out.repository.repo}`);
  const near = nearestLibraryName(registry, requested);
  if (near) facts.push(`nearest curated name: "${near}"`);
  if (out.saved === false) facts.push(`resolution not saved: ${out.saveNote ?? "resolved.json could not be written"}`);
  return `> Resolved "${requested}" via ${label} on this call — not a curated entry; verify this is the package you meant. ${facts.join(" · ")}`.trimEnd();
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
  // D-34 (PAR-659): every writer of a PRIMARY cached document keeps the cross-library search
  // index current — a document get_docs just fetched is one `search` would otherwise have to
  // tokenize on its own. Only the primary document: followed index pages are per-query and
  // would make the index unbounded. Memoized by content hash inside the hook, so the ordinary
  // cache-hit call does no file work at all, and best effort throughout (D-13).
  indexCachedDocument(entry.name, doc.url, doc.content);
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
  //
  // D-31: the primary document and each followed page are split into sections
  // SEPARATELY and the section LISTS concatenated. Concatenating the TEXT and splitting
  // once meant an unclosed fence in one document swallowed everything appended after it
  // — the next page's sections, its heading path and its answer with them. Each page
  // still keeps the "# <link title>" marker as its own root heading, so its heading
  // paths read under the page they came from.
  const primarySections = splitSections(doc.content);
  const followedSections: SplitSection[] = [];
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
      const ok = isAllowedLink(link.url, doc.url, entry);
      if (!ok) skippedOutsideOrigin += 1;
      return ok;
    });
    let followedBytes = 0;
    for (const link of allowed.slice(0, limit)) {
      if (followedBytes >= MAX_FOLLOWED_BYTES) break;
      const result = await fetchLinkedPage(entry.name, link.url, doc.url, entry.ttlHours, args.offline, entry);
      switch (result.status) {
        case "ok":
          followedSections.push(...splitSections(`# ${link.title}\n\n${result.page.content}`));
          followed.push(link.url);
          followedBytes += result.page.content.length;
          break;
        case "refused": // redirect left the allowed hosts
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
    const hosts = [new URL(doc.url).hostname, ...(entry.allowedHosts ?? [])];
    notes.push(`Skipped ${skippedOutsideOrigin} index links outside allowed hosts (${hosts.join(", ")})`);
  }
  if (tooLarge.length) {
    notes.push(
      `Skipped ${tooLarge.length} index links larger than ${LINKED_PAGE_MAX_BYTES / (1024 * 1024)} MiB: ${tooLarge.join(", ")}`,
    );
  }
  if (failed.length) notes.push(`Could not fetch ${failed.length} index links: ${failed.join(", ")}`);
  const noteBlock = notes.length ? `\n${notes.join("\n")}` : "";

  // Everything above this line is identical for both modes (D-26): the same document,
  // the same followed links, the same notes. Only the ranking and the rendering differ.
  const noMatch = (what: string, advice: string): GetDocsOutcome => ({
    text: `${prefix}No ${what} matched "${topic}" in ${entry.name} docs (source: ${doc.url}).${
      noteBlock ? `${noteBlock}\n` : " "
    }${advice}`,
    source,
    isIndex,
    matched: 0,
    returnedFromFollowed: 0,
    followed,
    dropped,
  });

  /** How many of the rendered chunks came from a followed page rather than the primary
   *  document. A body-less section is never counted: the "# <link title>" marker
   *  get_docs prefixes to each followed page matches the topic by construction without
   *  carrying any answer. Only computed when something was actually followed. */
  const fromFollowed = (chosen: { heading: string; body: string }[]): number => {
    if (followed.length === 0) return 0;
    const primaryKeys = new Set(primarySections.map(sectionKey));
    return chosen.filter((s) => s.body.trim().length > 0 && !primaryKeys.has(sectionKey(s))).length;
  };

  const corpusSections = [...primarySections, ...followedSections];

  if ((args.mode ?? "sections") === "snippets") {
    const snippets = rankSplitSnippets(corpusSections, topic);
    if (snippets.length === 0) {
      return noMatch("code snippets", 'Try mode "sections" or broader terms.');
    }
    return {
      text: `${prefix}Source: ${doc.url}${noteBlock}\n\n${assembleSnippets(snippets, budget)}`,
      source,
      isIndex,
      matched: snippets.length,
      returnedFromFollowed: fromFollowed(
        selectSnippets(snippets, budget).map((s) => corpusSections[s.sectionIndex]),
      ),
      followed,
      dropped,
    };
  }

  const ranked = rankSplitSections(corpusSections, topic);
  if (ranked.length === 0) {
    return noMatch("sections", "Try broader terms or call get_docs without a topic for the table of contents.");
  }
  return {
    text: `${prefix}Source: ${doc.url}${noteBlock}\n\n${assemble(ranked, budget)}`,
    source,
    isIndex,
    matched: ranked.length,
    returnedFromFollowed: fromFollowed(selectSections(ranked, budget)),
    followed,
    dropped,
  };
}
