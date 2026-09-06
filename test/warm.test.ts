import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readCache, writeCache } from "../src/cache.js";
import { loadRegistry, type Registry } from "../src/registry.js";
import { resolvePackage, resetResolutionWindow, MAX_RESOLUTIONS_PER_HOUR } from "../src/resolve.js";
import { readProjectRecord, projectRecordPath } from "../src/project-store.js";
import { runWarm, formatWarmTable, warmExitCode, warmToolText, WARM_CONCURRENCY, type WarmReport } from "../src/warm.js";

let cache: string;
let project: string;

beforeEach(() => {
  cache = mkdtempSync(join(tmpdir(), "vibectx-warm-cache-"));
  project = mkdtempSync(join(tmpdir(), "vibectx-warm-proj-"));
  process.env.DOCS_CACHE_DIR = cache;
  resetResolutionWindow();
});

afterEach(() => {
  delete process.env.DOCS_CACHE_DIR;
  rmSync(cache, { recursive: true, force: true });
  rmSync(project, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

function stubFetch(routes: Record<string, unknown>) {
  const spy = vi.fn(async (url: unknown) => {
    const body = routes[String(url)];
    if (body === undefined) return new Response("not found", { status: 404 });
    if (typeof body === "string") return new Response(body, { status: 200, headers: { "content-type": "text/plain" } });
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  });
  vi.stubGlobal("fetch", spy);
  return spy;
}

function writePackageJson(deps: Record<string, string>, devDeps: Record<string, string> = {}): void {
  writeFileSync(join(project, "package.json"), JSON.stringify({ name: "app", dependencies: deps, devDependencies: devDeps }), "utf8");
}

const REACT_URL = "https://react.dev/llms-full.txt";
const HONO_URL = "https://hono.dev/llms.txt";
const registry = (): Registry => ({
  entries: new Map([
    ["react", { name: "react", urls: [REACT_URL], aliases: ["react-dom"] }],
    ["hono", { name: "hono", urls: [HONO_URL] }],
  ]),
});

const byName = (r: WarmReport) => Object.fromEntries(r.dependencies.map((d) => [d.name, d]));

describe("runWarm (PAR-656)", () => {
  it("cached / already fresh / resolved+cached / unresolved / denied / unreachable, all in one run; record written", async () => {
    writeCache("react", REACT_URL, "# React fresh");
    writePackageJson({ react: "19", hono: "4", elysia: "1", "zz-nothing": "1", "@types/node": "22" });
    stubFetch({
      [HONO_URL]: "# Hono",
      "https://registry.npmjs.org/elysia/latest": { homepage: "https://elysiajs.com", repository: "https://github.com/elysiajs/elysia" },
      "https://raw.githubusercontent.com/elysiajs/elysia/HEAD/README.md": "# Elysia",
    });
    const reg = registry();
    const report = await runWarm(reg, { dir: project });
    expect(Object.keys(report)).toEqual([
      "schemaVersion",
      "generatedAt",
      "dir",
      "offline",
      "manifests",
      "notes",
      "dependencies",
      "cached",
      "attempted",
      "denied",
      "total",
    ]);
    expect(report.schemaVersion).toBe(1);
    expect(report.manifests).toEqual(["package.json"]);
    const rows = byName(report);
    expect(rows.react).toEqual({ name: "react", ecosystem: "npm", source: "package.json", library: "react", status: "already fresh", url: REACT_URL });
    expect(rows.hono).toEqual({ name: "hono", ecosystem: "npm", source: "package.json", library: "hono", status: "cached", url: HONO_URL });
    expect(rows.elysia).toMatchObject({ library: "elysia", status: "resolved+cached", url: "https://raw.githubusercontent.com/elysiajs/elysia/HEAD/README.md" });
    expect(rows["zz-nothing"]).toMatchObject({ status: "unresolved" });
    expect(rows["zz-nothing"].note).toMatch(/npm: no metadata/);
    expect(rows["@types/node"]).toEqual({ name: "@types/node", ecosystem: "npm", source: "package.json", status: "denied (noise list)" });
    expect(report.total).toBe(5);
    expect(report.denied).toBe(1);
    expect(report.attempted).toBe(4);
    expect(report.cached).toBe(3);
    expect(warmExitCode(report)).toBe(1);
    // The resolved entry joined the live registry and the cache holds its document.
    expect(reg.entries.get("elysia")?.resolved?.source).toBe("npm");
    expect(readCache("elysia", "https://raw.githubusercontent.com/elysiajs/elysia/HEAD/README.md", 168)?.content).toBe("# Elysia");
    expect(readCache("hono", HONO_URL, 168)?.content).toBe("# Hono");
    // Project record.
    const record = readProjectRecord(project);
    expect(record?.dependencies).toEqual(report.dependencies);
    expect(record?.warmedAt).toBe(report.generatedAt);
  });

  it("exit 0 when every attempted name is cached / fresh / resolved+cached, denied names notwithstanding", async () => {
    writeCache("react", REACT_URL, "# React fresh");
    writePackageJson({ react: "19" }, { eslint: "9", prettier: "3" });
    const spy = stubFetch({});
    const report = await runWarm(registry(), { dir: project });
    expect(report.cached).toBe(1);
    expect(report.attempted).toBe(1);
    expect(report.denied).toBe(2);
    expect(warmExitCode(report)).toBe(0);
    expect(spy).not.toHaveBeenCalled();
  });

  it("an alias in the manifest warms the canonical entry (react-dom → react) and reports the library column", async () => {
    writePackageJson({ "react-dom": "19" });
    stubFetch({ [REACT_URL]: "# React" });
    const report = await runWarm(registry(), { dir: project });
    expect(byName(report)["react-dom"]).toMatchObject({ library: "react", status: "cached", url: REACT_URL });
  });

  it("two manifest names that map to one entry (react + react-dom) fetch that entry once; both rows report it", async () => {
    writePackageJson({ react: "19", "react-dom": "19", hono: "4" });
    const spy = stubFetch({ [REACT_URL]: "# React", [HONO_URL]: "# Hono" });
    const report = await runWarm(registry(), { dir: project });
    expect(byName(report).react).toMatchObject({ library: "react", status: "cached", url: REACT_URL });
    expect(byName(report)["react-dom"]).toMatchObject({ library: "react", status: "cached", url: REACT_URL });
    expect(spy.mock.calls.filter((c) => String(c[0]) === REACT_URL)).toHaveLength(1);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("a stale entry is revalidated (etag-first) and reported cached; when the network fails the stale copy is kept and reported unreachable", async () => {
    writeCache("react", REACT_URL, "# React old", '"v1"');
    writePackageJson({ react: "19" });
    const reg: Registry = { entries: new Map([["react", { name: "react", urls: [REACT_URL], ttlHours: 0 }]]) };
    const spy = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string>;
      expect(headers["if-none-match"]).toBe('"v1"');
      return new Response(null, { status: 304 });
    });
    vi.stubGlobal("fetch", spy);
    const ok = await runWarm(reg, { dir: project });
    expect(byName(ok).react).toMatchObject({ status: "cached", url: REACT_URL });
    expect(spy).toHaveBeenCalledTimes(1);

    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("ECONNREFUSED"); }));
    const failed = await runWarm(reg, { dir: project });
    expect(byName(failed).react).toMatchObject({ status: "unreachable", url: REACT_URL });
    expect(byName(failed).react.note).toMatch(/stale copy .* kept/);
    expect(warmExitCode(failed)).toBe(1);
  });

  it("nothing cached and the network down → unreachable, run continues, exit 1", async () => {
    writePackageJson({ react: "19", hono: "4" });
    stubFetch({ [HONO_URL]: "# Hono" });
    const report = await runWarm(registry(), { dir: project });
    expect(byName(report).react).toMatchObject({ status: "unreachable", note: "all candidate URLs unreachable" });
    expect(byName(report).hono).toMatchObject({ status: "cached" });
    expect(warmExitCode(report)).toBe(1);
  });

  it("resolution respects the per-hour cap: once it is hit the rest are `skipped (rate cap)`, the run continues, exit 1", async () => {
    const spy = stubFetch({
      "https://registry.npmjs.org/hono/latest": { homepage: "https://hono.dev" },
      "https://hono.dev/llms.txt": "# Hono",
      "https://registry.npmjs.org/a-one/latest": { homepage: "https://a-one.example.com" },
      "https://a-one.example.com/llms.txt": "# a-one",
      "https://registry.npmjs.org/b-two/latest": { homepage: "https://b-two.example.com" },
      "https://b-two.example.com/llms.txt": "# b-two",
    });
    let t = Date.parse("2026-09-06T10:00:00Z");
    const now = () => new Date(t);
    for (let i = 0; i < MAX_RESOLUTIONS_PER_HOUR - 1; i++) expect((await resolvePackage("hono", { now })).ok).toBe(true);
    spy.mockClear();
    writePackageJson({ "a-one": "1", "b-two": "1", react: "19" });
    writeCache("react", REACT_URL, "# React fresh");
    const reg: Registry = { entries: new Map([["react", { name: "react", urls: [REACT_URL] }]]) };
    const report = await runWarm(reg, { dir: project, now, concurrency: 1 });
    const rows = byName(report);
    expect(rows["a-one"]).toMatchObject({ status: "resolved+cached" });
    expect(rows["b-two"]).toMatchObject({ status: "skipped (rate cap)" });
    expect(rows["b-two"].note).toMatch(/resolution limit reached/);
    expect(rows.react).toMatchObject({ status: "already fresh" });
    expect(spy.mock.calls.map((c) => String(c[0]))).not.toContain("https://registry.npmjs.org/b-two/latest");
    expect(report.cached).toBe(2);
    expect(report.attempted).toBe(3);
    expect(warmExitCode(report)).toBe(1); // a capped name is not cached
    // The window slides: an hour later the same run resolves it.
    t += 61 * 60_000;
    expect(byName(await runWarm(reg, { dir: project, now }))["b-two"]).toMatchObject({ status: "resolved+cached" });
  });

  it("resolves with the ecosystem the manifest implies (pyproject → PyPI only, no npm metadata fetch)", async () => {
    writeFileSync(join(project, "pyproject.toml"), '[project]\ndependencies = ["httpx>=0.27"]\n', "utf8");
    const spy = stubFetch({
      "https://pypi.org/pypi/httpx/json": { info: { project_urls: { Documentation: "https://www.python-httpx.org" } } },
      "https://www.python-httpx.org/llms.txt": "# HTTPX",
    });
    const report = await runWarm(registry(), { dir: project });
    expect(byName(report).httpx).toMatchObject({ ecosystem: "pypi", source: "pyproject.toml", status: "resolved+cached", library: "httpx" });
    expect(spy.mock.calls.map((c) => String(c[0]))).not.toContain("https://registry.npmjs.org/httpx/latest");
  });

  it("--offline: cache-only report, no fetch, no record written; stale = cached (noted), missing = unreachable, unknown = unresolved", async () => {
    writeCache("react", REACT_URL, "# React fresh");
    writeCache("hono", HONO_URL, "# Hono old");
    writePackageJson({ react: "19", hono: "4", elysia: "1", eslint: "9" });
    const reg: Registry = {
      entries: new Map([
        ["react", { name: "react", urls: [REACT_URL] }],
        ["hono", { name: "hono", urls: [HONO_URL], ttlHours: 0 }],
        ["zod", { name: "zod", urls: ["https://zod.dev/llms.txt"] }],
      ]),
    };
    writeFileSync(join(project, "package.json"), JSON.stringify({ dependencies: { react: "19", hono: "4", zod: "3", elysia: "1", eslint: "9" } }), "utf8");
    const spy = stubFetch({});
    const report = await runWarm(reg, { dir: project, offline: true });
    expect(report.offline).toBe(true);
    const rows = byName(report);
    expect(rows.react).toMatchObject({ status: "already fresh" });
    expect(rows.hono).toMatchObject({ status: "cached", url: HONO_URL });
    expect(rows.hono.note).toMatch(/^stale copy from .*; offline$/);
    expect(rows.zod).toMatchObject({ status: "unreachable", note: "not cached; offline" });
    expect(rows.elysia).toMatchObject({ status: "unresolved", note: "not in the registry; offline, not resolved" });
    expect(rows.eslint).toMatchObject({ status: "denied (noise list)" });
    expect(spy).not.toHaveBeenCalled();
    expect(existsSync(projectRecordPath(project))).toBe(false);
    expect(warmExitCode(report)).toBe(1);
  });

  it("throws when the directory has no manifest (and lists what it looked for) or is not a directory", async () => {
    await expect(runWarm(registry(), { dir: project })).rejects.toThrow(/no dependency manifest in .*looked for package\.json, pyproject\.toml, requirements\*\.txt, package-lock\.json, pnpm-lock\.yaml/);
    await expect(runWarm(registry(), { dir: join(project, "nope") })).rejects.toThrow(/not a directory/);
    writeFileSync(join(project, "yarn.lock"), "# yarn lockfile v1\n", "utf8");
    await expect(runWarm(registry(), { dir: project })).rejects.toThrow(/yarn\.lock: not read/);
  });

  it("a manifest with zero dependencies is a valid, empty run (exit 0)", async () => {
    writePackageJson({});
    const report = await runWarm(registry(), { dir: project });
    expect(report.total).toBe(0);
    expect(warmExitCode(report)).toBe(0);
    expect(formatWarmTable(report)).toContain("0/0 dependencies cached");
  });

  it("a per-name failure (cache write error) is an `unreachable` row with the message, never a thrown run", async () => {
    writePackageJson({ react: "19", hono: "4" });
    stubFetch({ [REACT_URL]: "# React", [HONO_URL]: "# Hono" });
    // Make react's cache directory unwritable by planting a FILE where the library dir should be.
    writeFileSync(join(cache, "react"), "not a directory", "utf8");
    const report = await runWarm(registry(), { dir: project });
    expect(byName(report).react.status).toBe("unreachable");
    expect(byName(report).react.note).toMatch(/^error: /);
    expect(byName(report).hono).toMatchObject({ status: "cached" });
  });

  it("runs at most WARM_CONCURRENCY names at once", async () => {
    expect(WARM_CONCURRENCY).toBe(4);
    const deps: Record<string, string> = {};
    const entries = new Map();
    for (let i = 0; i < 10; i++) {
      deps[`lib${i}`] = "1";
      entries.set(`lib${i}`, { name: `lib${i}`, urls: [`https://lib${i}.example.com/llms.txt`] });
    }
    writePackageJson(deps);
    let inFlight = 0;
    let peak = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight -= 1;
        return new Response("# doc", { status: 200, headers: { "content-type": "text/plain" } });
      }),
    );
    const report = await runWarm({ entries }, { dir: project });
    expect(report.cached).toBe(10);
    expect(peak).toBe(WARM_CONCURRENCY);
  });
});

describe("formatWarmTable / warmToolText", () => {
  it("prints one row per dependency, a summary line, and the discovery notes", async () => {
    writeCache("react", REACT_URL, "# React fresh");
    writeFileSync(join(project, "package.json"), JSON.stringify({ dependencies: { react: "19", "@types/node": "22" } }), "utf8");
    writeFileSync(join(project, "yarn.lock"), "", "utf8"); // present but ignored while package.json exists: no note
    const report = await runWarm(registry(), { dir: project, offline: true });
    const text = formatWarmTable(report);
    const lines = text.split("\n");
    expect(lines[0]).toBe(`vibectx warm · ${project} · offline · cache ${cache}`);
    expect(lines[1]).toBe("manifests: package.json");
    expect(lines[2]).toBe("");
    expect(lines[3]).toMatch(/^dependency\s+library\s+status\s+url$/);
    expect(lines[4]).toMatch(/^react\s+react\s+already fresh\s+https:\/\/react\.dev\/llms-full\.txt$/);
    expect(lines[5]).toMatch(/^@types\/node\s+—\s+denied \(noise list\)\s+—$/);
    expect(lines[6]).toBe("");
    expect(lines[7]).toBe("1/1 dependencies cached · 1 denied (noise list)");
    expect(lines).toHaveLength(8);
  });

  it("lists notes and per-name detail lines for anything not cached", async () => {
    writePackageJson({ "zz-nothing": "1" });
    writeFileSync(join(project, "requirements.txt"), "-r missing.txt\n", "utf8");
    stubFetch({});
    const report = await runWarm(registry(), { dir: project });
    const text = formatWarmTable(report);
    expect(text).toContain("0/1 dependencies cached");
    expect(text).toContain("✗ zz-nothing: npm: no metadata (404 or unreachable)");
    expect(text).toContain("note: requirements.txt: -r missing.txt not found; skipped");
  });

  it("warmToolText returns the table for a directory, or the error line for a bad one (never throws)", async () => {
    writeCache("react", REACT_URL, "# React fresh");
    writePackageJson({ react: "19" });
    stubFetch({});
    const text = await warmToolText(registry(), project);
    expect(text).toMatch(/^vibectx warm · /);
    expect(text).toContain("1/1 dependencies cached");
    expect(await warmToolText(registry(), join(project, "nope"))).toMatch(/is not a directory$/);
    expect(await warmToolText(registry(), cache)).toMatch(/^no dependency manifest in /);
  });

  it("the default registry with the demo scaffold (offline, empty cache): every real dependency unreachable, noise denied", async () => {
    writePackageJson(
      { next: "15", react: "19", "react-dom": "19", "@supabase/supabase-js": "2", stripe: "16" },
      { tailwindcss: "4", typescript: "5", "@types/node": "22", "@types/react": "19", eslint: "9", "eslint-config-next": "15", postcss: "8" },
    );
    const spy = stubFetch({});
    const report = await runWarm(loadRegistry(undefined, { includeResolved: false }), { dir: project, offline: true });
    expect(spy).not.toHaveBeenCalled();
    const rows = byName(report);
    // Curated hits resolve to their canonical entries without network, even offline.
    expect(rows.next.library).toBe("next.js");
    expect(rows["react-dom"].library).toBe("react");
    expect(rows["@supabase/supabase-js"].library).toBe("supabase");
    expect(rows.stripe.library).toBe("stripe");
    expect(rows.tailwindcss.library).toBe("tailwindcss");
    expect(rows.typescript).toMatchObject({ status: "unresolved" }); // kept, not denied — but offline it cannot be resolved
    for (const n of ["@types/node", "@types/react", "eslint", "eslint-config-next", "postcss"]) expect(rows[n].status, n).toBe("denied (noise list)");
    expect(report.denied).toBe(5);
    expect(report.attempted).toBe(7);
  });
});
