import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isAllowedLink,
  getLibraryDoc,
  getLinkedPage,
  fetchLinkedPage,
  LINKED_PAGE_MAX_BYTES,
  PRIMARY_DOC_MAX_BYTES,
  MAX_REDIRECT_HOPS,
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
  process.env.VIBECTX_CACHE_DIR = dir;
});

afterEach(() => {
  delete process.env.VIBECTX_CACHE_DIR;
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

  it("rejects non-http(s) schemes: file:, javascript:, data:", () => {
    for (const link of ["file:///etc/passwd", "javascript:alert(1)", "data:text/plain,x"]) {
      expect(isAllowedLink(link, source), link).toBe(false);
      expect(isAllowedLink(link, source, { allowedHosts: ["*.example.com"] }), link).toBe(false);
    }
  });

  it("rejects userinfo, IPv6 literals and single-label hosts even when passed as the source (PAR-655 additions)", () => {
    expect(isAllowedLink("https://u:p@docs.example.com/x", source)).toBe(false);
    expect(isAllowedLink("https://[::1]/x", source)).toBe(false);
    expect(isAllowedLink("https://[::1]/x", "https://[::1]/llms.txt")).toBe(false);
    expect(isAllowedLink("https://intranet/x", "https://intranet/llms.txt")).toBe(false);
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

  it("refuses file:, javascript: and data: links without touching the network, policy or not", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const source = "https://docs.example.com/llms.txt";
    for (const link of ["file:///etc/passwd", "javascript:alert(1)", "data:text/plain,x"]) {
      expect(await getLinkedPage("lib", link, source), link).toBeUndefined();
      expect(await fetchLinkedPage("lib", link, source, 168, false, { allowedHosts: ["*.example.com"] }), link).toEqual({ status: "refused" });
    }
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
    expect(result).toMatchObject({ status: "ok", page: { content: "# Moved guide", url: link } });
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

  describe("resolved entries: primary URLs are content-derived, so their final URL must be https on a public host (PAR-655)", () => {
    const resolved = {
      name: "evil-pkg",
      urls: ["https://evil-pkg.example.com/llms.txt"],
      resolved: { source: "npm" as const, resolvedAt: "2026-09-06T00:00:00.000Z", metadataUrl: "https://registry.npmjs.org/evil-pkg/latest" },
    };

    it.each([
      "http://169.254.169.254/latest/meta-data",
      "https://169.254.169.254/latest/meta-data",
      "https://localhost/admin",
      "https://[::1]/x",
      "https://intranet/x",
      "http://evil-pkg.example.com/llms.txt",
    ])("refuses a primary whose redirect chain ends at %s and caches nothing", async (final) => {
      vi.stubGlobal("fetch", vi.fn(async () => responseAt(final, "SECRET")));
      expect(await getLibraryDoc(resolved)).toBeUndefined();
      expect(readCache(resolved.name, resolved.urls[0], 999)).toBeUndefined();
    });

    it("still allows a cross-host https redirect to a public host (D-04 preserved)", async () => {
      vi.stubGlobal("fetch", vi.fn(async () => responseAt("https://docs.evil-pkg.example.org/llms.txt", "# Docs")));
      expect((await getLibraryDoc(resolved))?.content).toBe("# Docs");
    });

    it("a curated (non-resolved) entry keeps the 0.1.3 behaviour on a cross-host redirect", async () => {
      vi.stubGlobal("fetch", vi.fn(async () => responseAt("https://mirror.example.org/llms.txt", "# Mirror")));
      expect((await getLibraryDoc({ name: "curated", urls: ["https://docs.example.com/llms.txt"] }))?.content).toBe("# Mirror");
    });
  });
});

describe("fetchLinkedPage with an allowed-host policy (PAR-655)", () => {
  const source = "https://docs.example.com/llms.txt";
  const policy = { allowedHosts: ["api.example.com", "*.example.org"] };

  it("fetches a link on an allowed host that the same-origin rule would have refused", async () => {
    const link = "https://api.example.com/v1.md";
    const spy = vi.fn(async () => responseAt(link, "# API v1"));
    vi.stubGlobal("fetch", spy);
    expect(await fetchLinkedPage("lib", link, source)).toEqual({ status: "refused" }); // no policy → 0.1.3 behaviour
    expect(spy).not.toHaveBeenCalled();
    const result = await fetchLinkedPage("lib", link, source, 168, false, policy);
    expect(result).toMatchObject({ status: "ok", page: { content: "# API v1", url: link } });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("still refuses hosts outside the policy, IP literals and http, without fetching", async () => {
    const spy = vi.fn();
    vi.stubGlobal("fetch", spy);
    for (const bad of [
      "https://evil.example.net/x.md",
      "https://example.org/x.md", // apex is not covered by *.example.org
      "https://169.254.169.254/latest/meta-data",
      "http://api.example.com/v1.md",
      "https://api.example.com:8443/v1.md",
    ]) {
      expect(await fetchLinkedPage("lib", bad, source, 168, false, policy), bad).toEqual({ status: "refused" });
    }
    expect(spy).not.toHaveBeenCalled();
  });

  it("post-redirect: a followed link that 302s to an allowed host passes and is cached under the link URL", async () => {
    const link = "https://docs.example.com/guide.md";
    vi.stubGlobal("fetch", vi.fn(async () => responseAt("https://sub.example.org/guide.md", "# Moved to sub")));
    const result = await fetchLinkedPage("lib", link, source, 168, false, policy);
    expect(result).toMatchObject({ status: "ok", page: { content: "# Moved to sub", url: link } });
    expect(readCache("lib", link, 999)?.content).toBe("# Moved to sub");
  });

  it("post-redirect: a followed link that 302s to a host outside the policy is refused and never cached", async () => {
    const link = "https://docs.example.com/guide.md";
    for (const escaped of [
      "https://evil.example.net/guide.md",
      "https://example.org/guide.md",
      "https://169.254.169.254/latest/meta-data",
      "https://localhost/admin",
      "http://api.example.com/guide.md",
      "https://api.example.com:8443/guide.md",
      "https://u:p@api.example.com/guide.md",
    ]) {
      vi.stubGlobal("fetch", vi.fn(async () => responseAt(escaped, "SECRET")));
      expect(await fetchLinkedPage("lib", link, source, 168, false, policy), escaped).toEqual({ status: "refused" });
      expect(readCache("lib", link, 999), escaped).toBeUndefined();
    }
  });

  it("post-redirect check uses the allowed-host policy, not origin equality: same policy passes an allowed host and refuses a malformed entry both before and after the redirect", async () => {
    const link = "https://docs.example.com/guide.md";
    // Pass case: the redirect lands on a host the policy allows (origin equality would refuse this).
    vi.stubGlobal("fetch", vi.fn(async () => responseAt("https://api.example.com/guide.md", "# On api")));
    expect(await fetchLinkedPage("lib", link, source, 168, false, policy)).toMatchObject({
      status: "ok",
      page: { content: "# On api", url: link },
    });
    // A malformed policy entry never matches, before or after the redirect.
    const broken = { allowedHosts: ["https://api.example.com"] };
    vi.stubGlobal("fetch", vi.fn(async () => responseAt("https://api.example.com/other.md", "SECRET")));
    expect(await fetchLinkedPage("lib", "https://api.example.com/other.md", source, 168, false, broken)).toEqual({ status: "refused" });
    expect(await fetchLinkedPage("lib", "https://docs.example.com/other.md", source, 168, false, broken)).toEqual({ status: "refused" });
    expect(readCache("lib", "https://docs.example.com/other.md", 999)).toBeUndefined();
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

describe("offline option (cache-only; PAR-707 doctor --offline)", () => {
  const source = "https://docs.example.com/llms.txt";
  const link = "https://docs.example.com/guide.md";

  it("getLibraryDoc serves a fresh cache hit and never calls fetch", async () => {
    const spy = vi.fn();
    vi.stubGlobal("fetch", spy);
    writeCache("off-lib", source, "# Cached");
    const doc = await getLibraryDoc({ name: "off-lib", urls: [source] }, { offline: true });
    expect(doc).toMatchObject({ content: "# Cached", url: source, stale: false });
    expect(spy).not.toHaveBeenCalled();
  });

  it("getLibraryDoc serves a stale cache hit flagged as offline, without calling fetch", async () => {
    const spy = vi.fn();
    vi.stubGlobal("fetch", spy);
    writeCache("off-lib", source, "# Old");
    const doc = await getLibraryDoc({ name: "off-lib", urls: [source], ttlHours: 0 }, { offline: true });
    expect(doc?.content).toBe("# Old");
    expect(doc?.staleNote).toMatch(/^STALE: .*offline/);
    expect(spy).not.toHaveBeenCalled();
  });

  it("getLibraryDoc returns undefined when nothing is cached, without calling fetch", async () => {
    const spy = vi.fn();
    vi.stubGlobal("fetch", spy);
    const doc = await getLibraryDoc({ name: "off-lib", urls: [source, link] }, { offline: true });
    expect(doc).toBeUndefined();
    expect(spy).not.toHaveBeenCalled();
  });

  it("fetchLinkedPage serves cached pages (fresh or stale) and reports the rest unavailable, never fetching", async () => {
    const spy = vi.fn();
    vi.stubGlobal("fetch", spy);
    writeCache("off-lib", link, "# Guide");
    expect(await fetchLinkedPage("off-lib", link, source, 168, true)).toMatchObject({
      status: "ok",
      page: { content: "# Guide", url: link, stale: false },
    });
    const stale = await fetchLinkedPage("off-lib", link, source, 0, true);
    expect(stale.status).toBe("ok");
    if (stale.status === "ok") expect(stale.page.staleNote).toMatch(/^STALE:/);
    expect(await fetchLinkedPage("off-lib", "https://docs.example.com/other.md", source, 168, true)).toEqual({
      status: "unavailable",
    });
    expect(spy).not.toHaveBeenCalled();
  });

  it("fetchLinkedPage still refuses cross-origin links offline (guard runs before the cache)", async () => {
    const spy = vi.fn();
    vi.stubGlobal("fetch", spy);
    const result = await fetchLinkedPage("off-lib", "https://evil.example.net/x.md", source, 168, true);
    expect(result).toEqual({ status: "refused" });
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("DocResult.fetchedAt / .stale (A17/PAR-726): every return path states when the document was fetched and whether it is past TTL, not just the staleNote prose", () => {
  const source = "https://docs.example.com/llms.txt";
  const link = "https://docs.example.com/guide.md";

  it("getLibraryDoc, fresh cache hit: fetchedAt is the cache meta's own value, stale is false", async () => {
    writeCache("fresh-lib", source, "# Fresh");
    const before = readCache("fresh-lib", source, 999)!.meta.fetchedAt;
    const doc = await getLibraryDoc({ name: "fresh-lib", urls: [source] });
    expect(doc).toMatchObject({ fetchedAt: before, stale: false });
    expect(doc?.staleNote).toBeUndefined();
  });

  it("getLibraryDoc, fresh network fetch: fetchedAt is exactly what writeCache persisted, not a second, separately-taken timestamp", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => responseAt(source, "# New")));
    const doc = await getLibraryDoc({ name: "new-lib", urls: [source] });
    const persisted = readCache("new-lib", source, 999)!.meta.fetchedAt;
    expect(doc).toMatchObject({ fetchedAt: persisted, stale: false });
  });

  it("getLibraryDoc, 304 revalidation: fetchedAt is the touched (refreshed) value, not the pre-revalidation one", async () => {
    writeCache("touch-lib", source, "# Cached", '"etag1"');
    const before = readCache("touch-lib", source, 999)!.meta.fetchedAt;
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 304 })));
    await new Promise((r) => setTimeout(r, 5));
    const doc = await getLibraryDoc({ name: "touch-lib", urls: [source], ttlHours: 0 });
    expect(doc?.stale).toBe(false);
    expect(doc?.fetchedAt).not.toBe(before);
    expect(doc?.fetchedAt).toBe(readCache("touch-lib", source, 999)!.meta.fetchedAt);
  });

  it("getLibraryDoc, stale fallback (network down): fetchedAt is the stale cache's own meta value, stale is true", async () => {
    writeCache("stale-lib", source, "# Old");
    const before = readCache("stale-lib", source, 999)!.meta.fetchedAt;
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 404 })));
    const doc = await getLibraryDoc({ name: "stale-lib", urls: [source], ttlHours: 0 });
    expect(doc).toMatchObject({ fetchedAt: before, stale: true });
    expect(doc?.staleNote).toMatch(/^STALE:/);
  });

  it("fetchLinkedPage: the same four cases carry the same fetchedAt/stale contract as getLibraryDoc", async () => {
    writeCache("page-lib", link, "# Guide");
    const before = readCache("page-lib", link, 999)!.meta.fetchedAt;
    const fresh = await fetchLinkedPage("page-lib", link, source, 999);
    if (fresh.status === "ok") expect(fresh.page).toMatchObject({ fetchedAt: before, stale: false });
    else expect.unreachable();

    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 404 })));
    const stale = await fetchLinkedPage("page-lib", link, source, 0);
    if (stale.status === "ok") expect(stale.page).toMatchObject({ fetchedAt: before, stale: true });
    else expect.unreachable();
  });
});

describe("PAR-776 (D-74) — DocResult.finalUrl", () => {
  const source = "https://docs.example.com/llms.txt";
  const link = "https://docs.example.com/guide.md";

  it("getLibraryDoc, fresh network fetch with no redirect: finalUrl equals the candidate url", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => responseAt(source, "# Doc")));
    const doc = await getLibraryDoc({ name: "no-redirect-lib", urls: [source] });
    expect(doc).toMatchObject({ url: source, finalUrl: source });
  });

  it("getLibraryDoc, fresh network fetch that redirects: finalUrl is the redirect target, url stays the candidate", async () => {
    const final = "https://final.example.com/llms.txt";
    vi.stubGlobal("fetch", vi.fn(async () => responseAt(final, "# Doc")));
    const doc = await getLibraryDoc({ name: "redirect-lib", urls: [source] });
    expect(doc).toMatchObject({ url: source, finalUrl: final });
    // Persisted, not just returned live — the whole point is a later cache-hit still knows it.
    expect(readCache("redirect-lib", source, 999)?.meta.finalUrl).toBe(final);
  });

  it("getLibraryDoc, fresh cache hit (no network call at all): finalUrl comes from the persisted meta, not just the candidate url", async () => {
    const final = "https://final.example.com/llms.txt";
    writeCache("cached-redirect-lib", source, "# Doc", undefined, final);
    const spy = vi.fn();
    vi.stubGlobal("fetch", spy);
    const doc = await getLibraryDoc({ name: "cached-redirect-lib", urls: [source] });
    expect(spy).not.toHaveBeenCalled();
    expect(doc).toMatchObject({ url: source, finalUrl: final });
  });

  it("getLibraryDoc, 304 revalidation that still redirects: finalUrl is (re)computed from the redirect actually followed, not left stale", async () => {
    // A real revalidation re-requests the CANDIDATE url every time, so a site that keeps
    // redirecting keeps redirecting on revalidation too — the hop loop lands on `final`
    // before the 304 is ever seen, exactly as it did on the original fetch.
    const final = "https://final.example.com/llms.txt";
    writeCache("touch-redirect-lib", source, "# Doc", '"etag1"', final);
    const fetchSpy = vi.fn(async (input: unknown) => {
      if (String(input) === source) return new Response(null, { status: 301, headers: { location: final } });
      return new Response(null, { status: 304 });
    });
    vi.stubGlobal("fetch", fetchSpy);
    const doc = await getLibraryDoc({ name: "touch-redirect-lib", urls: [source], ttlHours: 0 });
    expect(doc).toMatchObject({ finalUrl: final });
    expect(readCache("touch-redirect-lib", source, 999)?.meta.finalUrl).toBe(final);
  });

  it("getLibraryDoc, stale fallback (network down): finalUrl comes from the stale cache's own meta", async () => {
    const final = "https://final.example.com/llms.txt";
    writeCache("stale-redirect-lib", source, "# Doc", undefined, final);
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 404 })));
    const doc = await getLibraryDoc({ name: "stale-redirect-lib", urls: [source], ttlHours: 0 });
    expect(doc).toMatchObject({ stale: true, finalUrl: final });
  });

  it("fetchLinkedPage: a redirecting followed link reports its own finalUrl the same way", async () => {
    // Same-origin as `source` (the same-origin rule always allows it) — a cross-host redirect
    // additionally needing an allowed-host policy match is covered in the host-policy suite.
    const final = "https://docs.example.com/redirected-guide.md";
    vi.stubGlobal("fetch", vi.fn(async () => responseAt(final, "# Guide")));
    const result = await fetchLinkedPage("page-redirect-lib", link, source, 999);
    expect(result).toMatchObject({ status: "ok", page: { url: link, finalUrl: final } });
  });

  it("fetchLinkedPage: no redirect — finalUrl equals the link url", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => responseAt(link, "# Guide")));
    const result = await fetchLinkedPage("page-no-redirect-lib", link, source, 999);
    expect(result).toMatchObject({ status: "ok", page: { url: link, finalUrl: link } });
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
    // PAR-744 — the field `refresh.ts` now uses to distinguish a 304 (nothing to drop) from a
    // genuine fresh fetch: a byte-identical revalidation must say so, not look like a change.
    expect(doc?.notModified).toBe(true);
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
    // PAR-744 — a genuine fresh fetch (a real 200, not a revalidation) must NOT be mistaken
    // for a 304: the field is absent, not false, matching every other optional DocResult flag.
    expect(doc?.notModified).toBeUndefined();
    expect(readCache(entry.name, entry.urls[0], 999)?.meta.etag).toBe('"v2"');
  });

  /** PAR-744 — `fetchLinkedPage` gets the same `notModified` flag `getLibraryDoc` does, for
   *  the same reason: a followed page revalidated via 304 is not a page that changed. */
  it("fetchLinkedPage: a 304 revalidation sets notModified on the returned page, a fresh 200 does not", async () => {
    const source = "https://docs.example.com/llms.txt";
    const link = "https://docs.example.com/guide.md";
    writeCache("linked-lib", link, "# Cached guide", '"etag-1"');
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 304 })));
    const revalidated = await fetchLinkedPage("linked-lib", link, source, 0);
    expect(revalidated).toMatchObject({ status: "ok", page: { content: "# Cached guide", url: link, stale: false, notModified: true } });

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("# New guide", { status: 200, headers: { "content-type": "text/plain" } })),
    );
    const fresh = await fetchLinkedPage("linked-lib", link, source, 0);
    expect(fresh).toMatchObject({ status: "ok", page: { content: "# New guide", url: link, stale: false } });
    if (fresh.status === "ok") expect(fresh.page.notModified).toBeUndefined(); // absent, not false
  });
});

describe("hop-by-hop redirects (S1): every Location is checked BEFORE it is requested", () => {
  const source = "https://docs.example.com/llms.txt";
  const link = "https://docs.example.com/guide.md";
  const policy = { allowedHosts: ["*.example.org"] };
  const resolvedMeta = { source: "npm" as const, resolvedAt: "2026-09-06T00:00:00.000Z", metadataUrl: "https://registry.npmjs.org/evil/latest" };
  let server: Server;
  let listenerHits: string[];
  let port: number;
  const realFetch = globalThis.fetch;

  beforeEach(async () => {
    listenerHits = [];
    server = createServer((req, res) => {
      listenerHits.push(`${req.method} ${req.url}`);
      if (req.url === "/start") {
        res.writeHead(302, { location: "/admin/reboot?x=1" });
        res.end();
        return;
      }
      res.end("SECRET");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    port = (server.address() as AddressInfo).port;
  });

  afterEach(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  const redirect = (location: string) => new Response(null, { status: 302, headers: { location } });

  /** Stub: the https origin answers from `routes` (a string is a 200 body, a Response is returned as is);
   *  anything else goes to the REAL fetch — so a followed hop to the listener is observable. */
  function stubOrigin(routes: Record<string, string | Response | (() => Response)>) {
    const spy = vi.fn(async (url: unknown, init?: RequestInit) => {
      const r = routes[String(url)];
      if (r === undefined) return realFetch(url as string, init);
      if (typeof r === "string") return new Response(r, { status: 200, headers: { "content-type": "text/plain" } });
      return typeof r === "function" ? r() : r;
    });
    vi.stubGlobal("fetch", spy);
    return spy;
  }

  it("linkGuard path: a 302 to http://127.0.0.1:<port> produces ZERO requests at the listener and is refused", async () => {
    const spy = stubOrigin({ [link]: () => redirect(`http://127.0.0.1:${port}/admin/reboot?x=1`) });
    expect(await fetchLinkedPage("lib", link, source, 168, false, policy)).toEqual({ status: "refused" });
    expect(listenerHits).toEqual([]);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(readCache("lib", link, 999)).toBeUndefined();
  });

  it("publicFinalUrl path (resolved primary): a 302 to the listener produces ZERO requests and nothing is served or cached", async () => {
    const primary = "https://evil-pkg.example.com/llms.txt";
    for (const target of [`http://127.0.0.1:${port}/admin/reboot?x=1`, `https://127.0.0.1:${port}/x`, `https://localhost:${port}/x`]) {
      const spy = stubOrigin({ [primary]: () => redirect(target) });
      expect(await getLibraryDoc({ name: "evil", urls: [primary], resolved: resolvedMeta }), target).toBeUndefined();
      expect(listenerHits, target).toEqual([]);
      expect(spy, target).toHaveBeenCalledTimes(1);
    }
    expect(readCache("evil", primary, 999)).toBeUndefined();
  });

  it("curated primary (no guard, D-04): cross-host https redirects are followed, but never to http / an IP / localhost", async () => {
    stubOrigin({
      "https://docs.example.com/llms.txt": () => redirect("https://platform.example.org/llms.txt"),
      "https://platform.example.org/llms.txt": "# Moved docs",
    });
    expect((await getLibraryDoc({ name: "curated", urls: ["https://docs.example.com/llms.txt"] }))?.content).toBe("# Moved docs");
    stubOrigin({ "https://docs.example.com/llms.txt": () => redirect(`http://127.0.0.1:${port}/admin/reboot?x=1`) });
    expect(await getLibraryDoc({ name: "curated2", urls: ["https://docs.example.com/llms.txt"] })).toBeUndefined();
    expect(listenerHits).toEqual([]);
  });

  it("a real listener that 302s to itself: the operator-configured first request is made, the hop is not; a resolved entry's http first URL is not even requested", async () => {
    vi.stubGlobal("fetch", realFetch);
    const start = `http://127.0.0.1:${port}/start`;
    expect(await getLibraryDoc({ name: "cur-local", urls: [start] })).toBeUndefined();
    expect(listenerHits).toEqual(["GET /start"]); // never GET /admin/reboot
    expect(await getLibraryDoc({ name: "res-local", urls: [start], resolved: resolvedMeta })).toBeUndefined();
    expect(listenerHits).toEqual(["GET /start"]); // the resolved entry's first URL fails the baseline pre-flight
  });

  it("a 302 to an allowed https host is followed; relative Locations resolve against the current URL; the page is cached under the link URL", async () => {
    const spy = stubOrigin({
      [link]: () => redirect("https://sub.example.org/v2/guide.md"),
      "https://sub.example.org/v2/guide.md": () => redirect("../v3/guide.md"),
      "https://sub.example.org/v3/guide.md": "# Guide v3",
    });
    expect(await fetchLinkedPage("lib", link, source, 168, false, policy)).toMatchObject({ status: "ok", page: { content: "# Guide v3", url: link } });
    expect(spy.mock.calls.map((c) => String(c[0]))).toEqual([link, "https://sub.example.org/v2/guide.md", "https://sub.example.org/v3/guide.md"]);
    expect(readCache("lib", link, 999)?.content).toBe("# Guide v3");
  });

  it("a hop to a disallowed host in the MIDDLE of a chain is refused before it is requested", async () => {
    const spy = stubOrigin({
      [link]: () => redirect("https://sub.example.org/a.md"),
      "https://sub.example.org/a.md": () => redirect("https://evil.example.net/b.md"),
      "https://evil.example.net/b.md": "SECRET",
    });
    expect(await fetchLinkedPage("lib", link, source, 168, false, policy)).toEqual({ status: "refused" });
    expect(spy.mock.calls.map((c) => String(c[0]))).not.toContain("https://evil.example.net/b.md");
  });

  it(`more than ${MAX_REDIRECT_HOPS} hops is a miss, and the next hop is not requested`, async () => {
    const routes: Record<string, () => Response> = {};
    routes[link] = () => redirect("https://docs.example.com/r1.md");
    for (let i = 1; i <= MAX_REDIRECT_HOPS + 2; i++) routes[`https://docs.example.com/r${i}.md`] = () => redirect(`https://docs.example.com/r${i + 1}.md`);
    const spy = stubOrigin(routes);
    expect(await fetchLinkedPage("lib", link, source, 168, false, policy)).toEqual({ status: "unavailable" });
    expect(spy).toHaveBeenCalledTimes(1 + MAX_REDIRECT_HOPS);
    expect(MAX_REDIRECT_HOPS).toBe(5);
  });

  it("a 3xx without a Location, or with an unparseable one, is a miss and nothing further is requested", async () => {
    let spy = stubOrigin({ [link]: () => new Response(null, { status: 302 }) });
    expect(await fetchLinkedPage("lib", link, source, 168, false, policy)).toEqual({ status: "unavailable" });
    expect(spy).toHaveBeenCalledTimes(1);
    spy = stubOrigin({ [link]: () => redirect("http://[::1") });
    expect(await fetchLinkedPage("lib", link, source, 168, false, policy)).toEqual({ status: "unavailable" });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("the existing final-URL check still applies when the runtime reports a different res.url", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => responseAt("http://169.254.169.254/latest/meta-data", "SECRET")));
    expect(await fetchLinkedPage("lib", link, source, 168, false, policy)).toEqual({ status: "refused" });
  });

  it("R1: trailing-dot hosts (localhost., x.internal., x.local., foo.) are refused as redirect targets on the publicFinalUrl path", async () => {
    const primary = "https://evil-pkg.example.com/llms.txt";
    for (const host of ["localhost.", "x.internal.", "x.local.", "foo."]) {
      const spy = stubOrigin({ [primary]: () => redirect(`https://${host}/x`) });
      expect(await getLibraryDoc({ name: "evil", urls: [primary], resolved: resolvedMeta }), host).toBeUndefined();
      expect(spy, host).toHaveBeenCalledTimes(1);
    }
  });

  /** security-architect, PAR-776 round 1, N-3: `isPublicHttpsUrl` is the redirect path's own
   *  gate (`hopAllowed`), and was the one URL-trust check in this codebase that didn't reject
   *  userinfo — unlike `sanitizeRemoteUrl`, `validateLibraryUrl` and `isAllowedLink`. Matters
   *  more since PAR-776: a redirect target carrying `user:pass@` used to be accepted, then
   *  PERSISTED (`cache.ts`'s `finalUrl`) and RENDERED (the `Source:` stamp) — not just used and
   *  discarded the way it was before `finalUrl` existed. */
  it("(security-architect, PAR-776 round 1, N-3) a redirect target carrying userinfo is refused, not silently accepted", async () => {
    const primary = "https://evil-pkg.example.com/llms.txt";
    const spy = stubOrigin({ [primary]: () => redirect("https://user:pass@docs.example.com/x") });
    expect(await getLibraryDoc({ name: "evil", urls: [primary], resolved: resolvedMeta })).toBeUndefined();
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
