import { mkdirSync, readFileSync, writeFileSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { cacheRoot } from "./cache.js";
import { derivedAllowedHosts, sanitizeRemoteUrl } from "./link-policy.js";
import { npmNameError, pypiNameError } from "./package-names.js";
import type { LibraryEntry, ResolvedMeta } from "./registry.js";

/**
 * Persistence for resolve_library (PAR-655): `<cacheRoot>/resolved.json`, shape
 * `{ schemaVersion: 1, entries: [ { name, urls, description?, resolved } ] }`.
 *
 * The file is a trust boundary — anything in the cache directory can write it — so
 * every record is re-validated on load with the same rules the resolver applies to
 * live metadata, malformed records are skipped, a corrupt file reads as empty, and
 * `allowedHosts` is never read from disk: it is re-derived from the record's
 * homepage / docs URL, so a persisted record cannot widen its own allow-list.
 */

export const RESOLVED_SCHEMA_VERSION = 1;
const FILE_NAME = "resolved.json";
const MAX_URLS = 10;
const MAX_DESCRIPTION = 200;
const METADATA_HOSTS = new Set(["registry.npmjs.org", "pypi.org"]);

export function resolvedStorePath(): string {
  return join(cacheRoot(), FILE_NAME);
}

/** Keep a description to one plain line of at most 200 characters. */
export function cleanDescription(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const oneLine = value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  if (oneLine.length === 0) return undefined;
  return oneLine.length > MAX_DESCRIPTION ? `${oneLine.slice(0, MAX_DESCRIPTION - 1)}…` : oneLine;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Validate one persisted record into a LibraryEntry; undefined when anything essential is off. */
export function toResolvedEntry(record: unknown): LibraryEntry | undefined {
  if (!isRecord(record)) return undefined;
  const { name, urls, description, resolved } = record;
  if (typeof name !== "string" || (npmNameError(name) !== undefined && pypiNameError(name) !== undefined)) return undefined;
  if (!Array.isArray(urls) || urls.length === 0) return undefined;
  const cleanUrls: string[] = [];
  for (const u of urls.slice(0, MAX_URLS)) {
    const ok = sanitizeRemoteUrl(u);
    if (ok === undefined) return undefined; // a bad URL in the probe list is not skipped: the whole record is untrusted
    cleanUrls.push(ok);
  }
  if (!isRecord(resolved)) return undefined;
  if (resolved.source !== "npm" && resolved.source !== "pypi") return undefined;
  if (typeof resolved.resolvedAt !== "string" || Number.isNaN(Date.parse(resolved.resolvedAt))) return undefined;
  const metadataUrl = sanitizeRemoteUrl(resolved.metadataUrl);
  if (metadataUrl === undefined || !METADATA_HOSTS.has(new URL(metadataUrl).hostname)) return undefined;
  const meta: ResolvedMeta = { source: resolved.source, resolvedAt: resolved.resolvedAt, metadataUrl };
  const homepage = sanitizeRemoteUrl(resolved.homepage);
  const docsUrl = sanitizeRemoteUrl(resolved.docsUrl);
  if (homepage) meta.homepage = homepage;
  if (docsUrl) meta.docsUrl = docsUrl;
  const entry: LibraryEntry = { name, urls: cleanUrls, allowedHosts: derivedAllowedHosts(meta), resolved: meta };
  const desc = cleanDescription(description);
  if (desc) entry.description = desc;
  return entry;
}

/** Every valid persisted resolution, in file order; [] when the file is missing, corrupt or of another schema. */
export function readResolvedEntries(): LibraryEntry[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(resolvedStorePath(), "utf8"));
  } catch {
    return [];
  }
  if (!isRecord(parsed) || parsed.schemaVersion !== RESOLVED_SCHEMA_VERSION || !Array.isArray(parsed.entries)) return [];
  const out: LibraryEntry[] = [];
  const seen = new Set<string>();
  for (const raw of parsed.entries) {
    const e = toResolvedEntry(raw);
    if (e && !seen.has(e.name)) {
      seen.add(e.name);
      out.push(e);
    }
  }
  return out;
}

function toRecord(e: LibraryEntry): Record<string, unknown> {
  // allowedHosts is deliberately not written: it is derived on every load.
  return { name: e.name, urls: e.urls, ...(e.description ? { description: e.description } : {}), resolved: e.resolved };
}

/**
 * Persist one resolution: read the current file, replace-or-append by name, write to
 * a temp file in the same directory and rename over the original (readers see the old
 * or the new file, never a partial one). Two processes saving at the same instant can
 * still lose one another's *record* (last writer wins) — acceptable for a single-user
 * local tool; the file is never corrupt.
 */
export function saveResolvedEntry(entry: LibraryEntry): void {
  if (!entry.resolved) throw new Error(`saveResolvedEntry: "${entry.name}" is not a resolved entry`);
  const valid = toResolvedEntry(toRecord(entry));
  if (!valid) throw new Error(`saveResolvedEntry: "${entry.name}" does not pass resolved-record validation`);
  const dir = cacheRoot();
  mkdirSync(dir, { recursive: true });
  const entries = readResolvedEntries();
  const at = entries.findIndex((e) => e.name === valid.name);
  if (at === -1) entries.push(valid);
  else entries[at] = valid;
  const path = resolvedStorePath();
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  const body = JSON.stringify({ schemaVersion: RESOLVED_SCHEMA_VERSION, entries: entries.map(toRecord) }, null, 2);
  try {
    writeFileSync(tmp, body, "utf8");
    renameSync(tmp, path);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}
