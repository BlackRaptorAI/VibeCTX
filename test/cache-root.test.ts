import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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

/**
 * D-46 (oversight, PAR-652b) — the legacy path must be PROVEN a real directory before it is
 * renamed.
 *
 * `existsSync` follows symlinks, so at HEAD a symlinked `~/.docs-cache-mcp` passed rule 2 and
 * rule 3 renamed THE LINK: `~/.vibectx` became a symlink aiming wherever the link aimed, and
 * from then on every cached document — and every eviction — landed in the user's own
 * directory. `renameSync` operates on the link itself, which is exactly why nothing about the
 * target being someone's `Documents` folder stopped it.
 *
 * The refusal degrades the same way a failed rename does (rule 4): keep using the legacy path
 * for this run and say so once. RESIDUAL, stated because it is real: writes during that run
 * still resolve through the link. What is closed here is the PERMANENT capture — `~/.vibectx`
 * is not made a link — and deletion, which the D-46 root guard in cache-evict.ts refuses.
 */
describe("D-46: a symlinked legacy cache directory is refused, not renamed", () => {
  let target: string;
  let victim: string;
  beforeEach(() => {
    target = mkdtempSync(join(tmpdir(), "vibectx-victim-"));
    victim = join(target, "thesis.md");
    writeFileSync(victim, "# My thesis", "utf8");
  });
  afterEach(() => {
    rmSync(target, { recursive: true, force: true });
  });

  const legacyIsLinkTo = (dest: string) => symlinkSync(dest, legacy());

  it("never renames the link, so ~/.vibectx cannot become a link aimed at user files", () => {
    legacyIsLinkTo(target);
    const notes: string[] = [];
    const root = cacheRoot({ warn: (m) => notes.push(m) });

    expect(existsSync(current())).toBe(false); // nothing was created at the new path
    expect(lstatSync(legacy()).isSymbolicLink()).toBe(true); // the link is exactly where it was
    expect(realpathSync(legacy())).toBe(realpathSync(target));
    expect(existsSync(victim)).toBe(true);
    expect(root).toBe(legacy()); // degraded in place, as a failed rename does
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain("symlink");
    expect(notes[0]).toContain(legacy());
  });

  it("says it once per process, however many times cacheRoot is called", () => {
    legacyIsLinkTo(target);
    const notes: string[] = [];
    const warn = (m: string) => notes.push(m);
    cacheRoot({ warn });
    cacheRoot({ warn });
    cacheRoot({ warn });
    expect(notes).toHaveLength(1);
  });

  it("refuses a legacy path that exists but is not a directory", () => {
    writeFileSync(legacy(), "not a cache", "utf8");
    const notes: string[] = [];
    cacheRoot({ warn: (m) => notes.push(m) });
    expect(existsSync(current())).toBe(false);
    expect(readFileSync(legacy(), "utf8")).toBe("not a cache");
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain("not a directory");
  });

  it("a real legacy directory still migrates — the guard costs the good case nothing", () => {
    const marker = seedLegacy();
    const notes: string[] = [];
    expect(cacheRoot({ warn: (m) => notes.push(m) })).toBe(current());
    expect(existsSync(marker)).toBe(false);
    expect(readFileSync(join(current(), "react", "doc.md"), "utf8")).toBe("# react");
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain("moved the cache directory");
  });
});

/**
 * PAR-652b (security-gate note, info) — rule 1 was silent about what it left behind.
 *
 * `~/.vibectx` existing wins outright, and rightly so: a user with both directories has
 * already moved on, and overwriting the newer cache with the older one is the worst outcome
 * available here. But an EMPTY `~/.vibectx` — created by a `mkdir`, a dotfile manager, a
 * half-finished earlier run — took the same path and said nothing, so a full legacy cache sat
 * there stranded while the tool re-downloaded every document the user already had.
 *
 * The fix is a note, not a move: rule 1 does not change, the user is simply told where the
 * old cache is and what to do with it.
 */
describe("an empty ~/.vibectx no longer strands a legacy cache silently", () => {
  it("names both directories, once, and moves nothing", () => {
    const marker = seedLegacy();
    mkdirSync(current(), { recursive: true }); // empty
    const notes: string[] = [];
    const warn = (m: string) => notes.push(m);

    expect(cacheRoot({ warn })).toBe(current());
    cacheRoot({ warn });
    cacheRoot({ warn });

    expect(existsSync(marker)).toBe(true); // the legacy cache is exactly where it was
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain(legacy());
    expect(notes[0]).toContain(current());
  });

  it("says nothing when ~/.vibectx already holds a cache — that user has moved on", () => {
    seedLegacy();
    mkdirSync(current(), { recursive: true });
    writeFileSync(join(current(), "keep.md"), "new", "utf8");
    const notes: string[] = [];
    expect(cacheRoot({ warn: (m) => notes.push(m) })).toBe(current());
    expect(notes).toEqual([]);
  });

  it("says nothing when there is no legacy directory to strand", () => {
    mkdirSync(current(), { recursive: true });
    const notes: string[] = [];
    expect(cacheRoot({ warn: (m) => notes.push(m) })).toBe(current());
    expect(notes).toEqual([]);
  });

  it("says nothing when the legacy path is not a real directory", () => {
    mkdirSync(current(), { recursive: true });
    symlinkSync(mkdtempSync(join(tmpdir(), "vibectx-elsewhere-")), legacy());
    const notes: string[] = [];
    expect(cacheRoot({ warn: (m) => notes.push(m) })).toBe(current());
    expect(notes).toEqual([]);
  });
});
