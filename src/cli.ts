import { loadDiscoveredRegistry, type Registry } from "./registry.js";
import { ConfigError } from "./config.js";
import { runDoctor, formatDoctorTable, doctorExitCode } from "./doctor.js";
import { resolveToolText, type Ecosystem } from "./resolve.js";
import { runWarm, formatWarmTable, warmExitCode } from "./warm.js";
import { formatSearchResults, runSearch, searchExitCode, MAX_QUERY_CHARS, MAX_TOKENS_BUDGET } from "./search.js";

/**
 * Subcommand dispatch for the `vibectx` binary: `doctor`, `resolve`, `warm` and `search`;
 * anything else falls through to the MCP stdio server in index.ts. Kept transport- and
 * process-free so the dispatcher is unit-testable.
 */

export interface DoctorCliArgs {
  json: boolean;
  offline: boolean;
  library?: string;
  config?: string;
}

export interface ResolveCliArgs {
  name: string;
  ecosystem?: Ecosystem;
  config?: string;
}

export interface WarmCliArgs {
  json: boolean;
  offline: boolean;
  /** Retry names the project record marks unresolved within the last 24 h (R3). */
  force?: true;
  dir?: string;
  config?: string;
}

export interface SearchCliArgs {
  json: boolean;
  query: string;
  /** Repeatable `--library <name>`; empty means every cached library. */
  libraries: string[];
  maxTokens?: number;
  config?: string;
  /** D-41: the query was longer than MAX_QUERY_CHARS and was cut to it. */
  clipped?: true;
}

export interface CliIo {
  stdout(s: string): void;
  stderr(s: string): void;
}

export const DOCTOR_USAGE = "usage: vibectx doctor [--json] [--library <name>] [--config <path>] [--offline]";
export const RESOLVE_USAGE = "usage: vibectx resolve <package> [--npm | --pypi] [--config <path>]";
export const WARM_USAGE = "usage: vibectx warm [dir] [--offline] [--force] [--json] [--config <path>]";
export const SEARCH_USAGE =
  "usage: vibectx search <query> [--library <name>]… [--max-tokens <n>] [--json] [--config <path>]";

/** Parse the arguments after `doctor`. Throws on anything not in DOCTOR_USAGE. */
export function parseDoctorArgs(args: string[]): DoctorCliArgs {
  const parsed: DoctorCliArgs = { json: false, offline: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case "--json":
        parsed.json = true;
        break;
      case "--offline":
        parsed.offline = true;
        break;
      case "--library":
      case "--config": {
        const value = args[i + 1];
        if (value === undefined || value.startsWith("--")) throw new Error(`${arg} requires a value`);
        if (arg === "--library") parsed.library = value;
        else parsed.config = value;
        i += 1;
        break;
      }
      default:
        if (arg.startsWith("-")) throw new Error(`Unknown option "${arg}"`);
        throw new Error(`Unexpected argument "${arg}"`);
    }
  }
  return parsed;
}

/** Parse the arguments after `resolve`: one package name, `--npm` or `--pypi`, `--config`. */
export function parseResolveArgs(args: string[]): ResolveCliArgs {
  let name: string | undefined;
  let ecosystem: Ecosystem | undefined;
  let config: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case "--npm":
      case "--pypi": {
        const eco: Ecosystem = arg === "--npm" ? "npm" : "pypi";
        if (ecosystem !== undefined && ecosystem !== eco) throw new Error("--npm and --pypi are mutually exclusive");
        ecosystem = eco;
        break;
      }
      case "--config": {
        const value = args[i + 1];
        if (value === undefined || value.startsWith("--")) throw new Error(`${arg} requires a value`);
        config = value;
        i += 1;
        break;
      }
      default:
        if (arg.startsWith("-")) throw new Error(`Unknown option "${arg}"`);
        if (name !== undefined) throw new Error(`Unexpected argument "${arg}"`);
        name = arg;
    }
  }
  if (name === undefined) throw new Error("resolve requires a package name");
  const parsed: ResolveCliArgs = { name };
  if (ecosystem !== undefined) parsed.ecosystem = ecosystem;
  if (config !== undefined) parsed.config = config;
  return parsed;
}

/** Parse the arguments after `warm`: an optional directory, `--offline`, `--json`, `--config`. */
export function parseWarmArgs(args: string[]): WarmCliArgs {
  const parsed: WarmCliArgs = { json: false, offline: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case "--json":
        parsed.json = true;
        break;
      case "--offline":
        parsed.offline = true;
        break;
      case "--force":
        parsed.force = true;
        break;
      case "--config": {
        const value = args[i + 1];
        if (value === undefined || value.startsWith("--")) throw new Error(`${arg} requires a value`);
        parsed.config = value;
        i += 1;
        break;
      }
      default:
        if (arg.startsWith("-")) throw new Error(`Unknown option "${arg}"`);
        if (parsed.dir !== undefined) throw new Error(`Unexpected argument "${arg}"`);
        parsed.dir = arg;
    }
  }
  return parsed;
}

/**
 * Parse the arguments after `search` (PAR-659): one query — the words may be quoted as one
 * argument or left as several, because `vibectx search server-sent events streaming` is what a
 * person actually types — plus a repeatable `--library`, `--max-tokens`, `--json`, `--config`.
 *
 * A bare word is query text, never a flag: `--library` is the only way to name a library, so a
 * package called `warm` or `--json`-shaped text cannot be misread as one.
 */
export function parseSearchArgs(args: string[]): SearchCliArgs {
  const words: string[] = [];
  const parsed: SearchCliArgs = { json: false, query: "", libraries: [] };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case "--json":
        parsed.json = true;
        break;
      case "--library":
      case "--max-tokens":
      case "--config": {
        const value = args[i + 1];
        if (value === undefined || value.startsWith("--")) throw new Error(`${arg} requires a value`);
        if (arg === "--library") parsed.libraries.push(value);
        else if (arg === "--config") parsed.config = value;
        else {
          const n = Number(value);
          // A2 (PAR-715): the accepted RANGE is exactly the MCP schemas' — the integers in
          // (0, MAX_TOKENS_BUDGET] — so this path cannot admit a value get_docs/search would
          // reject. (Number() itself is looser than zod's — it reads "0x30" or "  4000  " —
          // but nothing outside that range gets through either way.)
          if (!Number.isInteger(n) || n <= 0 || n > MAX_TOKENS_BUDGET)
            throw new Error(`--max-tokens requires a positive whole number no greater than ${MAX_TOKENS_BUDGET}, not "${value}"`);
          parsed.maxTokens = n;
        }
        i += 1;
        break;
      }
      default:
        if (arg.startsWith("-")) throw new Error(`Unknown option "${arg}"`);
        words.push(arg);
    }
  }
  parsed.query = words.join(" ").trim();
  if (parsed.query.length === 0) throw new Error("search requires a query");
  // D-41: a shell can paste a megabyte. Clip rather than refuse — the first MAX_QUERY_CHARS
  // characters are still a searchable question — and say so, so nobody wonders why the tail
  // of what they typed had no effect. (`runSearch` bounds it again; this is what tells the
  // person at the terminal.)
  if (parsed.query.length > MAX_QUERY_CHARS) {
    parsed.query = parsed.query.slice(0, MAX_QUERY_CHARS);
    parsed.clipped = true;
  }
  return parsed;
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Every subcommand resolves its config the same way the stdio server does (PAR-657 D-14):
 * `--config` when given, else `VIBECTX_CONFIG`, else the project file found by walking up to
 * the git root, layered over the user file. Deprecation notes go to stderr, once.
 */
function registryFor(flag: string | undefined, io: CliIo): Registry {
  return loadDiscoveredRegistry({
    cwd: process.cwd(),
    env: process.env,
    flag,
    warn: (note) => io.stderr(`${note}\n`),
  });
}

/**
 * The one config-failure line (D-22, R1). A `ConfigError` already IS that line — file,
 * locator, message — so it is printed as it stands; printing the path again produced
 * `Could not load config ./x.json: ./x.json: …`. Anything else that escapes the loader
 * gets the prefix, because it may not name a file at all.
 */
function configError(e: unknown): string {
  return `${e instanceof ConfigError ? e.message : `could not load config: ${message(e)}`}\n`;
}

/** Run `vibectx doctor <args>`; returns the process exit code:
 *  0 all healthy · 1 something unhealthy · 2 usage / config / unknown-library error. */
export async function runDoctorCli(args: string[], io: CliIo): Promise<number> {
  let parsed: DoctorCliArgs;
  try {
    parsed = parseDoctorArgs(args);
  } catch (e) {
    io.stderr(`${message(e)}\n${DOCTOR_USAGE}\n`);
    return 2;
  }
  let registry;
  try {
    registry = registryFor(parsed.config, io);
  } catch (e) {
    io.stderr(configError(e));
    return 2;
  }
  let report;
  try {
    report = await runDoctor(registry, { library: parsed.library, offline: parsed.offline });
  } catch (e) {
    io.stderr(`${message(e)}\n`);
    return 2;
  }
  io.stdout(parsed.json ? `${JSON.stringify(report, null, 2)}\n` : `${formatDoctorTable(report)}\n`);
  return doctorExitCode(report);
}

/** Run `vibectx resolve <package>`; prints the same report the MCP tool returns.
 *  Exit 0 resolved (or already in the registry) · 1 could not resolve · 2 usage / config error. */
export async function runResolveCli(args: string[], io: CliIo): Promise<number> {
  let parsed: ResolveCliArgs;
  try {
    parsed = parseResolveArgs(args);
  } catch (e) {
    io.stderr(`${message(e)}\n${RESOLVE_USAGE}\n`);
    return 2;
  }
  let registry;
  try {
    registry = registryFor(parsed.config, io);
  } catch (e) {
    io.stderr(configError(e));
    return 2;
  }
  const text = await resolveToolText(registry, parsed.name, parsed.ecosystem);
  io.stdout(`${text}\n`);
  return text.startsWith("Could not resolve") ? 1 : 0;
}

/** Run `vibectx warm [dir]`; prints the table (or `--json`) on stdout.
 *  Exit 0 every attempted dependency cached · 1 something not cached · 2 usage / config / no-manifest error. */
export async function runWarmCli(args: string[], io: CliIo): Promise<number> {
  let parsed: WarmCliArgs;
  try {
    parsed = parseWarmArgs(args);
  } catch (e) {
    io.stderr(`${message(e)}\n${WARM_USAGE}\n`);
    return 2;
  }
  let registry;
  try {
    registry = registryFor(parsed.config, io);
  } catch (e) {
    io.stderr(configError(e));
    return 2;
  }
  let report;
  try {
    report = await runWarm(registry, { dir: parsed.dir, offline: parsed.offline, force: parsed.force === true, warn: io.stderr });
  } catch (e) {
    io.stderr(`${message(e)}\n`);
    return 2;
  }
  io.stdout(parsed.json ? `${JSON.stringify(report, null, 2)}\n` : `${formatWarmTable(report)}\n`);
  return warmExitCode(report);
}

/**
 * Run `vibectx search <query>`; prints the grouped results (or `--json`) on stdout.
 * Exit 0 at least one section returned · 1 nothing matched · 2 usage / config error.
 * Never touches the network (D-35), so there is no offline flag: it is always offline.
 */
export async function runSearchCli(args: string[], io: CliIo): Promise<number> {
  let parsed: SearchCliArgs;
  try {
    parsed = parseSearchArgs(args);
  } catch (e) {
    io.stderr(`${message(e)}\n${SEARCH_USAGE}\n`);
    return 2;
  }
  let registry;
  try {
    registry = registryFor(parsed.config, io);
  } catch (e) {
    io.stderr(configError(e));
    return 2;
  }
  if (parsed.clipped) io.stderr(`vibectx: the query was clipped to its first ${MAX_QUERY_CHARS} characters\n`);
  const outcome = runSearch(registry, {
    query: parsed.query,
    maxTokens: parsed.maxTokens,
    libraries: parsed.libraries.length > 0 ? parsed.libraries : undefined,
    // The clip happened at parse time, so `runSearch` cannot see it: the query it receives is
    // exactly at the bound. Carried in so the note lands in `outcome.notes` — a `--json`
    // consumer reads stdout and would otherwise have no way to know its tail was dropped, and
    // the stderr line above is for the person at the terminal, not for the machine.
    queryClipped: parsed.clipped,
    warn: io.stderr,
  });
  io.stdout(parsed.json ? `${JSON.stringify(outcome, null, 2)}\n` : `${formatSearchResults(outcome)}\n`);
  return searchExitCode(outcome);
}

const SUBCOMMANDS = new Set(["doctor", "resolve", "warm", "search"]);

/** Options whose VALUE must be skipped when looking for the subcommand token, so a library,
 *  package, directory or config path named "doctor" / "resolve" / "warm" / "search" is not
 *  mistaken for one. */
const OPTIONS_WITH_VALUES = new Set(["--config", "--library", "--max-tokens"]);

/** Index of the first subcommand token in argv, skipping option VALUES; -1 when absent. The
 *  FIRST token wins: `warm doctor` warms a directory named doctor, and `search warm` searches
 *  for the word "warm". */
function findSubcommand(argv: string[]): number {
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (OPTIONS_WITH_VALUES.has(arg)) {
      i += 1;
      continue;
    }
    if (SUBCOMMANDS.has(arg)) return i;
  }
  return -1;
}

/** `argv` is process.argv. Returns an exit code when a subcommand ran, or
 *  undefined when the caller should start the MCP server as before. The subcommand
 *  token may come before or after `--config <path>` (the README shows `--config`
 *  leading); without one anywhere, argv is left to the server path. */
export async function dispatchCli(argv: string[], io: CliIo): Promise<number | undefined> {
  const at = findSubcommand(argv);
  if (at === -1) return undefined;
  const rest = [...argv.slice(2, at), ...argv.slice(at + 1)];
  switch (argv[at]) {
    case "doctor":
      return runDoctorCli(rest, io);
    case "resolve":
      return runResolveCli(rest, io);
    case "search":
      return runSearchCli(rest, io);
    default:
      return runWarmCli(rest, io);
  }
}
