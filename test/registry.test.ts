import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_REGISTRY,
  loadRegistry,
  resolveLibrary,
  unknownLibraryMessage,
  type LibraryEntry,
  type Registry,
} from "../src/registry.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "vibectx-registry-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeConfig(libraries: unknown[]): string {
  const path = join(dir, "vibectx.config.json");
  writeFileSync(path, JSON.stringify({ libraries }), "utf8");
  return path;
}

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
      ["next.js", { name: "next.js", urls: ["u"], aliases: ["next", "nextjs"] }],
      ["hono", { name: "hono", urls: ["u"] }],
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
    expect(loadRegistry(writeConfig([{ name: "hono", urls: ["u"], aliases: [] }])).entries.get("hono")?.aliases).toEqual([]);
    expect(loadRegistry(writeConfig([{ name: "hono", urls: ["u"] }])).entries.get("hono")?.aliases).toBeUndefined();
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
    expect(() => loadRegistry(writeConfig([{ name: "hono", urls: ["u"], aliases: ["react"] }]))).toThrow(
      /alias "react" on config entry "hono" collides with the canonical name "react" \(a default library\); rename the alias, or override "react" \(with its urls\) and set aliases: \[\]/,
    );
    expect(() =>
      loadRegistry(writeConfig([
        { name: "hono", urls: ["u"] },
        { name: "elysia", urls: ["u"], aliases: ["hono"] },
      ])),
    ).toThrow(/alias "hono" on config entry "elysia" collides with the canonical name "hono" \(another config entry\)/);
  });

  it("rejects an alias equal to the entry's own name", () => {
    expect(() => loadRegistry(writeConfig([{ name: "hono", urls: ["u"], aliases: ["hono"] }]))).toThrow(
      /alias "hono" on config entry "hono" collides with the canonical name "hono" \(the entry itself\)/,
    );
  });

  it("rejects the same alias on two config entries", () => {
    expect(() =>
      loadRegistry(writeConfig([
        { name: "a", urls: ["u"], aliases: ["shared"] },
        { name: "b", urls: ["u"], aliases: ["shared"] },
      ])),
    ).toThrow(/alias "shared".*both "a" and "b"/);
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
    const reg = loadRegistry(writeConfig([{ name: "mine", urls: ["u"], aliases: ["tailwind"] }]));
    expect(resolveLibrary(reg, "tailwind")?.name).toBe("mine");
    expect(reg.entries.get("tailwindcss")?.aliases).toEqual([]);
  });

  it("never mutates the shared DEFAULT_REGISTRY objects when dropping an alias", () => {
    loadRegistry(writeConfig([{ name: "next", urls: ["u"] }]));
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
    const reg = loadRegistry(writeConfig([{ name: "next.js", urls: ["u"], aliases: [] }]));
    expect(reg.entries.get("next.js")?.aliases).toEqual([]);
    expect(resolveLibrary(reg, "next")).toBeUndefined();
  });

  it("an explicit list replaces the default's", () => {
    const reg = loadRegistry(writeConfig([{ name: "next.js", urls: ["u"], aliases: ["nextjs"] }]));
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
    expect(() => loadRegistry(writeConfig([{ name: "hono", urls: ["u"], aliases: ["React"] }]))).toThrow(
      /alias "react" on config entry "hono" collides with the canonical name "react"/,
    );
  });

  it('alias " bar " is stored and resolves as "bar"', () => {
    const reg = loadRegistry(writeConfig([{ name: "foo", urls: ["u"], aliases: [" bar "] }]));
    expect(reg.entries.get("foo")?.aliases).toEqual(["bar"]);
    expect(resolveLibrary(reg, "bar")?.name).toBe("foo");
    expect(resolveLibrary(reg, " BAR ")?.name).toBe("foo");
  });

  it("a name that folds to empty is rejected", () => {
    expect(() => loadRegistry(writeConfig([{ name: "   ", urls: ["u"] }]))).toThrow(/missing name\/urls/);
  });

  it("two config entries whose names fold to the same key are one override (last wins)", () => {
    const reg = loadRegistry(writeConfig([
      { name: "Foo", urls: ["a"] },
      { name: "foo ", urls: ["b"] },
    ]));
    expect(reg.entries.get("foo")?.urls).toEqual(["b"]);
    expect([...reg.entries.keys()].filter((k) => k === "foo")).toHaveLength(1);
  });
});

describe("unknownLibraryMessage", () => {
  it("lists canonical names only (aliases are shown by list_libraries)", () => {
    const reg: Registry = {
      entries: new Map<string, LibraryEntry>([
        ["next.js", { name: "next.js", urls: ["u"], aliases: ["next"] }],
        ["hono", { name: "hono", urls: ["u"] }],
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
    expect(() => loadRegistry(writeConfig([{ name: "x" }]))).toThrow(/missing name\/urls/);
  });
});
