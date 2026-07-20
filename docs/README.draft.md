<!--
DRAFT README for VibeCTX 0.2.0 — reviewed by product-marketing, honest-claims
checked (shipped 0.1.x vs roadmap clearly separated). DO NOT replace the live
root README.md with this until 0.2.0 features actually ship (per the GTM plan's
#1 risk: never present roadmap as live). Config-flag note: `--config <path>`
accepts any filename; `vibectx.config.json` is the recommended convention going
forward (0.1.2 examples used docs-cache.config.json; cache dir is
~/.docs-cache-mcp/). CEO review before this goes to the root.
-->

# VibeCTX

**Batteries-included docs for your AI coding agent — feature-rich like the heavy tools, instant like the hosted ones, fully local. `npx` and it works.**

VibeCTX is a local [MCP](https://modelcontextprotocol.io/) server that fetches official library documentation (llms.txt-first), caches it to disk, and serves the sections relevant to your agent's question — offline, deterministic, zero recurring cost.

> Published on npm as [`@blackraptorai/vibectx`](https://www.npmjs.com/package/@blackraptorai/vibectx) · MIT.
> By [BlackRaptor AI](https://github.com/BlackRaptorAI). Companion to [BlackRaptor Agents](https://github.com/BlackRaptorAI/BlackRaptor_Agents).

---

## Why this exists

Coding agents write confident code against APIs that don't exist. The fix is putting real, current docs in the agent's context — and there are good tools for that, but each asks something back:

- **Hosted docs services** work well until the network hiccups, the free tier gets throttled, or you'd simply rather your inner agent loop not depend on a cloud round-trip.
- **Self-hosted options** can mean standing up Docker and wiring an embedding provider before you get your first answer.

VibeCTX keeps the whole loop on your machine and skips the setup tax. Fetch once from the official source, cache to disk, serve matching sections — deterministically, offline, with no account, no container, and no API key. `npx` and it works. Power is opt-in, never required.

## Quickstart

```bash
# Claude Code
claude mcp add vibectx -- npx -y @blackraptorai/vibectx

# or any MCP client (stdio):
npx -y @blackraptorai/vibectx
```

That's the whole install. No Docker, no database, no embedding key, no config file.

## Tools

| Tool | What it does |
|---|---|
| `list_libraries()` | Registry + per-library cache status |
| `get_docs(library, topic?, maxTokens?)` | Fetch-or-cache, then return the sections best matching `topic` (follows llms.txt index links when needed). No topic → table of contents + document head |
| `refresh(library?)` | Force refetch past the TTL (all libraries when omitted) |

## How it works

- **llms.txt-first.** VibeCTX prefers each project's own published [`llms.txt` / `llms-full.txt`](https://llmstxt.org/); candidate URLs are probed in order, with a raw README or docs page as fallback.
- **Index-aware.** When a source is a link index, VibeCTX fetches (and caches) the topic's best-matching links one level deep.
- **Deterministic retrieval.** Markdown heading-split plus keyword scoring. No embeddings, no external calls at query time — the same question returns the same answer every run.
- **Offline-first cache.** Disk cache (etag / TTL); when the network is down, VibeCTX serves the cached copy flagged `STALE:` rather than failing.
- **Safe by default.** A same-origin SSRF guard bounds which links the fetcher will follow.

Cache lives at `~/.docs-cache-mcp/` (override with `DOCS_CACHE_DIR`). Default TTL is 7 days.

## Features

### Available now (0.1.x)

- **llms.txt-first fetch** with index-following and README/docs fallback
- **Disk cache** with etag/TTL and stale-serve when offline
- **Deterministic keyword retrieval** — heading-split + keyword scoring, no embeddings, reproducible
- **Curated registry** of 9 libraries out of the box (Fastify, Prisma, TimescaleDB, pgvector, Anthropic SDK, AWS CDK, Playwright, React, fastify-type-provider-zod)
- **Config override** — add or replace libraries with a JSON file, no code changes
- **Three tools:** `list_libraries`, `get_docs`, `refresh`
- **Same-origin SSRF link guard**

### On the roadmap

> The items below are **planned, not yet shipped.** They describe intended direction, not current capability. Track progress in [issues](https://github.com/BlackRaptorAI/VibeCTX/issues).

**0.2.0 — "Batteries-included, zero-config" (planned):**
- **Auto-resolve any package** (`resolve_library`) — npm/PyPI metadata → llms.txt probing → README fallback, so you can ask for any library without curating a registry entry first
- **Local sources** (`file://` dirs) — index your own project's docs, ADRs, and specs (markdown/text/MDX first)
- **Convention / rules docs as a first-class source** — coding standards, glossary, and architecture decisions served so the agent writes code your way
- **Shareable committed config** (`vibectx.config.json`) — check it into the repo so every teammate's agent gets byte-identical context
- **Cross-library search** — one query across the whole cached corpus
- **Snippet extraction + BM25** — ranked fenced code blocks and better keyword scoring, still deterministic and model-free

**0.3.0 — "Power, opt-in" (planned):**
- **Optional zero-config semantic search** — embeddings that work out of the box, off unless enabled; deterministic keyword retrieval stays the default
- **Private / internal URL sources** with env-token auth
- **Version-specific docs** — per-tag resolution and version-aware cache keys
- **GitHub repo sources** (public first)

Everything on the roadmap is designed to ship with a sensible default and stay zero-config. Optional power never becomes required setup.

## Configuration

VibeCTX runs with no configuration. To add or override libraries, point it at a JSON file:

```bash
npx -y @blackraptorai/vibectx --config ./vibectx.config.json
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

URLs are **candidates probed in order** — list `llms-full.txt` first, then `llms.txt`, then any curated fallback page.

## Who it's for

- **Solo vibe coders** who want correct docs in their agent without an account, a cloud dependency, or a throttled free tier.
- **Small teams** who care about latency and repeatability — the same docs, the same answers, no SaaS in the loop.

If you have a private-documentation, air-gapped, or team need this doesn't cover yet, [open an issue](https://github.com/BlackRaptorAI/VibeCTX/issues) — real-world reports shape what gets built.

## Contributing

Issues and PRs welcome.

```bash
npm install
npm test        # vitest
npm run build   # tsc → dist/
```

- **Repo:** [BlackRaptorAI/VibeCTX](https://github.com/BlackRaptorAI/VibeCTX)
- **Companion agents:** [BlackRaptor Agents](https://github.com/BlackRaptorAI/BlackRaptor_Agents)
- **Product direction & roadmap:** [`docs/PRODUCT-STRATEGY.md`](PRODUCT-STRATEGY.md)

## License

MIT © 2026 BlackRaptor AI. Free and open source — and staying that way.
