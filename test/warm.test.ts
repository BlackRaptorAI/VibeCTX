import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync, symlinkSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readCache, writeCache } from "../src/cache.js";
import { loadDiscoveredRegistry, loadRegistry, DEFAULT_REGISTRY, type Registry } from "../src/registry.js";
import { resolvePackage, resetResolutionWindow, MAX_RESOLUTIONS_PER_HOUR } from "../src/resolve.js";
import { readProjectRecord, projectRecordPath, PROJECT_RECORD_SCHEMA_VERSION } from "../src/project-store.js";
import { documentHash, readIndex, resetSearchIndexMemo } from "../src/search-index.js";
import { runSearch } from "../src/search.js";
import { runWarm, formatWarmTable, warmExitCode, warmToolText, WARM_CONCURRENCY, WARM_SCHEMA_VERSION, type WarmReport } from "../src/warm.js";

let cache: string;
let project: string;

beforeEach(() => {
  cache = mkdtempSync(join(tmpdir(), "vibectx-warm-cache-"));
  project = mkdtempSync(join(tmpdir(), "vibectx-warm-proj-"));
  process.env.DOCS_CACHE_DIR = cache;
  resetResolutionWindow();
  resetSearchIndexMemo();
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

  it("R-2 / D-13: a project record that cannot be written is a warn line and a report note, never a failed run", async () => {
    writeCache("react", REACT_URL, "# React fresh");
    writePackageJson({ react: "19" });
    writeFileSync(join(cache, "projects"), "not a directory", "utf8"); // mkdir of <cacheRoot>/projects fails
    stubFetch({});
    const warnings: string[] = [];
    const report = await runWarm(registry(), { dir: project, warn: (m) => warnings.push(m) });
    expect(byName(report).react).toMatchObject({ status: "already fresh" });
    expect(report.cached).toBe(1);
    expect(warmExitCode(report)).toBe(0); // the docs ARE on disk; only the memo was lost
    expect(report.notes.some((n) => n.startsWith("project record not written: "))).toBe(true);
    expect(warnings.join("")).toMatch(/^vibectx: project record not written: /);
    expect(formatWarmTable(report)).toMatch(/note: project record not written: /);
  });

  it("K2/D-13: a record refused because a NEWER schema owns the file is a report note as well as a stderr line", async () => {
    writeCache("react", REACT_URL, "# React fresh");
    writePackageJson({ react: "19" });
    mkdirSync(join(cache, "projects"), { recursive: true });
    const future = JSON.stringify({ schemaVersion: PROJECT_RECORD_SCHEMA_VERSION + 1, dir: project });
    writeFileSync(projectRecordPath(project), future, "utf8");
    stubFetch({});
    const warnings: string[] = [];
    const report = await runWarm(registry(), { dir: project, warn: (m) => warnings.push(m) });
    expect(warmExitCode(report)).toBe(0); // the docs are cached; only the memo was refused
    expect(report.notes).toContain("project record not written: newer schema on disk");
    expect(warnings.join("")).toMatch(/newer schemaVersion 2/);
    expect(formatWarmTable(report)).toContain("note: project record not written: newer schema on disk");
    expect(readFileSync(projectRecordPath(project), "utf8")).toBe(future); // untouched
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

  it("S-C: a run sweeps orphan temp files out of the cache directories first", async () => {
    writeCache("react", REACT_URL, "# React fresh");
    mkdirSync(join(cache, "projects"), { recursive: true });
    const orphans = [join(cache, "resolved.json.4242.1757000000000.tmp"), join(cache, "projects", "abc.json.4242.1757000000000.tmp"), join(cache, "react", "page.md.4242.1757000000000.tmp")];
    for (const o of orphans) writeFileSync(o, "half a file", "utf8");
    writeFileSync(join(cache, "keep.tmp"), "not ours", "utf8");
    writePackageJson({ react: "19" });
    stubFetch({});
    await runWarm(registry(), { dir: project });
    for (const o of orphans) expect(existsSync(o), o).toBe(false);
    expect(existsSync(join(cache, "keep.tmp"))).toBe(true);
    expect(readCache("react", REACT_URL, 168)?.content).toBe("# React fresh");
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

  it("D-19: a skipped discovered config file is a note in --json and in the text report", async () => {
    // The whole point of `warm` is "your stack's docs are on disk". A run that quietly used
    // the shipped defaults, because the project's committed config was skipped, must not
    // read as a clean run — and `--json` consumers never see the stderr line.
    mkdirSync(join(project, ".git"), { recursive: true });
    writeFileSync(join(project, "vibectx.config.json"), '{ "libraries": [{ "name": "a", "urls": ["http://x/y"] }] }', "utf8");
    writePackageJson({ react: "19" });
    const reg = loadDiscoveredRegistry({ cwd: project, env: {}, home: join(cache, "home") });
    const report = await runWarm(reg, { dir: project, offline: true });
    const note = 'config: ./vibectx.config.json (project) not loaded: libraries[0].urls ("a"): must be a non-empty array of https URLs';
    expect(JSON.parse(JSON.stringify(report)).notes).toContain(note); // the --json report
    expect(formatWarmTable(report)).toContain(`note: ${note}`);
    expect(report.schemaVersion).toBe(WARM_SCHEMA_VERSION); // additive: no schema bump
  });

  it("warmToolText returns the table for a directory, or the error line for a bad one (never throws)", async () => {
    writeCache("react", REACT_URL, "# React fresh");
    writePackageJson({ react: "19" });
    stubFetch({});
    const cwd = vi.spyOn(process, "cwd").mockReturnValue(project); // D-10: the tool reads cwd or beneath
    try {
      const text = await warmToolText(registry(), project);
      expect(text).toMatch(/^vibectx warm · /);
      expect(text).toContain("1/1 dependencies cached");
      expect(await warmToolText(registry(), join(project, "nope"))).toMatch(/is not a directory$/);
      mkdirSync(join(project, "empty"));
      expect(await warmToolText(registry(), join(project, "empty"))).toMatch(/^no dependency manifest in /);
    } finally {
      cwd.mockRestore();
    }
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

describe("rework conditions (PAR-656 R1 / R3 / D-10 / K1 / Q1)", () => {
  it("K1: every row's keys come in the documented order name, ecosystem, source, library?, status, url?, note?, failedAt?", async () => {
    writeCache("react", REACT_URL, "# React fresh");
    writePackageJson({ react: "19", "zz-nothing": "1", eslint: "9" });
    stubFetch({});
    const report = await runWarm(registry(), { dir: project });
    const order = ["name", "ecosystem", "source", "library", "status", "url", "note", "failedAt"];
    for (const row of report.dependencies) {
      const keys = Object.keys(row);
      expect(keys, row.name).toEqual(order.filter((k) => keys.includes(k)));
    }
    expect(Object.keys(byName(report).react)).toEqual(["name", "ecosystem", "source", "library", "status", "url"]);
    expect(Object.keys(byName(report)["zz-nothing"])).toEqual(["name", "ecosystem", "source", "status", "note", "failedAt"]);
  });

  it("K-2: the report's schema version IS the project record's — one constant, so the two can never drift", async () => {
    expect(WARM_SCHEMA_VERSION).toBe(PROJECT_RECORD_SCHEMA_VERSION);
    writeCache("react", REACT_URL, "# React fresh");
    writePackageJson({ react: "19" });
    stubFetch({});
    const report = await runWarm(registry(), { dir: project });
    expect(report.schemaVersion).toBe(WARM_SCHEMA_VERSION);
    expect(JSON.parse(readFileSync(projectRecordPath(project), "utf8")).schemaVersion).toBe(WARM_SCHEMA_VERSION);
  });

  it("Q1: warm fetches ONLY the primary document — an index-like primary with links is cached and none of its links are requested", async () => {
    const INDEX = "# Hono\n- [Routing](https://hono.dev/docs/routing.md)\n- [Middleware](https://hono.dev/docs/middleware.md)\n- [Helpers](https://hono.dev/docs/helpers.md)";
    writePackageJson({ hono: "4" });
    const spy = stubFetch({ [HONO_URL]: INDEX, "https://hono.dev/docs/routing.md": "# Routing" });
    const report = await runWarm(registry(), { dir: project });
    expect(byName(report).hono).toMatchObject({ status: "cached", url: HONO_URL });
    expect(spy.mock.calls.map((c) => String(c[0]))).toEqual([HONO_URL]);
    expect(readCache("hono", HONO_URL, 168)?.content).toBe(INDEX);
  });

  it("R3: a name the project record shows `unresolved` within the last 24 h is `unresolved (recent)` and spends no resolution slot; --force retries; after 24 h it retries", async () => {
    writePackageJson({ "zz-nothing": "1" });
    const spy = stubFetch({});
    let t = Date.parse("2026-09-06T10:00:00Z");
    const now = () => new Date(t);
    const first = await runWarm(registry(), { dir: project, now });
    expect(byName(first)["zz-nothing"]).toMatchObject({ status: "unresolved", failedAt: "2026-09-06T10:00:00.000Z" });
    expect(spy).toHaveBeenCalledTimes(1); // npm metadata only (package.json → npm)
    spy.mockClear();
    t += 3 * 3600_000;
    const second = await runWarm(registry(), { dir: project, now });
    const row = byName(second)["zz-nothing"];
    expect(row.status).toBe("unresolved (recent)");
    expect(row.failedAt).toBe("2026-09-06T10:00:00.000Z");
    expect(row.note).toMatch(/^unresolved 3\.0 h ago \(npm: no metadata \(404 or unreachable\).*\); retried after 24 h, or now with --force$/);
    expect(spy).not.toHaveBeenCalled();
    expect(warmExitCode(second)).toBe(1);
    // The rewritten record keeps the ORIGINAL failure time, so the window does not slide with every run.
    expect(readProjectRecord(project)?.dependencies[0].failedAt).toBe("2026-09-06T10:00:00.000Z");
    const forced = await runWarm(registry(), { dir: project, now, force: true });
    expect(byName(forced)["zz-nothing"].status).toBe("unresolved");
    expect(byName(forced)["zz-nothing"].failedAt).toBe(new Date(t).toISOString());
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockClear();
    t += 25 * 3600_000;
    const later = await runWarm(registry(), { dir: project, now });
    expect(byName(later)["zz-nothing"].status).toBe("unresolved");
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("R3: the memo is per ecosystem+name and never applies to names that later resolve or become curated", async () => {
    writePackageJson({ elysia: "1" });
    let t = Date.parse("2026-09-06T10:00:00Z");
    const now = () => new Date(t);
    stubFetch({});
    expect(byName(await runWarm(registry(), { dir: project, now })).elysia.status).toBe("unresolved");
    t += 3600_000;
    // Now the package resolves (published metadata): the memo still holds for 24 h — until --force.
    stubFetch({
      "https://registry.npmjs.org/elysia/latest": { homepage: "https://elysiajs.com", repository: "https://github.com/elysiajs/elysia" },
      "https://raw.githubusercontent.com/elysiajs/elysia/HEAD/README.md": "# Elysia",
    });
    expect(byName(await runWarm(registry(), { dir: project, now })).elysia.status).toBe("unresolved (recent)");
    expect(byName(await runWarm(registry(), { dir: project, now, force: true })).elysia.status).toBe("resolved+cached");
    // A curated entry for the name is never memoised away.
    const reg: Registry = { entries: new Map([["elysia", { name: "elysia", urls: ["https://elysiajs.com/llms.txt"] }]]) };
    stubFetch({ "https://elysiajs.com/llms.txt": "# Elysia" });
    expect(byName(await runWarm(reg, { dir: project, now })).elysia.status).toBe("cached");
  });

  it("R1 / D-11: a manifest whose ecosystem differs from the entry's evident ecosystem gets a note; same ecosystem gets none", async () => {
    writeFileSync(join(project, "pyproject.toml"), '[project]\ndependencies = ["stripe", "httpx"]\n', "utf8");
    writeFileSync(join(project, "package.json"), JSON.stringify({ dependencies: { stripe: "16", httpx: "1" } }), "utf8");
    const reg = loadRegistry(undefined, { includeResolved: false });
    reg.entries.set("httpx", {
      name: "httpx",
      urls: ["https://www.python-httpx.org/llms.txt"],
      resolved: { source: "pypi", resolvedAt: "2026-09-06T00:00:00.000Z", metadataUrl: "https://pypi.org/pypi/httpx/json" },
    });
    writeCache("stripe", "https://docs.stripe.com/llms-full.txt", "# Stripe");
    writeCache("httpx", "https://www.python-httpx.org/llms.txt", "# HTTPX");
    const report = await runWarm(reg, { dir: project, offline: true });
    const rows = report.dependencies;
    const find = (name: string, eco: string) => rows.find((r) => r.name === name && r.ecosystem === eco)!;
    expect(find("stripe", "npm").note).toBeUndefined();
    expect(find("stripe", "pypi")).toMatchObject({ library: "stripe", status: "already fresh", note: "curated entry is the npm package" });
    expect(find("httpx", "pypi").note).toBeUndefined();
    expect(find("httpx", "npm")).toMatchObject({ library: "httpx", status: "already fresh", note: "resolved entry is the pypi package (resolve it again with --npm to switch)" });
    // A config entry has no evident ecosystem: no note either way.
    const cfg: Registry = { entries: new Map([["stripe", { name: "stripe", urls: ["https://docs.stripe.com/llms-full.txt"] }]]) };
    const cfgReport = await runWarm(cfg, { dir: project, offline: true });
    expect(cfgReport.dependencies.filter((r) => r.name === "stripe").every((r) => r.note === undefined)).toBe(true);
  });

  it("Q-3 / S3: ESC, C1, bidi and zero-width characters reach neither the table, nor the tool text, nor the --json report", async () => {
    // Everything cleanText strips, minus the newline the renderers legitimately join lines with.
    const CONTROLS = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/;
    const HOSTILE = "boom\u001b[31mx\u009f\u202ey\u200bz";
    const CLEAN = "boom[31mxyz";
    // Route 1: a seeded project record — the R3 memo copies the previous run's note into this run's row.
    writePackageJson({ "zz-nothing": "1" });
    mkdirSync(join(cache, "projects"), { recursive: true });
    writeFileSync(
      projectRecordPath(project),
      JSON.stringify({
        schemaVersion: PROJECT_RECORD_SCHEMA_VERSION,
        dir: project,
        manifests: ["package.json"],
        dependencies: [{ name: "zz-nothing", ecosystem: "npm", source: "package.json", status: "unresolved", note: HOSTILE, failedAt: "2026-09-06T10:00:00.000Z" }],
        warmedAt: "2026-09-06T10:00:00.000Z",
      }),
      "utf8",
    );
    // Route 2: a manifest FILE NAME carrying the same characters — it becomes a `source` and a manifest entry.
    writeFileSync(join(project, "requirements-\u001b[31mred\u200b.txt"), "flask\n", "utf8");
    stubFetch({});
    const report = await runWarm(registry(), { dir: project, now: () => new Date("2026-09-06T13:00:00Z") });

    const memo = report.dependencies.find((d) => d.name === "zz-nothing")!;
    expect(memo.status).toBe("unresolved (recent)");
    expect(memo.note).toContain(CLEAN); // cleaned, not dropped
    expect(report.manifests).toContain("requirements-[31mred.txt");

    const table = formatWarmTable(report);
    expect(table).toContain(CLEAN);
    expect(CONTROLS.test(table)).toBe(false);

    const cwd = vi.spyOn(process, "cwd").mockReturnValue(project);
    try {
      const tool = await warmToolText(registry(), project);
      expect(CONTROLS.test(tool)).toBe(false);
      expect(tool).toContain(CLEAN);
    } finally {
      cwd.mockRestore();
    }

    // --json has no renderer to clean it, so the rows themselves must already be clean.
    const json = JSON.stringify(report, null, 2);
    expect(CONTROLS.test(json)).toBe(false); // bidi / zero-width survive JSON.stringify unescaped
    expect(json).not.toMatch(/\\u00(1b|9f)/); // a control character would appear escaped
    expect(json).toContain(CLEAN);
    expect(json).toContain("requirements-[31mred.txt");
  });

  it("N-4: evidentEcosystem's array-identity contract — a shipped default (and its D-06 alias-trimmed copy) keeps DEFAULT_REGISTRY's `urls` array; a config entry brings its own", () => {
    // evidentEcosystem calls a registry entry "the npm package by the NAMING RULE" only when
    // its `urls` array IS a DEFAULT_REGISTRY entry's array (===, not deep equality). Two things
    // must therefore stay true, and nothing else in the suite pins them:
    //   1. loadRegistry copies default entries with a spread, so `urls` is shared, not cloned;
    //   2. a config entry overriding a default name replaces `urls` with its own array.
    // Break either and warm silently stops emitting (or starts wrongly emitting) the D-11 note.
    const byUrls = new Map(DEFAULT_REGISTRY.map((d) => [d.name, d.urls]));
    const plain = loadRegistry(undefined, { includeResolved: false });
    for (const d of DEFAULT_REGISTRY) expect(plain.entries.get(d.name)?.urls, d.name).toBe(byUrls.get(d.name));

    // D-06: a config entry claiming a DEFAULT alias makes loadRegistry rewrite that default's
    // `aliases`; the copy must still share the same `urls` array.
    const cfg = join(project, "vibectx.config.json");
    writeFileSync(cfg, JSON.stringify({ libraries: [{ name: "next", urls: ["https://example.com/llms.txt"] }] }), "utf8");
    const trimmed = loadRegistry(cfg, { includeResolved: false });
    expect(trimmed.entries.get("next.js")?.aliases).not.toContain("next");
    expect(trimmed.entries.get("next.js")?.urls).toBe(byUrls.get("next.js"));

    // A config entry overriding a default BY NAME brings its own urls: no evident ecosystem.
    writeFileSync(cfg, JSON.stringify({ libraries: [{ name: "next.js", urls: ["https://example.com/llms.txt"] }] }), "utf8");
    expect(loadRegistry(cfg, { includeResolved: false }).entries.get("next.js")?.urls).not.toBe(byUrls.get("next.js"));
  });

  it("D-10: warmToolText (the MCP tool) accepts only the server's working directory or a directory beneath it", async () => {
    writePackageJson({ react: "19" });
    writeCache("react", REACT_URL, "# React fresh");
    stubFetch({});
    const cwd = vi.spyOn(process, "cwd").mockReturnValue(project);
    try {
      expect(await warmToolText(registry())).toContain("1/1 dependencies cached");
      expect(await warmToolText(registry(), project)).toContain("1/1 dependencies cached");
      expect(await warmToolText(registry(), join(project, "sub", ".."))).toContain("1/1 dependencies cached");
      expect(await warmToolText(registry(), join(project, "nope"))).toMatch(/is not a directory$/); // beneath cwd: allowed, then fails honestly
      expect(await warmToolText(registry(), cache)).toBe(`${cache} is outside the project directory (${project}); warm_project only reads the server's working directory or a directory beneath it`);
      expect(await warmToolText(registry(), join(project, ".."))).toMatch(/is outside the project directory/);
      expect(await warmToolText(registry(), "/")).toMatch(/is outside the project directory/);
    } finally {
      cwd.mockRestore();
    }
  });

  describe("S-A / D-10 amended: containment is decided on REAL paths", () => {
    const CANARY = "zz-canary-outside-cwd";
    let outside: string;
    beforeEach(() => {
      outside = mkdtempSync(join(tmpdir(), "vibectx-outside-cwd-"));
      writeFileSync(join(outside, "package.json"), JSON.stringify({ dependencies: { [CANARY]: "1" } }), "utf8");
    });
    afterEach(() => {
      rmSync(outside, { recursive: true, force: true });
    });

    it("a symlinked subdirectory of cwd whose target is outside is refused, and nothing in it is read", async () => {
      writePackageJson({ react: "19" });
      symlinkSync(outside, join(project, "link"));
      const spy = stubFetch({});
      const cwd = vi.spyOn(process, "cwd").mockReturnValue(project);
      try {
        const text = await warmToolText(registry(), join(project, "link"));
        expect(text).toMatch(/is outside the project directory/);
        expect(text).not.toContain(CANARY);
      } finally {
        cwd.mockRestore();
      }
      expect(spy).not.toHaveBeenCalled();
    });

    it("S-A: a NON-EXISTENT path under a symlinked subdirectory is refused on the real path, and discovery never runs", async () => {
      writePackageJson({ react: "19" });
      symlinkSync(outside, join(project, "link"));
      // runWarm's very first act is to sweep the cache's orphan temp files. A planted orphan
      // surviving MEASURES that warmToolText refused at the containment gate — before runWarm,
      // and so before discovery, ever started.
      const sentinel = join(cache, "resolved.json.4242.1757000000000.tmp");
      writeFileSync(sentinel, "{}", "utf8");
      const spy = stubFetch({});
      const cwd = vi.spyOn(process, "cwd").mockReturnValue(project);
      try {
        const target = join(project, "link", "nope");
        expect(existsSync(target)).toBe(false); // the target does not exist, on either side of the link
        const text = await warmToolText(registry(), target);
        expect(text).toMatch(/is outside the project directory/);
        expect(text).not.toMatch(/is not a directory/); // NOT discovery's error: the gate refused first
        expect(existsSync(sentinel)).toBe(true); // measured: runWarm never started
        expect(spy).not.toHaveBeenCalled();
        // The manifest that path WOULD have discovered, planted only now — after the check —
        // so it can only appear in a later, wrongly-allowed read.
        mkdirSync(join(outside, "nope"));
        writeFileSync(join(outside, "nope", "package.json"), JSON.stringify({ dependencies: { [CANARY]: "1" } }), "utf8");
        expect(text).not.toContain(CANARY);
        expect(await warmToolText(registry(), target)).not.toContain(CANARY); // still refused now that it exists

        // A non-existent path under a REAL subdirectory of cwd is still allowed through to
        // discovery's honest "not a directory" — the nearest existing ancestor is inside cwd.
        mkdirSync(join(project, "sub"));
        expect(await warmToolText(registry(), join(project, "sub", "nope"))).toMatch(/is not a directory$/);
      } finally {
        cwd.mockRestore();
      }
    });

    it("a sibling directory whose path shares cwd's prefix is refused", async () => {
      const sibling = `${realpathSync(project)}-evil`;
      mkdirSync(sibling);
      try {
        const cwd = vi.spyOn(process, "cwd").mockReturnValue(project);
        try {
          expect(await warmToolText(registry(), sibling)).toMatch(/is outside the project directory/);
        } finally {
          cwd.mockRestore();
        }
      } finally {
        rmSync(sibling, { recursive: true, force: true });
      }
    });

    it("a real subdirectory of cwd is still allowed, and a cwd that is itself a symlink still allows its real subdirectories", async () => {
      mkdirSync(join(project, "app"));
      writeFileSync(join(project, "app", "package.json"), JSON.stringify({ dependencies: { react: "19" } }), "utf8");
      writeCache("react", REACT_URL, "# React fresh");
      stubFetch({});
      const direct = vi.spyOn(process, "cwd").mockReturnValue(project);
      try {
        expect(await warmToolText(registry(), join(project, "app"))).toContain("1/1 dependencies cached");
      } finally {
        direct.mockRestore();
      }
      // cwd reached through a symlink: realpath(cwd) is the real project, realpath(target) beneath it.
      const linkedCwd = join(outside, "proj-link");
      symlinkSync(project, linkedCwd);
      const linked = vi.spyOn(process, "cwd").mockReturnValue(linkedCwd);
      try {
        expect(await warmToolText(registry(), join(linkedCwd, "app"))).toContain("1/1 dependencies cached");
      } finally {
        linked.mockRestore();
      }
    });
  });
});

/**
 * PAR-659 · D-34 — "autowarm/warm should leave a usable index behind". The point is not that a
 * file appears: it is that the FIRST `search` after a warm is already the fast path, so a vibe
 * coder who runs `vibectx warm` and immediately asks a question does not pay for tokenizing
 * their whole stack.
 */
describe("warm leaves a usable cross-library search index behind (PAR-659, D-34)", () => {
  it("indexes each dependency's primary document, fetched or already fresh", async () => {
    writeCache("react", REACT_URL, "# React\n\n## Effects\n\nuseEffect cleanup runs on unmount.");
    writePackageJson({ react: "19", hono: "4" });
    stubFetch({ [HONO_URL]: "# Hono\n\n## Streaming\n\nstreamSSE sends server-sent events." });

    const report = await runWarm(registry(), { dir: project });
    expect(byName(report).react.status).toBe("already fresh");
    expect(byName(report).hono.status).toBe("cached");

    const index = readIndex().libraries;
    expect([...index.keys()].sort()).toEqual(["hono", "react"]);
    expect(index.get("hono")!.hash).toBe(documentHash("# Hono\n\n## Streaming\n\nstreamSSE sends server-sent events."));
    expect(index.get("hono")!.url).toBe(HONO_URL);
  });

  it("the first search after a warm tokenizes nothing", async () => {
    writePackageJson({ react: "19", hono: "4" });
    stubFetch({
      [REACT_URL]: "# React\n\n## Effects\n\nuseEffect cleanup runs on unmount.",
      [HONO_URL]: "# Hono\n\n## Streaming\n\nstreamSSE sends server-sent events to the client.",
    });
    await runWarm(registry(), { dir: project });

    const out = runSearch(registry(), { query: "server-sent events" });
    expect(out.tokenized).toBe(0);
    expect(out.fromIndex).toBe(2);
    expect(out.groups[0].library).toBe("hono");
  });

  it("PAR-659 R1: a NEWLY RESOLVED library is indexed too — the branch the caller-side hook missed", async () => {
    // `warm`'s `resolved+cached` branch never reached `indexWarmed`: the document was fetched
    // inside `resolvePackage`, so the library was cached and UNINDEXED, and every search until
    // the next warm re-tokenized it. The hook now sits at that single writer instead.
    writePackageJson({ elysia: "1" });
    stubFetch({
      "https://registry.npmjs.org/elysia/latest": { homepage: "https://elysiajs.com", repository: "https://github.com/elysiajs/elysia" },
      "https://raw.githubusercontent.com/elysiajs/elysia/HEAD/README.md": "# Elysia\n\n## Streaming\n\nStream server-sent events to the client.",
    });
    const reg = registry();
    expect(byName(await runWarm(reg, { dir: project })).elysia.status).toBe("resolved+cached");
    expect(readIndex().libraries.has("elysia")).toBe(true);

    resetSearchIndexMemo(); // a new process, so only what is ON DISK can help
    const out = runSearch(reg, { query: "server-sent events streaming" });
    expect(out.tokenized).toBe(0);
    expect(out.groups[0].library).toBe("elysia");
  });

  it("an offline warm indexes what the cache already holds", async () => {
    writeCache("hono", HONO_URL, "# Hono\n\n## Streaming\n\nstreamSSE sends server-sent events.");
    writePackageJson({ hono: "4" });
    stubFetch({});
    await runWarm(registry(), { dir: project, offline: true });
    expect([...readIndex().libraries.keys()]).toEqual(["hono"]);
  });
});
