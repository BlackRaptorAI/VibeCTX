import { createHash } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { newerSchemaVersion, writeAtomic } from "./atomic-store.js";
import { cacheRoot } from "./cache.js";
import { sanitizeRemoteUrl } from "./link-policy.js";
import { cleanText, type DependencyEcosystem } from "./project-deps.js";

/**
 * Project records for `vibectx warm` (PAR-656): `<cacheRoot>/projects/<hash>.json`, one
 * per project directory, shape `{ schemaVersion: 1, dir, manifests, dependencies, warmedAt }`.
 * `hash` is the first 32 hex characters of SHA-256 over the normalised absolute path, so
 * nothing about the path (which may be long, or contain characters the filesystem
 * dislikes) is in the file name.
 *
 * Same discipline as resolved.json — and the same reason: the cache directory is a trust
 * boundary, so the file is written atomically (temp file + rename) and EVERY field is
 * re-validated on read against the rule that field has, not merely typechecked. In full
 * (K1): `schemaVersion` must equal ours, `dir` must equal the directory asked for,
 * `manifests` must be an array of bounded strings (each cleaned), `warmedAt` must be a strict
 * ISO-8601 UTC instant (`Date.parse` alone accepts `2020-01-01 (‮evil)`, and that string
 * lands verbatim in the list_libraries footer), and `dependencies` must be an array — any of
 * those failing makes the record absent. Then, per row: `name` 1…214 characters, `ecosystem`
 * exactly npm or pypi, `source` a relative manifest path (bounded, no absolute path, no `..`
 * segment — any alphabet),
 * `status` one of WARM_STATUSES and `failedAt` a strict ISO-8601 instant when present — each
 * of those failing drops the ROW; `library`
 * over 214 characters and a `url` that is not an https URL passing `sanitizeRemoteUrl` drop
 * that FIELD; a `note` over 512 characters is truncated. Every surviving string passes
 * through `cleanText`. A corrupt file reads as absent. Upgrade policy (K2): a file whose
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

/**
 * Build a row with its keys in the documented order (K1): name, ecosystem, source, library?,
 * status, url?, note?, failedAt?. Every writer goes through here, which makes it the one
 * place S3 has to hold: each free-text field passes through `cleanText`, so a control, bidi
 * or zero-width character out of a manifest, a resolver message or a previous project record
 * cannot reach the table, the tool's text, OR the `--json` report — the renderers clean
 * again, but the JSON has no renderer to clean it.
 */
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
  const { ecosystem, status } = fields;
  const name = cleanText(fields.name);
  const source = cleanText(fields.source);
  const library = fields.library === undefined ? undefined : cleanText(fields.library);
  const row: WarmRow = library !== undefined ? { name, ecosystem, source, library, status } : { name, ecosystem, source, status };
  if (fields.url !== undefined) row.url = cleanText(fields.url);
  if (fields.note !== undefined) row.note = cleanText(fields.note);
  if (fields.failedAt !== undefined) row.failedAt = fields.failedAt;
  return row;
}

/** Longest `name` / `library`: npm's published package-name limit. */
const MAX_NAME = 214;
/** Longest `source`: a manifest file name, possibly one directory deep. */
const MAX_SOURCE = 256;
/** Longest `note`: one plain phrase of detail, truncated with an ellipsis past this. */
export const MAX_NOTE = 512;

/**
 * A `source` is a manifest file name relative to the project directory — `package.json`,
 * `requirements-dev.txt`, `sub/requirements.txt`. The reader refuses it for what it DOES,
 * never for its alphabet: a real project directory may be named `треб/`, `req dir/` or
 * `req+dev/`, and an allow-list of ASCII punctuation would drop those rows as if the file
 * were hostile. So the rule is the property that matters — the path must be RELATIVE and must
 * not traverse — checked on the CLEANED text, since `cleanText` is what the row will actually
 * carry (`a U+200B before /etc/passwd` cleans to an absolute path and must be refused as one):
 *
 *   - no NUL in the raw value (`cleanText` would strip it, hiding a truncation trick),
 *   - bounded by MAX_SOURCE and non-empty once cleaned,
 *   - not absolute: no leading `/`, no leading `\` (a Windows root or a `\\server\share` UNC),
 *     no `X:` drive prefix,
 *   - no `..` segment, splitting on BOTH separators — `a/../b` and `a\..\b` alike.
 *
 * Failure drops the ROW. This is a read-side gate only: writers go through `makeWarmRow`, and
 * a source discovered on this machine is never validated on the way out — a path we can read
 * is a path we can record.
 */
const WINDOWS_DRIVE = /^[A-Za-z]:/;
function validSource(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_SOURCE) return false;
  if (value.includes("\u0000")) return false;
  const text = cleanText(value);
  if (text.length === 0) return false;
  if (text.startsWith("/") || text.startsWith("\\") || WINDOWS_DRIVE.test(text)) return false;
  return !text.split(/[/\\]/).includes("..");
}

/**
 * A UTC ISO-8601 instant exactly as `Date.prototype.toISOString` writes it — the only shape
 * anything here ever produces. `Date.parse` alone is far too lenient to validate a timestamp
 * off a trust boundary: it accepts `2020-01-01 (‮evil)`, comment and bidi override and
 * all, and that string is rendered verbatim in the list_libraries footer. Shape first, then
 * `Date.parse` to reject a well-shaped impossibility like `2026-13-45T06:00:00Z`.
 */
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
function validIsoInstant(value: unknown): value is string {
  return typeof value === "string" && ISO_INSTANT.test(value) && Number.isFinite(Date.parse(value));
}

/**
 * `manifests` is descriptive — it is echoed, never opened — so each entry is bounded and
 * CLEANED rather than dropped: losing an entry would misreport what the run read, while a
 * bidi override in one must never survive into anything that renders it. An entry that is
 * empty, over the cap, or empty once cleaned makes the record absent: our writer never
 * produces one, so the file is not ours.
 */
function cleanManifests(value: unknown): string[] | undefined {
  if (!isStringList(value)) return undefined;
  const out: string[] = [];
  for (const raw of value) {
    if (raw.length === 0 || raw.length > MAX_SOURCE) return undefined;
    const text = cleanText(raw);
    if (text.length === 0) return undefined;
    out.push(text);
  }
  return out;
}

/** One plain line of at most MAX_NOTE characters; truncated, never dropped — the reason a
 *  name failed is worth showing even when whatever wrote the file was over-generous. */
function cleanNote(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  const text = cleanText(value);
  if (text.length === 0) return undefined;
  return text.length > MAX_NOTE ? `${text.slice(0, MAX_NOTE - 1)}…` : text;
}

/**
 * Validate one persisted row (K1). The file is a trust boundary — anything with write access
 * to the cache directory can put a row here, and every field lands in a table a person and a
 * model both read — so each field is re-validated with the rule that field actually has:
 *
 *   name       required, 1…214 characters       — row dropped otherwise
 *   ecosystem  exactly "npm" or "pypi"          — row dropped otherwise
 *   source     a relative, non-traversing path  — row dropped otherwise (see validSource:
 *              ≤ 256 characters, non-empty once cleaned, no NUL, not absolute (no leading
 *              `/` or `\`, no `X:` drive), no `..` segment on either separator. Any other
 *              character is fine — `треб/extra.txt` is a real manifest path, not an attack.)
 *   status     one of WARM_STATUSES             — row dropped otherwise (K3)
 *   failedAt   a strict ISO-8601 instant when present — row dropped otherwise
 *   library    1…214 characters                 — FIELD dropped otherwise
 *   url        passes sanitizeRemoteUrl (https, no credentials, no forbidden host)
 *                                               — FIELD dropped otherwise
 *   note       ≤ 512 characters                 — TRUNCATED, never dropped
 *
 * Every surviving string also passes through `cleanText`, so no control, bidi or zero-width
 * character reaches the renderer (S3).
 */
function toWarmRow(raw: unknown): WarmRow | undefined {
  if (!isRecord(raw)) return undefined;
  const { name, ecosystem, source, library, status, url, note, failedAt } = raw;
  if (typeof name !== "string" || name.length === 0 || name.length > MAX_NAME) return undefined;
  if (ecosystem !== "npm" && ecosystem !== "pypi") return undefined;
  if (!validSource(source)) return undefined;
  if (typeof status !== "string" || !(WARM_STATUSES as readonly string[]).includes(status)) return undefined; // K3: unknown status → row dropped
  if (failedAt !== undefined && !validIsoInstant(failedAt)) return undefined;
  return makeWarmRow({
    name,
    ecosystem,
    source,
    library: typeof library === "string" && library.length > 0 && library.length <= MAX_NAME ? library : undefined,
    status: status as WarmStatus,
    url: sanitizeRemoteUrl(url),
    note: cleanNote(note),
    failedAt: typeof failedAt === "string" ? failedAt : undefined,
  });
}

/**
 * Validate a parsed file into a ProjectRecord for `dir`; undefined when anything essential is
 * off. Every string here either reaches the list_libraries footer (`dir`, `warmedAt`) or is
 * of the same kind as one that does (`manifests`), so each is checked against its actual
 * rule: `warmedAt` a strict ISO-8601 instant (record absent otherwise) and `manifests`
 * bounded and cleaned. `dir` must equal the directory asked for, so it is whatever the
 * caller's own path is — it is cleaned at the render boundary, not refused here.
 */
export function toProjectRecord(parsed: unknown, dir: string): ProjectRecord | undefined {
  if (!isRecord(parsed) || parsed.schemaVersion !== PROJECT_RECORD_SCHEMA_VERSION) return undefined;
  if (parsed.dir !== normaliseProjectDir(dir)) return undefined;
  const manifests = cleanManifests(parsed.manifests);
  if (manifests === undefined || !Array.isArray(parsed.dependencies)) return undefined;
  if (!validIsoInstant(parsed.warmedAt)) return undefined;
  const dependencies: WarmRow[] = [];
  for (const raw of parsed.dependencies) {
    const row = toWarmRow(raw);
    if (row) dependencies.push(row);
  }
  return { schemaVersion: PROJECT_RECORD_SCHEMA_VERSION, dir: parsed.dir, manifests, dependencies, warmedAt: parsed.warmedAt };
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

/** The one line list_libraries appends when a record exists for the working directory. S3:
 *  `dir` and `warmedAt` pass through `cleanText` here as well as being validated on read —
 *  this function is the render boundary, and it must hold for any ProjectRecord it is handed,
 *  not only for one that came back through `toProjectRecord`. */
export function summariseProjectRecord(record: ProjectRecord): string {
  let cached = 0;
  let denied = 0;
  let unresolved = 0;
  for (const row of record.dependencies) {
    if (CACHED_STATUSES.has(row.status)) cached += 1;
    else if (row.status === "denied (noise list)") denied += 1;
    else unresolved += 1;
  }
  return `Project deps (${cleanText(record.dir)}): ${cached} cached, ${unresolved} unresolved, ${denied} denied — warmed ${cleanText(record.warmedAt)}`;
}
