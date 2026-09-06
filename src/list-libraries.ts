import { homedir } from "node:os";
import type { Registry } from "./registry.js";
import { describeConfig } from "./config.js";
import { cleanText } from "./project-deps.js";
import { readCache, cacheRoot } from "./cache.js";
import { classifySourceKind } from "./doctor.js";
import { autowarmStatus } from "./autowarm.js";
import { readProjectRecord, summariseProjectRecord } from "./project-store.js";

export interface ListLibrariesOptions {
  /** Directory whose `vibectx warm` record (if any) is summarised on the last line (default: process.cwd()). */
  projectDir?: string;
  /** Entries the startup autowarm has in flight (default: the live set). */
  warming?: ReadonlySet<string>;
  /** Directory the config paths in the header are shown relative to (default: process.cwd()). */
  cwd?: string;
  /** Home directory the header `~`-abbreviates against (default: os.homedir()). */
  home?: string;
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
    // S2 (PAR-657): name, aliases and description come from a config file or a package
    // registry — text this process did not write. Clean every one of them at the point of
    // render, so a terminal escape or a bidi override cannot ride out in a tool answer.
    const aka = e.aliases && e.aliases.length > 0 ? ` (aka ${e.aliases.map(cleanText).join(", ")})` : "";
    const resolved = e.resolved ? " [resolved]" : ""; // synthesized by resolve_library, not curated (PAR-655)
    const description = e.resolved && e.description ? `(package-supplied) ${e.description}` : (e.description ?? "");
    return `- **${cleanText(e.name)}**${aka} — ${cleanText(description)} [${status}] [${kind}]${resolved}`;
  });
  const record = readProjectRecord(opts.projectDir ?? process.cwd());
  const footer = record ? `\n\n${summariseProjectRecord(record)}` : "";
  // D-18 (PAR-657): which config files this server actually loaded, in precedence order,
  // then any deprecation / ignored-file note. A hand-built registry has no resolution to
  // report, so it keeps the 0.1.x header.
  const header = registry.config
    ? describeConfig(registry.config, { cwd: opts.cwd ?? process.cwd(), home: opts.home ?? homedir() })
    : [];
  return `${[...header, `Cache dir: ${cacheRoot()}`].join("\n")}\n\n${rows.join("\n")}${footer}`;
}
