import type { Registry } from "./registry.js";
import { readCache, cacheRoot } from "./cache.js";
import { classifySourceKind } from "./doctor.js";

/** The list_libraries tool body. One line per library: description, cache status,
 *  and the source kind classified from the cached document (`unknown` until cached;
 *  `vibectx doctor` fetches and probes). Never touches the network. */
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
    return `- **${e.name}** — ${e.description ?? ""} [${status}] [${kind}]`;
  });
  return `Cache dir: ${cacheRoot()}\n\n${rows.join("\n")}`;
}
