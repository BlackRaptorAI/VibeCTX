import { createHash } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { newerSchemaVersion, writeAtomic } from "./atomic-store.js";
import { cacheRoot } from "./cache.js";
import type { DependencyEcosystem } from "./project-deps.js";

/**
 * Project records for `vibectx warm` (PAR-656): `<cacheRoot>/projects/<hash>.json`, one
 * per project directory, shape `{ schemaVersion: 1, dir, manifests, dependencies, warmedAt }`.
 * `hash` is the first 32 hex characters of SHA-256 over the normalised absolute path, so
 * nothing about the path (which may be long, or contain characters the filesystem
 * dislikes) is in the file name.
 *
 * Same discipline as resolved.json: atomic write (temp file + rename), every field
 * re-validated on read, a corrupt file reads as absent. Upgrade policy (K2): a file whose
 * `schemaVersion` is LOWER than ours is ignored on read and replaced on write (an older
 * vibectx wrote it; this version owns the format now); a HIGHER one is ignored on read and
 * never overwritten (a newer vibectx owns it — refuse, with a note on stderr). A record
 * whose `dir` does not equal the directory asked for is treated as absent (the hash is not
 * the identity; the path is).
 *
 * The record is read for one decision only (R3): a dependency it shows `unresolved` with a
 * `failedAt` inside the last 24 h is reported `unresolved (recent)` on the next run without
 * spending a resolution slot, unless `--force`. Nothing else consults it.
 */

/** Bumped when a key is renamed, removed or changes meaning — and when a WarmStatus value is
 *  added or removed (K3): a reader validates `status` against WARM_STATUSES and drops rows
 *  with an unknown one, so a new value under the same version would silently lose rows for
 *  older readers. Version 1 is the first shipped shape (0.2.0). */
export const PROJECT_RECORD_SCHEMA_VERSION = 1;

export type WarmStatus =
  | "cached"
  | "already fresh"
  | "resolved+cached"
  | "unresolved"
  | "unresolved (recent)"
  | "denied (noise list)"
  | "skipped (rate cap)"
  | "unreachable";

export const WARM_STATUSES: readonly WarmStatus[] = [
  "cached",
  "already fresh",
  "resolved+cached",
  "unresolved",
  "unresolved (recent)",
  "denied (noise list)",
  "skipped (rate cap)",
  "unreachable",
];

/** Statuses that mean "get_docs answers this name from disk right now". */
export const CACHED_STATUSES: ReadonlySet<WarmStatus> = new Set(["cached", "already fresh", "resolved+cached"]);

export interface WarmRow {
  /** The dependency as discovered (npm name as written; PyPI name in PEP 503 form). */
  name: string;
  ecosystem: DependencyEcosystem;
  /** Manifest file the name came from, relative to the project directory. */
  source: string;
  /** Registry entry that served it (canonical name), when one did. */
  library?: string;
  status: WarmStatus;
  /** The URL that is (now) cached, when one is. */
  url?: string;
  /** One plain phrase of detail: why unresolved, that a stale copy was kept, … */
  note?: string;
  /** ISO time of the resolution failure behind an `unresolved` / `unresolved (recent)` row —
   *  the memo's clock (R3); carried over unchanged while the memo holds. */
  failedAt?: string;
}

export interface ProjectRecord {
  schemaVersion: typeof PROJECT_RECORD_SCHEMA_VERSION;
  /** Absolute, normalised project directory. */
  dir: string;
  manifests: string[];
  dependencies: WarmRow[];
  /** ISO timestamp of the warm run that wrote the record. */
  warmedAt: string;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isStringList(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((s) => typeof s === "string");
}

/** Normalised absolute form of a project directory — what is hashed and what `dir` holds. */
export function normaliseProjectDir(dir: string): string {
  return resolve(dir);
}

export function projectRecordPath(dir: string): string {
  const hash = createHash("sha256").update(normaliseProjectDir(dir)).digest("hex").slice(0, 32);
  return join(cacheRoot(), "projects", `${hash}.json`);
}

/** Build a row with its keys in the documented order (K1): name, ecosystem, source,
 *  library?, status, url?, note?, failedAt?. Every writer goes through here. */
export function makeWarmRow(fields: {
  name: string;
  ecosystem: DependencyEcosystem;
  source: string;
  library?: string;
  status: WarmStatus;
  url?: string;
  note?: string;
  failedAt?: string;
}): WarmRow {
  const { name, ecosystem, source, library, status } = fields;
  const row: WarmRow = library !== undefined ? { name, ecosystem, source, library, status } : { name, ecosystem, source, status };
  if (fields.url !== undefined) row.url = fields.url;
  if (fields.note !== undefined) row.note = fields.note;
  if (fields.failedAt !== undefined) row.failedAt = fields.failedAt;
  return row;
}

function toWarmRow(raw: unknown): WarmRow | undefined {
  if (!isRecord(raw)) return undefined;
  const { name, ecosystem, source, library, status, url, note, failedAt } = raw;
  if (typeof name !== "string" || name.length === 0 || name.length > 214) return undefined;
  if (ecosystem !== "npm" && ecosystem !== "pypi") return undefined;
  if (typeof source !== "string") return undefined;
  if (typeof status !== "string" || !(WARM_STATUSES as readonly string[]).includes(status)) return undefined; // K3: unknown status → row dropped
  if (failedAt !== undefined && (typeof failedAt !== "string" || Number.isNaN(Date.parse(failedAt)))) return undefined;
  return makeWarmRow({
    name,
    ecosystem,
    source,
    library: typeof library === "string" ? library : undefined,
    status: status as WarmStatus,
    url: typeof url === "string" ? url : undefined,
    note: typeof note === "string" ? note : undefined,
    failedAt: typeof failedAt === "string" ? failedAt : undefined,
  });
}

/** Validate a parsed file into a ProjectRecord for `dir`; undefined when anything essential is off. */
export function toProjectRecord(parsed: unknown, dir: string): ProjectRecord | undefined {
  if (!isRecord(parsed) || parsed.schemaVersion !== PROJECT_RECORD_SCHEMA_VERSION) return undefined;
  if (parsed.dir !== normaliseProjectDir(dir)) return undefined;
  if (!isStringList(parsed.manifests) || !Array.isArray(parsed.dependencies)) return undefined;
  if (typeof parsed.warmedAt !== "string" || Number.isNaN(Date.parse(parsed.warmedAt))) return undefined;
  const dependencies: WarmRow[] = [];
  for (const raw of parsed.dependencies) {
    const row = toWarmRow(raw);
    if (row) dependencies.push(row);
  }
  return { schemaVersion: PROJECT_RECORD_SCHEMA_VERSION, dir: parsed.dir, manifests: parsed.manifests, dependencies, warmedAt: parsed.warmedAt };
}

/** The record for `dir`, or undefined when absent, corrupt, of another schema, or for another dir. */
export function readProjectRecord(dir: string): ProjectRecord | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(projectRecordPath(dir), "utf8"));
  } catch {
    return undefined;
  }
  return toProjectRecord(parsed, dir);
}

/**
 * Write the record for `record.dir` via a temp file and rename (readers see the old or the
 * new file, never a partial one). Returns false, with a note via `warn`, when the file on
 * disk belongs to a NEWER schema version — that file is not ours to rewrite (K2).
 */
export function writeProjectRecord(record: ProjectRecord, warn: (message: string) => void = (m) => process.stderr.write(m)): boolean {
  const dir = normaliseProjectDir(record.dir);
  const path = projectRecordPath(dir);
  mkdirSync(join(cacheRoot(), "projects"), { recursive: true });
  const newer = newerSchemaVersion(path, PROJECT_RECORD_SCHEMA_VERSION);
  if (newer !== undefined) {
    warn(
      `vibectx: not writing the project record for ${dir} — ${path} has a newer schemaVersion ${newer} (this version writes ${PROJECT_RECORD_SCHEMA_VERSION}); upgrade vibectx or delete the file\n`,
    );
    return false;
  }
  const body = JSON.stringify(
    {
      schemaVersion: PROJECT_RECORD_SCHEMA_VERSION,
      dir,
      manifests: record.manifests,
      dependencies: record.dependencies,
      warmedAt: record.warmedAt,
    },
    null,
    2,
  );
  writeAtomic(path, body);
  return true;
}

/** The one line list_libraries appends when a record exists for the working directory. */
export function summariseProjectRecord(record: ProjectRecord): string {
  let cached = 0;
  let denied = 0;
  let unresolved = 0;
  for (const row of record.dependencies) {
    if (CACHED_STATUSES.has(row.status)) cached += 1;
    else if (row.status === "denied (noise list)") denied += 1;
    else unresolved += 1;
  }
  return `Project deps (${record.dir}): ${cached} cached, ${unresolved} unresolved, ${denied} denied — warmed ${record.warmedAt}`;
}
