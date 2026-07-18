# VibeCTX

**A local MCP server that fetches official library documentation (llms.txt-first), caches it to disk, and serves the relevant sections to your coding agents — offline, deterministic, zero recurring cost.**

> Published on npm as [`@blackraptorai/docs-cache-mcp`](https://www.npmjs.com/package/@blackraptorai/docs-cache-mcp).

By [BlackRaptor AI](https://github.com/BlackRaptorAI) · MIT · Companion to
[development-team-agents](https://github.com/BlackRaptorAI/development-team-agents) and
[business-council-agents](https://github.com/BlackRaptorAI/business-council-agents).

## Why

Coding agents need current, correct docs in context. Cloud docs services work, but you
trade away control, offline use, and repeatability. This server keeps the whole loop
local: fetch once from the official source (preferring each project's published
[`llms.txt` / `llms-full.txt`](https://llmstxt.org/)), cache to disk with a TTL, serve
sections matched to the agent's question. When the network is down you get the cached
copy, clearly flagged as stale, instead of a failure.

## Quickstart

```bash
# Claude Code
claude mcp add docs-cache -- npx -y @blackraptorai/docs-cache-mcp

# or any MCP client (stdio):
npx -y @blackraptorai/docs-cache-mcp
```

## Tools

| Tool | What it does |
|---|---|
| `list_libraries()` | Registry + per-library cache status |
| `get_docs(library, topic?, maxTokens?)` | Fetch-or-cache, then return the sections best matching `topic` (follows llms.txt index links when needed). No topic → table of contents + document head |
| `refresh(library?)` | Force refetch past the TTL (all libraries when omitted) |

## Configuration

Ships with a default registry (Fastify, Prisma, TimescaleDB, pgvector, Anthropic SDK,
AWS CDK, Playwright, React, fastify-type-provider-zod). Add or override libraries with
a JSON config:

```bash
npx -y @blackraptorai/docs-cache-mcp --config ./docs-cache.config.json
```

```json
{
  "libraries": [
    {
      "name": "hono",
      "urls": ["https://hono.dev/llms-full.txt", "https://hono.dev/llms.txt"],
      "ttlHours": 168,
      "description": "Hono web framework"
    }
  ]
}
```

URLs are **candidates probed in order** — list `llms-full.txt` first, then `llms.txt`,
then any curated fallback page (raw GitHub READMEs work well). Cache lives at
`~/.docs-cache-mcp/` (override with `DOCS_CACHE_DIR`). Default TTL is 7 days.

## Design notes

- **Offline-first:** past-TTL cache is served (flagged `STALE:`) when the network fails —
  an old answer beats no answer, but the agent is told which it got.
- **Index-aware:** many projects publish `llms.txt` as a link index rather than full
  content. When the source looks like an index, the topic's best-matching links are
  fetched (and cached) one level deep.
- **Deterministic retrieval:** markdown heading-split + keyword scoring. No embeddings,
  no external calls at query time, same answer every run.

## Using this in a company / behind an air gap?

This tool is free and MIT-licensed, and will stay that way. If you have a **private
documentation, air-gapped, or enterprise deployment need it doesn't cover — 
[open an issue](https://github.com/BlackRaptorAI/VibeCTX/issues)** and describe
your setup. Real-world reports directly shape what gets built.

## Development

```bash
npm install
npm test        # vitest
npm run build   # tsc → dist/
```

## License

MIT © 2026 Tom Hanks / BlackRaptor AI
