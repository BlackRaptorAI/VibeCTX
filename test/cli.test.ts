import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeCache } from "../src/cache.js";
import { DEFAULT_REGISTRY } from "../src/registry.js";
import { parseDoctorArgs, parseResolveArgs, dispatchCli, RESOLVE_USAGE, type CliIo } from "../src/cli.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "vibectx-cli-"));
  process.env.DOCS_CACHE_DIR = dir;
});

afterEach(() => {
  delete process.env.DOCS_CACHE_DIR;
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
    expect(a.err.join("")).toMatch(/Could not load config \/nonexistent\.json/);
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
    expect(Object.keys(report)).toEqual(["schemaVersion", "generatedAt", "libraries", "healthy", "total"]);
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
    expect(a.err.join("")).toMatch(/Could not load config .*alias "react"/);
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
    expect(a.err.join("")).toMatch(/Could not load config/);
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
      "https://raw.githubusercontent.com/elysiajs/elysia/main/README.md": "# Elysia",
    });
    const a = io();
    expect(await dispatchCli(["node", "dist/index.js", "resolve", "elysia"], a)).toBe(0);
    const text = a.out.join("");
    expect(text).toMatch(/^Resolved "elysia" via npm/);
    expect(text).toContain("chosen: https://raw.githubusercontent.com/elysiajs/elysia/main/README.md (readme, 8 chars)");
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
    expect(a.err.join("")).toMatch(/Could not load config \/nonexistent\.json/);
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
