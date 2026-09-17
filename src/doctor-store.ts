import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { newerSchemaVersion, writeAtomic } from "./atomic-store.js";
import { cacheRoot } from "./cache.js";
import { clipText } from "./text.js";
import type { SourceKind } from "./source-kind.js";

/**
 * Persistence for `vibectx doctor`'s per-library verdict (A19/PAR-728): `<cacheRoot>/doctor.json`,
 * shape `{ schemaVersion: 1, verdicts: [ { name, kind, healthy, reasons, checkedAt } ] }`.
 *
 * `runDoctor` computes `LibraryReport[]` fresh, in memory, on every call — nothing persisted it
 * before this. Without a persisted verdict, `list_libraries` and `get_docs` have no way to warn
 * that a library which LOOKS cached and healthy actually failed its last probe (the PAR-704
 * fastify shape: index-only, topic queries return "No sections matched", yet `list_libraries`
 * reported it cached with no error) short of re-running a probe on every call — which
 * `list_libraries` is documented never to do (it touches only the cache) and `get_docs` cannot
 * afford per response. So doctor's verdict is written here once, and read back cheaply.
 *
 * The file is a trust boundary (K1, mirroring `resolved-store.ts`): anything with write access
 * to the cache directory can edit it, so every record is re-validated field by field on read,
 * a malformed record is dropped rather than partially trusted, and a corrupt file reads as
 * empty rather than throwing. `reasons` in particular passes through `clipText` here even
 * though `doctor.ts` already builds them from bounded pieces — a persisted copy of them is a
 * second place a forged value could arrive from, so it gets the same cleaning `resolved-store.ts`
 * applies to persisted, previously-untrusted text (D-48).
 */

export const DOCTOR_STORE_SCHEMA_VERSION = 1;
const FILE_NAME = "doctor.json";
const SOURCE_KINDS: readonly SourceKind[] = ["full-text", "index-only", "readme", "unreachable"];
const MAX_NAME_CHARS = 300;
const MAX_REASON_CHARS = 300;
const MAX_REASONS = 10;

export interface DoctorVerdict {
  name: string;
  kind: SourceKind;
  healthy: boolean;
  reasons: string[];
  /** ISO, when this verdict was computed (`DoctorReport.generatedAt`). */
  checkedAt: string;
}

export function doctorStorePath(): string {
  return join(cacheRoot(), FILE_NAME);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** K1: every field re-checked against its own rule; the whole record is dropped, never
 *  partially trusted, the moment one field fails. */
function toDoctorVerdict(raw: unknown): DoctorVerdict | undefined {
  if (!isRecord(raw)) return undefined;
  const { name, kind, healthy, reasons, checkedAt } = raw;
  if (typeof name !== "string" || name.length === 0 || name.length > MAX_NAME_CHARS) return undefined;
  if (typeof kind !== "string" || !SOURCE_KINDS.includes(kind as SourceKind)) return undefined;
  if (typeof healthy !== "boolean") return undefined;
  if (typeof checkedAt !== "string" || Number.isNaN(Date.parse(checkedAt))) return undefined;
  const cleanReasons = Array.isArray(reasons)
    ? reasons
        .filter((r): r is string => typeof r === "string")
        .slice(0, MAX_REASONS)
        .map((r) => clipText(r, MAX_REASON_CHARS))
    : [];
  return { name, kind: kind as SourceKind, healthy, reasons: cleanReasons, checkedAt };
}

/** Every persisted verdict, keyed by library name. A corrupt file, a schema mismatch, or any
 *  read error all read as empty (K1) — a missing verdict means "doctor has not reported on this
 *  library," never a crash for a caller on the get_docs / list_libraries hot path. */
export function readDoctorVerdicts(): Map<string, DoctorVerdict> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(doctorStorePath(), "utf8"));
  } catch {
    return new Map();
  }
  if (!isRecord(parsed) || parsed.schemaVersion !== DOCTOR_STORE_SCHEMA_VERSION || !Array.isArray(parsed.verdicts)) {
    return new Map();
  }
  const out = new Map<string, DoctorVerdict>();
  for (const raw of parsed.verdicts) {
    const v = toDoctorVerdict(raw);
    if (v) out.set(v.name, v);
  }
  return out;
}

function toRecord(v: DoctorVerdict): Record<string, unknown> {
  return { name: v.name, kind: v.kind, healthy: v.healthy, reasons: v.reasons, checkedAt: v.checkedAt };
}

/** Merge `verdicts` into the persisted store, replacing any existing entry for the same name
 *  and leaving every other library's last verdict untouched (a `--library` doctor run must not
 *  erase what a full run already recorded for the rest of the registry). Best effort (D-13):
 *  doctor's own report is computed and returned regardless of whether this succeeds, so a
 *  write failure is reported via `warn`, never thrown. K2: a file with a NEWER schemaVersion
 *  than this process knows was written by a newer vibectx and is left alone. */
export function saveDoctorVerdicts(verdicts: DoctorVerdict[], warn: (message: string) => void = () => {}): void {
  if (verdicts.length === 0) return;
  try {
    const path = doctorStorePath();
    mkdirSync(cacheRoot(), { recursive: true });
    const newer = newerSchemaVersion(path, DOCTOR_STORE_SCHEMA_VERSION);
    if (newer !== undefined) {
      warn(`vibectx: not saving doctor verdicts — ${path} has a newer schemaVersion ${newer}; upgrade vibectx or delete the file\n`);
      return;
    }
    const existing = readDoctorVerdicts();
    for (const v of verdicts) existing.set(v.name, v);
    writeAtomic(
      path,
      JSON.stringify({ schemaVersion: DOCTOR_STORE_SCHEMA_VERSION, verdicts: [...existing.values()].map(toRecord) }, null, 2),
    );
  } catch (e) {
    warn(`vibectx: doctor verdicts not saved: ${e instanceof Error ? e.message : String(e)}\n`);
  }
}
