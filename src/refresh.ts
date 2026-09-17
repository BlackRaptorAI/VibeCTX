import { installResolvedEntry, resolveLibrary, unknownLibraryMessage, type LibraryEntry, type Registry } from "./registry.js";
import { getLibraryDoc, isDocUnchanged } from "./fetcher.js";
import { resolvePackage } from "./resolve.js";
import { invalidateIndex, openIndexSession, documentHash } from "./search-index.js";
import { dropFollowedPageCache } from "./cache.js";
import { MAX_FULL_REFRESHES_PER_HOUR } from "./limits.js";
import { createSlidingWindowLimiter } from "./rate-limit.js";
import { recordActivity } from "./activity-log.js";

// A3 (PAR-716): the no-argument ("full") form iterates the whole registry — up to thirty
// upstream fetches per call — and is model-callable with no cap before this. Single-library
// refresh stays uncapped; see MAX_FULL_REFRESHES_PER_HOUR.
const fullRefreshLimiter = createSlidingWindowLimiter(MAX_FULL_REFRESHES_PER_HOUR);

/** Test hook: forget the full-refresh window. */
export function resetFullRefreshWindow(): void {
  fullRefreshLimiter.reset();
}

/** The MCP `refresh` tool body, kept out of index.ts so it can be exercised without a
 *  transport: force-refetch one library (canonical name or alias) or every library,
 *  one result line each. An unknown name returns the unknown-library text and fetches
 *  nothing (refresh never resolves new names — get_docs and resolve_library do that).
 *  A resolved entry (PAR-655) is re-resolved through its ecosystem, so a project that
 *  has since published llms.txt or moved its homepage is picked up; on failure the
 *  old entry stays.
 *
 *  A20/PAR-729 (D-51): one activity-log entry per CALL — not per target — matching the
 *  Done-when's own wording. A single-library refresh's entry carries that library's own
 *  `url`/`contentHash` and `fresh: true` (every document here was just force-refetched); a
 *  full (no-argument) refresh's entry carries neither `library` nor `url` — no ONE document
 *  is "the" one a caller can cite, the same reasoning `search`'s multi-library case applies
 *  (see search.ts's `runSearch`). `outcome` is `matched` when at least one target actually
 *  refreshed, `not-cached` otherwise (including the rate-limited and unresolved-name cases). */
export async function refreshToolText(registry: Registry, library?: string, opts: { now?: () => Date } = {}): Promise<string> {
  let targets: LibraryEntry[];
  if (library !== undefined) {
    const entry = resolveLibrary(registry, library);
    if (!entry) {
      recordActivity({ tool: "refresh", library, outcome: "unresolved" });
      return unknownLibraryMessage(registry, library);
    }
    targets = [entry];
  } else {
    const now = opts.now ?? (() => new Date());
    if (!fullRefreshLimiter.take(now().getTime())) {
      recordActivity({ tool: "refresh", outcome: "not-cached" });
      return `refresh limit reached (${MAX_FULL_REFRESHES_PER_HOUR} full refreshes per hour per process); try again later, or refresh one library at a time`;
    }
    targets = [...registry.entries.values()];
  }
  const results: string[] = [];
  let succeeded = 0;
  let single: { url?: string; contentHash?: string } | undefined;
  // R2 (A3, PAR-716): ONE session for the whole loop, not one read-then-write per library —
  // the same fix `warm` and `autowarm` already have (search-index.ts:495-508). Scoped to the
  // direct-fetch path below; a RESOLVED entry's indexing is `resolvePackage`'s own single-
  // document write (R1, D-34) and stays outside this session — see the branch below. MEASURED
  // for the direct-fetch path only (round 1, code-reviewer, S4 — a resolved-entry refresh is
  // still O(n): its own `invalidateIndex` plus `resolvePackage`'s own `indexCachedDocument`,
  // unchanged by this item): a 30-library refresh of non-resolved entries costs at most 3
  // `index.json` reads and 1 write, CONSTANT in library count — not the literal "one read, one
  // write" the issue states. Two of those three reads (the `flush()` re-read that guards
  // against a concurrent writer, and `writeIndex`'s own schema-version check) are intrinsic to
  // the shared session/writeIndex API `warm`/`autowarm` already use and are unchanged here; the
  // third (the lazy snapshot read this item's own `add()`/`remove()` interplay was routing
  // through) is NOT intrinsic — round 1 found it elidable and `search-index.ts`'s `add()` now
  // cancels a pending removal instead of re-reading for it, which also means a refresh that
  // finds nothing changed reads once and writes nothing at all. See the phase report for the
  // full disposition against the go-card's literal wording.
  const session = openIndexSession();
  try {
    for (const entry of targets) {
      if (entry.resolved) {
        // D-34 (PAR-659): invalidate before refetching, so a failed re-resolve leaves the entry
        // gone rather than stale. Left as its own read+write, not folded into `session`:
        // `resolvePackage` re-indexes what it caches on success (R1) as a single-document write
        // this loop does not see coming, so batching this call's removal into `session` risks
        // that later write undoing what `resolvePackage` just did correctly — see the commit
        // message for the case this would break.
        invalidateIndex(entry.name);
        const out = await resolvePackage(entry.name, { ecosystem: entry.resolved.source });
        if (out.ok && out.entry) {
          if (!installResolvedEntry(registry, out.entry)) {
            results.push(
              `${entry.name}: not replaced — "${out.entry.name}" is a curated entry (default, config or alias); a resolved record cannot override it`,
            );
            continue;
          }
          // Round 1 (code-reviewer, S2/S3): keeps every remaining candidate URL, not just the
          // chosen one — `out.entry.urls` is the fallback chain `getLibraryDoc` would use on a
          // future outage, not a followed page, and must not be deleted alongside them.
          // PAR-744 (F-7): guarded on `out.unchanged`, the resolved-branch twin of the
          // direct-fetch guard below — before this, `ResolveOutcome` carried no staleness
          // signal at all, so a re-resolution that only reached a 304 or a stale-cache
          // fallback still dropped followed pages here.
          if (out.chosen && !out.unchanged) dropFollowedPageCache(entry.name, [out.chosen, ...out.entry.urls]);
          // A20/PAR-729: "matched" either way — a 304-confirmed document is as current as a
          // freshly fetched one, and the activity log records what is now known-current, not
          // whether bytes moved on the wire.
          succeeded += 1;
          single = { url: out.chosen, contentHash: out.contentHash };
          results.push(
            `${entry.name}: re-resolved via ${entry.resolved.source} — refreshed from ${out.chosen} (${(out.chars ?? 0).toLocaleString()} chars)`,
          );
        } else {
          results.push(`${entry.name}: FAILED — ${out.text}`);
        }
        continue;
      }
      // D-34: mark this library's entry removed before refetching — batched into `session`
      // rather than `invalidateIndex`'s own read+write, so thirty libraries cost one session,
      // not thirty. A failed refetch leaves the removal as the last word for this library;
      // `add()` below supersedes it on success.
      session.remove(entry.name);
      const doc = await getLibraryDoc(entry, { forceRefresh: true });
      if (doc) {
        session.add(entry.name, doc.url, doc.content);
        // A3: the pages followed from the document just replaced no longer describe anything
        // this refresh knows to be current — drop them (and every OTHER candidate URL's cache
        // — round 1, S2) so the next get_docs re-follows fresh links instead of blending old
        // followed pages with the new primary document. Guarded on `isDocUnchanged` (PAR-744,
        // F-7): `staleNote` catches the case where every candidate URL is unreachable and
        // `getLibraryDoc` re-serves the SAME cached primary; `notModified` catches the case
        // this item fixes — a 304 Not-Modified revalidation, which returns the SAME content
        // with no `staleNote` and used to be indistinguishable here from a genuine fresh
        // fetch, dropping followed pages even on an ETag-serving site's ordinary "nothing
        // changed" refresh (round 2, code-reviewer, SF-1 — the dropped page's real cost: one
        // previously served flagged `STALE:` during an upstream outage now reports "Could not
        // fetch N index links" instead, once its cache is gone).
        if (!isDocUnchanged(doc)) dropFollowedPageCache(entry.name, [doc.url, ...entry.urls]);
        // A20/PAR-729: "matched" either way — see the same note on the resolved-entry branch
        // above.
        succeeded += 1;
        single = { url: doc.url, contentHash: documentHash(doc.content) };
      }
      results.push(
        doc
          ? // PAR-744 (F-7, security-architect round 1, L1): a 304 revalidation says so — the
            // whole point of this item is that "unchanged" and "refreshed" are now DIFFERENT,
            // internally distinguishable outcomes, and reporting them identically would hide
            // that from the one place a human actually reads the result.
            `${entry.name}: ${doc.notModified ? "unchanged (304 revalidated)" : "refreshed"} from ${doc.url} (${doc.content.length.toLocaleString()} chars)`
          : `${entry.name}: FAILED — all candidate URLs unreachable`,
      );
    }
  } finally {
    // Round 1 (code-reviewer, B2): NOT inside the loop and NOT skippable on a mid-loop throw.
    // `getLibraryDoc` can throw (EACCES/ENOSPC/EROFS out of `writeCache`/`touchCache`, the same
    // class A5 caught one level up) after it has already replaced an EARLIER library's cache
    // file on disk but before this session's `add()` for that library is flushed — without
    // `finally`, that library's cache holds the NEW document while the index still serves its
    // OLD posting list, exactly the state D-34 exists to prevent. `flush()` is documented safe
    // to call more than once and to no-op on an empty session, so this costs nothing on the
    // ordinary path.
    session.flush();
  }
  recordActivity({
    tool: "refresh",
    library: library !== undefined ? targets[0].name : undefined,
    url: library !== undefined ? single?.url : undefined,
    contentHash: library !== undefined ? single?.contentHash : undefined,
    fresh: library !== undefined && succeeded > 0 ? true : undefined,
    outcome: succeeded > 0 ? "matched" : "not-cached",
  });
  return results.join("\n");
}
