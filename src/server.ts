import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { z } from "zod";
import type { Registry } from "./registry.js";
import { getDocsToolText } from "./get-docs.js";
import { refreshToolText } from "./refresh.js";
import { listLibrariesText } from "./list-libraries.js";
import { doctorToolText } from "./doctor.js";
import { resolveToolText } from "./resolve.js";
import { warmToolText } from "./warm.js";
import { shouldAutowarm, startAutowarm, type AutowarmSummary } from "./autowarm.js";

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
        "Get official documentation for a library. With a topic, returns the best-matching sections (following index links when the source is an llms.txt index); without one, returns the document head and section list. An unknown name is resolved automatically from npm / PyPI metadata (llms.txt, then the GitHub README) — any package name works.",
      inputSchema: {
        library: z.string().describe("Library name (or alias) from list_libraries, or any npm / PyPI package name"),
        topic: z.string().optional().describe("What you need docs about"),
        maxTokens: z
          .number()
          .optional()
          .describe("Approximate response budget (default 4000)"),
      },
    },
    async ({ library, topic, maxTokens }) => text(await getDocsToolText(registry, { library, topic, maxTokens })),
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
