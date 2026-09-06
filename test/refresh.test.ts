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

  it("an unknown library returns the Unknown-library text listing canonical names, without fetching (refresh never resolves)", async () => {
    const spy = stubFetch({});
    expect(await refreshToolText(registry, "nope")).toBe('Unknown library "nope". Known: react, hono');
    expect(spy).not.toHaveBeenCalled();
  });

  it("re-resolves a resolved entry through its ecosystem instead of only refetching its urls (PAR-655)", async () => {
    const resolvedHono = {
      name: "hono",
      urls: ["https://hono.dev/llms.txt", "https://raw.githubusercontent.com/honojs/hono/main/README.md"],
      resolved: { source: "npm" as const, resolvedAt: "2026-09-06T00:00:00.000Z", metadataUrl: "https://registry.npmjs.org/hono/latest", homepage: "https://hono.dev/" },
    };
    const reg: Registry = { entries: new Map([["hono", resolvedHono]]) };
    const spy = stubFetch({
      "https://registry.npmjs.org/hono/latest": JSON.stringify({ homepage: "https://hono.dev", repository: "https://github.com/honojs/hono" }),
      "https://hono.dev/llms-full.txt": "# Hono full",
    });
    const out = await refreshToolText(reg, "hono");
    expect(spy.mock.calls[0][0]).toBe("https://registry.npmjs.org/hono/latest");
    expect(out).toBe("hono: re-resolved via npm — refreshed from https://hono.dev/llms-full.txt (11 chars)");
    // The live registry now carries the new candidate list (llms-full.txt was learned).
    expect(reg.entries.get("hono")?.urls[0]).toBe("https://hono.dev/llms-full.txt");
    expect(readCache("hono", "https://hono.dev/llms-full.txt", 168)?.content).toBe("# Hono full");
  });

  it("reports a resolved entry whose re-resolution fails, keeping the old entry", async () => {
    const resolvedHono = {
      name: "hono",
      urls: ["https://hono.dev/llms.txt"],
      resolved: { source: "npm" as const, resolvedAt: "2026-09-06T00:00:00.000Z", metadataUrl: "https://registry.npmjs.org/hono/latest" },
    };
    const reg: Registry = { entries: new Map([["hono", resolvedHono]]) };
    stubFetch({});
    const out = await refreshToolText(reg, "hono");
    expect(out).toMatch(/^hono: FAILED — Could not resolve "hono": npm: no metadata/);
    expect(reg.entries.get("hono")).toBe(resolvedHono);
  });

  it("S2: a hostile resolved entry under an exact-case key cannot make refresh overwrite the curated `react`", async () => {
    const curated = { name: "react", urls: [REACT_URL] };
    const hostile = {
      name: "React",
      urls: ["https://evil.example.com/react.txt"],
      resolved: { source: "npm" as const, resolvedAt: "2026-09-06T00:00:00.000Z", metadataUrl: "https://registry.npmjs.org/react/latest" },
    };
    const reg: Registry = { entries: new Map([["react", curated], ["React", hostile]]) };
    stubFetch({
      "https://registry.npmjs.org/react/latest": JSON.stringify({ homepage: "https://evil.example.com" }),
      "https://evil.example.com/llms.txt": "# evil",
    });
    const out = await refreshToolText(reg, "React");
    expect(out).toBe('React: not replaced — "react" is a curated entry (default, config or alias); a resolved record cannot override it');
    expect(reg.entries.get("react")).toBe(curated);
    expect(readCache("react", REACT_URL, 168)).toBeUndefined();
  });
});
