import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { cleanText } from "./project-deps.js";
import type { LibraryEntry } from "./registry.js";

/**
 * Config discovery (PAR-657). MCP clients launch the server with a fixed command line, so
 * `--config <path>` can never carry a committed team config: this module finds one.
 *
 * Sources, highest precedence first (D-14):
 *   1. `--config <path>`                         (flag)
 *   2. `VIBECTX_CONFIG=<path>`                   (env)
 *   3. `./vibectx.config.json`, walking up to the git root   (project)
 *   4. `$XDG_CONFIG_HOME/vibectx/config.json`, else `~/.config/vibectx/config.json` (user)
 *   5. the shipped defaults
 *
 * An EXPLICIT source is authoritative: given a flag or the env var, discovery of (3) and (4)
 * is skipped entirely — exactly the 0.1.x behaviour for everyone already passing `--config`.
 * Otherwise user layers over the defaults and project layers over that (registry.ts does the
 * merging, one layer at a time, so D-06 / D-07 apply between layers as they do today).
 *
 * Everything here is injectable: `cwd`, `env` and `home` are parameters, never read from the
 * process, so tests cannot be changed by the machine they run on.
 */

export const CONFIG_FILENAME = "vibectx.config.json";
/** The user-level file is `<config dir>/vibectx/config.json` — the directory already names it. */
export const USER_CONFIG_FILENAME = "config.json";
/** D-16: accepted at the same locations through 0.2.x, with a deprecation note. */
export const LEGACY_CONFIG_FILENAME = "docs-cache.config.json";
export const CONFIG_ENV = "VIBECTX_CONFIG";
/** ASSUMED cap (D-17): no real config is this big, and a huge file is a mistake worth naming. */
export const MAX_CONFIG_BYTES = 1024 * 1024;

export type ConfigScope = "flag" | "env" | "project" | "user";

export interface ConfigFile {
  /** As given for a flag / env source; absolute for a discovered one. */
  path: string;
  scope: ConfigScope;
  /** True when this is the deprecated `docs-cache.config.json` name. */
  legacy: boolean;
}

export interface ConfigResolution {
  /** LOWEST precedence first — registry.ts applies them in this order. */
  files: ConfigFile[];
  /** Deprecation / ignored-file notes, already display-formatted (D-16, D-18). */
  notes: string[];
}

export interface DiscoverConfigOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** The `--config` value, when one was passed. */
  flag?: string;
  /** Home directory for the user-level file (default: os.homedir()). */
  home?: string;
}

/** Resolve the config sources for one process. Throws only when a candidate path exists but
 *  is not a regular file (D-15); a missing file is simply not a source. */
export function discoverConfig(opts: DiscoverConfigOptions): ConfigResolution {
  const notes: string[] = [];
  const home = opts.home ?? homedir();
  const show = (p: string): string => displayPath(p, opts.cwd, home);

  const flag = opts.flag?.trim();
  if (flag) return { files: [{ path: opts.flag as string, scope: "flag", legacy: false }], notes };
  const env = (opts.env[CONFIG_ENV] ?? "").trim();
  if (env) return { files: [{ path: env, scope: "env", legacy: false }], notes };

  const files: ConfigFile[] = [];
  const userDir = userConfigDir(opts.env, home);
  const user = userDir === undefined ? undefined : pickInDirectory(userDir, "user", USER_CONFIG_FILENAME, notes, show);
  if (user) files.push(user); // lowest precedence first
  for (const dir of projectDirs(opts.cwd)) {
    const hit = pickInDirectory(dir, "project", CONFIG_FILENAME, notes, show);
    if (hit) {
      files.push(hit); // nearest wins; parents are NOT layered (monorepo layering is a follow-up)
      break;
    }
  }
  return { files, notes };
}

/**
 * `$XDG_CONFIG_HOME/vibectx`, else `<home>/.config/vibectx`; undefined when there is no home.
 * The XDG base directory spec requires an ABSOLUTE path and says a relative one must be
 * ignored — and a relative one here would be resolved against the working directory, which
 * is how an unrelated repo's `./vibectx/config.json` would become "the user's config" (K2).
 */
function userConfigDir(env: NodeJS.ProcessEnv, home: string): string | undefined {
  const xdg = (env.XDG_CONFIG_HOME ?? "").trim();
  if (xdg && isAbsolute(xdg)) return join(xdg, "vibectx");
  if (!home) return undefined;
  return join(home, ".config", "vibectx");
}

/** `path.resolve` falls back to `process.cwd()` for a relative input; discovery must depend
 *  only on the cwd it was given (K2), so an absolute path is merely normalised. */
function fromCwd(cwd: string, path?: string): string {
  if (path === undefined) return isAbsolute(cwd) ? normalize(cwd) : resolve(cwd);
  return isAbsolute(path) ? normalize(path) : join(fromCwd(cwd), path);
}

/**
 * D-15 — the directories the walk-up may look in: cwd, then each parent, stopping AFTER the
 * one that holds `.git` (a directory in a clone, a file in a worktree). With no `.git` above
 * cwd at all, only cwd is checked, so a stray config in `/tmp` or `$HOME` is never picked up.
 */
function projectDirs(cwd: string): string[] {
  const start = fromCwd(cwd);
  const dirs: string[] = [];
  let cur = start;
  for (;;) {
    dirs.push(cur);
    if (existsSync(join(cur, ".git"))) return dirs;
    const parent = dirname(cur);
    if (parent === cur) return [start];
    cur = parent;
  }
}

/** The config file to use from one directory, with D-16's notes. */
function pickInDirectory(
  dir: string,
  scope: ConfigScope,
  mainName: string,
  notes: string[],
  show: (p: string) => string,
): ConfigFile | undefined {
  const main = join(dir, mainName);
  const legacy = join(dir, LEGACY_CONFIG_FILENAME);
  const hasMain = isRegularFile(main, show);
  const hasLegacy = isRegularFile(legacy, show);
  if (hasMain) {
    if (hasLegacy) {
      notes.push(`${show(legacy)} is ignored: ${show(main)} in the same directory takes precedence`);
    }
    return { path: main, scope, legacy: false };
  }
  if (hasLegacy) {
    notes.push(
      `${show(legacy)} is deprecated: rename it to ${mainName} (the legacy name is accepted through 0.2.x)`,
    );
    return { path: legacy, scope, legacy: true };
  }
  return undefined;
}

/** True for a regular file (symlinks are followed — the user's own tree). Anything else that
 *  exists under a config name is refused loudly rather than silently skipped (D-15). */
function isRegularFile(path: string, show: (p: string) => string): boolean {
  const st = statSync(path, { throwIfNoEntry: false });
  if (st === undefined) return false;
  if (!st.isFile()) throw new Error(`${show(path)}: not a regular file`);
  return true;
}

/** D-18 display rule: relative to cwd when beneath it, `~`-abbreviated when under home,
 *  absolute otherwise. Always POSIX separators, so the header reads the same everywhere. */
export function displayPath(path: string, cwd: string, home?: string): string {
  const abs = fromCwd(cwd, path);
  const rel = relative(fromCwd(cwd), abs);
  if (rel !== "" && !rel.startsWith("..") && !isAbsolute(rel)) return `./${rel.split(sep).join("/")}`;
  if (home && (abs === home || abs.startsWith(home + sep))) return `~/${relative(home, abs).split(sep).join("/")}`;
  return abs;
}

/**
 * D-18 — the lines `list_libraries` starts with: one `config:` line naming the sources
 * actually loaded, highest precedence first, then any deprecation / ignored-file note.
 * Everything passes through `cleanText` (S3), because a path is attacker-adjacent text.
 */
export function describeConfig(resolution: ConfigResolution, opts: { cwd: string; home?: string }): string[] {
  const parts = [...resolution.files].reverse().map((f) => {
    const shown = displayPath(f.path, opts.cwd, opts.home);
    if (f.scope === "flag") return `--config ${shown}`;
    if (f.scope === "env") return `${CONFIG_ENV}=${shown}`;
    return `${shown} (${f.scope})`;
  });
  const header = parts.length === 0 ? "config: none (shipped defaults)" : `config: ${parts.join(" · ")}`;
  return [header, ...resolution.notes].map(cleanText);
}

/* ------------------------------------------------------------------ *
 * D-17 — file validation. One line per failure: `<file>: <path>: <message>`,
 * never a zod issue dump and never a JSON.parse stack.
 * ------------------------------------------------------------------ */

const URLS_MESSAGE = "must be a non-empty array of https URLs";
const STRINGS_MESSAGE = "must be an array of non-empty strings";
const LIBRARIES_MESSAGE = "must be an array of library entries";
const TTL_MESSAGE = "must be a number of hours, 0 or greater (0 = always revalidate)";

const isNonEmptyString = (v: unknown): boolean => typeof v === "string" && v.trim().length > 0;
const isStringList = (v: unknown): boolean => Array.isArray(v) && v.every(isNonEmptyString);
const isHttpsUrl = (v: unknown): boolean => {
  if (typeof v !== "string") return false;
  try {
    return new URL(v).protocol === "https:";
  } catch {
    return false;
  }
};

/** Unknown ENTRY keys are stripped, not rejected (forward-compatible): a config written for a
 *  later version still loads here. `resolved` goes with them — only the resolver may set it. */
const EntrySchema = z.object({
  name: z.custom<string>(isNonEmptyString, "must be a non-empty string"),
  urls: z.custom<string[]>((v) => Array.isArray(v) && v.length > 0 && v.every(isHttpsUrl), URLS_MESSAGE),
  aliases: z.custom<string[]>(isStringList, STRINGS_MESSAGE).optional(),
  probeQueries: z.custom<string[]>(isStringList, STRINGS_MESSAGE).optional(),
  allowedHosts: z
    .custom<string[]>((v) => Array.isArray(v) && v.every((h) => typeof h === "string"), "must be an array of hostnames")
    .optional(),
  description: z.string({ invalid_type_error: "must be a string" }).optional(),
  // D-21: 0 is a real setting — "always revalidate", which is what a 0.1.3 config meant by it
  // and what cache.ts still does with it. Only a negative or non-finite value is a mistake.
  ttlHours: z
    .number({ invalid_type_error: TTL_MESSAGE, required_error: TTL_MESSAGE })
    .finite(TTL_MESSAGE)
    .min(0, TTL_MESSAGE)
    .optional(),
});

/** Unknown TOP-LEVEL keys (`$comment`, `$schema`) are ignored the same way. D-21: `libraries`
 *  itself is OPTIONAL — `{}` (and an explicit `null`) load as "no entries", which is how a
 *  0.1.3 config with the key commented out behaved. Any other type is still an error. */
const ConfigSchema = z.object(
  {
    libraries: z.array(EntrySchema, { required_error: LIBRARIES_MESSAGE, invalid_type_error: LIBRARIES_MESSAGE }).nullish(),
  },
  { invalid_type_error: 'must be an object with a "libraries" array', required_error: 'must be an object with a "libraries" array' },
);

/** `libraries[2].urls` from a zod issue path. */
function issuePath(path: readonly (string | number)[]): string {
  return path.map((seg, i) => (typeof seg === "number" ? `[${seg}]` : i === 0 ? seg : `.${seg}`)).join("");
}

/** Drop a leading UTF-8 BOM (editors on Windows write one; JSON.parse rejects it). */
function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** `invalid JSON at line L column C: <reason>` — line/col computed from the parser's
 *  position when it reports one (Node 18 does; Node 20+ also prints them itself). */
function jsonErrorMessage(text: string, err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  // V8 embeds a snippet of the offending source (with its newlines) in some messages; flatten
  // and bound it so the result is always ONE readable line.
  const reason = raw.split(" in JSON at position")[0].replace(/\s+/g, " ").trim().slice(0, 120);
  const at = /at position (\d+)/.exec(raw);
  if (!at) return `invalid JSON: ${reason}`;
  const pos = Math.min(Number(at[1]), text.length);
  const before = text.slice(0, pos);
  const lastBreak = before.lastIndexOf("\n");
  return `invalid JSON at line ${before.split("\n").length} column ${pos - lastBreak}: ${reason}`;
}

/**
 * Read and validate one config file. `display` is what the message names it (the caller may
 * pass a cwd-relative form); everything it throws is a single line safe to print.
 */
export function readConfigFile(path: string, display: string = path): { libraries: LibraryEntry[] } {
  const st = statSync(path, { throwIfNoEntry: false });
  if (st === undefined) throw new Error(`${display}: not found`);
  if (!st.isFile()) throw new Error(`${display}: not a regular file`);
  if (st.size > MAX_CONFIG_BYTES) throw new Error(`${display}: larger than 1 MiB`);
  const text = stripBom(readFileSync(path, "utf8"));
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (e) {
    throw new Error(`${display}: ${jsonErrorMessage(text, e)}`);
  }
  const parsed = ConfigSchema.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issuePath(issue.path);
    throw new Error(`${display}: ${where === "" ? "" : `${where}: `}${cleanText(issue.message)}`);
  }
  return { libraries: (parsed.data.libraries ?? []) as LibraryEntry[] };
}
