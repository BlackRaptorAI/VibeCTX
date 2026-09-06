import { readFileSync } from "node:fs";
import { normaliseAllowedHost } from "./link-policy.js";
import { readResolvedEntries } from "./resolved-store.js";

/** Provenance of an entry synthesized by resolve_library (PAR-655). Set only by the
 *  resolver and the persisted store; stripped from config entries. */
export interface ResolvedMeta {
  source: "npm" | "pypi";
  /** ISO timestamp of the resolution. */
  resolvedAt: string;
  /** The registry metadata document the entry was derived from. */
  metadataUrl: string;
  /** Sanitized https URLs from that metadata; the allowed-host set is derived from these. */
  homepage?: string;
  docsUrl?: string;
}

export interface LibraryEntry {
  /** Canonical name agents use to request docs. Lowercase. See NAMING RULE below. */
  name: string;
  /** Other names agents commonly use for this library (`next`, `nextjs` → `next.js`). Lowercase.
   *  An alias must not equal any canonical name in the registry; `[]` means none. */
  aliases?: string[];
  /** Ordered candidate URLs. First reachable one wins. Prefer llms-full.txt, then llms.txt, then curated pages. */
  urls: string[];
  /** Cache time-to-live in hours. Default 168 (7 days). */
  ttlHours?: number;
  /** One-line description shown by list_libraries. */
  description?: string;
  /** Topics `vibectx doctor` runs through get_docs to prove retrieval works for this
   *  entry. Pick something the docs certainly cover; one is enough. When absent — or
   *  an empty array, which is accepted and behaves exactly as absent — doctor derives
   *  a query from the description and marks it "(derived)". */
  probeQueries?: string[];
  /** Hosts, besides the source document's own, that followed index links may target.
   *  Bare hostnames (no scheme / port / path), lowercase; `*.example.com` matches
   *  subdomains, never the apex. IP literals, localhost, `.local`, `.internal` and
   *  single-label names are rejected. See src/link-policy.ts. */
  allowedHosts?: string[];
  /** Present only on entries resolve_library synthesized (never on defaults or config). */
  resolved?: ResolvedMeta;
}

/*
 * DEFAULT REGISTRY — the vibe-coder top-30 (PAR-654).
 *
 * Who it is for: solo vibe coders and 2–20-dev startups (docs/PRODUCT-STRATEGY.md, segments
 * A/B). Paragon's own platform stack (fastify, timescaledb, pgvector, aws-cdk,
 * fastify-type-provider-zod) moved to docs/examples/paragon.vibectx.config.json — the
 * "keep a private stack via committed config" example.
 *
 * NAMING RULE. `name` is lowercase and is the npm package name — unless that package is
 * scoped (`@supabase/supabase-js`, `@trpc/server`, `@clerk/nextjs`, `@anthropic-ai/sdk`,
 * `@playwright/test`, `@sveltejs/kit`, `@tanstack/react-query`), too generic to recognise on
 * its own (`ai`), or not what people call the product (`next` → Next.js). Then `name` is the
 * product's widely used short name in lowercase (`supabase`, `trpc`, `clerk`, `anthropic-sdk`,
 * `playwright`, `sveltekit`, `tanstack-query`, `ai-sdk`, `next.js`). `aliases` carry the other
 * names agents actually send; they are shipped only where such a name is common.
 *
 * URL RULE. Candidates are probed in order: `{docs-base}/llms-full.txt`, `{docs-base}/llms.txt`,
 * then a curated fallback (a raw GitHub README or docs page). The docs base is the package's
 * npm `homepage` (registry.npmjs.org, read 2026-09-06) or, when that is a GitHub URL, the docs
 * site its README links to. Where the docs base is a sub-path (`supabase.com/docs`), the site
 * root's `llms.txt` is also tried, because llmstxt.org places the file at the root.
 *
 * VERIFICATION STATUS (2026-09-06, build sandbox). Every raw.githubusercontent.com fallback
 * below returned HTTP 200 with real markdown content when fetched from the build sandbox
 * (MEASURED). No docs-site `llms-full.txt` / `llms.txt` candidate could be reached from the
 * sandbox (docs hosts are blocked there): those are NOT VERIFIED here. `vibectx doctor` run
 * from a machine with normal network access is the verification (PAR-653); the fetcher probes
 * candidates in order and falls back, so an entry whose site lacks or later gains llms.txt
 * keeps working either way. Prisma's llms-full.txt (~5 MB) and the Anthropic candidates were
 * reachable per the PAR-704 field report (2026-09-05, 0.1.x registry) and are carried over unchanged.
 */
export const DEFAULT_REGISTRY: LibraryEntry[] = [
  {
    name: "next.js",
    aliases: ["next", "nextjs"],
    urls: [
      "https://nextjs.org/llms-full.txt",
      "https://nextjs.org/llms.txt",
      "https://raw.githubusercontent.com/vercel/next.js/canary/packages/next/README.md",
    ],
    description: "Next.js — React framework (App Router, server actions, routing)",
    probeQueries: ["server actions revalidate", "app router layout"],
  },
  {
    name: "react",
    urls: [
      "https://react.dev/llms-full.txt",
      "https://react.dev/llms.txt",
      // The repo README is a link list (index-only, links cross-origin to github.com → never
      // followed); the docs source is the react.dev repo, so fall back to a reference page.
      "https://raw.githubusercontent.com/reactjs/react.dev/main/src/content/reference/react/useEffect.md",
    ],
    description: "React 19 documentation",
    probeQueries: ["useEffect cleanup", "context provider"],
  },
  {
    name: "supabase",
    aliases: ["supabase-js"],
    urls: [
      "https://supabase.com/docs/llms-full.txt",
      "https://supabase.com/docs/llms.txt",
      "https://supabase.com/llms.txt",
      "https://raw.githubusercontent.com/supabase/supabase-js/master/packages/core/supabase-js/README.md",
    ],
    description: "Supabase — Postgres, auth, storage, realtime (supabase-js)",
    probeQueries: ["row level security policy", "auth sign in with oauth"],
  },
  {
    name: "tailwindcss",
    aliases: ["tailwind"],
    urls: [
      "https://tailwindcss.com/llms-full.txt",
      "https://tailwindcss.com/llms.txt",
      "https://raw.githubusercontent.com/tailwindlabs/tailwindcss/main/README.md",
    ],
    description: "Tailwind CSS utility-first framework",
    probeQueries: ["dark mode variant", "responsive breakpoints"],
  },
  {
    name: "shadcn",
    aliases: ["shadcn-ui", "shadcn/ui"],
    urls: [
      "https://ui.shadcn.com/llms-full.txt",
      "https://ui.shadcn.com/llms.txt",
      "https://raw.githubusercontent.com/shadcn-ui/ui/main/apps/v4/content/docs/installation/next.mdx",
    ],
    description: "shadcn/ui — copy-paste React components on Radix + Tailwind",
    probeQueries: ["add button component", "theming css variables"],
  },
  {
    name: "stripe",
    urls: [
      "https://docs.stripe.com/llms-full.txt",
      "https://docs.stripe.com/llms.txt",
      "https://raw.githubusercontent.com/stripe/stripe-node/master/README.md",
    ],
    description: "Stripe payments API (stripe-node)",
    probeQueries: ["checkout session create", "webhook signature verify"],
  },
  {
    name: "ai-sdk",
    aliases: ["ai", "vercel-ai"],
    urls: [
      "https://ai-sdk.dev/docs/llms-full.txt",
      "https://ai-sdk.dev/docs/llms.txt",
      "https://ai-sdk.dev/llms.txt",
      "https://raw.githubusercontent.com/vercel/ai/main/packages/ai/README.md",
    ],
    description: "Vercel AI SDK (npm `ai`) — streamText, generateObject, useChat",
    probeQueries: ["streamText tool calling", "useChat hook"],
  },
  {
    name: "expo",
    urls: [
      "https://docs.expo.dev/llms-full.txt",
      "https://docs.expo.dev/llms.txt",
      "https://raw.githubusercontent.com/expo/expo/main/packages/expo/README.md",
    ],
    description: "Expo — React Native apps, Expo Router, EAS",
    probeQueries: ["expo router navigation", "push notifications"],
  },
  {
    name: "drizzle-orm",
    aliases: ["drizzle"],
    urls: [
      "https://orm.drizzle.team/llms-full.txt",
      "https://orm.drizzle.team/llms.txt",
      "https://raw.githubusercontent.com/drizzle-team/drizzle-orm/main/README.md",
    ],
    description: "Drizzle ORM — TypeScript SQL ORM and migrations",
    probeQueries: ["select with where", "migrations generate"],
  },
  {
    name: "prisma",
    urls: [
      "https://www.prisma.io/docs/llms-full.txt",
      "https://www.prisma.io/docs/llms.txt",
      "https://raw.githubusercontent.com/prisma/prisma/main/README.md",
    ],
    description: "Prisma ORM documentation",
    probeQueries: ["upsert", "relation include"],
  },
  {
    name: "trpc",
    urls: [
      "https://trpc.io/llms-full.txt",
      "https://trpc.io/llms.txt",
      "https://raw.githubusercontent.com/trpc/trpc/main/README.md",
    ],
    description: "tRPC — end-to-end typesafe APIs",
    probeQueries: ["create router procedure", "react query client"],
  },
  {
    name: "zod",
    urls: [
      "https://zod.dev/llms-full.txt",
      "https://zod.dev/llms.txt",
      "https://raw.githubusercontent.com/colinhacks/zod/main/packages/zod/README.md",
    ],
    description: "Zod — TypeScript-first schema validation",
    probeQueries: ["parse object schema", "refine custom validation"],
  },
  {
    name: "hono",
    urls: [
      "https://hono.dev/llms-full.txt",
      "https://hono.dev/llms.txt",
      "https://raw.githubusercontent.com/honojs/hono/main/README.md",
    ],
    description: "Hono — small web framework for any JS runtime",
    probeQueries: ["middleware", "route params"],
  },
  {
    name: "bun",
    urls: [
      "https://bun.com/llms-full.txt",
      "https://bun.com/llms.txt",
      // README is a 300-link index; docs live in-repo under docs/ as .mdx.
      "https://raw.githubusercontent.com/oven-sh/bun/main/docs/runtime/http/server.mdx",
    ],
    description: "Bun — JavaScript runtime, bundler, test runner, package manager",
    probeQueries: ["bun install", "Bun.serve http server"],
  },
  {
    name: "vite",
    urls: [
      "https://vite.dev/llms-full.txt",
      "https://vite.dev/llms.txt",
      "https://raw.githubusercontent.com/vitejs/vite/main/docs/guide/index.md",
    ],
    description: "Vite — frontend build tool and dev server",
    probeQueries: ["env variables", "config proxy"],
  },
  {
    name: "clerk",
    urls: [
      "https://clerk.com/llms-full.txt",
      "https://clerk.com/llms.txt",
      "https://clerk.com/docs/llms.txt",
      "https://raw.githubusercontent.com/clerk/javascript/main/packages/nextjs/README.md",
    ],
    description: "Clerk — authentication and user management (@clerk/nextjs)",
    probeQueries: ["middleware protect routes", "useUser hook"],
  },
  {
    name: "convex",
    urls: [
      "https://docs.convex.dev/llms-full.txt",
      "https://docs.convex.dev/llms.txt",
      "https://convex.dev/llms.txt",
      "https://raw.githubusercontent.com/get-convex/convex-backend/main/README.md",
    ],
    description: "Convex — reactive backend with queries, mutations and schema",
    probeQueries: ["mutation query function", "schema define table"],
  },
  {
    name: "firebase",
    aliases: ["firebase-js"],
    urls: [
      "https://firebase.google.com/llms-full.txt",
      "https://firebase.google.com/llms.txt",
      "https://raw.githubusercontent.com/firebase/firebase-js-sdk/main/README.md",
    ],
    description: "Firebase JS SDK — Firestore, Auth, Storage, Functions",
    probeQueries: ["firestore query where", "auth sign in google"],
  },
  {
    name: "openai",
    urls: [
      "https://platform.openai.com/docs/llms-full.txt",
      "https://platform.openai.com/docs/llms.txt",
      "https://platform.openai.com/llms.txt",
      "https://raw.githubusercontent.com/openai/openai-node/master/README.md",
    ],
    description: "OpenAI API (openai-node) — responses, chat completions, streaming",
    probeQueries: ["chat completions streaming", "structured outputs"],
  },
  {
    name: "anthropic-sdk",
    aliases: ["anthropic"],
    urls: [
      "https://platform.claude.com/llms.txt",
      "https://docs.anthropic.com/llms-full.txt",
      "https://docs.anthropic.com/llms.txt",
      "https://raw.githubusercontent.com/anthropics/anthropic-sdk-typescript/main/README.md",
    ],
    description: "Anthropic API / Claude SDK documentation",
    probeQueries: ["streaming messages", "tool use"],
  },
  {
    name: "playwright",
    urls: [
      "https://playwright.dev/llms-full.txt",
      "https://playwright.dev/llms.txt",
      "https://raw.githubusercontent.com/microsoft/playwright/main/README.md",
    ],
    description: "Playwright browser automation and end-to-end testing",
    probeQueries: ["locator click", "expect toBeVisible"],
  },
  {
    name: "vitest",
    urls: [
      "https://vitest.dev/llms-full.txt",
      "https://vitest.dev/llms.txt",
      "https://raw.githubusercontent.com/vitest-dev/vitest/main/docs/guide/index.md",
    ],
    description: "Vitest — Vite-native unit test framework",
    probeQueries: ["mock function", "config coverage"],
  },
  {
    name: "react-router",
    aliases: ["remix", "react-router-dom"],
    urls: [
      "https://reactrouter.com/llms-full.txt",
      "https://reactrouter.com/llms.txt",
      "https://raw.githubusercontent.com/remix-run/react-router/main/docs/start/framework/routing.md",
    ],
    description: "React Router v7 (the Remix successor) — routing, loaders, actions",
    probeQueries: ["loader data", "nested routes outlet"],
  },
  {
    name: "astro",
    urls: [
      "https://docs.astro.build/llms-full.txt",
      "https://docs.astro.build/llms.txt",
      "https://astro.build/llms.txt",
      // README is a sponsor/link list (index-only); the docs source is the withastro/docs repo.
      "https://raw.githubusercontent.com/withastro/docs/main/src/content/docs/en/basics/astro-components.mdx",
    ],
    description: "Astro — content-driven web framework with islands",
    probeQueries: ["content collections", "islands client directive"],
  },
  {
    name: "sveltekit",
    aliases: ["svelte"],
    urls: [
      "https://svelte.dev/llms-full.txt",
      "https://svelte.dev/llms.txt",
      "https://svelte.dev/docs/kit/llms.txt",
      "https://raw.githubusercontent.com/sveltejs/kit/main/documentation/docs/20-core-concepts/10-routing.md",
    ],
    description: "SvelteKit — Svelte application framework (routing, load, form actions)",
    probeQueries: ["load function", "form actions"],
  },
  {
    name: "nuxt",
    urls: [
      "https://nuxt.com/llms-full.txt",
      "https://nuxt.com/llms.txt",
      "https://raw.githubusercontent.com/nuxt/nuxt/main/README.md",
    ],
    description: "Nuxt — Vue full-stack framework",
    probeQueries: ["useFetch data fetching", "server api routes"],
  },
  {
    name: "vue",
    urls: [
      "https://vuejs.org/llms-full.txt",
      "https://vuejs.org/llms.txt",
      "https://raw.githubusercontent.com/vuejs/docs/main/src/guide/introduction.md",
    ],
    description: "Vue 3 documentation",
    probeQueries: ["computed reactive ref", "component props emit"],
  },
  {
    name: "tanstack-query",
    aliases: ["react-query"],
    urls: [
      "https://tanstack.com/query/llms-full.txt",
      "https://tanstack.com/query/llms.txt",
      "https://tanstack.com/llms.txt",
      "https://raw.githubusercontent.com/TanStack/query/main/README.md",
    ],
    description: "TanStack Query (React Query) — async state, caching, mutations",
    probeQueries: ["useQuery stale time", "mutation invalidate queries"],
  },
  {
    name: "motion",
    aliases: ["framer-motion"],
    urls: [
      "https://motion.dev/llms-full.txt",
      "https://motion.dev/llms.txt",
      "https://raw.githubusercontent.com/motiondivision/motion/main/README.md",
    ],
    description: "Motion (formerly Framer Motion) — animation library for React and JS",
    probeQueries: ["animate variants", "layout animation"],
  },
  {
    name: "resend",
    urls: [
      "https://resend.com/docs/llms-full.txt",
      "https://resend.com/docs/llms.txt",
      "https://resend.com/llms.txt",
      "https://raw.githubusercontent.com/resend/resend-node/main/readme.md",
    ],
    description: "Resend — transactional email API (resend-node)",
    probeQueries: ["send email react template", "domains verify"],
  },
];

export interface Registry {
  entries: Map<string, LibraryEntry>;
}

function isStringList(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((s) => typeof s === "string" && s.trim().length > 0);
}

/** Registry keys (names and aliases) are compared and stored in this form. */
const fold = (s: string): string => s.trim().toLowerCase();

/**
 * Every alias must be unique across the registry and must not equal any canonical name
 * (compared on folded keys). Runs on every load, config or not, so the shipped defaults
 * are checked too. By the time this runs, D-06 has already removed the default aliases a
 * config claimed — so a collision here is always something the config must change.
 * `configNames` tells the message whether the colliding canonical is a default or config entry.
 */
function validateAliases(entries: Map<string, LibraryEntry>, configNames: ReadonlySet<string>): void {
  const owner = new Map<string, string>();
  for (const e of entries.values()) {
    for (const raw of e.aliases ?? []) {
      const a = fold(raw);
      if (entries.has(a)) {
        const what = a === fold(e.name) ? "the entry itself" : configNames.has(a) ? "another config entry" : "a default library";
        throw new Error(
          `alias "${a}" on config entry "${e.name}" collides with the canonical name "${a}" (${what}); ` +
            `rename the alias, or override "${a}" (with its urls) and set aliases: [] on that entry`,
        );
      }
      const other = owner.get(a);
      if (other !== undefined) throw new Error(`alias "${a}" is declared on both "${other}" and "${e.name}"`);
      owner.set(a, e.name);
    }
  }
}

/**
 * Build the registry: defaults, optionally merged/overridden by a JSON config file of
 * shape { "libraries": LibraryEntry[] }. Unknown top-level keys (e.g. "$comment") are ignored.
 *
 * Config names and aliases are normalised with trim().toLowerCase() before validation and
 * storage, so {name: "Next.js"} overrides "next.js" rather than adding an entry.
 *
 * Precedence (oversight decisions D-06 / D-07, 2026-09-06):
 * - D-06 — config beats default alias. A config entry whose name or alias equals a DEFAULT
 *   alias is not an error: the config wins and that alias is silently dropped from the default
 *   (a 0.1.3 config with {name: "next"} keeps loading). Still errors: a config alias equal to
 *   any CANONICAL name (default or config), the same alias on two config entries, an alias equal
 *   to its own entry's name.
 * - D-07 — an override that OMITS `aliases` inherits the replaced entry's aliases;
 *   `aliases: []` clears them; an explicit list replaces them.
 * - PAR-655 — persisted resolutions (`<cacheRoot>/resolved.json`) merge BELOW both: a
 *   record whose name equals any canonical name or alias above is ignored, so a real
 *   registry or config entry always wins and a persisted resolution never overrides one.
 *   `includeResolved: false` skips the file (tests; tools that must not read the cache).
 */
export function loadRegistry(configPath?: string, opts: { includeResolved?: boolean } = {}): Registry {
  const entries = new Map<string, LibraryEntry>();
  for (const e of DEFAULT_REGISTRY) entries.set(e.name, e);
  const configNames = new Set<string>();
  if (configPath) {
    const raw = JSON.parse(readFileSync(configPath, "utf8")) as { libraries?: LibraryEntry[] };
    // Pass 1: validate shape and normalise keys.
    const config: LibraryEntry[] = [];
    for (const e of raw.libraries ?? []) {
      if (typeof e.name !== "string" || fold(e.name).length === 0 || !Array.isArray(e.urls) || e.urls.length === 0) {
        throw new Error(`config entry missing name/urls: ${JSON.stringify(e)}`);
      }
      if (e.probeQueries !== undefined && !isStringList(e.probeQueries)) {
        throw new Error(
          `config entry "${e.name}": probeQueries must be an array of non-empty strings, got ${JSON.stringify(e.probeQueries)}`,
        );
      }
      if (e.aliases !== undefined && !isStringList(e.aliases)) {
        throw new Error(
          `config entry "${e.name}": aliases must be an array of non-empty strings, got ${JSON.stringify(e.aliases)}`,
        );
      }
      if (e.allowedHosts !== undefined && !Array.isArray(e.allowedHosts)) {
        throw new Error(`config entry "${e.name}": allowedHosts must be an array of hostnames, got ${JSON.stringify(e.allowedHosts)}`);
      }
      const normalised: LibraryEntry = { ...e, name: fold(e.name) };
      if (e.aliases !== undefined) normalised.aliases = e.aliases.map(fold);
      if (e.allowedHosts !== undefined) {
        try {
          normalised.allowedHosts = e.allowedHosts.map(normaliseAllowedHost);
        } catch (err) {
          throw new Error(`config entry "${e.name}": ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      delete normalised.resolved; // only the resolver may mark an entry resolved
      config.push(normalised);
    }
    // Pass 2 (D-06): every key a config entry claims — as a name or an alias — leaves the defaults' alias lists.
    const claimed = new Set<string>();
    for (const e of config) {
      claimed.add(e.name);
      configNames.add(e.name);
      for (const a of e.aliases ?? []) claimed.add(a);
    }
    for (const d of DEFAULT_REGISTRY) {
      if (d.aliases?.some((a) => claimed.has(a))) {
        entries.set(d.name, { ...d, aliases: d.aliases.filter((a) => !claimed.has(a)) }); // copy: never mutate the shipped defaults
      }
    }
    // Pass 3: merge, config wins on name; D-07 alias inheritance.
    for (const e of config) {
      const replaced = entries.get(e.name);
      if (e.aliases === undefined && replaced?.aliases !== undefined) e.aliases = replaced.aliases;
      entries.set(e.name, e);
    }
  }
  validateAliases(entries, configNames);
  if (opts.includeResolved !== false) {
    const taken = new Set<string>(entries.keys());
    for (const e of entries.values()) for (const a of e.aliases ?? []) taken.add(a);
    for (const r of readResolvedEntries()) if (!taken.has(r.name)) entries.set(r.name, r);
  }
  return { entries };
}

/**
 * Install a just-resolved entry into a live registry (S2). Refused — nothing changes —
 * when the entry is not marked resolved, or when `resolveLibrary` maps its name to a
 * curated entry (default, config, or either's alias): a resolved record can replace only
 * another resolved record. Mirrors the load-time precedence. Returns whether it was installed.
 */
export function installResolvedEntry(registry: Registry, entry: LibraryEntry): boolean {
  if (!entry.resolved) return false;
  const owner = resolveLibrary(registry, entry.name);
  if (owner && !owner.resolved) return false;
  if (owner && owner.name !== entry.name) registry.entries.delete(owner.name);
  registry.entries.set(entry.name, entry);
  return true;
}

/** The text every tool returns for a name that resolves to nothing. Lists canonical names
 *  only (aliases are shown by list_libraries). */
export function unknownLibraryMessage(registry: Registry, library: string): string {
  return `Unknown library "${library}". Known: ${[...registry.entries.keys()].join(", ")}`;
}

/**
 * The one lookup every tool uses (get_docs, refresh, doctor, list). Order:
 * exact canonical name → exact alias → the same two again on the trimmed,
 * lower-cased input (agents send "Next.js" and "Supabase"). Undefined when unknown.
 */
export function resolveLibrary(registry: Registry, name: string): LibraryEntry | undefined {
  const lookup = (key: string): LibraryEntry | undefined => {
    const direct = registry.entries.get(key);
    if (direct) return direct;
    for (const e of registry.entries.values()) if (e.aliases?.includes(key)) return e;
    return undefined;
  };
  const exact = lookup(name);
  if (exact) return exact;
  const folded = fold(name);
  return folded !== name && folded.length > 0 ? lookup(folded) : undefined;
}
