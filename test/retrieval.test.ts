import { describe, it, expect } from "vitest";
import {
  splitSections,
  rankSections,
  assemble,
  selectSections,
  headingPath,
  renderSection,
  extractSnippets,
  rankSnippets,
  assembleSnippets,
  selectSnippets,
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
    // D-25 changed the rendered heading LINE from `## <heading>` to
    // `## <ancestors joined with " > "> > <heading>`; the selection contract is unchanged.
    for (const s of chosen) expect(rendered).toContain(`## ${headingPath(s)}`);
    for (const s of ranked.slice(chosen.length)) expect(rendered).not.toContain(`## ${headingPath(s)}`);
  });
});

describe("splitSections — heading path and levels (D-25)", () => {
  const NESTED = [
    "# Auth",
    "Top-level prose.",
    "## Row Level Security",
    "RLS prose.",
    "### Policies",
    "Write a policy with CREATE POLICY.",
    "#### Insert policies",
    "WITH CHECK applies to inserts.",
    "## Storage",
    "Buckets and objects.",
  ].join("\n");

  it("gives every section its level and its ancestor path, nearest last", () => {
    const byHeading = new Map(splitSections(NESTED).map((s) => [s.heading, s]));
    expect(byHeading.get("Auth")).toMatchObject({ level: 1, path: [] });
    expect(byHeading.get("Row Level Security")).toMatchObject({ level: 2, path: ["Auth"] });
    expect(byHeading.get("Policies")).toMatchObject({ level: 3, path: ["Auth", "Row Level Security"] });
    expect(byHeading.get("Insert policies")).toMatchObject({
      level: 4,
      path: ["Auth", "Row Level Security", "Policies"],
    });
  });

  it("resets the deeper path when a shallower heading appears", () => {
    const storage = splitSections(NESTED).find((s) => s.heading === "Storage")!;
    expect(storage).toMatchObject({ level: 2, path: ["Auth"] });
  });

  it("keeps a hole when a level is skipped (H1 then H3)", () => {
    const sections = splitSections("# One\ntext\n### Three\nmore text");
    expect(sections.find((s) => s.heading === "Three")).toMatchObject({ level: 3, path: ["One"] });
  });

  it("gives the synthetic intro section level 0 and an empty path", () => {
    expect(splitSections(DOC)[0]).toMatchObject({ heading: "(intro)", level: 0, path: [] });
  });

  it("renders the path in the section heading line, and leaves top-level and intro alone", () => {
    const byHeading = new Map(splitSections(NESTED).map((s) => [s.heading, s]));
    expect(renderSection(byHeading.get("Insert policies")!)).toContain(
      "## Auth > Row Level Security > Policies > Insert policies",
    );
    expect(renderSection(byHeading.get("Auth")!)).toContain("## Auth\n");
    expect(renderSection(splitSections(DOC)[0])).toContain("## (intro)\n");
  });
});

describe("splitSections — code fences (D-25)", () => {
  it("does not treat a '#' line inside a fenced block as a heading", () => {
    const doc = [
      "# Install",
      "Run the installer:",
      "```bash",
      "# this is a shell comment, not a heading",
      "npm install vibectx",
      "```",
      "Done.",
    ].join("\n");
    const sections = splitSections(doc);
    expect(sections.map((s) => s.heading)).toEqual(["Install"]);
    expect(sections[0].body).toContain("# this is a shell comment");
    expect(sections[0].body).toContain("Done.");
  });

  it("handles tilde fences and a longer closing run", () => {
    const doc = ["# T", "~~~md", "## not a heading", "~~~~", "after"].join("\n");
    expect(splitSections(doc).map((s) => s.heading)).toEqual(["T"]);
  });

  it("still sees headings after the fence closes", () => {
    const doc = ["# A", "```", "# hidden", "```", "## B", "text"].join("\n");
    expect(splitSections(doc).map((s) => s.heading)).toEqual(["A", "B"]);
  });

  it("does not open a fence on an indented code block or an inline code span", () => {
    const doc = ["# A", "    ```", "text `a` more", "## B", "body"].join("\n");
    expect(splitSections(doc).map((s) => s.heading)).toEqual(["A", "B"]);
  });
});

describe("rankSections — BM25 (D-24)", () => {
  it("prefers the section holding the rare term over a long section full of a common one", () => {
    const doc = [
      "# Common ground",
      "query ".repeat(400),
      "# Upsert",
      "The upsert helper writes or updates one row. query",
    ].join("\n");
    const ranked = rankSections(doc, "query upsert");
    expect(ranked[0].heading).toBe("Upsert");
  });

  it("boosts a term in the section's own heading over the same term in a body", () => {
    const doc = ["# Webhooks", "Nothing else here.", "# Other", "webhooks webhooks webhooks"].join("\n");
    const ranked = rankSections(doc, "webhooks");
    expect(ranked[0].heading).toBe("Webhooks");
  });

  it("counts ancestor-path headings, so a child section inherits its parent's topic", () => {
    const doc = [
      "# Authentication",
      "## Providers",
      "Configure the provider list here.",
      "# Deployment",
      "## Providers",
      "Configure the provider list here.",
    ].join("\n");
    const ranked = rankSections(doc, "authentication providers");
    expect(ranked[0].path).toEqual(["Authentication"]);
  });

  it("breaks ties in document order", () => {
    const doc = ["# One", "hooks matter", "# Two", "hooks matter"].join("\n");
    const ranked = rankSections(doc, "hooks matter");
    expect(ranked[0].score).toBeCloseTo(ranked[1].score, 10);
    expect(ranked.map((s) => s.heading)).toEqual(["One", "Two"]);
  });

  it("is deterministic across repeated calls", () => {
    const a = rankSections(DOC, "configuration cache ttl");
    const b = rankSections(DOC, "configuration cache ttl");
    expect(a).toEqual(b);
  });

  it("matches a camelCase identifier from a spelled-out query, and the reverse", () => {
    const doc = [
      "# Hooks",
      "Return a cleanup function from useEffect when the component unmounts.",
      "# Styling",
      "Use CSS modules.",
    ].join("\n");
    expect(rankSections(doc, "use effect cleanup")[0].heading).toBe("Hooks");
    const spelled = ["# Hooks", "Return a cleanup function from use effect.", "# Styling", "Use CSS modules."].join("\n");
    expect(rankSections(spelled, "useEffect")[0].heading).toBe("Hooks");
  });

  it("matches across the stemmer: 'policies' finds 'policy' and back again", () => {
    const doc = ["# Policy", "One policy per table.", "# Buckets", "Storage buckets."].join("\n");
    expect(rankSections(doc, "policies")[0].heading).toBe("Policy");
    const plural = ["# Policies", "Several policies per table.", "# Buckets", "Storage buckets."].join("\n");
    expect(rankSections(plural, "policy")[0].heading).toBe("Policies");
  });

  it("still returns nothing for a query with no hits", () => {
    expect(rankSections(DOC, "quantum blockchain")).toHaveLength(0);
  });
});

describe("rankSections — performance bound (D-24)", () => {
  /** ~5 MB of markdown in ~5,000 sections. */
  function bigCorpus(sectionCount: number): string {
    const lines: string[] = [];
    for (let i = 0; i < sectionCount; i++) {
      lines.push(`## Section ${i}`);
      lines.push(`The ${i} handler registers a route and validates the request body with a schema. `.repeat(12));
      lines.push(`Configure the cache directory, the retry policy and the streaming reply for entry ${i}.`.repeat(2));
    }
    return lines.join("\n");
  }

  it("ranks a 5 MB corpus with a 4-term query well inside the budget, and stays linear in size", () => {
    const big = bigCorpus(5000);
    expect(big.length).toBeGreaterThan(5_000_000);
    const query = "streaming reply cache policy";

    const t0 = performance.now();
    const ranked = rankSections(big, query);
    const bigMs = performance.now() - t0;
    expect(ranked.length).toBeGreaterThan(0);
    expect(bigMs).toBeLessThan(5000); // D-24 target is 1.5 s; the CI budget is generous

    const small = bigCorpus(1000); // ~1 MB
    const large = bigCorpus(4000); // ~4 MB
    let t = performance.now();
    rankSections(small, query);
    const smallMs = Math.max(performance.now() - t, 1);
    t = performance.now();
    rankSections(large, query);
    const largeMs = performance.now() - t;
    expect(largeMs / smallMs).toBeLessThan(6); // 4x the input, well under 6x the time
  });
});

describe("extractSnippets (D-26)", () => {
  const DOC_WITH_CODE = [
    "# Stripe",
    "## Checkout",
    "### Create a session",
    "Create a Checkout Session and redirect the customer:",
    "```js",
    "const session = await stripe.checkout.sessions.create({",
    "  mode: 'payment',",
    "});",
    "```",
    "## Webhooks",
    "```",
    "stripe listen --forward-to localhost:3000",
    "```",
  ].join("\n");

  it("captures the language, the code, the heading path and one line of context", () => {
    const [first] = extractSnippets(DOC_WITH_CODE);
    expect(first.lang).toBe("js");
    expect(first.code).toContain("stripe.checkout.sessions.create(");
    expect(first.code).not.toContain("```");
    expect(first.heading).toBe("Create a session");
    expect(first.path).toEqual(["Stripe", "Checkout"]);
    expect(first.context).toBe("Create a Checkout Session and redirect the customer:");
  });

  it("falls back to the section heading when the fence opens the section", () => {
    const webhook = extractSnippets(DOC_WITH_CODE)[1];
    expect(webhook.lang).toBe("");
    expect(webhook.context).toBe("Webhooks");
  });

  it("finds every block in document order and never re-reads a block's contents as prose", () => {
    const doc = ["# A", "first prose", "```js", "one()", "```", "```js", "two()", "```"].join("\n");
    const snips = extractSnippets(doc);
    expect(snips.map((s) => s.code)).toEqual(["one()", "two()"]);
    expect(snips[1].context).toBe("A"); // the previous block's lines are not prose
  });

  it("runs an unclosed fence to the end of its section", () => {
    const snips = extractSnippets(["# A", "text", "```py", "print(1)"].join("\n"));
    expect(snips).toHaveLength(1);
    expect(snips[0].code).toBe("print(1)");
  });

  it("returns nothing for a document with no code blocks", () => {
    expect(extractSnippets(DOC)).toEqual([]);
  });
});

describe("rankSnippets + assembleSnippets (D-26)", () => {
  const STRIPE_LIKE = [
    "# Stripe Node",
    "## Checkout",
    "### Create a Checkout Session",
    "Create the session server-side, then redirect:",
    "```js",
    "const session = await stripe.checkout.sessions.create({",
    "  line_items: [{ price: 'price_123', quantity: 1 }],",
    "  mode: 'payment',",
    "  success_url: 'https://example.com/ok',",
    "});",
    "```",
    "## Refunds",
    "Refund a payment intent:",
    "```js",
    "const refund = await stripe.refunds.create({",
    "  payment_intent: 'pi_123',",
    "});",
    "```",
  ].join("\n");

  const PRISMA_LIKE = [
    "# Prisma Client",
    "## Writing data",
    "### upsert",
    "Update a row when it exists, create it otherwise:",
    "```ts",
    "const user = await prisma.user.upsert({",
    "  where: { email: 'a@b.c' },",
    "  update: { name: 'A' },",
    "  create: { email: 'a@b.c', name: 'A' },",
    "});",
    "```",
    "## Reading data",
    "Find many rows:",
    "```ts",
    "const users = await prisma.user.findMany({ where: { active: true } });",
    "```",
  ].join("\n");

  it("returns the Stripe checkout-session call for 'stripe checkout session create'", () => {
    const ranked = rankSnippets(STRIPE_LIKE, "stripe checkout session create");
    expect(ranked.length).toBeGreaterThan(0);
    expect(ranked[0].code).toContain("stripe.checkout.sessions.create(");
    expect(ranked[0].lang).toBe("js");
    expect(ranked[0].path).toEqual(["Stripe Node", "Checkout"]);
  });

  it("returns the Prisma upsert call for 'prisma upsert'", () => {
    const ranked = rankSnippets(PRISMA_LIKE, "prisma upsert");
    expect(ranked[0].code).toContain("prisma.user.upsert(");
  });

  it("renders heading path, context line and a fenced block with its language", () => {
    const out = assembleSnippets(rankSnippets(STRIPE_LIKE, "stripe checkout session create"), 4000);
    expect(out).toContain("### Stripe Node > Checkout > Create a Checkout Session");
    expect(out).toContain("Create the session server-side, then redirect:");
    expect(out).toContain("```js\nconst session = await stripe.checkout.sessions.create({");
    expect(out.trimEnd().endsWith("```")).toBe(true);
  });

  it("returns nothing when no code block matches the query", () => {
    expect(rankSnippets(STRIPE_LIKE, "quantum blockchain")).toEqual([]);
    expect(rankSnippets(DOC, "configuration")).toEqual([]); // a doc with no code at all
  });

  it("skips a block under two non-empty lines unless the query hits it exactly", () => {
    const doc = [
      "# Install",
      "Install it:",
      "```bash",
      "npm i vibectx",
      "```",
      "## Usage",
      "Then call it:",
      "```js",
      "vibectx.start();",
      "vibectx.stop();",
      "```",
    ].join("\n");
    // "install" matches the one-line block's section but not the block's own tokens.
    expect(rankSnippets(doc, "install").map((s) => s.code)).not.toContain("npm i vibectx");
    // Naming every token in the block keeps it.
    expect(rankSnippets(doc, "npm vibectx")[0].code).toBe("npm i vibectx");
  });

  it("breaks ties in document order and is deterministic", () => {
    const doc = ["# A", "call it", "```js", "run()", "more()", "```", "# B", "call it", "```js", "run()", "more()", "```"].join("\n");
    const ranked = rankSnippets(doc, "run more");
    expect(ranked).toHaveLength(2);
    expect(ranked[0].heading).toBe("A");
    expect(rankSnippets(doc, "run more")).toEqual(ranked);
  });

  it("always returns at least one snippet under a tiny budget, closing the fence it cut", () => {
    const ranked = rankSnippets(STRIPE_LIKE, "stripe checkout session create");
    expect(selectSnippets(ranked, 5)).toHaveLength(1);
    const out = assembleSnippets(ranked, 5);
    expect(out.length).toBeGreaterThan(0);
    expect(out.trimEnd().endsWith("```")).toBe(true);
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
