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
  /** D-19: set by the loader when a DISCOVERED file failed and was skipped — the reason,
   *  one line, without the path (the header and the warning add it). Never set for an
   *  explicit source: a `--config` or `VIBECTX_CONFIG` that cannot be honoured is fatal. */
  error?: string;
  /** How the loader named this file in its messages (cwd-relative, `~/…`, else absolute). */
  display?: string;
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
  /** D-20 seam: who owns a directory (default: `statSync(dir).uid`, undefined when it cannot
   *  be read). Injectable so a test can plant a foreign owner without a second user. */
  ownerUid?: (dir: string) => number | undefined;
}

/** Resolve the config sources for one process. Throws only when a candidate path exists but
 *  is not a regular file (D-15); a missing file is simply not a source. */
export function discoverConfig(opts: DiscoverConfigOptions): ConfigResolution {
  const notes: string[] = [];
  const home = opts.home ?? homedir();
  const show = (p: string): string => displayPath(p, opts.cwd, home);

  // The trimmed value is what was tested for emptiness, so it is also what is used: a path
  // that differs from it only by surrounding whitespace is the same path.
  const flag = opts.flag?.trim();
  if (flag) return { files: [{ path: flag, scope: "flag", legacy: false }], notes };
  const env = (opts.env[CONFIG_ENV] ?? "").trim();
  if (env) return { files: [{ path: env, scope: "env", legacy: false }], notes };

  const files: ConfigFile[] = [];
  const userDir = userConfigDir(opts.env, home);
  const user = userDir === undefined ? undefined : pickInDirectory(userDir, "user", USER_CONFIG_FILENAME, notes, show);
  if (user) files.push(user); // lowest precedence first
  for (const dir of projectDirs(opts.cwd, opts.ownerUid ?? directoryUid)) {
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

/** Owner of a directory, or undefined when it cannot be stat'ed. */
function directoryUid(dir: string): number | undefined {
  return statSync(dir, { throwIfNoEntry: false })?.uid;
}

/**
 * D-15 — the directories the walk-up may look in: cwd, then each parent, stopping AFTER the
 * one that holds `.git` (a directory in a clone, a file in a worktree). With no `.git` above
 * cwd at all, only cwd is checked, so a stray config in `/tmp` or `$HOME` is never picked up.
 *
 * D-20 — and only directories the current user OWNS. The walk stops at the first directory
 * with a different uid: its config is not read and no parent of it is looked at. This is
 * git's `safe.directory` reasoning — on a shared machine anyone can create `/tmp/x/.git`
 * beside a `/tmp/x/vibectx.config.json` and wait for someone to run a server under it.
 * Where uids do not exist (Windows: no `process.getuid`) the check is skipped.
 */
function projectDirs(cwd: string, ownerUid: (dir: string) => number | undefined): string[] {
  const start = fromCwd(cwd);
  const mine = typeof process.getuid === "function" ? process.getuid() : undefined;
  const trusted = (dir: string): boolean => mine === undefined || ownerUid(dir) === mine;
  const dirs: string[] = [];
  let cur = start;
  for (;;) {
    if (!trusted(cur)) return dirs;
    dirs.push(cur);
    if (existsSync(join(cur, ".git"))) return dirs;
    const parent = dirname(cur);
    if (parent === cur) return [start]; // no repository anywhere above: cwd only
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
  if (!st.isFile()) throw new ConfigError(show(path), "not a regular file");
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
    // D-19: a discovered file that failed is still named — silence would leave the reader
    // believing their committed config is in force.
    return `${shown} (${f.scope})${f.error === undefined ? "" : ` — NOT LOADED: ${f.error}`}`;
  });
  const header = parts.length === 0 ? "config: none (shipped defaults)" : `config: ${parts.join(" · ")}`;
  return [header, ...resolution.notes].map(cleanText);
}

/* ------------------------------------------------------------------ *
 * D-17 / D-22 — file validation. ONE line per failure, in ONE grammar:
 *
 *   <display path>: libraries[i].<field> ("<name>" when known): <message>
 *
 * for schema failures here and for the semantic ones registry.ts raises (alias
 * collisions, allowedHosts values, D-06 conflicts) alike. Never a zod issue dump,
 * never a JSON.parse stack, and never any content of the file: a config path can be
 * pointed at any file on disk (`--config ~/.env`), so only positions are reported.
 * ------------------------------------------------------------------ */

/** Longest config-error line. A message is read by a human in a terminal or an MCP
 *  client's log pane; anything longer is a payload, not a message. ASSUMED. */
export const MAX_CONFIG_ERROR_CHARS = 300;
/** Longest quoted value inside one (a hostname, a library name). ASSUMED. */
export const MAX_CONFIG_VALUE_CHARS = 80;

/** `s` with control / bidi characters removed and clipped to `max`, ellipsis included. */
export function clipText(s: string, max: number): string {
  const clean = cleanText(s);
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

/**
 * One config failure, as one printable line. `detail` is the part after the display path,
 * which is what the D-18 header shows next to a file it could not load (D-19). Both parts
 * are cleaned and bounded on the way in, so every consumer prints a safe line.
 */
export class ConfigError extends Error {
  readonly display: string;
  readonly detail: string;
  constructor(display: string, detail: string) {
    const shownPath = clipText(display, MAX_CONFIG_ERROR_CHARS);
    const shownDetail = clipText(detail, MAX_CONFIG_ERROR_CHARS - 2);
    super(clipText(`${shownPath}: ${shownDetail}`, MAX_CONFIG_ERROR_CHARS));
    this.name = "ConfigError";
    this.display = shownPath;
    this.detail = shownDetail;
  }
}

/**
 * D-22's locator: `libraries[3].allowedHosts ("acme")`. The name is quoted only when the
 * file actually supplies one — a broken `name` field has nothing to quote — and is clipped,
 * because it is attacker-adjacent text from a file the user may not have written.
 */
export function configLocator(index: number, field: string, name?: unknown): string {
  const known = typeof name === "string" && name.trim().length > 0;
  const shown = known ? ` (${JSON.stringify(clipText(name as string, MAX_CONFIG_VALUE_CHARS))})` : "";
  return `libraries[${index}].${field}${shown}`;
}

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

/**
 * The D-22 locator for a zod issue path: `libraries` for a top-level failure,
 * `libraries[2].urls ("acme")` for an entry field — the entry's own name is read back out
 * of the parsed JSON when the file supplies a usable one. `""` when the whole document is
 * the wrong shape (path `[]`), which needs no locator at all.
 */
function issueLocator(path: readonly (string | number)[], json: unknown): string {
  if (path.length === 0) return "";
  if (path.length < 3 || typeof path[1] !== "number" || typeof path[2] !== "string") {
    return path.map((seg, i) => (typeof seg === "number" ? `[${seg}]` : i === 0 ? seg : `.${seg}`)).join("");
  }
  const [, index, field] = path;
  const entry = (json as { libraries?: unknown[] } | null)?.libraries?.[index] as { name?: unknown } | undefined;
  return configLocator(index, String(field), entry?.name);
}

/** Drop a leading UTF-8 BOM (editors on Windows write one; JSON.parse rejects it). */
function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * `invalid JSON at line L column C` — the position, and NOTHING from the file (S1). Every
 * V8 syntax-error message quotes a run of the offending source ("Unexpected token 'S',
 * \"SECRET=hun\"... is not valid JSON"), so the message itself is discarded: a config path
 * is user-supplied and may name a `.env`, an id_rsa or any other file whose bytes must not
 * reach a log. Line/column come from the parser's own position when it reports one (every
 * supported Node does; Node 20+ also prints them itself).
 */
function jsonErrorMessage(text: string, err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const at = /at position (\d+)/.exec(raw);
  if (!at) return "invalid JSON";
  const pos = Math.min(Number(at[1]), text.length);
  const before = text.slice(0, pos);
  const lastBreak = before.lastIndexOf("\n");
  return `invalid JSON at line ${before.split("\n").length} column ${pos - lastBreak}`;
}

/**
 * Read and validate one config file. `display` is what the message names it (the caller may
 * pass a cwd-relative form); everything it throws is a single line safe to print.
 */
export function readConfigFile(path: string, display: string = path): { libraries: LibraryEntry[] } {
  const st = statSync(path, { throwIfNoEntry: false });
  if (st === undefined) throw new ConfigError(display, "not found");
  if (!st.isFile()) throw new ConfigError(display, "not a regular file");
  if (st.size > MAX_CONFIG_BYTES) throw new ConfigError(display, "larger than 1 MiB");
  const text = stripBom(readFileSync(path, "utf8"));
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (e) {
    throw new ConfigError(display, jsonErrorMessage(text, e));
  }
  const parsed = ConfigSchema.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issueLocator(issue.path, json);
    throw new ConfigError(display, `${where === "" ? "" : `${where}: `}${issue.message}`);
  }
  return { libraries: (parsed.data.libraries ?? []) as LibraryEntry[] };
}
