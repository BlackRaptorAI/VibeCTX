import { installResolvedEntry, resolveLibrary, unknownLibraryMessage, type LibraryEntry, type Registry } from "./registry.js";
import { getLibraryDoc } from "./fetcher.js";
import { resolvePackage } from "./resolve.js";
import { indexCachedDocument, invalidateIndex } from "./search-index.js";

/** The MCP `refresh` tool body, kept out of index.ts so it can be exercised without a
 *  transport: force-refetch one library (canonical name or alias) or every library,
 *  one result line each. An unknown name returns the unknown-library text and fetches
 *  nothing (refresh never resolves new names — get_docs and resolve_library do that).
 *  A resolved entry (PAR-655) is re-resolved through its ecosystem, so a project that
 *  has since published llms.txt or moved its homepage is picked up; on failure the
 *  old entry stays. */
export async function refreshToolText(registry: Registry, library?: string): Promise<string> {
  let targets: LibraryEntry[];
  if (library !== undefined) {
    const entry = resolveLibrary(registry, library);
    if (!entry) return unknownLibraryMessage(registry, library);
    targets = [entry];
  } else {
    targets = [...registry.entries.values()];
  }
  const results: string[] = [];
  for (const entry of targets) {
    // D-34 (PAR-659): refresh INVALIDATES this library's search-index entry before it refetches.
    // Deleting rather than rebuilding is deliberate — a refresh may fail, and a deleted entry
    // cannot be stale, while one rebuilt from a document the refresh did not replace is work
    // done twice. The next write (get_docs, warm, autowarm) or the next `search` rebuilds it
    // from whatever the cache then holds.
    invalidateIndex(entry.name);
    if (entry.resolved) {
      const out = await resolvePackage(entry.name, { ecosystem: entry.resolved.source });
      if (out.ok && out.entry) {
        if (!installResolvedEntry(registry, out.entry)) {
          results.push(
            `${entry.name}: not replaced — "${out.entry.name}" is a curated entry (default, config or alias); a resolved record cannot override it`,
          );
          continue;
        }
        results.push(
          `${entry.name}: re-resolved via ${entry.resolved.source} — refreshed from ${out.chosen} (${(out.chars ?? 0).toLocaleString()} chars)`,
        );
      } else {
        results.push(`${entry.name}: FAILED — ${out.text}`);
      }
      continue;
    }
    const doc = await getLibraryDoc(entry, { forceRefresh: true });
    // D-34's other half: refresh is also a WRITER of a primary document, so a refresh that
    // succeeded leaves the index rebuilt rather than merely emptied. A refresh that failed
    // leaves it empty, which is the safe state — nothing stale can be served from it.
    if (doc) indexCachedDocument(entry.name, doc.url, doc.content);
    results.push(
      doc
        ? `${entry.name}: refreshed from ${doc.url} (${doc.content.length.toLocaleString()} chars)`
        : `${entry.name}: FAILED — all candidate URLs unreachable`,
    );
  }
  return results.join("\n");
}
