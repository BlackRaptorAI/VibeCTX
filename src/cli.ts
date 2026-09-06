import { loadRegistry } from "./registry.js";
import { runDoctor, formatDoctorTable, doctorExitCode } from "./doctor.js";

/**
 * Subcommand dispatch for the `vibectx` binary. Only `doctor` exists; anything
 * else falls through to the MCP stdio server in index.ts. Kept transport- and
 * process-free so the dispatcher is unit-testable.
 */

export interface DoctorCliArgs {
  json: boolean;
  offline: boolean;
  library?: string;
  config?: string;
}

export interface CliIo {
  stdout(s: string): void;
  stderr(s: string): void;
}

export const DOCTOR_USAGE = "usage: vibectx doctor [--json] [--library <name>] [--config <path>] [--offline]";

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

/** Index of the `doctor` subcommand token in argv, skipping option VALUES so a
 *  library or config path named "doctor" is not mistaken for it; -1 when absent. */
function findDoctorToken(argv: string[]): number {
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--config" || arg === "--library") {
      i += 1;
      continue;
    }
    if (arg === "doctor") return i;
  }
  return -1;
}

/** `argv` is process.argv. Returns an exit code when a subcommand ran, or
 *  undefined when the caller should start the MCP server as before. The `doctor`
 *  token may come before or after `--config <path>` (the README shows `--config`
 *  leading); without a `doctor` token anywhere, argv is left to the server path. */
export async function dispatchCli(argv: string[], io: CliIo): Promise<number | undefined> {
  const at = findDoctorToken(argv);
  if (at === -1) return undefined;
  return runDoctorCli([...argv.slice(2, at), ...argv.slice(at + 1)], io);
}
