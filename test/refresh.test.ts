import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readCache, writeCache } from "../src/cache.js";
import type { Registry } from "../src/registry.js";
import { refreshToolText } from "../src/refresh.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "vibectx-refresh-"));
  process.env.DOCS_CACHE_DIR = dir;
});

afterEach(() => {
  delete process.env.DOCS_CACHE_DIR;
  rmSync(dir, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

function stubFetch(pages: Record<string, string>) {
  const spy = vi.fn(async (url: unknown) => {
    const body = pages[String(url)];
    if (body === undefined) return new Response("not found", { status: 404 });
    return new Response(body, { status: 200, headers: { "content-type": "text/plain" } });
  });
  vi.stubGlobal("fetch", spy);
  return spy;
}

const REACT_URL = "https://react.dev/llms-full.txt";
const HONO_URL = "https://hono.dev/llms.txt";
const registry: Registry = {
  entries: new Map([
    ["react", { name: "react", urls: [REACT_URL], aliases: ["reactjs"] }],
    ["hono", { name: "hono", urls: [HONO_URL] }],
  ]),
};

describe("refreshToolText (MCP refresh tool body, PAR-654)", () => {
  it("refreshes the canonical entry when given an alias, bypassing a fresh cache", async () => {
    writeCache("react", REACT_URL, "# React old");
    const spy = stubFetch({ [REACT_URL]: "# React new" });
    const out = await refreshToolText(registry, "reactjs");
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(REACT_URL, expect.anything());
    expect(out).toBe(`react: refreshed from ${REACT_URL} (11 chars)`);
    expect(readCache("react", REACT_URL, 168)?.content).toBe("# React new");
  });

  it("refreshes every library when no name is given, one line each, and reports failures", async () => {
    stubFetch({ [REACT_URL]: "# React new" }); // hono 404s
    const out = await refreshToolText(registry);
    expect(out.split("\n")).toEqual([
      `react: refreshed from ${REACT_URL} (11 chars)`,
      "hono: FAILED — all candidate URLs unreachable",
    ]);
  });

  it("an unknown library returns the Unknown-library text listing canonical names, without fetching", async () => {
    const spy = stubFetch({});
    expect(await refreshToolText(registry, "nope")).toBe('Unknown library "nope". Known: react, hono');
    expect(spy).not.toHaveBeenCalled();
  });
});
