import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { z } from "zod";
import type { Registry } from "./registry.js";
import { getDocsToolText } from "./get-docs.js";
import { searchToolText, MAX_QUERY_CHARS } from "./search.js";
import { refreshToolText } from "./refresh.js";
import { listLibrariesText } from "./list-libraries.js";
import { doctorToolText } from "./doctor.js";
import { resolveToolText } from "./resolve.js";
import { warmToolText } from "./warm.js";
import { shouldAutowarm, startAutowarm, type AutowarmSummary } from "./autowarm.js";
import { sweepCacheTempFiles } from "./atomic-store.js";
import { cacheRoot } from "./cache.js";

/**
 * The MCP server, transport-agnostic (PAR-656 Q2): `buildServer` registers the tools,
 * `startServer` connects a transport and — only then, and only when `shouldAutowarm`
 * says so — kicks off the background autowarm, tied to the connection: when the
 * transport closes, the autowarm's AbortSignal fires and no further fetch is scheduled
 * (R4). index.ts binds this to stdio; tests bind it to an in-memory transport.
 */

function text(s: string) {
  return { content: [{ type: "text" as const, text: s }] };
}

export function buildServer(registry: Registry): McpServer {
  const server = new McpServer({ name: "vibectx", version: "0.1.3" });

  server.registerTool(
    "list_libraries",
    {
      description:
        "List the libraries this server can fetch docs for, with cache status and source kind (full-text / index-only / readme; unknown until cached); [resolved] marks entries auto-resolved from npm/PyPI. Use get_docs to retrieve content.",
      inputSchema: {},
    },
    async () => text(listLibrariesText(registry)),
  );

  server.registerTool(
    "get_docs",
    {
      description:
        'Get official documentation for a library. With a topic, returns the best-matching sections ranked by BM25 (following index links when the source is an llms.txt index); with mode "snippets", returns just the runnable code blocks from those sections, each with its heading path and one line of context. Without a topic, returns the document head and section list. An unknown name is resolved automatically from npm / PyPI metadata (llms.txt, then the GitHub README) — any package name works.',
      inputSchema: {
        library: z.string().describe("Library name (or alias) from list_libraries, or any npm / PyPI package name"),
        topic: z.string().optional().describe("What you need docs about"),
        maxTokens: z
          .number()
          .optional()
          .describe("Approximate response budget (default 4000)"),
        // D-26: an enum, so an unknown mode is a schema error the client sees rather than
        // a silent fall back to sections.
        mode: z
          .enum(["sections", "snippets"])
          .optional()
          .describe('"sections" (default) for prose, "snippets" for code blocks only. Needs a topic.'),
      },
    },
    async ({ library, topic, maxTokens, mode }) =>
      text(await getDocsToolText(registry, { library, topic, maxTokens, mode })),
  );

  server.registerTool(
    "search",
    {
      description:
        "Search ALL cached library docs at once and get the best sections grouped by library — use this when you do not know which library owns a concept (\"how do I stream a response to the client\" could be Next.js, the AI SDK or Hono), or to find out which of your dependencies documents something. Use get_docs instead when you already know the library. Cache-only and offline by design: it never fetches, so it searches exactly the libraries already cached (the response says which, and how to cache the rest with warm_project).",
      inputSchema: {
        // A non-empty query: an empty string is a schema error the client sees, not a search
        // that quietly returns everything. Bounded above too (D-41): a 200,000-term query
        // exhausts the heap, and an out-of-memory here takes down every tool on this server,
        // not one call — so an over-long query is a schema error the client sees as well.
        query: z
          .string()
          .min(1)
          .max(MAX_QUERY_CHARS)
          .describe("What you are looking for, in plain words — e.g. \"server-sent events streaming\""),
        maxTokens: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Approximate response budget (default 4000), shared across all libraries"),
        // Capped at 30: a filter is a shortlist, and an unbounded list is a way to make one
        // call do thirty libraries' work of name resolution.
        libraries: z
          .array(z.string())
          .max(30)
          .optional()
          .describe("Restrict the search to these libraries, by name or alias (default: every cached library)"),
      },
    },
    async ({ query, maxTokens, libraries }) => text(searchToolText(registry, { query, maxTokens, libraries })),
  );

  server.registerTool(
    "refresh",
    {
      description:
        "Force-refetch a library's docs from the network, bypassing the cache TTL. Omit library to refresh everything.",
      inputSchema: {
        library: z.string().optional(),
      },
    },
    async ({ library }) => text(await refreshToolText(registry, library)),
  );

  server.registerTool(
    "doctor",
    {
      description:
        "Check that retrieval actually works per library: source kind (full-text / index-only / readme / unreachable), cache age and staleness, and whether each library's probe queries return sections through get_docs. Same report as `vibectx doctor`. Measures retrieval, not correctness.",
      inputSchema: {
        library: z.string().optional().describe("Check one library only, by name or alias (default: all)"),
      },
    },
    async ({ library }) => text(await doctorToolText(registry, library)),
  );

  server.registerTool(
    "resolve_library",
    {
      description:
        "Resolve any npm or PyPI package name to a docs source without configuration: registry metadata → llms-full.txt / llms.txt on its homepage or docs site → its GitHub README. Reports what was found (source, homepage, candidates tried, chosen URL, kind) and saves the result so get_docs works for that name. get_docs does this implicitly for unknown names; call this to see the details or to pick the ecosystem.",
      inputSchema: {
        name: z.string().describe("Package name, e.g. hono, httpx, @tanstack/react-query"),
        ecosystem: z
          .enum(["npm", "pypi"])
          .optional()
          .describe("Only look in this registry (default: npm first, then PyPI)"),
      },
    },
    async ({ name, ecosystem }) => text(await resolveToolText(registry, name, ecosystem)),
  );

  server.registerTool(
    "warm_project",
    {
      description:
        "Read the project's dependency manifests (package.json, pyproject.toml, requirements*.txt; lockfiles when the manifest is absent) and cache every dependency's primary docs so get_docs answers for the whole stack offline. Unknown names are resolved from npm / PyPI (sharing the server's 100-per-hour resolution cap with get_docs); build/lint tooling is skipped as noise. Reads only the server's working directory or a directory beneath it. Same table as `vibectx warm`.",
      inputSchema: {
        dir: z.string().optional().describe("Project directory: the server's working directory (default) or one beneath it"),
      },
    },
    // D-12: `force` is a CLI flag (`vibectx warm --force`), never a tool input — retrying a
    // name the last run could not resolve is a person's decision, not a model's.
    async ({ dir }) => text(await warmToolText(registry, dir)),
  );

  return server;
}

export interface StartedServer {
  server: McpServer;
  /** The autowarm run, when one was started (tests await it); undefined when opted out. */
  autowarm?: Promise<AutowarmSummary>;
  /** Fires once when the transport closes. */
  closed: Promise<void>;
}

/**
 * Connect `transport`, then start the autowarm in the background (never awaited on the
 * request path; `void`). The autowarm's AbortSignal is tied to the server's `onclose`, so a
 * client that spawns the server and closes it leaves no orphan scheduling fetches (R4).
 */
export async function startServer(
  registry: Registry,
  transport: Transport,
  opts: { env?: NodeJS.ProcessEnv; warn?: (message: string) => void } = {},
): Promise<StartedServer> {
  // S-C: a previous run killed mid-write leaves `<target>.<pid>.<ms>.tmp` files nothing ever
  // reads. Sweep them once, before anything else writes. Best effort; never throws.
  sweepCacheTempFiles(cacheRoot());
  const server = buildServer(registry);
  const controller = new AbortController();
  let resolveClosed!: () => void;
  const closed = new Promise<void>((r) => {
    resolveClosed = r;
  });
  server.server.onclose = () => {
    controller.abort();
    resolveClosed();
  };
  await server.connect(transport);
  // Background revalidation of configured libraries that are uncached or past TTL (PAR-656):
  // fire-and-forget, after the transport is up, never on the request path; every error is
  // swallowed into one stderr line. Opt out with VIBECTX_NO_AUTOWARM=1.
  let autowarm: Promise<AutowarmSummary> | undefined;
  if (shouldAutowarm(opts.env ?? process.env)) {
    autowarm = startAutowarm(registry, { signal: controller.signal, warn: opts.warn });
    void autowarm;
  }
  return { server, autowarm, closed };
}
