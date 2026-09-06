import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseGitHubRepo,
  parseNpmMetadata,
  parsePyPiMetadata,
  synthesizeCandidates,
  resolvePackage,
  resolveToolText,
  couldNotResolveMessage,
  MAX_METADATA_FETCHES,
  MAX_LLMS_CANDIDATES,
  MAX_README_CANDIDATES,
  METADATA_MAX_BYTES,
  type PackageMetadata,
} from "../src/resolve.js";
import { readResolvedEntries } from "../src/resolved-store.js";
import { readCache } from "../src/cache.js";
import type { Registry } from "../src/registry.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "vibectx-resolve-"));
  process.env.DOCS_CACHE_DIR = dir;
});

afterEach(() => {
  delete process.env.DOCS_CACHE_DIR;
  rmSync(dir, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

const NPM_HONO = "https://registry.npmjs.org/hono/latest";
const NPM_HTTPX = "https://registry.npmjs.org/httpx/latest";
const PYPI_HTTPX = "https://pypi.org/pypi/httpx/json";

/** Stub fetch: JSON bodies for metadata URLs, text for documents, 404 for the rest. */
function stubFetch(routes: Record<string, unknown>) {
  const spy = vi.fn(async (url: unknown) => {
    const body = routes[String(url)];
    if (body === undefined) return new Response("not found", { status: 404 });
    if (typeof body === "string") return new Response(body, { status: 200, headers: { "content-type": "text/plain" } });
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  });
  vi.stubGlobal("fetch", spy);
  return spy;
}

const honoNpm = {
  name: "hono",
  description: "Web framework built on Web Standards",
  homepage: "https://hono.dev",
  repository: { type: "git", url: "git+https://github.com/honojs/hono.git" },
};

const httpxPyPi = {
  info: {
    name: "httpx",
    summary: "The next generation HTTP client.",
    home_page: null,
    project_urls: {
      Changelog: "https://github.com/encode/httpx/blob/master/CHANGELOG.md",
      Documentation: "https://www.python-httpx.org",
      Homepage: "https://github.com/encode/httpx",
      Source: "https://github.com/encode/httpx",
    },
  },
};

describe("parseGitHubRepo (every repository URL form npm and PyPI emit)", () => {
  it.each([
    ["git+https://github.com/honojs/hono.git", "honojs", "hono"],
    ["https://github.com/honojs/hono", "honojs", "hono"],
    ["https://github.com/honojs/hono/", "honojs", "hono"],
    ["https://github.com/honojs/hono#readme", "honojs", "hono"],
    ["https://github.com/honojs/hono/tree/main/packages/x", "honojs", "hono"],
    ["https://www.github.com/honojs/hono", "honojs", "hono"],
    ["git://github.com/honojs/hono.git", "honojs", "hono"],
    ["git@github.com:honojs/hono.git", "honojs", "hono"],
    ["ssh://git@github.com/honojs/hono.git", "honojs", "hono"],
    ["git+ssh://git@github.com/honojs/hono.git", "honojs", "hono"],
    ["github:honojs/hono", "honojs", "hono"],
    ["honojs/hono", "honojs", "hono"],
    ["https://github.com/TanStack/query.git", "TanStack", "query"],
    [{ type: "git", url: "git+https://github.com/honojs/hono.git" }, "honojs", "hono"],
    ["https://github.com/vercel/next.js", "vercel", "next.js"],
  ])("%s → %s/%s", (value, owner, repo) => {
    expect(parseGitHubRepo(value)).toEqual({ owner, repo });
  });

  it.each([
    ["GitLab", "https://gitlab.com/o/r"],
    ["a lookalike host", "https://github.com.evil.net/o/r"],
    ["a GitHub subdomain that is not github.com", "https://gist.github.com/o/r"],
    ["userinfo before github.com", "https://evil.net@github.com/o/r"],
    ["only an owner", "https://github.com/honojs"],
    ["dot segments", "https://github.com/../etc"],
    ["a dot-dot repo", "github:o/.."],
    ["a space", "github:o/my repo"],
    ["an empty string", ""],
    ["a non-string", 42],
    ["null", null],
    ["a shell-ish name", "o/r;rm -rf"],
    ["a percent-encoded slash", "https://github.com/o%2Fr/x"],
  ])("rejects %s", (_label, value) => {
    expect(parseGitHubRepo(value)).toBeUndefined();
  });
});

describe("parseNpmMetadata", () => {
  it("takes homepage, repository and description", () => {
    expect(parseNpmMetadata(honoNpm, NPM_HONO)).toEqual({
      source: "npm",
      metadataUrl: NPM_HONO,
      homepage: "https://hono.dev/",
      repository: { owner: "honojs", repo: "hono" },
      description: "Web framework built on Web Standards",
    });
  });

  it("treats a github.com homepage as the repository, not as a docs site", () => {
    const meta = parseNpmMetadata({ homepage: "https://github.com/JacksonTian/httpx#readme" }, NPM_HTTPX);
    expect(meta.homepage).toBeUndefined();
    expect(meta.repository).toEqual({ owner: "JacksonTian", repo: "httpx" });
  });

  it("skips hostile values instead of failing (http, IP, userinfo, javascript:, wrong types)", () => {
    for (const homepage of ["http://hono.dev", "https://169.254.169.254/", "https://u:p@hono.dev/", "javascript:alert(1)", 42, { url: "https://hono.dev" }]) {
      const meta = parseNpmMetadata({ homepage, repository: "https://gitlab.com/o/r", description: ["x"] }, NPM_HONO);
      expect(meta.homepage, String(homepage)).toBeUndefined();
      expect(meta.repository).toBeUndefined();
      expect(meta.description).toBeUndefined();
    }
    expect(parseNpmMetadata(null, NPM_HONO)).toEqual({ source: "npm", metadataUrl: NPM_HONO });
    expect(parseNpmMetadata("nope", NPM_HONO)).toEqual({ source: "npm", metadataUrl: NPM_HONO });
  });

  it("accepts a string repository field", () => {
    expect(parseNpmMetadata({ repository: "github:honojs/hono" }, NPM_HONO).repository).toEqual({ owner: "honojs", repo: "hono" });
  });
});

describe("parsePyPiMetadata", () => {
  it("takes Documentation / Homepage / Source from project_urls (case-insensitively) and the summary", () => {
    expect(parsePyPiMetadata(httpxPyPi, PYPI_HTTPX)).toEqual({
      source: "pypi",
      metadataUrl: PYPI_HTTPX,
      docsUrl: "https://www.python-httpx.org/",
      repository: { owner: "encode", repo: "httpx" },
      description: "The next generation HTTP client.",
    });
    const lower = parsePyPiMetadata(
      { info: { project_urls: { documentation: "https://stripe.com/docs/api/?lang=python", homepage: "https://stripe.com/", source: "https://github.com/stripe/stripe-python" } } },
      "https://pypi.org/pypi/stripe/json",
    );
    expect(lower.docsUrl).toBe("https://stripe.com/docs/api/?lang=python");
    expect(lower.homepage).toBe("https://stripe.com/");
    expect(lower.repository).toEqual({ owner: "stripe", repo: "stripe-python" });
  });

  it("falls back to info.home_page and recognises Docs / Repository / Home keys", () => {
    const meta = parsePyPiMetadata(
      { info: { home_page: "https://fastapi.tiangolo.com", project_urls: { Docs: "https://docs.example.org/x", Repository: "https://github.com/fastapi/fastapi" } } },
      "https://pypi.org/pypi/fastapi/json",
    );
    expect(meta.homepage).toBe("https://fastapi.tiangolo.com/");
    expect(meta.docsUrl).toBe("https://docs.example.org/x");
    expect(meta.repository).toEqual({ owner: "fastapi", repo: "fastapi" });
  });

  it("skips hostile values and tolerates a missing info block", () => {
    const meta = parsePyPiMetadata(
      { info: { home_page: "http://x.example.com", project_urls: { Documentation: "https://[::1]/", Homepage: "file:///etc", Source: "https://gitlab.com/o/r" } } },
      PYPI_HTTPX,
    );
    expect(meta).toEqual({ source: "pypi", metadataUrl: PYPI_HTTPX });
    expect(parsePyPiMetadata({}, PYPI_HTTPX)).toEqual({ source: "pypi", metadataUrl: PYPI_HTTPX });
    expect(parsePyPiMetadata({ info: { project_urls: "nope" } }, PYPI_HTTPX)).toEqual({ source: "pypi", metadataUrl: PYPI_HTTPX });
  });
});

describe("synthesizeCandidates (order, dedupe, bounds)", () => {
  const base = (m: Partial<PackageMetadata>): PackageMetadata => ({ source: "npm", metadataUrl: NPM_HONO, ...m });

  it("homepage only: origin+path then origin, llms-full before llms, then README main then master", () => {
    expect(synthesizeCandidates(base({ homepage: "https://tanstack.com/query", repository: { owner: "TanStack", repo: "query" } }))).toEqual([
      "https://tanstack.com/query/llms-full.txt",
      "https://tanstack.com/query/llms.txt",
      "https://tanstack.com/llms-full.txt",
      "https://tanstack.com/llms.txt",
      "https://raw.githubusercontent.com/TanStack/query/main/README.md",
      "https://raw.githubusercontent.com/TanStack/query/master/README.md",
    ]);
  });

  it("a root homepage yields two llms candidates, not four duplicates", () => {
    expect(synthesizeCandidates(base({ homepage: "https://hono.dev/" }))).toEqual([
      "https://hono.dev/llms-full.txt",
      "https://hono.dev/llms.txt",
    ]);
  });

  it("with a docs URL: the docs URL's four come first, then the homepage's, deduplicated, query strings dropped", () => {
    expect(
      synthesizeCandidates(base({ homepage: "https://stripe.com/", docsUrl: "https://stripe.com/docs/api/?lang=python" })),
    ).toEqual([
      "https://stripe.com/docs/api/llms-full.txt",
      "https://stripe.com/docs/api/llms.txt",
      "https://stripe.com/llms-full.txt",
      "https://stripe.com/llms.txt",
    ]);
  });

  it("caps llms candidates at 8 and README candidates at 2", () => {
    const out = synthesizeCandidates(
      base({ homepage: "https://a.example.com/x/y", docsUrl: "https://b.example.com/d/e", repository: { owner: "o", repo: "r" } }),
    );
    expect(out.filter((u) => u.includes("llms"))).toHaveLength(MAX_LLMS_CANDIDATES);
    expect(out.filter((u) => u.startsWith("https://raw.githubusercontent.com/"))).toHaveLength(MAX_README_CANDIDATES);
    expect(MAX_LLMS_CANDIDATES).toBe(8);
    expect(MAX_README_CANDIDATES).toBe(2);
    expect(MAX_METADATA_FETCHES).toBe(2);
  });

  it("README-only when there is no docs base; empty when there is nothing", () => {
    expect(synthesizeCandidates(base({ repository: { owner: "o", repo: "r" } }))).toEqual([
      "https://raw.githubusercontent.com/o/r/main/README.md",
      "https://raw.githubusercontent.com/o/r/master/README.md",
    ]);
    expect(synthesizeCandidates(base({}))).toEqual([]);
  });

  it("strips a trailing file segment such as index.html from the docs path", () => {
    expect(synthesizeCandidates(base({ homepage: "https://docs.example.com/guide/index.html" }))).toEqual([
      "https://docs.example.com/guide/llms-full.txt",
      "https://docs.example.com/guide/llms.txt",
      "https://docs.example.com/llms-full.txt",
      "https://docs.example.com/llms.txt",
    ]);
  });
});

describe("resolvePackage (chain: registry metadata → llms probes → README; stop at first usable)", () => {
  it("npm hit, llms probes miss, README on main wins; persists; caches the document under the entry name", async () => {
    const spy = stubFetch({
      [NPM_HONO]: honoNpm,
      "https://raw.githubusercontent.com/honojs/hono/main/README.md": "# Hono\n\nUltrafast web framework.\n\n## Middleware\n\nUse app.use().",
    });
    const out = await resolvePackage("hono");
    expect(out.ok).toBe(true);
    expect(out.source).toBe("npm");
    expect(out.chosen).toBe("https://raw.githubusercontent.com/honojs/hono/main/README.md");
    expect(out.kind).toBe("readme");
    expect(out.candidates).toEqual([
      "https://hono.dev/llms-full.txt",
      "https://hono.dev/llms.txt",
      "https://raw.githubusercontent.com/honojs/hono/main/README.md",
      "https://raw.githubusercontent.com/honojs/hono/master/README.md",
    ]);
    // 1 metadata + 3 probes; the master README was never requested.
    expect(spy).toHaveBeenCalledTimes(4);
    expect(spy.mock.calls.map((c) => String(c[0]))).not.toContain("https://raw.githubusercontent.com/honojs/hono/master/README.md");
    expect(out.entry).toMatchObject({
      name: "hono",
      urls: out.candidates,
      description: "Web framework built on Web Standards",
      allowedHosts: ["hono.dev", "docs.hono.dev"],
      resolved: { source: "npm", metadataUrl: NPM_HONO, homepage: "https://hono.dev/" },
    });
    expect(readResolvedEntries().map((e) => e.name)).toEqual(["hono"]);
    expect(readCache("hono", out.chosen!, 168)?.content).toContain("Ultrafast");
    expect(out.text).toContain('Resolved "hono" via npm');
    expect(out.text).toContain("chosen");
    expect(out.text).toContain("hono.dev, docs.hono.dev");
  });

  it("README main 404 → master is tried and wins", async () => {
    const spy = stubFetch({
      [NPM_HONO]: honoNpm,
      "https://raw.githubusercontent.com/honojs/hono/master/README.md": "# Hono on master",
    });
    const out = await resolvePackage("hono");
    expect(out.ok).toBe(true);
    expect(out.chosen).toBe("https://raw.githubusercontent.com/honojs/hono/master/README.md");
    expect(spy).toHaveBeenCalledTimes(5);
  });

  it("stops at the first llms candidate that serves a real document and classifies it", async () => {
    const spy = stubFetch({
      [NPM_HONO]: honoNpm,
      "https://hono.dev/llms-full.txt": "# Hono\n\nProse about routing.\n\n## Middleware\n\nUse app.use().",
    });
    const out = await resolvePackage("hono");
    expect(out.chosen).toBe("https://hono.dev/llms-full.txt");
    expect(out.kind).toBe("full-text");
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("an HTML page served as 200 at an llms.txt URL is not a usable document", async () => {
    const spy = vi.fn(async (url: unknown) => {
      const u = String(url);
      if (u === NPM_HONO) return new Response(JSON.stringify(honoNpm), { status: 200, headers: { "content-type": "application/json" } });
      if (u.endsWith("llms.txt")) return new Response("<!doctype html><html>404</html>", { status: 200, headers: { "content-type": "text/html" } });
      if (u.endsWith("/main/README.md")) return new Response("# Hono", { status: 200, headers: { "content-type": "text/plain" } });
      return new Response("nope", { status: 404 });
    });
    vi.stubGlobal("fetch", spy);
    const out = await resolvePackage("hono");
    expect(out.chosen).toBe("https://raw.githubusercontent.com/honojs/hono/main/README.md");
  });

  it("npm 404 → PyPI; docs URL probes come first; entry keeps the folded input name", async () => {
    const spy = stubFetch({
      [PYPI_HTTPX]: httpxPyPi,
      "https://www.python-httpx.org/llms.txt": "# HTTPX\n\nA next-generation HTTP client.\n\n## Timeouts\n\nDefault 5 seconds.",
    });
    const out = await resolvePackage("HTTPX");
    expect(spy.mock.calls.map((c) => String(c[0]))).toEqual([
      NPM_HTTPX,
      PYPI_HTTPX,
      "https://www.python-httpx.org/llms-full.txt",
      "https://www.python-httpx.org/llms.txt",
    ]);
    expect(out.ok).toBe(true);
    expect(out.source).toBe("pypi");
    expect(out.entry?.name).toBe("httpx");
    expect(out.entry?.allowedHosts).toEqual(["www.python-httpx.org"]);
    expect(out.entry?.resolved).toMatchObject({ source: "pypi", docsUrl: "https://www.python-httpx.org/" });
    expect(out.entry?.resolved?.homepage).toBeUndefined(); // github.com homepage is the repository, not a docs host
    expect(out.candidates.at(-2)).toBe("https://raw.githubusercontent.com/encode/httpx/main/README.md");
  });

  it("prefers npm when both ecosystems know the name; ecosystem: 'pypi' forces PyPI and skips npm entirely", async () => {
    const spy = stubFetch({
      [NPM_HTTPX]: { homepage: "https://github.com/JacksonTian/httpx" },
      [PYPI_HTTPX]: httpxPyPi,
      "https://raw.githubusercontent.com/JacksonTian/httpx/main/README.md": "# httpx (node)",
      "https://www.python-httpx.org/llms.txt": "# HTTPX (python)",
    });
    const npmFirst = await resolvePackage("httpx");
    expect(npmFirst.source).toBe("npm");
    expect(npmFirst.chosen).toBe("https://raw.githubusercontent.com/JacksonTian/httpx/main/README.md");
    spy.mockClear();
    const forced = await resolvePackage("httpx", { ecosystem: "pypi" });
    expect(forced.source).toBe("pypi");
    expect(forced.chosen).toBe("https://www.python-httpx.org/llms.txt");
    expect(spy.mock.calls.map((c) => String(c[0]))).not.toContain(NPM_HTTPX);
    // The later explicit resolution replaces the persisted record for that name.
    const [persisted] = readResolvedEntries();
    expect(persisted.resolved?.source).toBe("pypi");
  });

  it("ecosystem: 'npm' never consults PyPI", async () => {
    const spy = stubFetch({ [PYPI_HTTPX]: httpxPyPi });
    const out = await resolvePackage("httpx", { ecosystem: "npm" });
    expect(out.ok).toBe(false);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(out.text).toMatch(/^Could not resolve "httpx": npm: no metadata \(404 or unreachable\); PyPI: not tried \(ecosystem npm\)\. Add it to vibectx\.config\.json like: \{ "name": "httpx", "urls": \["https:\/\/\.\.\."\] \}$/);
  });

  it("npm metadata with no usable URL falls through to PyPI (still ≤ 2 metadata fetches)", async () => {
    const spy = stubFetch({
      [NPM_HTTPX]: { description: "nothing useful", homepage: "http://insecure.example.com" },
      [PYPI_HTTPX]: httpxPyPi,
      "https://www.python-httpx.org/llms.txt": "# HTTPX",
    });
    const out = await resolvePackage("httpx");
    expect(out.source).toBe("pypi");
    expect(spy.mock.calls.filter((c) => String(c[0]).includes("registry.npmjs.org") || String(c[0]).includes("pypi.org"))).toHaveLength(2);
  });

  it("scoped npm names are URL-encoded in the metadata URL and not offered to PyPI", async () => {
    const spy = stubFetch({
      "https://registry.npmjs.org/@tanstack%2Freact-query/latest": { homepage: "https://tanstack.com/query", repository: "https://github.com/TanStack/query" },
      "https://raw.githubusercontent.com/TanStack/query/main/README.md": "# TanStack Query",
    });
    const out = await resolvePackage("@tanstack/react-query");
    expect(out.ok).toBe(true);
    expect(out.entry?.name).toBe("@tanstack/react-query");
    expect(spy.mock.calls.map((c) => String(c[0])).some((u) => u.includes("pypi.org"))).toBe(false);
    expect(readCache("@tanstack/react-query", out.chosen!, 168)?.content).toBe("# TanStack Query");
  });

  it("refuses an implausible name before any network call", async () => {
    const spy = stubFetch({});
    for (const bad of ["https://evil.example/x", "../../etc/passwd", "", "  ", "a b", "hono?x=1", "@/x"]) {
      const out = await resolvePackage(bad);
      expect(out.ok, bad).toBe(false);
      expect(out.text, bad).toMatch(/^Could not resolve ".*": .*not a valid npm or PyPI package name; nothing was fetched\. Add it to vibectx\.config\.json/);
    }
    expect(spy).not.toHaveBeenCalled();
    expect(existsSync(join(dir, "resolved.json"))).toBe(false);
  });

  it("nothing on either registry → the could-not-resolve message names both attempts; nothing persisted", async () => {
    const spy = stubFetch({});
    const out = await resolvePackage("zz-no-such-package");
    expect(out.ok).toBe(false);
    expect(spy).toHaveBeenCalledTimes(2);
    expect(out.text).toBe(
      'Could not resolve "zz-no-such-package": npm: no metadata (404 or unreachable); PyPI: no metadata (404 or unreachable). ' +
        'Add it to vibectx.config.json like: { "name": "zz-no-such-package", "urls": ["https://..."] }',
    );
    expect(existsSync(join(dir, "resolved.json"))).toBe(false);
  });

  it("metadata found but no candidate serves a document → one-line summary of what was tried; nothing persisted or cached", async () => {
    const spy = stubFetch({ [NPM_HONO]: honoNpm });
    const out = await resolvePackage("hono");
    expect(out.ok).toBe(false);
    expect(spy).toHaveBeenCalledTimes(1 + 4);
    expect(out.text).toContain('Could not resolve "hono": npm metadata found (homepage https://hono.dev/, repository github.com/honojs/hono); none of 4 candidate URLs served a document: https://hono.dev/llms-full.txt, https://hono.dev/llms.txt, https://raw.githubusercontent.com/honojs/hono/main/README.md, https://raw.githubusercontent.com/honojs/hono/master/README.md. Add it to vibectx.config.json');
    expect(existsSync(join(dir, "resolved.json"))).toBe(false);
    expect(existsSync(join(dir, "hono"))).toBe(false);
  });

  it("metadata found with no usable URLs on either registry → says so", async () => {
    stubFetch({ [NPM_HONO]: { description: "x" } });
    const out = await resolvePackage("hono");
    expect(out.ok).toBe(false);
    expect(out.text).toContain('Could not resolve "hono": npm metadata found but it has no https homepage, docs URL or GitHub repository; PyPI: no metadata (404 or unreachable). Add it');
  });

  it("never exceeds the fetch bound even when every candidate exists but is unusable", async () => {
    const spy = vi.fn(async (url: unknown) => {
      const u = String(url);
      if (u === NPM_HONO) {
        return new Response(
          JSON.stringify({ homepage: "https://a.example.com/x/y", repository: "https://github.com/o/r" }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response("   ", { status: 200, headers: { "content-type": "text/plain" } }); // blank body = miss
    });
    vi.stubGlobal("fetch", spy);
    const out = await resolvePackage("hono");
    expect(out.ok).toBe(false);
    expect(spy.mock.calls.length).toBeLessThanOrEqual(MAX_METADATA_FETCHES + MAX_LLMS_CANDIDATES + MAX_README_CANDIDATES);
  });

  it("metadata larger than the cap is treated as no metadata", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response("{}", { status: 200, headers: { "content-type": "application/json", "content-length": String(METADATA_MAX_BYTES + 1) } }),
      ),
    );
    const out = await resolvePackage("hono");
    expect(out.ok).toBe(false);
    expect(out.text).toContain("npm: no metadata");
  });

  it("a metadata body that is not JSON is treated as no metadata, never a stack trace", async () => {
    stubFetch({ [NPM_HONO]: "<!doctype html><html>maintenance</html>" });
    const out = await resolvePackage("hono");
    expect(out.ok).toBe(false);
    expect(out.text).not.toMatch(/at .*\.ts:\d+/);
    expect(out.text).toContain("npm: no metadata");
  });

  it("a metadata document that is a huge JSON array of homepages still yields at most the bounded candidate list", async () => {
    stubFetch({ [NPM_HONO]: { homepage: "https://hono.dev", repository: { url: "https://github.com/honojs/hono" }, versions: Array.from({ length: 1000 }, () => "x") } });
    const out = await resolvePackage("hono");
    expect(out.candidates.length).toBeLessThanOrEqual(MAX_LLMS_CANDIDATES + MAX_README_CANDIDATES);
  });
});

describe("couldNotResolveMessage", () => {
  it("is one line, names the attempts, and ends with the config hint", () => {
    expect(couldNotResolveMessage("x", ["npm: a", "PyPI: b"])).toBe(
      'Could not resolve "x": npm: a; PyPI: b. Add it to vibectx.config.json like: { "name": "x", "urls": ["https://..."] }',
    );
  });
});

describe("resolveToolText (MCP resolve_library body: registry-aware)", () => {
  const registry = (): Registry => ({
    entries: new Map([["hono", { name: "hono", urls: ["https://hono.dev/llms.txt"], aliases: ["honojs"] }]]),
  });

  it("a known name or alias reports the registry entry without any network call", async () => {
    const spy = stubFetch({});
    const reg = registry();
    const text = await resolveToolText(reg, "honojs");
    expect(spy).not.toHaveBeenCalled();
    expect(text).toContain('"honojs" is already in the registry as "hono"');
    expect(text).toContain("https://hono.dev/llms.txt");
  });

  it("an unknown name is resolved, adopted into the live registry and reported", async () => {
    stubFetch({
      [NPM_HTTPX]: { homepage: "https://github.com/JacksonTian/httpx" },
      "https://raw.githubusercontent.com/JacksonTian/httpx/main/README.md": "# httpx",
    });
    const reg = registry();
    const text = await resolveToolText(reg, "httpx");
    expect(text).toContain('Resolved "httpx" via npm');
    expect(reg.entries.get("httpx")?.resolved?.source).toBe("npm");
  });

  it("reports the could-not-resolve text and leaves the registry alone", async () => {
    stubFetch({});
    const reg = registry();
    const text = await resolveToolText(reg, "zz-nothing");
    expect(text).toMatch(/^Could not resolve "zz-nothing"/);
    expect(reg.entries.size).toBe(1);
  });

  it("re-resolves a resolved entry (rather than reporting it as already known) so ecosystem can be switched", async () => {
    stubFetch({
      [NPM_HTTPX]: { homepage: "https://github.com/JacksonTian/httpx" },
      [PYPI_HTTPX]: httpxPyPi,
      "https://raw.githubusercontent.com/JacksonTian/httpx/main/README.md": "# httpx",
      "https://www.python-httpx.org/llms.txt": "# HTTPX",
    });
    const reg = registry();
    await resolveToolText(reg, "httpx");
    expect(reg.entries.get("httpx")?.resolved?.source).toBe("npm");
    const text = await resolveToolText(reg, "httpx", "pypi");
    expect(text).toContain('Resolved "httpx" via PyPI');
    expect(reg.entries.get("httpx")?.resolved?.source).toBe("pypi");
  });
});
