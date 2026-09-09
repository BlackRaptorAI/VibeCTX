import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { writeCache } from "../src/cache.js";
import type { Registry } from "../src/registry.js";
import { autowarmStatus, resetAutowarm } from "../src/autowarm.js";
import { buildServer, startServer } from "../src/server.js";
import { loadDiscoveredRegistry } from "../src/registry.js";
import { MAX_TOKENS_BUDGET } from "../src/search.js";

/**
 * Q2 (PAR-656): the real McpServer over an in-memory transport — the tool list, a tool
 * call answered while the autowarm holds a fetch open, the `warming…` marker, and the
 * autowarm's start / opt-out / abort-on-close, all without a process or stdio.
 */

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "vibectx-server-"));
  process.env.VIBECTX_CACHE_DIR = dir;
  resetAutowarm();
});
afterEach(() => {
  delete process.env.VIBECTX_CACHE_DIR;
  rmSync(dir, { recursive: true, force: true });
  vi.unstubAllGlobals();
  // Q2 (PAR-657): the done-when case spies process.cwd(); restoring it here means a failure
  // inside that test cannot leave every later file running against a temp directory.
  vi.restoreAllMocks();
});

const REACT_URL = "https://react.dev/llms-full.txt";
const ZOD_URL = "https://zod.dev/llms.txt";
const registry = (): Registry => ({
  entries: new Map([
    ["react", { name: "react", urls: [REACT_URL], description: "React" }],
    ["zod", { name: "zod", urls: [ZOD_URL], description: "Zod" }],
  ]),
});

/** A fetch stub whose responses are released by the test. */
function heldFetch() {
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const spy = vi.fn(async () => {
    await gate;
    return new Response("# doc", { status: 200, headers: { "content-type": "text/plain" } });
  });
  vi.stubGlobal("fetch", spy);
  return { spy, release };
}

async function connect(reg: Registry, env: NodeJS.ProcessEnv = {}) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const notes: string[] = [];
  const started = await startServer(reg, serverTransport, { env, warn: (m) => notes.push(m) });
  const client = new Client({ name: "probe", version: "0" });
  await client.connect(clientTransport);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const res = (await client.callTool({ name, arguments: args })) as { content: { type: string; text: string }[] };
    return res.content[0].text;
  };
  return { client, started, notes, call };
}

describe("buildServer", () => {
  it("registers the seven tools", async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = buildServer(registry());
    await server.connect(serverTransport);
    const client = new Client({ name: "probe", version: "0" });
    await client.connect(clientTransport);
    const tools = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(tools).toEqual(["doctor", "get_docs", "list_libraries", "refresh", "resolve_library", "search", "warm_project"]);
    expect(autowarmStatus().started).toBe(false); // buildServer alone never warms
    await client.close();
  });

  it("S-B / D-12: warm_project's input schema is `dir` only — `force` is a CLI flag, not a model-callable one", async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = buildServer(registry());
    await server.connect(serverTransport);
    const client = new Client({ name: "probe", version: "0" });
    await client.connect(clientTransport);
    const warm = (await client.listTools()).tools.find((t) => t.name === "warm_project")!;
    expect(Object.keys(warm.inputSchema.properties ?? {})).toEqual(["dir"]);
    expect(JSON.stringify(warm)).not.toContain("force");
    await client.close();
  });
});

describe('get_docs mode over the transport (D-26)', () => {
  const STRIPE_URL = "https://docs.stripe.com/llms-full.txt";
  const STRIPE_DOC = [
    "# Stripe",
    "## Checkout",
    "### Create a Checkout Session",
    "Create the session server-side, then redirect:",
    "```js",
    "const session = await stripe.checkout.sessions.create({",
    "  mode: 'payment',",
    "});",
    "```",
  ].join("\n");
  const stripeRegistry = (): Registry => ({
    entries: new Map([["stripe", { name: "stripe", urls: [STRIPE_URL], description: "Stripe" }]]),
  });

  it('mode "snippets" returns fenced code with its heading path and context line', async () => {
    writeCache("stripe", STRIPE_URL, STRIPE_DOC);
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 404 })));
    const { client, call } = await connect(stripeRegistry(), { VIBECTX_NO_AUTOWARM: "1" });
    const out = await call("get_docs", { library: "stripe", topic: "checkout session create", mode: "snippets" });
    expect(out).toContain("### Stripe > Checkout > Create a Checkout Session");
    expect(out).toContain("Create the session server-side, then redirect:");
    expect(out).toContain("```js\nconst session = await stripe.checkout.sessions.create({");
    await client.close();
  });

  it("the default is sections mode, byte for byte", async () => {
    writeCache("stripe", STRIPE_URL, STRIPE_DOC);
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 404 })));
    const { client, call } = await connect(stripeRegistry(), { VIBECTX_NO_AUTOWARM: "1" });
    const args = { library: "stripe", topic: "checkout session create" };
    expect(await call("get_docs", args)).toBe(await call("get_docs", { ...args, mode: "sections" }));
    expect(await call("get_docs", args)).toContain("## Stripe > Checkout > Create a Checkout Session");
    await client.close();
  });

  it("an unknown mode is rejected by the schema, not silently treated as sections", async () => {
    writeCache("stripe", STRIPE_URL, STRIPE_DOC);
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 404 })));
    const { client, call } = await connect(stripeRegistry(), { VIBECTX_NO_AUTOWARM: "1" });
    // The SDK reports a schema violation as an error result, not a thrown transport error.
    const out = await call("get_docs", { library: "stripe", topic: "checkout", mode: "code" });
    expect(out).toContain("Input validation error");
    expect(out).toContain("mode");
    expect(out).not.toContain("Source:");
    await client.close();
  });

  it("A2 (PAR-715): the maxTokens matrix — Infinity, over-budget, negative, zero and fractional are schema errors; the default and the ceiling are accepted", async () => {
    // Pinned against a literal, not only against itself — see the identical note in cli.test.ts.
    expect(MAX_TOKENS_BUDGET).toBe(200_000);
    writeCache("stripe", STRIPE_URL, STRIPE_DOC);
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 404 })));
    const { client, call } = await connect(stripeRegistry(), { VIBECTX_NO_AUTOWARM: "1" });
    for (const maxTokens of [Infinity, 1_000_000_000, -5, 0, 3.7, MAX_TOKENS_BUDGET + 1]) {
      const out = await call("get_docs", { library: "stripe", topic: "checkout session create", maxTokens });
      expect(out, `maxTokens: ${maxTokens}`).toContain("Input validation error");
    }
    for (const maxTokens of [4000, MAX_TOKENS_BUDGET]) {
      const out = await call("get_docs", { library: "stripe", topic: "checkout session create", maxTokens });
      expect(out, `maxTokens: ${maxTokens}`).toContain("Source:");
      expect(out, `maxTokens: ${maxTokens}`).not.toContain("Input validation error");
    }
    await client.close();
  });

  it("get_docs advertises mode as an enum of exactly sections and snippets, and maxTokens as a bounded integer", async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = buildServer(stripeRegistry());
    await server.connect(serverTransport);
    const client = new Client({ name: "probe", version: "0" });
    await client.connect(clientTransport);
    const getDocs = (await client.listTools()).tools.find((t) => t.name === "get_docs")!;
    const props = getDocs.inputSchema.properties as Record<string, { enum?: string[]; type?: string; exclusiveMinimum?: number; maximum?: number }>;
    expect(Object.keys(props).sort()).toEqual(["library", "maxTokens", "mode", "topic"]);
    expect(props.mode.enum).toEqual(["sections", "snippets"]);
    // A2 (PAR-715): this is what a conforming client actually reads — if the cap ever moved
    // out of the schema (into a `.refine()` or a handler-side clamp), this is the assertion
    // that would catch it; the rejection tests above would not, since both still reject.
    expect(props.maxTokens).toMatchObject({ type: "integer", exclusiveMinimum: 0, maximum: MAX_TOKENS_BUDGET });
    await client.close();
  });
});

describe("startServer + autowarm over an in-memory transport", () => {
  it("autowarm starts only after connect; a tool call answers while its fetch is held open and shows warming…", async () => {
    writeCache("react", REACT_URL, "# React fresh");
    const { spy, release } = heldFetch();
    expect(autowarmStatus().started).toBe(false);
    const { client, started, notes, call } = await connect(registry());
    expect(autowarmStatus().started).toBe(true);
    expect(started.autowarm).toBeDefined();
    // The autowarm is holding zod's fetch; list_libraries must still answer, and mark it.
    const list = await Promise.race([call("list_libraries"), new Promise<string>((_, rej) => setTimeout(() => rej(new Error("list_libraries blocked")), 1000))]);
    expect(list).toMatch(/\*\*zod\*\* — Zod \[not cached, warming…\]/);
    expect(list).toMatch(/\*\*react\*\* — React \[cached [^\]]*\] \[full-text\]/);
    expect(spy).toHaveBeenCalledTimes(1);
    release();
    expect(await started.autowarm).toEqual({ attempted: 1, cached: 1, failed: [], aborted: 0 });
    expect(await call("list_libraries")).not.toContain("warming…");
    expect(notes.join("")).toBe("vibectx: autowarm cached 1/1 configured libraries\n");
    await client.close();
  });

  it("S-C: startServer sweeps orphan temp files out of the cache directories before anything else writes", async () => {
    writeCache("react", REACT_URL, "# React fresh");
    mkdirSync(join(dir, "projects"), { recursive: true });
    const orphans = [join(dir, "resolved.json.4242.1757000000000.tmp"), join(dir, "projects", "abc.json.4242.1757000000000.tmp"), join(dir, "react", "page.md.4242.1757000000000.tmp")];
    for (const o of orphans) writeFileSync(o, "half a file", "utf8");
    writeFileSync(join(dir, "keep.tmp"), "not ours", "utf8");
    heldFetch();
    const { client } = await connect(registry(), { VIBECTX_NO_AUTOWARM: "1" });
    for (const o of orphans) expect(existsSync(o), o).toBe(false);
    expect(existsSync(join(dir, "keep.tmp"))).toBe(true);
    await client.close();
  });

  it("VIBECTX_NO_AUTOWARM=1: connected, tools work, autowarm never starts, nothing fetched", async () => {
    const { spy } = heldFetch();
    const { client, started, call } = await connect(registry(), { VIBECTX_NO_AUTOWARM: "1" });
    expect(autowarmStatus().started).toBe(false);
    expect(started.autowarm).toBeUndefined();
    expect(await call("list_libraries")).toMatch(/\*\*zod\*\* — Zod \[not cached\]/);
    expect(spy).not.toHaveBeenCalled();
    await client.close();
  });

  it("R4: closing the transport aborts the autowarm — entries not yet started are never fetched", async () => {
    const reg: Registry = { entries: new Map() };
    for (let i = 0; i < 6; i++) reg.entries.set(`lib${i}`, { name: `lib${i}`, urls: [`https://lib${i}.example.com/llms.txt`] });
    const { spy, release } = heldFetch();
    const { client, started } = await connect(reg);
    await new Promise((r) => setTimeout(r, 5));
    expect(autowarmStatus().inFlight.size).toBe(2);
    await client.close(); // the linked pair closes the server side too
    await started.closed;
    release();
    const summary = await started.autowarm!;
    expect(summary).toEqual({ attempted: 6, cached: 2, failed: [], aborted: 4 });
    expect(spy).toHaveBeenCalledTimes(2);
  });
});

describe("done-when (PAR-657): a committed vibectx.config.json reaches a flagless server start", () => {
  const ACME_URL = "https://docs.acme-internal.example.com/llms-full.txt";

  it("list_libraries shows the extra library with the (project) header, and the autowarm fetches it", async () => {
    const repo = join(dir, "repo");
    const home = join(dir, "home");
    mkdirSync(join(repo, ".git"), { recursive: true }); // a real repo, not a bare directory
    mkdirSync(home, { recursive: true });
    writeFileSync(
      join(repo, "vibectx.config.json"),
      JSON.stringify({ libraries: [{ name: "acme-internal", urls: [ACME_URL], description: "Acme internal platform" }] }),
      "utf8",
    );
    const spy = vi.fn(async () => new Response("# Acme\n\nInternal platform docs.", { status: 200, headers: { "content-type": "text/plain" } }));
    vi.stubGlobal("fetch", spy);
    vi.spyOn(process, "cwd").mockReturnValue(repo);

    // Exactly what index.ts does on the server path: no --config, no VIBECTX_CONFIG.
    const registry = loadDiscoveredRegistry({ cwd: process.cwd(), env: {}, home });
    expect(registry.entries.size).toBe(31); // the shipped 30 + the committed one
    const { client, started, call } = await connect(registry);

    const text = await call("list_libraries");
    expect(text.split("\n")[0]).toBe("config: ./vibectx.config.json (project)");
    expect(text).toMatch(/- \*\*acme-internal\*\* — Acme internal platform/);

    await started.autowarm; // the autowarm's "configured libraries" include the discovered entry
    expect(spy.mock.calls.map((c) => String(c[0]))).toContain(ACME_URL);
    await client.close();
  });
});

/**
 * PAR-659 · D-35 — the `search` tool over the real transport. What matters over MCP and
 * nowhere else: the input schema is what a model sees, so an empty query and an over-long
 * library list must be SCHEMA errors the client is told about, not silently-wide searches.
 */
describe("search over the transport (PAR-659)", () => {
  const HONO_URL = "https://hono.dev/llms.txt";
  const AI_URL = "https://ai-sdk.dev/llms.txt";
  const searchRegistry = (): Registry => ({
    entries: new Map([
      ["hono", { name: "hono", urls: [HONO_URL], description: "Hono" }],
      ["ai-sdk", { name: "ai-sdk", aliases: ["ai"], urls: [AI_URL], description: "AI SDK" }],
    ]),
  });

  function seed(): void {
    writeCache("hono", HONO_URL, "# Hono\n\n## Streaming responses\n\nUse streamSSE to send server-sent events to the client.");
    writeCache("ai-sdk", AI_URL, "# AI SDK\n\n## streamText\n\nstreamText pipes a model response into a server-sent events stream.");
  }

  it("returns sections grouped by library, with Source lines and the searched/configured count", async () => {
    seed();
    const { call, client } = await connect(searchRegistry(), { VIBECTX_NO_AUTOWARM: "1" });
    const out = await call("search", { query: "server-sent events streaming" });
    expect(out).toContain("# hono");
    expect(out).toContain(`Source: ${HONO_URL}`);
    expect(out).toContain("# ai-sdk");
    expect(out).toContain("Searched 2 of 2 configured libraries");
    await client.close();
  });

  it("honours the libraries filter and maxTokens", async () => {
    seed();
    const { call, client } = await connect(searchRegistry(), { VIBECTX_NO_AUTOWARM: "1" });
    const out = await call("search", { query: "streaming", libraries: ["ai"], maxTokens: 500 });
    expect(out).toContain("# ai-sdk");
    expect(out).not.toContain("# hono");
    // N1: the count is reported against the registry too, so a filter cannot make the cache
    // look emptier than it is.
    expect(out).toContain("Searched 1 of 1 requested library (2 configured)");
    await client.close();
  });

  it("D-41: an empty query, an OVER-LONG query, a non-integer maxTokens and an over-long libraries list are schema errors", async () => {
    seed();
    const { client, call } = await connect(searchRegistry(), { VIBECTX_NO_AUTOWARM: "1" });
    // The SDK reports a schema violation as an error result, not a thrown transport error.
    for (const args of [
      { query: "" },
      // D-41: a 200,000-term query exhausted a 2 GB heap and took the whole server with it.
      // Over MCP that is a schema error the client is told about, never work this process does.
      { query: "streaming ".repeat(20_000) },
      { query: "x".repeat(1001) },
      { query: "streaming", maxTokens: 1.5 },
      { query: "streaming", maxTokens: 0 },
      { query: "streaming", maxTokens: -100 },
      { query: "streaming", libraries: Array.from({ length: 31 }, (_, i) => `l${i}`) },
    ]) {
      const out = await call("search", args);
      expect(out).toContain("Input validation error");
      expect(out).not.toContain("Source:");
    }
    await client.close();
  });

  it("A2 (PAR-715): the maxTokens matrix — Infinity, over-budget, negative, zero and fractional are schema errors; the default and the ceiling are accepted", async () => {
    expect(MAX_TOKENS_BUDGET).toBe(200_000);
    seed();
    const { client, call } = await connect(searchRegistry(), { VIBECTX_NO_AUTOWARM: "1" });
    for (const maxTokens of [Infinity, 1_000_000_000, -5, 0, 3.7, MAX_TOKENS_BUDGET + 1]) {
      const out = await call("search", { query: "streaming", maxTokens });
      expect(out, `maxTokens: ${maxTokens}`).toContain("Input validation error");
    }
    for (const maxTokens of [4000, MAX_TOKENS_BUDGET]) {
      const out = await call("search", { query: "streaming", maxTokens });
      expect(out, `maxTokens: ${maxTokens}`).toContain("Source:");
      expect(out, `maxTokens: ${maxTokens}`).not.toContain("Input validation error");
    }
    await client.close();
  });

  it("its description tells an agent when to reach for it instead of get_docs", async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = buildServer(searchRegistry());
    await server.connect(serverTransport);
    const client = new Client({ name: "probe", version: "0" });
    await client.connect(clientTransport);
    const tool = (await client.listTools()).tools.find((t) => t.name === "search")!;
    const props = tool.inputSchema.properties as Record<string, { type?: string; exclusiveMinimum?: number; maximum?: number }>;
    expect(Object.keys(props).sort()).toEqual(["libraries", "maxTokens", "query"]);
    expect(tool.description).toContain("get_docs");
    expect(tool.description).toMatch(/cache-only|offline/i);
    // A2 (PAR-715): same reasoning as the matching get_docs assertion above — the advertised
    // shape is what a conforming client reads, and nothing else in this file pins it.
    expect(props.maxTokens).toMatchObject({ type: "integer", exclusiveMinimum: 0, maximum: MAX_TOKENS_BUDGET });
    await client.close();
  });
});
