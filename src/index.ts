#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { loadRegistry } from "./registry.js";
import { getLibraryDoc, getLinkedPage } from "./fetcher.js";
import { rankSections, assemble, looksLikeIndex, rankLinks } from "./retrieval.js";
import { readCache, cacheRoot } from "./cache.js";

const configFlag = process.argv.indexOf("--config");
const registry = loadRegistry(
  configFlag !== -1 ? process.argv[configFlag + 1] : undefined,
);

const server = new McpServer({ name: "vibectx", version: "0.1.2" });

function text(s: string) {
  return { content: [{ type: "text" as const, text: s }] };
}

server.registerTool(
  "list_libraries",
  {
    description:
      "List the libraries this server can fetch docs for, with cache status. Use get_docs to retrieve content.",
    inputSchema: {},
  },
  async () => {
    const rows = [...registry.entries.values()].map((e) => {
      const ttl = e.ttlHours ?? 168;
      const cached = e.urls
        .map((u) => readCache(e.name, u, ttl))
        .find((h) => h !== undefined);
      const status = cached
        ? `cached ${cached.meta.fetchedAt}${cached.stale ? " (stale)" : ""}`
        : "not cached";
      return `- **${e.name}** — ${e.description ?? ""} [${status}]`;
    });
    return text(`Cache dir: ${cacheRoot()}\n\n${rows.join("\n")}`);
  },
);

server.registerTool(
  "get_docs",
  {
    description:
      "Get official documentation for a library. With a topic, returns the best-matching sections (following index links when the source is an llms.txt index); without one, returns the document head and section list.",
    inputSchema: {
      library: z.string().describe("Library name from list_libraries"),
      topic: z.string().optional().describe("What you need docs about"),
      maxTokens: z
        .number()
        .optional()
        .describe("Approximate response budget (default 4000)"),
    },
  },
  async ({ library, topic, maxTokens }) => {
    const entry = registry.entries.get(library);
    if (!entry) {
      const known = [...registry.entries.keys()].join(", ");
      return text(`Unknown library "${library}". Known: ${known}`);
    }
    const doc = await getLibraryDoc(entry);
    if (!doc) {
      return text(
        `Could not fetch docs for "${library}" — all candidate URLs unreachable and nothing cached. Candidates tried:\n${entry.urls.join("\n")}`,
      );
    }
    const budget = maxTokens ?? 4000;
    const prefix = doc.staleNote ? `> ${doc.staleNote}\n\n` : "";

    if (!topic) {
      const toc = doc.content
        .split("\n")
        .filter((l) => /^#{1,3}\s/.test(l))
        .slice(0, 60)
        .join("\n");
      const head = doc.content.slice(0, budget * 4);
      return text(
        `${prefix}Source: ${doc.url}\n\n${toc ? `Table of contents:\n${toc}\n\n---\n\n` : ""}${head}`,
      );
    }

    // Topic given: if the doc is an index of links, pull the best-matching pages too.
    let corpus = doc.content;
    const followed: string[] = [];
    if (looksLikeIndex(doc.content)) {
      for (const link of rankLinks(doc.content, topic, 3)) {
        const page = await getLinkedPage(entry.name, link.url, doc.url, entry.ttlHours);
        if (page) {
          corpus += `\n\n# ${link.title}\n\n${page.content}`;
          followed.push(link.url);
        }
      }
    }
    const ranked = rankSections(corpus, topic);
    if (ranked.length === 0) {
      return text(
        `${prefix}No sections matched "${topic}" in ${library} docs (source: ${doc.url}). Try broader terms or call get_docs without a topic for the table of contents.`,
      );
    }
    const body = assemble(ranked, budget);
    const followedNote = followed.length
      ? `\nFollowed index links: ${followed.join(", ")}`
      : "";
    return text(`${prefix}Source: ${doc.url}${followedNote}\n\n${body}`);
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
      ? [registry.entries.get(library)].filter((e) => e !== undefined)
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

const transport = new StdioServerTransport();
await server.connect(transport);
