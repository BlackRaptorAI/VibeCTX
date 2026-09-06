# VibeCTX

**A local MCP server that fetches official library documentation (llms.txt-first), caches it to disk, and serves the relevant sections to your coding agents — offline, deterministic, zero recurring cost.**

> Published on npm as [`@blackraptorai/vibectx`](https://www.npmjs.com/package/@blackraptorai/vibectx).
> (Formerly `@blackraptorai/docs-cache-mcp` ≤ 0.1.1 — deprecated in favor of this package.)

By [BlackRaptor AI](https://github.com/BlackRaptorAI) · MIT · Companion to
[BlackRaptor Agents — development](https://github.com/BlackRaptorAI/BlackRaptor_Agents/tree/main/development) and
[BlackRaptor Agents — council](https://github.com/BlackRaptorAI/BlackRaptor_Agents/tree/main/council).

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
claude mcp add vibectx -- npx -y @blackraptorai/vibectx

# or any MCP client (stdio):
npx -y @blackraptorai/vibectx
```

## Tools

| Tool | What it does |
|---|---|
| `list_libraries()` | Registry + per-library cache status |
| `get_docs(library, topic?, maxTokens?)` | Fetch-or-cache, then return the sections best matching `topic` (follows llms.txt index links when needed). No topic → table of contents + document head |
| `refresh(library?)` | Force refetch past the TTL (all libraries when omitted) |
| `doctor(library?)` | Prove retrieval works per library — same report as `vibectx doctor` below |

## Configuration

Ships with a default registry (Fastify, Prisma, TimescaleDB, pgvector, Anthropic SDK,
AWS CDK, Playwright, React, fastify-type-provider-zod). Add or override libraries with
a JSON config:

```bash
npx -y @blackraptorai/vibectx --config ./docs-cache.config.json
```

```json
{
  "libraries": [
    {
      "name": "hono",
      "urls": ["https://hono.dev/llms-full.txt", "https://hono.dev/llms.txt"],
      "ttlHours": 168,
      "description": "Hono web framework",
      "probeQueries": ["middleware"]
    }
  ]
}
```

URLs are **candidates probed in order** — list `llms-full.txt` first, then `llms.txt`,
then any curated fallback page (raw GitHub READMEs work well). Cache lives at
`~/.docs-cache-mcp/` (override with `DOCS_CACHE_DIR`). Default TTL is 7 days.
`probeQueries` (optional, array of non-empty strings) are the topics `vibectx doctor`
uses to prove the entry answers; without them a query is derived from the description.
An empty array `[]` is accepted and behaves exactly as if `probeQueries` were absent.

## Checking coverage: `vibectx doctor`

A library can look healthy — bytes cached, refresh succeeded — and still answer
nothing (an `llms.txt` that is only a link index, a README fallback that never
mentions your topic). `doctor` makes coverage a measured property: for every
library it runs the entry's `probeQueries` through the **same `get_docs` path**
your agent uses and reports what came back.

```bash
npx -y @blackraptorai/vibectx doctor                      # human table
npx -y @blackraptorai/vibectx doctor --json               # machine shape (below)
npx -y @blackraptorai/vibectx doctor --library fastify    # one library
npx -y @blackraptorai/vibectx doctor --offline            # cache only; never touches the network
npx -y @blackraptorai/vibectx doctor --config ./vibectx.config.json
```

```
library   kind         cache  probe                               links  mark
fastify   index-only   0.0h   "lifecycle hooks" → index-followed  2/0    ✓
pgvector  readme       3.2h   "hnsw index" → answered             0/0    ✓
react     unreachable  —      —                                   0/0    ✗

2/3 libraries healthy
✗ react: unreachable: nothing fetched and nothing cached
```

Per library it reports:

- **kind** — `index-only` when the document is link-dense (structure, whatever the
  URL; answers depend on following links); `readme` when it is not an index and the
  resolved URL is README-style (host `raw.githubusercontent.com`, or last path segment
  `README`/`README.ext`) **or** has no llms.txt provenance (last path segment is not
  `llms.txt` / `llms-*.txt`); `full-text` for prose at an llms.txt URL;
  `unreachable` when nothing could be fetched and nothing is cached.
- **cache** — age of the cached document in hours, plus `stale` when past its TTL.
- **probe** — `answered` (≥ 1 section returned), `index-followed` (answered, and a
  returned section came from a followed index page — the index alone would have
  returned only its link list), or `no match`. `(derived)` marks a query derived
  from the description because the entry has no `probeQueries`.
- **links** — index links followed / dropped (outside origin, over 2 MiB, or unreachable).

**Exit code** `0` when every checked library is healthy; `1` when any is
`unreachable`, `index-only` with zero links followed, has a probe with `no match`,
or has a cache older than 2× its TTL (inclusive; not applied when `ttlHours` is `0`);
`2` for a usage, config or unknown-library error. `--offline` reports anything not
cached as `unreachable`. A library whose check itself fails (unreadable cache file,
permission error) is reported `unreachable` with `error: <message>` as its reason and
never stops the rest of the table. At most three libraries are checked at a time.

`--json` emits `{ schemaVersion: 1, generatedAt, libraries: [{ library, kind, url,
cacheAgeHours, stale, ttlHours, probes: [{ query, derived, status, followed, dropped }],
followed, dropped, healthy, reasons }], healthy, total }` — keys in that order, `null`
for a missing URL or age. New keys may be appended in later versions; consumers should
read keys by name and must not assert exact key sets. `reasons[]` strings are
human-readable and not a contract. If you snapshot the output, note that `generatedAt`,
`cacheAgeHours`, `url` (which candidate resolved) and `reasons[]` are non-deterministic
run to run; `schemaVersion` is bumped only when a key is renamed, removed or changes meaning.

Honest limit: doctor measures **retrieval, not correctness**. A ✓ means an agent
asking that question today gets sections back; it does not check that they are the
right ones. `list_libraries` shows the same kind per library, classified from the
cache without touching the network (`unknown` until something is cached).

## Design notes

- **Offline-first:** past-TTL cache is served (flagged `STALE:`) when the network fails —
  an old answer beats no answer, but the agent is told which it got.
- **Index-aware:** many projects publish `llms.txt` as a link index rather than full
  content. When the source looks like an index (link-dense, any size), the topic's
  best-matching links — absolute or relative — are fetched (and cached) one level deep:
  up to 3 links, or 5 when the index has more than 200. Each followed page is capped at
  2 MiB (larger responses are dropped, not cached), and no new fetch starts once ~2 MB of
  followed content has accumulated. Primary documents are capped at 25 MiB. Only
  same-origin `https` links are followed, checked again after redirects; skipped,
  oversize or unreachable links are reported in the response rather than dropped silently.
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
