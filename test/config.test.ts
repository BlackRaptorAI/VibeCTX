import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
const discover = (
  opts: { cwd?: string; env?: NodeJS.ProcessEnv; flag?: string; home?: string; ownerUid?: (dir: string) => number | undefined } = {},
) =>
  discoverConfig({
    cwd: opts.cwd ?? repo,
    env: opts.env ?? {},
    flag: opts.flag,
    home: opts.home ?? home,
    ownerUid: opts.ownerUid,
  });

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

  it("D-20: stops at a directory the current user does not own, and reads no config from it", () => {
    const p = write(repo, CONFIG_FILENAME, CONFIG("planted", "https://planted.example.com/llms.txt"));
    const mine = process.getuid?.() ?? 0;
    // `repo` belongs to someone else (a /tmp-style shared parent); `repo/src` is ours.
    const ownerUid = (dir: string) => (dir === repo ? mine + 1 : mine);
    expect(discover({ cwd: join(repo, "src"), ownerUid }).files).toEqual([]);
    // The same walk with the real owner does find it — the uid is what stopped it.
    expect(paths({ cwd: join(repo, "src") })).toEqual([`project:${p}`]);
    // A config in a directory we DO own, below the foreign one, is still read.
    const own = write(join(repo, "src"), CONFIG_FILENAME, CONFIG("own", "https://own.example.com/llms.txt"));
    expect(discover({ cwd: join(repo, "src"), ownerUid }).files.map((f) => f.path)).toEqual([own]);
  });

  it("D-20: a config the owner check skipped is NAMED, never silently dropped", () => {
    write(repo, CONFIG_FILENAME, CONFIG("planted", "https://planted.example.com/llms.txt"));
    const mine = process.getuid?.() ?? 0;
    const res = discover({ cwd: join(repo, "src"), ownerUid: (dir) => (dir === repo ? mine + 1 : mine) });
    expect(res.files).toEqual([]);
    // A parent is not beneath cwd, so the display rule shows it absolute.
    expect(res.notes).toEqual([`${join(repo, CONFIG_FILENAME)} is ignored: ${repo} is owned by another user`]);
    // No config in the foreign directory: nothing to say, and no noise on every start.
    rmSync(join(repo, CONFIG_FILENAME));
    expect(discover({ cwd: join(repo, "src"), ownerUid: (dir) => (dir === repo ? mine + 1 : mine) }).notes).toEqual([]);
  });

  it("D-20: a foreign-owned working directory yields no project config at all", () => {
    write(repo, CONFIG_FILENAME, CONFIG("planted", "https://planted.example.com/llms.txt"));
    const uid = vi.spyOn(process, "getuid").mockReturnValue((process.getuid?.() ?? 0) + 1);
    try {
      expect(discover({ cwd: repo }).files).toEqual([]);
    } finally {
      uid.mockRestore();
    }
  });

  it("D-20: the check is skipped where uids do not exist (Windows has no process.getuid)", () => {
    const p = write(repo, CONFIG_FILENAME, CONFIG("x", "https://p.example.com/llms.txt"));
    const real = process.getuid;
    Object.defineProperty(process, "getuid", { value: undefined, configurable: true });
    try {
      // Every directory would look foreign if the check ran with no uid to compare against.
      expect(paths({ cwd: join(repo, "src") })).toEqual([`project:${p}`]);
    } finally {
      Object.defineProperty(process, "getuid", { value: real, configurable: true });
    }
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

  it("D-19: a DISCOVERED path that is not a regular file is carried as a skipped file, not thrown", () => {
    mkdirSync(join(repo, CONFIG_FILENAME));
    const res = discover();
    expect(res.files).toEqual([{ path: join(repo, CONFIG_FILENAME), scope: "project", legacy: false, error: "not a regular file" }]);
    expect(describeConfig(res, { cwd: repo, home })[0]).toBe(
      "config: ./vibectx.config.json (project) — NOT LOADED: not a regular file",
    );
  });

  it("refuses a directory an EXPLICIT --config names, with a clear message", () => {
    mkdirSync(join(repo, "explicit.json"));
    expect(() => readConfigFile(join(repo, "explicit.json"))).toThrow(/explicit\.json: not a regular file/);
  });

  it("reports an unreadable file by its errno, never by a stack or the system message (S1)", () => {
    // A regular file whose read fails: /proc/self/mem stats as a zero-length regular file
    // and answers EIO. Where /proc does not exist, a mode-000 file answers EACCES instead
    // (and running as root, which can read it anyway, leaves nothing to assert).
    if (existsSync("/proc/self/mem")) {
      expect(() => readConfigFile("/proc/self/mem")).toThrow("/proc/self/mem: cannot be read (EIO)");
    }
    const path = write(repo, "locked.json", CONFIG("x", "https://x.example.com/llms.txt"));
    chmodSync(path, 0o000);
    try {
      if (process.getuid?.() !== 0) expect(() => readConfigFile(path)).toThrow(/locked\.json: cannot be read \(EACCES\)$/);
    } finally {
      chmodSync(path, 0o600);
    }
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

  it("reports the entry index and field for a bad name or urls, naming the entry when it has one (D-22)", () => {
    expect(bad({ libraries: [{ urls: ["https://a.example.com/x"] }] })).toThrow(
      /libraries\[0\]\.name: must be a non-empty string/, // no name to quote yet
    );
    expect(bad({ libraries: [{ name: "   ", urls: ["https://a.example.com/x"] }] })).toThrow(/libraries\[0\]\.name/);
    expect(bad({ libraries: [{ name: "a", urls: [] }] })).toThrow(
      /libraries\[0\]\.urls \("a"\): must be a non-empty array of https URLs/,
    );
    expect(bad({ libraries: [{ name: "a" }] })).toThrow(/libraries\[0\]\.urls \("a"\): must be a non-empty array of https URLs/);
    expect(bad({ libraries: [{ name: "a", urls: ["http://a.example.com/x"] }] })).toThrow(
      /libraries\[0\]\.urls \("a"\): must be a non-empty array of https URLs/,
    );
    expect(
      bad({ libraries: [{ name: "a", urls: ["https://a.example.com/x"] }, { name: "b", urls: ["https://b/x"] }, { name: "c", urls: "nope" }] }),
    ).toThrow(/libraries\[2\]\.urls \("c"\): must be a non-empty array of https URLs/);
  });

  it("reports bad aliases, probeQueries, allowedHosts, description and ttlHours", () => {
    const entry = (extra: Record<string, unknown>) => ({ libraries: [{ name: "a", urls: ["https://a.example.com/x"], ...extra }] });
    expect(bad(entry({ aliases: "one" }))).toThrow(/libraries\[0\]\.aliases \("a"\): must be an array of non-empty strings/);
    expect(bad(entry({ aliases: [1] }))).toThrow(/libraries\[0\]\.aliases \("a"\): must be an array of non-empty strings/);
    expect(bad(entry({ probeQueries: [""] }))).toThrow(/libraries\[0\]\.probeQueries \("a"\): must be an array of non-empty strings/);
    expect(bad(entry({ allowedHosts: "api.acme.com" }))).toThrow(/libraries\[0\]\.allowedHosts \("a"\): must be an array of hostnames/);
    expect(bad(entry({ description: 3 }))).toThrow(/libraries\[0\]\.description \("a"\): must be a string/);
  });

  it("S1: no content of the file reaches the message — a config pointed at a secrets file leaks nothing", () => {
    const secrets = write(root, ".env", "STRIPE_SECRET_KEY=sk_live_hunter2\nDB_PASSWORD=correct-horse\n");
    symlinkSync(secrets, join(repo, "linked.json"));
    try {
      readConfigFile(join(repo, "linked.json"));
      expect.unreachable();
    } catch (e) {
      const m = (e as Error).message;
      expect(m).toMatch(/linked\.json: invalid JSON(?: at line \d+ column \d+)?$/);
      expect(m).not.toMatch(/hunter2|correct-horse|STRIPE|PASSWORD/);
    }
  });

  it("S1: a terminal escape or bidi override in a config value never reaches the error text", () => {
    const nasty = "acme\u001b\u202egnip\u200b"; // ESC, right-to-left override, zero-width space
    const dangerous = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/;
    expect(bad({ libraries: [{ name: nasty, urls: [] }] })).toThrow(/libraries\[0\]\.urls \("acmegnip"\)/);
    try {
      bad({ libraries: [{ name: nasty, urls: [] }] })();
      expect.unreachable();
    } catch (e) {
      expect((e as Error).message).not.toMatch(dangerous);
    }
  });

  it("S1: every config error is one line of at most 300 characters", () => {
    const huge = "z".repeat(5000);
    try {
      bad({ libraries: [{ name: huge, urls: [] }] })();
      expect.unreachable();
    } catch (e) {
      const m = (e as Error).message;
      expect(m.length).toBeLessThanOrEqual(300);
      expect(m.split("\n")).toHaveLength(1);
    }
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

  it("reports a JSON syntax error with line and column, and nothing else (S1)", () => {
    // The V8 message quotes the offending source; the config may be any file the user
    // pointed at, so the position is reported and the content never is.
    try {
      bad('{\n "libraries": [\n  { "name": "a" "urls": [] }\n ]\n}\n')();
      expect.unreachable();
    } catch (e) {
      expect((e as Error).message).toMatch(/^.*vibectx\.config\.json: invalid JSON at line 3 column \d+$/);
    }
  });

  it("falls back to a bare `invalid JSON` — still one line — when the parser gives no position", () => {
    try {
      bad("")();
      expect.unreachable();
    } catch (e) {
      const m = (e as Error).message;
      expect(m).toMatch(/vibectx\.config\.json: invalid JSON$/);
      expect(m.split("\n")).toHaveLength(1);
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

  it("D-19: shows a discovered file that could not be loaded as NOT LOADED, with the reason", () => {
    const project = write(repo, CONFIG_FILENAME, CONFIG("x", "https://p.example.com/llms.txt"));
    const resolution = {
      files: [{ path: project, scope: "project" as const, legacy: false, error: "invalid JSON at line 3 column 5" }],
      notes: [],
    };
    expect(describeConfig(resolution, { cwd: repo, home })).toEqual([
      "config: ./vibectx.config.json (project) — NOT LOADED: invalid JSON at line 3 column 5",
    ]);
  });

  it("puts the deprecation and ignored-file notes on the following lines", () => {
    write(repo, LEGACY_CONFIG_FILENAME, CONFIG("x", "https://p.example.com/llms.txt"));
    const out = lines();
    expect(out[0]).toBe("config: ./docs-cache.config.json (project)");
    expect(out[1]).toMatch(/^\.\/docs-cache\.config\.json is deprecated/);
  });
});
