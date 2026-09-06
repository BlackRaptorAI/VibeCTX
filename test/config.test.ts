import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CONFIG_ENV,
  CONFIG_FILENAME,
  LEGACY_CONFIG_FILENAME,
  describeConfig,
  discoverConfig,
  readConfigFile,
} from "../src/config.js";

/**
 * PAR-657 — config discovery. Every case injects cwd / env / home: nothing here may
 * depend on the machine's real HOME, XDG_CONFIG_HOME or working directory.
 */

let root: string;
let repo: string;
let home: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "vibectx-config-"));
  repo = join(root, "repo");
  home = join(root, "home");
  mkdirSync(join(repo, "src", "deep"), { recursive: true });
  mkdirSync(join(repo, ".git"), { recursive: true }); // ordinary clone
  mkdirSync(home, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const CONFIG = (name: string, url: string) => JSON.stringify({ libraries: [{ name, urls: [url] }] });
const write = (dir: string, file: string, body: string): string => {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, file);
  writeFileSync(path, body, "utf8");
  return path;
};
/** discoverConfig with the machine's real environment fully replaced. */
const discover = (opts: { cwd?: string; env?: NodeJS.ProcessEnv; flag?: string; home?: string } = {}) =>
  discoverConfig({ cwd: opts.cwd ?? repo, env: opts.env ?? {}, flag: opts.flag, home: opts.home ?? home });

const paths = (opts?: Parameters<typeof discover>[0]) => discover(opts).files.map((f) => `${f.scope}:${f.path}`);

describe("discoverConfig: explicit sources are authoritative (D-14, PAR-657)", () => {
  it("uses --config alone and skips discovery of the project and user files", () => {
    write(repo, CONFIG_FILENAME, CONFIG("project", "https://p.example.com/llms.txt"));
    write(join(home, ".config", "vibectx"), "config.json", CONFIG("user", "https://u.example.com/llms.txt"));
    const res = discover({ flag: "./explicit.json" });
    expect(res.files).toEqual([{ path: "./explicit.json", scope: "flag", legacy: false }]);
  });

  it("uses VIBECTX_CONFIG when there is no flag, and skips discovery", () => {
    write(repo, CONFIG_FILENAME, CONFIG("project", "https://p.example.com/llms.txt"));
    const res = discover({ env: { [CONFIG_ENV]: "/etc/vibectx.json" } });
    expect(res.files).toEqual([{ path: "/etc/vibectx.json", scope: "env", legacy: false }]);
  });

  it("flag beats env", () => {
    const res = discover({ flag: "./flag.json", env: { [CONFIG_ENV]: "/etc/env.json" } });
    expect(res.files).toEqual([{ path: "./flag.json", scope: "flag", legacy: false }]);
  });

  it("treats an empty flag or env value as absent and discovers instead", () => {
    const p = write(repo, CONFIG_FILENAME, CONFIG("project", "https://p.example.com/llms.txt"));
    expect(paths({ flag: "  ", env: { [CONFIG_ENV]: "" } })).toEqual([`project:${p}`]);
  });
});

describe("discoverConfig: project + user layering order (D-14)", () => {
  it("orders the files lowest precedence first: user, then project", () => {
    const u = write(join(home, ".config", "vibectx"), "config.json", CONFIG("x", "https://u.example.com/llms.txt"));
    const p = write(repo, CONFIG_FILENAME, CONFIG("x", "https://p.example.com/llms.txt"));
    expect(paths()).toEqual([`user:${u}`, `project:${p}`]);
  });

  it("finds the user file under XDG_CONFIG_HOME when that is set", () => {
    write(join(home, ".config", "vibectx"), "config.json", CONFIG("x", "https://u.example.com/llms.txt"));
    const xdg = join(root, "xdg");
    const u = write(join(xdg, "vibectx"), "config.json", CONFIG("x", "https://xdg.example.com/llms.txt"));
    expect(paths({ env: { XDG_CONFIG_HOME: xdg } })).toEqual([`user:${u}`]);
  });

  it("returns no files at all when neither exists", () => {
    expect(discover().files).toEqual([]);
    expect(discover().notes).toEqual([]);
  });

  it("ignores a relative or empty XDG_CONFIG_HOME and falls back to ~/.config (K2)", () => {
    const u = write(join(home, ".config", "vibectx"), "config.json", CONFIG("x", "https://u.example.com/llms.txt"));
    expect(paths({ env: { XDG_CONFIG_HOME: "relative/xdg" } })).toEqual([`user:${u}`]);
    expect(paths({ env: { XDG_CONFIG_HOME: "   " } })).toEqual([`user:${u}`]);
    expect(paths({ env: { XDG_CONFIG_HOME: "" } })).toEqual([`user:${u}`]);
  });

  it("never consults process.cwd(): every path comes from the injected cwd (K2)", () => {
    const p = write(repo, CONFIG_FILENAME, CONFIG("x", "https://p.example.com/llms.txt"));
    const cwd = vi.spyOn(process, "cwd").mockImplementation(() => {
      throw new Error("process.cwd() must not be consulted by discovery");
    });
    try {
      const res = discoverConfig({ cwd: join(repo, "src", "deep"), env: {}, home });
      expect(res.files.map((f) => f.path)).toEqual([p]);
      expect(describeConfig(res, { cwd: repo, home })).toEqual(["config: ./vibectx.config.json (project)"]);
    } finally {
      cwd.mockRestore();
    }
  });
});

describe("discoverConfig: the walk-up is confined to the repository (D-15)", () => {
  it("finds a config in a parent directory inside the repo", () => {
    const p = write(repo, CONFIG_FILENAME, CONFIG("x", "https://p.example.com/llms.txt"));
    expect(paths({ cwd: join(repo, "src", "deep") })).toEqual([`project:${p}`]);
  });

  it("stops at the directory containing a .git DIRECTORY and never reads a config above it", () => {
    write(root, CONFIG_FILENAME, CONFIG("outside", "https://outside.example.com/llms.txt"));
    expect(discover({ cwd: join(repo, "src") }).files).toEqual([]);
  });

  it("stops at a .git FILE too (git worktrees write a file, not a directory)", () => {
    const worktree = join(root, "wt");
    mkdirSync(join(worktree, "src"), { recursive: true });
    writeFileSync(join(worktree, ".git"), "gitdir: /elsewhere/.git/worktrees/wt\n", "utf8");
    write(root, CONFIG_FILENAME, CONFIG("outside", "https://outside.example.com/llms.txt"));
    expect(discover({ cwd: join(worktree, "src") }).files).toEqual([]);
  });

  it("still reads the config in the git root directory itself", () => {
    const p = write(repo, CONFIG_FILENAME, CONFIG("x", "https://p.example.com/llms.txt"));
    expect(paths({ cwd: repo })).toEqual([`project:${p}`]);
  });

  it("checks cwd only when no .git is found before the filesystem root", () => {
    const loose = join(root, "loose", "sub");
    mkdirSync(loose, { recursive: true });
    write(join(root, "loose"), CONFIG_FILENAME, CONFIG("parent", "https://parent.example.com/llms.txt"));
    expect(discover({ cwd: loose }).files).toEqual([]);
    const own = write(loose, CONFIG_FILENAME, CONFIG("own", "https://own.example.com/llms.txt"));
    expect(paths({ cwd: loose })).toEqual([`project:${own}`]);
  });

  it("takes the nearest project file and does NOT layer a second one above it", () => {
    write(repo, CONFIG_FILENAME, CONFIG("far", "https://far.example.com/llms.txt"));
    const near = write(join(repo, "src"), CONFIG_FILENAME, CONFIG("near", "https://near.example.com/llms.txt"));
    expect(paths({ cwd: join(repo, "src", "deep") })).toEqual([`project:${near}`]);
  });
});

describe("discoverConfig: legacy filename (D-16)", () => {
  it("accepts docs-cache.config.json with a deprecation note", () => {
    const p = write(repo, LEGACY_CONFIG_FILENAME, CONFIG("x", "https://p.example.com/llms.txt"));
    const res = discover();
    expect(res.files).toEqual([{ path: p, scope: "project", legacy: true }]);
    expect(res.notes.join("\n")).toMatch(/docs-cache\.config\.json is deprecated.*vibectx\.config\.json/);
  });

  it("prefers vibectx.config.json when both names sit in the same directory, and says the legacy one is ignored", () => {
    const p = write(repo, CONFIG_FILENAME, CONFIG("new", "https://new.example.com/llms.txt"));
    write(repo, LEGACY_CONFIG_FILENAME, CONFIG("old", "https://old.example.com/llms.txt"));
    const res = discover();
    expect(res.files).toEqual([{ path: p, scope: "project", legacy: false }]);
    expect(res.notes.join("\n")).toMatch(/docs-cache\.config\.json is ignored/);
  });

  it("accepts the legacy name at the user location too", () => {
    const u = write(join(home, ".config", "vibectx"), LEGACY_CONFIG_FILENAME, CONFIG("x", "https://u.example.com/llms.txt"));
    expect(paths()).toEqual([`user:${u}`]);
  });
});

describe("discoverConfig: file kind (D-15)", () => {
  it("accepts a symlink that resolves to a regular file", () => {
    const target = write(join(root, "shared"), "team.json", CONFIG("x", "https://t.example.com/llms.txt"));
    symlinkSync(target, join(repo, CONFIG_FILENAME));
    const res = discover();
    expect(res.files.map((f) => f.scope)).toEqual(["project"]);
    expect(readConfigFile(res.files[0].path).libraries[0].name).toBe("x");
  });

  it("refuses a directory named vibectx.config.json with a clear message", () => {
    mkdirSync(join(repo, CONFIG_FILENAME));
    expect(() => discover()).toThrow(/vibectx\.config\.json: not a regular file/);
  });
});

describe("readConfigFile: zod validation, one line per failure (D-17)", () => {
  const bad = (body: unknown): (() => unknown) => {
    const path = write(repo, CONFIG_FILENAME, typeof body === "string" ? body : JSON.stringify(body));
    return () => readConfigFile(path);
  };

  it("accepts a well-formed file and returns its libraries", () => {
    const path = write(
      repo,
      CONFIG_FILENAME,
      JSON.stringify({
        $comment: "unknown top-level keys are ignored",
        libraries: [
          {
            name: "acme",
            urls: ["https://docs.acme.com/llms.txt"],
            aliases: ["acme-js"],
            probeQueries: ["install"],
            allowedHosts: ["api.acme.com"],
            description: "Acme",
            ttlHours: 24,
            futureField: "ignored, not an error",
          },
        ],
      }),
    );
    const { libraries } = readConfigFile(path);
    expect(libraries).toHaveLength(1);
    expect(libraries[0].name).toBe("acme");
    expect(libraries[0].ttlHours).toBe(24);
    expect((libraries[0] as Record<string, unknown>).futureField).toBeUndefined();
  });

  it("D-21: a file without libraries — or with null — loads as empty, exactly as 0.1.3 did", () => {
    const empty = write(repo, CONFIG_FILENAME, JSON.stringify({ $comment: "no libraries yet" }));
    expect(readConfigFile(empty).libraries).toEqual([]);
    const nulled = write(repo, "nulled.json", JSON.stringify({ libraries: null }));
    expect(readConfigFile(nulled).libraries).toEqual([]);
  });

  it("reports libraries that is neither an array nor null", () => {
    expect(bad({ libraries: { acme: {} } })).toThrow(/libraries: must be an array of library entries/);
    expect(bad({ libraries: 3 })).toThrow(/libraries: must be an array of library entries/);
    expect(bad("[]")).toThrow(/vibectx\.config\.json: must be an object with a "libraries" array/);
  });

  it("D-21: ttlHours 0 means always revalidate and still loads; negative and non-finite are refused", () => {
    const zero = write(repo, "zero.json", JSON.stringify({ libraries: [{ name: "a", urls: ["https://a.example.com/x"], ttlHours: 0 }] }));
    expect(readConfigFile(zero).libraries[0].ttlHours).toBe(0);
    const entry = (ttlHours: unknown) => ({ libraries: [{ name: "a", urls: ["https://a.example.com/x"], ttlHours }] });
    expect(bad(entry(-1))).toThrow(/libraries\[0\]\.ttlHours.*must be a number of hours, 0 or greater/);
    expect(bad(entry("24"))).toThrow(/libraries\[0\]\.ttlHours.*must be a number of hours, 0 or greater/);
    expect(bad('{"libraries":[{"name":"a","urls":["https://a.example.com/x"],"ttlHours":1e999}]}')).toThrow(
      /libraries\[0\]\.ttlHours.*must be a number of hours, 0 or greater/,
    );
  });

  it("reports the entry index and field for a bad name or urls", () => {
    expect(bad({ libraries: [{ urls: ["https://a.example.com/x"] }] })).toThrow(
      /libraries\[0\]\.name: must be a non-empty string/,
    );
    expect(bad({ libraries: [{ name: "   ", urls: ["https://a.example.com/x"] }] })).toThrow(/libraries\[0\]\.name/);
    expect(bad({ libraries: [{ name: "a", urls: [] }] })).toThrow(
      /libraries\[0\]\.urls: must be a non-empty array of https URLs/,
    );
    expect(bad({ libraries: [{ name: "a" }] })).toThrow(/libraries\[0\]\.urls: must be a non-empty array of https URLs/);
    expect(bad({ libraries: [{ name: "a", urls: ["http://a.example.com/x"] }] })).toThrow(
      /libraries\[0\]\.urls: must be a non-empty array of https URLs/,
    );
    expect(
      bad({ libraries: [{ name: "a", urls: ["https://a.example.com/x"] }, { name: "b", urls: ["https://b/x"] }, { name: "c", urls: "nope" }] }),
    ).toThrow(/libraries\[2\]\.urls: must be a non-empty array of https URLs/);
  });

  it("reports bad aliases, probeQueries, allowedHosts, description and ttlHours", () => {
    const entry = (extra: Record<string, unknown>) => ({ libraries: [{ name: "a", urls: ["https://a.example.com/x"], ...extra }] });
    expect(bad(entry({ aliases: "one" }))).toThrow(/libraries\[0\]\.aliases: must be an array of non-empty strings/);
    expect(bad(entry({ aliases: [1] }))).toThrow(/libraries\[0\]\.aliases: must be an array of non-empty strings/);
    expect(bad(entry({ probeQueries: [""] }))).toThrow(/libraries\[0\]\.probeQueries: must be an array of non-empty strings/);
    expect(bad(entry({ allowedHosts: "api.acme.com" }))).toThrow(/libraries\[0\]\.allowedHosts: must be an array of hostnames/);
    expect(bad(entry({ description: 3 }))).toThrow(/libraries\[0\]\.description: must be a string/);
  });

  it("never leaks a zod issue dump or a stack trace", () => {
    try {
      bad({ libraries: [{ name: "a", urls: ["ftp://a/x"] }] })();
      expect.unreachable();
    } catch (e) {
      const m = (e as Error).message;
      expect(m.split("\n")).toHaveLength(1);
      expect(m).not.toMatch(/"code"|invalid_type|ZodError/);
    }
  });

  it("reports a JSON syntax error with line and column when the parser gives a position", () => {
    expect(bad('{\n "libraries": [\n  { "name": "a" "urls": [] }\n ]\n}\n')).toThrow(
      /vibectx\.config\.json: invalid JSON at line 3 column \d+: Expected/,
    );
  });

  it("falls back to `invalid JSON: <reason>` — still one line — when the parser gives no position", () => {
    expect(bad('{\n  "libraries": [,]\n}\n')).toThrow(/vibectx\.config\.json: invalid JSON: Unexpected token/);
    expect(bad("")).toThrow(/vibectx\.config\.json: invalid JSON: Unexpected end of JSON input/);
    try {
      bad('{\n  "libraries": [,]\n}\n')();
      expect.unreachable();
    } catch (e) {
      expect((e as Error).message.split("\n")).toHaveLength(1);
    }
  });

  it("tolerates a UTF-8 BOM (editors on Windows write one)", () => {
    const path = write(repo, CONFIG_FILENAME, `\uFEFF${CONFIG("acme", "https://docs.acme.com/llms.txt")}`);
    expect(readConfigFile(path).libraries[0].name).toBe("acme");
  });

  it("refuses a file larger than 1 MiB (ASSUMED cap)", () => {
    const filler = "x".repeat(1024 * 1024);
    const path = write(repo, CONFIG_FILENAME, JSON.stringify({ $comment: filler, libraries: [] }));
    expect(() => readConfigFile(path)).toThrow(/vibectx\.config\.json: larger than 1 MiB/);
  });

  it("reports a missing file and a directory without an ENOENT stack", () => {
    expect(() => readConfigFile(join(repo, "nope.json"))).toThrow(/nope\.json: not found/);
    mkdirSync(join(repo, "adir.json"));
    expect(() => readConfigFile(join(repo, "adir.json"))).toThrow(/adir\.json: not a regular file/);
  });

  it("validates docs/examples/paragon.vibectx.config.json against the new schema", () => {
    const example = fileURLToPath(new URL("../docs/examples/paragon.vibectx.config.json", import.meta.url));
    expect(readConfigFile(example).libraries.length).toBeGreaterThan(0);
  });
});

describe("describeConfig: the list_libraries header (D-18)", () => {
  const lines = (opts?: Parameters<typeof discover>[0]) => describeConfig(discover(opts), { cwd: opts?.cwd ?? repo, home });

  it("says so when nothing was loaded", () => {
    expect(lines()).toEqual(["config: none (shipped defaults)"]);
  });

  it("names the project file relative to cwd and the user file under ~, highest precedence first", () => {
    write(join(home, ".config", "vibectx"), "config.json", CONFIG("x", "https://u.example.com/llms.txt"));
    write(repo, CONFIG_FILENAME, CONFIG("x", "https://p.example.com/llms.txt"));
    expect(lines()).toEqual(["config: ./vibectx.config.json (project) · ~/.config/vibectx/config.json (user)"]);
  });

  it("names an explicit flag or env source", () => {
    expect(describeConfig(discover({ flag: "./x.json" }), { cwd: repo, home })).toEqual(["config: --config ./x.json"]);
    expect(describeConfig(discover({ env: { [CONFIG_ENV]: "/etc/x.json" } }), { cwd: repo, home })).toEqual([
      "config: VIBECTX_CONFIG=/etc/x.json",
    ]);
  });

  it("shows a project file found in a parent directory relative to cwd", () => {
    write(repo, CONFIG_FILENAME, CONFIG("x", "https://p.example.com/llms.txt"));
    // Not beneath cwd: shown absolute (it is not under HOME either).
    expect(lines({ cwd: join(repo, "src") })[0]).toBe(`config: ${join(repo, CONFIG_FILENAME)} (project)`);
  });

  it("puts the deprecation and ignored-file notes on the following lines", () => {
    write(repo, LEGACY_CONFIG_FILENAME, CONFIG("x", "https://p.example.com/llms.txt"));
    const out = lines();
    expect(out[0]).toBe("config: ./docs-cache.config.json (project)");
    expect(out[1]).toMatch(/^\.\/docs-cache\.config\.json is deprecated/);
  });
});
