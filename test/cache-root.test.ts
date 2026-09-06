import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * PAR-652 item 5 — the cache location's rebrand: `~/.docs-cache-mcp` → `~/.vibectx`,
 * `DOCS_CACHE_DIR` → `VIBECTX_CACHE_DIR` (D-45: the new name wins; the old one keeps working
 * for 0.2.x with one deprecation note per process).
 *
 * `renameSync` is the only thing mocked, and only so the "the rename fails" case can be
 * exercised without a second filesystem: every other fs call in this file is the real one.
 * `renameImpl` is what `node:fs.renameSync` does for the duration of one test.
 */
let renameImpl: ((from: string, to: string) => void) | undefined;
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    default: actual,
    renameSync: (from: string, to: string) => (renameImpl ?? actual.renameSync)(from, to),
  };
});

const { cacheRoot, resetCacheRootState, LEGACY_CACHE_DIR_NAME, CACHE_DIR_NAME } = await import("../src/cache.js");

let home: string;
let saved: Record<string, string | undefined>;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "vibectx-home-"));
  saved = {
    HOME: process.env.HOME,
    VIBECTX_CACHE_DIR: process.env.VIBECTX_CACHE_DIR,
    DOCS_CACHE_DIR: process.env.DOCS_CACHE_DIR,
  };
  process.env.HOME = home;
  delete process.env.VIBECTX_CACHE_DIR;
  delete process.env.DOCS_CACHE_DIR;
  renameImpl = undefined;
  resetCacheRootState();
});

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  renameImpl = undefined;
  resetCacheRootState();
  rmSync(home, { recursive: true, force: true });
});

const legacy = () => join(home, LEGACY_CACHE_DIR_NAME);
const current = () => join(home, CACHE_DIR_NAME);

/** A legacy cache with one recognisable file in it, so "the cache survived" is checkable. */
function seedLegacy(): string {
  mkdirSync(join(legacy(), "react"), { recursive: true });
  const marker = join(legacy(), "react", "doc.md");
  writeFileSync(marker, "# react", "utf8");
  return marker;
}

describe("D-45 env precedence: new > old > default", () => {
  it("VIBECTX_CACHE_DIR wins over DOCS_CACHE_DIR", () => {
    process.env.VIBECTX_CACHE_DIR = join(home, "new");
    process.env.DOCS_CACHE_DIR = join(home, "old");
    const notes: string[] = [];
    expect(cacheRoot({ warn: (m) => notes.push(m) })).toBe(join(home, "new"));
    expect(notes).toEqual([]); // nothing deprecated was used, so nothing is said
  });

  it("DOCS_CACHE_DIR is still honoured when the new name is unset", () => {
    process.env.DOCS_CACHE_DIR = join(home, "old");
    expect(cacheRoot({ warn: () => {} })).toBe(join(home, "old"));
  });

  it("with neither set, the default is ~/.vibectx", () => {
    expect(cacheRoot({ warn: () => {} })).toBe(current());
  });

  it("an empty value is not a cache directory — it reads as unset", () => {
    process.env.VIBECTX_CACHE_DIR = "";
    process.env.DOCS_CACHE_DIR = join(home, "old");
    expect(cacheRoot({ warn: () => {} })).toBe(join(home, "old"));
  });
});

describe("D-45 deprecation note", () => {
  it("fires once per process, not once per call", () => {
    process.env.DOCS_CACHE_DIR = join(home, "old");
    const notes: string[] = [];
    const warn = (m: string) => notes.push(m);
    cacheRoot({ warn });
    cacheRoot({ warn });
    cacheRoot({ warn });
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain("DOCS_CACHE_DIR");
    expect(notes[0]).toContain("VIBECTX_CACHE_DIR");
  });

  it("does not fire when the new name is set, even if the old one is too", () => {
    process.env.VIBECTX_CACHE_DIR = join(home, "new");
    process.env.DOCS_CACHE_DIR = join(home, "old");
    const notes: string[] = [];
    cacheRoot({ warn: (m) => notes.push(m) });
    expect(notes).toEqual([]);
  });
});

describe("D-45 one-time migration of ~/.docs-cache-mcp", () => {
  it("renames the old directory once and keeps its contents", () => {
    const marker = seedLegacy();
    const notes: string[] = [];
    expect(cacheRoot({ warn: (m) => notes.push(m) })).toBe(current());
    expect(existsSync(marker)).toBe(false);
    expect(readFileSync(join(current(), "react", "doc.md"), "utf8")).toBe("# react");
    expect(existsSync(legacy())).toBe(false);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain(legacy());
    expect(notes[0]).toContain(current());
  });

  it("says it once, however many times cacheRoot is called", () => {
    seedLegacy();
    const notes: string[] = [];
    const warn = (m: string) => notes.push(m);
    cacheRoot({ warn });
    cacheRoot({ warn });
    expect(notes).toHaveLength(1);
  });

  it("is skipped when ~/.vibectx already exists — the new cache is never overwritten", () => {
    const marker = seedLegacy();
    mkdirSync(current(), { recursive: true });
    writeFileSync(join(current(), "keep.md"), "new", "utf8");
    const notes: string[] = [];
    expect(cacheRoot({ warn: (m) => notes.push(m) })).toBe(current());
    expect(readFileSync(join(current(), "keep.md"), "utf8")).toBe("new");
    expect(existsSync(marker)).toBe(true); // the old cache is left exactly where it was
    expect(notes).toEqual([]);
  });

  it("does nothing at all when there is no legacy directory", () => {
    const notes: string[] = [];
    expect(cacheRoot({ warn: (m) => notes.push(m) })).toBe(current());
    expect(notes).toEqual([]);
  });

  it("a failed rename degrades to the old path for this run rather than throwing", () => {
    const marker = seedLegacy();
    renameImpl = () => {
      const e = new Error("EXDEV: cross-device link not permitted") as NodeJS.ErrnoException;
      e.code = "EXDEV";
      throw e;
    };
    const notes: string[] = [];
    expect(() => cacheRoot({ warn: (m) => notes.push(m) })).not.toThrow();
    expect(cacheRoot({ warn: (m) => notes.push(m) })).toBe(legacy());
    expect(existsSync(marker)).toBe(true); // nothing copied, nothing lost
    expect(existsSync(current())).toBe(false); // and no empty new directory left behind
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain("EXDEV");
    expect(notes[0]).toContain(legacy());
  });
});
