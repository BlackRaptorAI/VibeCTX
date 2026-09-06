import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { readCache, writeCache, touchCache, cacheRoot } from "../src/cache.js";

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
