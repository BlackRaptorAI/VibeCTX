import { describe, it, expect } from "vitest";
import {
  splitSections,
  rankSections,
  assemble,
  looksLikeIndex,
  rankLinks,
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
});

describe("rankLinks", () => {
  it("returns query-relevant links only, best first", () => {
    const index = [
      "- [Installation guide](https://example.com/install.md)",
      "- [Plugin system](https://example.com/plugins.md)",
      "- [Deployment](https://example.com/deploy.md)",
    ].join("\n");
    const links = rankLinks(index, "plugin", 5);
    expect(links).toHaveLength(1);
    expect(links[0].url).toBe("https://example.com/plugins.md");
  });
});
