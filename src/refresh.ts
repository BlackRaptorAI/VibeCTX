import { installResolvedEntry, resolveLibrary, unknownLibraryMessage, type LibraryEntry, type Registry } from "./registry.js";
import { getLibraryDoc } from "./fetcher.js";
import { resolvePackage } from "./resolve.js";
import { invalidateIndex, openIndexSession } from "./search-index.js";
import { dropFollowedPageCache } from "./cache.js";
import { MAX_FULL_REFRESHES_PER_HOUR } from "./limits.js";
import { createSlidingWindowLimiter } from "./rate-limit.js";

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
 *  old entry stays. */
export async function refreshToolText(registry: Registry, library?: string, opts: { now?: () => Date } = {}): Promise<string> {
  let targets: LibraryEntry[];
  if (library !== undefined) {
    const entry = resolveLibrary(registry, library);
    if (!entry) return unknownLibraryMessage(registry, library);
    targets = [entry];
  } else {
    const now = opts.now ?? (() => new Date());
    if (!fullRefreshLimiter.take(now().getTime())) {
      return `refresh limit reached (${MAX_FULL_REFRESHES_PER_HOUR} full refreshes per hour per process); try again later, or refresh one library at a time`;
    }
    targets = [...registry.entries.values()];
  }
  const results: string[] = [];
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
          // UNGUARDED, unlike the direct-fetch branch below: `ResolveOutcome` carries no
          // staleness signal (no `staleNote` equivalent), so a re-resolution that only reached
          // a stale-cache fallback still drops followed pages here — disclosed, not fixed (see
          // `dropFollowedPageCache`'s own doc comment); fixing it needs a `resolve.ts` change
          // out of this item's scope.
          if (out.chosen) dropFollowedPageCache(entry.name, [out.chosen, ...out.entry.urls]);
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
        // followed pages with the new primary document. Guarded on `staleNote`, but only
        // PARTIALLY (round 1, S1): when every candidate URL is unreachable, `getLibraryDoc`
        // re-serves the SAME cached primary with `staleNote` SET, and this correctly skips the
        // drop. A 304 Not-Modified revalidation, though, returns the SAME content with NO
        // `staleNote` — indistinguishable here from a genuine fresh fetch — so an unchanged
        // primary still drops its followed pages on every revalidated refresh, which is the
        // COMMON case for a scheduled full refresh against docs sites that mostly haven't
        // changed. Disclosed, not fixed: distinguishing the two needs a `DocResult` field this
        // item does not add, because `fetcher.ts` is a Tier-2/3 gated path this item does not
        // otherwise touch and touching it would pull in a Change Record this item does not
        // otherwise need. Round 2 (code-reviewer, SF-1): this is a REAL cost, not only a
        // wasted re-fetch — MEASURED, a dropped page that used to be served flagged `STALE:`
        // during an upstream outage or under `offline` now reports "Could not fetch N index
        // links" instead (fetcher.ts:330-331 has nothing left to fall back to). Never served
        // WRONG, so not a correctness bug, but not free, and it lands on the COMMON case above
        // — see `dropFollowedPageCache`'s own doc comment for the full disposition.
        if (doc.staleNote === undefined) dropFollowedPageCache(entry.name, [doc.url, ...entry.urls]);
      }
      results.push(
        doc
          ? `${entry.name}: refreshed from ${doc.url} (${doc.content.length.toLocaleString()} chars)`
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
  return results.join("\n");
}
