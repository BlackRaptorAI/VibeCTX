import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync, symlinkSync, lstatSync } from "node:fs";
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
import { listLibrariesText } from "../src/list-libraries.js";

let dir: string;
let project: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "vibectx-projstore-"));
  project = mkdtempSync(join(tmpdir(), "vibectx-proj-"));
  process.env.VIBECTX_CACHE_DIR = dir;
});

afterEach(() => {
  delete process.env.VIBECTX_CACHE_DIR;
  rmSync(dir, { recursive: true, force: true });
  rmSync(project, { recursive: true, force: true });
});

function record(overrides: Partial<ProjectRecord> = {}): ProjectRecord {
  return {
    schemaVersion: PROJECT_RECORD_SCHEMA_VERSION,
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

describe("PAR-859 — a project record is symlink-safe on read", () => {
  /**
   * Unlike `resolved-store.ts`/`doctor-store.ts`, `writeProjectRecord` does NOT read the
   * existing file to merge before writing — it serialises the `record` argument it was handed
   * directly (CONFIRMED by reading it). So this closes a served-and-discarded read only; a plain
   * refusal test is sufficient here, no read-merge-persist poisoning test is needed.
   */
  it("readProjectRecord refuses a symlink planted at its own record path — reads back undefined, not through the link (mutation target: readProjectRecord's isRegularFile guard)", () => {
    expect(writeProjectRecord(record())).toBe(true);
    expect(readProjectRecord(project)).toEqual(record()); // the real file round-trips first
    const sibling = join(dir, "sibling.json");
    writeFileSync(sibling, JSON.stringify(record({ dir: project })), "utf8");
    rmSync(projectRecordPath(project), { force: true });
    symlinkSync(sibling, projectRecordPath(project));

    let out: ReturnType<typeof readProjectRecord>;
    expect(() => {
      out = readProjectRecord(project);
    }).not.toThrow();
    expect(out!).toBeUndefined();
    expect(lstatSync(projectRecordPath(project)).isSymbolicLink()).toBe(true); // the link itself is untouched by the read
  });

  /**
   * code-reviewer (Phase 1b review round, BLOCKING) PROVED with an executed probe that the test
   * above is not the whole story: `isRegularFile`/`lstat` only inspects the LEAF (the record file
   * itself). With `VIBECTX_CACHE_DIR` pointed at a symlink whose TARGET holds a genuinely real,
   * valid record, the leaf check never sees a symlink — `lstat` on the full joined path resolves
   * the ROOT (an intermediate component) for ordinary traversal and finds a real regular file at
   * the far end. A different scenario from the test above; needs its own proof.
   */
  it("readProjectRecord refuses even when only the cache ROOT is a symlink, whose target genuinely holds a valid record", () => {
    const target = mkdtempSync(join(tmpdir(), "vibectx-projstore-root-symlink-target-"));
    const parent = mkdtempSync(join(tmpdir(), "vibectx-projstore-root-symlink-parent-"));
    const linked = join(parent, "root");
    process.env.VIBECTX_CACHE_DIR = target;
    const realPath = projectRecordPath(project); // <target>/projects/<hash>.json, computed against the REAL root
    mkdirSync(join(target, "projects"), { recursive: true });
    writeFileSync(realPath, JSON.stringify(record()), "utf8");
    symlinkSync(target, linked);
    process.env.VIBECTX_CACHE_DIR = linked;
    try {
      let out: ReturnType<typeof readProjectRecord>;
      expect(() => {
        out = readProjectRecord(project);
      }).not.toThrow();
      expect(out!).toBeUndefined(); // must NOT return the record sitting at the far end of the root symlink
    } finally {
      process.env.VIBECTX_CACHE_DIR = dir;
      rmSync(parent, { recursive: true, force: true });
      rmSync(target, { recursive: true, force: true });
    }
  });
});

describe("PAR-859 — writeProjectRecord refuses a symlink at EITHER of its two ensureCacheRoot calls independently", () => {
  it("refuses when the cache ROOT itself is a symlink", () => {
    const target = mkdtempSync(join(tmpdir(), "vibectx-projstore-write-symlink-target-"));
    const parent = mkdtempSync(join(tmpdir(), "vibectx-projstore-write-symlink-parent-"));
    const linked = join(parent, "root");
    symlinkSync(target, linked);
    process.env.VIBECTX_CACHE_DIR = linked;
    try {
      expect(() => writeProjectRecord(record())).not.toThrow();
      expect(writeProjectRecord(record())).toBe(false);
      expect(readdirSync(target)).toEqual([]); // nothing was created through the link
    } finally {
      process.env.VIBECTX_CACHE_DIR = dir;
      rmSync(parent, { recursive: true, force: true });
      rmSync(target, { recursive: true, force: true });
    }
  });

  /**
   * PAR-859 (mutation target: writeProjectRecord's SECOND ensureCacheRoot call, on
   * `join(root, "projects")`) — a real root does not, by itself, prove `projects/` is real: a
   * symlink could be planted specifically at that one subdirectory, exactly the shape
   * `writeCache`'s own two-call root/library-directory check already treats as independent
   * (see that function's own comment). This is caught ONLY by checking the SECOND call's own
   * return value — the mutation this test targets is real: removing just this bail (leaving the
   * root's own bail intact) makes no OTHER test in this suite fail, since every other write-side
   * fixture symlinks the root itself, never `projects/` alone.
   */
  it("refuses when the root is real but projects/ itself is a symlink", () => {
    const elsewhere = mkdtempSync(join(tmpdir(), "vibectx-projstore-write-symlink-elsewhere-"));
    symlinkSync(elsewhere, join(dir, "projects"));
    try {
      expect(() => writeProjectRecord(record())).not.toThrow();
      expect(writeProjectRecord(record())).toBe(false);
      expect(readdirSync(elsewhere)).toEqual([]); // nothing was created through the link
      expect(lstatSync(join(dir, "projects")).isSymbolicLink()).toBe(true); // the link itself is untouched
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });
});

describe("A16/PAR-725 (code-reviewer round 1, should-fix #6): the schema version bump is pinned by an exact value, not only by reference to itself", () => {
  it("PROJECT_RECORD_SCHEMA_VERSION is 2 — every other assertion in this suite compares against the constant, which would not catch an accidental revert or an unintended bump", () => {
    expect(PROJECT_RECORD_SCHEMA_VERSION).toBe(2);
  });
});

describe("K2 — upgrade policy: a LOWER schemaVersion is replaced, only a HIGHER one is protected", () => {
  it("lower: ignored on read, replaced on write, no note", () => {
    mkdirSync(join(dir, "projects"), { recursive: true });
    writeFileSync(projectRecordPath(project), JSON.stringify({ schemaVersion: 0, dir: project, legacy: true }), "utf8");
    expect(readProjectRecord(project)).toBeUndefined();
    const notes: string[] = [];
    expect(writeProjectRecord(record(), (m) => notes.push(m))).toBe(true);
    expect(notes).toEqual([]);
    expect(readProjectRecord(project)).toEqual(record());
  });

  it("higher: ignored on read, refused on write with a stderr note", () => {
    mkdirSync(join(dir, "projects"), { recursive: true });
    const future = JSON.stringify({ schemaVersion: PROJECT_RECORD_SCHEMA_VERSION + 1, dir: project });
    writeFileSync(projectRecordPath(project), future, "utf8");
    const notes: string[] = [];
    expect(writeProjectRecord(record(), (m) => notes.push(m))).toBe(false);
    expect(readFileSync(projectRecordPath(project), "utf8")).toBe(future);
    expect(notes.join("")).toMatch(new RegExp(`newer schemaVersion ${PROJECT_RECORD_SCHEMA_VERSION + 1}`));
  });

  it("K-1: the schema gate's seeded record — a javascript: url is dropped, a traversing source drops the row, an over-long note is truncated", () => {
    mkdirSync(join(dir, "projects"), { recursive: true });
    const rows = record().dependencies;
    const longNote = "n".repeat(5026);
    writeFileSync(
      projectRecordPath(project),
      JSON.stringify({
        ...record(),
        dependencies: [
          { ...rows[0], name: "bad-url", url: "javascript:alert(1)" },
          { ...rows[0], name: "http-url", url: "http://insecure.example.com/llms.txt" },
          { ...rows[3], name: "traversing-source", source: "../../etc/passwd" },
          { ...rows[3], name: "absolute-source", source: "/etc/passwd" },
          { ...rows[3], name: "long-note", note: longNote },
          { ...rows[0], name: "long-library", library: "l".repeat(215) },
        ],
      }),
      "utf8",
    );
    const back = readProjectRecord(project)!;
    expect(back.dependencies.map((d) => d.name)).toEqual(["bad-url", "http-url", "long-note", "long-library"]);
    // A url that is not an https URL is DROPPED; the row survives, it just no longer claims one.
    expect(back.dependencies[0].url).toBeUndefined();
    expect(back.dependencies[1].url).toBeUndefined();
    // A source that is not a plain relative manifest path DROPS THE ROW — it is a file name, and
    // one that traverses is evidence the file was written by something other than this tool.
    expect(JSON.stringify(back)).not.toContain("passwd");
    // An over-long note is TRUNCATED, not dropped: the reason a name failed is still worth showing.
    expect(back.dependencies[2].note).toHaveLength(512);
    expect(back.dependencies[2].note!.endsWith("…")).toBe(true);
    // An over-long library name drops that field only.
    expect(back.dependencies[3].library).toBeUndefined();
  });

  it("K-1: legitimate manifest sources and https urls survive untouched", () => {
    mkdirSync(join(dir, "projects"), { recursive: true });
    const rows = record().dependencies;
    const keep = [
      { ...rows[0], name: "a", source: "package.json" },
      { ...rows[0], name: "b", source: "requirements-dev.txt" },
      { ...rows[0], name: "c", source: "sub/requirements.txt" },
      { ...rows[0], name: "d", source: "@scope/pyproject.toml" },
    ];
    writeFileSync(projectRecordPath(project), JSON.stringify({ ...record(), dependencies: keep }), "utf8");
    expect(readProjectRecord(project)?.dependencies).toEqual(keep);
  });

  it("K-1: a source is refused for what it DOES, not for its alphabet — any relative path survives, an absolute or traversing one drops the row", () => {
    mkdirSync(join(dir, "projects"), { recursive: true });
    const base = record().dependencies[0];
    const keep = [
      "package.json",
      "sub/requirements.txt",
      "req+dev/extra.txt", // a character the old allow-list did not know
      "треб/extra.txt", // a non-ASCII directory: a real path on a real machine
      "req dir/dev.txt", // a space: legal in every filesystem this runs on
      "requirements(dev).txt",
      "a/b/c/pyproject.toml",
      "..hidden/req.txt", // leading dots, but not a `..` SEGMENT
    ];
    const drop = [
      "../../etc/passwd",
      "/etc/passwd",
      "C:\\x",
      "\\\\server\\share\\req.txt",
      "a/../b",
      "a\\..\\b", // a `..` segment on the other separator
      "..",
      "",
      "sub/\u0000passwd",
      "\u200b/etc/passwd", // absolute once cleaned
      `${"x".repeat(257)}.txt`,
    ];
    const rows = [
      ...keep.map((source, i) => ({ ...base, name: `keep-${i}`, source })),
      ...drop.map((source, i) => ({ ...base, name: `drop-${i}`, source })),
    ];
    writeFileSync(projectRecordPath(project), JSON.stringify({ ...record(), dependencies: rows }), "utf8");
    const back = readProjectRecord(project)!;
    expect(back.dependencies.map((d) => d.source)).toEqual(keep);
    expect(back.dependencies.map((d) => d.name)).toEqual(keep.map((_, i) => `keep-${i}`));
    expect(JSON.stringify(back)).not.toContain("passwd");
  });

  it("K3: an unknown status is dropped on read; failedAt must be a date when present", () => {
    mkdirSync(join(dir, "projects"), { recursive: true });
    const rows = record().dependencies;
    writeFileSync(
      projectRecordPath(project),
      JSON.stringify({ ...record(), dependencies: [{ ...rows[3], failedAt: "2026-09-06T05:00:00.000Z" }, { ...rows[3], name: "bad-date", failedAt: "yesterday" }, { ...rows[0], status: "unresolved (soon)" }] }),
      "utf8",
    );
    expect(readProjectRecord(project)?.dependencies).toEqual([{ ...rows[3], failedAt: "2026-09-06T05:00:00.000Z" }]);
  });

  it("K1/S3: warmedAt is a STRICT ISO-8601 instant and no record string can carry a bidi override into the list_libraries footer", () => {
    mkdirSync(join(dir, "projects"), { recursive: true });
    const RLO = "‮";
    const write = (r: unknown) => writeFileSync(projectRecordPath(project), JSON.stringify(r), "utf8");

    // Date.parse is lenient enough to accept a "date" with a trailing parenthesised comment,
    // which is how a bidi override reaches the footer. Strict ISO-8601 or the record is absent.
    write(record({ warmedAt: `2020-01-01 (${RLO}evil)` }));
    expect(readProjectRecord(project)).toBeUndefined();
    for (const bad of ["2026-09-06", "06 Sep 2026 06:00:00 GMT", "2026-09-06T06:00:00.000+01:00", "2026-13-45T06:00:00Z", ""]) {
      write(record({ warmedAt: bad }));
      expect(readProjectRecord(project), bad).toBeUndefined();
    }
    for (const good of ["2026-09-06T06:00:00Z", "2026-09-06T06:00:00.000Z"]) {
      write(record({ warmedAt: good }));
      expect(readProjectRecord(project)?.warmedAt, good).toBe(good);
    }

    // manifests are echoed, never opened: each entry is bounded and CLEANED, not dropped.
    write(record({ manifests: [`package.json${RLO}`, "sub/requirements.txt"] }));
    expect(readProjectRecord(project)?.manifests).toEqual(["package.json", "sub/requirements.txt"]);
    write(record({ manifests: [RLO] })); // empty once cleaned: not ours
    expect(readProjectRecord(project)).toBeUndefined();
    write(record({ manifests: ["x".repeat(257)] }));
    expect(readProjectRecord(project)).toBeUndefined();

    // …and `dir`, plus warmedAt, are cleaned at the render boundary itself.
    const summary = summariseProjectRecord({ ...record(), dir: `${project}${RLO}`, warmedAt: `2026-09-06T06:00:00.000Z${RLO}` });
    expect(summary).not.toContain(RLO);

    // The footer list_libraries actually prints never carries one.
    write(record({ warmedAt: `2020-01-01 (${RLO}evil)` }));
    const registry = { entries: new Map([["react", { name: "react", urls: ["https://react.dev/llms.txt"] }]]) };
    const text = listLibrariesText(registry, { projectDir: project, warming: new Set<string>() });
    expect(text).not.toContain(RLO);
    expect(text).not.toContain("Project deps"); // the record was rejected outright
  });
});
