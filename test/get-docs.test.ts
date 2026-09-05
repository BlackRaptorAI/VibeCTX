import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDocs } from "../src/get-docs.js";
import { writeCache } from "../src/cache.js";
import { MAX_FOLLOWED_BYTES } from "../src/retrieval.js";
import { LINKED_PAGE_MAX_BYTES } from "../src/fetcher.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "docs-cache-getdocs-"));
  process.env.DOCS_CACHE_DIR = dir;
});

afterEach(() => {
  delete process.env.DOCS_CACHE_DIR;
  rmSync(dir, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

const INDEX_URL = "https://fastify.dev/llms.txt";
const entry = { name: "fastify", urls: [INDEX_URL] };

/** Seed the index into the cache (fresh) so getLibraryDoc never hits the network;
 *  only followed links go through the stubbed fetch. */
function seedIndex(content: string) {
  writeCache(entry.name, INDEX_URL, content);
}

function stubFetch(pages: Record<string, string>) {
  const spy = vi.fn(async (url: unknown) => {
    const body = pages[String(url)];
    if (body === undefined) return new Response("not found", { status: 404 });
    return new Response(body, {
      status: 200,
      headers: { "content-type": "text/plain" },
    });
  });
  vi.stubGlobal("fetch", spy);
  return spy;
}

describe("getDocs index following", () => {
  it("follows relative index links resolved against the index URL and returns their sections", async () => {
    seedIndex(
      [
        "# Fastify",
        "- [Request](/docs/latest/Reference/Request.md): the request object",
        "- [Reply](/docs/latest/Reference/Reply.md): the reply object",
        "- [Hooks](/docs/latest/Reference/Hooks.md): lifecycle hooks",
      ].join("\n"),
    );
    const spy = stubFetch({
      "https://fastify.dev/docs/latest/Reference/Request.md":
        "# Request\n\n## request.hostname\n\nThe hostname of the incoming request.",
    });
    const out = await getDocs(entry, { topic: "request hostname" });
    expect(spy).toHaveBeenCalledWith(
      "https://fastify.dev/docs/latest/Reference/Request.md",
      expect.anything(),
    );
    expect(out).toContain("request.hostname");
    expect(out).toContain("Followed index links: https://fastify.dev/docs/latest/Reference/Request.md");
    expect(out).not.toContain("No sections matched");
  });

  it("reports index links skipped by the origin guard instead of dropping them silently", async () => {
    seedIndex(
      [
        "# Fastify",
        "- [Request docs](https://github.com/fastify/fastify/blob/main/docs/Request.md)",
        "- [Request mirror](https://mirror.example.net/Request.md)",
        "- [Reply](https://fastify.dev/docs/Reply.md)",
      ].join("\n"),
    );
    const spy = stubFetch({});
    const out = await getDocs(entry, { topic: "request" });
    expect(spy).not.toHaveBeenCalled();
    expect(out).toContain("Skipped 2 index links outside https://fastify.dev");
  });

  it("does not let guard-refused links consume the follow budget", async () => {
    // Three cross-origin candidates and one same-origin candidate, all tied on score
    // ("request" once in each title). The same-origin page must still be fetched.
    seedIndex(
      [
        "# Fastify",
        "- [Request A](https://github.com/fastify/fastify/blob/main/docs/A.md)",
        "- [Request B](https://github.com/fastify/fastify/blob/main/docs/B.md)",
        "- [Request C](https://github.com/fastify/fastify/blob/main/docs/C.md)",
        "- [Request D](/docs/D.md)",
      ].join("\n"),
    );
    const spy = stubFetch({ "https://fastify.dev/docs/D.md": "# Request D\n\nrequest details" });
    const out = await getDocs(entry, { topic: "request" });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(out).toContain("Followed index links: https://fastify.dev/docs/D.md");
    expect(out).toContain("Skipped 3 index links outside https://fastify.dev");
  });

  it("renders the skipped note on the no-match response (protocol-relative links, topic only in the resolved URL)", async () => {
    // "https" appears in no index line — only in the resolved URL — so the links are
    // candidates but the index text itself has no matching section.
    seedIndex(
      [
        "# Fastify",
        "- [Request](//github.com/fastify/fastify/blob/main/docs/Request.md)",
        "- [Reply](//github.com/fastify/fastify/blob/main/docs/Reply.md)",
        "- [Hooks](//github.com/fastify/fastify/blob/main/docs/Hooks.md)",
      ].join("\n"),
    );
    const spy = stubFetch({});
    const out = await getDocs(entry, { topic: "https" });
    expect(spy).not.toHaveBeenCalled();
    expect(out).toContain('No sections matched "https"');
    expect(out).toContain("Skipped 3 index links outside https://fastify.dev");
  });

  it("counts a followed link whose redirect escaped the origin as skipped, not as a fetch failure", async () => {
    seedIndex(["# Fastify", "- [Request](/docs/Request.md)", "- [Reply](/docs/Reply.md)"].join("\n"));
    const spy = vi.fn(async () => {
      const res = new Response("SECRET", { status: 200, headers: { "content-type": "text/plain" } });
      Object.defineProperty(res, "url", { value: "http://169.254.169.254/latest/meta-data" });
      return res;
    });
    vi.stubGlobal("fetch", spy);
    const out = await getDocs(entry, { topic: "request" });
    expect(out).toContain("Skipped 1 index links outside https://fastify.dev");
    expect(out).not.toContain("Could not fetch");
    expect(out).not.toContain("SECRET");
  });

  it("reports a followed page dropped for exceeding the per-page cap", async () => {
    seedIndex(["# Fastify", "- [Request](/docs/Request.md)", "- [Reply](/docs/Reply.md)"].join("\n"));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response("small", {
          status: 200,
          headers: { "content-type": "text/plain", "content-length": String(LINKED_PAGE_MAX_BYTES + 1) },
        }),
      ),
    );
    const out = await getDocs(entry, { topic: "request" });
    expect(out).toContain("Skipped 1 index links larger than 2 MB: https://fastify.dev/docs/Request.md");
  });

  it("keeps the no-match response for a topic nothing in the index mentions", async () => {
    seedIndex(["# Fastify", "- [Request](/docs/Request.md)", "- [Reply](/docs/Reply.md)"].join("\n"));
    const spy = stubFetch({});
    const out = await getDocs(entry, { topic: "zzz-unmatched" });
    expect(spy).not.toHaveBeenCalled();
    expect(out).toContain('No sections matched "zzz-unmatched"');
    expect(out).not.toContain("Skipped");
  });

  it("reports followed links whose fetch failed", async () => {
    seedIndex(["# Fastify", "- [Request](/docs/Request.md)", "- [Reply](/docs/Reply.md)"].join("\n"));
    stubFetch({}); // every fetch 404s
    const out = await getDocs(entry, { topic: "request" });
    expect(out).toContain("Could not fetch 1 index links: https://fastify.dev/docs/Request.md");
  });

  it("follows at most 3 links for a small index", async () => {
    const lines = ["# Fastify"];
    for (let i = 0; i < 20; i++) lines.push(`- [Request page ${i}](/docs/R${i}.md)`);
    seedIndex(lines.join("\n"));
    const pages: Record<string, string> = {};
    for (let i = 0; i < 20; i++) pages[`https://fastify.dev/docs/R${i}.md`] = `# Request page ${i}\n\nrequest body ${i}`;
    const spy = stubFetch(pages);
    await getDocs(entry, { topic: "request" });
    expect(spy).toHaveBeenCalledTimes(3);
  });

  it("follows up to 5 links for an index with more than 200 links", async () => {
    const lines = ["# Fastify"];
    for (let i = 0; i < 250; i++) lines.push(`- [Request page ${i}](/docs/R${i}.md)`);
    seedIndex(lines.join("\n"));
    const pages: Record<string, string> = {};
    for (let i = 0; i < 250; i++) pages[`https://fastify.dev/docs/R${i}.md`] = `# Request page ${i}\n\nrequest body ${i}`;
    const spy = stubFetch(pages);
    await getDocs(entry, { topic: "request" });
    expect(spy).toHaveBeenCalledTimes(5);
  });

  it("stops following once ~2 MB of linked content has been fetched", async () => {
    const lines = ["# Fastify"];
    for (let i = 0; i < 250; i++) lines.push(`- [Request page ${i}](/docs/R${i}.md)`);
    seedIndex(lines.join("\n"));
    const big = `# Request\n\n${"request ".repeat(Math.ceil(MAX_FOLLOWED_BYTES / 2 / 8) + 1)}`;
    expect(big.length).toBeGreaterThan(MAX_FOLLOWED_BYTES / 2);
    const pages: Record<string, string> = {};
    for (let i = 0; i < 250; i++) pages[`https://fastify.dev/docs/R${i}.md`] = big;
    const spy = stubFetch(pages);
    await getDocs(entry, { topic: "request" });
    // Two pages of > 1 MB each cross the cap; the third (and fourth, fifth) must not be fetched.
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("reports every candidate URL when nothing is reachable and nothing is cached", async () => {
    const spy = stubFetch({});
    const out = await getDocs(
      { name: "ghost", urls: ["https://ghost.example.com/llms-full.txt", "https://ghost.example.com/llms.txt"] },
      { topic: "anything" },
    );
    expect(spy).toHaveBeenCalledTimes(2);
    expect(out).toContain('Could not fetch docs for "ghost"');
    expect(out).toContain("https://ghost.example.com/llms-full.txt\nhttps://ghost.example.com/llms.txt");
  });

  it("returns the table of contents and document head when no topic is given", async () => {
    seedIndex(
      [
        "# Fastify",
        "Intro text.",
        "## Reference",
        "### Request",
        "#### Too deep for the TOC",
        "- [Request](/docs/Request.md)",
      ].join("\n"),
    );
    const spy = stubFetch({});
    const out = await getDocs(entry, { maxTokens: 5 }); // head = 20 chars
    expect(spy).not.toHaveBeenCalled();
    expect(out).toContain("Source: https://fastify.dev/llms.txt");
    expect(out).toContain("Table of contents:\n# Fastify\n## Reference\n### Request\n\n---\n\n");
    expect(out).not.toContain("#### Too deep");
    expect(out.endsWith("\n\n---\n\n# Fastify\nIntro text")).toBe(true); // 20-char head, period cut
  });

  it("does not follow links when the document is prose", async () => {
    seedIndex(
      [
        "# Guide",
        "Prose paragraph one about the request object.",
        "Prose paragraph two about hooks.",
        "See [Request](/docs/Request.md) for details.",
        "More prose. More prose. More prose.",
      ].join("\n"),
    );
    const spy = stubFetch({});
    const out = await getDocs(entry, { topic: "request" });
    expect(spy).not.toHaveBeenCalled();
    expect(out).toContain("Source: https://fastify.dev/llms.txt");
  });
});
