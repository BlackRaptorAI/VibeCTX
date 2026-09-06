#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadRegistry } from "./registry.js";
import { dispatchCli } from "./cli.js";
import { startServer } from "./server.js";
import { autowarmStatus } from "./autowarm.js";

/** How long after the client closes stdin an in-flight autowarm fetch may keep the process
 *  alive before it is ended (R4). The timer is unref'd: when nothing is in flight the loop
 *  drains and the process exits naturally, sooner. Cache writes are atomic (temp + rename),
 *  so ending the process mid-fetch leaves nothing torn. ASSUMED. */
const CLOSE_GRACE_MS = 100;

// `vibectx doctor [...]` / `vibectx resolve <name>` / `vibectx warm [dir]` run and exit
// with their code; anything else starts the MCP stdio server exactly as before.
const cliExit = await dispatchCli(process.argv, {
  stdout: (s) => process.stdout.write(s),
  stderr: (s) => process.stderr.write(s),
});
if (cliExit !== undefined) {
  process.exitCode = cliExit;
} else {
  const configFlag = process.argv.indexOf("--config");
  const registry = loadRegistry(configFlag !== -1 ? process.argv[configFlag + 1] : undefined);
  const transport = new StdioServerTransport();
  const started = await startServer(registry, transport, { env: process.env });
  // The SDK's stdio transport does not watch for stdin ending; close the server ourselves so
  // the autowarm is aborted and a spawn-and-close client never leaves an orphan (R4).
  process.stdin.once("end", () => void started.server.close());
  void started.closed.then(() => {
    if (autowarmStatus().inFlight.size > 0) setTimeout(() => process.exit(0), CLOSE_GRACE_MS).unref();
  });
}
