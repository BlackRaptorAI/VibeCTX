import { resolveLibrary, unknownLibraryMessage, type Registry } from "./registry.js";
import { getLibraryDoc } from "./fetcher.js";

/** The MCP `refresh` tool body, kept out of index.ts so it can be exercised without a
 *  transport: force-refetch one library (canonical name or alias) or every library,
 *  one result line each. An unknown name returns the unknown-library text and fetches nothing. */
export async function refreshToolText(registry: Registry, library?: string): Promise<string> {
  let targets;
  if (library !== undefined) {
    const entry = resolveLibrary(registry, library);
    if (!entry) return unknownLibraryMessage(registry, library);
    targets = [entry];
  } else {
    targets = [...registry.entries.values()];
  }
  const results: string[] = [];
  for (const entry of targets) {
    const doc = await getLibraryDoc(entry, { forceRefresh: true });
    results.push(
      doc
        ? `${entry.name}: refreshed from ${doc.url} (${doc.content.length.toLocaleString()} chars)`
        : `${entry.name}: FAILED — all candidate URLs unreachable`,
    );
  }
  return results.join("\n");
}
