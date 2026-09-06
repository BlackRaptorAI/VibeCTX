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

/**
 * Q2 (PAR-656): the real McpServer over an in-memory transport — the tool list, a tool
 * call answered while the autowarm holds a fetch open, the `warming…` marker, and the
 * autowarm's start / opt-out / abort-on-close, all without a process or stdio.
 */

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "vibectx-server-"));
  process.env.DOCS_CACHE_DIR = dir;
  resetAutowarm();
});
afterEach(() => {
  delete process.env.DOCS_CACHE_DIR;
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
  it("registers the six tools", async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = buildServer(registry());
    await server.connect(serverTransport);
    const client = new Client({ name: "probe", version: "0" });
    await client.connect(clientTransport);
    const tools = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(tools).toEqual(["doctor", "get_docs", "list_libraries", "refresh", "resolve_library", "warm_project"]);
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
