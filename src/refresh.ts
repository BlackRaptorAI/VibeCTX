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
  // document write (R1, D-34) and stays outside this session — see the branch below.
  const session = openIndexSession();
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
        if (out.chosen) dropFollowedPageCache(entry.name, out.chosen);
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
      // this refresh knows to be current — drop them so the next get_docs re-follows fresh
      // links instead of blending old followed pages with the new primary document. Guarded
      // on `staleNote`: when every candidate URL is unreachable, `getLibraryDoc` re-serves the
      // SAME cached primary it already had (a "success" from this loop's point of view, so the
      // entry is rebuilt rather than left deleted) — nothing about the primary changed, so the
      // pages followed under it are still exactly as valid as before this attempt.
      if (doc.staleNote === undefined) dropFollowedPageCache(entry.name, doc.url);
    }
    results.push(
      doc
        ? `${entry.name}: refreshed from ${doc.url} (${doc.content.length.toLocaleString()} chars)`
        : `${entry.name}: FAILED — all candidate URLs unreachable`,
    );
  }
  session.flush();
  return results.join("\n");
}
