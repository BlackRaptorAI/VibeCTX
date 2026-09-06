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
  MAX_URLS_PER_ENTRY,
  MAX_FETCHES_PER_RESOLUTION,
  MAX_RESOLUTIONS_PER_HOUR,
  METADATA_MAX_BYTES,
  resetResolutionWindow,
  lookupLibrary,
  type PackageMetadata,
} from "../src/resolve.js";
import { writeFileSync, readFileSync } from "node:fs";
import { readResolvedEntries } from "../src/resolved-store.js";
import { readCache } from "../src/cache.js";
import type { Registry } from "../src/registry.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "vibectx-resolve-"));
  process.env.DOCS_CACHE_DIR = dir;
  resetResolutionWindow();
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

  it("homepage only: origin+path then origin, llms-full before llms, then the README variants at HEAD", () => {
    // HEAD is GitHub's default-branch ref on raw.githubusercontent.com (MEASURED 2026-09-06), so no
    // main/master guess; the filename variants cover express (Readme.md), resend (readme.md), django (README.rst).
    expect(synthesizeCandidates(base({ homepage: "https://tanstack.com/query", repository: { owner: "TanStack", repo: "query" } }))).toEqual([
      "https://tanstack.com/query/llms-full.txt",
      "https://tanstack.com/query/llms.txt",
      "https://tanstack.com/llms-full.txt",
      "https://tanstack.com/llms.txt",
      "https://raw.githubusercontent.com/TanStack/query/HEAD/README.md",
      "https://raw.githubusercontent.com/TanStack/query/HEAD/readme.md",
      "https://raw.githubusercontent.com/TanStack/query/HEAD/Readme.md",
      "https://raw.githubusercontent.com/TanStack/query/HEAD/README.rst",
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

  it("caps llms candidates at 8 and README candidates at 4", () => {
    const out = synthesizeCandidates(
      base({ homepage: "https://a.example.com/x/y", docsUrl: "https://b.example.com/d/e", repository: { owner: "o", repo: "r" } }),
    );
    expect(out.filter((u) => u.includes("llms"))).toHaveLength(MAX_LLMS_CANDIDATES);
    expect(out.filter((u) => u.startsWith("https://raw.githubusercontent.com/"))).toHaveLength(MAX_README_CANDIDATES);
    expect(MAX_LLMS_CANDIDATES).toBe(8);
    expect(MAX_README_CANDIDATES).toBe(4);
    expect(MAX_METADATA_FETCHES).toBe(2);
  });

  it("README-only when there is no docs base; empty when there is nothing", () => {
    expect(synthesizeCandidates(base({ repository: { owner: "o", repo: "r" } }))).toEqual([
      "https://raw.githubusercontent.com/o/r/HEAD/README.md",
      "https://raw.githubusercontent.com/o/r/HEAD/readme.md",
      "https://raw.githubusercontent.com/o/r/HEAD/Readme.md",
      "https://raw.githubusercontent.com/o/r/HEAD/README.rst",
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
  it("npm hit, llms probes miss, README.md at HEAD wins; persists; caches the document under the entry name", async () => {
    const spy = stubFetch({
      [NPM_HONO]: honoNpm,
      "https://raw.githubusercontent.com/honojs/hono/HEAD/README.md": "# Hono\n\nUltrafast web framework.\n\n## Middleware\n\nUse app.use().",
    });
    const out = await resolvePackage("hono");
    expect(out.ok).toBe(true);
    expect(out.source).toBe("npm");
    expect(out.chosen).toBe("https://raw.githubusercontent.com/honojs/hono/HEAD/README.md");
    expect(out.kind).toBe("readme");
    expect(out.candidates).toEqual([
      "https://hono.dev/llms-full.txt",
      "https://hono.dev/llms.txt",
      "https://raw.githubusercontent.com/honojs/hono/HEAD/README.md",
      "https://raw.githubusercontent.com/honojs/hono/HEAD/readme.md",
      "https://raw.githubusercontent.com/honojs/hono/HEAD/Readme.md",
      "https://raw.githubusercontent.com/honojs/hono/HEAD/README.rst",
    ]);
    // 1 metadata + 3 probes; the later README variants were never requested.
    expect(spy).toHaveBeenCalledTimes(4);
    expect(spy.mock.calls.map((c) => String(c[0]))).not.toContain("https://raw.githubusercontent.com/honojs/hono/HEAD/readme.md");
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

  it("README.md 404 → the other filename variants are tried in order (Readme.md, README.rst)", async () => {
    const spy = stubFetch({
      [NPM_HONO]: honoNpm,
      "https://raw.githubusercontent.com/honojs/hono/HEAD/Readme.md": "# Hono (express-style casing)",
    });
    const out = await resolvePackage("hono");
    expect(out.ok).toBe(true);
    expect(out.chosen).toBe("https://raw.githubusercontent.com/honojs/hono/HEAD/Readme.md");
    expect(spy).toHaveBeenCalledTimes(1 + 2 + 3);
    stubFetch({ [NPM_HONO]: honoNpm, "https://raw.githubusercontent.com/honojs/hono/HEAD/README.rst": "Hono\n====\n\nrst readme" });
    expect((await resolvePackage("hono")).chosen).toBe("https://raw.githubusercontent.com/honojs/hono/HEAD/README.rst");
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
      if (u.endsWith("/HEAD/README.md")) return new Response("# Hono", { status: 200, headers: { "content-type": "text/plain" } });
      return new Response("nope", { status: 404 });
    });
    vi.stubGlobal("fetch", spy);
    const out = await resolvePackage("hono");
    expect(out.chosen).toBe("https://raw.githubusercontent.com/honojs/hono/HEAD/README.md");
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
    expect(out.candidates.at(-4)).toBe("https://raw.githubusercontent.com/encode/httpx/HEAD/README.md");
  });

  it("npm with a real homepage wins outright: PyPI is never consulted (1 metadata fetch)", async () => {
    const spy = stubFetch({
      [NPM_HONO]: honoNpm,
      "https://pypi.org/pypi/hono/json": { info: { project_urls: { Documentation: "https://hono.example.org" } } },
      "https://raw.githubusercontent.com/honojs/hono/HEAD/README.md": "# Hono",
    });
    const out = await resolvePackage("hono");
    expect(out.source).toBe("npm");
    expect(spy.mock.calls.map((c) => String(c[0]))).not.toContain("https://pypi.org/pypi/hono/json");
  });

  it("docs-site preference: npm knows the name but only as a repo, PyPI has a docs site → PyPI wins (2 metadata fetches)", async () => {
    // MEASURED 2026-09-06: `httpx` and `fastapi` both exist on npm as unrelated README-only packages.
    const spy = stubFetch({
      [NPM_HTTPX]: { homepage: "https://github.com/JacksonTian/httpx" },
      [PYPI_HTTPX]: httpxPyPi,
      "https://raw.githubusercontent.com/JacksonTian/httpx/HEAD/README.md": "# httpx (node)",
      "https://www.python-httpx.org/llms.txt": "# HTTPX (python)",
    });
    const out = await resolvePackage("httpx");
    expect(out.source).toBe("pypi");
    expect(out.chosen).toBe("https://www.python-httpx.org/llms.txt");
    const urls = spy.mock.calls.map((c) => String(c[0]));
    expect(urls.slice(0, 2)).toEqual([NPM_HTTPX, PYPI_HTTPX]);
    expect(urls).not.toContain("https://raw.githubusercontent.com/JacksonTian/httpx/HEAD/README.md");
  });

  it("both README-only → npm (first in order); npm README-only and PyPI unknown → npm", async () => {
    const spy = stubFetch({
      [NPM_HTTPX]: { homepage: "https://github.com/JacksonTian/httpx" },
      [PYPI_HTTPX]: { info: { project_urls: { Source: "https://github.com/encode/httpx" } } },
      "https://raw.githubusercontent.com/JacksonTian/httpx/HEAD/README.md": "# httpx (node)",
    });
    expect((await resolvePackage("httpx")).source).toBe("npm");
    expect(spy.mock.calls.map((c) => String(c[0])).slice(0, 2)).toEqual([NPM_HTTPX, PYPI_HTTPX]);
    stubFetch({
      [NPM_HTTPX]: { homepage: "https://github.com/JacksonTian/httpx" },
      "https://raw.githubusercontent.com/JacksonTian/httpx/HEAD/README.md": "# httpx (node)",
    });
    expect((await resolvePackage("httpx")).source).toBe("npm");
  });

  it("npm's security-holder placeholder counts as no package (MEASURED: `django` on npm)", async () => {
    stubFetch({
      "https://registry.npmjs.org/django/latest": { description: "security holding package", repository: { url: "git+https://github.com/npm/security-holder.git" } },
      "https://pypi.org/pypi/django/json": { info: { project_urls: { Documentation: "https://docs.djangoproject.com/" } } },
      "https://docs.djangoproject.com/llms.txt": "# Django",
    });
    const out = await resolvePackage("Django");
    expect(out.source).toBe("pypi");
    expect(out.chosen).toBe("https://docs.djangoproject.com/llms.txt");
    stubFetch({
      "https://registry.npmjs.org/django/latest": { repository: { url: "git+https://github.com/npm/security-holder.git" } },
    });
    const none = await resolvePackage("django");
    expect(none.ok).toBe(false);
    expect(none.text).toContain("npm: name is held by npm's security-holder placeholder");
  });

  it("ecosystem: 'pypi' forces PyPI and skips npm entirely; a later explicit resolution replaces the persisted record", async () => {
    const spy = stubFetch({
      [NPM_HTTPX]: { homepage: "https://httpx-node.example.com" },
      [PYPI_HTTPX]: httpxPyPi,
      "https://httpx-node.example.com/llms.txt": "# httpx (node)",
      "https://www.python-httpx.org/llms.txt": "# HTTPX (python)",
    });
    expect((await resolvePackage("httpx")).source).toBe("npm");
    spy.mockClear();
    const forced = await resolvePackage("httpx", { ecosystem: "pypi" });
    expect(forced.source).toBe("pypi");
    expect(forced.chosen).toBe("https://www.python-httpx.org/llms.txt");
    expect(spy.mock.calls.map((c) => String(c[0]))).not.toContain(NPM_HTTPX);
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
      "https://raw.githubusercontent.com/TanStack/query/HEAD/README.md": "# TanStack Query",
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
    expect(spy).toHaveBeenCalledTimes(1 + 6);
    expect(out.text).toContain('Could not resolve "hono": npm metadata found (homepage https://hono.dev/, repository github.com/honojs/hono); none of 6 candidate URLs served a document: https://hono.dev/llms-full.txt, https://hono.dev/llms.txt, https://raw.githubusercontent.com/honojs/hono/HEAD/README.md, https://raw.githubusercontent.com/honojs/hono/HEAD/readme.md, https://raw.githubusercontent.com/honojs/hono/HEAD/Readme.md, https://raw.githubusercontent.com/honojs/hono/HEAD/README.rst. Add it to vibectx.config.json');
    expect(existsSync(join(dir, "resolved.json"))).toBe(false);
    expect(existsSync(join(dir, "hono"))).toBe(false);
  });

  it("metadata found with no usable URLs on either registry → says so", async () => {
    stubFetch({ [NPM_HONO]: { description: "x" } });
    const out = await resolvePackage("hono");
    expect(out.ok).toBe(false);
    expect(out.text).toContain('Could not resolve "hono": npm metadata found but it has no https homepage, docs URL or GitHub repository; PyPI: no metadata (404 or unreachable). Add it');
  });

  it("Q2: the fetch bound is exact — npm README-only, PyPI full list, everything fails → 2 + 12 + 4 requests, both ecosystems reported", async () => {
    const spy = stubFetch({
      [NPM_HTTPX]: { repository: "https://github.com/JacksonTian/httpx" }, // 4 README candidates, no docs site
      [PYPI_HTTPX]: {
        info: { project_urls: { Documentation: "https://b.example.com/d/e", Homepage: "https://c.example.com/f/g", Source: "https://github.com/encode/httpx" } },
      }, // 8 llms + 4 README
    });
    const out = await resolvePackage("httpx");
    expect(out.ok).toBe(false);
    expect(spy).toHaveBeenCalledTimes(MAX_METADATA_FETCHES + MAX_URLS_PER_ENTRY + MAX_README_CANDIDATES);
    expect(spy).toHaveBeenCalledTimes(18);
    expect(spy.mock.calls.length).toBeLessThanOrEqual(MAX_FETCHES_PER_RESOLUTION);
    expect(MAX_FETCHES_PER_RESOLUTION).toBe(26);
    expect(MAX_URLS_PER_ENTRY).toBe(MAX_LLMS_CANDIDATES + MAX_README_CANDIDATES);
    // Order: both metadata documents, then the docs-site ecosystem's 12, then npm's 4.
    const urls = spy.mock.calls.map((c) => String(c[0]));
    expect(urls.slice(0, 2)).toEqual([NPM_HTTPX, PYPI_HTTPX]);
    expect(urls[2]).toBe("https://b.example.com/d/e/llms-full.txt");
    expect(urls[14]).toBe("https://raw.githubusercontent.com/JacksonTian/httpx/HEAD/README.md");
    expect(out.text).toContain("PyPI metadata found (homepage https://c.example.com/f/g, docs https://b.example.com/d/e, repository github.com/encode/httpx); none of 12 candidate URLs served a document");
    expect(out.text).toContain("npm metadata found (repository github.com/JacksonTian/httpx); none of 4 candidate URLs served a document");
  });

  it("R2: when the preferred ecosystem's candidates all fail, the other found ecosystem is probed (left-pad: PyPI squatter with a docs-looking homepage, no repo)", async () => {
    const spy = stubFetch({
      "https://registry.npmjs.org/left-pad/latest": { repository: "https://github.com/left-pad/left-pad" },
      "https://pypi.org/pypi/left-pad/json": { info: { project_urls: { Homepage: "https://left-pad-docs.example.com/" } } },
      "https://raw.githubusercontent.com/left-pad/left-pad/HEAD/README.md": "# left-pad\n\nString left pad",
    });
    const out = await resolvePackage("left-pad");
    expect(out.ok).toBe(true);
    expect(out.source).toBe("npm");
    expect(out.chosen).toBe("https://raw.githubusercontent.com/left-pad/left-pad/HEAD/README.md");
    const urls = spy.mock.calls.map((c) => String(c[0]));
    expect(urls.slice(2, 4)).toEqual(["https://left-pad-docs.example.com/llms-full.txt", "https://left-pad-docs.example.com/llms.txt"]);
    expect(spy).toHaveBeenCalledTimes(2 + 2 + 1);
    expect(readResolvedEntries()[0].resolved?.source).toBe("npm");
  });

  it("L2: at most 100 resolutions per hour per process; the 101st is refused without a fetch; the window slides", async () => {
    const spy = stubFetch({ [NPM_HONO]: honoNpm, "https://hono.dev/llms-full.txt": "# Hono" });
    let t = Date.parse("2026-09-06T10:00:00Z");
    const now = () => new Date(t);
    for (let i = 0; i < MAX_RESOLUTIONS_PER_HOUR; i++) expect((await resolvePackage("hono", { now })).ok).toBe(true);
    expect(MAX_RESOLUTIONS_PER_HOUR).toBe(100);
    spy.mockClear();
    const refused = await resolvePackage("hono", { now });
    expect(refused.ok).toBe(false);
    expect(spy).not.toHaveBeenCalled();
    expect(refused.text).toBe(
      'Could not resolve "hono": resolution limit reached (100 per hour per process); try again later, or pin the library. ' +
        'Add it to vibectx.config.json like: { "name": "hono", "urls": ["https://..."] }',
    );
    t += 61 * 60_000;
    expect((await resolvePackage("hono", { now })).ok).toBe(true);
  });

  it("L2: a name that fails validation does not consume the budget", async () => {
    const spy = stubFetch({ [NPM_HONO]: honoNpm, "https://hono.dev/llms-full.txt": "# Hono" });
    const now = () => new Date("2026-09-06T10:00:00Z");
    for (let i = 0; i < MAX_RESOLUTIONS_PER_HOUR; i++) await resolvePackage("not a name", { now });
    expect(spy).not.toHaveBeenCalled();
    expect((await resolvePackage("hono", { now })).ok).toBe(true);
  });

  it("L3: a PyPI-sourced entry is keyed by its PEP 503 name, so typing_extensions and Typing-Extensions are one record", async () => {
    stubFetch({
      "https://pypi.org/pypi/typing-extensions/json": { info: { project_urls: { Documentation: "https://typing-extensions.readthedocs.io/" } } },
      "https://typing-extensions.readthedocs.io/llms.txt": "# typing-extensions",
    });
    const a = await resolvePackage("typing_extensions");
    expect(a.ok).toBe(true);
    expect(a.entry?.name).toBe("typing-extensions");
    const b = await resolvePackage("Typing-Extensions");
    expect(b.entry?.name).toBe("typing-extensions");
    expect(readResolvedEntries().map((e) => e.name)).toEqual(["typing-extensions"]);
  });

  it("K2: when resolved.json belongs to another schema version the resolution still works but the report says NOT saved", async () => {
    writeFileSync(join(dir, "resolved.json"), JSON.stringify({ schemaVersion: 7, entries: [] }), "utf8");
    stubFetch({ [NPM_HONO]: honoNpm, "https://hono.dev/llms-full.txt": "# Hono" });
    const notes: string[] = [];
    const out = await resolvePackage("hono", { warn: (m) => notes.push(m) });
    expect(out.ok).toBe(true);
    expect(out.text).toContain("NOT saved");
    expect(out.text).toContain("schemaVersion 7");
    expect(notes.join("")).toMatch(/schemaVersion 7/);
    expect(JSON.parse(readFileSync(join(dir, "resolved.json"), "utf8")).schemaVersion).toBe(7);
  });

  it("L1: the report labels the description as package-supplied", async () => {
    stubFetch({ [NPM_HONO]: honoNpm, "https://hono.dev/llms-full.txt": "# Hono" });
    const out = await resolvePackage("hono");
    expect(out.text).toContain("  description: (package-supplied) Web framework built on Web Standards");
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
      "https://raw.githubusercontent.com/JacksonTian/httpx/HEAD/README.md": "# httpx",
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
      "https://raw.githubusercontent.com/JacksonTian/httpx/HEAD/README.md": "# httpx",
      "https://www.python-httpx.org/llms.txt": "# HTTPX",
    });
    const reg = registry();
    await resolveToolText(reg, "httpx", "npm");
    expect(reg.entries.get("httpx")?.resolved?.source).toBe("npm");
    const text = await resolveToolText(reg, "httpx", "pypi");
    expect(text).toContain('Resolved "httpx" via PyPI');
    expect(reg.entries.get("httpx")?.resolved?.source).toBe("pypi");
  });

  it("S2: never installs onto a curated key, even when a hostile exact-case resolved entry is already in the map", async () => {
    stubFetch({
      "https://registry.npmjs.org/react/latest": { homepage: "https://evil.example.com" },
      "https://evil.example.com/llms.txt": "# evil",
    });
    const curated = { name: "react", urls: ["https://react.dev/llms-full.txt"] };
    const hostile = { name: "React", urls: ["https://evil.example.com/x"], resolved: { source: "npm" as const, resolvedAt: "2026-09-06T00:00:00.000Z", metadataUrl: "https://registry.npmjs.org/react/latest" } };
    const reg: Registry = { entries: new Map([["react", curated], ["React", hostile]]) };
    const text = await resolveToolText(reg, "React");
    expect(text).toContain('"React" is already in the registry as "react"');
    expect(reg.entries.get("react")).toBe(curated);
  });

  it("L3: a registry lookup also tries the PEP 503 form, so a resolved typing-extensions answers to typing_extensions without a new resolution", async () => {
    const spy = stubFetch({
      "https://pypi.org/pypi/typing-extensions/json": { info: { project_urls: { Documentation: "https://typing-extensions.readthedocs.io/" } } },
      "https://typing-extensions.readthedocs.io/llms.txt": "# typing-extensions",
    });
    const reg = registry();
    await resolveToolText(reg, "typing_extensions");
    expect(reg.entries.has("typing-extensions")).toBe(true);
    spy.mockClear();
    const text = await resolveToolText(reg, "Typing_Extensions");
    expect(text).toContain('Resolved "Typing_Extensions" via PyPI'); // resolved entries are re-resolvable by design …
    expect(reg.entries.size).toBe(2); // … but still one record
  });

  it("lookupLibrary returns a config pin for the PEP 503 spelling and never a resolved record beside it", () => {
    const pin = { name: "typing_extensions", urls: ["https://pinned.example.com/llms.txt"] };
    const reg: Registry = { entries: new Map([["typing_extensions", pin]]) };
    expect(lookupLibrary(reg, "Typing.Extensions")).toBe(pin);
    expect(lookupLibrary(reg, "typing-extensions")).toBe(pin);
  });
});
