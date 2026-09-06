import type { Registry } from "./registry.js";
import { readCache, cacheRoot } from "./cache.js";
import { classifySourceKind } from "./doctor.js";
import { autowarmStatus } from "./autowarm.js";
import { readProjectRecord, summariseProjectRecord } from "./project-store.js";

export interface ListLibrariesOptions {
  /** Directory whose `vibectx warm` record (if any) is summarised on the last line (default: process.cwd()). */
  projectDir?: string;
  /** Entries the startup autowarm has in flight (default: the live set). */
  warming?: ReadonlySet<string>;
}

/** The list_libraries tool body. One line per library: name (plus `(aka …)` when it has
 *  aliases), description, cache status — with `warming…` while the startup autowarm is
 *  fetching that entry (PAR-656) — the source kind classified from the cached document
 *  (`unknown` until cached; `vibectx doctor` fetches and probes), and `[resolved]` for
 *  entries resolve_library synthesized. When `vibectx warm` has a record for the working
 *  directory, one closing line summarises it. Never touches the network. */
export function listLibrariesText(registry: Registry, opts: ListLibrariesOptions = {}): string {
  const warming = opts.warming ?? autowarmStatus().inFlight;
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
    const base = cached ? `cached ${cached.meta.fetchedAt}${cached.stale ? " (stale)" : ""}` : "not cached";
    const status = warming.has(e.name) ? `${base}, warming…` : base;
    const kind = cached && cachedUrl ? classifySourceKind(cachedUrl, cached.content) : "unknown";
    const aka = e.aliases && e.aliases.length > 0 ? ` (aka ${e.aliases.join(", ")})` : "";
    const resolved = e.resolved ? " [resolved]" : ""; // synthesized by resolve_library, not curated (PAR-655)
    const description = e.resolved && e.description ? `(package-supplied) ${e.description}` : (e.description ?? "");
    return `- **${e.name}**${aka} — ${description} [${status}] [${kind}]${resolved}`;
  });
  const record = readProjectRecord(opts.projectDir ?? process.cwd());
  const footer = record ? `\n\n${summariseProjectRecord(record)}` : "";
  return `Cache dir: ${cacheRoot()}\n\n${rows.join("\n")}${footer}`;
}
