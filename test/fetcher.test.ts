import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isAllowedLink,
  getLibraryDoc,
  getLinkedPage,
  fetchLinkedPage,
  LINKED_PAGE_MAX_BYTES,
  PRIMARY_DOC_MAX_BYTES,
} from "../src/fetcher.js";
import { writeCache, readCache } from "../src/cache.js";

/** A Response whose `url` reports where a redirect chain ended (real fetch sets this; stubs don't). */
function responseAt(finalUrl: string, body: string | null, init: ResponseInit = {}): Response {
  const res = new Response(body, {
    status: 200,
    headers: { "content-type": "text/plain" },
    ...init,
  });
  Object.defineProperty(res, "url", { value: finalUrl });
  return res;
}

/** A Response streamed in fixed-size chunks with no content-length header. */
function streamedResponse(totalBytes: number, chunkBytes = 64 * 1024): Response {
  let sent = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= totalBytes) {
        controller.close();
        return;
      }
      const n = Math.min(chunkBytes, totalBytes - sent);
      controller.enqueue(new Uint8Array(n).fill(0x61)); // 'a'
      sent += n;
    },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "text/plain" } });
}

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

describe("fetchLinkedPage redirect enforcement (SSRF guard, post-redirect)", () => {
  const source = "https://docs.example.com/llms.txt";
  const link = "https://docs.example.com/guide.md";

  it("refuses a same-origin link whose redirect chain ends cross-origin, without caching the body", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => responseAt("http://169.254.169.254/latest/meta-data", "SECRET")),
    );
    const result = await fetchLinkedPage("lib", link, source);
    expect(result.status).toBe("refused");
    expect(readCache("lib", link, 999)).toBeUndefined();
  });

  it("refuses a redirect that downgrades to http on the same host", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => responseAt("http://docs.example.com/guide.md", "body")));
    const result = await fetchLinkedPage("lib", link, source);
    expect(result.status).toBe("refused");
    expect(readCache("lib", link, 999)).toBeUndefined();
  });

  it("serves a same-origin redirect to a different path normally", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => responseAt("https://docs.example.com/v2/guide.md", "# Moved guide")),
    );
    const result = await fetchLinkedPage("lib", link, source);
    expect(result).toEqual({ status: "ok", page: { content: "# Moved guide", url: link } });
    expect(readCache("lib", link, 999)?.content).toBe("# Moved guide");
  });

  it("reports a network failure as unavailable, not refused", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 404 })));
    const result = await fetchLinkedPage("lib", link, source);
    expect(result.status).toBe("unavailable");
  });

  it("getLibraryDoc still serves a primary URL that redirects across hosts (regression guard)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => responseAt("https://platform.claude.com/llms.txt", "# Claude docs")),
    );
    const doc = await getLibraryDoc({ name: "anthropic", urls: ["https://docs.anthropic.com/llms.txt"] });
    expect(doc?.content).toBe("# Claude docs");
  });
});

describe("response byte caps", () => {
  const source = "https://docs.example.com/llms.txt";
  const link = "https://docs.example.com/big.md";

  it("rejects a followed page early when Content-Length exceeds the linked-page cap", async () => {
    const spy = vi.fn(async () =>
      responseAt(link, "small body", {
        headers: { "content-type": "text/plain", "content-length": String(LINKED_PAGE_MAX_BYTES + 1) },
      }),
    );
    vi.stubGlobal("fetch", spy);
    const result = await fetchLinkedPage("lib", link, source);
    expect(result.status).toBe("too-large");
    expect(readCache("lib", link, 999)).toBeUndefined();
  });

  it("stops reading a streamed followed page once the linked-page cap is exceeded", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => streamedResponse(LINKED_PAGE_MAX_BYTES + 64 * 1024)));
    const result = await fetchLinkedPage("lib", link, source);
    expect(result.status).toBe("too-large");
    expect(readCache("lib", link, 999)).toBeUndefined();
  });

  it("serves a streamed followed page that is exactly at the cap", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => streamedResponse(LINKED_PAGE_MAX_BYTES)));
    const result = await fetchLinkedPage("lib", link, source);
    expect(result.status).toBe("ok");
    if (result.status === "ok") expect(result.page.content.length).toBe(LINKED_PAGE_MAX_BYTES);
  });

  it("primary documents use the larger cap: a body above the linked cap is still served", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => streamedResponse(LINKED_PAGE_MAX_BYTES + 64 * 1024)));
    const doc = await getLibraryDoc({ name: "big-lib", urls: ["https://docs.example.com/llms-full.txt"] });
    expect(doc?.content.length).toBe(LINKED_PAGE_MAX_BYTES + 64 * 1024);
  });

  it("primary documents are rejected above their own cap via Content-Length", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        responseAt("https://docs.example.com/llms-full.txt", "small", {
          headers: { "content-type": "text/plain", "content-length": String(PRIMARY_DOC_MAX_BYTES + 1) },
        }),
      ),
    );
    const doc = await getLibraryDoc({ name: "huge-lib", urls: ["https://docs.example.com/llms-full.txt"] });
    expect(doc).toBeUndefined();
  });

  it("primary documents are rejected above their own cap when streamed", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => streamedResponse(PRIMARY_DOC_MAX_BYTES + 64 * 1024, 1024 * 1024)));
    const doc = await getLibraryDoc({ name: "huge-lib", urls: ["https://docs.example.com/llms-full.txt"] });
    expect(doc).toBeUndefined();
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
