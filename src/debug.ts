/**
 * PAR-652 item 7b — `VIBECTX_DEBUG=1` structured stderr diagnostics.
 *
 * `fetchUrl` collapses a 404, a connection timeout and a DNS failure into the same
 * `{ status: "miss" }`, which is right for the caller (all three mean "no document from
 * this URL") and useless for the person trying to work out why their library will not
 * cache. This module is the only place that difference is written down.
 *
 * It is ADDITIVE and nothing else: no call here changes a return value, a redirect
 * decision, a byte cap or a policy check. Diagnostics that can alter behaviour are not
 * diagnostics. That is ENFORCED, not asserted — `debugEvent` catches everything it can
 * raise, including a stderr that throws, so no call site can be made to fail by a
 * diagnostic (PAR-652b; see the note on `debugEvent`).
 *
 * Everything goes to STDERR. This process is a stdio MCP server: stdout carries the
 * protocol and a stray byte on it corrupts the session.
 *
 * THE LINE IS FOR A HUMAN, NOT A PARSER (PAR-652c, schema K2). `vibectx [debug] <event> k=v`
 * has a stable enough shape to read and to grep, and no stability guarantee beyond that: the
 * event names, the field set, the field ORDER and the `reason` vocabulary may all change in
 * any release, without a version bump and without a deprecation, because the whole point of a
 * diagnostic is to be improved the moment it fails to explain something. Nothing in this
 * product parses it, and nothing outside should either — the machine-readable surfaces are
 * `--json` on the CLI subcommands and the MCP tool payloads, which ARE versioned contracts.
 * If you need a fetch failure in a script, that is a feature request, not a `grep`.
 */

/** Longest a single field value is printed at; a URL from a fetched document is untrusted. */
const MAX_FIELD_CHARS = 300;

/** True only for an explicit opt-in. Anything else — including `0`, `false` and the empty
 *  string — leaves diagnostics off, so a variable someone set to `0` to disable them does
 *  not enable them. */
export function debugEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.VIBECTX_DEBUG;
  if (raw === undefined) return false;
  const v = raw.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

/** Strip C0/C1 and bidi controls and clip. A debug line carries URLs and error messages
 *  that came off the network; a terminal must not be able to be driven by one. */
export function debugField(value: string | number | undefined): string {
  if (value === undefined) return "-";
  const text = typeof value === "number" ? String(value) : value;
  const cleaned = text.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, "");
  const clipped = cleaned.length > MAX_FIELD_CHARS ? `${cleaned.slice(0, MAX_FIELD_CHARS)}…` : cleaned;
  return /[\s"]/.test(clipped) ? JSON.stringify(clipped) : clipped;
}

/**
 * One structured line: `vibectx [debug] <event> k=v k=v`. No-op unless VIBECTX_DEBUG is on.
 *
 * NEVER THROWS, and that is the feature (PAR-652b). "Additive and nothing else" was written
 * at the top of this file and at `fetcher.ts:107` as a claim about the call sites; the
 * security gate measured that it was not true — with `VIBECTX_DEBUG=1` and a
 * `process.stderr.write` that throws (a closed or full stderr: the piped MCP client went
 * away), the `debugEvent` in `fetchUrl`'s catch block threw out of the catch block and a DNS
 * failure surfaced as an exception instead of the `{ status: "miss" }` every caller is typed
 * to receive. A diagnostic that can turn a handled failure into an unhandled one is not
 * additive.
 *
 * The guard is HERE, not at that one call site, because this is the only place that makes
 * every caller safe — the ones that exist and the ones added later. The cost of losing a
 * debug line when stderr is broken is nothing; the cost of losing the return value is a
 * crash. Writing the line is the last thing done, so a throw mid-render cannot half-write one.
 */
export function debugEvent(
  event: string,
  fields: Record<string, string | number | undefined>,
  opts: { env?: NodeJS.ProcessEnv; write?: (line: string) => void } = {},
): void {
  try {
    if (!debugEnabled(opts.env ?? process.env)) return;
    const rendered = Object.entries(fields)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => `${k}=${debugField(v)}`)
      .join(" ");
    const line = `vibectx [debug] ${event}${rendered.length > 0 ? ` ${rendered}` : ""}\n`;
    (opts.write ?? ((s: string) => void process.stderr.write(s)))(line);
  } catch {
    // Deliberately silent: the only channel available to report a diagnostic failure is the
    // channel that just failed, and re-raising is the bug this catch exists to prevent.
  }
}

/** The thrown-error reasons, as data as well as a type — see `FETCH_DIAGNOSTIC_REASONS`. */
export const FETCH_FAILURE_REASONS = [
  "timeout",
  "aborted",
  "dns",
  "connection-refused",
  "connection-reset",
  "tls",
  "network",
] as const;

export type FetchFailureReason = (typeof FETCH_FAILURE_REASONS)[number];

/**
 * Every `reason=` value `fetchUrl` can emit, by event name — the ONE list, and the one the
 * README documents.
 *
 * It exists because the README and this module had drifted (PAR-652c, schema K2): the docs
 * enumerated nine values and the union exported ten. Prose and a type cannot be kept in step
 * by good intentions, so `test/debug.test.ts` reads the README's list and compares it to this
 * constant, and the behavioural cases in the same file prove each value is really emitted.
 * Adding a reason to the code and not to the docs now reds a test.
 */
export const FETCH_DIAGNOSTIC_REASONS: Readonly<Record<string, readonly string[]>> = {
  "fetch.miss": [
    "http-status",
    "html-not-text",
    "empty-body",
    "redirect-no-location",
    "redirect-hops",
    "redirect-unparsable",
    ...FETCH_FAILURE_REASONS,
  ],
  "fetch.refused": ["not-public", "redirect-host", "final-host", "link-policy"],
  "fetch.too-large": ["content-length", "body-cap"],
};

/**
 * Which kind of failure a thrown fetch error was. The three the brief names are the three
 * that matter most and they are genuinely different problems: a `timeout` is the host being
 * slow or a captive network, `dns` is a name that does not resolve (a typo, or no network
 * at all), and an HTTP status never reaches here — it is not a thrown error, so it is logged
 * separately at the point `fetchUrl` decides a response is a miss.
 *
 * `aborted` IS NOT REACHABLE TODAY (PAR-652c, schema K2), and is kept deliberately. The only
 * signal `fetchUrl` passes is `AbortSignal.timeout(20_000)`, whose rejection is a
 * `TimeoutError` and is claimed by the branch above; no caller passes an `AbortController`
 * into a fetch (the autowarm's controller stops it SCHEDULING further fetches — `src/
 * autowarm.ts` — it does not abort one in flight). Dropping the branch would not delete the
 * case, it would relabel it: the day a caller does pass a controller, an abort would arrive
 * here with no `code` on its cause chain and be reported as `network`, which is the wrong
 * answer to the only question this function exists to answer. It costs one line to be right
 * about it, and the README says plainly that no code path produces it yet.
 *
 * `fetch` wraps low-level failures in a `TypeError` whose `cause` carries the libuv code, so
 * the code is read from the cause chain rather than from the message text.
 */
export function classifyFetchError(error: unknown): { reason: FetchFailureReason; code?: string; message: string } {
  const message = error instanceof Error ? error.message : String(error);
  const name = error instanceof Error ? error.name : "";
  if (name === "TimeoutError") return { reason: "timeout", message };
  if (name === "AbortError") return { reason: "aborted", message };
  let code: string | undefined;
  let cursor: unknown = error;
  for (let depth = 0; depth < 5 && cursor !== undefined && cursor !== null; depth++) {
    const c = (cursor as { code?: unknown }).code;
    if (typeof c === "string") {
      code = c;
      break;
    }
    cursor = (cursor as { cause?: unknown }).cause;
  }
  switch (code) {
    case "ENOTFOUND":
    case "EAI_AGAIN":
      return { reason: "dns", code, message };
    case "ECONNREFUSED":
      return { reason: "connection-refused", code, message };
    case "ECONNRESET":
    case "EPIPE":
      return { reason: "connection-reset", code, message };
    default:
      break;
  }
  if (code !== undefined && (code.startsWith("ERR_TLS") || code.startsWith("CERT_") || code.includes("SSL"))) {
    return { reason: "tls", code, message };
  }
  if (name === "TimeoutError" || /timed? ?out/i.test(message)) return { reason: "timeout", code, message };
  return { reason: "network", code, message };
}
