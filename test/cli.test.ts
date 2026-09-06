import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeCache } from "../src/cache.js";
import { DEFAULT_REGISTRY, loadDiscoveredRegistry } from "../src/registry.js";
import { listLibrariesText } from "../src/list-libraries.js";
import { parseDoctorArgs, parseResolveArgs, parseSearchArgs, dispatchCli, RESOLVE_USAGE, SEARCH_USAGE, type CliIo } from "../src/cli.js";
import { resetSearchIndexMemo } from "../src/search-index.js";
import { SEARCH_SCHEMA_VERSION } from "../src/search.js";

let dir: string;
/** A working directory with no `.git` and no config file (Q1). */
let sandbox: string;
const ENV_KEYS = ["HOME", "XDG_CONFIG_HOME", "VIBECTX_CONFIG"] as const;
let previousEnv: Partial<Record<(typeof ENV_KEYS)[number], string>>;

/**
 * Q1 (PAR-657): since config discovery needs no flag, EVERY case in this file would
 * otherwise be at the mercy of the machine it runs on — a developer's own
 * ~/.config/vibectx/config.json, or a vibectx.config.json sitting in the repo root while
 * the suite runs from there. HOME, XDG_CONFIG_HOME and VIBECTX_CONFIG are replaced with
 * empty temp locations and process.cwd() is pointed at a directory with neither `.git`
 * nor a config, so discovery finds nothing unless the test plants it.
 */
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "vibectx-cli-"));
  process.env.DOCS_CACHE_DIR = dir;
  sandbox = join(dir, "sandbox");
  mkdirSync(sandbox, { recursive: true });
  previousEnv = {};
  for (const key of ENV_KEYS) {
    previousEnv[key] = process.env[key];
    delete process.env[key];
  }
  process.env.HOME = join(dir, "home");
  process.env.XDG_CONFIG_HOME = join(dir, "xdg");
  vi.spyOn(process, "cwd").mockReturnValue(sandbox);
  resetSearchIndexMemo();
});

afterEach(() => {
  delete process.env.DOCS_CACHE_DIR;
  for (const key of ENV_KEYS) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

function io(): CliIo & { out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, stdout: (s) => out.push(s), stderr: (s) => err.push(s) };
}

const REACT_URL = "https://react.dev/llms-full.txt";
const REACT_DOC = "# React\n\n## useEffect cleanup\n\nReturn a function from useEffect to run cleanup.";

function writeConfig(libraries: unknown[]): string {
  const path = join(dir, "vibectx.config.json");
  writeFileSync(path, JSON.stringify({ libraries }), "utf8");
  return path;
}

describe("parseDoctorArgs", () => {
  it("defaults to a human table, online, all libraries, no config", () => {
    expect(parseDoctorArgs([])).toEqual({ json: false, offline: false });
  });

  it("parses every documented flag", () => {
    expect(parseDoctorArgs(["--json", "--library", "react", "--config", "c.json", "--offline"])).toEqual({
      json: true,
      offline: true,
      library: "react",
      config: "c.json",
    });
  });

  it("rejects unknown flags and flags missing their value", () => {
    expect(() => parseDoctorArgs(["--bogus"])).toThrow(/Unknown option "--bogus"/);
    expect(() => parseDoctorArgs(["--library"])).toThrow(/--library requires a value/);
    expect(() => parseDoctorArgs(["--config", "--json"])).toThrow(/--config requires a value/);
    expect(() => parseDoctorArgs(["extra"])).toThrow(/Unexpected argument "extra"/);
  });
});

describe("dispatchCli", () => {
  it("returns undefined (start the MCP server) when no subcommand token is present", async () => {
    const spy = vi.fn();
    vi.stubGlobal("fetch", spy);
    const a = io();
    expect(await dispatchCli(["node", "dist/index.js"], a)).toBeUndefined();
    expect(await dispatchCli(["node", "dist/index.js", "--config", "x.json"], a)).toBeUndefined();
    expect(a.out).toEqual([]);
    expect(a.err).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
  });

  it("accepts --config <path> before the doctor token (the README's leading position)", async () => {
    writeCache("react", REACT_URL, REACT_DOC);
    const config = writeConfig([{ name: "react", urls: [REACT_URL], probeQueries: ["useEffect cleanup"] }]);
    const a = io();
    const code = await dispatchCli(
      ["node", "dist/index.js", "--config", config, "doctor", "--library", "react", "--offline"],
      a,
    );
    expect(code).toBe(0);
    expect(a.out.join("")).toContain("1/1 libraries healthy");
    expect(a.err).toEqual([]);
  });

  it("a missing config before the doctor token is the doctor's exit 2, not a server-path crash", async () => {
    const a = io();
    const code = await dispatchCli(["node", "dist/index.js", "--config", "/nonexistent.json", "doctor"], a);
    expect(code).toBe(2);
    expect(a.err.join("")).toMatch(/^\/nonexistent\.json: not found$/m);
  });

  it("does not mistake a --library or --config VALUE named 'doctor' for the subcommand", async () => {
    const a = io();
    expect(await dispatchCli(["node", "dist/index.js", "--config", "doctor"], a)).toBeUndefined();
    expect(await dispatchCli(["node", "dist/index.js", "doctor", "--library", "doctor", "--offline"], a)).toBe(2);
    expect(a.err.join("")).toMatch(/Unknown library "doctor"/);
  });

  it("doctor --offline --json on the default registry with an empty cache: every library unreachable, exit 1, no fetch", async () => {
    const spy = vi.fn();
    vi.stubGlobal("fetch", spy);
    const a = io();
    const code = await dispatchCli(["node", "dist/index.js", "doctor", "--offline", "--json"], a);
    expect(code).toBe(1);
    expect(spy).not.toHaveBeenCalled();
    const report = JSON.parse(a.out.join(""));
    expect(Object.keys(report)).toEqual(["schemaVersion", "generatedAt", "libraries", "healthy", "total", "configIssues"]);
    expect(report.configIssues).toEqual([]);
    expect(report.schemaVersion).toBe(1);
    expect(report.total).toBe(DEFAULT_REGISTRY.length);
    expect(report.total).toBe(30); // PAR-654: the vibe-coder top-30
    expect(report.healthy).toBe(0);
    expect(report.libraries.every((l: { kind: string }) => l.kind === "unreachable")).toBe(true);
    expect(report.libraries.map((l: { library: string }) => l.library)).toEqual(DEFAULT_REGISTRY.map((e) => e.name));
  });

  it("doctor --config --library --offline with a seeded cache prints the table and exits 0", async () => {
    writeCache("react", REACT_URL, REACT_DOC);
    const config = writeConfig([{ name: "react", urls: [REACT_URL], probeQueries: ["useEffect cleanup"] }]);
    const a = io();
    const code = await dispatchCli(
      ["node", "dist/index.js", "doctor", "--config", config, "--library", "react", "--offline"],
      a,
    );
    expect(code).toBe(0);
    const text = a.out.join("");
    expect(text).toMatch(/^vibectx doctor/);
    expect(text).toMatch(/react\s+full-text\s+0\.0h\s+"useEffect cleanup" → answered\s+0\/0\s+✓/);
    expect(text).toContain("1/1 libraries healthy");
    expect(a.err).toEqual([]);
  });

  it("exits 2 with usage on a bad flag", async () => {
    const a = io();
    expect(await dispatchCli(["node", "dist/index.js", "doctor", "--bogus"], a)).toBe(2);
    expect(a.err.join("")).toMatch(/Unknown option "--bogus"/);
    expect(a.err.join("")).toMatch(/usage: vibectx doctor \[--json\] \[--library <name>\] \[--config <path>\] \[--offline\]/);
  });

  it("--library accepts an alias and reports the canonical row (PAR-654)", async () => {
    writeCache("react", REACT_URL, REACT_DOC);
    const config = writeConfig([{ name: "react", urls: [REACT_URL], aliases: ["reactjs"], probeQueries: ["useEffect cleanup"] }]);
    const a = io();
    const code = await dispatchCli(
      ["node", "dist/index.js", "doctor", "--config", config, "--library", "reactjs", "--offline"],
      a,
    );
    expect(code).toBe(0);
    expect(a.out.join("")).toMatch(/\nreact\s+full-text/);
    expect(a.out.join("")).toContain("1/1 libraries healthy");
  });

  it("exits 2 when the config declares an alias that collides with a canonical name", async () => {
    const a = io();
    const bad = writeConfig([{ name: "x", urls: ["https://x.example/llms.txt"], aliases: ["react"] }]);
    expect(await dispatchCli(["node", "dist/index.js", "doctor", "--config", bad, "--offline"], a)).toBe(2);
    expect(a.err.join("")).toMatch(/^.*vibectx\.config\.json: libraries\[0\]\.aliases \("x"\): alias "react" collides/m);
  });

  it("exits 2 on an unknown library", async () => {
    const a = io();
    expect(await dispatchCli(["node", "dist/index.js", "doctor", "--library", "nope", "--offline"], a)).toBe(2);
    expect(a.err.join("")).toMatch(/Unknown library "nope"/);
  });

  it("exits 2 when the config cannot be loaded", async () => {
    const a = io();
    const missing = join(dir, "missing.json");
    expect(await dispatchCli(["node", "dist/index.js", "doctor", "--config", missing, "--offline"], a)).toBe(2);
    expect(a.err.join("")).toMatch(/missing\.json: not found/);
    const bad = writeConfig([{ name: "x", urls: ["https://x.example/llms.txt"], probeQueries: [""] }]);
    expect(await dispatchCli(["node", "dist/index.js", "doctor", "--config", bad, "--offline"], a)).toBe(2);
    expect(a.err.join("")).toMatch(/probeQueries/);
  });
});

function stubFetch(routes: Record<string, string>) {
  const spy = vi.fn(async (url: unknown) => {
    const body = routes[String(url)];
    if (body === undefined) return new Response("not found", { status: 404 });
    const json = body.startsWith("{");
    return new Response(body, { status: 200, headers: { "content-type": json ? "application/json" : "text/plain" } });
  });
  vi.stubGlobal("fetch", spy);
  return spy;
}

describe("parseResolveArgs (PAR-655)", () => {
  it("takes one positional name plus optional --npm / --pypi / --config", () => {
    expect(parseResolveArgs(["hono"])).toEqual({ name: "hono" });
    expect(parseResolveArgs(["httpx", "--pypi"])).toEqual({ name: "httpx", ecosystem: "pypi" });
    expect(parseResolveArgs(["--npm", "httpx", "--config", "c.json"])).toEqual({ name: "httpx", ecosystem: "npm", config: "c.json" });
  });

  it("rejects a missing name, two names, both ecosystems, unknown flags and a flag missing its value", () => {
    expect(() => parseResolveArgs([])).toThrow(/resolve requires a package name/);
    expect(() => parseResolveArgs(["a", "b"])).toThrow(/Unexpected argument "b"/);
    expect(() => parseResolveArgs(["a", "--npm", "--pypi"])).toThrow(/--npm and --pypi are mutually exclusive/);
    expect(() => parseResolveArgs(["a", "--bogus"])).toThrow(/Unknown option "--bogus"/);
    expect(() => parseResolveArgs(["a", "--config"])).toThrow(/--config requires a value/);
  });
});

describe("dispatchCli resolve (PAR-655)", () => {
  it("resolves a name, prints the report on stdout and exits 0", async () => {
    stubFetch({
      "https://registry.npmjs.org/elysia/latest": JSON.stringify({ homepage: "https://elysiajs.com", repository: "https://github.com/elysiajs/elysia" }),
      "https://raw.githubusercontent.com/elysiajs/elysia/HEAD/README.md": "# Elysia",
    });
    const a = io();
    expect(await dispatchCli(["node", "dist/index.js", "resolve", "elysia"], a)).toBe(0);
    const text = a.out.join("");
    expect(text).toMatch(/^Resolved "elysia" via npm/);
    expect(text).toContain("chosen: https://raw.githubusercontent.com/elysiajs/elysia/HEAD/README.md (readme, 8 chars)");
    expect(a.err).toEqual([]);
    expect(JSON.parse(readFileSync(join(dir, "resolved.json"), "utf8")).entries[0].name).toBe("elysia");
  });

  it("a name the registry already knows is reported without fetching, exit 0", async () => {
    const spy = stubFetch({});
    const a = io();
    expect(await dispatchCli(["node", "dist/index.js", "resolve", "next"], a)).toBe(0);
    expect(a.out.join("")).toContain('"next" is already in the registry as "next.js"');
    expect(spy).not.toHaveBeenCalled();
  });

  it("an unresolvable name prints the could-not-resolve line on stdout and exits 1", async () => {
    stubFetch({});
    const a = io();
    expect(await dispatchCli(["node", "dist/index.js", "resolve", "zz-nothing"], a)).toBe(1);
    expect(a.out.join("")).toMatch(/^Could not resolve "zz-nothing": npm: no metadata/);
  });

  it("--pypi forces PyPI; --config loads the config first", async () => {
    const spy = stubFetch({
      "https://pypi.org/pypi/httpx/json": JSON.stringify({ info: { project_urls: { Documentation: "https://www.python-httpx.org" } } }),
      "https://www.python-httpx.org/llms.txt": "# HTTPX",
    });
    const config = writeConfig([{ name: "react", urls: [REACT_URL] }]);
    const a = io();
    expect(await dispatchCli(["node", "dist/index.js", "--config", config, "resolve", "httpx", "--pypi"], a)).toBe(0);
    expect(a.out.join("")).toMatch(/^Resolved "httpx" via PyPI/);
    expect(spy.mock.calls.map((c) => String(c[0]))).not.toContain("https://registry.npmjs.org/httpx/latest");
  });

  it("exits 2 with usage on a bad flag or missing name, and on a bad config", async () => {
    const a = io();
    expect(await dispatchCli(["node", "dist/index.js", "resolve"], a)).toBe(2);
    expect(a.err.join("")).toContain(RESOLVE_USAGE);
    expect(await dispatchCli(["node", "dist/index.js", "resolve", "x", "--bogus"], a)).toBe(2);
    expect(await dispatchCli(["node", "dist/index.js", "resolve", "x", "--config", "/nonexistent.json"], a)).toBe(2);
    expect(a.err.join("")).toMatch(/^\/nonexistent\.json: not found$/m);
  });

  it("does not mistake a --library / --config VALUE named 'resolve' for the subcommand, and a package named 'doctor' can be resolved", async () => {
    const a = io();
    expect(await dispatchCli(["node", "dist/index.js", "--config", "resolve"], a)).toBeUndefined();
    const spy = stubFetch({});
    expect(await dispatchCli(["node", "dist/index.js", "resolve", "doctor"], a)).toBe(1);
    expect(a.out.join("")).toMatch(/^Could not resolve "doctor"/);
    expect(spy).toHaveBeenCalledTimes(2);
  });
});

import { parseWarmArgs, WARM_USAGE } from "../src/cli.js";
import { existsSync } from "node:fs";
import { mkdtempSync as mkdtemp2 } from "node:fs";
import { projectRecordPath, PROJECT_RECORD_SCHEMA_VERSION } from "../src/project-store.js";

describe("parseWarmArgs (PAR-656)", () => {
  it("takes an optional directory plus --offline / --json / --config", () => {
    expect(parseWarmArgs([])).toEqual({ json: false, offline: false });
    expect(parseWarmArgs(["./app"])).toEqual({ json: false, offline: false, dir: "./app" });
    expect(parseWarmArgs(["--offline", "--json", "--config", "c.json", "/p"])).toEqual({ json: true, offline: true, config: "c.json", dir: "/p" });
  });

  it("rejects two directories, unknown flags and a flag missing its value", () => {
    expect(() => parseWarmArgs(["a", "b"])).toThrow(/Unexpected argument "b"/);
    expect(() => parseWarmArgs(["--bogus"])).toThrow(/Unknown option "--bogus"/);
    expect(() => parseWarmArgs(["--config"])).toThrow(/--config requires a value/);
    expect(() => parseWarmArgs(["--library", "x"])).toThrow(/Unknown option "--library"/);
  });
});

describe("dispatchCli warm (PAR-656)", () => {
  let project: string;
  beforeEach(() => {
    project = mkdtemp2(join(tmpdir(), "vibectx-cli-proj-"));
  });
  afterEach(() => {
    rmSync(project, { recursive: true, force: true });
  });

  it("warms a directory: table on stdout, exit 0 when everything is cached, record written", async () => {
    writeFileSync(join(project, "package.json"), JSON.stringify({ dependencies: { react: "19" }, devDependencies: { eslint: "9" } }), "utf8");
    const config = writeConfig([{ name: "react", urls: [REACT_URL] }]);
    stubFetch({ [REACT_URL]: REACT_DOC });
    const a = io();
    expect(await dispatchCli(["node", "dist/index.js", "warm", project, "--config", config], a)).toBe(0);
    const text = a.out.join("");
    expect(text).toMatch(/^vibectx warm · /);
    expect(text).toMatch(/\nreact\s+react\s+cached\s+https:\/\/react\.dev\/llms-full\.txt\n/);
    expect(text).toContain("1/1 dependencies cached · 1 denied (noise list)");
    expect(a.err).toEqual([]);
    expect(existsSync(join(dir, "projects"))).toBe(true);
  });

  it("--json emits schemaVersion 1 first; --offline never fetches; exit 1 when something is not cached", async () => {
    writeFileSync(join(project, "package.json"), JSON.stringify({ dependencies: { react: "19", hono: "4" } }), "utf8");
    writeCache("react", REACT_URL, REACT_DOC);
    const spy = stubFetch({});
    const a = io();
    expect(await dispatchCli(["node", "dist/index.js", "warm", "--offline", "--json", project], a)).toBe(1);
    expect(spy).not.toHaveBeenCalled();
    const report = JSON.parse(a.out.join(""));
    expect(Object.keys(report).slice(0, 4)).toEqual(["schemaVersion", "generatedAt", "dir", "offline"]);
    expect(report.schemaVersion).toBe(1);
    expect(report.offline).toBe(true);
    expect(report.dependencies.map((d: { name: string; status: string }) => [d.name, d.status])).toEqual([
      ["react", "already fresh"],
      ["hono", "unreachable"],
    ]);
  });

  it("--json carries the note when a newer schema on disk owns the project record", async () => {
    writeFileSync(join(project, "package.json"), JSON.stringify({ dependencies: { react: "19" } }), "utf8");
    writeCache("react", REACT_URL, REACT_DOC);
    mkdirSync(join(dir, "projects"), { recursive: true });
    writeFileSync(projectRecordPath(project), JSON.stringify({ schemaVersion: PROJECT_RECORD_SCHEMA_VERSION + 1, dir: project }), "utf8");
    stubFetch({});
    const a = io();
    expect(await dispatchCli(["node", "dist/index.js", "warm", project, "--json"], a)).toBe(0);
    const report = JSON.parse(a.out.join(""));
    expect(report.notes).toContain("project record not written: newer schema on disk");
    expect(a.err.join("")).toMatch(/newer schemaVersion 2/);
  });

  it("defaults the directory to the working directory", async () => {
    const cwd = vi.spyOn(process, "cwd").mockReturnValue(project);
    try {
      writeFileSync(join(project, "package.json"), JSON.stringify({ dependencies: { react: "19" } }), "utf8");
      writeCache("react", REACT_URL, REACT_DOC);
      stubFetch({});
      const a = io();
      expect(await dispatchCli(["node", "dist/index.js", "warm", "--offline"], a)).toBe(0);
      expect(a.out.join("")).toContain(`vibectx warm · ${project}`);
    } finally {
      cwd.mockRestore();
    }
  });

  it("exits 2 with usage on a bad flag, on a missing manifest, on a non-directory, and on a bad config", async () => {
    const a = io();
    expect(await dispatchCli(["node", "dist/index.js", "warm", "--bogus"], a)).toBe(2);
    expect(a.err.join("")).toContain(WARM_USAGE);
    expect(await dispatchCli(["node", "dist/index.js", "warm", project], a)).toBe(2);
    expect(a.err.join("")).toMatch(/no dependency manifest in /);
    expect(await dispatchCli(["node", "dist/index.js", "warm", join(project, "nope")], a)).toBe(2);
    expect(a.err.join("")).toMatch(/is not a directory/);
    expect(await dispatchCli(["node", "dist/index.js", "warm", project, "--config", "/nonexistent.json"], a)).toBe(2);
    expect(a.err.join("")).toMatch(/^\/nonexistent\.json: not found$/m);
    expect(a.out).toEqual([]);
  });

  it("the first subcommand token wins: `warm doctor` warms a directory named doctor; `doctor --library warm` is a doctor run; a --config VALUE named warm is not a subcommand", async () => {
    const a = io();
    expect(await dispatchCli(["node", "dist/index.js", "warm", "doctor"], a)).toBe(2);
    expect(a.err.join("")).toMatch(/doctor is not a directory/);
    expect(await dispatchCli(["node", "dist/index.js", "doctor", "--library", "warm", "--offline"], a)).toBe(2);
    expect(a.err.join("")).toMatch(/Unknown library "warm"/);
    expect(await dispatchCli(["node", "dist/index.js", "--config", "warm"], a)).toBeUndefined();
    const spy = stubFetch({});
    expect(await dispatchCli(["node", "dist/index.js", "resolve", "warm"], a)).toBe(1);
    expect(spy).toHaveBeenCalled();
  });
});

describe("warm --force and the JSON row order (PAR-656 R3 / K1)", () => {
  it("parses --force; --json rows keep the documented key order", async () => {
    expect(parseWarmArgs(["--force"])).toEqual({ json: false, offline: false, force: true });
    const project = mkdtemp2(join(tmpdir(), "vibectx-cli-proj-"));
    try {
      writeFileSync(join(project, "package.json"), JSON.stringify({ dependencies: { react: "19", "zz-nothing": "1" } }), "utf8");
      writeCache("react", REACT_URL, REACT_DOC);
      stubFetch({});
      const a = io();
      expect(await dispatchCli(["node", "dist/index.js", "warm", project, "--json", "--force"], a)).toBe(1);
      const report = JSON.parse(a.out.join(""));
      expect(Object.keys(report.dependencies[0])).toEqual(["name", "ecosystem", "source", "library", "status", "url"]);
      expect(Object.keys(report.dependencies[1])).toEqual(["name", "ecosystem", "source", "status", "note", "failedAt"]);
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });
});

describe("CLI config discovery: no flag needed (PAR-657)", () => {
  let repo: string;

  // HOME, XDG_CONFIG_HOME and VIBECTX_CONFIG are already isolated for the whole file (Q1);
  // this block adds the one thing these cases need: a working directory that IS a repo.
  beforeEach(() => {
    repo = join(dir, "repo");
    mkdirSync(join(repo, ".git"), { recursive: true });
    vi.spyOn(process, "cwd").mockReturnValue(repo);
  });

  const commit = (name: string, libraries: unknown[]): string => {
    const path = join(repo, name);
    writeFileSync(path, JSON.stringify({ libraries }), "utf8");
    return path;
  };

  it("doctor picks up a committed vibectx.config.json with no --config", async () => {
    writeCache("acme", "https://docs.acme.example.com/llms-full.txt", REACT_DOC);
    commit("vibectx.config.json", [
      { name: "acme", urls: ["https://docs.acme.example.com/llms-full.txt"], probeQueries: ["useEffect cleanup"] },
    ]);
    const a = io();
    const code = await dispatchCli(["node", "dist/index.js", "doctor", "--library", "acme", "--offline"], a);
    expect(code).toBe(0);
    expect(a.out.join("")).toMatch(/acme\s+full-text/);
  });

  it("VIBECTX_CONFIG is used when there is no flag, and skips the committed file", async () => {
    commit("vibectx.config.json", [{ name: "acme", urls: ["https://docs.acme.example.com/llms-full.txt"] }]);
    const envPath = join(dir, "env.json");
    writeFileSync(envPath, JSON.stringify({ libraries: [{ name: "envonly", urls: ["https://env.example.com/llms.txt"] }] }), "utf8");
    process.env.VIBECTX_CONFIG = envPath;
    const a = io();
    expect(await dispatchCli(["node", "dist/index.js", "doctor", "--json", "--offline"], a)).toBe(1);
    const names = JSON.parse(a.out.join("")).libraries.map((l: { library: string }) => l.library);
    expect(names).toContain("envonly");
    expect(names).not.toContain("acme");
  });

  it("D-19: a broken DISCOVERED file is skipped — doctor still runs, warns once, and is unhealthy", async () => {
    writeCache("react", REACT_URL, REACT_DOC);
    writeFileSync(join(repo, "vibectx.config.json"), '{ "libraries": [{ "name": "a", "urls": [] }] }', "utf8");
    const a = io();
    // Without the broken file this run is exit 0 (one healthy library); the skipped config
    // is what makes it 1 — and the run happens at all, which is the point of D-19.
    expect(await dispatchCli(["node", "dist/index.js", "doctor", "--library", "react", "--offline"], a)).toBe(1);
    const err = a.err.join("");
    expect(err.trim().split("\n")).toHaveLength(1);
    expect(err).toMatch(
      /^vibectx: \.\/vibectx\.config\.json: libraries\[0\]\.urls \("a"\): must be a non-empty array of https URLs — file skipped, continuing without it$/m,
    );
    const out = a.out.join("");
    expect(out).toMatch(/react\s+full-text/); // the run itself is complete
    expect(out).toContain(
      '✗ config ./vibectx.config.json (project): libraries[0].urls ("a"): must be a non-empty array of https URLs — file skipped',
    );
  });

  it("D-19: the same failure through an EXPLICIT --config or VIBECTX_CONFIG stays fatal (exit 2)", async () => {
    const broken = join(dir, "broken.json");
    writeFileSync(broken, '{ "libraries": [{ "name": "a", "urls": [] }] }', "utf8");
    const a = io();
    expect(await dispatchCli(["node", "dist/index.js", "doctor", "--config", broken, "--offline"], a)).toBe(2);
    process.env.VIBECTX_CONFIG = broken;
    expect(await dispatchCli(["node", "dist/index.js", "doctor", "--offline"], a)).toBe(2);
    expect(a.err.join("").trim().split("\n")).toHaveLength(2);
    expect(a.err.join("")).not.toContain("file skipped");
    expect(a.out).toEqual([]);
  });

  it("D-19: a broken discovered file is named NOT LOADED on the list_libraries header", async () => {
    writeFileSync(join(repo, "vibectx.config.json"), "{ oops", "utf8");
    const registry = loadDiscoveredRegistry({ cwd: repo, env: {}, home: join(dir, "home") });
    expect(listLibrariesText(registry, { cwd: repo, home: join(dir, "home") }).split("\n")[0]).toMatch(
      /^config: \.\/vibectx\.config\.json \(project\) — NOT LOADED: invalid JSON/,
    );
  });

  it("warns once on stderr about the deprecated filename, and still loads it", async () => {
    commit("docs-cache.config.json", [{ name: "acme", urls: ["https://docs.acme.example.com/llms-full.txt"] }]);
    const a = io();
    expect(await dispatchCli(["node", "dist/index.js", "doctor", "--json", "--offline"], a)).toBe(1);
    expect(a.err.join("")).toMatch(/docs-cache\.config\.json is deprecated/);
    expect(JSON.parse(a.out.join("")).libraries.map((l: { library: string }) => l.library)).toContain("acme");
  });

  it("warm reads the discovered config too (one resolution path for every subcommand)", async () => {
    writeFileSync(join(repo, "package.json"), JSON.stringify({ dependencies: { acme: "^1.0.0" } }), "utf8");
    writeCache("acme", "https://docs.acme.example.com/llms-full.txt", REACT_DOC);
    commit("vibectx.config.json", [{ name: "acme", urls: ["https://docs.acme.example.com/llms-full.txt"] }]);
    const a = io();
    const code = await dispatchCli(["node", "dist/index.js", "warm", repo, "--offline", "--json"], a);
    const report = JSON.parse(a.out.join(""));
    expect(report.dependencies.find((d: { name: string }) => d.name === "acme")?.library).toBe("acme");
    expect(code).toBe(0);
  });
});

describe("parseSearchArgs (PAR-659)", () => {
  it("takes the query as one quoted argument or as several bare words", () => {
    expect(parseSearchArgs(["server-sent events streaming"])).toEqual({ json: false, query: "server-sent events streaming", libraries: [] });
    expect(parseSearchArgs(["server-sent", "events", "streaming"])).toEqual({ json: false, query: "server-sent events streaming", libraries: [] });
  });

  it("parses every documented flag, --library repeating", () => {
    expect(parseSearchArgs(["streaming", "--library", "hono", "--library", "ai-sdk", "--max-tokens", "800", "--json", "--config", "c.json"])).toEqual({
      json: true,
      query: "streaming",
      libraries: ["hono", "ai-sdk"],
      maxTokens: 800,
      config: "c.json",
    });
  });

  it("rejects an empty query, unknown flags, missing values and a bad --max-tokens", () => {
    expect(() => parseSearchArgs([])).toThrow(/search requires a query/);
    expect(() => parseSearchArgs(["--json"])).toThrow(/search requires a query/);
    expect(() => parseSearchArgs(["x", "--bogus"])).toThrow(/Unknown option "--bogus"/);
    expect(() => parseSearchArgs(["x", "--library"])).toThrow(/--library requires a value/);
    expect(() => parseSearchArgs(["x", "--max-tokens", "zero"])).toThrow(/positive whole number/);
    expect(() => parseSearchArgs(["x", "--max-tokens", "0"])).toThrow(/positive whole number/);
    expect(() => parseSearchArgs(["x", "--max-tokens", "1.5"])).toThrow(/positive whole number/);
  });

  it("a bare word is query text, never a library — only --library names one", () => {
    expect(parseSearchArgs(["hono", "streaming"]).libraries).toEqual([]);
    expect(parseSearchArgs(["hono", "streaming"]).query).toBe("hono streaming");
  });
});

describe("dispatchCli search (PAR-659)", () => {
  const HONO_URL = "https://hono.dev/llms.txt";
  const HONO_DOC = "# Hono\n\n## Streaming responses\n\nUse streamSSE to send server-sent events to the client.";

  function config(): string {
    return writeConfig([
      { name: "hono", urls: [HONO_URL] },
      { name: "react", urls: [REACT_URL] },
    ]);
  }

  it("prints grouped results and exits 0; the network is never touched", async () => {
    writeCache("hono", HONO_URL, HONO_DOC);
    const fetchSpy = vi.fn(() => {
      throw new Error("vibectx search must never fetch");
    });
    vi.stubGlobal("fetch", fetchSpy);
    const o = io();
    const code = await dispatchCli(["node", "vibectx", "search", "server-sent events", "--config", config()], o);
    expect(code).toBe(0);
    expect(o.out.join("")).toContain("# hono");
    expect(o.out.join("")).toContain(`Source: ${HONO_URL}`);
    // The config LAYERS over the shipped defaults, so "configured" counts all of them; one is cached.
    expect(o.out.join("")).toMatch(/Searched 1 of \d+ configured libraries/);
    expect(o.out.join("")).toContain("Run `vibectx warm`");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("exits 1 when nothing matched, naming what was searched", async () => {
    writeCache("hono", HONO_URL, HONO_DOC);
    const o = io();
    expect(await dispatchCli(["node", "vibectx", "search", "kubernetes", "--config", config()], o)).toBe(1);
    expect(o.out.join("")).toContain("No sections matched");
    expect(o.out.join("")).toContain("searched 1 cached library: hono");
  });

  it("exits 2 on a usage error and prints the usage line", async () => {
    const o = io();
    expect(await dispatchCli(["node", "vibectx", "search", "--json"], o)).toBe(2);
    expect(o.err.join("")).toContain(SEARCH_USAGE);
  });

  it("--library filters, and a subcommand name given as a library value is not a subcommand", async () => {
    writeCache("hono", HONO_URL, HONO_DOC);
    writeCache("react", REACT_URL, REACT_DOC);
    const o = io();
    expect(await dispatchCli(["node", "vibectx", "search", "streaming cleanup", "--library", "hono", "--config", config()], o)).toBe(0);
    expect(o.out.join("")).toContain("# hono");
    expect(o.out.join("")).not.toContain("# react");
    expect(o.out.join("")).toContain("Searched 1 of 1 configured library");
  });

  it("--json prints the outcome with a stable key order", async () => {
    writeCache("hono", HONO_URL, HONO_DOC);
    const o = io();
    expect(await dispatchCli(["node", "vibectx", "search", "streaming", "--json", "--config", config()], o)).toBe(0);
    const parsed = JSON.parse(o.out.join(""));
    expect(Object.keys(parsed)).toEqual([
      "schemaVersion",
      "generatedAt",
      "query",
      "groups",
      "configured",
      "searched",
      "searchedLibraries",
      "matchedLibraries",
      "unknown",
      "uncached",
      "fromIndex",
      "tokenized",
      "indexWritten",
      "notes",
    ]);
    expect(parsed.schemaVersion).toBe(SEARCH_SCHEMA_VERSION);
    expect(parsed.groups[0].library).toBe("hono");
    expect(parsed.groups[0].sections[0].body).toContain("streamSSE");
    expect(parsed.uncached).toContain("react");
    expect(parsed.uncached).not.toContain("hono");
    expect(parsed.searchedLibraries).toEqual(["hono"]);
  });

  it("`search warm` searches for the word warm rather than dispatching to warm", async () => {
    writeCache("hono", HONO_URL, HONO_DOC);
    const o = io();
    const code = await dispatchCli(["node", "vibectx", "search", "warm", "--config", config()], o);
    expect(code).toBe(1); // nothing in the cache says "warm"
    expect(o.out.join("")).toContain('No sections matched "warm"');
    expect(o.out.join("")).not.toContain("dependencies cached");
  });
});
