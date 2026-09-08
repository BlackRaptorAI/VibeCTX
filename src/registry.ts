import { homedir } from "node:os";
import {
  ConfigError,
  clipText,
  configLocator,
  discoverConfig,
  displayPath,
  readConfigFile,
  MAX_CONFIG_VALUE_CHARS,
  type ConfigFile,
  type ConfigResolution,
} from "./config.js";
import { normaliseAllowedHost } from "./link-policy.js";
import { readResolvedEntries } from "./resolved-store.js";
import { normalisePyPiName } from "./package-names.js";

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
 * Who it is for: solo vibe coders and small teams. Paragon's own platform stack (fastify, timescaledb, pgvector, aws-cdk,
 * fastify-type-provider-zod) moved to docs/examples/paragon.vibectx.config.json — the
 * "keep a private stack via committed config" example.
 *
 * NAMING RULE. `name` is lowercase and is the npm package name — unless that package is
 * scoped (`@supabase/supabase-js`, `@trpc/server`, `@clerk/nextjs`, `@anthropic-ai/sdk`,
 * `@playwright/test`, `@sveltejs/kit`, `@tanstack/react-query`), too generic to recognise on
 * its own (`ai`), or not what people call the product (`next` → Next.js). Then `name` is the
 * product's widely used short name in lowercase (`supabase`, `trpc`, `clerk`, `anthropic-sdk`,
 * `playwright`, `sveltekit`, `tanstack-query`, `ai-sdk`, `next.js`). `aliases` carry the other
 * names agents actually send; they are shipped only where such a name is common. Since
 * PAR-656 (`vibectx warm` reads package.json) every entry whose canonical name is not the
 * npm package name also carries that package name as an alias (`@supabase/supabase-js`,
 * `@trpc/server`, `@clerk/nextjs`, `@anthropic-ai/sdk`, `@playwright/test`, `@sveltejs/kit`,
 * `@tanstack/react-query`; `react-dom` → react), so a manifest name is a curated hit.
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
    aliases: ["react-dom"],
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
    aliases: ["supabase-js", "@supabase/supabase-js"],
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
    aliases: ["tailwind", "@tailwindcss/postcss"],
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
    aliases: ["@trpc/server", "@trpc/client"],
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
    aliases: ["@clerk/nextjs"],
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
    aliases: ["anthropic", "@anthropic-ai/sdk"],
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
    aliases: ["@playwright/test"],
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
    aliases: ["svelte", "@sveltejs/kit"],
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
    aliases: ["react-query", "@tanstack/react-query"],
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
  /** The config sources this registry was built from (PAR-657), for the list_libraries header.
   *  Absent on a hand-built registry (tests, callers that assemble entries themselves). */
  config?: ConfigResolution;
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
function validateAliases(
  entries: Map<string, LibraryEntry>,
  configNames: ReadonlySet<string>,
  fileOf: ReadonlyMap<string, ConfigSite>,
): void {
  const owner = new Map<string, string>();
  /** D-22: a config-caused failure is `<file>: libraries[i].aliases ("name"): <detail>`; a
   *  defaults-only one has no file and no index, so it names the entry in the detail. */
  const fail = (name: string, detail: string): never => {
    const site = fileOf.get(fold(name));
    if (site === undefined) throw new Error(`alias on entry "${name}": ${detail}`);
    throw new ConfigError(site.display, `${configLocator(site.index, "aliases", name)}: ${detail}`);
  };
  for (const e of entries.values()) {
    for (const raw of e.aliases ?? []) {
      const a = fold(raw);
      if (entries.has(a)) {
        const what = a === fold(e.name) ? "the entry itself" : configNames.has(a) ? "another config entry" : "a default library";
        fail(
          e.name,
          `alias "${a}" collides with the canonical name "${a}" (${what}); ` +
            `rename the alias, or override "${a}" (with its urls) and set aliases: [] on that entry`,
        );
      }
      const other = owner.get(a);
      if (other !== undefined) fail(e.name, `alias "${a}" is also declared on "${other}"`);
      owner.set(a, e.name);
    }
  }
}

/** Where a config entry came from: the file as the messages show it, and the entry's index
 *  in that file's `libraries` array — together, D-22's locator. */
interface ConfigSite {
  display: string;
  index: number;
}

/**
 * Normalise one config file's entries: keys folded, allowed hosts normalised, any `resolved`
 * marker dropped (only the resolver may set one). Shape was already validated by
 * `readConfigFile`; what can still fail here is a host VALUE the link policy refuses.
 *
 * The refusal is re-worded into D-22's grammar, with the offending value clipped: it is a
 * string from a file this process did not write, and link-policy quotes it back whole.
 */
function normaliseLayer(libraries: LibraryEntry[], display: string): LibraryEntry[] {
  return libraries.map((e, index) => {
    const normalised: LibraryEntry = { ...e, name: fold(e.name) };
    if (e.aliases !== undefined) normalised.aliases = e.aliases.map(fold);
    if (e.allowedHosts !== undefined) {
      normalised.allowedHosts = e.allowedHosts.map((host) => {
        try {
          return normaliseAllowedHost(host);
        } catch (err) {
          const why = whyHostRefused(err, host);
          const value = clipText(typeof host === "string" ? host : JSON.stringify(host), MAX_CONFIG_VALUE_CHARS);
          throw new ConfigError(display, `${configLocator(index, "allowedHosts", e.name)}: "${value}" ${why}`);
        }
      });
    }
    delete normalised.resolved;
    return normalised;
  });
}

/** link-policy says `allowedHosts: "<value>" <why>`; the value is re-quoted clipped, so
 *  only the reason is taken from its message (and the whole message when it is shaped
 *  differently — a message is never dropped). */
function whyHostRefused(err: unknown, host: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  const prefix = `allowedHosts: ${typeof host === "string" ? `"${host}"` : `"${JSON.stringify(host)}"`} `;
  return message.startsWith(prefix) ? message.slice(prefix.length) : message;
}

/**
 * Merge one config layer over everything loaded so far — the same D-06 / D-07 rules that
 * applied between a config and the defaults, now applied between layers (PAR-657 D-14):
 * project over user over defaults. `entries` is mutated; `configNames` and `fileOf`
 * accumulate across layers so an error can say which file and which kind of entry.
 */
function applyLayer(
  entries: Map<string, LibraryEntry>,
  layer: LibraryEntry[],
  configNames: Set<string>,
  fileOf: Map<string, ConfigSite>,
  display: string,
): void {
  // D-06: every key this layer claims — as a name or an alias — leaves the layers below.
  const claimed = new Set<string>();
  for (const [index, e] of layer.entries()) {
    claimed.add(e.name);
    configNames.add(e.name);
    fileOf.set(e.name, { display, index });
    for (const a of e.aliases ?? []) claimed.add(a);
  }
  const rewritten: [string, LibraryEntry][] = [];
  for (const [key, below] of entries) {
    // copy: never mutate the shipped defaults (or a lower layer's entry)
    if (below.aliases?.some((a) => claimed.has(a))) rewritten.push([key, { ...below, aliases: below.aliases.filter((a) => !claimed.has(a)) }]);
  }
  for (const [key, e] of rewritten) entries.set(key, e);
  // Merge, this layer wins on name; D-07 alias inheritance from the layer it replaces.
  for (const e of layer) {
    const replaced = entries.get(e.name);
    if (e.aliases === undefined && replaced?.aliases !== undefined) e.aliases = replaced.aliases;
    entries.set(e.name, e);
  }
}

/**
 * Build the registry: defaults, optionally merged/overridden by a JSON config file of
 * shape { "libraries": LibraryEntry[] }. Unknown top-level keys (e.g. "$comment") are ignored.
 *
 * Config names and aliases are normalised with trim().toLowerCase() before validation and
 * storage, so {name: "Next.js"} overrides "next.js" rather than adding an entry.
 *
 * Precedence (decisions D-06 / D-07, 2026-09-06):
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
export function loadRegistry(configPath?: string, opts: LoadRegistryOptions = {}): Registry {
  const files: ConfigFile[] = configPath ? [{ path: configPath, scope: "flag", legacy: false }] : [];
  return loadRegistryFrom({ files, notes: [] }, opts);
}

export interface LoadRegistryOptions {
  includeResolved?: boolean;
  /** Directory config paths are shown relative to in messages (default: process.cwd()). */
  cwd?: string;
  /** Home directory those paths are `~`-abbreviated against (default: os.homedir()). */
  home?: string;
}

/**
 * The one loader (PAR-657): defaults, then every config file in `resolution.files` applied in
 * order — LOWEST precedence first, so user layers over the defaults and project over user.
 * `loadRegistry(path)` is this with a single `--config` layer, which is why every 0.1.x
 * behaviour above is unchanged for an explicit config.
 */
export function loadRegistryFrom(resolution: ConfigResolution, opts: LoadRegistryOptions = {}): Registry {
  const cwd = opts.cwd ?? process.cwd();
  const home = opts.home ?? homedir();
  /** D-19: discovered files that failed, by path, with the one-line reason. */
  const skipped = new Map<string, string>();
  let entries: Map<string, LibraryEntry>;
  for (;;) {
    const active = resolution.files.filter((f) => !skipped.has(f.path));
    try {
      entries = buildEntries(active, cwd, home);
      break;
    } catch (failure) {
      // An explicit source (flag or env) that cannot be honoured is fatal — the user asked
      // for that file by name. A discovered one is dropped and the rest is rebuilt without
      // it, so an ambient file cannot take the server down for everyone who launches it.
      if (!(failure instanceof LayerFailure) || failure.file.scope === "flag" || failure.file.scope === "env") {
        throw failure instanceof LayerFailure ? failure.error : failure;
      }
      skipped.set(failure.file.path, failure.reason);
    }
  }
  if (opts.includeResolved !== false) {
    const taken = curatedKeys(entries);
    for (const r of readResolvedEntries()) if (!isTaken(taken, r.name)) entries.set(r.name, r);
  }
  const files = resolution.files.map((f) => {
    const display = displayPath(f.path, cwd, home);
    const error = f.error ?? skipped.get(f.path); // discovery's own verdict, else the loader's
    return error === undefined ? { ...f, display } : { ...f, display, error };
  });
  return { entries, config: { files, notes: resolution.notes } };
}

/** A config layer that failed, and which file it was — so the caller can decide between
 *  "fatal" and "skip it and rebuild" (D-19) without re-parsing the message. */
class LayerFailure extends Error {
  constructor(
    readonly file: ConfigFile,
    readonly error: Error,
  ) {
    super(error.message);
    this.name = "LayerFailure";
  }
  /** The message without the file path: what the D-18 header shows after NOT LOADED. */
  get reason(): string {
    return this.error instanceof ConfigError ? this.error.detail : this.error.message;
  }
}

/**
 * The shipped defaults with `files` applied over them in order (lowest precedence first).
 * Throws `LayerFailure` for anything attributable to one config file — including the
 * cross-layer alias validation, which runs once at the end so that the D-06 alias claims a
 * later layer makes are already in effect, exactly as when every file loads.
 */
function buildEntries(files: readonly ConfigFile[], cwd: string, home: string): Map<string, LibraryEntry> {
  const entries = new Map<string, LibraryEntry>();
  for (const e of DEFAULT_REGISTRY) entries.set(e.name, e);
  const configNames = new Set<string>();
  const fileOf = new Map<string, ConfigSite>();
  const byDisplay = new Map<string, ConfigFile>();
  for (const file of files) {
    if (file.error !== undefined) continue; // discovery already decided this one is unusable (D-19)
    const display = displayPath(file.path, cwd, home);
    byDisplay.set(display, file);
    try {
      const { libraries } = readConfigFile(file.path, display);
      applyLayer(entries, normaliseLayer(libraries, display), configNames, fileOf, display);
    } catch (e) {
      throw new LayerFailure(file, e as Error);
    }
  }
  try {
    validateAliases(entries, configNames, fileOf);
  } catch (e) {
    const file = e instanceof ConfigError ? byDisplay.get(e.display) : undefined;
    if (file === undefined) throw e; // a defaults-only collision is nobody's file
    throw new LayerFailure(file, e as Error);
  }
  return entries;
}

export interface DiscoveredRegistryOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** The `--config` value, when one was passed. */
  flag?: string;
  /** Home directory for the user-level file (default: os.homedir()). */
  home?: string;
  includeResolved?: boolean;
  /** Where the D-16 deprecation notes go, once, at load (stderr for the server and the CLI). */
  warn?: (message: string) => void;
}

/**
 * `discoverConfig` + `loadRegistryFrom` — the single entry point the stdio server (index.ts)
 * and every CLI subcommand use, so a committed `vibectx.config.json` reaches an MCP client
 * that can only ever launch a fixed command line (PAR-657).
 */
export function loadDiscoveredRegistry(opts: DiscoveredRegistryOptions): Registry {
  const resolution = discoverConfig({ cwd: opts.cwd, env: opts.env, flag: opts.flag, home: opts.home });
  const registry = loadRegistryFrom(resolution, {
    includeResolved: opts.includeResolved,
    cwd: opts.cwd,
    home: opts.home ?? homedir(),
  });
  for (const note of resolution.notes) opts.warn?.(note);
  // D-19: one line per discovered file that was skipped. Most MCP clients swallow stderr,
  // which is exactly why the same fact is also on the list_libraries header and in doctor.
  for (const file of registry.config?.files ?? []) {
    if (file.error !== undefined) {
      opts.warn?.(`vibectx: ${file.display ?? file.path}: ${file.error} — file skipped, continuing without it`);
    }
  }
  return registry;
}

/** Every key a curated (non-resolved) entry claims: names, aliases, and each one's PEP 503
 *  form — so a config pin `typing_extensions` also owns `typing-extensions` (schema gate, PAR-655). */
function curatedKeys(entries: Map<string, LibraryEntry>): Set<string> {
  const keys = new Set<string>();
  for (const e of entries.values()) {
    if (e.resolved) continue;
    for (const k of [e.name, ...(e.aliases ?? [])]) {
      keys.add(k);
      keys.add(normalisePyPiName(k));
    }
  }
  return keys;
}

function isTaken(keys: ReadonlySet<string>, candidate: string): boolean {
  return keys.has(candidate) || keys.has(normalisePyPiName(candidate));
}

/**
 * Install a just-resolved entry into a live registry (S2). Refused — nothing changes —
 * when the entry is not marked resolved, or when `resolveLibrary` maps its name to a
 * curated entry (default, config, or either's alias): a resolved record can replace only
 * another resolved record. Mirrors the load-time precedence. Returns whether it was installed.
 */
export function installResolvedEntry(registry: Registry, entry: LibraryEntry): boolean {
  if (!entry.resolved) return false;
  if (isTaken(curatedKeys(registry.entries), entry.name)) return false; // incl. the PEP 503 twin of a curated key
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
 * lower-cased input (agents send "Next.js" and "Supabase") → finally the PEP 503
 * form of the input against the PEP 503 form of every curated name and alias, then of
 * resolved entries (`Typing.Extensions` reaches a `typing_extensions` pin; a pin always
 * beats a resolved record). Undefined when unknown.
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
  if (folded.length === 0) return undefined;
  if (folded !== name) {
    const hit = lookup(folded);
    if (hit) return hit;
  }
  const pep = normalisePyPiName(folded);
  let resolvedMatch: LibraryEntry | undefined;
  for (const e of registry.entries.values()) {
    if ([e.name, ...(e.aliases ?? [])].some((k) => normalisePyPiName(k) === pep)) {
      if (!e.resolved) return e;
      resolvedMatch ??= e;
    }
  }
  return resolvedMatch;
}

function editDistance(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length];
}

/** The curated name or alias within edit distance 2 of `name` (folded), closest first,
 *  registry order on ties; undefined when nothing is close or the name is an exact key.
 *  Used by get_docs to flag a likely typo next to an implicit resolution (R3). */
export function nearestLibraryName(registry: Registry, name: string): string | undefined {
  const needle = fold(name);
  let best: { key: string; d: number } | undefined;
  for (const e of registry.entries.values()) {
    if (e.resolved) continue;
    for (const key of [e.name, ...(e.aliases ?? [])]) {
      const d = editDistance(needle, key);
      if (d === 0) return undefined;
      if (d <= 2 && (best === undefined || d < best.d)) best = { key, d };
    }
  }
  return best?.key;
}
