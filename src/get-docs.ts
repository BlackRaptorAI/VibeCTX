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
  fitStampLine,
  noMatchNote,
  thinMatchNote,
  MAX_FOLLOWED_BYTES,
  type SplitSection,
} from "./retrieval.js";
import { indexCachedDocument, documentHash } from "./search-index.js";
import { clipText } from "./text.js";
import { recordActivity, type ActivityOutcome } from "./activity-log.js";

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
  /** The primary document that was served; undefined when nothing was fetched and nothing
   *  cached. `fetchedAt`/`curated` added at A17/PAR-726 alongside the rendered stamp, so a
   *  structured consumer (doctor) reads the same facts the text states without parsing it.
   *  `url` stays the CANDIDATE URL `doctor.ts` looks the cache up by — never `finalUrl` — so
   *  it must not be repointed at the post-redirect URL; `finalUrl` (PAR-776, D-74) is added
   *  alongside it, present only when a redirect actually moved the fetch somewhere else. */
  source?: { url: string; stale: boolean; fetchedAt: string; curated: boolean; finalUrl?: string };
  /** `documentHash` (search-index.ts) of the primary document's content — set exactly when
   *  `source` is (A20/PAR-729, D-51: what the activity log records instead of the text). */
  contentHash?: string;
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

/** A17 (PAR-726), code-reviewer round 1, S1 — `resolutionNote` carries the resolved package's
 *  own (untrusted) description, unbounded beyond `resolved-store.ts`'s ~200-char
 *  `MAX_DESCRIPTION` plus homepage/docs/repository facts. `noMatch` is deliberately exempt
 *  from `clipToBudget` (below, "a short, fixed-shape diagnostic, not content") — true of the
 *  message itself, but `resolutionNote` is neither short by construction nor fixed-shape, so
 *  threading it through unclipped breaks that path's own invariant. Capped here, once, so
 *  every render path — budgeted or exempt — sees the same bounded worst case. */
const MAX_RESOLUTION_NOTE_CHARS = 500;

/** security-architect, A17 round 2, SF-1 — `entry.name` and `entry.urls` are config-authored
 *  raw strings (`link-policy.ts`'s `validateLibraryUrl` checks scheme/host but never
 *  re-serializes, unlike `sanitizeRemoteUrl`'s `url.href` on the resolved path) and, unlike
 *  every stamp field, were never cleaned or clipped before landing in the could-not-fetch and
 *  no-match messages — the same forgery class `sourceStampLine`'s own `url` cleaning (S-1)
 *  closed, one interpolation over. One shared bound for both fields here (not npm's tighter
 *  214-char name limit `search.ts`'s `MAX_LIBRARY_CHARS` uses) — simplicity over precision,
 *  since a config-defined name is not npm-validated the way a resolved one is. */
const MAX_STAMP_FIELD_CHARS = 300;

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
export async function getDocs(entry: LibraryEntry, args: GetDocsArgs, resolutionNote?: string): Promise<string> {
  return (await getDocsDetailed(entry, args, resolutionNote)).text;
}

/** A20/PAR-729, D-51: `not-cached` when nothing was fetched or cached; `no-match` when a
 *  topic was given and nothing in the document matched it; `matched` otherwise (including
 *  the no-topic table-of-contents path — a document WAS successfully served, even though
 *  nothing was topic-matched to produce it). */
function getDocsOutcome(topic: string | undefined, outcome: GetDocsOutcome): ActivityOutcome {
  if (!outcome.source) return "not-cached";
  if (topic !== undefined && outcome.matched === 0) return "no-match";
  return "matched";
}

/** The MCP `get_docs` tool body: resolve `library` (canonical name or alias) and run
 *  getDocs. An unknown name is resolved implicitly through resolve_library (PAR-655) —
 *  npm / PyPI metadata → llms.txt → GitHub README — and, when that works, the entry
 *  joins the live registry so the next call is a plain hit; when it does not, the
 *  could-not-resolve line is returned. Offline, an unknown name gets the unknown-library
 *  text without touching the network.
 *
 *  A20/PAR-729 (D-51): every call writes exactly one activity-log entry, whichever branch
 *  it takes — including the two that never reach a document at all (unknown offline,
 *  unresolvable) — because those are consultations too: an agent asked for a library and
 *  this is what actually happened. `library` is the requested name, cleaned by the log's
 *  own field bound, in those two branches (nothing canonical exists yet to record instead);
 *  the canonical `entry.name` once one does. */
export async function getDocsToolText(
  registry: Registry,
  args: GetDocsArgs & { library: string },
): Promise<string> {
  const { library, ...rest } = args;
  let entry = lookupLibrary(registry, library);
  let resolutionNote: string | undefined;
  if (!entry) {
    if (rest.offline) {
      recordActivity({ tool: "get_docs", library, query: rest.topic, outcome: "unresolved" });
      return unknownLibraryMessage(registry, library);
    }
    const out = await resolvePackage(library);
    if (!out.ok || !out.entry) {
      recordActivity({ tool: "get_docs", library, query: rest.topic, outcome: "unresolved" });
      return out.text;
    }
    // S2: a resolved entry never replaces a curated one; if a curated entry owns the name
    // (it cannot, since the lookup above missed — but the guard is the invariant), serve that.
    entry = installResolvedEntry(registry, out.entry) ? out.entry : (resolveLibrary(registry, out.entry.name) ?? out.entry);
    resolutionNote = provenanceLine(registry, library, out);
  }
  // A17 (PAR-726): resolutionNote used to be prepended here, entirely outside getDocsDetailed's
  // own budget accounting — exactly A6's original mistake, repeated. It is now passed down and
  // priced as part of the header alongside the standing stamp, so on every path `clipToBudget`
  // actually applies to (no-topic, and topic-given success/snippets), `resolutionNote + body`
  // together never exceed `maxTokens*4`, not merely `body` alone. `noMatch` stays the one
  // pre-existing, DELIBERATE exception to that cap (A6's own "short, fixed-shape diagnostic"
  // design, unchanged here) — `resolutionNote` is bounded before it reaches that path too
  // (code-reviewer round 1, S1: `MAX_RESOLUTION_NOTE_CHARS`), so "exempt from the hard cap"
  // no longer also means "unbounded".
  //
  // A20/PAR-729: `getDocsDetailed` directly, not the `getDocs` text-only wrapper — the
  // structured outcome is what the activity-log entry is built from; `detailed.text` already
  // carries `resolutionNote` baked into its own priced header, so nothing is prepended here.
  const detailed = await getDocsDetailed(entry, rest, resolutionNote);
  recordActivity({
    tool: "get_docs",
    library: entry.name,
    query: rest.topic,
    url: detailed.source?.url,
    contentHash: detailed.contentHash,
    fresh: detailed.source ? !detailed.source.stale : undefined,
    outcome: getDocsOutcome(rest.topic, detailed),
  });
  return detailed.text;
}

/** R3: one line the agent sees before docs that were resolved on this very call — where
 *  the package came from, its own (untrusted) description, and a nearby curated name
 *  when the request looks like a typo of one. A17 (PAR-726): this is the ONE-TIME extra
 *  detail a fresh resolution adds; the STANDING stamp every call gets (source, fetched-at,
 *  fresh/stale, curated/resolved — see `sourceStampLine`) is separate and unconditional,
 *  added inside `getDocsDetailed` itself.
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

/** True when `entry` was synthesized by `resolve_library` this session rather than coming
 *  from the default registry or a config file (list-libraries.ts:54 established this exact
 *  reading of the field first; A17/PAR-726 reuses it for the standing stamp). */
function isCurated(entry: LibraryEntry): boolean {
  return entry.resolved === undefined;
}

/** getDocs with its structured outcome (see GetDocsOutcome). `resolutionNote`: the one-time
 *  extra prose `getDocsToolText` computed when THIS call is what resolved `entry` implicitly
 *  (see `provenanceLine`) — undefined on every other call. Priced into the budget alongside
 *  the standing stamp, not prepended outside it (A17/PAR-726). */
export async function getDocsDetailed(
  entry: LibraryEntry,
  args: GetDocsArgs,
  resolutionNote?: string,
): Promise<GetDocsOutcome> {
  const { topic } = args;
  const noDropped = { outsideOrigin: 0, tooLarge: 0, unavailable: 0 };
  const resolutionPrefix = resolutionNote ? `${clipText(resolutionNote, MAX_RESOLUTION_NOTE_CHARS)}\n` : "";
  const curated = isCurated(entry);
  const doc = await getLibraryDoc(entry, { offline: args.offline });
  if (!doc) {
    // A17 (PAR-726) addendum (CR-20260906-par-657-config-discovery, source-header-gap): the
    // one response in this file that used to carry no marker at all — no `Source:` line
    // (nothing was fetched, so there is no url/fetchedAt/stale to state), but curated/resolved
    // is still a fact about `entry` regardless of whether a document was ever reached. Same
    // "fact · fact" grammar the stamp itself uses (code-reviewer round 1, N2), not a second,
    // independently-worded vocabulary for the same field.
    const noDocStamp = `No document available · ${curated ? "curated" : "resolved"}`;
    // security-architect, A17 round 2, SF-1: `entry.name`/`entry.urls` come straight from a
    // config file's raw strings — `validateLibraryUrl` (link-policy.ts) checks scheme/host but
    // never re-serializes, so a URL is validated, not normalised, the same gap S-1 closed for
    // the stamp's own `url`. Cleaned and clipped here too, so this response can't carry the
    // same forged-second-line risk right next to the marker that names it "no document".
    return {
      text: `${resolutionPrefix}${noDocStamp}\nCould not fetch docs for "${clipText(entry.name, MAX_STAMP_FIELD_CHARS)}" — all candidate URLs unreachable and nothing cached. Candidates tried:\n${entry.urls.map((u) => clipText(u, MAX_STAMP_FIELD_CHARS)).join("\n")}`,
      isIndex: false,
      matched: 0,
      returnedFromFollowed: 0,
      followed: [],
      dropped: noDropped,
    };
  }
  // PAR-776 (D-74) — `source.url` stays the CANDIDATE `doc.url`, unconditionally: `doctor.ts`
  // reads it straight into `readCache(entry.name, source.url, ttlHours)`, which requires the
  // exact candidate the cache is keyed by, never the post-redirect `finalUrl`. `finalUrl` is
  // added alongside it, only when it actually differs, so a structured consumer can learn the
  // same redirect fact the rendered stamp below states, without parsing prose for it — the
  // same design A17/PAR-726 already established for `stale`/`fetchedAt`/`curated`.
  const source = { url: doc.url, stale: doc.stale, fetchedAt: doc.fetchedAt, curated, ...(doc.finalUrl !== doc.url ? { finalUrl: doc.finalUrl } : {}) };
  // A20/PAR-729: the same hash the search index already computes to detect a changed
  // document (D-33) is what the activity log records in place of the text itself.
  const contentHash = documentHash(doc.content);
  // D-34 (PAR-659): every writer of a PRIMARY cached document keeps the cross-library search
  // index current — a document get_docs just fetched is one `search` would otherwise have to
  // tokenize on its own. Only the primary document: followed index pages are per-query and
  // would make the index unbounded. Memoized by content hash inside the hook, so the ordinary
  // cache-hit call does no file work at all, and best effort throughout (D-13). Keyed by the
  // CANDIDATE `doc.url`, matching `search.ts`'s own `primaryCached` (D-74, PAR-776): the search
  // index's hash+url gate correlates against `entry.urls`, never a post-redirect URL.
  indexCachedDocument(entry.name, doc.url, doc.content);
  const isIndex = looksLikeIndex(doc.content);
  const budget = args.maxTokens ?? DEFAULT_BUDGET_TOKENS;
  const budgetChars = budget * 4;
  // code-reviewer, A17 round 2, SF2 — the same B2 defect `fitStampLine` exists to prevent
  // (a real, well-formed, WRONG date from a mid-value character slice: `doc.staleNote` embeds
  // `fetchedAt` in prose, e.g. "STALE: served from cache fetched 2026-09-1…") was still
  // reachable here, pre-existing and unaffected by A6/A17 alike, because this banner was never
  // priced against a "fits or omit" rule the way every OTHER header piece now is. All-or-
  // nothing, not a field-by-field degrade like the stamp: the STRUCTURED fact ("stale") still
  // survives in `docStamp` below whenever docStamp itself fits, so dropping this prose
  // explanation first (never truncating it) loses elaboration, not the fact.
  const staleBanner = doc.staleNote ? `> ${doc.staleNote}\n\n` : "";
  const prefix = staleBanner.length <= Math.max(0, budgetChars - resolutionPrefix.length) ? staleBanner : "";
  // A18 (PAR-727): built once, reused by both the standing `docStamp` below and `thinMatch`'s
  // own re-fitted stamp further down — the same facts, just re-degraded around less room.
  // PAR-776 (D-74): `url` here is the URL the content actually came from (`doc.finalUrl`), not
  // the candidate that was requested — unlike the structured `source` above, this is what a
  // human or a model reading the response needs to know the document's real origin is.
  // `redirectedFrom` carries the candidate too, only when it differs, so the line states BOTH
  // when they diverge rather than silently substituting one for the other.
  const stampFacts = {
    url: doc.finalUrl,
    redirectedFrom: doc.finalUrl !== doc.url ? doc.url : undefined,
    fetchedAt: doc.fetchedAt,
    stale: doc.stale,
    curated,
  };
  // A17 (PAR-726), code-reviewer round 1, B2 — `fitStampLine`, not `sourceStampLine` directly:
  // the room actually available for the stamp is `budgetChars` minus whatever the one-time
  // resolution note and the stale prefix already spent, so a small budget degrades the stamp
  // to a shorter COMPLETE line rather than leaving it to the final `clipToBudget` backstop to
  // cut a field in half (measured pre-fix: `maxTokens: 14` rendered `fetched 2026-09-1` — a
  // real, well-formed, WRONG date).
  const docStamp = fitStampLine(stampFacts, Math.max(0, budgetChars - resolutionPrefix.length - prefix.length));

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
    // non-empty: `doc.finalUrl` (PAR-776 — what the stamp renders; see below) is itself
    // unbounded, so the fixed overhead around the TOC
    // (`Source:` line, label, separator — NOT charged against `tocBudget`) can still exceed
    // what's left once the TOC saturates its own half-share. When it saturates (a heading at
    // or past `tocBudget`), head is non-empty only once `budgetChars` clears roughly TWICE
    // that fixed overhead, not merely "the overhead plus one character" — MEASURED for
    // `test/get-docs.test.ts`'s `INDEX_URL` fixture (64-char fixed overhead): `head` stays empty through
    // `maxTokens: 32` (`budgetChars` 128, `header` 128) and only turns non-empty at
    // `maxTokens: 33` (`budgetChars` 132, `header` 130, `head` 2 chars) — not at
    // `budgetChars >= 65`, which is what "overhead plus one character" would predict. Below
    // that boundary, the final `clipToBudget` backstop is what keeps the response in budget,
    // same as every other path — it does not keep the head non-empty. No universal formula is
    // asserted here for that reason: the fixed overhead varies with `doc.finalUrl`'s own length, so
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
    const header = `${resolutionPrefix}${prefix}${docStamp}\n\n${toc ? `Table of contents:\n${toc}\n\n---\n\n` : ""}`;
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
      contentHash,
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
    // PAR-776 (D-74) — `doc.finalUrl`, not `doc.url`, resolves relative links and gates the
    // host policy: a relative link in the document text resolves against the URL it was
    // ACTUALLY served from, not the candidate that was requested before any redirect. A
    // primary document that redirects cross-host (docs.anthropic.com → platform.claude.com,
    // D-04) used to resolve its own relative links against the ORIGINAL host — wrong, since
    // nothing was ever served from there — which could refuse a link that is genuinely
    // same-origin with the document as fetched, or (not excluded either) admit one that only
    // LOOKS same-origin against the wrong base. `doc.finalUrl` equals `doc.url` when nothing
    // redirected, so this is a no-op change for the common case.
    const limit = followLimit(extractLinks(doc.content, doc.finalUrl).length);
    // Rank every matching link, drop guard-refused ones (counted for the note),
    // THEN take the budget — so cross-origin links never crowd out followable ones.
    // fetchLinkedPage re-checks the guard; this is the visible layer, that one is the safety layer.
    const candidates = rankLinks(doc.content, topic, doc.finalUrl, Number.POSITIVE_INFINITY);
    const allowed = candidates.filter((link) => {
      const ok = isAllowedLink(link.url, doc.finalUrl, entry);
      if (!ok) skippedOutsideOrigin += 1;
      return ok;
    });
    let followedBytes = 0;
    for (const link of allowed.slice(0, limit)) {
      if (followedBytes >= MAX_FOLLOWED_BYTES) break;
      const result = await fetchLinkedPage(entry.name, link.url, doc.finalUrl, entry.ttlHours, args.offline, entry);
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
    // PAR-776 (D-74): the document's OWN host, for this note, is the one it was actually
    // served from — matching the `isAllowedLink` check just above that produced this count.
    const hosts = [new URL(doc.finalUrl).hostname, ...(entry.allowedHosts ?? [])];
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
  // genuinely unbounded PER-CALL field, `topic`, is clipped on its own instead (round 4,
  // code-reviewer S4 — earlier wording here claimed `topic` was the only unclipped field,
  // which the `noMatch` template below directly contradicts). Neither `doc.url` nor (PAR-776)
  // `doc.finalUrl` appears in this template at all (A17/PAR-726 — see below) and, everywhere
  // either DOES still appear (`docStamp`), both are cleaned and clipped by
  // `sourceStampLine`/`fitStampLine` (security-architect, A17 round 1, S-1 — extended to
  // `redirectedFrom` by PAR-776, the same lesson applied to the newer field). `entry.name` is
  // clipped below too (round 2, SF-1) — it was
  // bounded to 214 chars only on the resolve path (`npmNameError`/`pypiNameError`), not for a
  // config-defined entry, the same gap S-1 closed for `url`.
  const noMatch = (what: string, advice: string): GetDocsOutcome => ({
    // A17 (PAR-726): the lowercase inline "(source: url)" fragment this used to carry is gone
    // — replaced by the same `docStamp` line every other path renders, closing a wording
    // inconsistency this file's own ground-truth review flagged (capitalized `Source:` line
    // everywhere else, lowercase inline fragment only here). A18 (PAR-727): the sentence
    // itself is now `retrieval.ts`'s `noMatchNote` — the one grammar shared by both modes,
    // cleaning/clipping `topic`/`entry.name` centrally instead of this file doing it inline.
    text: `${resolutionPrefix}${prefix}${docStamp}\n${noMatchNote(what, topic ?? "", entry.name)}${
      noteBlock ? `${noteBlock}\n` : " "
    }${advice}`,
    contentHash,
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
  const header = `${resolutionPrefix}${prefix}${docStamp}${noteBlock}\n\n`;

  // A18 (PAR-727) — the thin-match case: real matches exist (`matchedCount > 0`) but the
  // budget left `assemble`/`assembleSnippets` NOTHING to render once the (full-size) header
  // above was paid for. That silence is exactly the condition D-29 already forces this file to
  // treat as "the header alone reached the budget" — which means the OUTER `clipToBudget`
  // backstop would swallow any body text at that same point regardless of what it contained.
  // A `thinMatchNote` appended to the SAME oversized header would therefore never be visible:
  // dead code, not a fix. So this path builds its OWN, smaller header instead — the note's own
  // length is reserved FIRST, `docStamp` re-degrades (via `fitStampLine`) around what is left,
  // and `noteBlock` (index-follow accounting) is dropped entirely: D-43's "the answer outranks
  // the accounting" applies here too — when there is no room for the real answer, the
  // EXPLANATION of why outranks the follow/skip bookkeeping that no longer matters as much.
  //
  // code-reviewer round 1, S1 — the first version of this stopped there, and MEASURED, it left
  // the note itself invisible in the large majority of budgets that actually reach `thinMatch`
  // (94.6% of a swept range, for a document with a longish URL): `fitStampLine` has a floor it
  // cannot degrade below (`Source: <url>` — up to ~308 chars once the url itself is clipped),
  // so whenever that floor alone reaches the room reserved for it, the note that was supposed
  // to get PRIORITY got silently sliced off by the plain head-truncating `clipToBudget`
  // instead. Fixed by making the priority real, not aspirational: the stamp is included ONLY
  // when even its shortest complete form fits beside the note; otherwise it is dropped
  // entirely, never rendered as a partial (mid-URL) fragment — the same lesson A17's B2 finding
  // established for the fetched-at date, applied here to the stamp as a whole. D-43's ordering
  // is now genuinely: note first, stamp only if there's room left for the WHOLE thing.
  const thinMatch = (what: string, matchedCount: number): GetDocsOutcome => {
    const note = thinMatchNote(what, matchedCount);
    const stampRoom = Math.max(0, budgetChars - resolutionPrefix.length - prefix.length - note.length - 1);
    const stamp = fitStampLine(stampFacts, stampRoom);
    const head = stamp.length <= stampRoom ? `${stamp}\n` : "";
    return {
      text: clipToBudget(`${resolutionPrefix}${prefix}${head}${note}`, budgetChars),
      source,
      contentHash,
      isIndex,
      matched: matchedCount,
      returnedFromFollowed: 0,
      followed,
      dropped,
    };
  };

  if ((args.mode ?? "sections") === "snippets") {
    const snippets = rankSplitSnippets(corpusSections, topic);
    if (snippets.length === 0) {
      return noMatch("code snippets", 'Try mode "sections" or broader terms.');
    }
    const assembled = assembleSnippets(snippets, budget, header.length);
    if (assembled.length === 0) return thinMatch("code snippets", snippets.length);
    return {
      text: clipToBudget(`${header}${assembled}`, budgetChars),
      source,
      contentHash,
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
  const assembled = assemble(ranked, budget, header.length);
  if (assembled.length === 0) return thinMatch("sections", ranked.length);
  return {
    text: clipToBudget(`${header}${assembled}`, budgetChars),
    source,
    contentHash,
    isIndex,
    matched: ranked.length,
    returnedFromFollowed: fromFollowed(selectSections(ranked, budget, header.length)),
    followed,
    dropped,
  };
}
