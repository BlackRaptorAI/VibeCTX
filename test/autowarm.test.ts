import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
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

/** n configured entries, none cached. */
function manyEntries(n: number): Registry {
  const entries = new Map();
  for (let i = 0; i < n; i++) entries.set(`lib${i}`, { name: `lib${i}`, urls: [`https://lib${i}.example.com/llms.txt`] });
  return { entries };
}

/** A fetch stub that resolves after `ms`, tracking peak concurrency. */
function slowFetch(ms: number, body = "# doc") {
  const state = { inFlight: 0, peak: 0, urls: [] as string[] };
  const spy = vi.fn(async (url: unknown) => {
    state.inFlight += 1;
    state.peak = Math.max(state.peak, state.inFlight);
    state.urls.push(String(url));
    await new Promise((r) => setTimeout(r, ms));
    state.inFlight -= 1;
    return new Response(body, { status: 200, headers: { "content-type": "text/plain" } });
  });
  vi.stubGlobal("fetch", spy);
  return { spy, state };
}

describe("shouldAutowarm (R5: env only — the server has no --offline mode)", () => {
  it("is on by default for the long-lived server, off with VIBECTX_NO_AUTOWARM set to anything but '', '0', 'false'", () => {
    expect(AUTOWARM_OPT_OUT_ENV).toBe("VIBECTX_NO_AUTOWARM");
    expect(shouldAutowarm({})).toBe(true);
    expect(shouldAutowarm({ VIBECTX_NO_AUTOWARM: "1" })).toBe(false);
    expect(shouldAutowarm({ VIBECTX_NO_AUTOWARM: "true" })).toBe(false);
    expect(shouldAutowarm({ VIBECTX_NO_AUTOWARM: "yes" })).toBe(false);
    expect(shouldAutowarm({ VIBECTX_NO_AUTOWARM: "0" })).toBe(true);
    expect(shouldAutowarm({ VIBECTX_NO_AUTOWARM: "false" })).toBe(true);
    expect(shouldAutowarm({ VIBECTX_NO_AUTOWARM: "" })).toBe(true);
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
  it("revalidates stale entries etag-first and fetches uncached ones; list_libraries shows warming… while in flight", async () => {
    writeCache("react", REACT_URL, "# React fresh"); // fresh: left alone
    writeCache("hono", HONO_URL, "# Hono old", '"v1"'); // stale (ttl 0): revalidated
    const reg = registry(); // zod: uncached → fetched; elysia: resolved → left alone
    const seenDuring: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: unknown, init?: RequestInit) => {
        seenDuring.push(listLibrariesText(reg));
        await new Promise((r) => setTimeout(r, 5));
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
    expect(summary).toEqual({ attempted: 2, cached: 2, failed: [], aborted: 0 });
    expect(autowarmStatus().started).toBe(true);
    expect(autowarmStatus().inFlight.size).toBe(0);
    expect(readCache("zod", ZOD_URL, 168)?.content).toBe("# Zod");
    expect(readCache("hono", HONO_URL, 168)?.content).toBe("# Hono old"); // 304: TTL touched, body untouched
    expect(seenDuring.some((t) => /\*\*hono\*\*.*warming…/.test(t) || /\*\*zod\*\*.*warming…/.test(t))).toBe(true);
    expect(listLibrariesText(reg)).not.toContain("warming…");
    expect(notes.join("")).toMatch(/^vibectx: autowarm cached 2\/2 configured libraries\n$/);
  });

  it("Q4: with six entries needing warm, peak concurrency is exactly AUTOWARM_CONCURRENCY", async () => {
    expect(AUTOWARM_CONCURRENCY).toBe(2);
    const { state } = slowFetch(10);
    const summary = await startAutowarm(manyEntries(6), { warn: () => {} });
    expect(summary).toEqual({ attempted: 6, cached: 6, failed: [], aborted: 0 });
    expect(state.peak).toBe(AUTOWARM_CONCURRENCY);
  });

  it("R4: once the signal aborts, no further entry is scheduled; the ones in flight finish; the summary says how many never started", async () => {
    const { spy, state } = slowFetch(20);
    const controller = new AbortController();
    const notes: string[] = [];
    const run = startAutowarm(manyEntries(8), { signal: controller.signal, warn: (m) => notes.push(m) });
    await new Promise((r) => setTimeout(r, 5)); // the first two are in flight
    expect(autowarmStatus().inFlight.size).toBe(2);
    controller.abort();
    const summary = await run;
    expect(spy).toHaveBeenCalledTimes(2);
    expect(state.urls).toEqual(["https://lib0.example.com/llms.txt", "https://lib1.example.com/llms.txt"]);
    expect(summary).toEqual({ attempted: 8, cached: 2, failed: [], aborted: 6 });
    expect(autowarmStatus().inFlight.size).toBe(0);
    expect(notes.join("")).toBe("vibectx: autowarm cached 2/8 configured libraries; 6 not started (transport closed)\n");
  });

  it("R4: a signal already aborted before the run starts schedules nothing", async () => {
    const { spy } = slowFetch(1);
    const controller = new AbortController();
    controller.abort();
    const summary = await startAutowarm(manyEntries(3), { signal: controller.signal, warn: () => {} });
    expect(spy).not.toHaveBeenCalled();
    expect(summary).toEqual({ attempted: 3, cached: 0, failed: [], aborted: 3 });
  });

  it("Q5: a cache directory that cannot be written (a file where the library dir belongs) fails that entry only; the run completes and reports it", async () => {
    writeFileSync(join(dir, "zod"), "not a directory", "utf8"); // writeCache → mkdirSync throws ENOTDIR/EEXIST
    writeCache("react", REACT_URL, "# React fresh");
    const reg: Registry = { entries: new Map([...registry().entries].filter(([k]) => k !== "hono")) };
    vi.stubGlobal("fetch", vi.fn(async () => new Response("# Zod", { status: 200, headers: { "content-type": "text/plain" } })));
    const notes: string[] = [];
    const summary = await startAutowarm(reg, { warn: (m) => notes.push(m) });
    expect(summary).toEqual({ attempted: 1, cached: 0, failed: ["zod"], aborted: 0 });
    expect(autowarmStatus().inFlight.size).toBe(0);
    expect(notes.join("")).toMatch(/^vibectx: autowarm cached 0\/1 configured libraries; not fetched: zod \(zod: E(NOTDIR|EXIST)/);
  });

  it("Q5: a corrupt meta.json makes the pre-scan itself throw — the outer catch reports it and the promise still resolves", async () => {
    mkdirSync(join(dir, "react"), { recursive: true });
    const slug = REACT_URL.replace(/[^a-z0-9]/gi, "_");
    writeFileSync(join(dir, "react", `${slug}.md`), "# React", "utf8");
    writeFileSync(join(dir, "react", `${slug}.meta.json`), "{ corrupt", "utf8");
    const spy = vi.fn();
    vi.stubGlobal("fetch", spy);
    const notes: string[] = [];
    const summary = await startAutowarm(registry(), { warn: (m) => notes.push(m) });
    expect(summary).toEqual({ attempted: 0, cached: 0, failed: [], aborted: 0 });
    expect(spy).not.toHaveBeenCalled();
    expect(notes.join("")).toMatch(/^vibectx: autowarm cached 0\/0 configured libraries \(.*JSON/);
  });

  it("swallows a throwing fetchDoc and a network failure alike: the promise resolves and the failures are reported once", async () => {
    const reg = registry();
    const notes: string[] = [];
    const summary = await startAutowarm(reg, {
      warn: (m) => notes.push(m),
      fetchDoc: async (entry) => {
        if (entry.name === "zod") throw new Error("boom");
        return undefined;
      },
    });
    expect(summary).toEqual({ attempted: 3, cached: 0, failed: ["react", "hono", "zod"], aborted: 0 });
    expect(notes.join("")).toBe("vibectx: autowarm cached 0/3 configured libraries; not fetched: react, hono, zod (zod: boom)\n");
  });

  it("a warn sink that throws (stderr closed) does not break the run", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("# doc", { status: 200, headers: { "content-type": "text/plain" } })));
    await expect(
      startAutowarm(manyEntries(1), {
        warn: () => {
          throw new Error("EPIPE");
        },
      }),
    ).resolves.toEqual({ attempted: 1, cached: 1, failed: [], aborted: 0 });
  });

  it("does nothing, and says nothing, when every configured entry is fresh", async () => {
    writeCache("react", REACT_URL, "# React");
    writeCache("zod", ZOD_URL, "# Zod");
    const reg: Registry = { entries: new Map([...registry().entries].filter(([k]) => k !== "hono")) };
    const spy = vi.fn();
    vi.stubGlobal("fetch", spy);
    const notes: string[] = [];
    expect(await startAutowarm(reg, { warn: (m) => notes.push(m) })).toEqual({ attempted: 0, cached: 0, failed: [], aborted: 0 });
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

  it("source tripwire: server.ts starts it only after connect, guarded by shouldAutowarm, never awaited; index.ts closes the server when stdin ends", () => {
    const server = readFileSync(new URL("../src/server.ts", import.meta.url), "utf8");
    const connectAt = server.indexOf("await server.connect(transport)");
    const startAt = server.indexOf("startAutowarm(registry");
    expect(connectAt).toBeGreaterThan(-1);
    expect(startAt).toBeGreaterThan(connectAt);
    expect(server.slice(connectAt, startAt)).toContain("shouldAutowarm(");
    const startLine = server.split("\n").find((l) => l.includes("startAutowarm(registry"))!;
    expect(startLine).not.toContain("await");
    const index = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
    expect(index).toMatch(/process\.stdin\.once\("end", \(\) => void started\.server\.close\(\)\)/);
    expect(index).not.toContain("startAutowarm(");
  });
});
