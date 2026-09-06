import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDocs, getDocsDetailed, getDocsToolText } from "../src/get-docs.js";
import { writeCache } from "../src/cache.js";
import type { Registry } from "../src/registry.js";
import { MAX_FOLLOWED_BYTES } from "../src/retrieval.js";
import { LINKED_PAGE_MAX_BYTES } from "../src/fetcher.js";
import { derivedAllowedHosts } from "../src/link-policy.js";

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
    expect(out).toContain("Skipped 2 index links outside allowed hosts (fastify.dev)");
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
    expect(out).toContain("Skipped 3 index links outside allowed hosts (fastify.dev)");
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
    expect(out).toContain("Skipped 3 index links outside allowed hosts (fastify.dev)");
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
    expect(out).toContain("Skipped 1 index links outside allowed hosts (fastify.dev)");
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
    expect(out).toContain("Skipped 1 index links larger than 2 MiB: https://fastify.dev/docs/Request.md");
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

  it("exposes followed / dropped counts and section origin structurally (PAR-707)", async () => {
    seedIndex(
      [
        "# Fastify",
        "- [Request](/docs/Request.md)",
        "- [Request mirror](https://mirror.example.net/Request.md)",
        "- [Request big](/docs/Big.md)",
        "- [Request gone](/docs/Gone.md)",
      ].join("\n"),
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: unknown) => {
        const u = String(url);
        if (u.endsWith("/Request.md")) {
          return new Response("# Request\n\n## request.hostname\n\nThe hostname of the incoming request.", {
            status: 200,
            headers: { "content-type": "text/plain" },
          });
        }
        if (u.endsWith("/Big.md")) {
          return new Response("x", {
            status: 200,
            headers: { "content-type": "text/plain", "content-length": String(LINKED_PAGE_MAX_BYTES + 1) },
          });
        }
        return new Response("nope", { status: 404 });
      }),
    );
    const out = await getDocsDetailed(entry, { topic: "request hostname" });
    expect(out.source).toEqual({ url: INDEX_URL, stale: false });
    expect(out.isIndex).toBe(true);
    expect(out.followed).toEqual(["https://fastify.dev/docs/Request.md"]);
    expect(out.dropped).toEqual({ outsideOrigin: 1, tooLarge: 1, unavailable: 1 });
    expect(out.matched).toBeGreaterThan(0);
    // The best section came from the followed page, not from the index's own link list.
    expect(out.returnedFromFollowed).toBeGreaterThan(0);
    expect(out.text).toBe(await getDocs(entry, { topic: "request hostname" }));
  });

  it("does not count the synthetic link-title heading as an answer from a followed page", async () => {
    // get_docs prefixes each followed page with "# <link title>". That heading alone
    // matches "request" but carries no content; a followed page that says nothing
    // about the topic must not register as returnedFromFollowed.
    seedIndex(["# Fastify", "- [Request](/docs/Request.md)", "- [Reply](/docs/Reply.md)"].join("\n"));
    stubFetch({ "https://fastify.dev/docs/Request.md": "# Unrelated\n\nNothing about the topic here." });
    const out = await getDocsDetailed(entry, { topic: "request" });
    expect(out.followed).toEqual(["https://fastify.dev/docs/Request.md"]);
    expect(out.matched).toBeGreaterThan(0); // the index's own link line still matches
    expect(out.returnedFromFollowed).toBe(0);
  });

  /**
   * K1 / D-31 — the primary document and every followed page are split SEPARATELY and
   * their section lists concatenated. Before, the texts were concatenated and split
   * once, so an unclosed fence in the index swallowed whatever was appended after it:
   * the followed page's sections, its `# <link title>` marker and all.
   */
  it("(D-31) an unclosed fence in the primary document cannot swallow a followed page", async () => {
    seedIndex(
      [
        "# Fastify",
        "- [Request](/docs/Request.md): the request object",
        "- [Reply](/docs/Reply.md): the reply object",
        "- [Hooks](/docs/Hooks.md): lifecycle hooks",
        "```", // never closed: everything after this is code, in THIS document
        "request",
      ].join("\n"),
    );
    stubFetch({
      "https://fastify.dev/docs/Request.md":
        "## request.hostname\n\nThe hostname of the incoming request.\n\n## request.id\n\nThe request id.",
    });
    const out = await getDocsDetailed(entry, { topic: "request hostname" });
    expect(out.followed).toEqual(["https://fastify.dev/docs/Request.md"]);
    expect(out.text).toContain("request.hostname");
    expect(out.matched).toBeGreaterThan(1); // the followed page's sections are counted
    expect(out.returnedFromFollowed).toBeGreaterThan(0);
    // No section's heading path mixes the two documents: the followed page's sections
    // sit under its own "# Request" marker, never under the index's headings.
    expect(out.text).toContain("## Request > request.hostname");
    expect(out.text).not.toContain("Fastify > request.hostname");
  });

  it("(D-31) keeps the link-title marker as the followed page's root heading", async () => {
    seedIndex(["# Fastify", "- [Routing guides](/docs/Guides.md)", "- [Reply](/docs/Reply.md)"].join("\n"));
    stubFetch({
      "https://fastify.dev/docs/Guides.md": "## Getting started\n\nInstall the framework and write a route.",
    });
    const out = await getDocsDetailed(entry, { topic: "routing getting started" });
    expect(out.text).toContain("## Routing guides > Getting started");
  });

  it("reports no source and zero matches structurally when nothing is reachable or cached", async () => {
    stubFetch({});
    const out = await getDocsDetailed({ name: "ghost", urls: ["https://ghost.example.com/llms.txt"] }, { topic: "x" });
    expect(out.source).toBeUndefined();
    expect(out.isIndex).toBe(false);
    expect(out.matched).toBe(0);
    expect(out.followed).toEqual([]);
    expect(out.text).toContain('Could not fetch docs for "ghost"');
  });

  it("marks a stale-served source as stale and counts an answer from the index itself as not from followed pages", async () => {
    seedIndex(["# Fastify", "- [Request](/docs/Request.md)", "- [Reply](/docs/Reply.md)"].join("\n"));
    stubFetch({}); // followed page 404s; the index line itself still matches "request"
    const stale = { ...entry, ttlHours: 0 };
    const out = await getDocsDetailed(stale, { topic: "request" });
    expect(out.source).toEqual({ url: INDEX_URL, stale: true });
    expect(out.matched).toBeGreaterThan(0);
    expect(out.returnedFromFollowed).toBe(0);
    expect(out.dropped.unavailable).toBe(1);
  });

  it("follows a cross-host link when the entry's allowedHosts permits it, and lists the allowed hosts in the skipped note (PAR-655)", async () => {
    seedIndex(
      [
        "# Fastify",
        "- [Request on api](https://api.fastify.dev/Request.md)",
        "- [Request mirror](https://mirror.example.net/Request.md)",
        "- [Reply](/docs/Reply.md)",
      ].join("\n"),
    );
    const spy = stubFetch({ "https://api.fastify.dev/Request.md": "# Request\n\n## request.hostname\n\nFrom the api host." });
    const withHosts = { ...entry, allowedHosts: ["api.fastify.dev"] };
    const out = await getDocs(withHosts, { topic: "request hostname" });
    expect(spy).toHaveBeenCalledWith("https://api.fastify.dev/Request.md", expect.anything());
    expect(out).toContain("From the api host");
    expect(out).toContain("Followed index links: https://api.fastify.dev/Request.md");
    expect(out).toContain("Skipped 1 index links outside allowed hosts (fastify.dev, api.fastify.dev)");
  });

  it("a followed link whose redirect lands on an allowed host is served; one that lands elsewhere is skipped", async () => {
    seedIndex(["# Fastify", "- [Request](/docs/Request.md)", "- [Reply](/docs/Reply.md)"].join("\n"));
    const redirectTo = (target: string) =>
      vi.fn(async () => {
        const res = new Response("# Request\n\n## request.hostname\n\nredirected body", { status: 200, headers: { "content-type": "text/plain" } });
        Object.defineProperty(res, "url", { value: target });
        return res;
      });
    const withHosts = { ...entry, allowedHosts: ["*.fastify.dev"] };
    // Escaping redirect first: refused, so nothing is cached under the link URL …
    vi.stubGlobal("fetch", redirectTo("https://docs.fastify.dev.evil.net/Request.md"));
    const out = await getDocs(withHosts, { topic: "request hostname" });
    expect(out).not.toContain("redirected body");
    expect(out).toContain("Skipped 1 index links outside allowed hosts (fastify.dev, *.fastify.dev)");
    // … and the allowed redirect is then fetched and served.
    vi.stubGlobal("fetch", redirectTo("https://docs.fastify.dev/Request.md"));
    expect(await getDocs(withHosts, { topic: "request hostname" })).toContain("redirected body");
  });

  it("Q1: a RESOLVED entry with derived allowedHosts: the derived-host link is fetched, off-policy links are skipped, never fetched and never consume the budget", async () => {
    const primary = "https://raw.githubusercontent.com/acme/acme/HEAD/README.md";
    const resolvedEntry = {
      name: "acme",
      urls: [primary],
      allowedHosts: derivedAllowedHosts({ homepage: "https://acme.dev/" }), // → acme.dev, docs.acme.dev
      resolved: { source: "npm" as const, resolvedAt: "2026-09-06T00:00:00.000Z", metadataUrl: "https://registry.npmjs.org/acme/latest", homepage: "https://acme.dev/" },
    };
    expect(resolvedEntry.allowedHosts).toEqual(["acme.dev", "docs.acme.dev"]);
    // Three off-policy links outrank the one on the derived host (two topic tokens vs one);
    // with a budget of 3 they would crowd it out if refused links consumed the budget.
    writeCache("acme", primary, [
      "# acme",
      "- [Request routing guide](https://github.com/acme/acme/blob/main/docs/routing.md)",
      "- [Request routing mirror](https://mirror.example.net/routing.md)",
      "- [Request routing api](https://api.acme.dev/routing.md)", // api.acme.dev is NOT derived (no *. wildcard)
      "- [Routing](https://docs.acme.dev/routing.md)",
    ].join("\n"));
    const spy = stubFetch({ "https://docs.acme.dev/routing.md": "# Routing\n\n## Request routing\n\nMatched from the derived docs host." });
    const out = await getDocsDetailed(resolvedEntry, { topic: "request routing" });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith("https://docs.acme.dev/routing.md", expect.anything());
    expect(out.followed).toEqual(["https://docs.acme.dev/routing.md"]);
    expect(out.dropped).toEqual({ outsideOrigin: 3, tooLarge: 0, unavailable: 0 });
    expect(out.text).toContain("Matched from the derived docs host");
    expect(out.text).toContain("Skipped 3 index links outside allowed hosts (raw.githubusercontent.com, acme.dev, docs.acme.dev)");
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

describe('getDocs mode: "snippets" (D-26)', () => {
  const STRIPE_URL = "https://docs.stripe.com/llms-full.txt";
  const stripe = { name: "stripe", urls: [STRIPE_URL] };
  const STRIPE_DOC = [
    "# Stripe",
    "## Checkout",
    "### Create a Checkout Session",
    "Create the session server-side, then redirect the customer:",
    "```js",
    "const session = await stripe.checkout.sessions.create({",
    "  line_items: [{ price: 'price_123', quantity: 1 }],",
    "  mode: 'payment',",
    "});",
    "```",
    "## Payment intents",
    "Confirm a payment intent:",
    "```js",
    "const intent = await stripe.paymentIntents.confirm('pi_123', {",
    "  payment_method: 'pm_123',",
    "});",
    "```",
  ].join("\n");

  it("returns the fenced code block with its heading path and context line, and the Source line", async () => {
    writeCache(stripe.name, STRIPE_URL, STRIPE_DOC);
    const spy = stubFetch({});
    const out = await getDocs(stripe, { topic: "checkout session create", mode: "snippets" });
    expect(spy).not.toHaveBeenCalled();
    expect(out).toContain(`Source: ${STRIPE_URL}`);
    expect(out).toContain("### Stripe > Checkout > Create a Checkout Session");
    expect(out).toContain("Create the session server-side, then redirect the customer:");
    expect(out).toContain("```js\nconst session = await stripe.checkout.sessions.create({");
    expect(out).not.toContain("## Checkout\n"); // sections-mode rendering is not used
  });

  it("the default mode is unchanged: sections-mode prose, not code blocks", async () => {
    writeCache(stripe.name, STRIPE_URL, STRIPE_DOC);
    stubFetch({});
    const sections = await getDocs(stripe, { topic: "checkout session create" });
    expect(sections).toContain("## Stripe > Checkout > Create a Checkout Session");
    expect(sections).toBe(await getDocs(stripe, { topic: "checkout session create", mode: "sections" }));
    expect(sections).not.toBe(await getDocs(stripe, { topic: "checkout session create", mode: "snippets" }));
  });

  it("counts matched snippets, not sections, and keeps source / isIndex reporting", async () => {
    writeCache(stripe.name, STRIPE_URL, STRIPE_DOC);
    stubFetch({});
    const out = await getDocsDetailed(stripe, { topic: "stripe create", mode: "snippets" });
    expect(out.matched).toBe(2); // two code blocks, not the four sections
    expect(out.source).toEqual({ url: STRIPE_URL, stale: false });
    expect(out.isIndex).toBe(false);
    expect(out.returnedFromFollowed).toBe(0);
  });

  it('says so when no code block matches, and points at mode "sections"', async () => {
    writeCache(stripe.name, STRIPE_URL, STRIPE_DOC);
    stubFetch({});
    const out = await getDocsDetailed(stripe, { topic: "quantum blockchain", mode: "snippets" });
    expect(out.text).toBe(
      `No code snippets matched "quantum blockchain" in stripe docs (source: ${STRIPE_URL}). ` +
        'Try mode "sections" or broader terms.',
    );
    expect(out.matched).toBe(0);
  });

  it("follows index links in snippets mode and reports the snippet that came from the followed page", async () => {
    seedIndex(["# Fastify", "- [Request](/docs/Request.md)", "- [Reply](/docs/Reply.md)"].join("\n"));
    stubFetch({
      "https://fastify.dev/docs/Request.md": [
        "# Request",
        "## request.hostname",
        "Read the hostname off the request:",
        "```js",
        "fastify.get('/', (request, reply) => {",
        "  reply.send(request.hostname);",
        "});",
        "```",
      ].join("\n"),
    });
    const out = await getDocsDetailed(entry, { topic: "request hostname", mode: "snippets" });
    expect(out.followed).toEqual(["https://fastify.dev/docs/Request.md"]);
    expect(out.text).toContain("Followed index links: https://fastify.dev/docs/Request.md");
    expect(out.text).toContain("reply.send(request.hostname);");
    expect(out.returnedFromFollowed).toBeGreaterThan(0);
  });

  it("carries the stale prefix into snippets mode", async () => {
    writeCache(stripe.name, STRIPE_URL, STRIPE_DOC);
    stubFetch({}); // revalidation fails, the stale copy is served
    const out = await getDocs({ ...stripe, ttlHours: 0 }, { topic: "checkout session create", mode: "snippets" });
    expect(out.split("\n")[0]).toMatch(/^> /); // the staleNote prefix
    expect(out).toContain("stripe.checkout.sessions.create(");
  });
});

describe("getDocsToolText (MCP get_docs tool body: alias resolution + unknown-library text, PAR-654)", () => {
  const REACT_URL = "https://react.dev/llms-full.txt";
  const registry: Registry = {
    entries: new Map([
      ["react", { name: "react", urls: [REACT_URL], aliases: ["reactjs"] }],
      ["hono", { name: "hono", urls: ["https://hono.dev/llms.txt"] }],
    ]),
  };

  it("an alias returns the canonical entry's docs (served from the seeded cache, no fetch)", async () => {
    writeCache("react", REACT_URL, "# React\n\n## useEffect cleanup\n\nReturn a function from useEffect to run cleanup.");
    const spy = stubFetch({});
    const out = await getDocsToolText(registry, { library: "reactjs", topic: "useEffect cleanup" });
    expect(spy).not.toHaveBeenCalled();
    expect(out).toContain(`Source: ${REACT_URL}`);
    expect(out).toContain("Return a function from useEffect");
    // Case-folded input takes the same path.
    expect(await getDocsToolText(registry, { library: "React" })).toContain(`Source: ${REACT_URL}`);
  });

  it("an unknown library is resolved implicitly (PAR-655): metadata → document → docs, and the entry joins the live registry", async () => {
    const spy = stubFetch({
      "https://registry.npmjs.org/elysia/latest": JSON.stringify({ homepage: "https://elysiajs.com", repository: "https://github.com/elysiajs/elysia" }),
      "https://raw.githubusercontent.com/elysiajs/elysia/HEAD/README.md": "# Elysia\n\n## Middleware\n\nUse .onBeforeHandle() for middleware.",
    });
    const reg: Registry = { entries: new Map(registry.entries) };
    const out = await getDocsToolText(reg, { library: "Elysia", topic: "middleware" });
    // R3: provenance first, then the normal response.
    expect(out.split("\n")[0]).toBe(
      '> Resolved "Elysia" via npm on this call — not a curated entry; verify this is the package you meant. homepage https://elysiajs.com/ · repository github.com/elysiajs/elysia',
    );
    expect(out).toContain("Source: https://raw.githubusercontent.com/elysiajs/elysia/HEAD/README.md");
    expect(out).toContain("onBeforeHandle");
    expect(reg.entries.get("elysia")?.resolved?.source).toBe("npm");
    expect(spy).toHaveBeenCalledTimes(1 + 3); // metadata, two llms probes, README.md at HEAD
    // Second call: served from the adopted entry and the cache — no new fetch, and no provenance line.
    spy.mockClear();
    const again = await getDocsToolText(reg, { library: "elysia", topic: "middleware" });
    expect(again).toContain("onBeforeHandle");
    expect(again).not.toContain("Resolved ");
    expect(spy).not.toHaveBeenCalled();
  });

  it("R3: the provenance line carries the package-supplied description and the nearest curated name for a likely typo", async () => {
    stubFetch({
      "https://registry.npmjs.org/reakt/latest": JSON.stringify({ description: "Something\u202E else entirely", homepage: "https://github.com/someone/reakt" }),
      "https://raw.githubusercontent.com/someone/reakt/HEAD/README.md": "# reakt\n\n## Hooks\n\nNot the React you meant.",
    });
    const reg: Registry = { entries: new Map(registry.entries) };
    const out = await getDocsToolText(reg, { library: "reakt", topic: "hooks" });
    expect(out.split("\n")[0]).toBe(
      '> Resolved "reakt" via npm on this call — not a curated entry; verify this is the package you meant. (package-supplied) description: Something else entirely · repository github.com/someone/reakt · nearest curated name: "react"',
    );
  });

  it("an unknown library nothing can resolve returns the could-not-resolve line (never the stack), after at most the metadata fetches", async () => {
    const spy = stubFetch({});
    const reg: Registry = { entries: new Map(registry.entries) };
    const out = await getDocsToolText(reg, { library: "nope", topic: "x" });
    expect(out).toBe(
      'Could not resolve "nope": npm: no metadata (404 or unreachable); PyPI: no metadata (404 or unreachable). ' +
        'Add it to vibectx.config.json like: { "name": "nope", "urls": ["https://..."] }',
    );
    expect(spy).toHaveBeenCalledTimes(2);
    expect(reg.entries.size).toBe(2);
  });

  it("an implausible name is refused without any fetch", async () => {
    const spy = stubFetch({});
    const out = await getDocsToolText(registry, { library: "https://evil.example/x" });
    expect(out).toMatch(/^Could not resolve "https:\/\/evil\.example\/x": .*not a valid npm or PyPI package name; nothing was fetched\./);
    expect(spy).not.toHaveBeenCalled();
  });

  it("L3: after resolving typing_extensions, get_docs(\"Typing-Extensions\") is served from the same record without a new resolution", async () => {
    const spy = stubFetch({
      "https://registry.npmjs.org/typing_extensions/latest": "",
      "https://pypi.org/pypi/typing-extensions/json": JSON.stringify({ info: { project_urls: { Documentation: "https://typing-extensions.readthedocs.io/" } } }),
      "https://typing-extensions.readthedocs.io/llms.txt": "# typing-extensions\n\n## TypedDict\n\nTotal is optional.",
    });
    const reg: Registry = { entries: new Map(registry.entries) };
    expect(await getDocsToolText(reg, { library: "typing_extensions", topic: "TypedDict" })).toContain("Total is optional");
    expect(reg.entries.has("typing-extensions")).toBe(true);
    spy.mockClear();
    expect(await getDocsToolText(reg, { library: "Typing-Extensions", topic: "TypedDict" })).toContain("Total is optional");
    expect(spy).not.toHaveBeenCalled();
  });

  it("a config pin typing_extensions answers get_docs(\"Typing.Extensions\") without any resolution", async () => {
    const PIN = "https://pinned.example.com/llms.txt";
    writeCache("typing_extensions", PIN, "# Pinned\n\n## TypedDict\n\nFrom the pin.");
    const spy = stubFetch({});
    const reg: Registry = { entries: new Map([["typing_extensions", { name: "typing_extensions", urls: [PIN] }]]) };
    const out = await getDocsToolText(reg, { library: "Typing.Extensions", topic: "TypedDict" });
    expect(out).toContain("From the pin");
    expect(out).not.toContain("Resolved ");
    expect(spy).not.toHaveBeenCalled();
    expect(reg.entries.size).toBe(1);
  });

  it("offline: an unknown library returns the Unknown-library text listing canonical names, without fetching", async () => {
    const spy = stubFetch({});
    expect(await getDocsToolText(registry, { library: "nope", topic: "x", offline: true })).toBe(
      'Unknown library "nope". Known: react, hono',
    );
    expect(spy).not.toHaveBeenCalled();
  });

  it("passes topic and maxTokens through to getDocs", async () => {
    writeCache("react", REACT_URL, "# React\n\n## useEffect cleanup\n\nReturn a function from useEffect to run cleanup.");
    stubFetch({});
    const out = await getDocsToolText(registry, { library: "react", topic: "zzz-unmatched", maxTokens: 10 });
    expect(out).toMatch(/No sections matched "zzz-unmatched" in react docs/);
  });
});
