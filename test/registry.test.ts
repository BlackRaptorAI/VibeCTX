import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { formatDoctorTable, runDoctor } from "../src/doctor.js";
import {
  DEFAULT_REGISTRY,
  installResolvedEntry,
  loadDiscoveredRegistry,
  loadRegistry,
  loadRegistryFrom,
  nearestLibraryName,
  resolveLibrary,
  unknownLibraryMessage,
  type LibraryEntry,
  type Registry,
} from "../src/registry.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "vibectx-registry-"));
  // loadRegistry also merges <cacheRoot>/resolved.json (PAR-655); point it at an empty dir
  // so a developer's real cache cannot change entry counts here.
  process.env.VIBECTX_CACHE_DIR = dir;
});

afterEach(() => {
  delete process.env.VIBECTX_CACHE_DIR;
  rmSync(dir, { recursive: true, force: true });
});

function writeConfig(libraries: unknown[]): string {
  const path = join(dir, "vibectx.config.json");
  writeFileSync(path, JSON.stringify({ libraries }), "utf8");
  return path;
}

/** D-17 (PAR-657): a config file's urls must be https, so the old `"u"` placeholder is now
 *  spelled out. Nothing else about these cases changed. */
const U = "https://placeholder.example.com/llms.txt";

/** Paths go into RegExps in a couple of message assertions. */
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const PARAGON_EXAMPLE = fileURLToPath(new URL("../docs/examples/paragon.vibectx.config.json", import.meta.url));

describe("default registry probe queries (PAR-707)", () => {
  it("gives every default entry at least one non-empty probe query", () => {
    for (const e of DEFAULT_REGISTRY) {
      expect(e.probeQueries, e.name).toBeDefined();
      expect(e.probeQueries!.length, e.name).toBeGreaterThan(0);
      for (const q of e.probeQueries!) expect(q.trim().length, e.name).toBeGreaterThan(0);
    }
  });
});

describe("default registry: vibe-coder top-30 (PAR-654)", () => {
  const VIBE_CODER_30 = [
    "next.js", "react", "supabase", "tailwindcss", "shadcn", "stripe", "ai-sdk", "expo",
    "drizzle-orm", "prisma", "trpc", "zod", "hono", "bun", "vite", "clerk", "convex",
    "firebase", "openai", "anthropic-sdk", "playwright", "vitest", "react-router", "astro",
    "sveltekit", "nuxt", "vue", "tanstack-query", "motion", "resend",
  ];

  it("ships exactly these 30 libraries, in this order", () => {
    expect(DEFAULT_REGISTRY.map((e) => e.name)).toEqual(VIBE_CODER_30);
    expect(DEFAULT_REGISTRY).toHaveLength(30);
  });

  it.each(DEFAULT_REGISTRY.map((e) => [e.name, e] as const))("%s is a well-formed entry", (_name, e) => {
    expect(e.name.trim().length).toBeGreaterThan(0);
    expect(e.name).toBe(e.name.toLowerCase()); // naming rule: canonical names are lowercase
    expect(e.description?.trim().length ?? 0).toBeGreaterThan(0);
    expect(e.urls.length).toBeGreaterThanOrEqual(1);
    for (const u of e.urls) expect(u, `${e.name}: ${u}`).toMatch(/^https:\/\//);
    expect(new Set(e.urls).size, `${e.name}: duplicate urls`).toBe(e.urls.length);
    // ≥ 1 raw-GitHub fallback (the only kind reachable from the build sandbox), listed LAST:
    // llms-full.txt → llms.txt → curated fallback is the documented candidate order.
    expect(e.urls.some((u) => u.startsWith("https://raw.githubusercontent.com/")), `${e.name}: no GitHub-raw fallback`).toBe(true);
    expect(e.urls[e.urls.length - 1]).toMatch(/^https:\/\/raw\.githubusercontent\.com\//);
    expect(e.probeQueries, e.name).toHaveLength(2);
    for (const q of e.probeQueries!) expect(q.trim().length, e.name).toBeGreaterThan(0);
    for (const a of e.aliases ?? []) {
      expect(a.trim().length, `${e.name}: empty alias`).toBeGreaterThan(0);
      expect(a, `${e.name}: alias must be lowercase`).toBe(a.toLowerCase());
      expect(a, `${e.name}: alias equals its own name`).not.toBe(e.name);
    }
  });

  it("has no duplicate names, no duplicate aliases, and no alias that equals a canonical name", () => {
    const names = DEFAULT_REGISTRY.map((e) => e.name);
    expect(new Set(names).size).toBe(names.length);
    const aliases = DEFAULT_REGISTRY.flatMap((e) => e.aliases ?? []);
    expect(new Set(aliases).size).toBe(aliases.length);
    const nameSet = new Set(names);
    for (const a of aliases) expect(nameSet.has(a), `alias "${a}" collides with a canonical name`).toBe(false);
  });

  it("ships the aliases agents commonly use", () => {
    const reg = loadRegistry();
    const expectAlias = (alias: string, canonical: string) =>
      expect(resolveLibrary(reg, alias)?.name, alias).toBe(canonical);
    expectAlias("next", "next.js");
    expectAlias("nextjs", "next.js");
    expectAlias("tailwind", "tailwindcss");
    expectAlias("remix", "react-router");
    expectAlias("svelte", "sveltekit");
    expectAlias("framer-motion", "motion");
    expectAlias("react-query", "tanstack-query");
    expectAlias("anthropic", "anthropic-sdk");
    expectAlias("firebase-js", "firebase");
    expectAlias("drizzle", "drizzle-orm");
    expectAlias("ai", "ai-sdk");
    // PAR-656: the npm package name reaches the entry whose canonical name differs from it,
    // so `vibectx warm` (which reads package.json) gets a curated hit, not a resolution.
    expectAlias("react-dom", "react");
    expectAlias("@supabase/supabase-js", "supabase");
    expectAlias("@trpc/server", "trpc");
    expectAlias("@trpc/client", "trpc");
    expectAlias("@clerk/nextjs", "clerk");
    expectAlias("@anthropic-ai/sdk", "anthropic-sdk");
    expectAlias("@playwright/test", "playwright");
    expectAlias("@sveltejs/kit", "sveltekit");
    expectAlias("@tanstack/react-query", "tanstack-query");
    expectAlias("@tailwindcss/postcss", "tailwindcss");
    // Canonical already IS the common name — no alias needed, must resolve directly:
    for (const n of ["openai", "trpc", "tailwindcss", "drizzle-orm"]) expect(resolveLibrary(reg, n)?.name, n).toBe(n);
  });

  it("no longer ships Paragon's platform stack by default", () => {
    const reg = loadRegistry();
    for (const n of ["fastify", "timescaledb", "pgvector", "aws-cdk", "fastify-type-provider-zod"]) {
      expect(resolveLibrary(reg, n), n).toBeUndefined();
    }
  });
});

describe("docs/examples/paragon.vibectx.config.json (Paragon's stack, moved to committed config)", () => {
  it("is a valid config that restores the removed entries with their probe queries", () => {
    const reg = loadRegistry(PARAGON_EXAMPLE);
    for (const n of ["fastify", "timescaledb", "pgvector", "aws-cdk", "fastify-type-provider-zod"]) {
      const e = reg.entries.get(n);
      expect(e, n).toBeDefined();
      expect(e!.urls.length, n).toBeGreaterThan(0);
      expect(e!.probeQueries?.length ?? 0, n).toBeGreaterThan(0);
    }
    // Merged over the defaults: the vibe-coder 30 are still there.
    expect(reg.entries.size).toBe(35);
  });
});

describe("resolveLibrary", () => {
  const reg: Registry = {
    entries: new Map<string, LibraryEntry>([
      ["next.js", { name: "next.js", urls: [U], aliases: ["next", "nextjs"] }],
      ["hono", { name: "hono", urls: [U] }],
    ]),
  };

  it("resolves a canonical name", () => {
    expect(resolveLibrary(reg, "hono")?.name).toBe("hono");
    expect(resolveLibrary(reg, "next.js")?.name).toBe("next.js");
  });

  it("resolves an alias to its canonical entry", () => {
    expect(resolveLibrary(reg, "next")?.name).toBe("next.js");
    expect(resolveLibrary(reg, "nextjs")?.name).toBe("next.js");
  });

  it("is forgiving about case and surrounding whitespace (agents send 'Next.js')", () => {
    expect(resolveLibrary(reg, "Next.js")?.name).toBe("next.js");
    expect(resolveLibrary(reg, " NEXT ")?.name).toBe("next.js");
    expect(resolveLibrary(reg, "Hono")?.name).toBe("hono");
  });

  it("returns undefined for an unknown name", () => {
    expect(resolveLibrary(reg, "nope")).toBeUndefined();
    expect(resolveLibrary(reg, "")).toBeUndefined();
  });

  it("prefers an exact canonical match over a case-folded one", () => {
    const mixed: Registry = {
      entries: new Map<string, LibraryEntry>([
        ["Hono", { name: "Hono", urls: ["a"] }],
        ["hono", { name: "hono", urls: ["b"] }],
      ]),
    };
    expect(resolveLibrary(mixed, "Hono")?.urls).toEqual(["a"]);
    expect(resolveLibrary(mixed, "hono")?.urls).toEqual(["b"]);
  });
});

describe("config aliases validation", () => {
  it("accepts an array of non-empty strings and keeps it on the entry", () => {
    const path = writeConfig([{ name: "hono", urls: ["https://hono.dev/llms.txt"], aliases: ["honojs"] }]);
    const reg = loadRegistry(path);
    expect(reg.entries.get("hono")?.aliases).toEqual(["honojs"]);
    expect(resolveLibrary(reg, "honojs")?.name).toBe("hono");
  });

  it("accepts aliases: [] (no aliases) and an entry without aliases", () => {
    expect(loadRegistry(writeConfig([{ name: "hono", urls: [U], aliases: [] }])).entries.get("hono")?.aliases).toEqual([]);
    expect(loadRegistry(writeConfig([{ name: "hono", urls: [U] }])).entries.get("hono")?.aliases).toBeUndefined();
  });

  it.each([
    ["a string", "honojs"],
    ["an empty string element", [""]],
    ["a whitespace-only element", ["   "]],
    ["a non-string element", [1]],
    ["an object", { a: "honojs" }],
  ])("rejects aliases that is %s", (_label, aliases) => {
    const path = writeConfig([{ name: "hono", urls: ["https://hono.dev/llms.txt"], aliases }]);
    expect(() => loadRegistry(path)).toThrow(/aliases/);
  });

  it("rejects an alias that collides with a canonical name (default or config), with an actionable hint", () => {
    expect(() => loadRegistry(writeConfig([{ name: "hono", urls: [U], aliases: ["react"] }]))).toThrow(
      /libraries\[0\]\.aliases \("hono"\): alias "react" collides with the canonical name "react" \(a default library\); rename the alias, or override "react" \(with its urls\) and set aliases: \[\]/,
    );
    expect(() =>
      loadRegistry(writeConfig([
        { name: "hono", urls: [U] },
        { name: "elysia", urls: [U], aliases: ["hono"] },
      ])),
    ).toThrow(/libraries\[1\]\.aliases \("elysia"\): alias "hono" collides with the canonical name "hono" \(another config entry\)/);
  });

  it("rejects an alias equal to the entry's own name", () => {
    expect(() => loadRegistry(writeConfig([{ name: "hono", urls: [U], aliases: ["hono"] }]))).toThrow(
      /libraries\[0\]\.aliases \("hono"\): alias "hono" collides with the canonical name "hono" \(the entry itself\)/,
    );
  });

  it("rejects the same alias on two config entries", () => {
    expect(() =>
      loadRegistry(writeConfig([
        { name: "a", urls: [U], aliases: ["shared"] },
        { name: "b", urls: [U], aliases: ["shared"] },
      ])),
    ).toThrow(/libraries\[1\]\.aliases \("b"\): alias "shared" is also declared on "a"/);
  });

  it("validates the defaults even without a config (no alias/canonical collision shipped)", () => {
    expect(() => loadRegistry()).not.toThrow();
  });
});

describe("D-06: config beats default alias (backward compatibility with 0.1.3 configs)", () => {
  it("a legacy config named after a default alias loads; the alias is dropped from the default", () => {
    const reg = loadRegistry(writeConfig([{ name: "next", urls: ["https://example.com/next.txt"] }]));
    expect(resolveLibrary(reg, "next")?.urls).toEqual(["https://example.com/next.txt"]);
    expect(resolveLibrary(reg, "next.js")?.urls[0]).toBe("https://nextjs.org/llms-full.txt"); // default still there
    expect(reg.entries.get("next.js")?.aliases).toEqual(["nextjs"]); // "next" silently dropped
    expect(resolveLibrary(reg, "nextjs")?.name).toBe("next.js");
    expect(reg.entries.size).toBe(31);
  });

  it("a config ALIAS equal to a default alias also wins: the default loses it", () => {
    const reg = loadRegistry(writeConfig([{ name: "mine", urls: [U], aliases: ["tailwind"] }]));
    expect(resolveLibrary(reg, "tailwind")?.name).toBe("mine");
    expect(reg.entries.get("tailwindcss")?.aliases).not.toContain("tailwind");
    expect(reg.entries.get("tailwindcss")?.aliases).toEqual(["@tailwindcss/postcss"]); // the unclaimed alias stays
  });

  it("never mutates the shared DEFAULT_REGISTRY objects when dropping an alias", () => {
    loadRegistry(writeConfig([{ name: "next", urls: [U] }]));
    expect(DEFAULT_REGISTRY.find((e) => e.name === "next.js")?.aliases).toEqual(["next", "nextjs"]);
    expect(resolveLibrary(loadRegistry(), "next")?.name).toBe("next.js");
  });
});

describe("D-07: an override that omits aliases inherits the default's; aliases: [] clears them", () => {
  it("omit → inherit (the common 'point next.js at a mirror' override keeps `next` working)", () => {
    const reg = loadRegistry(writeConfig([{ name: "next.js", urls: ["https://mirror.example/llms.txt"] }]));
    expect(reg.entries.get("next.js")?.aliases).toEqual(["next", "nextjs"]);
    expect(resolveLibrary(reg, "next")?.urls).toEqual(["https://mirror.example/llms.txt"]);
  });

  it("[] → cleared", () => {
    const reg = loadRegistry(writeConfig([{ name: "next.js", urls: [U], aliases: [] }]));
    expect(reg.entries.get("next.js")?.aliases).toEqual([]);
    expect(resolveLibrary(reg, "next")).toBeUndefined();
  });

  it("an explicit list replaces the default's", () => {
    const reg = loadRegistry(writeConfig([{ name: "next.js", urls: [U], aliases: ["nextjs"] }]));
    expect(reg.entries.get("next.js")?.aliases).toEqual(["nextjs"]);
    expect(resolveLibrary(reg, "next")).toBeUndefined();
  });

  it("inherited aliases still yield to a config entry of that name (D-06 applies to inherited aliases)", () => {
    const reg = loadRegistry(writeConfig([
      { name: "next.js", urls: ["https://mirror.example/llms.txt"] },
      { name: "next", urls: ["https://example.com/next.txt"] },
    ]));
    expect(reg.entries.get("next.js")?.aliases).toEqual(["nextjs"]);
    expect(resolveLibrary(reg, "next")?.urls).toEqual(["https://example.com/next.txt"]);
  });
});

describe("config normalization: names and aliases are trimmed and lower-cased before validation and storage", () => {
  it('{name: "Next.js"} overrides next.js instead of adding a 31st entry', () => {
    const reg = loadRegistry(writeConfig([{ name: "Next.js", urls: ["https://mirror.example/llms.txt"] }]));
    expect(reg.entries.size).toBe(30);
    expect(reg.entries.has("Next.js")).toBe(false);
    expect(reg.entries.get("next.js")?.urls).toEqual(["https://mirror.example/llms.txt"]);
    expect(reg.entries.get("next.js")?.name).toBe("next.js");
    expect(resolveLibrary(reg, "NEXT.JS")?.urls).toEqual(["https://mirror.example/llms.txt"]);
  });

  it('alias "React" on another entry is rejected as a canonical collision', () => {
    expect(() => loadRegistry(writeConfig([{ name: "hono", urls: [U], aliases: ["React"] }]))).toThrow(
      /libraries\[0\]\.aliases \("hono"\): alias "react" collides with the canonical name "react"/,
    );
  });

  it('alias " bar " is stored and resolves as "bar"', () => {
    const reg = loadRegistry(writeConfig([{ name: "foo", urls: [U], aliases: [" bar "] }]));
    expect(reg.entries.get("foo")?.aliases).toEqual(["bar"]);
    expect(resolveLibrary(reg, "bar")?.name).toBe("foo");
    expect(resolveLibrary(reg, " BAR ")?.name).toBe("foo");
  });

  it("a name that folds to empty is rejected", () => {
    expect(() => loadRegistry(writeConfig([{ name: "   ", urls: [U] }]))).toThrow(
      /libraries\[0\]\.name: must be a non-empty string/,
    );
  });

  it("two config entries whose names fold to the same key are one override (last wins)", () => {
    const reg = loadRegistry(writeConfig([
      { name: "Foo", urls: ["https://a.example.com/llms.txt"] },
      { name: "foo ", urls: ["https://b.example.com/llms.txt"] },
    ]));
    expect(reg.entries.get("foo")?.urls).toEqual(["https://b.example.com/llms.txt"]);
    expect([...reg.entries.keys()].filter((k) => k === "foo")).toHaveLength(1);
  });
});

describe("unknownLibraryMessage", () => {
  it("lists canonical names only (aliases are shown by list_libraries)", () => {
    const reg: Registry = {
      entries: new Map<string, LibraryEntry>([
        ["next.js", { name: "next.js", urls: [U], aliases: ["next"] }],
        ["hono", { name: "hono", urls: [U] }],
      ]),
    };
    expect(unknownLibraryMessage(reg, "nope")).toBe('Unknown library "nope". Known: next.js, hono');
  });
});

describe("config probeQueries validation", () => {
  it("accepts an array of non-empty strings and keeps it on the entry", () => {
    const path = writeConfig([
      { name: "hono", urls: ["https://hono.dev/llms.txt"], probeQueries: ["middleware", "routing"] },
    ]);
    const reg = loadRegistry(path);
    expect(reg.entries.get("hono")?.probeQueries).toEqual(["middleware", "routing"]);
  });

  it("accepts probeQueries: [] and keeps it (doctor treats it as absent: derived query)", () => {
    const path = writeConfig([{ name: "hono", urls: ["https://hono.dev/llms.txt"], probeQueries: [] }]);
    expect(loadRegistry(path).entries.get("hono")?.probeQueries).toEqual([]);
  });

  it("accepts an entry without probeQueries", () => {
    const path = writeConfig([{ name: "hono", urls: ["https://hono.dev/llms.txt"] }]);
    expect(loadRegistry(path).entries.get("hono")?.probeQueries).toBeUndefined();
  });

  it.each([
    ["a string", "middleware"],
    ["an empty string element", [""]],
    ["a whitespace-only element", ["   "]],
    ["a non-string element", [1]],
    ["an object", { q: "middleware" }],
  ])("rejects probeQueries that is %s", (_label, probeQueries) => {
    const path = writeConfig([{ name: "hono", urls: ["https://hono.dev/llms.txt"], probeQueries }]);
    expect(() => loadRegistry(path)).toThrow(/probeQueries/);
  });

  it("still rejects an entry missing name or urls", () => {
    expect(() => loadRegistry(writeConfig([{ name: "x" }]))).toThrow(
      /libraries\[0\]\.urls \("x"\): must be a non-empty array of https URLs/,
    );
    expect(() => loadRegistry(writeConfig([{ urls: ["https://x.example.com/llms.txt"] }]))).toThrow(
      /libraries\[0\]\.name: must be a non-empty string/,
    );
  });
});

describe("config allowedHosts validation (PAR-655)", () => {
  it("accepts bare hostnames and *. wildcards, folded to lowercase, and keeps them on the entry", () => {
    const reg = loadRegistry(writeConfig([{ name: "acme", urls: ["https://docs.acme.com/llms.txt"], allowedHosts: [" API.acme.com ", "*.Acme.dev"] }]));
    expect(reg.entries.get("acme")?.allowedHosts).toEqual(["api.acme.com", "*.acme.dev"]);
  });

  it("accepts allowedHosts: [] and an entry without it", () => {
    expect(loadRegistry(writeConfig([{ name: "acme", urls: [U], allowedHosts: [] }])).entries.get("acme")?.allowedHosts).toEqual([]);
    expect(loadRegistry(writeConfig([{ name: "acme", urls: [U] }])).entries.get("acme")?.allowedHosts).toBeUndefined();
  });

  it.each([
    ["a string", "api.acme.com"],
    ["a non-string element", [1]],
  ])("rejects allowedHosts whose SHAPE is wrong (%s) with the schema's path + message", (_label, allowedHosts) => {
    expect(() => loadRegistry(writeConfig([{ name: "acme", urls: [U], allowedHosts }]))).toThrow(
      /libraries\[0\]\.allowedHosts \("acme"\): must be an array of hostnames/,
    );
  });

  it.each([
    ["a scheme", ["https://api.acme.com"]],
    ["a path", ["api.acme.com/docs"]],
    ["a port", ["api.acme.com:8443"]],
    ["a bare wildcard", ["*"]],
    ["a single-label wildcard", ["*.com"]],
    ["a mid wildcard", ["api.*.com"]],
    ["an IP literal", ["10.0.0.1"]],
    ["localhost", ["localhost"]],
    ["a .internal host", ["vault.internal"]],
    ["a single label", ["intranet"]],
    ["an empty element", [""]],
  ])("rejects the host VALUE %s, naming the file, the entry and the offending value (D-22)", (_label, allowedHosts) => {
    expect(() => loadRegistry(writeConfig([{ name: "acme", urls: [U], allowedHosts }]))).toThrow(
      new RegExp(`vibectx\\.config\\.json: libraries\\[0\\]\\.allowedHosts \\("acme"\\): "${(allowedHosts as string[])[0].replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}" `),
    );
  });

  it("S1: an oversized host value is clipped — the line stays inside the 300-character bound", () => {
    const huge = `${"h".repeat(4000)}.example.com`;
    try {
      loadRegistry(writeConfig([{ name: "acme", urls: [U], allowedHosts: [huge] }]));
      expect.unreachable();
    } catch (e) {
      const m = (e as Error).message;
      expect(m.length).toBeLessThanOrEqual(300);
      expect(m).toMatch(/libraries\[0\]\.allowedHosts \("acme"\): "h+…" is longer than/);
      expect(m.split("\n")).toHaveLength(1);
    }
  });

  it("strips a `resolved` marker from config entries (only the resolver may set it)", () => {
    const reg = loadRegistry(writeConfig([{ name: "acme", urls: [U], resolved: { source: "npm", resolvedAt: "x", metadataUrl: "y" } }]));
    expect(reg.entries.get("acme")?.resolved).toBeUndefined();
  });
});

describe("loadRegistryFrom: layered config, project over user over defaults (D-14, PAR-657)", () => {
  const layerFile = (name: string, libraries: unknown[]): string => {
    const path = join(dir, name);
    writeFileSync(path, JSON.stringify({ libraries }), "utf8");
    return path;
  };
  const layered = (user: string, project: string) =>
    loadRegistryFrom({
      files: [
        { path: user, scope: "user", legacy: false },
        { path: project, scope: "project", legacy: false },
      ],
      notes: [],
    });

  it("lets the project file win on a name the user file also defines", () => {
    const user = layerFile("user.json", [{ name: "acme", urls: ["https://user.example.com/llms.txt"] }]);
    const project = layerFile("project.json", [{ name: "acme", urls: ["https://project.example.com/llms.txt"] }]);
    const reg = layered(user, project);
    expect(reg.entries.get("acme")?.urls).toEqual(["https://project.example.com/llms.txt"]);
  });

  it("keeps entries only one layer defines, and both layers override a default", () => {
    const user = layerFile("user.json", [
      { name: "only-user", urls: ["https://user.example.com/llms.txt"] },
      { name: "react", urls: ["https://user.example.com/react.txt"] },
    ]);
    const project = layerFile("project.json", [
      { name: "only-project", urls: ["https://project.example.com/llms.txt"] },
      { name: "zod", urls: ["https://project.example.com/zod.txt"] },
    ]);
    const reg = layered(user, project);
    expect(reg.entries.get("only-user")?.urls).toEqual(["https://user.example.com/llms.txt"]);
    expect(reg.entries.get("only-project")?.urls).toEqual(["https://project.example.com/llms.txt"]);
    expect(reg.entries.get("react")?.urls).toEqual(["https://user.example.com/react.txt"]);
    expect(reg.entries.get("zod")?.urls).toEqual(["https://project.example.com/zod.txt"]);
    expect(reg.entries.size).toBe(32);
  });

  it("D-06 between layers: a project entry claiming a user alias takes it from the user entry", () => {
    const user = layerFile("user.json", [{ name: "mine", urls: [U], aliases: ["shared"] }]);
    const project = layerFile("project.json", [{ name: "shared", urls: ["https://project.example.com/llms.txt"] }]);
    const reg = layered(user, project);
    expect(reg.entries.get("mine")?.aliases).toEqual([]);
    expect(resolveLibrary(reg, "shared")?.urls).toEqual(["https://project.example.com/llms.txt"]);
  });

  it("D-07 between layers: a project override that omits aliases inherits the user layer's", () => {
    const user = layerFile("user.json", [{ name: "acme", urls: [U], aliases: ["acme-js"] }]);
    const project = layerFile("project.json", [{ name: "acme", urls: ["https://project.example.com/llms.txt"] }]);
    const reg = layered(user, project);
    expect(reg.entries.get("acme")?.aliases).toEqual(["acme-js"]);
    expect(resolveLibrary(reg, "acme-js")?.urls).toEqual(["https://project.example.com/llms.txt"]);
    const cleared = layerFile("cleared.json", [{ name: "acme", urls: ["https://project.example.com/llms.txt"], aliases: [] }]);
    expect(layered(user, cleared).entries.get("acme")?.aliases).toEqual([]);
  });

  it("names the FILE a semantic failure came from (D-22), and skips only that layer (D-19)", () => {
    const user = layerFile("user.json", [{ name: "mine", urls: [U] }]);
    const project = layerFile("project.json", [{ name: "hono", urls: [U], aliases: ["react"] }]);
    const reg = layered(user, project);
    expect(reg.config?.files.find((f) => f.path === project)?.error).toMatch(
      /^libraries\[0\]\.aliases \("hono"\): alias "react" collides with the canonical name "react"/,
    );
    expect(reg.entries.has("mine")).toBe(true); // the user layer below it still loaded
    const badHost = layerFile("bad-host.json", [{ name: "acme", urls: [U], allowedHosts: ["localhost"] }]);
    expect(layered(user, badHost).config?.files.find((f) => f.path === badHost)?.error).toMatch(
      /^libraries\[0\]\.allowedHosts \("acme"\): "localhost" must have at least two labels/,
    );
    // The same failure through an explicit --config is fatal, and the line names the file.
    expect(() => loadRegistry(badHost)).toThrow(
      new RegExp(`${escapeRe(badHost)}: libraries\\[0\\]\\.allowedHosts \\("acme"\\): "localhost" must have at least two labels`),
    );
  });

  it("carries the resolution on registry.config for the list_libraries header (D-18)", () => {
    const project = layerFile("project.json", [{ name: "acme", urls: [U] }]);
    const resolution = { files: [{ path: project, scope: "project" as const, legacy: false }], notes: ["a note"] };
    expect(loadRegistryFrom(resolution).config).toEqual({
      files: [{ ...resolution.files[0], display: project }], // display: not under cwd or HOME here
      notes: ["a note"],
    });
    expect(loadRegistry().config).toEqual({ files: [], notes: [] });
    expect(loadRegistry(project).config?.files[0].scope).toBe("flag");
  });
});

describe("loadDiscoveredRegistry: the path index.ts and the CLI use (D-14, PAR-657)", () => {
  let repo: string;
  let home: string;
  beforeEach(() => {
    repo = join(dir, "repo");
    home = join(dir, "home");
    mkdirSync(join(repo, ".git"), { recursive: true });
    mkdirSync(join(home, ".config", "vibectx"), { recursive: true });
  });

  const at = (path: string, url: string): string => {
    writeFileSync(path, JSON.stringify({ libraries: [{ name: "acme", urls: [url] }] }), "utf8");
    return path;
  };
  const url = (reg: Registry) => reg.entries.get("acme")?.urls[0];

  it("resolves flag > env > project > user > defaults for the same library name", () => {
    at(join(home, ".config", "vibectx", "config.json"), "https://user.example.com/x.txt");
    at(join(repo, "vibectx.config.json"), "https://project.example.com/x.txt");
    const envPath = at(join(dir, "env.json"), "https://env.example.com/x.txt");
    const flagPath = at(join(dir, "flag.json"), "https://flag.example.com/x.txt");
    const load = (env: NodeJS.ProcessEnv, flag?: string) => loadDiscoveredRegistry({ cwd: repo, env, home, flag });

    expect(url(load({ VIBECTX_CONFIG: envPath }, flagPath))).toBe("https://flag.example.com/x.txt");
    expect(url(load({ VIBECTX_CONFIG: envPath }))).toBe("https://env.example.com/x.txt");
    expect(url(load({}))).toBe("https://project.example.com/x.txt");
    rmSync(join(repo, "vibectx.config.json"));
    expect(url(load({}))).toBe("https://user.example.com/x.txt");
    rmSync(join(home, ".config", "vibectx", "config.json"));
    expect(url(load({}))).toBeUndefined(); // shipped defaults only
    expect(load({}).entries.size).toBe(30);
  });

  it("an explicit source skips discovery entirely: the project file is not layered under it", () => {
    at(join(repo, "vibectx.config.json"), "https://project.example.com/x.txt");
    writeFileSync(join(repo, "vibectx.config.json"), JSON.stringify({ libraries: [
      { name: "acme", urls: ["https://project.example.com/x.txt"] },
      { name: "project-only", urls: ["https://project.example.com/only.txt"] },
    ] }), "utf8");
    const flagPath = at(join(dir, "flag.json"), "https://flag.example.com/x.txt");
    const reg = loadDiscoveredRegistry({ cwd: repo, env: {}, home, flag: flagPath });
    expect(url(reg)).toBe("https://flag.example.com/x.txt");
    expect(reg.entries.has("project-only")).toBe(false);
  });

  it("emits the D-16 deprecation note to warn once, and still loads the file", () => {
    at(join(repo, "docs-cache.config.json"), "https://legacy.example.com/x.txt");
    const warnings: string[] = [];
    const reg = loadDiscoveredRegistry({ cwd: repo, env: {}, home, warn: (m) => warnings.push(m) });
    expect(url(reg)).toBe("https://legacy.example.com/x.txt");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/docs-cache\.config\.json is deprecated/);
  });

  it("D-19: a bad DISCOVERED project file is skipped — the other layers load, with one warning", () => {
    at(join(home, ".config", "vibectx", "config.json"), "https://user.example.com/x.txt");
    writeFileSync(join(repo, "vibectx.config.json"), '{ "libraries": [{ "name": "a", "urls": ["http://x/y"] }] }', "utf8");
    const warnings: string[] = [];
    const reg = loadDiscoveredRegistry({ cwd: repo, env: {}, home, warn: (m) => warnings.push(m) });
    expect(url(reg)).toBe("https://user.example.com/x.txt"); // the user layer still applied
    expect(reg.entries.size).toBe(31); // defaults + the user entry
    expect(warnings).toEqual([
      'vibectx: ./vibectx.config.json: libraries[0].urls ("a"): "http://x/y" must use https: — file skipped, continuing without it',
    ]);
    const skipped = reg.config?.files.find((f) => f.scope === "project");
    expect(skipped?.error).toBe('libraries[0].urls ("a"): "http://x/y" must use https:');
    expect(reg.config?.files.find((f) => f.scope === "user")?.error).toBeUndefined();
  });

  it("D-19: a bad DISCOVERED user file is skipped too — the project file still decides", () => {
    writeFileSync(join(home, ".config", "vibectx", "config.json"), "{ oops", "utf8");
    at(join(repo, "vibectx.config.json"), "https://project.example.com/x.txt");
    const warnings: string[] = [];
    const reg = loadDiscoveredRegistry({ cwd: repo, env: {}, home, warn: (m) => warnings.push(m) });
    expect(url(reg)).toBe("https://project.example.com/x.txt");
    expect(warnings.join("")).toMatch(/^vibectx: ~?[^\n]*config\.json: invalid JSON[^\n]* — file skipped, continuing without it$/);
    expect(reg.config?.files.find((f) => f.scope === "user")?.error).toMatch(/^invalid JSON/);
  });

  it("D-19: a semantic failure in a discovered file skips that file, and the layers below still load", () => {
    at(join(home, ".config", "vibectx", "config.json"), "https://user.example.com/x.txt");
    writeFileSync(
      join(repo, "vibectx.config.json"),
      JSON.stringify({ libraries: [{ name: "mine", urls: ["https://mine.example.com/x.txt"], aliases: ["react"] }] }),
      "utf8",
    );
    const reg = loadDiscoveredRegistry({ cwd: repo, env: {}, home });
    expect(url(reg)).toBe("https://user.example.com/x.txt");
    expect(reg.entries.has("mine")).toBe(false); // the whole file is skipped, not one entry
    expect(resolveLibrary(reg, "react")?.name).toBe("react"); // the default keeps its name
    expect(reg.config?.files.find((f) => f.scope === "project")?.error).toMatch(/^libraries\[0\]\.aliases \("mine"\): alias "react" collides/);
  });

  it("D-19: an EXPLICIT source that cannot be honoured stays fatal (flag and env alike)", () => {
    const broken = join(dir, "broken.json");
    writeFileSync(broken, '{ "libraries": [{ "name": "a", "urls": ["http://x/y"] }] }', "utf8");
    expect(() => loadDiscoveredRegistry({ cwd: repo, env: {}, home, flag: broken })).toThrow(
      /libraries\[0\]\.urls \("a"\): "http:\/\/x\/y" must use https:$/,
    );
    expect(() => loadDiscoveredRegistry({ cwd: repo, env: { VIBECTX_CONFIG: broken }, home })).toThrow(
      /libraries\[0\]\.urls \("a"\): "http:\/\/x\/y" must use https:$/,
    );
    expect(() => loadDiscoveredRegistry({ cwd: repo, env: {}, home, flag: join(dir, "nope.json") })).toThrow(/nope\.json: not found$/);
  });
});

describe("loadRegistry merges persisted resolutions BELOW defaults and config (PAR-655)", () => {
  const resolvedRecord = (name: string, url: string) => ({
    name,
    urls: [url],
    description: `${name} (resolved)`,
    resolved: { source: "npm", resolvedAt: "2026-09-06T05:00:00.000Z", metadataUrl: `https://registry.npmjs.org/${name}/latest`, homepage: "https://example.com/" },
  });
  const writeResolved = (entries: unknown[]) =>
    writeFileSync(join(dir, "resolved.json"), JSON.stringify({ schemaVersion: 1, entries }), "utf8");

  it("adds a resolved entry the registry does not know, marked resolved with derived allowedHosts", () => {
    writeResolved([resolvedRecord("elysia", "https://elysiajs.com/llms.txt")]);
    const reg = loadRegistry();
    expect(reg.entries.size).toBe(31);
    const e = resolveLibrary(reg, "elysia");
    expect(e?.urls).toEqual(["https://elysiajs.com/llms.txt"]);
    expect(e?.resolved?.source).toBe("npm");
    expect(e?.allowedHosts).toEqual(["example.com", "docs.example.com"]);
    // Defaults first, resolved last.
    expect([...reg.entries.keys()].at(-1)).toBe("elysia");
  });

  it("never overrides a default, a default alias, a config entry or a config alias", () => {
    writeResolved([
      resolvedRecord("react", "https://evil.example.com/react.txt"),
      resolvedRecord("next", "https://evil.example.com/next.txt"), // default alias
      resolvedRecord("mine", "https://evil.example.com/mine.txt"), // config entry
      resolvedRecord("mine-alias", "https://evil.example.com/alias.txt"), // config alias
      resolvedRecord("fresh", "https://fresh.example.com/llms.txt"),
    ]);
    const reg = loadRegistry(writeConfig([{ name: "mine", urls: ["https://mine.example.com/llms.txt"], aliases: ["mine-alias"] }]));
    expect(resolveLibrary(reg, "react")?.urls[0]).toBe("https://react.dev/llms-full.txt");
    expect(resolveLibrary(reg, "react")?.resolved).toBeUndefined();
    expect(resolveLibrary(reg, "next")?.name).toBe("next.js");
    expect(resolveLibrary(reg, "mine")?.urls).toEqual(["https://mine.example.com/llms.txt"]);
    expect(resolveLibrary(reg, "mine-alias")?.name).toBe("mine");
    expect(reg.entries.has("next")).toBe(false);
    expect(reg.entries.has("mine-alias")).toBe(false);
    expect(resolveLibrary(reg, "fresh")?.resolved?.source).toBe("npm");
    expect(reg.entries.size).toBe(32);
  });

  it("ignores a corrupt or malformed resolved.json without failing the load", () => {
    writeFileSync(join(dir, "resolved.json"), "{{{", "utf8");
    expect(loadRegistry().entries.size).toBe(30);
    writeResolved([{ name: "bad", urls: ["http://insecure.example.com/x"], resolved: { source: "npm", resolvedAt: "2026-09-06T05:00:00.000Z", metadataUrl: "https://registry.npmjs.org/bad/latest" } }]);
    expect(loadRegistry().entries.size).toBe(30);
  });

  it("can be told to skip persisted resolutions", () => {
    writeResolved([resolvedRecord("elysia", "https://elysiajs.com/llms.txt")]);
    expect(loadRegistry(undefined, { includeResolved: false }).entries.size).toBe(30);
  });

  it("S2: planted `React` / `NextJS` records neither load nor shadow the curated entries", () => {
    writeResolved([
      { ...resolvedRecord("react", "https://evil.example.com/react.txt"), name: "React" },
      { ...resolvedRecord("nextjs", "https://evil.example.com/next.txt"), name: "NextJS" },
    ]);
    const reg = loadRegistry();
    expect(reg.entries.size).toBe(30);
    expect(reg.entries.has("React")).toBe(false);
    expect(resolveLibrary(reg, "React")?.urls[0]).toBe("https://nextjs.org/llms-full.txt".replace("nextjs.org/llms-full", "react.dev/llms-full"));
    expect(resolveLibrary(reg, "React")?.resolved).toBeUndefined();
    expect(resolveLibrary(reg, "NextJS")?.name).toBe("next.js");
  });
});

describe("curated keys also claim their PEP 503 spelling (schema gate, PAR-655)", () => {
  const record = {
    name: "typing-extensions",
    urls: ["https://evil.example.com/te.txt"],
    resolved: { source: "pypi" as const, resolvedAt: "2026-09-06T05:00:00.000Z", metadataUrl: "https://pypi.org/pypi/typing-extensions/json" },
  };

  it("a persisted typing-extensions record is dropped when config pins typing_extensions; lookups return the pin", () => {
    writeFileSync(join(dir, "resolved.json"), JSON.stringify({ schemaVersion: 1, entries: [record] }), "utf8");
    const reg = loadRegistry(writeConfig([{ name: "typing_extensions", urls: ["https://pinned.example.com/llms.txt"] }]));
    expect(reg.entries.size).toBe(31);
    expect(reg.entries.has("typing-extensions")).toBe(false);
    for (const q of ["typing-extensions", "typing_extensions", "Typing.Extensions", "TYPING__EXTENSIONS"]) {
      expect(resolveLibrary(reg, q)?.urls, q).toEqual(["https://pinned.example.com/llms.txt"]);
      expect(resolveLibrary(reg, q)?.resolved, q).toBeUndefined();
    }
    expect(installResolvedEntry(reg, record)).toBe(false);
    expect(reg.entries.has("typing-extensions")).toBe(false);
  });

  it("aliases and default names claim their PEP 503 form too; a resolved record may still use an unrelated key", () => {
    const reg = loadRegistry(writeConfig([{ name: "mine", urls: [U], aliases: ["my_alias.x"] }]));
    const meta = { source: "npm" as const, resolvedAt: "2026-09-06T05:00:00.000Z", metadataUrl: "https://registry.npmjs.org/x/latest" };
    expect(installResolvedEntry(reg, { name: "my-alias-x", urls: ["https://evil.example.com/x"], resolved: meta })).toBe(false);
    expect(installResolvedEntry(reg, { name: "react-router", urls: ["https://evil.example.com/x"], resolved: meta })).toBe(false); // default
    expect(installResolvedEntry(reg, { name: "react_router", urls: ["https://evil.example.com/x"], resolved: meta })).toBe(false); // its PEP 503 twin
    expect(resolveLibrary(reg, "react_router")?.name).toBe("react-router");
    expect(installResolvedEntry(reg, { name: "fresh-thing", urls: ["https://fresh.example.com/x"], resolved: meta })).toBe(true);
  });
});

describe("installResolvedEntry (S2: a resolved entry can never replace a curated one)", () => {
  it("refuses when the name maps to a default, a default alias, a config entry or a config alias; installs otherwise", () => {
    const reg = loadRegistry(writeConfig([{ name: "mine", urls: [U], aliases: ["mine-alias"] }]));
    const meta = { source: "npm" as const, resolvedAt: "2026-09-06T05:00:00.000Z", metadataUrl: "https://registry.npmjs.org/x/latest" };
    for (const name of ["react", "next", "mine", "mine-alias"]) {
      expect(installResolvedEntry(reg, { name, urls: ["https://evil.example.com/x"], resolved: meta }), name).toBe(false);
    }
    expect(reg.entries.get("react")?.urls[0]).toBe("https://react.dev/llms-full.txt");
    expect(reg.entries.get("mine")?.urls).toEqual([U]);
    expect(installResolvedEntry(reg, { name: "fresh", urls: ["https://fresh.example.com/x"], resolved: meta })).toBe(true);
    expect(installResolvedEntry(reg, { name: "fresh", urls: ["https://fresh.example.com/y"], resolved: { ...meta, source: "pypi" } })).toBe(true); // replaces a resolved one
    expect(reg.entries.get("fresh")?.resolved?.source).toBe("pypi");
    expect(installResolvedEntry(reg, { name: "plain", urls: [U] })).toBe(false); // not a resolved entry
  });

  it("even a hostile exact-case key already in the map cannot be promoted onto the curated key", () => {
    const reg = loadRegistry();
    const meta = { source: "npm" as const, resolvedAt: "2026-09-06T05:00:00.000Z", metadataUrl: "https://registry.npmjs.org/react/latest" };
    reg.entries.set("React", { name: "React", urls: ["https://evil.example.com/x"], resolved: meta }); // simulates a bypassed loader
    expect(installResolvedEntry(reg, { name: "react", urls: ["https://evil.example.com/y"], resolved: meta })).toBe(false);
    expect(reg.entries.get("react")?.urls[0]).toBe("https://react.dev/llms-full.txt");
  });
});

describe("nearestLibraryName (R3: typo hint, edit distance ≤ 2 over names and aliases)", () => {
  it("finds a close name or alias, ignores exact matches and far names, and prefers the closer one", () => {
    const reg = loadRegistry();
    expect(nearestLibraryName(reg, "reakt")).toBe("react");
    expect(nearestLibraryName(reg, "nextjs")).toBeUndefined(); // exact alias → not a typo
    expect(nearestLibraryName(reg, "nxtjs")).toBe("nextjs"); // alias, distance 1
    expect(nearestLibraryName(reg, "Prisma ")).toBeUndefined(); // folds to an exact name
    expect(nearestLibraryName(reg, "zzzzzzzz")).toBeUndefined();
    expect(nearestLibraryName(reg, "vitesst")).toBe("vitest");
  });
});

describe("S3: a hostile directory name never rides out on a display path (PAR-657)", () => {
  const ESC = "\u001b"; // C0 escape — starts a terminal control sequence
  const RLO = "\u202e"; // RIGHT-TO-LEFT OVERRIDE — reverses everything printed after it

  it("keeps ESC and bidi overrides out of the stderr line, the doctor row and configIssues[].path", async () => {
    // A repository root whose own NAME carries a terminal escape and a right-to-left
    // override. Every sink below prints that name, because the config file lives inside it.
    const hostile = join(dir, `repo${ESC}[31m${RLO}evil`);
    try {
      mkdirSync(join(hostile, ".git"), { recursive: true });
      mkdirSync(join(hostile, "sub"), { recursive: true });
    } catch {
      return; // a filesystem that refuses the name (Windows) has nothing to test here
    }
    // Invalid on purpose: a SKIPPED discovered file is what reaches all three sinks (D-19).
    writeFileSync(join(hostile, "vibectx.config.json"), '{ "libraries": [{ "name": "a", "urls": ["http://x/y"] }] }', "utf8");

    const warnings: string[] = [];
    // cwd is BELOW the repository root, so the display rule cannot shorten the name away.
    const reg = loadDiscoveredRegistry({ cwd: join(hostile, "sub"), env: {}, home: join(dir, "home"), warn: (m) => warnings.push(m) });
    const project = reg.config?.files.find((f) => f.scope === "project");
    expect(project?.error).toBeDefined();
    expect(project?.display).toContain("evil"); // still names the file — cleaned, never dropped

    const report = await runDoctor(reg, { library: "react", offline: true });
    const table = formatDoctorTable(report);
    expect(report.configIssues).toHaveLength(1);
    expect(table).toContain("✗ config ");

    for (const sink of [warnings.join("\n"), project!.display!, report.configIssues![0].path, table]) {
      expect(sink).not.toContain(ESC);
      expect(sink).not.toContain(RLO);
    }
  });
});
