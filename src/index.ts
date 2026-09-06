#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { loadRegistry, resolveLibrary } from "./registry.js";
import { getLibraryDoc } from "./fetcher.js";
import { getDocs } from "./get-docs.js";
import { listLibrariesText } from "./list-libraries.js";
import { doctorToolText } from "./doctor.js";
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
        "List the libraries this server can fetch docs for, with cache status and source kind (full-text / index-only / readme; unknown until cached). Use get_docs to retrieve content.",
      inputSchema: {},
    },
    async () => text(listLibrariesText(registry)),
  );

  server.registerTool(
    "get_docs",
    {
      description:
        "Get official documentation for a library. With a topic, returns the best-matching sections (following index links when the source is an llms.txt index); without one, returns the document head and section list.",
      inputSchema: {
        library: z.string().describe("Library name (or alias) from list_libraries"),
        topic: z.string().optional().describe("What you need docs about"),
        maxTokens: z
          .number()
          .optional()
          .describe("Approximate response budget (default 4000)"),
      },
    },
    async ({ library, topic, maxTokens }) => {
      const entry = resolveLibrary(registry, library);
      if (!entry) {
        const known = [...registry.entries.keys()].join(", ");
        return text(`Unknown library "${library}". Known: ${known}`);
      }
      return text(await getDocs(entry, { topic, maxTokens }));
    },
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
    async ({ library }) => {
      const targets = library
        ? [resolveLibrary(registry, library)].filter((e) => e !== undefined)
        : [...registry.entries.values()];
      if (targets.length === 0) return text(`Unknown library "${library}".`);
      const results: string[] = [];
      for (const entry of targets) {
        const doc = await getLibraryDoc(entry, { forceRefresh: true });
        results.push(
          doc
            ? `${entry.name}: refreshed from ${doc.url} (${doc.content.length.toLocaleString()} chars)`
            : `${entry.name}: FAILED — all candidate URLs unreachable`,
        );
      }
      return text(results.join("\n"));
    },
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

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// `vibectx doctor [...]` runs the coverage check and exits with its code;
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
