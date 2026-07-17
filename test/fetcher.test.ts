import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isAllowedLink, getLibraryDoc, getLinkedPage } from "../src/fetcher.js";
import { writeCache, readCache } from "../src/cache.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "docs-cache-fetch-"));
  process.env.DOCS_CACHE_DIR = dir;
});

afterEach(() => {
  delete process.env.DOCS_CACHE_DIR;
  rmSync(dir, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

describe("isAllowedLink (SSRF guard)", () => {
  const source = "https://docs.example.com/llms.txt";

  it("allows same-origin https links", () => {
    expect(isAllowedLink("https://docs.example.com/guide.md", source)).toBe(true);
  });

  it("rejects http links even on the same host", () => {
    expect(isAllowedLink("http://docs.example.com/guide.md", source)).toBe(false);
  });

  it("rejects cross-origin links", () => {
    expect(isAllowedLink("https://evil.example.net/guide.md", source)).toBe(false);
    expect(isAllowedLink("https://169.254.169.254/latest/meta-data", source)).toBe(false);
    expect(isAllowedLink("https://localhost:8080/admin", source)).toBe(false);
  });

  it("rejects unparseable urls", () => {
    expect(isAllowedLink("not a url", source)).toBe(false);
  });
});

describe("getLinkedPage origin enforcement", () => {
  it("refuses to fetch a cross-origin link without touching the network", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const result = await getLinkedPage(
      "lib",
      "https://attacker.example.net/x.md",
      "https://docs.example.com/llms.txt",
    );
    expect(result).toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("etag revalidation", () => {
  const entry = {
    name: "revalidate-lib",
    urls: ["https://docs.example.com/llms-full.txt"],
    ttlHours: 0, // instantly stale → every read revalidates
  };

  it("sends If-None-Match and serves cache on 304 without re-downloading", async () => {
    writeCache(entry.name, entry.urls[0], "# Cached content", '"abc123"');
    const fetchSpy = vi.fn(async (_url: unknown, init: any) => {
      expect(init.headers["if-none-match"]).toBe('"abc123"');
      return new Response(null, { status: 304 });
    });
    vi.stubGlobal("fetch", fetchSpy);

    const before = readCache(entry.name, entry.urls[0], 999)!.meta.fetchedAt;
    await new Promise((r) => setTimeout(r, 5));
    const doc = await getLibraryDoc(entry);

    expect(doc?.content).toBe("# Cached content");
    expect(doc?.staleNote).toBeUndefined();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    // 304 must refresh the TTL clock (touchCache)
    const after = readCache(entry.name, entry.urls[0], 999)!.meta.fetchedAt;
    expect(new Date(after).getTime()).toBeGreaterThan(new Date(before).getTime());
  });

  it("stores the new etag on a 200 refresh", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response("# Fresh content", {
          status: 200,
          headers: { etag: '"v2"', "content-type": "text/plain" },
        }),
      ),
    );
    const doc = await getLibraryDoc(entry);
    expect(doc?.content).toBe("# Fresh content");
    expect(readCache(entry.name, entry.urls[0], 999)?.meta.etag).toBe('"v2"');
  });
});
