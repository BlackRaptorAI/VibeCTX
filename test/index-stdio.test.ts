import { describe, it, expect, afterEach, beforeAll } from "vitest";
import { spawn, execFileSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * A10 — the one file no other test executes: `src/index.ts`, compiled to `dist/index.js`
 * and launched exactly as an MCP client launches it — `spawn(node, [dist/index.js])`, real
 * stdin/stdout, no `InMemoryTransport`. `test/server.test.ts` proves the tool set and the
 * autowarm/close wiring against `startServer` directly; this file proves the process wrapped
 * around it: the top-level `await dispatchCli`, `process.exitCode` on a subcommand, the
 * `process.exit(2)` config-error path (index.ts:40), and — the one no other test can reach —
 * `process.stdin.once("end", …)` (index.ts:46) actually ending a REAL process's REAL stdin,
 * observed as an `exit` event, never a sleep.
 *
 * Requires `dist/index.js`, built fresh by the `beforeAll` below — NOT "as CI does": CI's own
 * `.github/workflows/ci.yml` runs `npm test` BEFORE `npm run build`, so on a clean checkout
 * `dist/` does not exist yet when this file runs. `dist/` is also gitignored, so nothing here
 * can assume a prior manual build either. The `beforeAll` builds unconditionally (not just
 * when `dist/index.js` is missing) so a stale local `dist/` — built from an older `src/` —
 * can never produce a false-positive pass.
 *
 * Handshake: written by hand rather than through the SDK's `Client` / `StdioClientTransport`,
 * because the client transport's own `close()` races a 2 s timeout and falls back to
 * `SIGTERM`/`SIGKILL` — exactly the ambiguity this test exists to remove. Talking newline-
 * delimited JSON-RPC directly means the only thing that ends the child's stdin is the single
 * `child.stdin.end()` call below, and the only thing that ends the child is index.ts's own
 * `"end"` handler.
 */

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const DIST_INDEX = fileURLToPath(new URL("../dist/index.js", import.meta.url));

beforeAll(() => {
  // Budget generously: the reviewer measured ~1 s locally, but a cold/loaded CI runner (fresh
  // `npm ci`, no TS build cache, shared CPU) can be much slower — this is not a hot path.
  execFileSync("npm", ["run", "build"], { cwd: REPO_ROOT, stdio: "inherit" });
}, 120_000);

/** How long after `child.stdin.end()` an exit driven only by index.ts's own shutdown path
 *  (index.ts:13 `CLOSE_GRACE_MS = 100`, index.ts:46-49) may take. No autowarm fetch is ever
 *  in flight in these tests (`VIBECTX_NO_AUTOWARM=1`), so the 100 ms grace timer itself is
 *  never armed and a real exit lands in single-digit milliseconds — [MEASURED] 2-6 ms across
 *  30 repeated runs on the machine this was authored on. This ceiling is 3x CLOSE_GRACE_MS
 *  (~75-100x the locally measured value) to absorb OS process-teardown jitter on a loaded CI
 *  box without excusing a real hang; see the assertion's own [MEASURED] print for what
 *  actually happened on this run. */
const EXIT_CEILING_MS = 300;

interface Rpc {
  jsonrpc: "2.0";
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string };
}

/** Minimal newline-delimited JSON-RPC pump over a child's stdio — the same framing
 *  `@modelcontextprotocol/sdk`'s `shared/stdio.js` uses (`JSON.stringify(msg) + "\n"`, split
 *  on the next `\n`), reimplemented here so nothing but the child's own code can end it.
 *
 *  A pending `nextMessage()` must never dangle: if the child dies (or a stdout line can't be
 *  parsed as JSON) before it answers, every outstanding and future waiter rejects immediately
 *  with the collected stderr attached, instead of hanging until vitest's own test timeout
 *  reports an opaque "Test timed out in 8000ms" with the real cause discarded. */
function frame(child: ChildProcessWithoutNullStreams) {
  let buf = Buffer.alloc(0);
  let stderr = "";
  child.stderr.on("data", (d: Buffer) => (stderr += d.toString("utf8")));

  const pending: { resolve: (msg: Rpc) => void; reject: (err: Error) => void }[] = [];
  const queued: Rpc[] = [];
  let dead: Error | undefined;

  function fail(err: Error): void {
    if (dead) return; // already dead; don't overwrite the first cause
    dead = err;
    while (pending.length > 0) pending.shift()!.reject(err);
  }

  child.stdout.on("data", (chunk: Buffer) => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      const nl = buf.indexOf("\n");
      if (nl === -1) break;
      const line = buf.subarray(0, nl).toString("utf8");
      buf = buf.subarray(nl + 1);
      if (line.trim().length === 0) continue;
      let msg: Rpc;
      try {
        msg = JSON.parse(line) as Rpc;
      } catch (err) {
        fail(new Error(`malformed JSON-RPC line on child stdout: ${JSON.stringify(line)} (${(err as Error).message})`));
        return;
      }
      // Skip server-initiated notifications (a "method" with no "id") rather than matching
      // send/receive order blindly — nothing in src/ sends one today, but this keeps
      // nextMessage()'s FIFO correlation safe against one appearing later.
      if (msg.id === undefined && msg.method !== undefined) continue;
      const waiter = pending.shift();
      if (waiter) waiter.resolve(msg);
      else queued.push(msg);
    }
  });

  child.once("exit", (code, signal) => {
    fail(new Error(`child exited (code=${code}, signal=${signal}) before answering; stderr: ${stderr || "<empty>"}`));
  });
  child.once("error", (err) => {
    fail(new Error(`child process error: ${err.message}; stderr: ${stderr || "<empty>"}`));
  });

  return {
    send(msg: Rpc): void {
      child.stdin.write(`${JSON.stringify(msg)}\n`);
    },
    nextMessage(): Promise<Rpc> {
      const already = queued.shift();
      if (already) return Promise.resolve(already);
      if (dead) return Promise.reject(dead);
      return new Promise((resolve, reject) => pending.push({ resolve, reject }));
    },
    /** stderr collected so far — used instead of a second, redundant listener on the caller's side. */
    stderr(): string {
      return stderr;
    },
  };
}

let cwd: string | undefined;
let home: string | undefined;
let cache: string | undefined;
let liveChild: ChildProcessWithoutNullStreams | undefined;

afterEach(async () => {
  // Belt and braces: an assertion that throws mid-test must not leave a spawned server
  // running against the next test's (deleted) temp directories.
  if (liveChild && liveChild.exitCode === null && liveChild.signalCode === null) {
    const child = liveChild;
    const reaped = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    child.kill("SIGKILL");
    // Bounded: SIGKILL reaping should be near-instant, but never let a slow OS scheduler turn
    // this into an indefinite hang in an already-failed test's cleanup.
    await Promise.race([reaped, new Promise((resolve) => setTimeout(resolve, 500))]);
  }
  liveChild = undefined;
  for (const d of [cwd, home, cache]) if (d) rmSync(d, { recursive: true, force: true });
  cwd = home = cache = undefined;
});

/** Isolated HOME / XDG-less / cache dirs and a cwd with neither `.git` nor a config file
 *  above it (Q1, as in test/cli.test.ts) — so config discovery lands on "shipped defaults"
 *  regardless of what is on the machine actually running the suite, and the autowarm never
 *  reaches the network (`VIBECTX_NO_AUTOWARM=1`). */
function sandboxEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  cwd = mkdtempSync(join(tmpdir(), "vibectx-stdio-cwd-"));
  home = mkdtempSync(join(tmpdir(), "vibectx-stdio-home-"));
  cache = mkdtempSync(join(tmpdir(), "vibectx-stdio-cache-"));
  return {
    PATH: process.env.PATH,
    HOME: home,
    VIBECTX_CACHE_DIR: cache,
    VIBECTX_NO_AUTOWARM: "1",
    ...extra,
  };
}

describe("spawn(node, [dist/index.js]) — the real stdio process (A10)", () => {
  it(
    "answers tools/list with the 7 registered tools, then exits promptly and cleanly when stdin ends",
    async () => {
      const env = sandboxEnv();
      const child = spawn(process.execPath, [DIST_INDEX], { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
      liveChild = child;
      const io = frame(child);

      io.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "a10-probe", version: "0" } } });
      const initResponse = await io.nextMessage();
      expect(initResponse.id).toBe(1);
      expect(initResponse.error).toBeUndefined();
      expect((initResponse.result as { serverInfo?: { name?: string } } | undefined)?.serverInfo?.name).toBe("vibectx");

      io.send({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
      io.send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
      const toolsResponse = await io.nextMessage();
      expect(toolsResponse.id).toBe(2);
      expect(toolsResponse.error).toBeUndefined();
      const tools = (toolsResponse.result as { tools: { name: string }[] }).tools.map((t) => t.name).sort();
      expect(tools).toEqual(["doctor", "get_docs", "list_libraries", "refresh", "resolve_library", "search", "warm_project"]);

      // index.ts:46 — process.stdin.once("end", () => void started.server.close()). Ending the
      // REAL child's REAL stdin is the only thing that can exercise this line; nothing here
      // sends a signal.
      const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
        child.once("exit", (code, signal) => resolve({ code, signal }));
      });
      const closeStart = Date.now();
      child.stdin.end();
      const { code, signal } = await exited;
      const exitElapsedMs = Date.now() - closeStart;
      console.log(`[A10 MEASURED] exit ${exitElapsedMs} ms after stdin.end() (CLOSE_GRACE_MS mirror: 100 ms, ceiling: ${EXIT_CEILING_MS} ms)`);

      // A clean shutdown: no signal (nothing here killed it — index.ts's own "end" handler and
      // event-loop drain did), exit code 0, and no stderr noise.
      expect(signal).toBeNull();
      expect(code).toBe(0);
      expect(exitElapsedMs).toBeLessThan(EXIT_CEILING_MS);
      expect(io.stderr()).toBe("");
    },
    8000,
  );

  it(
    "a broken --config exits 2 with exactly one stderr line and never a stack",
    async () => {
      const env = sandboxEnv();
      const badConfig = join(cwd!, "does-not-exist.json");
      const child = spawn(process.execPath, [DIST_INDEX, "--config", badConfig], { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
      liveChild = child;
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d: Buffer) => (stdout += d.toString("utf8")));
      child.stderr.on("data", (d: Buffer) => (stderr += d.toString("utf8")));

      const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
        child.once("exit", (code, signal) => resolve({ code, signal }));
      });
      const { code, signal } = await exited;

      expect(signal).toBeNull();
      expect(code).toBe(2); // index.ts:40 — process.exit(2) on ConfigError
      expect(stdout).toBe(""); // the transport is never connected on this path
      const lines = stderr.split("\n").filter((l) => l.length > 0);
      expect(lines).toHaveLength(1); // one line, never a stack (index.ts:37-39)
      expect(lines[0]).toContain("does-not-exist.json");
      expect(lines[0]).toContain("not found");
      expect(stderr).not.toMatch(/\n\s+at\s/); // a Node stack trace's own line shape
      expect(stderr).not.toContain(".js:"); // no source-location noise from an uncaught throw
    },
    8000,
  );
});
