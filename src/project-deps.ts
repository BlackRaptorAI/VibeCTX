import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { normalisePyPiName } from "./package-names.js";

/**
 * Dependency discovery for `vibectx warm` (PAR-656): read a project directory's
 * manifests and return the package names it depends on, per ecosystem. Pure parsing
 * over local files — no network, no registry, no cache. The parsers are exported
 * one by one so each format is unit-tested on its own.
 *
 * What is read, in this order (each file once; names de-duplicated per ecosystem,
 * first occurrence wins):
 *   1. `package.json`      — `dependencies` then `devDependencies` (not peer / optional /
 *                            bundled). `npm:<real>@<range>` alias specs are unwrapped;
 *                            `file:` / `link:` / `workspace:` / `portal:` specs are local
 *                            packages and are skipped.
 *   2. `pyproject.toml`    — `[project].dependencies`, every `[project.optional-dependencies]`
 *                            group, every `[dependency-groups]` group (PEP 735),
 *                            `[tool.poetry.dependencies]`, `[tool.poetry.dev-dependencies]`,
 *                            `[tool.poetry.group.<g>.dependencies]` (`python` excluded).
 *   3. `requirements*.txt` — `requirements.txt` first, then the others sorted; versions,
 *                            extras, markers, comments and `\` continuations stripped; `-r` /
 *                            `--requirement` includes followed ONE level, relative to the
 *                            including file, and only inside the project directory;
 *                            `-c`, `-e`, options, URLs and paths skipped.
 *   4. Lockfiles, ONLY when the ecosystem's manifest is absent, for exact names:
 *                            `package-lock.json` v2/v3 (`packages[""]`; v1 has no root
 *                            list and is reported), `pnpm-lock.yaml` (`importers['.']`, or
 *                            the v5 top-level blocks). `yarn.lock`, `uv.lock` and
 *                            `poetry.lock` list every package with no cheap root marker and
 *                            are reported, not read.
 *
 * The TOML reader is deliberately minimal: table headers, `key = value` lines, string
 * arrays (multi-line), inline tables on one line, `#` comments outside strings. Not
 * handled (documented limit): dotted keys inside a table (`tool.poetry.dependencies.x = …`),
 * multi-line basic strings, and arrays of inline tables beyond `{ include-group = … }`
 * entries, which are skipped.
 *
 * PyPI names are returned in their PEP 503 form (`Typing_Extensions` → `typing-extensions`);
 * npm names as written (npm names are already lowercase). Nothing here validates names —
 * the resolver refuses anything that is not a package name before any network call.
 */

export type DependencyEcosystem = "npm" | "pypi";

export interface ProjectDependency {
  name: string;
  ecosystem: DependencyEcosystem;
  /** Manifest the name came from, relative to the project directory (forward slashes). */
  source: string;
}

export interface ProjectDiscovery {
  /** The directory as given (resolved to an absolute path by the caller when it matters). */
  dir: string;
  /** Manifests read, in read order, relative to `dir`. */
  manifests: string[];
  dependencies: ProjectDependency[];
  /** Files present but not read, includes skipped, parse failures — one plain line each. */
  notes: string[];
}

/**
 * Names `warm` reports as `denied (noise list)` and never fetches: build / lint / format
 * tooling nobody asks an agent for docs about, which would otherwise spend resolution
 * budget and network on every run. A trailing `*` is a prefix rule (`eslint*` covers
 * `eslint-config-next`); a bare entry is an exact match. PyPI entries are compared in
 * PEP 503 form. Kept deliberately: `typescript`, `pytest*`, `ruff`, `mypy` — people do ask
 * about those. Everything not listed here is attempted.
 */
export const DEPENDENCY_DENYLIST: Readonly<Record<DependencyEcosystem, readonly string[]>> = {
  npm: [
    "@types/*",
    "eslint*",
    "@eslint/*",
    "prettier*",
    "@typescript-eslint/*",
    "tslib",
    "@babel/*",
    "postcss",
    "autoprefixer",
    "husky",
    "lint-staged",
  ],
  pypi: ["setuptools*", "wheel", "pip", "build", "twine", "black"],
};

/** True when `name` matches a DEPENDENCY_DENYLIST rule for its ecosystem. */
export function isDeniedDependency(name: string, ecosystem: DependencyEcosystem): boolean {
  const key = ecosystem === "pypi" ? normalisePyPiName(name) : name.trim().toLowerCase();
  return DEPENDENCY_DENYLIST[ecosystem].some((rule) => (rule.endsWith("*") ? key.startsWith(rule.slice(0, -1)) : key === rule));
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

const LOCAL_SPEC = /^(file|link|workspace|portal):/;
/** `npm:<name>@<range>` — the name may be scoped (`npm:@scope/name@1`). */
const NPM_ALIAS_SPEC = /^npm:((?:@[^/@]+\/)?[^@]+)(?:@.*)?$/;

function pushUnique(list: string[], seen: Set<string>, name: string): void {
  if (name.length === 0 || seen.has(name)) return;
  seen.add(name);
  list.push(name);
}

/** package.json → npm names from `dependencies` then `devDependencies`. Throws on invalid JSON. */
export function parsePackageJsonDeps(text: string): string[] {
  const json: unknown = JSON.parse(text);
  const out: string[] = [];
  const seen = new Set<string>();
  if (!isRecord(json)) return out;
  for (const field of ["dependencies", "devDependencies"]) {
    const table = json[field];
    if (!isRecord(table)) continue;
    for (const [rawName, spec] of Object.entries(table)) {
      let name = rawName.trim();
      if (typeof spec === "string") {
        if (LOCAL_SPEC.test(spec)) continue;
        const alias = NPM_ALIAS_SPEC.exec(spec.trim());
        if (alias) name = alias[1];
      }
      pushUnique(out, seen, name);
    }
  }
  return out;
}

/** PEP 508 project name (PEP 503 normalised) from one requirement string; undefined for
 *  anything that is not a plain requirement: blank, comment, option, path, URL, `-e`. */
export function requirementName(spec: string): string | undefined {
  const s = stripComment(spec).trim();
  if (s.length === 0 || s.startsWith("-")) return undefined; // options: -r -c -e --index-url …
  if (/^(\.{1,2}[\\/]|[\\/]|[a-z]:[\\/])/i.test(s)) return undefined; // paths
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) return undefined; // URLs (https://, git+https://, file://)
  const m = /^([A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?)(?:\s*$|\s*[\[<>=!~;@(\s])/.exec(s);
  return m ? normalisePyPiName(m[1]) : undefined;
}

/** Drop a `#` comment that is not inside a quoted string. */
function stripComment(line: string): string {
  let quote: string | undefined;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote !== undefined) {
      if (c === quote) quote = undefined;
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === "#") {
      return line.slice(0, i);
    }
  }
  return line;
}

/** requirements.txt → names plus the `-r` / `--requirement` includes (paths as written). */
export function parseRequirementsTxt(text: string): { names: string[]; includes: string[] } {
  const names: string[] = [];
  const includes: string[] = [];
  const seen = new Set<string>();
  // Join `\` continuations first.
  const logical = text.replace(/\r\n?/g, "\n").replace(/\\\n\s*/g, " ").split("\n");
  for (const raw of logical) {
    const line = stripComment(raw).trim();
    const inc = /^(?:-r|--requirement)(?:\s+|=)(\S+)/.exec(line);
    if (inc) {
      includes.push(inc[1]);
      continue;
    }
    const name = requirementName(line);
    if (name) pushUnique(names, seen, name);
  }
  return { names, includes };
}

/* ------------------------------------------------------------------------- */
/* Minimal TOML                                                               */
/* ------------------------------------------------------------------------- */

interface TomlKeyValue {
  table: string;
  key: string;
  /** Raw value text with comments removed, joined across lines for arrays. */
  value: string;
}

/** Count `[` minus `]` outside quoted strings — used to join multi-line arrays. */
function bracketBalance(s: string): number {
  let depth = 0;
  let quote: string | undefined;
  for (const c of s) {
    if (quote !== undefined) {
      if (c === quote) quote = undefined;
    } else if (c === '"' || c === "'") quote = c;
    else if (c === "[") depth += 1;
    else if (c === "]") depth -= 1;
  }
  return depth;
}

function unquoteKey(key: string): string {
  const k = key.trim();
  if ((k.startsWith('"') && k.endsWith('"')) || (k.startsWith("'") && k.endsWith("'"))) return k.slice(1, -1);
  return k;
}

/** Scan a TOML document into `(table, key, value)` triples; tables from `[a.b]` / `[[a.b]]`
 *  headers; values kept as raw text (arrays joined across lines). Anything unparseable is skipped. */
function scanToml(text: string): TomlKeyValue[] {
  const out: TomlKeyValue[] = [];
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  let table = "";
  for (let i = 0; i < lines.length; i++) {
    const line = stripComment(lines[i]).trim();
    if (line.length === 0) continue;
    const header = /^\[\[?\s*([^\]]+?)\s*\]\]?$/.exec(line);
    if (header) {
      table = header[1]
        .split(".")
        .map(unquoteKey)
        .join(".");
      continue;
    }
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = unquoteKey(line.slice(0, eq));
    let value = line.slice(eq + 1).trim();
    let balance = bracketBalance(value);
    while (balance > 0 && i + 1 < lines.length) {
      i += 1;
      const next = stripComment(lines[i]).trim();
      value += ` ${next}`;
      balance += bracketBalance(next);
    }
    out.push({ table, key, value });
  }
  return out;
}

/** Every quoted string in a TOML array literal, in order (inline tables inside are ignored). */
function tomlStringArray(value: string): string[] {
  if (!value.startsWith("[")) return [];
  const items: string[] = [];
  let depth = 0; // inline-table depth: strings inside `{ … }` are not requirement specs
  let quote: string | undefined;
  let current = "";
  for (const c of value) {
    if (quote !== undefined) {
      if (c === quote) {
        quote = undefined;
        if (depth === 0) items.push(current);
        current = "";
      } else current += c;
    } else if (c === '"' || c === "'") quote = c;
    else if (c === "{") depth += 1;
    else if (c === "}") depth -= 1;
  }
  return items;
}

const POETRY_DEP_TABLE = /^tool\.poetry\.(dependencies|dev-dependencies|group\.[^.]+\.dependencies)$/;

/** pyproject.toml → PyPI names (PEP 503) from the dependency tables listed in the module comment. */
export function parsePyprojectDeps(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (spec: string) => {
    const name = requirementName(spec);
    if (name) pushUnique(out, seen, name);
  };
  for (const { table, key, value } of scanToml(text)) {
    if (table === "project" && key === "dependencies") tomlStringArray(value).forEach(add);
    else if (table === "project.optional-dependencies" || table === "dependency-groups") tomlStringArray(value).forEach(add);
    else if (POETRY_DEP_TABLE.test(table)) {
      if (key.toLowerCase() !== "python") add(key);
    }
  }
  return out;
}

/* ------------------------------------------------------------------------- */
/* Lockfiles                                                                  */
/* ------------------------------------------------------------------------- */

/** package-lock.json v2/v3 → the root package's dependencies + devDependencies; [] for v1
 *  (no root list) or anything unexpected. Throws on invalid JSON. */
export function parsePackageLockDeps(text: string): string[] {
  const json: unknown = JSON.parse(text);
  const out: string[] = [];
  const seen = new Set<string>();
  if (!isRecord(json) || !isRecord(json.packages) || !isRecord(json.packages[""])) return out;
  const root = json.packages[""];
  for (const field of ["dependencies", "devDependencies"]) {
    const table = root[field];
    if (!isRecord(table)) continue;
    for (const name of Object.keys(table)) pushUnique(out, seen, name.trim());
  }
  return out;
}

/** pnpm-lock.yaml → names under `importers: '.': dependencies / devDependencies` (v6+),
 *  or the top-level `dependencies:` / `devDependencies:` blocks (v5). Line-based: keys are
 *  the lines exactly one indentation step under the block header; quotes stripped. */
export function parsePnpmLockDeps(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const indentOf = (l: string) => l.length - l.trimStart().length;
  const collect = (start: number, blockIndent: number) => {
    // keys are the first lines strictly deeper than the block header, all at the same indent
    let keyIndent = -1;
    for (let i = start + 1; i < lines.length; i++) {
      const l = lines[i];
      if (l.trim().length === 0) continue;
      const ind = indentOf(l);
      if (ind <= blockIndent) return;
      if (keyIndent === -1) keyIndent = ind;
      if (ind !== keyIndent) continue;
      const m = /^\s*(['"]?)([^'":]+)\1\s*:/.exec(l);
      if (m) pushUnique(out, seen, m[2].trim());
    }
  };
  const BLOCK = /^\s*(dependencies|devDependencies)\s*:\s*$/;
  // v6+/v9: importers → '.' → blocks
  let importersAt = lines.findIndex((l) => /^importers\s*:\s*$/.test(l));
  if (importersAt !== -1) {
    for (let i = importersAt + 1; i < lines.length; i++) {
      const l = lines[i];
      if (l.trim().length === 0) continue;
      if (indentOf(l) === 0) break; // left the importers map
      if (/^\s+(['"]?)\.\1\s*:\s*$/.test(l)) {
        const dot = indentOf(l);
        let childIndent = -1;
        for (let j = i + 1; j < lines.length; j++) {
          const lj = lines[j];
          if (lj.trim().length === 0) continue;
          const ind = indentOf(lj);
          if (ind <= dot) break;
          if (childIndent === -1) childIndent = ind;
          if (ind === childIndent && BLOCK.test(lj)) collect(j, ind); // direct children of '.' only
        }
        break;
      }
    }
    return out;
  }
  // v5: top-level blocks
  for (let i = 0; i < lines.length; i++) {
    if (indentOf(lines[i]) === 0 && BLOCK.test(lines[i])) collect(i, 0);
  }
  return out;
}

/* ------------------------------------------------------------------------- */
/* Discovery                                                                  */
/* ------------------------------------------------------------------------- */

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function toPosix(p: string): string {
  return p.split(sep).join("/");
}

/** Read every manifest in `dir` (see the module comment for the order and the rules).
 *  Throws only when `dir` is not a directory; every per-file problem becomes a note. */
export function discoverProjectDependencies(dir: string): ProjectDiscovery {
  if (!isDirectory(dir)) throw new Error(`${dir} is not a directory`);
  const root = resolve(dir);
  const manifests: string[] = [];
  const dependencies: ProjectDependency[] = [];
  const notes: string[] = [];
  const seen = { npm: new Set<string>(), pypi: new Set<string>() };

  const addAll = (names: string[], ecosystem: DependencyEcosystem, source: string) => {
    for (const raw of names) {
      const name = ecosystem === "pypi" ? normalisePyPiName(raw) : raw;
      if (name.length === 0 || seen[ecosystem].has(name)) continue;
      seen[ecosystem].add(name);
      dependencies.push({ name, ecosystem, source });
    }
  };
  const read = (rel: string): string | undefined => {
    try {
      return readFileSync(join(root, rel), "utf8");
    } catch (e) {
      notes.push(`${rel}: could not read (${e instanceof Error ? e.message : String(e)})`);
      return undefined;
    }
  };
  const parseWith = <T>(rel: string, text: string, parse: (t: string) => T): T | undefined => {
    try {
      return parse(text);
    } catch (e) {
      notes.push(`${rel}: could not parse (${e instanceof Error ? e.message : String(e)})`);
      return undefined;
    }
  };

  // 1. package.json
  let npmManifest = false;
  if (isFile(join(root, "package.json"))) {
    const text = read("package.json");
    const names = text === undefined ? undefined : parseWith("package.json", text, parsePackageJsonDeps);
    if (names) {
      npmManifest = true;
      manifests.push("package.json");
      addAll(names, "npm", "package.json");
    }
  }

  // 2. pyproject.toml
  let pypiManifest = false;
  if (isFile(join(root, "pyproject.toml"))) {
    const text = read("pyproject.toml");
    if (text !== undefined) {
      pypiManifest = true;
      manifests.push("pyproject.toml");
      addAll(parsePyprojectDeps(text), "pypi", "pyproject.toml");
    }
  }

  // 3. requirements*.txt (+ one level of -r includes, inside the project only)
  const reqFiles = readdirSync(root)
    .filter((f) => /^requirements.*\.txt$/i.test(f) && isFile(join(root, f)))
    .sort((a, b) => (a === "requirements.txt" ? -1 : b === "requirements.txt" ? 1 : a.localeCompare(b)));
  const readRequirements = (rel: string, depth: number) => {
    if (manifests.includes(rel)) return;
    const text = read(rel);
    if (text === undefined) return;
    pypiManifest = true;
    manifests.push(rel);
    const { names, includes } = parseRequirementsTxt(text);
    addAll(names, "pypi", rel);
    for (const inc of includes) {
      if (depth >= 1) {
        notes.push(`${rel}: -r ${inc} is nested more than one level; skipped`);
        continue;
      }
      const target = resolve(root, dirname(rel), inc);
      const relTarget = relative(root, target);
      if (relTarget.startsWith("..") || resolve(root, relTarget) !== target) {
        notes.push(`${rel}: -r ${inc} is outside the project directory; skipped`);
        continue;
      }
      if (!isFile(target)) {
        notes.push(`${rel}: -r ${inc} not found; skipped`);
        continue;
      }
      readRequirements(toPosix(relTarget), depth + 1);
    }
  };
  for (const f of reqFiles) readRequirements(f, 0);

  // 4. Lockfiles — exact names only, and only when the manifest is absent.
  if (!npmManifest) {
    if (isFile(join(root, "package-lock.json"))) {
      const text = read("package-lock.json");
      const json = text === undefined ? undefined : parseWith("package-lock.json", text, (t) => JSON.parse(t) as unknown);
      if (isRecord(json) && json.lockfileVersion === 1) {
        notes.push("package-lock.json: lockfileVersion 1 has no root dependency list; skipped");
      } else if (text !== undefined && json !== undefined) {
        const names = parseWith("package-lock.json", text, parsePackageLockDeps);
        if (names) {
          manifests.push("package-lock.json");
          addAll(names, "npm", "package-lock.json");
        }
      }
    }
    if (isFile(join(root, "pnpm-lock.yaml"))) {
      const text = read("pnpm-lock.yaml");
      if (text !== undefined) {
        manifests.push("pnpm-lock.yaml");
        addAll(parsePnpmLockDeps(text), "npm", "pnpm-lock.yaml");
      }
    }
    if (isFile(join(root, "yarn.lock"))) {
      notes.push("yarn.lock: not read (it lists every package with no root marker); add a package.json");
    }
  }
  if (!pypiManifest) {
    const present = ["uv.lock", "poetry.lock"].filter((f) => isFile(join(root, f)));
    if (present.length > 0) {
      notes.push(`${present.join(", ")}: not read (Python lockfiles list every package); add a pyproject.toml or requirements.txt`);
    }
  }

  return { dir, manifests, dependencies, notes };
}

/** Exported for the CLI's usage text and the README: the files discovery looks at. */
export const MANIFEST_FILES = ["package.json", "pyproject.toml", "requirements*.txt", "package-lock.json", "pnpm-lock.yaml"] as const;

/** True when `dir` exists and holds at least one file discovery would read or report. */
export function hasAnyManifest(dir: string): boolean {
  if (!isDirectory(dir)) return false;
  if (["package.json", "pyproject.toml", "package-lock.json", "pnpm-lock.yaml", "yarn.lock", "uv.lock", "poetry.lock"].some((f) => existsSync(join(dir, f)))) return true;
  return readdirSync(dir).some((f) => /^requirements.*\.txt$/i.test(f));
}
