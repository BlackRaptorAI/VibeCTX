import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { doctorStorePath, readDoctorVerdicts, saveDoctorVerdicts, DOCTOR_STORE_SCHEMA_VERSION, type DoctorVerdict } from "../src/doctor-store.js";
import { MAX_DOCTOR_VERDICTS } from "../src/limits.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "vibectx-doctor-store-"));
  process.env.VIBECTX_CACHE_DIR = dir;
});

afterEach(() => {
  delete process.env.VIBECTX_CACHE_DIR;
  rmSync(dir, { recursive: true, force: true });
});

const verdict = (over: Partial<DoctorVerdict> = {}): DoctorVerdict => ({
  name: "fastify",
  kind: "index-only",
  healthy: false,
  reasons: ["index-only, no links followed (answered from the link list at best)"],
  checkedAt: "2026-09-17T00:00:00.000Z",
  ...over,
});

describe("doctorStorePath", () => {
  it("is doctor.json under the cache root", () => {
    expect(doctorStorePath()).toBe(join(dir, "doctor.json"));
  });
});

describe("readDoctorVerdicts", () => {
  it("returns an empty map when nothing has been saved", () => {
    expect(readDoctorVerdicts().size).toBe(0);
  });

  it("returns an empty map for a corrupt file, without throwing", () => {
    writeFileSync(doctorStorePath(), "{ not json", "utf8");
    expect(() => readDoctorVerdicts()).not.toThrow();
    expect(readDoctorVerdicts().size).toBe(0);
  });

  it("returns an empty map for a file with a different schemaVersion shape (K1)", () => {
    writeFileSync(doctorStorePath(), JSON.stringify({ schemaVersion: 1, verdicts: "not an array" }), "utf8");
    expect(readDoctorVerdicts().size).toBe(0);
  });

  it("round-trips a saved verdict", () => {
    saveDoctorVerdicts([verdict()]);
    const out = readDoctorVerdicts();
    expect(out.get("fastify")).toEqual(verdict());
  });

  function seedRaw(verdicts: unknown[]) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(doctorStorePath(), JSON.stringify({ schemaVersion: DOCTOR_STORE_SCHEMA_VERSION, verdicts }), "utf8");
  }

  it("K1: drops a record with an invalid kind, missing name, non-boolean healthy, or unparseable checkedAt — one bad field drops the whole record, not just that field", () => {
    seedRaw([
      { name: "ok", kind: "full-text", healthy: true, reasons: [], checkedAt: "2026-09-17T00:00:00.000Z" },
      { name: "bad-kind", kind: "made-up", healthy: true, reasons: [], checkedAt: "2026-09-17T00:00:00.000Z" },
      { kind: "full-text", healthy: true, reasons: [], checkedAt: "2026-09-17T00:00:00.000Z" },
      { name: "bad-healthy", kind: "full-text", healthy: "yes", reasons: [], checkedAt: "2026-09-17T00:00:00.000Z" },
      { name: "bad-date", kind: "full-text", healthy: true, reasons: [], checkedAt: "not a date" },
    ]);
    expect([...readDoctorVerdicts().keys()]).toEqual(["ok"]);
  });

  it("K1: drops a record whose name is not already trim().toLowerCase()'d — a persisted \"React\" can never shadow \"react\" (mirrors resolved-store.ts's S2)", () => {
    seedRaw([{ name: "React", kind: "full-text", healthy: true, reasons: [], checkedAt: "2026-09-17T00:00:00.000Z" }]);
    expect(readDoctorVerdicts().size).toBe(0);
  });

  it("K1: drops a record whose checkedAt has an oversized fractional-seconds run — Date.parse alone is not a length backstop (security-architect S-3a)", () => {
    seedRaw([
      { name: "acme", kind: "full-text", healthy: true, reasons: [], checkedAt: `2026-09-17T00:00:00.${"1".repeat(10_000)}Z` },
    ]);
    expect(readDoctorVerdicts().size).toBe(0);
  });

  it("K1: drops the WHOLE record when one reasons element is not a string, rather than filtering just that element (security-architect N-2)", () => {
    seedRaw([{ name: "acme", kind: "index-only", healthy: false, reasons: ["ok reason", 42], checkedAt: "2026-09-17T00:00:00.000Z" }]);
    expect(readDoctorVerdicts().size).toBe(0);
  });

  it("K1: drops the whole record when the raw reasons array is absurdly long, rather than validating all of it (security-architect N-3)", () => {
    seedRaw([{ name: "acme", kind: "index-only", healthy: false, reasons: Array.from({ length: 5000 }, (_, i) => `r${i}`), checkedAt: "2026-09-17T00:00:00.000Z" }]);
    expect(readDoctorVerdicts().size).toBe(0);
  });

  it("K1: cleans and clips reasons on read — control characters removed, over-long entries clipped, extras beyond MAX_REASONS dropped", () => {
    seedRaw([
      {
        name: "acme",
        kind: "index-only",
        healthy: false,
        reasons: [`bad[31m ${"x".repeat(400)}`, ...Array.from({ length: 20 }, (_, i) => `reason ${i}`)],
        checkedAt: "2026-09-17T00:00:00.000Z",
      },
    ]);
    const out = readDoctorVerdicts().get("acme")!;
    expect(out.reasons[0]).not.toMatch(/[\x00-\x1f\x7f-\x9f]/);
    expect(out.reasons[0].length).toBeLessThanOrEqual(300);
    expect(out.reasons[0].endsWith("…")).toBe(true);
    expect(out.reasons).toHaveLength(10); // MAX_REASONS
  });
});

describe("saveDoctorVerdicts", () => {
  it("does nothing for an empty list — no file is created, and it reports success", () => {
    expect(saveDoctorVerdicts([])).toBe(true);
    expect(readDoctorVerdicts().size).toBe(0);
  });

  it("returns true on a successful write", () => {
    expect(saveDoctorVerdicts([verdict()])).toBe(true);
  });

  it("merges by name: saving one library's verdict leaves another library's last verdict untouched", () => {
    saveDoctorVerdicts([verdict({ name: "react", kind: "full-text", healthy: true, reasons: [] })]);
    saveDoctorVerdicts([verdict({ name: "fastify" })]);
    const out = readDoctorVerdicts();
    expect(out.get("react")?.healthy).toBe(true);
    expect(out.get("fastify")?.healthy).toBe(false);
  });

  it("replaces an existing verdict for the same name", () => {
    saveDoctorVerdicts([verdict({ healthy: false })]);
    saveDoctorVerdicts([verdict({ healthy: true, reasons: [] })]);
    expect(readDoctorVerdicts().get("fastify")?.healthy).toBe(true);
  });

  it("writes valid JSON with the documented shape", () => {
    saveDoctorVerdicts([verdict()]);
    const raw = JSON.parse(readFileSync(doctorStorePath(), "utf8"));
    expect(raw.schemaVersion).toBe(DOCTOR_STORE_SCHEMA_VERSION);
    expect(raw.verdicts).toEqual([
      { name: "fastify", kind: "index-only", healthy: false, reasons: verdict().reasons, checkedAt: "2026-09-17T00:00:00.000Z" },
    ]);
  });

  it("K2: refuses to overwrite a file with a newer schemaVersion, returns false, and warns instead of throwing", () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(doctorStorePath(), JSON.stringify({ schemaVersion: DOCTOR_STORE_SCHEMA_VERSION + 1, verdicts: [] }), "utf8");
    const warnings: string[] = [];
    expect(saveDoctorVerdicts([verdict()], (m) => warnings.push(m))).toBe(false);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("newer schemaVersion");
    const raw = JSON.parse(readFileSync(doctorStorePath(), "utf8"));
    expect(raw.verdicts).toEqual([]); // untouched
  });

  it("security-architect N-5: throws when a verdict does not pass its own read-side validation — the write side must produce something the read side would accept", () => {
    expect(() => saveDoctorVerdicts([verdict({ name: "Not-Lowercase" })])).toThrow(/does not pass doctor-verdict validation/);
    expect(readDoctorVerdicts().size).toBe(0); // nothing written
  });

  it("S-3b: bounds growth to MAX_DOCTOR_VERDICTS, dropping the OLDEST (by checkedAt) first, across separate saves", () => {
    // Distinct, strictly increasing checkedAt per entry — "oldest" must be unambiguous, not
    // decided by insertion-order tie-breaking, which is not the rule this test is pinning.
    const older = Array.from({ length: MAX_DOCTOR_VERDICTS }, (_, i) =>
      verdict({ name: `lib${i}`, checkedAt: new Date(2020, 0, 1, 0, 0, i).toISOString() }),
    );
    saveDoctorVerdicts(older);
    expect(readDoctorVerdicts().size).toBe(MAX_DOCTOR_VERDICTS);
    saveDoctorVerdicts([verdict({ name: "newest", checkedAt: "2026-09-17T00:00:00.000Z" })]);
    const out = readDoctorVerdicts();
    expect(out.size).toBe(MAX_DOCTOR_VERDICTS); // still at the cap, not +1
    expect(out.get("newest")).toBeDefined(); // the newest write always survives
    expect(out.get("lib0")).toBeUndefined(); // the oldest was evicted to make room
  });
});
