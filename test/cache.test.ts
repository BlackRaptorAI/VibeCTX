import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readCache, writeCache, cacheRoot } from "../src/cache.js";

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
