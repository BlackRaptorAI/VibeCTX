import { loadRegistry } from "./registry.js";
import { runDoctor, formatDoctorTable, doctorExitCode } from "./doctor.js";
import { resolveToolText, type Ecosystem } from "./resolve.js";
import { runWarm, formatWarmTable, warmExitCode } from "./warm.js";

/**
 * Subcommand dispatch for the `vibectx` binary: `doctor`, `resolve` and `warm`; anything
 * else falls through to the MCP stdio server in index.ts. Kept transport- and
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

export interface CliIo {
  stdout(s: string): void;
  stderr(s: string): void;
}

export const DOCTOR_USAGE = "usage: vibectx doctor [--json] [--library <name>] [--config <path>] [--offline]";
export const RESOLVE_USAGE = "usage: vibectx resolve <package> [--npm | --pypi] [--config <path>]";
export const WARM_USAGE = "usage: vibectx warm [dir] [--offline] [--force] [--json] [--config <path>]";

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

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
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
    registry = loadRegistry(parsed.config);
  } catch (e) {
    io.stderr(`Could not load config ${parsed.config}: ${message(e)}\n`);
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
    registry = loadRegistry(parsed.config);
  } catch (e) {
    io.stderr(`Could not load config ${parsed.config}: ${message(e)}\n`);
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
    registry = loadRegistry(parsed.config);
  } catch (e) {
    io.stderr(`Could not load config ${parsed.config}: ${message(e)}\n`);
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

const SUBCOMMANDS = new Set(["doctor", "resolve", "warm"]);

/** Index of the first subcommand token in argv, skipping option VALUES so a library,
 *  package or config path named "doctor" / "resolve" / "warm" is not mistaken for it; -1 when
 *  absent. The FIRST token wins: `warm doctor` warms a directory named doctor. */
function findSubcommand(argv: string[]): number {
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--config" || arg === "--library") {
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
    default:
      return runWarmCli(rest, io);
  }
}
