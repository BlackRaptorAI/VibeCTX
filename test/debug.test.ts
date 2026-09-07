import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyFetchError, debugEnabled, debugEvent, debugField } from "../src/debug.js";
import { fetchUrl, PRIMARY_DOC_MAX_BYTES } from "../src/fetcher.js";

/**
 * PAR-652 item 7b — `VIBECTX_DEBUG=1`. The point of the feature is that a 404, a timeout
 * and a DNS failure stop looking identical, so the tests below assert exactly that: the
 * three produce three different `reason=` values, while the OUTCOME each caller sees is
 * still the same `miss` it was before.
 */

let dir: string;
let lines: string[];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "vibectx-debug-"));
  process.env.VIBECTX_CACHE_DIR = dir;
  lines = [];
  vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
    lines.push(String(chunk));
    return true;
  });
});
afterEach(() => {
  delete process.env.VIBECTX_CACHE_DIR;
  delete process.env.VIBECTX_DEBUG;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  rmSync(dir, { recursive: true, force: true });
});

const URL_UNDER_TEST = "https://example.com/llms.txt";
const fetchOnce = () => fetchUrl(URL_UNDER_TEST, { maxBytes: PRIMARY_DOC_MAX_BYTES });

/** The `reason=` of the single fetch.miss line, or undefined when nothing was logged. */
function loggedReason(): string | undefined {
  const line = lines.find((l) => l.includes("fetch.miss"));
  return line === undefined ? undefined : /reason=([^\s]+)/.exec(line)?.[1];
}

describe("debugEnabled", () => {
  it("is off unless explicitly turned on", () => {
    expect(debugEnabled({})).toBe(false);
    expect(debugEnabled({ VIBECTX_DEBUG: "0" })).toBe(false);
    expect(debugEnabled({ VIBECTX_DEBUG: "false" })).toBe(false);
    expect(debugEnabled({ VIBECTX_DEBUG: "" })).toBe(false);
  });

  it("accepts the obvious spellings of on", () => {
    for (const v of ["1", "true", "TRUE", "yes", "on", " 1 "]) {
      expect(debugEnabled({ VIBECTX_DEBUG: v })).toBe(true);
    }
  });
});

describe("debugField", () => {
  it("strips control and bidi characters — a debug line must not drive a terminal", () => {
    expect(debugField("https://x/[2Ka‮b")).toBe("https://x/[2Kab");
  });

  it("quotes a value containing whitespace, and clips a long one", () => {
    expect(debugField("two words")).toBe('"two words"');
    expect(debugField("x".repeat(400)).length).toBeLessThanOrEqual(302);
  });
});

describe("classifyFetchError", () => {
  it("separates a timeout, a DNS failure and a refused connection", () => {
    const timeout = new Error("The operation was aborted due to timeout");
    timeout.name = "TimeoutError";
    expect(classifyFetchError(timeout).reason).toBe("timeout");

    const dns = new TypeError("fetch failed", { cause: Object.assign(new Error("getaddrinfo ENOTFOUND example.com"), { code: "ENOTFOUND" }) });
    expect(classifyFetchError(dns)).toMatchObject({ reason: "dns", code: "ENOTFOUND" });

    const refused = new TypeError("fetch failed", { cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }) });
    expect(classifyFetchError(refused).reason).toBe("connection-refused");
  });

  it("falls back to `network` rather than guessing", () => {
    expect(classifyFetchError(new TypeError("fetch failed")).reason).toBe("network");
  });
});

describe("fetchUrl diagnostics: a 404, a timeout and a DNS failure are three different lines", () => {
  it("a 404 logs reason=http-status with the status, and still returns miss", async () => {
    process.env.VIBECTX_DEBUG = "1";
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 404 })));
    expect(await fetchOnce()).toEqual({ status: "miss" });
    expect(loggedReason()).toBe("http-status");
    expect(lines.join("")).toContain("status=404");
  });

  it("a timeout logs reason=timeout, and still returns miss", async () => {
    process.env.VIBECTX_DEBUG = "1";
    vi.stubGlobal("fetch", vi.fn(async () => {
      const e = new Error("The operation was aborted due to timeout");
      e.name = "TimeoutError";
      throw e;
    }));
    expect(await fetchOnce()).toEqual({ status: "miss" });
    expect(loggedReason()).toBe("timeout");
  });

  it("a DNS failure logs reason=dns with the code, and still returns miss", async () => {
    process.env.VIBECTX_DEBUG = "1";
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new TypeError("fetch failed", { cause: Object.assign(new Error("getaddrinfo ENOTFOUND example.com"), { code: "ENOTFOUND" }) });
    }));
    expect(await fetchOnce()).toEqual({ status: "miss" });
    expect(loggedReason()).toBe("dns");
    expect(lines.join("")).toContain("code=ENOTFOUND");
  });

  it("an HTML 200 and an empty body are distinguishable from both", async () => {
    process.env.VIBECTX_DEBUG = "1";
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<!doctype html><h1>404</h1>", { status: 200, headers: { "content-type": "text/html" } })));
    expect(await fetchOnce()).toEqual({ status: "miss" });
    expect(loggedReason()).toBe("html-not-text");

    lines = [];
    vi.stubGlobal("fetch", vi.fn(async () => new Response("   ", { status: 200, headers: { "content-type": "text/plain" } })));
    expect(await fetchOnce()).toEqual({ status: "miss" });
    expect(loggedReason()).toBe("empty-body");
  });

  it("logs nothing at all when VIBECTX_DEBUG is not set, and the outcome is identical", async () => {
    delete process.env.VIBECTX_DEBUG;
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 404 })));
    expect(await fetchOnce()).toEqual({ status: "miss" });
    expect(lines).toEqual([]);
  });

  it("a successful fetch is unchanged and unlogged", async () => {
    process.env.VIBECTX_DEBUG = "1";
    vi.stubGlobal("fetch", vi.fn(async () => new Response("# doc", { status: 200, headers: { "content-type": "text/plain" } })));
    expect(await fetchOnce()).toMatchObject({ status: "ok", body: "# doc" });
    expect(lines).toEqual([]);
  });
});

describe("debugEvent", () => {
  it("renders one line of key=value pairs and drops undefined fields", () => {
    const out: string[] = [];
    debugEvent("fetch.miss", { url: "https://x/y", code: undefined, ms: 12 }, { env: { VIBECTX_DEBUG: "1" }, write: (l) => out.push(l) });
    expect(out).toEqual(["vibectx [debug] fetch.miss url=https://x/y ms=12\n"]);
  });
});

/**
 * PAR-652b — the additive claim, enforced instead of asserted.
 *
 * `debug.ts` and `fetcher.ts:107` both say a diagnostic can never change a return value.
 * The security gate measured that it could: with `VIBECTX_DEBUG=1` and a `process.stderr.write`
 * that throws (a closed or full stderr — a piped MCP client that went away), the `debugEvent`
 * in `fetchUrl`'s catch block threw out of the catch block, so a DNS failure came back as an
 * exception instead of `{ status: "miss" }`.
 *
 * The fix is in `debugEvent` itself rather than at that one call site: it is the only place
 * that makes EVERY caller safe, present and future, and "diagnostics that can alter behaviour
 * are not diagnostics" is a property of the diagnostic, not of who calls it.
 */
describe("a diagnostic can never change what a caller sees", () => {
  it("debugEvent swallows a stderr that throws", () => {
    expect(() =>
      debugEvent(
        "fetch.miss",
        { url: "https://x/y" },
        {
          env: { VIBECTX_DEBUG: "1" },
          write: () => {
            throw new Error("EPIPE: broken pipe");
          },
        },
      ),
    ).not.toThrow();
  });

  it("debugEvent swallows a field that throws while being rendered", () => {
    const hostile = { toString() { throw new Error("nope"); } } as unknown as string;
    const out: string[] = [];
    expect(() =>
      debugEvent("fetch.miss", { url: hostile }, { env: { VIBECTX_DEBUG: "1" }, write: (l) => out.push(l) }),
    ).not.toThrow();
  });

  it("a DNS failure still returns miss when writing the diagnostic throws", async () => {
    process.env.VIBECTX_DEBUG = "1";
    (process.stderr.write as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error("EPIPE: broken pipe");
    });
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new TypeError("fetch failed", { cause: Object.assign(new Error("getaddrinfo ENOTFOUND example.com"), { code: "ENOTFOUND" }) });
    }));
    await expect(fetchOnce()).resolves.toEqual({ status: "miss" });
  });

  it("a 404 still returns miss when writing the diagnostic throws", async () => {
    process.env.VIBECTX_DEBUG = "1";
    (process.stderr.write as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error("EPIPE: broken pipe");
    });
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 404 })));
    await expect(fetchOnce()).resolves.toEqual({ status: "miss" });
  });
});
