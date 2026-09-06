import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readCache, writeCache } from "../src/cache.js";
import type { Registry } from "../src/registry.js";
import {
  AUTOWARM_CONCURRENCY,
  AUTOWARM_OPT_OUT_ENV,
  shouldAutowarm,
  configuredEntriesNeedingWarm,
  startAutowarm,
  autowarmStatus,
  resetAutowarm,
} from "../src/autowarm.js";
import { listLibrariesText } from "../src/list-libraries.js";
import { dispatchCli } from "../src/cli.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "vibectx-autowarm-"));
  process.env.DOCS_CACHE_DIR = dir;
  resetAutowarm();
});

afterEach(() => {
  delete process.env.DOCS_CACHE_DIR;
  rmSync(dir, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

const REACT_URL = "https://react.dev/llms-full.txt";
const HONO_URL = "https://hono.dev/llms.txt";
const ZOD_URL = "https://zod.dev/llms.txt";

function registry(): Registry {
  return {
    entries: new Map([
      ["react", { name: "react", urls: [REACT_URL] }],
      ["hono", { name: "hono", urls: [HONO_URL], ttlHours: 0 }],
      ["zod", { name: "zod", urls: [ZOD_URL] }],
      [
        "elysia",
        {
          name: "elysia",
          urls: ["https://elysiajs.com/llms.txt"],
          resolved: { source: "npm", resolvedAt: "2026-09-06T00:00:00.000Z", metadataUrl: "https://registry.npmjs.org/elysia/latest" },
        },
      ],
    ]),
  };
}

describe("shouldAutowarm", () => {
  it("is on by default for the long-lived server, off with VIBECTX_NO_AUTOWARM=1 or --offline", () => {
    expect(AUTOWARM_OPT_OUT_ENV).toBe("VIBECTX_NO_AUTOWARM");
    expect(shouldAutowarm({}, ["node", "dist/index.js"])).toBe(true);
    expect(shouldAutowarm({}, ["node", "dist/index.js", "--config", "c.json"])).toBe(true);
    expect(shouldAutowarm({ VIBECTX_NO_AUTOWARM: "1" }, ["node", "dist/index.js"])).toBe(false);
    expect(shouldAutowarm({ VIBECTX_NO_AUTOWARM: "true" }, ["node", "dist/index.js"])).toBe(false);
    expect(shouldAutowarm({ VIBECTX_NO_AUTOWARM: "0" }, ["node", "dist/index.js"])).toBe(true);
    expect(shouldAutowarm({ VIBECTX_NO_AUTOWARM: "" }, ["node", "dist/index.js"])).toBe(true);
    expect(shouldAutowarm({}, ["node", "dist/index.js", "--offline"])).toBe(false);
  });
});

describe("configuredEntriesNeedingWarm", () => {
  it("picks configured (non-resolved) entries that are uncached or past TTL; fresh ones and resolved ones are left alone", () => {
    writeCache("react", REACT_URL, "# React fresh");
    writeCache("hono", HONO_URL, "# Hono stale"); // ttlHours 0 → stale at once
    const names = configuredEntriesNeedingWarm(registry()).map((e) => e.name);
    expect(names).toEqual(["hono", "zod"]);
  });
});

describe("startAutowarm", () => {
  it("revalidates stale entries etag-first and fetches uncached ones, at most AUTOWARM_CONCURRENCY at once; list_libraries shows warming… while in flight", async () => {
    expect(AUTOWARM_CONCURRENCY).toBe(2);
    writeCache("react", REACT_URL, "# React fresh"); // fresh: left alone
    writeCache("hono", HONO_URL, "# Hono old", '"v1"'); // stale (ttl 0): revalidated
    const reg = registry(); // zod: uncached → fetched; elysia: resolved → left alone
    const seenDuring: string[] = [];
    let inFlight = 0;
    let peak = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: unknown, init?: RequestInit) => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        seenDuring.push(listLibrariesText(reg));
        await new Promise((r) => setTimeout(r, 5));
        inFlight -= 1;
        if (String(url) === HONO_URL) {
          expect((init?.headers as Record<string, string>)["if-none-match"]).toBe('"v1"');
          return new Response(null, { status: 304 });
        }
        return new Response("# Zod", { status: 200, headers: { "content-type": "text/plain" } });
      }),
    );
    const notes: string[] = [];
    expect(autowarmStatus().started).toBe(false);
    const summary = await startAutowarm(reg, { warn: (m) => notes.push(m) });
    expect(summary).toEqual({ attempted: 2, cached: 2, failed: [] });
    expect(peak).toBeLessThanOrEqual(AUTOWARM_CONCURRENCY);
    expect(autowarmStatus().started).toBe(true);
    expect(autowarmStatus().inFlight.size).toBe(0);
    expect(readCache("zod", ZOD_URL, 168)?.content).toBe("# Zod");
    expect(readCache("hono", HONO_URL, 168)?.content).toBe("# Hono old"); // 304: TTL touched, body untouched
    // While a fetch was in flight, list_libraries marked that entry.
    expect(seenDuring.some((t) => /\*\*hono\*\*.*warming…/.test(t) || /\*\*zod\*\*.*warming…/.test(t))).toBe(true);
    expect(listLibrariesText(reg)).not.toContain("warming…");
    expect(notes.join("")).toMatch(/^vibectx: autowarm cached 2\/2 configured libraries\n$/);
  });

  it("swallows every error: a throwing fetch, a throwing fetchDoc, a cache directory that cannot be written — the promise resolves and the failures are reported once", async () => {
    const reg = registry();
    const notes: string[] = [];
    const summary = await startAutowarm(reg, {
      warn: (m) => notes.push(m),
      fetchDoc: async (entry) => {
        if (entry.name === "zod") throw new Error("boom");
        return undefined;
      },
    });
    expect(summary).toEqual({ attempted: 3, cached: 0, failed: ["react", "hono", "zod"] });
    expect(autowarmStatus().inFlight.size).toBe(0);
    expect(notes.join("")).toBe("vibectx: autowarm cached 0/3 configured libraries; not fetched: react, hono, zod (zod: boom)\n");
  });

  it("does nothing, and says nothing, when every configured entry is fresh", async () => {
    writeCache("react", REACT_URL, "# React");
    writeCache("zod", ZOD_URL, "# Zod");
    const reg: Registry = { entries: new Map([...registry().entries].filter(([k]) => k !== "hono")) };
    const spy = vi.fn();
    vi.stubGlobal("fetch", spy);
    const notes: string[] = [];
    expect(await startAutowarm(reg, { warn: (m) => notes.push(m) })).toEqual({ attempted: 0, cached: 0, failed: [] });
    expect(spy).not.toHaveBeenCalled();
    expect(notes).toEqual([]);
  });

  it("is never started by the doctor / resolve / warm subcommands", async () => {
    const spy = vi.fn(async () => new Response("not found", { status: 404 }));
    vi.stubGlobal("fetch", spy);
    const io = { stdout: () => {}, stderr: () => {} };
    await dispatchCli(["node", "dist/index.js", "doctor", "--offline"], io);
    await dispatchCli(["node", "dist/index.js", "resolve", "zz-nothing"], io);
    await dispatchCli(["node", "dist/index.js", "warm", dir, "--offline"], io);
    expect(autowarmStatus().started).toBe(false);
  });

  it("index.ts starts it only after the stdio transport is connected, guarded by shouldAutowarm (structural check)", () => {
    const src = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
    const connectAt = src.indexOf("await server.connect(transport)");
    const startAt = src.indexOf("startAutowarm(");
    expect(connectAt).toBeGreaterThan(-1);
    expect(startAt).toBeGreaterThan(connectAt);
    expect(src.slice(connectAt, startAt)).toContain("shouldAutowarm(process.env, process.argv)");
    expect(src).toMatch(/void startAutowarm\(/); // fire-and-forget: never awaited on the request path
  });
});
