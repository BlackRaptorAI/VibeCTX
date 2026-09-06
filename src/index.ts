#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { loadRegistry } from "./registry.js";
import { getDocsToolText } from "./get-docs.js";
import { refreshToolText } from "./refresh.js";
import { listLibrariesText } from "./list-libraries.js";
import { doctorToolText } from "./doctor.js";
import { resolveToolText } from "./resolve.js";
import { dispatchCli } from "./cli.js";

function text(s: string) {
  return { content: [{ type: "text" as const, text: s }] };
}

async function startServer(): Promise<void> {
  const configFlag = process.argv.indexOf("--config");
  const registry = loadRegistry(
    configFlag !== -1 ? process.argv[configFlag + 1] : undefined,
  );

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

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// `vibectx doctor [...]` / `vibectx resolve <name>` run and exit with their code;
// anything else starts the MCP stdio server exactly as before.
const cliExit = await dispatchCli(process.argv, {
  stdout: (s) => process.stdout.write(s),
  stderr: (s) => process.stderr.write(s),
});
if (cliExit !== undefined) {
  process.exitCode = cliExit;
} else {
  await startServer();
}
