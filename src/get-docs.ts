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
import { clipText } from "./config.js";

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

/** A6 (PAR-719) — the note block (followed links, skipped-link categories) is priced into the
 *  budget like everything else, but its own natural size is unbounded (real URLs, real link
 *  text) — capped here rather than exempted, per the rollback trigger: generous headroom over
 *  five followed URLs plus three skip-category lines at realistic URL lengths, bounded so it
 *  can never itself starve the answer on an ordinary call. ASSUMED, not measured. */
const MAX_NOTE_BLOCK_CHARS = 1000;

/** A6 (PAR-719), round 1 (test-auditor, F4) — `topic` has no length bound at the MCP schema
 *  (unlike `search`'s `query`, capped at 1000 chars there) and is echoed verbatim into the
 *  no-match message. Bounded on echo, matching this codebase's own convention for other
 *  attacker-influenced strings rendered into a response (`MAX_LIBRARY_CHARS`/`MAX_URL_CHARS`
 *  in `search.ts`). ASSUMED, not measured. */
const MAX_ECHOED_TOPIC_CHARS = 200;

/** A6 (PAR-719) — the final backstop every render path in this file applies: whatever the
 *  header (stale-note prefix, `Source:` line, table of contents or note block) and body come
 *  to, the combined response never exceeds the budget. D-29's rule, unchanged: the cap always
 *  wins, no field or header escapes it — this is what makes that literally true here even in
 *  the case an oversized header alone would otherwise exceed budget. */
function clipToBudget(text: string, budgetChars: number): string {
  return text.length > budgetChars ? text.slice(0, budgetChars) : text;
}

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
  const budgetChars = budget * 4;
  const prefix = doc.staleNote ? `> ${doc.staleNote}\n\n` : "";

  if (!topic) {
    const headings = doc.content.split("\n").filter((l) => /^#{1,3}\s/.test(l)).slice(0, 60);
    // Round 2 (code-reviewer, Nit 4) — the SAME D-43 half-share discipline the note block
    // already gets, applied to the table of contents: before this, the TOC was priced as
    // header (unconditionally ahead of the document head) but never capped as a SHARE of the
    // budget, only at a fixed 60-line ceiling — so on a document with many/long headings, the
    // TOC alone could consume the entire response and leave no document head at all, the same
    // failure D-43 was written to prevent for the note block.
    //
    // NARROWED CLAIM (round 3, test-auditor, F6) — round 2's own comment here overstated this
    // as a GUARANTEE of half of `budgetChars` for the document head. It was not one: the loop
    // took its first heading line unconditionally regardless of length, so a single heading
    // longer than `tocBudget` (unbounded — nothing upstream of this slice bounds a heading
    // line's length) reproduced the exact starvation this fix exists to prevent, by a
    // different route. Fixed here per D-29 ("the cap always wins, no field escapes it",
    // already the rule for `selectSections`/`assembleSnippets`): the first line is now CLIPPED
    // to `tocBudget` rather than taken whole when it alone exceeds it — this is not a "take at
    // least one heading" exception, it is the same cap the rest of the loop already obeys.
    // What this buys, precisely (round 4, test-auditor F7 — round 3's own replacement
    // claim here was ALSO wrong, off by roughly a factor of 2, caught the same way as F6):
    // the TOC content itself never exceeds `tocBudget` (half of `budgetChars`), full stop —
    // that part IS an exact guarantee. It is NOT a guarantee that the document head is ever
    // non-empty: `doc.url` is itself unbounded, so the fixed overhead around the TOC
    // (`Source:` line, label, separator — NOT charged against `tocBudget`) can still exceed
    // what's left once the TOC saturates its own half-share. When it saturates (a heading at
    // or past `tocBudget`), head is non-empty only once `budgetChars` clears roughly TWICE
    // that fixed overhead, not merely "the overhead plus one character" — MEASURED for this
    // file's own `INDEX_URL` fixture (64-char fixed overhead): `head` stays empty through
    // `maxTokens: 32` (`budgetChars` 128, `header` 128) and only turns non-empty at
    // `maxTokens: 33` (`budgetChars` 132, `header` 130, `head` 2 chars) — not at
    // `budgetChars >= 65`, which is what "overhead plus one character" would predict. Below
    // that boundary, the final `clipToBudget` backstop is what keeps the response in budget,
    // same as every other path — it does not keep the head non-empty. No universal formula is
    // asserted here for that reason: the fixed overhead varies with `doc.url`'s own length, so
    // the real boundary is per-document and pinned by test at a real url, not claimed as a
    // constant.
    const tocBudget = Math.floor(budgetChars / 2);
    let toc = "";
    for (const line of headings) {
      const next = toc.length === 0 ? line : `${toc}\n${line}`;
      if (next.length > tocBudget) {
        if (toc.length === 0) toc = line.slice(0, tocBudget);
        break;
      }
      toc = next;
    }
    const header = `${prefix}Source: ${doc.url}\n\n${toc ? `Table of contents:\n${toc}\n\n---\n\n` : ""}`;
    // A6 (PAR-719) — the OVERSIGHT FINDING this item exists to close: `head` used to be
    // computed as `doc.content.slice(0, budget * 4)` — the ENTIRE allowance — and the stale
    // prefix, `Source:` line and table of contents were then prepended ON TOP of that, so the
    // rendered response could run to kilobytes over budget on an ordinary call. The header is
    // priced FIRST now; `head` gets only what is left. `Math.max(0, ...)`, not a floor that lets
    // the header itself grow unbounded — D-29's rule applies here too: the cap always wins, so
    // the final clip below is the backstop for the case where even the header alone is over
    // budget (a very long table of contents), which `head` alone being empty cannot fix.
    const head = doc.content.slice(0, Math.max(0, budgetChars - header.length));
    return {
      text: clipToBudget(`${header}${head}`, budgetChars),
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
  // A6 (PAR-719), done-when #2 (D-43 — the answer outranks the accounting): the note block is
  // capped at the SMALLER of a fixed ceiling and half the call's own budget, never just the
  // fixed ceiling alone. Without the budget-relative half, a maximal note block (a followed
  // link plus all three skip lines) can by itself run past a small `maxTokens`, leaving
  // `assemble`/`assembleSnippets` nothing to work with and the "answer" absent from a response
  // that is mostly accounting — exactly what D-43 forbids. Capping the note block, not
  // exempting it, is the rollback trigger's own instruction.
  //
  // NARROWED CLAIM (round 1, test-auditor, F5; corrected round 2, test-auditor, same F5 —
  // round 1's own correction still overstated the boundary): "at ANY budget" overstates what
  // this buys. The header (prefix, `Source:` line, capped notes) still has its own fixed floor
  // — the `Source:` line alone is never zero — so at a budget too small even for THAT, the
  // header consumes the whole response and the answer is absent, same as D-29 already accepts
  // for snippets ("the cap always wins" has no size-of-answer exception). MEASURED for the
  // maximal-note-block fixture `test/get-docs.test.ts`'s D-43 tests use: the room left for the
  // body is `budgetChars - header.length`, which is POSITIVE — and a real, if truncated, slice
  // of the top section is rendered — from `maxTokens: 20` upward; genuinely ZERO room (no
  // section content of any kind, not even a partial heading) only below `maxTokens: 20`. Round
  // 1's own "33 and below, no content" claim was WRONG: at 33 there IS a 28-character slice of
  // the heading line, truncated one character short of completing the word "hostname" — caught
  // on re-review, not self-caught, and corrected here rather than left standing. Both numbers
  // are per-fixture (the URL lengths, library name and note categories all vary the header's
  // own size), not universal constants — pinned by test, not asserted here as a formula. A
  // plain length clip, NOT
  // `clipText`: `clipText` (via `cleanText`) strips C0 control characters to neutralise hostile
  // derived fields, but `\n` (U+000A) IS a C0 control character — running the WHOLE multi-line
  // block through it would silently delete the newlines between note lines, collapsing four
  // lines into one unreadable run-on string. Each note line is already built from this file's
  // own literal text plus URLs; cleaning those URLs individually (if a hostile document's link
  // text needs it) is unchanged from before this item and out of A6's scope — this only bounds
  // LENGTH.
  const noteBudget = Math.min(MAX_NOTE_BLOCK_CHARS, Math.floor(budgetChars / 2));
  const noteBlock = notes.length ? `\n${notes.join("\n")}`.slice(0, noteBudget) : "";

  // Everything above this line is identical for both modes (D-26): the same document,
  // the same followed links, the same notes. Only the ranking and the rendering differ.
  // A6 (PAR-719), round 1 (test-auditor, F4): the no-match response is a fourth render path
  // D-39 was silent about, and `topic` is echoed back RAW with no length bound anywhere above
  // the MCP schema (unlike `search`'s `query`, capped at 1000 chars at the schema itself) — an
  // attacker-length topic could otherwise make this response arbitrarily large. NOT wrapped in
  // `clipToBudget` like the other three paths: this message is a short, fixed-shape diagnostic
  // ("no match, try X"), not content, and an existing test (`getDocsToolText`, "passes topic
  // and maxTokens through") correctly expects it to survive even a very small `maxTokens` in
  // full — clipping it to the full budget would make a tiny-budget call silently lose the
  // ADVICE that tells the caller what to try next, which is the one thing worth keeping. The
  // one genuinely unbounded field, `topic`, is clipped on its own instead.
  const noMatch = (what: string, advice: string): GetDocsOutcome => ({
    text: `${prefix}No ${what} matched "${clipText(topic ?? "", MAX_ECHOED_TOPIC_CHARS)}" in ${entry.name} docs (source: ${doc.url}).${
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

  // A6 (PAR-719) — the header both topic-given render paths share, priced exactly: the stale
  // prefix, the `Source:` line and the (now capped) note block. `assemble`/`assembleSnippets`
  // price their own join separators AND this reserved amount, so the combined text — header
  // plus body — fits `budget*4` by construction; `clipToBudget` below is the same D-29 backstop
  // the no-topic path uses, for the case a maximal header alone is over budget.
  const header = `${prefix}Source: ${doc.url}${noteBlock}\n\n`;

  if ((args.mode ?? "sections") === "snippets") {
    const snippets = rankSplitSnippets(corpusSections, topic);
    if (snippets.length === 0) {
      return noMatch("code snippets", 'Try mode "sections" or broader terms.');
    }
    return {
      text: clipToBudget(`${header}${assembleSnippets(snippets, budget, header.length)}`, budgetChars),
      source,
      isIndex,
      matched: snippets.length,
      returnedFromFollowed: fromFollowed(
        selectSnippets(snippets, budget, header.length).map((s) => corpusSections[s.sectionIndex]),
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
    text: clipToBudget(`${header}${assemble(ranked, budget, header.length)}`, budgetChars),
    source,
    isIndex,
    matched: ranked.length,
    returnedFromFollowed: fromFollowed(selectSections(ranked, budget, header.length)),
    followed,
    dropped,
  };
}
