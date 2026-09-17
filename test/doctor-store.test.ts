import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { doctorStorePath, readDoctorVerdicts, saveDoctorVerdicts, DOCTOR_STORE_SCHEMA_VERSION, type DoctorVerdict } from "../src/doctor-store.js";

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

  it("K1: drops a record with an invalid kind, missing name, non-boolean healthy, or unparseable checkedAt — one bad field drops the whole record, not just that field", () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      doctorStorePath(),
      JSON.stringify({
        schemaVersion: DOCTOR_STORE_SCHEMA_VERSION,
        verdicts: [
          { name: "ok", kind: "full-text", healthy: true, reasons: [], checkedAt: "2026-09-17T00:00:00.000Z" },
          { name: "bad-kind", kind: "made-up", healthy: true, reasons: [], checkedAt: "2026-09-17T00:00:00.000Z" },
          { kind: "full-text", healthy: true, reasons: [], checkedAt: "2026-09-17T00:00:00.000Z" },
          { name: "bad-healthy", kind: "full-text", healthy: "yes", reasons: [], checkedAt: "2026-09-17T00:00:00.000Z" },
          { name: "bad-date", kind: "full-text", healthy: true, reasons: [], checkedAt: "not a date" },
        ],
      }),
      "utf8",
    );
    const out = readDoctorVerdicts();
    expect([...out.keys()]).toEqual(["ok"]);
  });

  it("K1: cleans and clips reasons on read — control characters removed, over-long entries clipped, extras dropped", () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      doctorStorePath(),
      JSON.stringify({
        schemaVersion: DOCTOR_STORE_SCHEMA_VERSION,
        verdicts: [
          {
            name: "acme",
            kind: "index-only",
            healthy: false,
            reasons: [`bad[31m ${"x".repeat(400)}`, ...Array.from({ length: 20 }, (_, i) => `reason ${i}`)],
            checkedAt: "2026-09-17T00:00:00.000Z",
          },
        ],
      }),
      "utf8",
    );
    const out = readDoctorVerdicts().get("acme")!;
    expect(out.reasons[0]).not.toMatch(/[\x00-\x1f\x7f-\x9f]/);
    expect(out.reasons[0].length).toBeLessThanOrEqual(300);
    expect(out.reasons[0].endsWith("…")).toBe(true);
    expect(out.reasons).toHaveLength(10); // MAX_REASONS
  });
});

describe("saveDoctorVerdicts", () => {
  it("does nothing for an empty list — no file is created", () => {
    saveDoctorVerdicts([]);
    expect(readDoctorVerdicts().size).toBe(0);
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

  it("K2: refuses to overwrite a file with a newer schemaVersion, and warns instead of throwing", () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(doctorStorePath(), JSON.stringify({ schemaVersion: DOCTOR_STORE_SCHEMA_VERSION + 1, verdicts: [] }), "utf8");
    const warnings: string[] = [];
    expect(() => saveDoctorVerdicts([verdict()], (m) => warnings.push(m))).not.toThrow();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("newer schemaVersion");
    const raw = JSON.parse(readFileSync(doctorStorePath(), "utf8"));
    expect(raw.verdicts).toEqual([]); // untouched
  });
});
