import { describe, it, expect } from "vitest";
import {
  splitSections,
  rankSections,
  assemble,
  selectSections,
  looksLikeIndex,
  rankLinks,
  extractLinks,
  followLimit,
} from "../src/retrieval.js";

const DOC = `Intro paragraph before any heading.

# Getting Started

Install the package and run it.

## Configuration

Set the cache directory with DOCS_CACHE_DIR. TTL defaults to seven days.

## Plugins

Fastify plugins are registered with the register method. Encapsulation matters.

# Advanced

## Streaming replies

Use reply.raw for streaming. Backpressure is your problem.
`;

describe("splitSections", () => {
  it("splits on headings and keeps intro", () => {
    const sections = splitSections(DOC);
    expect(sections[0].heading).toBe("(intro)");
    expect(sections.map((s) => s.heading)).toContain("Configuration");
    expect(sections.map((s) => s.heading)).toContain("Streaming replies");
  });
});

describe("rankSections", () => {
  it("ranks the matching section first, boosted by heading hits", () => {
    const ranked = rankSections(DOC, "configuration cache TTL");
    expect(ranked[0].heading).toBe("Configuration");
  });

  it("returns empty for a query with no hits", () => {
    expect(rankSections(DOC, "quantum blockchain")).toHaveLength(0);
  });
});

describe("assemble", () => {
  it("respects the token budget but always returns at least one section", () => {
    const ranked = rankSections(DOC, "configuration cache");
    const out = assemble(ranked, 10); // tiny budget
    expect(out.length).toBeGreaterThan(0);
    expect(out).toContain("Configuration");
  });

  it("selectSections returns exactly the sections assemble renders, in order", () => {
    const ranked = rankSections(DOC, "configuration cache plugins streaming");
    expect(ranked.length).toBeGreaterThan(2);
    const chosen = selectSections(ranked, 30); // room for roughly two small sections
    expect(chosen.length).toBeGreaterThanOrEqual(1);
    expect(chosen.length).toBeLessThan(ranked.length);
    expect(chosen).toEqual(ranked.slice(0, chosen.length));
    const rendered = assemble(ranked, 30);
    for (const s of chosen) expect(rendered).toContain(`## ${s.heading}`);
    for (const s of ranked.slice(chosen.length)) expect(rendered).not.toContain(`## ${s.heading}`);
  });
});

describe("looksLikeIndex", () => {
  it("detects link-dense llms.txt index files", () => {
    const index = [
      "# Docs",
      "- [Install](https://example.com/install.md)",
      "- [Config](https://example.com/config.md)",
      "- [Plugins](https://example.com/plugins.md)",
    ].join("\n");
    expect(looksLikeIndex(index)).toBe(true);
    expect(looksLikeIndex(DOC)).toBe(false);
  });

  it("detects an index larger than 100 KB (PAR-706: fastify llms.txt is 106,561 chars)", () => {
    // Fastify-shaped: title, summary, section headings, then relative-link lines.
    const lines = ["# Fastify", "", "> Fast and low overhead web framework.", "", "## Reference"];
    for (let i = 0; i < 2500; i++) {
      lines.push(`- [Reference page ${i}](/docs/latest/Reference/Page-${i}.md): description of page ${i}`);
    }
    const index = lines.join("\n");
    expect(index.length).toBeGreaterThan(106_561);
    expect(looksLikeIndex(index)).toBe(true);
  });

  it("counts relative links toward link density", () => {
    const index = [
      "# Docs",
      "- [Request](/docs/Reference/Request.md)",
      "- [Reply](./Reply.md)",
      "- [Hooks](Hooks.md)",
    ].join("\n");
    expect(looksLikeIndex(index)).toBe(true);
  });

  it("returns false for a short prose doc with a couple of links", () => {
    const prose = [
      "# Getting started",
      "This guide walks through installation, configuration and your first server.",
      "Start by installing the package from npm and creating an entry file.",
      "See the [install guide](https://example.com/install.md) for platform notes.",
      "Configuration lives in a JSON file next to your entry point.",
      "Plugins are registered with the register method and are encapsulated.",
      "Read more in the [plugin guide](https://example.com/plugins.md).",
      "Streaming replies use reply.raw and leave backpressure to you.",
    ].join("\n");
    expect(looksLikeIndex(prose)).toBe(false);
  });

  it("samples only the first 200 non-empty lines: a long prose preamble hides later links", () => {
    const lines: string[] = [];
    for (let i = 0; i < 250; i++) lines.push(`Prose line ${i} explaining something at length.`);
    for (let i = 0; i < 1000; i++) lines.push(`- [Page ${i}](/docs/p${i}.md)`);
    expect(looksLikeIndex(lines.join("\n"))).toBe(false);
  });

  it("samples only the first 200 non-empty lines: a link-dense head classifies despite a long prose tail", () => {
    const lines: string[] = [];
    for (let i = 0; i < 200; i++) lines.push(`- [Page ${i}](/docs/p${i}.md)`);
    for (let i = 0; i < 1000; i++) lines.push(`Prose line ${i} explaining something at length.`);
    expect(looksLikeIndex(lines.join("\n"))).toBe(true);
  });

  it("ignores blank lines when sampling", () => {
    // 150 links interleaved with 300 blank lines: the 200-line window must still see mostly links.
    const lines: string[] = ["# Docs"];
    for (let i = 0; i < 150; i++) lines.push("", "", `- [Page ${i}](/docs/p${i}.md)`);
    for (let i = 0; i < 300; i++) lines.push(`Prose ${i}`);
    expect(looksLikeIndex(lines.join("\n"))).toBe(true);
  });

  it("does not treat a README with an anchor-only table of contents as an index", () => {
    const readme = [
      "# pgvector",
      "- [Installation](#installation)",
      "- [Getting Started](#getting-started)",
      "- [Indexing](#indexing)",
      "## Installation",
      "Compile and install the extension.",
    ].join("\n");
    expect(looksLikeIndex(readme)).toBe(false);
  });
});

describe("extractLinks", () => {
  const source = "https://fastify.dev/docs/llms.txt";

  it("resolves root-relative, dot-relative and bare-relative hrefs against the source URL", () => {
    const index = [
      "- [Request](/docs/Reference/Request.md)",
      "- [Reply](./Reply.md)",
      "- [Hooks](Hooks.md)",
      "- [Absolute](https://fastify.dev/docs/Abs.md)",
    ].join("\n");
    expect(extractLinks(index, source).map((l) => l.url)).toEqual([
      "https://fastify.dev/docs/Reference/Request.md",
      "https://fastify.dev/docs/Reply.md",
      "https://fastify.dev/docs/Hooks.md",
      "https://fastify.dev/docs/Abs.md",
    ]);
  });

  it("resolves protocol-relative hrefs to https on the source scheme", () => {
    const links = extractLinks("- [Mirror](//github.com/fastify/fastify/Request.md)", source);
    expect(links.map((l) => l.url)).toEqual(["https://github.com/fastify/fastify/Request.md"]);
  });

  it("does not backtrack quadratically on pathological bracket input (security)", () => {
    const hostile = "[".repeat(200_000);
    const t0 = performance.now();
    const links = extractLinks(hostile, source);
    const isIndex = looksLikeIndex(hostile);
    const elapsed = performance.now() - t0;
    expect(links).toEqual([]);
    expect(isIndex).toBe(false);
    expect(elapsed).toBeLessThan(100);
  });

  it("does not backtrack quadratically on an unterminated-href run '[a](' (security)", () => {
    // 200 KB on a single line: one line is enough to reach looksLikeIndex's sample window.
    const hostile = "[a](".repeat(50_000);
    expect(hostile.length).toBe(200_000);

    let t0 = performance.now();
    const links = extractLinks(hostile, source);
    const extractMs = performance.now() - t0;

    t0 = performance.now();
    const isIndex = looksLikeIndex(hostile);
    const indexMs = performance.now() - t0;

    expect(links).toEqual([]);
    expect(isIndex).toBe(false);
    expect(extractMs).toBeLessThan(100);
    expect(indexMs).toBeLessThan(100);
  });

  it("skips hrefs containing parens or brackets and keeps the neighbours", () => {
    // Such hrefs were already truncated at the first ')' before; now they are skipped whole.
    const links = extractLinks("[Req](/docs/Request.md) [Odd](/docs/a(b).md) [Br](/docs/x[1].md) [Reply](/docs/Reply.md)", source);
    expect(links.map((l) => l.url)).toEqual([
      "https://fastify.dev/docs/Request.md",
      "https://fastify.dev/docs/Reply.md",
    ]);
  });

  it("recovers the right title after a stray unmatched '[' earlier on the line", () => {
    const links = extractLinks("[ oops [Request](/docs/Request.md)", source);
    expect(links).toEqual([{ title: "Request", url: "https://fastify.dev/docs/Request.md" }]);
  });

  it("skips images, anchor-only links, non-http schemes, and duplicate targets", () => {
    const index = [
      "![logo](/img/logo.png)",
      "- [Top](#top)",
      "- [Mail](mailto:team@example.com)",
      "- [Request](/docs/Request.md)",
      "- [Request again](/docs/Request.md)",
    ].join("\n");
    const links = extractLinks(index, source);
    expect(links).toHaveLength(1);
    expect(links[0]).toEqual({ title: "Request", url: "https://fastify.dev/docs/Request.md" });
  });
});

describe("rankLinks", () => {
  it("returns query-relevant links only, best first", () => {
    const index = [
      "- [Installation guide](https://example.com/install.md)",
      "- [Plugin system](https://example.com/plugins.md)",
      "- [Deployment](https://example.com/deploy.md)",
    ].join("\n");
    const links = rankLinks(index, "plugin", "https://example.com/llms.txt", 5);
    expect(links).toHaveLength(1);
    expect(links[0].url).toBe("https://example.com/plugins.md");
  });

  it("ranks a mixed absolute/relative index by match count, ties in document order", () => {
    const index = [
      "- [Deployment](https://fastify.dev/docs/Deploy.md)",
      "- [Request object](/docs/Reference/Request.md)",
      "- [Request hooks lifecycle](./Hooks.md)",
      "- [Reply](https://fastify.dev/docs/Reply.md)",
      "- [Request validation](Validation.md)",
    ].join("\n");
    const links = rankLinks(index, "request hooks", "https://fastify.dev/docs/llms.txt", 10);
    expect(links.map((l) => l.url)).toEqual([
      "https://fastify.dev/docs/Hooks.md", // 2 hits
      "https://fastify.dev/docs/Reference/Request.md", // 1 hit, earlier
      "https://fastify.dev/docs/Validation.md", // 1 hit, later
    ]);
  });

  it("is deterministic across repeated calls", () => {
    const index = Array.from({ length: 50 }, (_, i) => `- [Request page ${i}](/docs/R${i}.md)`).join("\n");
    const a = rankLinks(index, "request", "https://fastify.dev/llms.txt", 5);
    const b = rankLinks(index, "request", "https://fastify.dev/llms.txt", 5);
    expect(a).toEqual(b);
    expect(a.map((l) => l.url)).toEqual([0, 1, 2, 3, 4].map((i) => `https://fastify.dev/docs/R${i}.md`));
  });
});

describe("followLimit", () => {
  it("follows 3 links for small indexes and 5 for indexes with more than 200 links", () => {
    expect(followLimit(0)).toBe(3);
    expect(followLimit(200)).toBe(3);
    expect(followLimit(201)).toBe(5);
    expect(followLimit(2500)).toBe(5);
  });
});
