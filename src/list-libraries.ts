import { homedir } from "node:os";
import type { Registry } from "./registry.js";
import { describeConfig } from "./config.js";
import { clipText } from "./text.js";
import { readCache, cacheRoot } from "./cache.js";
import { classifySourceKind } from "./source-kind.js";
import { autowarmStatus } from "./autowarm-status.js";
import { readProjectRecord, summariseProjectRecord } from "./project-store.js";
import { readDoctorVerdicts } from "./doctor-store.js";

/** Longest config- or registry-supplied field (name, one alias, description) in one row.
 *  A row is a one-line summary; anything longer is a payload, not a description. ASSUMED. */
export const MAX_LIBRARY_FIELD_CHARS = 200;

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
 *  entries resolve_library synthesized, and (A19/PAR-728) a `[doctor: ...]` note when the last
 *  `vibectx doctor` run found the entry unhealthy — e.g. index-only with no link followed
 *  successfully, or a probe that returned no match — a fact the cache-status and kind brackets
 *  alone do not carry (PAR-704: a source can be cleanly cached and still fail every probe).
 *  Absent entirely when doctor has never checked the entry, so "no note" never overclaims
 *  health the way `unknown` for the kind bracket already declines to. When `vibectx warm` has
 *  a record for the working directory, one closing line summarises it. Never touches the
 *  network. */
export function listLibrariesText(registry: Registry, opts: ListLibrariesOptions = {}): string {
  const warming = opts.warming ?? autowarmStatus().inFlight;
  const doctorVerdicts = readDoctorVerdicts();
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
    // render, so a terminal escape or a bidi override cannot ride out in a tool answer —
    // and CLIP them, because cleaning leaves length: a 5 KB `description` in one entry
    // would otherwise bury the other rows of the answer in a client's log pane.
    const show = (s: string): string => clipText(s, MAX_LIBRARY_FIELD_CHARS);
    const aka = e.aliases && e.aliases.length > 0 ? ` (aka ${e.aliases.map(show).join(", ")})` : "";
    const resolved = e.resolved ? " [resolved]" : ""; // synthesized by resolve_library, not curated (PAR-655)
    const description = e.resolved && e.description ? `(package-supplied) ${e.description}` : (e.description ?? "");
    // A19/PAR-728 — `doctorVerdicts` is already clean/clipped on its own read boundary
    // (doctor-store.ts's K1), but every field in this row is clipped again HERE regardless of
    // where it came from (S2's own rule), so this is no exception.
    const verdict = doctorVerdicts.get(e.name);
    const doctorNote = verdict && !verdict.healthy ? ` [doctor: ${show(verdict.reasons[0] ?? "unhealthy")}]` : "";
    return `- **${show(e.name)}**${aka} — ${show(description)} [${status}] [${kind}]${resolved}${doctorNote}`;
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
