import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { readCache, writeCache, touchCache, cacheRoot } from "../src/cache.js";
import { sweepTempFiles, sweepCacheTempFiles } from "../src/atomic-store.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "docs-cache-test-"));
  process.env.DOCS_CACHE_DIR = dir;
});

afterEach(() => {
  delete process.env.DOCS_CACHE_DIR;
  rmSync(dir, { recursive: true, force: true });
});

describe("cache", () => {
  it("honors DOCS_CACHE_DIR", () => {
    expect(cacheRoot()).toBe(dir);
  });

  it("round-trips content with metadata", () => {
    writeCache("fastify", "https://fastify.dev/llms.txt", "# Fastify docs");
    const hit = readCache("fastify", "https://fastify.dev/llms.txt", 168);
    expect(hit?.content).toBe("# Fastify docs");
    expect(hit?.meta.url).toBe("https://fastify.dev/llms.txt");
    expect(hit?.stale).toBe(false);
  });

  it("misses for unknown urls", () => {
    expect(readCache("fastify", "https://nope.example/x", 168)).toBeUndefined();
  });

  it("marks entries stale past TTL", () => {
    writeCache("react", "https://react.dev/llms.txt", "# React");
    // TTL of zero hours: anything already written is instantly stale.
    const hit = readCache("react", "https://react.dev/llms.txt", 0);
    expect(hit?.stale).toBe(true);
    expect(hit?.content).toBe("# React"); // stale content still served
  });
});

describe("N-6 — an unparsable fetchedAt reads as stale, not as fresh forever", () => {
  const URL_ = "https://react.dev/llms.txt";
  const metaPath = () => join(dir, "react", `${URL_.replace(/[^a-z0-9]/gi, "_")}.meta.json`);

  it.each(["yesterday", "", "not-a-date"])("fetchedAt %j → stale (content still served)", (bad) => {
    writeCache("react", URL_, "# React");
    writeFileSync(metaPath(), JSON.stringify({ url: URL_, fetchedAt: bad }), "utf8");
    const hit = readCache("react", URL_, 168);
    expect(hit?.content).toBe("# React");
    expect(hit?.stale).toBe(true);
  });

  it("a missing fetchedAt is stale too, and a good one is still fresh", () => {
    writeCache("react", URL_, "# React");
    writeFileSync(metaPath(), JSON.stringify({ url: URL_ }), "utf8");
    expect(readCache("react", URL_, 168)?.stale).toBe(true);
    writeCache("react", URL_, "# React");
    expect(readCache("react", URL_, 168)?.stale).toBe(false);
  });
});

describe("cache — atomic writes (PAR-656 S4)", () => {
  const URL_ = "https://react.dev/llms.txt";
  const paths = () => {
    const d = join(dir, "react");
    const slug = URL_.replace(/[^a-z0-9]/gi, "_");
    return { dir: d, content: join(d, `${slug}.md`), meta: join(d, `${slug}.meta.json`) };
  };

  it("writes content then meta, each via a temp file + rename in the same directory, leaving no temp file behind", () => {
    writeCache("react", URL_, "# React", '"v1"');
    const p = paths();
    expect(readdirSync(p.dir).sort()).toEqual([basename(p.content), basename(p.meta)]);
    expect(readCache("react", URL_, 168)?.meta.etag).toBe('"v1"');
  });

  it("a reader never sees a torn pair: content present with meta missing is a miss; meta present with content missing is a miss", () => {
    writeCache("react", URL_, "# React");
    const p = paths();
    const meta = readFileSync(p.meta, "utf8");
    rmSync(p.meta);
    expect(readCache("react", URL_, 168)).toBeUndefined(); // crash after content rename, before meta rename
    writeFileSync(p.meta, meta, "utf8");
    rmSync(p.content);
    expect(readCache("react", URL_, 168)).toBeUndefined();
  });

  it("a failed write (the library dir is a file) throws and leaves no temp file where the dir should be", () => {
    writeFileSync(join(dir, "react"), "not a dir", "utf8");
    expect(() => writeCache("react", URL_, "# React")).toThrow();
    expect(readdirSync(dir)).toEqual(["react"]);
  });

  it("an overwrite replaces the old content in one step: after the write there is exactly one content file and it is the new one", () => {
    writeCache("react", URL_, "# old");
    writeCache("react", URL_, "# new");
    const p = paths();
    expect(readdirSync(p.dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
    expect(readFileSync(p.content, "utf8")).toBe("# new");
  });

  it("touchCache rewrites meta via rename too (no temp file left) and refreshes fetchedAt", async () => {
    writeCache("react", URL_, "# React");
    const before = readCache("react", URL_, 168)!.meta.fetchedAt;
    await new Promise((r) => setTimeout(r, 5));
    touchCache("react", URL_);
    const p = paths();
    expect(readdirSync(p.dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
    expect(readCache("react", URL_, 168)!.meta.fetchedAt > before).toBe(true);
  });
});

describe("S-C — orphan temp files are swept from the cache directories", () => {
  const URL_ = "https://react.dev/llms.txt";
  const orphan = (dirPath: string, base: string) => join(dirPath, `${base}.4242.1757000000000.tmp`);

  it("sweepTempFiles removes only names the atomic writers produce, and never throws on a missing directory", () => {
    mkdirSync(join(dir, "projects"), { recursive: true });
    writeFileSync(orphan(dir, "resolved.json"), "{}", "utf8");
    writeFileSync(orphan(join(dir, "projects"), "abc.json"), "{}", "utf8");
    writeFileSync(join(dir, "notes.tmp"), "mine", "utf8"); // not our shape: untouched
    writeFileSync(join(dir, "resolved.json"), "{}", "utf8");
    sweepTempFiles(dir);
    sweepTempFiles(join(dir, "projects"));
    expect(() => sweepTempFiles(join(dir, "does-not-exist"))).not.toThrow();
    expect(readdirSync(dir).sort()).toEqual(["notes.tmp", "projects", "resolved.json"]);
    expect(readdirSync(join(dir, "projects"))).toEqual([]);
  });

  it("sweepCacheTempFiles reaches the per-library document directories too, and leaves real files alone", () => {
    writeCache("react", URL_, "# React");
    const libDir = join(dir, "react");
    writeFileSync(orphan(libDir, "page.md"), "half a document", "utf8");
    writeFileSync(orphan(join(dir, "react"), "page.meta.json"), "{", "utf8");
    const before = readdirSync(libDir).filter((f) => !f.endsWith(".tmp")).sort();
    sweepCacheTempFiles(dir);
    expect(readdirSync(libDir).sort()).toEqual(before);
    expect(readCache("react", URL_, 168)?.content).toBe("# React");
  });
});
