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
| `refresh(library?)` | Force refetch past the TTL (all libraries when omitted; a resolved entry is re-resolved) |
| `resolve_library(name, ecosystem?)` | Turn any npm / PyPI package name into a docs source and report how — see [Any library, no config](#any-library-no-config) |
| `doctor(library?)` | Prove retrieval works per library — same report as `vibectx doctor` below |

`library` is a name from `list_libraries`, one of its aliases (`next`, `tailwind`, `remix`, …),
or **any npm / PyPI package name** — an unknown name is resolved on the spot.

## Any library, no config

Ask `get_docs` for a name the registry does not know and it resolves the package itself —
no curation, no config. `resolve_library` does the same step explicitly and shows its work;
`vibectx resolve <name>` prints the identical report from the command line.

```
$ npx -y @blackraptorai/vibectx resolve fastapi
Resolved "fastapi" via PyPI — https://pypi.org/pypi/fastapi/json
  homepage:   —
  docs:       https://fastapi.tiangolo.com/
  repository: https://github.com/fastapi/fastapi
  candidates (probed in order; first usable document wins):
    1. https://fastapi.tiangolo.com/llms-full.txt — no document
    2. https://fastapi.tiangolo.com/llms.txt — no document
    3. https://raw.githubusercontent.com/fastapi/fastapi/HEAD/README.md — chosen
    4. https://raw.githubusercontent.com/fastapi/fastapi/HEAD/readme.md — not tried
    …
  chosen: https://raw.githubusercontent.com/fastapi/fastapi/HEAD/README.md (readme, 22,568 chars)
  followed-link hosts: fastapi.tiangolo.com (plus the source document's own host; https only)
  saved to ~/.docs-cache-mcp/resolved.json — get_docs("fastapi") works now; pin or override it in vibectx.config.json.
```

**What resolution does**, in order, stopping at the first usable document:

1. **Registry hit** — a canonical name or alias is served as before; nothing is resolved.
2. **Package metadata** — npm (`registry.npmjs.org/<name>/latest`), then PyPI
   (`pypi.org/pypi/<name>/json`). The name must look like a package name (npm rules or
   PEP 503) or nothing is fetched. When both registries know the name, the one whose
   metadata carries a **homepage or docs URL** wins; a hit that offers only a repository
   README yields to the other ecosystem if that one has a docs site (so `httpx`, `fastapi`
   and `requests` resolve to the Python projects even though same-named npm packages
   exist); ties go to npm. npm's `security-holder` placeholder counts as no package.
   Pass `ecosystem: "npm" | "pypi"` (CLI `--npm` / `--pypi`) to decide yourself.
3. **llms.txt probing** — `llms-full.txt` then `llms.txt`, under the docs URL's path and
   its origin, then under the homepage's; at most 8 URLs. HTML served with a 200 does
   not count as a document.
4. **GitHub README** — for a `github.com` repository only, via
   `raw.githubusercontent.com/<owner>/<repo>/HEAD/<README.md | readme.md | Readme.md | README.rst>`
   (`HEAD` is the default branch, whatever it is called).
5. Otherwise one plain line: what was tried, and the config snippet to pin the library.

**Fetch bound.** A resolution makes at most **26 requests**: 2 metadata documents, then
the preferred ecosystem's candidates (8 llms.txt probes + 4 README variants), then — only
if none of those served — the other ecosystem's candidates; it stops as soon as one
document is usable (in practice the worst case is 18, since an ecosystem held back as
README-only has no llms.txt probes). Metadata responses over 8 MiB are treated as absent;
documents keep the normal 25 MiB cap. A process starts at most **100 resolutions per
hour**; beyond that, unknown names get a "resolution limit reached" line until the
window slides (pin the library in config if you hit it).

**Where it persists.** Successful resolutions are written to `resolved.json` in the
cache directory (`~/.docs-cache-mcp/`, or `DOCS_CACHE_DIR`) via a temp file and rename —
an internal file of shape `{ "schemaVersion": 1, "entries": [{ name, urls, description?,
resolved: { source, resolvedAt, metadataUrl, homepage?, docsUrl? } }] }`. On startup they
are merged **below** the defaults and your config: a real registry or config entry always
wins, and a persisted resolution never overrides one — not even a record whose name is a
different-case spelling of a curated one (record names must already be lowercase; PyPI
names are stored in their PEP 503 form, so `typing_extensions` and `Typing-Extensions`
are one record). Records are re-validated on every load (bad ones are skipped; a corrupt
file is ignored; a file written by a newer vibectx with another `schemaVersion` is left
alone and new resolutions stay in memory, with a note on stderr). `list_libraries` marks
them `[resolved]` and prefixes their descriptions `(package-supplied)`; `doctor` checks
them like any entry; `refresh` re-resolves them through the same ecosystem, so a project
that later publishes `llms.txt` is picked up.

When `get_docs` resolves a name on the spot, its response starts with one provenance line
— ecosystem, the package's own description, homepage / repository, and the nearest
curated name when the request looks like a typo of one — ending in *"not a curated
entry; verify this is the package you meant"*. A typo can resolve to a real, unrelated
package; that line is how you notice.

**Command line.** `vibectx resolve <name> [--npm | --pypi] [--config <path>]` exits `0`
when resolved (or already curated), `1` when it could not resolve, `2` on a usage or
config error. The report text and `resolved.json` are **not a stable machine contract**
(there is no `--json`); read them, do not parse them.

**Pin or override.** To fix a resolution you dislike, add the name to `vibectx.config.json`
with your own `urls` — config beats resolution, and the entry stops being `[resolved]`.
To resolve a name into the other ecosystem, run `vibectx resolve <name> --pypi` (or
`--npm`); the later explicit resolution replaces the earlier one.

**`allowedHosts` and followed links.** Followed index links are `https`-only and confined
to the source document's own host **plus** the entry's `allowedHosts`. Redirects are
followed one hop at a time (at most 5): every `Location` is checked against the same rule
*before* it is requested, so a page that redirects to a private address never produces a
request. The same hop rule — `https`, public host — applies to every fetch vibectx makes,
curated primaries included (those may still redirect across hosts). For a resolved
entry that set is derived from its metadata — the homepage host, the docs-URL host and
`docs.<registrable domain of the homepage>` — and is recomputed on every load, never read
from `resolved.json`. In config, `allowedHosts` is an array of bare hostnames
(`"api.acme.com"`), lowercase, or `"*.acme.com"` for subdomains (never the apex); no
scheme, path, port or userinfo. IP literals, `localhost`, `.local`, `.internal` and
single-label names are rejected on the way in and refused on the way out, whatever any
list says. Redirects are re-checked against the same rule. The registrable-domain helper
is deliberately small (last two labels, or three under a short list of two-part suffixes
such as `co.uk`, `com.au`, `github.io`) — no Public Suffix List — so an unlisted
two-part suffix derives a `docs.` host that simply does not exist; harmless, but not
useful.

**Honest limit.** Resolution finds a *source*; it does not make the source good. A
project that publishes `llms.txt` gives full-text answers; most today do not, so the
README on GitHub is what you get — fine for "how do I install / basic usage", thin for
deep API questions. `vibectx doctor --library <name>` tells you which you got. A project
with no GitHub repository and no `llms.txt` cannot be resolved; pin it in config.

**Security note.** Resolution turns package-registry metadata — which anyone can publish —
into fetches. Every URL is checked by name (https only; no IP literals, `localhost`,
`.local`, `.internal`, single-label or trailing-dot hosts; GitHub repositories only via
`raw.githubusercontent.com`; redirects checked hop by hop), and per-name and per-hour
bounds cap the volume (up to 26 requests per unknown name, 100 resolutions per hour per
process, so *N* unknown names can mean up to 26·*N* requests to the registries, docs hosts
and GitHub). Name-based checks cannot see through DNS: a hostname such as
`127.0.0.1.nip.io` resolves to a loopback address and the connection will be attempted;
TLS certificate-name verification then prevents a body from being read from a host that
cannot present a certificate for that name. If your environment has internal services on
routable names, run vibectx where they are not reachable, or pin libraries in config and
do not rely on resolution.

## Configuration

Ships with a default registry of the 30 libraries vibe coders and small startup teams
reach for most:

- **Web frameworks:** `next.js`, `react`, `react-router` (Remix), `astro`, `sveltekit`, `nuxt`, `vue`, `expo`
- **Backend / data:** `supabase`, `firebase`, `convex`, `prisma`, `drizzle-orm`, `trpc`, `hono`, `zod`
- **UI:** `tailwindcss`, `shadcn`, `motion` (Framer Motion), `tanstack-query`
- **AI:** `ai-sdk` (Vercel AI SDK), `openai`, `anthropic-sdk`
- **Auth / payments / email:** `clerk`, `stripe`, `resend`
- **Tooling:** `bun`, `vite`, `vitest`, `playwright`

**Naming rule.** A library's `name` is lowercase and is its npm package name — unless that
package is scoped (`@supabase/supabase-js`), too generic on its own (`ai`), or not what
people call the product (`next`); then it is the product's widely used short name
(`supabase`, `ai-sdk`, `next.js`). Where agents commonly send another name, the entry
carries **aliases** that resolve to the same docs: `next` / `nextjs` → `next.js`,
`tailwind` → `tailwindcss`, `remix` / `react-router-dom` → `react-router`,
`svelte` → `sveltekit`, `framer-motion` → `motion`, `react-query` → `tanstack-query`,
`anthropic` → `anthropic-sdk`, `firebase-js` → `firebase`, `drizzle` → `drizzle-orm`,
`ai` / `vercel-ai` → `ai-sdk`, `supabase-js` → `supabase`, `shadcn-ui` / `shadcn/ui` →
`shadcn`. Lookups are case-insensitive (`Next.js` works). `list_libraries` shows each
entry's aliases as `(aka …)`; every tool that takes a `library` accepts an alias.

Add or override libraries with a JSON config:

```bash
npx -y @blackraptorai/vibectx --config ./vibectx.config.json
```

```json
{
  "libraries": [
    {
      "name": "elysia",
      "aliases": ["elysiajs"],
      "urls": ["https://elysiajs.com/llms-full.txt", "https://elysiajs.com/llms.txt"],
      "ttlHours": 168,
      "description": "Elysia web framework",
      "probeQueries": ["middleware"],
      "allowedHosts": ["*.elysiajs.com"]
    }
  ]
}
```

URLs are **candidates probed in order** — list `llms-full.txt` first, then `llms.txt`,
then any curated fallback page (raw GitHub READMEs work well). Cache lives at
`~/.docs-cache-mcp/` (override with `DOCS_CACHE_DIR`). Default TTL is 7 days.
`allowedHosts` (optional) lists extra hosts followed index links may target — see
[`allowedHosts` and followed links](#any-library-no-config).
`probeQueries` (optional, array of non-empty strings) are the topics `vibectx doctor`
uses to prove the entry answers; without them a query is derived from the description.
An empty array `[]` is accepted and behaves exactly as if `probeQueries` were absent.
`aliases` (optional, array of non-empty strings; `[]` = none) are other names that resolve
to the entry. Unknown top-level keys in the config (for example `$comment`) are ignored.

Names and aliases are trimmed and lower-cased before anything else, so `"name": "Next.js"`
overrides `next.js`. Precedence:

- **Config beats default alias.** A config entry whose `name` or alias equals a *default's
  alias* wins; that alias is silently dropped from the default (`{"name": "next"}` loads and
  `next` is yours, while `next.js` and `nextjs` still reach the default).
- **Alias vs. canonical name is an error.** A config alias equal to any library's `name`
  (default or config), the same alias on two config entries, or an alias equal to its own
  entry's name fails to load, with a message naming both sides.
- **An override keeps the default's aliases unless you say otherwise.** Overriding a default
  (same `name`) and omitting `aliases` inherits them; `"aliases": []` clears them; an
  explicit list replaces them.

**Keep a private stack via committed config.** The default registry is what most teams
share; what only *your* team uses belongs in a `vibectx.config.json` committed to your
repo, so every teammate's agent gets byte-identical context. Config entries merge over
the defaults. [`docs/examples/paragon.vibectx.config.json`](docs/examples/paragon.vibectx.config.json)
is a complete example — the Fastify / TimescaleDB / pgvector / AWS CDK stack that shipped
as the default registry through 0.1.3:

```bash
npx -y @blackraptorai/vibectx --config ./docs/examples/paragon.vibectx.config.json doctor
```

## Checking coverage: `vibectx doctor`

A library can look healthy — bytes cached, refresh succeeded — and still answer
nothing (an `llms.txt` that is only a link index, a README fallback that never
mentions your topic). `doctor` makes coverage a measured property: for every
library it runs the entry's `probeQueries` through the **same `get_docs` path**
your agent uses and reports what came back.

```bash
npx -y @blackraptorai/vibectx doctor                      # human table
npx -y @blackraptorai/vibectx doctor --json               # machine shape (below)
npx -y @blackraptorai/vibectx doctor --library next.js    # one library (aliases work: --library next)
npx -y @blackraptorai/vibectx doctor --offline            # cache only; never touches the network
npx -y @blackraptorai/vibectx doctor --config ./vibectx.config.json
```

```
library   kind         cache  probe                 links  mark
supabase  readme       0.0h   2 probes: 2 answered  0/0    ✓
stripe    readme       0.0h   2 probes: 2 answered  0/0    ✓
react     unreachable  —      —                     0/0    ✗

2/3 libraries healthy
✗ react: unreachable: nothing fetched and nothing cached
```

(Three rows of a run from a network where only GitHub was reachable, so the entries fell
back to their README candidates; with the docs sites reachable you would expect `full-text`
or `index-only` in the kind column.)

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
- **links** — index links followed / dropped (outside the allowed hosts, over 2 MiB, or unreachable).

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
  followed content has accumulated. Primary documents are capped at 25 MiB. Only `https`
  links on the source document's host or the entry's `allowedHosts` are followed, checked
  again after redirects; skipped, oversize or unreachable links are reported in the
  response rather than dropped silently.
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
