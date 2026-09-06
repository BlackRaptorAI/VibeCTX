import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PROJECT_RECORD_SCHEMA_VERSION,
  projectRecordPath,
  readProjectRecord,
  writeProjectRecord,
  summariseProjectRecord,
  type ProjectRecord,
} from "../src/project-store.js";

let dir: string;
let project: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "vibectx-projstore-"));
  project = mkdtempSync(join(tmpdir(), "vibectx-proj-"));
  process.env.DOCS_CACHE_DIR = dir;
});

afterEach(() => {
  delete process.env.DOCS_CACHE_DIR;
  rmSync(dir, { recursive: true, force: true });
  rmSync(project, { recursive: true, force: true });
});

function record(overrides: Partial<ProjectRecord> = {}): ProjectRecord {
  return {
    schemaVersion: 1,
    dir: project,
    manifests: ["package.json"],
    dependencies: [
      { name: "next", ecosystem: "npm", source: "package.json", library: "next.js", status: "cached", url: "https://nextjs.org/llms.txt" },
      { name: "stripe", ecosystem: "npm", source: "package.json", library: "stripe", status: "already fresh", url: "https://docs.stripe.com/llms.txt" },
      { name: "@types/node", ecosystem: "npm", source: "package.json", status: "denied (noise list)" },
      { name: "zz-nothing", ecosystem: "npm", source: "package.json", status: "unresolved", note: "npm: no metadata" },
    ],
    warmedAt: "2026-09-06T06:00:00.000Z",
    ...overrides,
  };
}

describe("project record store (<cacheRoot>/projects/<hash>.json, PAR-656)", () => {
  it("keys the file by a hash of the absolute directory, under projects/", () => {
    const p = projectRecordPath(project);
    expect(p.startsWith(join(dir, "projects") + "/")).toBe(true);
    expect(p).toMatch(/\/[0-9a-f]{32}\.json$/);
    expect(projectRecordPath(project)).toBe(p); // deterministic
    expect(projectRecordPath(join(project, "sub", ".."))).toBe(p); // normalised before hashing
    expect(projectRecordPath(join(project, "other"))).not.toBe(p);
  });

  it("reads as undefined when absent; round-trips a record atomically with no temp file left", () => {
    expect(readProjectRecord(project)).toBeUndefined();
    expect(writeProjectRecord(record())).toBe(true);
    expect(readdirSync(join(dir, "projects"))).toHaveLength(1);
    expect(readdirSync(join(dir, "projects"))[0]).toMatch(/\.json$/);
    const raw = JSON.parse(readFileSync(projectRecordPath(project), "utf8"));
    expect(Object.keys(raw)[0]).toBe("schemaVersion");
    expect(raw.schemaVersion).toBe(PROJECT_RECORD_SCHEMA_VERSION);
    expect(readProjectRecord(project)).toEqual(record());
  });

  it("ignores a corrupt file, a file of the wrong shape, and a record whose dir does not match", () => {
    mkdirSync(join(dir, "projects"), { recursive: true });
    writeFileSync(projectRecordPath(project), "{ nope", "utf8");
    expect(readProjectRecord(project)).toBeUndefined();
    writeFileSync(projectRecordPath(project), JSON.stringify([1, 2]), "utf8");
    expect(readProjectRecord(project)).toBeUndefined();
    writeFileSync(projectRecordPath(project), JSON.stringify(record({ dir: "/somewhere/else" })), "utf8");
    expect(readProjectRecord(project)).toBeUndefined();
  });

  it("drops malformed dependency rows and keeps the valid ones", () => {
    mkdirSync(join(dir, "projects"), { recursive: true });
    const rows = record().dependencies;
    writeFileSync(
      projectRecordPath(project),
      JSON.stringify({
        ...record(),
        dependencies: [rows[0], null, { name: "x" }, { ...rows[1], status: "made-up" }, { ...rows[1], ecosystem: "gem" }, { ...rows[3], name: 42 }, rows[2]],
      }),
      "utf8",
    );
    expect(readProjectRecord(project)?.dependencies).toEqual([rows[0], rows[2]]);
  });

  it("a foreign schemaVersion is ignored on read and never overwritten on write", () => {
    mkdirSync(join(dir, "projects"), { recursive: true });
    const foreign = JSON.stringify({ schemaVersion: 7, dir: project, future: true });
    writeFileSync(projectRecordPath(project), foreign, "utf8");
    expect(readProjectRecord(project)).toBeUndefined();
    const notes: string[] = [];
    expect(writeProjectRecord(record(), (m) => notes.push(m))).toBe(false);
    expect(readFileSync(projectRecordPath(project), "utf8")).toBe(foreign);
    expect(notes.join("")).toMatch(/schemaVersion 7/);
    // A corrupt file is not "another version": it is replaced.
    writeFileSync(projectRecordPath(project), "{{{", "utf8");
    expect(writeProjectRecord(record(), (m) => notes.push(m))).toBe(true);
    expect(readProjectRecord(project)).toEqual(record());
  });

  it("rejects a record with a bad warmedAt or a non-array manifests list", () => {
    mkdirSync(join(dir, "projects"), { recursive: true });
    writeFileSync(projectRecordPath(project), JSON.stringify(record({ warmedAt: "yesterday" })), "utf8");
    expect(readProjectRecord(project)).toBeUndefined();
    writeFileSync(projectRecordPath(project), JSON.stringify({ ...record(), manifests: "package.json" }), "utf8");
    expect(readProjectRecord(project)).toBeUndefined();
  });

  it("summariseProjectRecord: one line — cached vs unresolved counts, denied aside, when warmed", () => {
    expect(summariseProjectRecord(record())).toBe(
      `Project deps (${project}): 2 cached, 1 unresolved, 1 denied — warmed 2026-09-06T06:00:00.000Z`,
    );
    expect(existsSync(join(dir, "projects"))).toBe(false); // summarising never writes
  });
});
