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

/**
 * PAR-652c review R4. README promised "every fetch failure" a line, and the two outcomes a
 * user is most likely to need explained — the SSRF guard refusing a redirect, and a document
 * over the byte cap — returned silently. From the outside they are indistinguishable from a
 * 404: the library simply is not cached. These cases pin one line per refusal and per
 * over-size, and pin that the OUTCOME each caller sees is byte-for-byte what it always was.
 */
describe("fetchUrl diagnostics: a refusal and an over-size document each get their own line", () => {
  /** The `reason=` of the single line carrying `event`, or undefined when none was logged. */
  function reasonOf(event: string): string | undefined {
    const line = lines.find((l) => l.includes(event));
    return line === undefined ? undefined : /reason=([^\s]+)/.exec(line)?.[1];
  }
  const redirectTo = (location: string) =>
    vi.fn(async () => new Response(null, { status: 302, headers: { location } }));

  it("a redirect to a non-public host logs fetch.refused reason=redirect-host naming the target", async () => {
    process.env.VIBECTX_DEBUG = "1";
    vi.stubGlobal("fetch", redirectTo("http://127.0.0.1/secret"));
    expect(await fetchOnce()).toEqual({ status: "refused" });
    expect(reasonOf("fetch.refused")).toBe("redirect-host");
    expect(lines.join("")).toContain("to=http://127.0.0.1/secret");
    expect(lines.join("")).toContain("status=302");
  });

  it("a content-derived first URL that is not public https is refused before any request", async () => {
    process.env.VIBECTX_DEBUG = "1";
    const spy = vi.fn(async () => new Response("never", { status: 200 }));
    vi.stubGlobal("fetch", spy);
    expect(await fetchUrl("http://169.254.169.254/latest", { maxBytes: PRIMARY_DOC_MAX_BYTES, publicFinalUrl: true })).toEqual({
      status: "refused",
    });
    expect(reasonOf("fetch.refused")).toBe("not-public");
    expect(spy).not.toHaveBeenCalled(); // the diagnostic did not cost a request
  });

  it("a followed link leaving its source origin logs fetch.refused reason=link-policy", async () => {
    process.env.VIBECTX_DEBUG = "1";
    vi.stubGlobal("fetch", vi.fn(async () => new Response("stolen", { status: 200 })));
    expect(
      await fetchUrl("https://elsewhere.example/page.md", {
        maxBytes: PRIMARY_DOC_MAX_BYTES,
        linkGuard: { sourceUrl: "https://example.com/llms.txt" },
      }),
    ).toEqual({ status: "refused" });
    expect(reasonOf("fetch.refused")).toBe("link-policy");
  });

  it("a declared Content-Length over the cap logs fetch.too-large with the size and the limit", async () => {
    process.env.VIBECTX_DEBUG = "1";
    vi.stubGlobal("fetch", vi.fn(async () => new Response("x", { status: 200, headers: { "content-length": "99999999" } })));
    expect(await fetchUrl(URL_UNDER_TEST, { maxBytes: 1000 })).toEqual({ status: "too-large" });
    expect(reasonOf("fetch.too-large")).toBe("content-length");
    expect(lines.join("")).toContain("bytes=99999999");
    expect(lines.join("")).toContain("limit=1000");
  });

  it("an undeclared body that overruns the cap mid-stream logs reason=body-cap and no size", async () => {
    process.env.VIBECTX_DEBUG = "1";
    vi.stubGlobal("fetch", vi.fn(async () => new Response("y".repeat(5000), { status: 200, headers: { "content-type": "text/plain" } })));
    expect(await fetchUrl(URL_UNDER_TEST, { maxBytes: 100 })).toEqual({ status: "too-large" });
    expect(reasonOf("fetch.too-large")).toBe("body-cap");
    expect(lines.join("")).toContain("limit=100");
    expect(lines.join("")).not.toContain("bytes="); // the true size is unknown; it is not guessed
  });

  it("a redirect with no Location, and one past the hop limit, are two different misses", async () => {
    process.env.VIBECTX_DEBUG = "1";
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 302 })));
    expect(await fetchOnce()).toEqual({ status: "miss" });
    expect(loggedReason()).toBe("redirect-no-location");

    lines = [];
    let hops = 0;
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 302, headers: { location: `https://example.com/${hops++}` } })));
    expect(await fetchOnce()).toEqual({ status: "miss" });
    expect(loggedReason()).toBe("redirect-hops");
  });

  it("the diagnostics are additive: with VIBECTX_DEBUG unset every outcome is identical and silent", async () => {
    delete process.env.VIBECTX_DEBUG;
    vi.stubGlobal("fetch", redirectTo("http://127.0.0.1/secret"));
    expect(await fetchOnce()).toEqual({ status: "refused" });
    vi.stubGlobal("fetch", vi.fn(async () => new Response("x", { status: 200, headers: { "content-length": "99999999" } })));
    expect(await fetchUrl(URL_UNDER_TEST, { maxBytes: 1000 })).toEqual({ status: "too-large" });
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
