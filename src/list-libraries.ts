import type { Registry } from "./registry.js";
import { readCache, cacheRoot } from "./cache.js";
import { classifySourceKind } from "./doctor.js";

/** The list_libraries tool body. One line per library: name (plus `(aka …)` when it has
 *  aliases), description, cache status, the source kind classified from the cached
 *  document (`unknown` until cached; `vibectx doctor` fetches and probes), and `[resolved]`
 *  for entries resolve_library synthesized. Never touches the network. */
export function listLibrariesText(registry: Registry): string {
  const rows = [...registry.entries.values()].map((e) => {
    const ttl = e.ttlHours ?? 168;
    let cached: ReturnType<typeof readCache>;
    let cachedUrl: string | undefined;
    for (const u of e.urls) {
      cached = readCache(e.name, u, ttl);
      if (cached) {
        cachedUrl = u;
        break;
      }
    }
    const status = cached
      ? `cached ${cached.meta.fetchedAt}${cached.stale ? " (stale)" : ""}`
      : "not cached";
    const kind = cached && cachedUrl ? classifySourceKind(cachedUrl, cached.content) : "unknown";
    const aka = e.aliases && e.aliases.length > 0 ? ` (aka ${e.aliases.join(", ")})` : "";
    const resolved = e.resolved ? " [resolved]" : ""; // synthesized by resolve_library, not curated (PAR-655)
    return `- **${e.name}**${aka} — ${e.description ?? ""} [${status}] [${kind}]${resolved}`;
  });
  return `Cache dir: ${cacheRoot()}\n\n${rows.join("\n")}`;
}
