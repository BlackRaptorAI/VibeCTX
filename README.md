# VibeCTX

**A local MCP server that fetches official library documentation (llms.txt-first), caches it to disk, and serves the relevant sections to your coding agents — offline, deterministic, zero recurring cost.**

> Installed from source — clone this repository and build it. See [Install](#install).
>
> **Do not install the npm package.** npm is no longer the distribution channel, and the
> copy still sitting there — `@blackraptorai/vibectx` **0.1.2**, published July 2026 — is
> both stale and unsafe: it predates the 0.1.3 hotfix that closed a redirect escape in the
> fetcher, a quadratic link regex, and unbounded response bodies. 0.1.3 was never published,
> the account is no longer maintained, and that version will not be superseded or withdrawn.
> Everything since 0.1.2 exists only in this repository. (Older still:
> `@blackraptorai/docs-cache-mcp` ≤ 0.1.1, superseded by the rename — same advice.)

By [BlackRaptor AI](https://github.com/BlackRaptorAI) · MIT

## Why

Coding agents need current, correct docs in context. Cloud docs services work, but you
trade away control, offline use, and repeatability. This server keeps the whole loop
local: fetch once from the official source (preferring each project's published
[`llms.txt` / `llms-full.txt`](https://llmstxt.org/)), cache to disk with a TTL, serve
sections matched to the agent's question. When the network is down you get the cached
copy, clearly flagged as stale, instead of a failure.

## Install

VibeCTX runs from a local clone. You need git and Node — `package.json` declares
**Node ≥ 18**, and CI builds and tests on **Node 22**, which is the version this is actually
proven on. Running the test suite needs Node ≥ 20.19 regardless (vitest's `vite` dependency
declares `^20.19.0 || >=22.12.0`); building and running the server does not.

```bash
git clone https://github.com/BlackRaptorAI/VibeCTX.git && cd VibeCTX && npm ci && npm run build
```

The same thing, one step at a time:

```bash
git clone https://github.com/BlackRaptorAI/VibeCTX.git
cd VibeCTX
npm ci          # install dependencies
npm run build   # compile TypeScript to dist/
```

That is the whole install. `dist/index.js` is now the server, and launching it contacts no
package registry — which is the point. An `npx`-style install has to reach the network on
*every* start to resolve what it runs; a docs cache whose own launch depends on the network
would defeat itself.

To use the `vibectx` CLI (every command example below assumes it is on your PATH):

```bash
npm link
```

`npm link` writes into npm's global prefix. On a stock Node install that is root-owned, so
this either needs `sudo` or — better — a user-owned prefix first:
`npm config set prefix ~/.npm-global` and put `~/.npm-global/bin` on your PATH. If you would
rather not link at all, every `vibectx …` example below also works as
`node /absolute/path/to/VibeCTX/dist/index.js …`.

**Nothing is cached yet.** A fresh install has an empty cache, so `vibectx doctor` and
`vibectx search` will both exit 1 with empty results until documents are fetched — that is
correct behaviour, not a broken install. Run `vibectx warm` in a project to cache its
dependencies' docs, or call `get_docs` for one library. See
[Warm your project's docs](#warm-your-projects-docs).

Update with `git pull && npm ci && npm run build`.

> **On pinning:** this repository carries no release tags yet, so `main` is currently the
> only thing to track. Once a `v*` tag exists, checking it out (`git checkout v0.1.3`) is
> how you pin a version — with source distribution the tag is the release artifact.

## Quickstart

Point your MCP client at the built server using the **absolute path** to your clone:

```bash
# Claude Code
claude mcp add vibectx -- node /absolute/path/to/VibeCTX/dist/index.js

# or any MCP client (stdio):
node /absolute/path/to/VibeCTX/dist/index.js
```

## Tools

| Tool | What it does |
|---|---|
| `list_libraries()` | Registry + per-library cache status |
| `get_docs(library, topic?, maxTokens?, mode?)` | Fetch-or-cache, then return the sections best matching `topic`, ranked by BM25 (follows llms.txt index links when needed). `mode: "snippets"` returns just the code blocks. No topic → table of contents + document head |
| `search(query, maxTokens?, libraries?)` | Search **every cached library at once** and get the best sections grouped by library — for when you don't know which library owns a concept. Cache-only and offline; see [Don't know which library? `search`](#dont-know-which-library-search) |
| `refresh(library?)` | Force refetch past the TTL (all libraries when omitted; a resolved entry is re-resolved). A successful refresh also drops that library's other cached pages — the ones followed from links in the document being replaced — so a later `get_docs` re-follows fresh links rather than blending old followed pages into new content. Omitting `library` (a full refresh of everything) is capped at a few calls per hour per running server; a call past the cap is refused with a stated reason. Refreshing one named library at a time has no such cap |
| `resolve_library(name, ecosystem?)` | Turn any npm / PyPI package name into a docs source and report how — see [Any library, no config](#any-library-no-config) |
| `doctor(library?)` | Prove retrieval works per library — same report as `vibectx doctor` below |
| `warm_project(dir?)` | Read the project's dependency manifests and cache every dependency's docs — same table as `vibectx warm` below; reads only the server's working directory or one beneath it (real paths, so a symlink out of it is refused) |

`library` is a name from `list_libraries`, one of its aliases (`next`, `tailwind`, `remix`, …),
or **any npm / PyPI package name** — an unknown name is resolved on the spot.

### How ranking works

No embeddings, no network at query time, same answer every run.

**Tokenizer.** Text is lowercased and split on non-alphanumerics, and identifiers are
split at camelCase and PascalCase boundaries — `useEffect` becomes `use` + `effect`,
`HTTPServer` becomes `http` + `server` — while the whole compound (`useeffect`) is kept
too, so a literal `useEffect` still scores. A light suffix stemmer folds `policies` onto
`policy`, `hooks` onto `hook`, and — after the plural and `ing`/`ed` rules — repairs the
spelling the suffix changed, in both directions: it drops a silent `e` so `parse` /
`parsing` / `parsed` / `parses` all land on `pars`, undoubles a consonant so `running`
lands on `run`, and puts a silent `e` back so `type` / `typed` / `typing` all land on
`type` rather than on the bare `typ`. Three exceptions are deliberate and documented in
`src/tokenize.ts`: `using` is a stopword and keeps its own form; there is no agent-noun
rule, so `handler` and `router` stay distinct from `handle` and `route`; and `embed` does
not meet `embedded`, because no suffix rule can tell a real `-ed` from a word that merely
ends in one. A small stopword list drops "how do I use the …"
scaffolding, unless the query is nothing but stopwords. The result: asking for "use
effect cleanup" finds `useEffect`, and asking for `useEffect` finds "use effect".

**BM25.** Sections are scored with Okapi BM25 (k1 = 1.2, b = 0.75) over the sections of
that call — the primary document plus any followed index pages. Because BM25 weighs a
term by how rare it is, a section containing `upsert` beats a long section that merely
repeats `query`, and length normalization stops a big section winning on bulk. A term in
the section's own heading counts three times; one in an ancestor heading or in the body
counts once. Sections that score zero are dropped; ties keep document order.

**Heading path.** Sections know where they sit in the heading tree, so a returned H4 is
rendered as `## Auth > Row Level Security > Policies` rather than a context-free
`## Policies`. A `#` line inside a fenced code block is code, not a heading — with one
known limitation: a fence indented four or more spaces, or with a tab, is an indented code
block under CommonMark and is not recognised as a fence, so its contents are not protected
as code. In practice the block's own lines are indented with it and an ATX heading must
start at column 0, so they do not become headings; a line inside such a block that is
*not* indented with it — a `#` at column 0 — is outside that protection and does start a
new section. The primary document and each followed index
page are split into sections **separately**, so an unclosed fence in one page cannot
swallow another, and a followed page's headings read under that page's own title. The
heading path, a snippet's language and its context line are stripped of control, bidi and
zero-width characters before they are rendered; section bodies are not, because the body
is the document.

Measured comparison against the previous ranker: on the GitHub-README corpus the
build sandbox can reach, BM25 and the previous ranker tie at 18 of 60 probe
questions answered with the right section in the top result (+0/−0; "no sections
matched" falls from 12 to 7). The docs-site `llms-full.txt` primaries these
libraries publish — the documents the ranker is meant for — are unreachable from
that sandbox, so this is not yet a measurement of the ranking on real
documentation. Full numbers and method:
[`docs/eval/2026-09-06-par-658.md`](docs/eval/2026-09-06-par-658.md).

### Code-first answers: `mode: "snippets"`

When the question is really "show me the call", pass `mode: "snippets"` and get the
fenced code blocks instead of the prose around them. Each snippet carries its heading
path, one line of context from the doc, and the fence's language:

```jsonc
// tool call
{ "library": "acme-pay", "topic": "checkout session create", "mode": "snippets" }
```

~~~markdown
Source: https://docs.acme.example.com/llms-full.txt

### Acme Pay > Checkout > Create a Checkout Session
Create the session on your server, then redirect the customer:

```js
const session = await acme.checkout.sessions.create({
  line_items: [{ price: 'price_123', quantity: 1 }],
  mode: 'payment',
  success_url: 'https://example.com/thanks',
});
```
~~~

**Where that response came from.** `acme-pay` is a made-up library on a
[reserved documentation domain](https://datatracker.ietf.org/doc/html/rfc2606), and the
block above is the real, unedited output of this code against a fixture document — pinned
by `test/get-docs.test.ts` ("produces the README's snippets example verbatim"), which
fails if the two ever drift. It is the *shape* of a response, not a capture from any
vendor's documentation site; the exact headings depend on what the library publishes.

A snippet is ranked by its section's BM25 score plus a BM25 over the code itself, so the
block that actually contains the call you asked for wins. Blocks under two lines are
skipped unless the query names them exactly. The code is fenced with a backtick run
longer than any run inside it, so a code sample that itself contains a fence cannot break
out of its block, and the whole thing is clipped to `maxTokens`. `mode` needs a topic; the default is
`"sections"`, and anything other than those two values is a schema error. When nothing
matches you get, in full:

```
No code snippets matched "<topic>" in <library> docs (source: <url>). Try mode "sections" or broader terms.
```

## Don't know which library? `search`

`get_docs` needs a library name. Half the time you don't have one: *"how do I stream a
response to the client"* could be Next.js, the AI SDK or Hono, and guessing wrong costs a
round trip. `search` runs one query across **every document already in your cache** and
groups the hits by library, so the answer to "which library documents this?" comes back
with the section that proves it.

```bash
vibectx search "server-sent events streaming"
vibectx search "server-sent events" --library hono --library ai-sdk
vibectx search "revalidate" --max-tokens 1500 --json
```

~~~markdown
# acme-pay
Source: https://docs.acme-pay.example.com/llms-full.txt

## Acme Pay > Webhooks > Listening for events

Open a server-sent events stream to receive payment events as they happen:

```js
const events = acme.events.stream({ types: ['payment.succeeded'] });
```

# acme-edge
Source: https://docs.acme-edge.example.com/llms-full.txt

## Acme Edge > Streaming responses

Return a `ReadableStream` from a handler and Acme Edge flushes each chunk as it is produced.

Searched 2 of 2 configured libraries; 2 matched.
~~~

**Where that response came from.** `acme-pay` and `acme-edge` are made-up libraries on a
[reserved documentation domain](https://datatracker.ietf.org/doc/html/rfc2606), and the block
above is the real, unedited output of this code against a fixture — pinned by
`test/search.test.ts` ("produces the README's search example verbatim"), which fails if the
two ever drift. It is the *shape* of a response, not a capture from any vendor's site.

**Cache-only, by design.** `search` never fetches, never resolves a new package name and
never touches the network — so it is deterministic and works on a plane. (How fast is
measured, not asserted: see [the search index](#the-search-index).) The flip side is that it
searches exactly what is already cached, which is why every response ends with how many
libraries it looked at, out of how many are configured, and how to cache the rest:

```
Searched 5 of 30 configured libraries; 4 matched.
Not cached, so not searched: supabase, tailwindcss, shadcn, stripe, expo, drizzle-orm, prisma, trpc and 17 more. Run `vibectx warm` in your project to cache your dependencies' docs, or call get_docs for one library.
```

So the pairing is: **`vibectx warm` once, then `search` freely.**

**How results are put together.** Same tokenizer, same BM25 and the same field weighting as
`get_docs` ([How ranking works](#how-ranking-works)) — but the corpus is every section of
every cached document at once, so a rare term picks the right library out of thirty instead
of the wordiest one. Libraries are ordered by their best section's score, sections within a
library by score, ties by document order. The `maxTokens` budget (default 4000) is shared
across libraries and spent **round-robin** — the best library's best section first, then the
next library's best, and so on — because the question is *which library*, and one verbose
library filling the whole response would defeat that. At most 8 libraries appear in one
response. Each group carries its `Source:` line, and a cached copy past its TTL is marked
stale with the `vibectx refresh` line that would fix it.

**The budget is a cap, and the answer outranks it.** It is priced on the text you actually
get back: whole rendered sections, their group headers, and the separators between them, with
the closing accounting line reserved out of it. Whenever the budget can hold an answer at all,
the rendered response and the sum of `--json` section bodies both stay inside `maxTokens × 4`
characters.

What the budget never buys is silence. At **any** budget the response carries the
best-scoring library's name, its `Source:` line, and at least one section of its text; when
the budget cannot hold both that and the accounting, the accounting is what gives way, in
this order — other libraries are dropped, the section body is clipped, the closing accounting
shrinks to one line (`Searched 3/8 libraries; 3 matched, 1 shown. (Accounting shortened to
fit the budget.)`), and then it goes altogether. A section excerpt is never clipped below 120
characters, so a budget too small even for the smallest possible answer — one library name,
one `Source:` line, one 120-character excerpt — gets that answer anyway, over budget, with
one line saying by how much. That is the only case in which a response exceeds
`maxTokens × 4`, and it always announces itself.

`--library <name>` (repeatable; `libraries: [...]` over MCP) narrows the search; names and
aliases both work, and an unknown one is *reported in the response* rather than failing the
search. A filtered search reports both numbers — `Searched 1 of 2 requested libraries
(30 configured)` — so narrowing the search can never make your cache look emptier than it
is. `query` is capped at 1000 characters — a longer one is clipped rather than refused, and
said so twice: on stderr for the terminal and in `notes` for `--json`. `maxTokens` is capped
at 200,000, on `search`, on `get_docs`, and at `--max-tokens` — unlike `query`, an over-budget
value is *refused*, not clipped. Exit codes: `0` something matched, `1` nothing matched, `2`
usage or config error.

`--json` emits `{ schemaVersion: 1, generatedAt, query, maxTokens, groups, configured,
requested, searched, searchedLibraries, matchedLibraries, unknown, uncached, fromIndex,
tokenized, indexWritten, notes }`. `schemaVersion` is bumped when a key is renamed, removed
or changes meaning; adding a key is not a bump, and **where** a key is added is not part of
the contract — read keys by name. The emitted order is stable (and pinned by a test) because
a diffable file is worth having, not because a reader may depend on it.

### The search index

To avoid re-reading and re-tokenizing every `llms-full.txt` on every query, `search` keeps a
small inverted index at `<cache>/index.json`. Three things are worth knowing about it:

- **It is a derived cache, never a source of truth.** It stores no document text at all —
  only per-section token counts and, per term, which sections it occurs in. Bodies and
  heading paths are read out of the cached document at query time. Every entry also carries
  a content hash, and an entry whose hash does not match the cached document is ignored and
  rebuilt. So a stale, hand-edited or planted index cannot make `search` return a single word
  the cache does not hold — at worst it costs a slower query.
- **It is keyed to the code that built it.** The file also records a *retrieval version*, and
  a file written by a build whose tokenizer, stemmer, section splitter or field weighting
  differed is refused whole and rebuilt. The content hash proves the *document* is unchanged,
  which is exactly why a change to that code slips past it: same bytes, different terms, and
  the answer would go quietly empty instead of visibly wrong.
- **It maintains itself.** Every writer of a library's primary document updates it —
  `warm`, the startup autowarm, `get_docs`, `refresh`, and `resolve_library` (so a
  *newly resolved* library is indexed the moment it is cached, not on some later run).
  `refresh` invalidates that library's entry first and a successful refresh rebuilds it.
  Anything missing is rebuilt inside the next `search`. Deleting the file is always safe: the
  next search rebuilds what it needs and answers the same way.
- **What it costs is vocabulary, not bytes — and it does not stay at 44 ms as you scale.**
  Two MEASURED points on the build sandbox, both worth carrying:

  | corpus | index file | warm `search` | one-off index build |
  | --- | --- | --- | --- |
  | 5.63 MB, 12 documents | 0.55 MB (10%) | **44 ms** | ~300 ms |
  | 146 MB, 30 documents | 16.9 MB (12%) | **820–893 ms** | 6.3 s |

  The 300 ms target this feature was built to is the **first** row — a normal project's stack
  of `llms.txt` files. Thirty five-megabyte `llms-full.txt` documents is 2.7–3.0× that target,
  and the cost there is dominated by `JSON.parse` of a 17 MB index plus a SHA-256 over every
  scanned document. The first row is printed by `test/search-perf.test.ts` on every run; the
  second by `npm run build && node scripts/probe-search-scale.mjs`, which generates its own
  corpus (no network, nothing to download) and prints the row it measured — the figures above
  are one of its runs, and a re-run on your own machine is the only number worth trusting.
  A pathological corpus in which every token is globally unique is the other extreme — 146%
  of the corpus and 100 ms for 1.65 MB. Documents over 8 MiB are not indexed at all; they are tokenized at
  query time and the response says so for that library. The file itself is never written
  larger than the 64 MiB a read will accept: past that, the largest entries are left out and
  the response names them.

## Warm your project's docs

One command, and your whole stack's docs are on disk — works offline, never a 429:

```bash
cd my-app
vibectx warm
```

```
vibectx warm · /Users/me/my-app · cache /Users/me/.vibectx
manifests: package.json

dependency             library      status               url
next                   next.js      cached               https://raw.githubusercontent.com/vercel/next.js/canary/packages/next/README.md
react                  react        cached               https://raw.githubusercontent.com/reactjs/react.dev/main/src/content/reference/react/useEffect.md
@supabase/supabase-js  supabase     cached               https://raw.githubusercontent.com/supabase/supabase-js/master/packages/core/supabase-js/README.md
stripe                 stripe       cached               https://raw.githubusercontent.com/stripe/stripe-node/master/README.md
tailwindcss            tailwindcss  cached               https://raw.githubusercontent.com/tailwindlabs/tailwindcss/main/README.md
typescript             typescript   resolved+cached      https://raw.githubusercontent.com/microsoft/TypeScript/HEAD/README.md
@types/node            —            denied (noise list)  —
eslint-config-next     —            denied (noise list)  —

6/6 dependencies cached · 2 denied (noise list)
```

(A real run against that `package.json`, reproduced on 2026-09-06 from a sandbox where
only `raw.githubusercontent.com` was reachable, so every entry fell back to its README
candidate; with the docs sites reachable you would see `llms-full.txt` / `llms.txt` URLs
where projects publish them. Every row and the totals are that run's; only the two paths
in the header line are shown as a typical macOS home rather than the run's temporary
directories.) Afterwards `get_docs("stripe", "webhook signature verification")` answers
from the cache with the network unplugged.

**What it reads** (each file once; names de-duplicated per ecosystem):

- `package.json` — `dependencies` and `devDependencies` (not peer / optional / bundled).
  `npm:` alias specs are unwrapped to the real package; `file:` / `link:` / `workspace:` /
  `portal:` specs are local packages and skipped.
- `pyproject.toml` — `[project].dependencies`, every `[project.optional-dependencies]`
  group, every `[dependency-groups]` group, `[tool.poetry.dependencies]`,
  `[tool.poetry.dev-dependencies]`, `[tool.poetry.group.<g>.dependencies]`; a poetry inline
  table with `path`, `git` or `url` is a local or VCS source and is skipped (like `file:` in
  package.json). Read by a small built-in TOML reader (table headers, `key = value`, string
  arrays, one-line inline tables); dotted keys inside a table and multi-line strings are not
  supported.
- `requirements*.txt` — `requirements.txt` first, then the rest; versions, extras, markers,
  comments and `\` continuations stripped; `-r` / `--requirement` includes followed one
  level, relative to the including file and only inside the project directory; `-c`, `-e`,
  options, URLs and paths skipped. PyPI names are normalised (PEP 503), so
  `Typing_Extensions` and `typing-extensions` are one dependency. Only names that pass the
  npm / PEP 508 name rules are kept (the rest are counted in a note, never printed); a
  manifest over 32 MiB is not read. **Symlinks are refused:** every manifest and every `-r`
  target is checked component by component, and a symlink anywhere in the path — or a real
  path that resolves outside the project directory — is `skipped (symlink)` / skipped as
  outside; the project directory itself may live behind a symlink. File names and include
  paths are stripped of control, bidi and zero-width characters before they are printed.
- Lockfiles, **only when the ecosystem's manifest is absent**, for names: `package-lock.json`
  v2/v3 (the root package's lists; v1 has none and is reported), `pnpm-lock.yaml`
  (`importers['.']`, or the v5 top-level blocks). `yarn.lock`, `uv.lock` and `poetry.lock`
  list every package with no cheap root marker and are reported, not read.

**What it does per dependency.** A registry name or alias (the npm package names of the
scoped entries are aliases: `@supabase/supabase-js`, `@trpc/server`, `@clerk/nextjs`,
`@anthropic-ai/sdk`, `@playwright/test`, `@sveltejs/kit`, `@tanstack/react-query`,
`@tailwindcss/postcss`; `react-dom` reaches `react`) is warmed through the same fetch
`get_docs` uses: a fresh cached copy is left alone (`already fresh`), a stale one is
revalidated with `If-None-Match`, a missing one is fetched (`cached`). Registry entries match
**by name regardless of ecosystem**: the shipped defaults are the npm packages, so a Python
project that depends on `stripe` or `openai` gets the npm entry's docs, and the row says so
— `curated entry is the npm package` (for an auto-resolved record, `resolved entry is the
<npm|pypi> package`, with the `--npm` / `--pypi` switch to re-resolve). An `ecosystem` field
on entries is a queued follow-up. Anything else is resolved from the ecosystem the manifest
implies (`package.json` → npm only, Python files → PyPI only), exactly as
[`resolve_library`](#any-library-no-config) would, and reported `resolved+cached`; these
resolutions **share the process's 100-resolutions-per-hour cap** with `get_docs` and
`resolve_library` — a large project can spend the hour's budget in one run. Names on the
noise list are `denied (noise list)` and never fetched. Up to four names are warmed at once;
names that map to one entry share one fetch.

**Recent failures are not retried every run.** A name the previous run left `unresolved` is
reported `unresolved (recent)` for 24 hours from that failure — no resolution slot spent,
no network — with the original reason and time in the detail line. `vibectx warm --force`
retries now; after 24 hours it retries by itself. `--force` is a **CLI flag only** — the
`warm_project` tool takes `dir` and nothing else, so spending the resolution budget on names
the last run already proved unresolvable stays a person's decision. The memo never applies
to a name the registry has since learned (pinned in config, or resolved another way).

**Statuses:** `cached` · `already fresh` · `resolved+cached` · `unresolved` (the resolver's
attempt summary is printed below the table) · `unresolved (recent)` (see above) ·
`denied (noise list)` · `skipped (rate cap)` (the 100-resolutions-per-hour cap was reached
mid-run; the run continues; run `warm` again later) · `unreachable` (nothing fetched — a
stale copy, if any, is kept and said so).

**Exit code** `0` when every attempted dependency is `cached`, `already fresh` or
`resolved+cached` (denied names do not count); `1` when any is `unresolved`,
`unresolved (recent)`, `unreachable` or `skipped (rate cap)` — the promise is "your stack's
docs are on disk", and they are not yet; `2` for a usage error, an unreadable config, a
directory that is not a directory, or a directory with no manifest to read. `vibectx warm
[dir]` takes any directory (default: the current one); the `warm_project` tool accepts only
the server's working directory or a directory beneath it — compared on **real** paths, so a
symlink inside the working directory that points elsewhere, or a sibling that merely shares
the prefix (`/a/proj-evil` against `/a/proj`), is refused — and answers "outside the project
directory" for anything else. `--offline` prints a cache-only report (fresh / stale / missing
per name, unknown names `unresolved`) without touching the network or writing anything;
`--force` retries recent failures; `--json` emits `{ schemaVersion: 1, generatedAt, dir,
offline, manifests, notes, dependencies: [{ name, ecosystem, source, library?, status, url?,
note?, failedAt? }], cached, attempted, denied, total }` — keys in that order (each row's
keys in that order too); new keys may be appended; read keys by name. `schemaVersion` is
bumped when a key is renamed, removed or changes meaning **and when a status value is added
or removed** — readers drop rows whose status they do not know. A discovered config file the
loader skipped adds one `notes` entry, `config: <path> (<scope>) not loaded: <reason>`, to
both the table and `--json`, so a run that fell back to the shipped defaults never reads as a
clean one. `--config <path>` loads your config first, so pinned entries win.

**Noise list.** `DEPENDENCY_DENYLIST` in `src/project-deps.ts` (a trailing `*` is a prefix
rule): npm `@types/*`, `eslint*`, `@eslint/*`, `prettier*`, `@typescript-eslint/*`,
`tslib`, `@babel/*`, `postcss`, `autoprefixer`, `husky`, `lint-staged`; PyPI `setuptools*`,
`wheel`, `pip`, `build`, `twine`, `black`. Kept on purpose: `typescript`, `pytest*`, `ruff`,
`mypy`. Everything not listed is attempted.

**What warm does not do.** It caches each dependency's *primary* document only; index links
are followed by `get_docs` on demand, per topic, not during warm. It does not make a source
good: a project without `llms.txt` gets its README, as with resolution — `vibectx doctor`
tells you which you got. It does not re-resolve entries already resolved (that is
`refresh`). It does not read peer dependencies, transitive dependencies, or lockfiles when a
manifest exists.

**Project record.** Each run (not `--offline`) writes `projects/<hash of the absolute
directory>.json` in the cache directory — `{ schemaVersion: 1, dir, manifests,
dependencies, warmedAt }`, atomically and validated on read. A file with an **older**
`schemaVersion` is replaced; one with a **newer** `schemaVersion` (written by a newer
vibectx) is left alone with a note on stderr and a `project record not written: newer schema
on disk` note in the report (`--json` included) — the same rule `resolved.json` follows. The
record is **best effort**: if it cannot be written (an unwritable cache directory, a full
disk) the run still prints its table and still exits on the dependencies alone, with one
stderr line and a `project record not written: <reason>` note. It feeds one decision, the
24-hour `unresolved (recent)` memo above; otherwise it is informational.

Validation on read is per field, because anything with write access to the cache directory
can edit the file: a `url` that is not an https URL is dropped from its row; a `source` that
is not a plain relative manifest path (`package.json`, `sub/requirements.txt` — never
absolute, never containing `..`) drops the whole row, as do a bad `name`, `ecosystem`,
`status` or `failedAt`; an over-long `library` is dropped from its row and an over-long
`note` is truncated. `warmedAt` and `failedAt` must be strict ISO-8601 UTC instants of the
form `2026-09-06T06:00:00.000Z` — `Date.parse` on its own accepts a "date" with a trailing
parenthesised comment, and `warmedAt` is printed verbatim in the `list_libraries` summary
line, so a bad `warmedAt` makes the whole record read as absent. That accepted timestamp
shape is part of `schemaVersion` 1: a reader of this version rejects anything else, so
widening it — accepting a `+01:00` offset, say — requires a version bump, exactly as adding
or removing a status value does. Control, bidi and zero-width characters are stripped from
every field.

**The `list_libraries` summary line.** When a record exists for the server's working
directory, `list_libraries` ends with `Project deps (<dir>): N cached, M unresolved, K
denied — warmed <time>`. Two things to know about that line:

- **`unresolved` is a bucket, not a status.** It counts every row that is not cached and not
  denied — `unresolved`, `unresolved (recent)`, `unreachable` and `skipped (rate cap)`
  together. So a run that hit the resolution cap, and one whose network was down, both read
  as "unresolved" here. Run `vibectx warm` for the per-name breakdown; the summary is
  deliberately one line. (Splitting the bucket is a queued follow-up.)
- **It emits the absolute project directory** — the value of `dir` — to whatever model is
  reading `list_libraries`. That is the path the server was started in; it is not secret, but
  it is not nothing either.

**A moved project gets a new record.** The file name is a hash of the absolute directory, so
renaming or moving a project writes a fresh record at the new path and leaves the old one in
place. Nothing prunes them today (a queued follow-up); they are inert, a few KB each, and
`rm -rf` on the cache directory clears them.

**Background revalidation on startup.** When the MCP server starts (never under `doctor`,
`resolve` or `warm`), any *configured* library — default or config, not auto-resolved
records — that is uncached or past its TTL is fetched in the background after the transport
is connected: two at a time, `If-None-Match` first, so a warm cache costs one conditional
request per stale entry and nothing for fresh ones, while a first start with an empty cache
fetches the 30 defaults the way `refresh` would. It never delays the handshake or a tool
call; `list_libraries` shows `warming…` on entries in flight; the outcome is one line on
stderr (`vibectx: autowarm cached N/M configured libraries`), and every error stays there —
the server does not depend on it. When the client closes the connection, nothing further is
scheduled and the process ends (a fetch already in flight is given 100 ms). Opt out with
`VIBECTX_NO_AUTOWARM=1` in the server's environment (see [Configuration](#configuration)).

## Any library, no config

Ask `get_docs` for a name the registry does not know and it resolves the package itself —
no curation, no config. `resolve_library` does the same step explicitly and shows its work;
`vibectx resolve <name>` prints the identical report from the command line.

```
$ vibectx resolve fastapi
Resolved "fastapi" via PyPI — https://pypi.org/pypi/fastapi/json
  description: (package-supplied) FastAPI framework, high performance, easy to learn, fast to code, ready for production
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
  saved to ~/.vibectx/resolved.json — get_docs("fastapi") works now; pin or override it in vibectx.config.json.
```

(A real run, re-verified on 2026-09-06 line by line, including the 22,568-char figure.
Two things are presentation, not output: candidates 5 and 6 are elided at the `…`, and the
last line shows the default cache directory in place of the `VIBECTX_CACHE_DIR` the run used.
The first two candidates report `no document` because that sandbox cannot reach
`fastapi.tiangolo.com` — from a machine that can, `llms.txt` may well win instead.)

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
cache directory (`~/.vibectx/`, or `VIBECTX_CACHE_DIR`) via a temp file and rename —
an internal file of shape `{ "schemaVersion": 1, "entries": [{ name, urls, description?,
resolved: { source, resolvedAt, metadataUrl, homepage?, docsUrl? } }] }`. On startup they
are merged **below** the defaults and your config: a real registry or config entry always
wins, and a persisted resolution never overrides one — not even a record whose name is a
different-case spelling of a curated one (record names must already be lowercase; PyPI
names are stored in their PEP 503 form, so `typing_extensions` and `Typing-Extensions`
are one record). Records are re-validated on every load (bad ones are skipped; a corrupt
file is ignored; a file written by a **newer** vibectx — a higher `schemaVersion` — is left
alone and new resolutions stay in memory, with a note on stderr; a lower one is replaced). The
`resolved.json` record stays in memory the same way, with the same kind of note, when the
write itself fails — a read-only `$HOME` or a full disk — rather than being refused by schema
version. `list_libraries` marks them `[resolved]` and prefixes their descriptions
`(package-supplied)`; `doctor` checks them like any entry; `refresh` re-resolves them through
the same ecosystem, so a project that later publishes `llms.txt` is picked up.

When `get_docs` resolves a name on the spot, its response starts with one provenance line
— ecosystem, the package's own description, homepage / repository, the nearest
curated name when the request looks like a typo of one, and (when the write above
failed) `resolution not saved: <reason>` — ending in *"not a curated
entry; verify this is the package you meant"*. A typo can resolve to a real, unrelated
package; that line is how you notice. A failed save of the *record* never costs you the
answer: the document itself was already fetched and cached before the record write is
attempted, so it is still returned, and the resolution still works for the rest of this
process. (A cache directory that is read-only from before this library was ever cached is a
different case — there the document cannot be cached either, and the name reports as
unresolvable rather than resolved-but-unsaved.)

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
curated primaries included (those may still redirect across hosts), **with one narrow,
explicit exception: a config entry's own `urls`, when that entry sets `allowInternalHosts:
true` — see below.** For a resolved entry that set is derived from its metadata — the
homepage host, the docs-URL host and `docs.<registrable domain of the homepage>` — and is
recomputed on every load, never read from `resolved.json`. In config, `allowedHosts` is an
array of bare hostnames (`"api.acme.com"`), lowercase, or `"*.acme.com"` for subdomains
(never the apex); no scheme, path, port or userinfo. IP literals, `localhost`, `.local`,
`.internal` and single-label names are rejected on the way in and refused on the way out,
whatever any list says. Redirects are re-checked against the same rule. The
registrable-domain helper is deliberately small (last two labels, or three under a short
list of two-part suffixes
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
`shadcn`, `react-dom` → `react`, and the npm package name of every scoped entry
(`@supabase/supabase-js`, `@trpc/server` / `@trpc/client`, `@clerk/nextjs`, `@anthropic-ai/sdk`,
`@playwright/test`, `@sveltejs/kit`, `@tanstack/react-query`) so what `package.json` says
is a curated hit. Lookups are case-insensitive (`Next.js` works). `list_libraries` shows each
entry's aliases as `(aka …)`; every tool that takes a `library` accepts an alias.

Add or override libraries with a JSON config:

```bash
vibectx --config ./vibectx.config.json
```

A `vibectx.config.json` committed to your repo is picked up with **no flag at all** — see
[Team config, no flags](#team-config-no-flags) for the full resolution order.

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
`~/.vibectx/` (override with `VIBECTX_CACHE_DIR`). Default TTL is 7 days.
Every file in there is written through a temp file and renamed into place, so a reader
never sees a half-written one; the server and `vibectx warm` sweep any `.tmp` file a
killed process left behind before they write anything — but only once it is at least a
minute old, so a second vibectx sharing the cache never has its in-flight write deleted.

**Upgrading from `~/.docs-cache-mcp`.** The cache used to live at `~/.docs-cache-mcp` and
the override used to be called `DOCS_CACHE_DIR`. Both still work, and you do not have to do
anything:

- `VIBECTX_CACHE_DIR` wins. `DOCS_CACHE_DIR` is still read through `0.2.x`, with one
  deprecation note on stderr the first time a process uses it.
- With neither set, the first run **renames** `~/.docs-cache-mcp` to `~/.vibectx` once and
  says so on stderr. A rename, never a copy — so there is never a moment with two
  divergent caches.
- If `~/.vibectx` already exists, nothing is migrated and nothing is overwritten; the old
  directory is left exactly where it is for you to delete.
- If the rename fails (a different filesystem, permissions), vibectx keeps using
  `~/.docs-cache-mcp` for that run and says so once. Nothing is copied and no cached
  document is lost.
- **Going back down to 0.1.x after the rename starts cold.** The migration is one-way and
  0.1.x knows nothing about `~/.vibectx`: it looks for `~/.docs-cache-mcp`, does not find it,
  creates it empty and re-fetches everything. Nothing is lost — the documents are still in
  `~/.vibectx` and re-appear when you go back up — but you pay a cold cache, and you then have
  two directories. If you need a downgrade to keep its cache, set `DOCS_CACHE_DIR=~/.vibectx`
  (0.1.x reads it) or rename the directory back by hand before running the older version.
- **The `docs-cache-mcp` command still works** — the build still provides it as a second bin
  name alongside `vibectx`, so a shell alias or an `.mcp.json` that invokes the *command*
  keeps running once you have run `npm link`. (An `.mcp.json` that invokes the old npm
  *package* — `npx -y @blackraptorai/docs-cache-mcp` — no longer reaches this code at all:
  it resolves to the abandoned 0.1.1 on the registry. Point it at your clone instead.) It is deprecated and **will be removed in `0.3.0`**, on the same schedule as
  `DOCS_CACHE_DIR` and the legacy `docs-cache.config.json` filename; move to `vibectx` before
  then. (`test/version.test.ts` fails the day the version reaches `0.3.0` with any of the
  three still shipped, so this is a schedule rather than an intention.)

**Size cap.** The cache is capped at **512 MB** by default — an assumed figure, not a
measured one; `VIBECTX_CACHE_MAX_MB` changes it and `VIBECTX_CACHE_MAX_MB=0` turns it off.
When a write pushes the cache over, the least-recently-fetched library **documents** are
deleted until it is back under, and one stderr line and a `vibectx doctor` line say what
went. Recency is the document's `fetchedAt`, which a 304 revalidation refreshes, so a
document you keep using keeps its place.

Three things the cap deliberately does not do:

- It never evicts the document whose own write triggered the sweep — that would make a warm
  loop fetch and delete the same file for ever — so the cap gives way for that one document
  instead, and the stderr line says so. The protection lasts **one sweep**, not the life of
  the process: a long-running server respects its cap, and every document it has cached takes
  its turn.
- It never evicts `resolved.json`, `index.json` or a project record, though it does count
  their bytes.
- It does not sweep on every write. It accumulates and sweeps once per 16 MiB written, or
  once per **half the cap** when that is smaller, plus once at the first write of a process.
  So the cache can sit over the cap by up to that amount plus one document between sweeps —
  a bound tied to the cap you set, not to a constant sized for the default one.

**Units: the name says MB, the arithmetic is MiB.** `VIBECTX_CACHE_MAX_MB=512` is
512 × 1024 × 1024 = 536,870,912 bytes, and the `MB`/`KB`/`GB` in the stderr and `doctor`
lines are the same binary units. Fractional values work (`VIBECTX_CACHE_MAX_MB=0.5` is
512 KiB). A value that is not a number, or is negative, falls back to the 512 default rather
than switching the cap off — a typo must not be a way to lose the bound — and says so once on
stderr, so a mistyped variable does not look like a variable that worked:

```
vibectx: VIBECTX_CACHE_MAX_MB=2GB is not a size — using the default 512 MB cap. Set a non-negative number of megabytes (0 turns the cap off).
```

**When a library will not cache: `VIBECTX_DEBUG=1`.** Every fetch failure looks the same
from the outside — the library is simply not cached — because a 404, a connection timeout, a
name that does not resolve, a redirect the SSRF guard refused and a document over the byte
cap all mean "no document at this URL". Set `VIBECTX_DEBUG=1` and each one writes a line to
stderr saying which it was:

```
vibectx [debug] fetch.miss url=https://example.com/llms.txt reason=http-status status=404 ms=50
vibectx [debug] fetch.miss url=https://example.com/llms.txt reason=timeout error="The operation was aborted due to timeout" ms=0
vibectx [debug] fetch.miss url=https://nope.invalid/llms.txt reason=dns code=ENOTFOUND error="fetch failed" ms=0
vibectx [debug] fetch.refused url=https://example.com/llms.txt reason=redirect-host to=http://169.254.169.254/latest/meta-data/ status=302 ms=1
vibectx [debug] fetch.refused url=https://elsewhere.example/page.md reason=link-policy to=https://elsewhere.example/page.md status=200 ms=1
vibectx [debug] fetch.too-large url=https://example.com/llms.txt reason=content-length bytes=31457280 limit=26214400 ms=0
vibectx [debug] fetch.too-large url=https://example.com/guide.md reason=body-cap limit=2097152 ms=57
```

(A real capture, 2026-09-07, from a built `dist/` with each failure injected in place of the
network — hence the `ms` figures, which are the stub's latency, not a real host's.)

There are **three event names, one per outcome**, and `reason` names the cause within it.
Every failure path in `fetchUrl` emits exactly one line:

- `fetch.miss` — `http-status` · `html-not-text` (a site serving its 404 page with a 200) ·
  `empty-body` · `redirect-no-location` · `redirect-hops` (more than 5) ·
  `redirect-unparsable` · and, for a fetch that threw, `timeout`, `dns`,
  `connection-refused`, `connection-reset`, `tls`, `network` or `aborted`.
- `fetch.refused` — the guard said no and no body was read: `not-public` (the URL is not
  https on a public host), `redirect-host`, `final-host`, `link-policy` (a followed link left
  its source origin). `to=` names the URL that was refused, which is a URL vibectx did *not*
  fetch.
- `fetch.too-large` — `content-length` (declared over the cap, refused before the body is
  read; `bytes=` is what the server declared) or `body-cap` (the cap was hit mid-stream, so
  the true size is unknown and no `bytes=` is printed). `limit=` is the cap that applied.

`aborted` is in the vocabulary but **no code path produces it today**: the only abort signal
vibectx uses is the 20-second fetch timeout, which arrives as `timeout`. It is kept so that a
future caller-side cancellation is not silently reported as `network`.

**These lines are for a human, not for a parser.** The shape is stable enough to read and to
grep, and that is the whole guarantee: event names, fields, field order and the `reason`
vocabulary can change in any release without a version bump. The versioned, machine-readable
surfaces are `--json` on the CLI subcommands and the MCP tool payloads. Nothing else changes:
the fetch behaves identically with the variable set or unset, and stdout — which carries the
MCP protocol — is never written to.

`VIBECTX_NO_AUTOWARM=1` in the server's environment turns off the
[background revalidation on startup](#warm-your-projects-docs).
`allowedHosts` (optional) lists extra hosts followed index links may target — see
[`allowedHosts` and followed links](#any-library-no-config).
`allowInternalHosts` (optional boolean, default `false`) lets **that entry's own `urls`**
name a loopback, link-local, `.local`/`.internal` or single-label host — the air-gapped or
internal-docs case, an explicit choice the entry's author writes down, never a default.
Without it, `urls` naming such a host is rejected the same way `allowedHosts` is: one line
naming the file, the entry and the value, and that config layer is skipped rather than
silently truncated. The opt-in reaches only the entry's own primary fetch — an internal
document's own index links are still refused (`allowedHosts` above is unaffected by it),
and `https`-only / no-userinfo still apply.
`probeQueries` (optional, array of non-empty strings) are the topics `vibectx doctor`
uses to prove the entry answers; without them a query is derived from the description.
An empty array `[]` is accepted and behaves exactly as if `probeQueries` were absent.
`aliases` (optional, array of non-empty strings; `[]` = none) are other names that resolve
to the entry. `ttlHours` (optional) is the cache lifetime in hours; `0` means "always
revalidate". `libraries` itself is optional — a file without it loads as no entries.
Unknown top-level keys in the config (for example `$comment`) are ignored.

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
- **A pin also claims its PEP 503 spelling.** A config (or default) name or alias owns the
  form with runs of `-`, `_`, `.` collapsed to `-` as well, so `{"name": "typing_extensions"}`
  answers `typing-extensions` and `Typing.Extensions`, and no auto-resolved record can sit
  beside it under that spelling.

**Keep a private stack via committed config.** The default registry is what most teams
share; what only *your* team uses belongs in a `vibectx.config.json` committed to your
repo, so every teammate's agent gets byte-identical context. Config entries merge over
the defaults. [`docs/examples/paragon.vibectx.config.json`](docs/examples/paragon.vibectx.config.json)
is a complete example — the Fastify / TimescaleDB / pgvector / AWS CDK stack that shipped
as the default registry through 0.1.3:

```bash
vibectx --config ./docs/examples/paragon.vibectx.config.json doctor
```

### Team config, no flags

An MCP client launches the server with a **fixed command line**, so a config that needs
`--config` never reaches it. Commit the file instead and vibectx finds it: put

```json
{
  "libraries": [
    { "name": "acme-platform", "urls": ["https://docs.acme.example.com/llms-full.txt"] }
  ]
}
```

in `vibectx.config.json` at the root of your repo, and every teammate's agent — started
with plain `vibectx`, no flags — gets `acme-platform` in
`list_libraries`, in `get_docs`, and in the startup warm.

| # | Source | Where |
|---|--------|-------|
| 1 | `--config <path>` | the launch command |
| 2 | `VIBECTX_CONFIG=<path>` | the server's environment |
| 3 | project file | `vibectx.config.json`, from the working directory **up to the git root** |
| 4 | user file | `$XDG_CONFIG_HOME/vibectx/config.json`, default `~/.config/vibectx/config.json` |
| 5 | shipped defaults | the vibe-coder 30 above |

**An explicit source is authoritative.** Pass `--config` (or set `VIBECTX_CONFIG`) and
discovery is skipped entirely — the flag alone decides, exactly as in 0.1.x. The flag beats
the environment variable. Otherwise the user file layers over the defaults and the project
file layers over that: **project beats user beats default**, by library name, with the same
alias rules as above applied at each layer.

**The walk-up stops at your repository.** vibectx checks the working directory, then each
parent, and stops after the directory holding `.git` — a config in an unrelated parent such
as `/tmp` or your home directory is never picked up, and with no `.git` anywhere above,
only the working directory is checked. The nearest file wins; a second one further up is
*not* layered under it. A symlinked config is fine as long as it resolves to a regular file.

`list_libraries` opens with the sources it actually loaded, highest precedence first, so
there is never a question of which file an agent is answering from:

```
config: ./vibectx.config.json (project) · ~/.config/vibectx/config.json (user)
Cache dir: /Users/you/.vibectx
```

or `config: --config ./x.json`, or `config: none (shipped defaults)`.

**Legacy filename.** `docs-cache.config.json` is still read at both locations through
`0.2.x`, with a deprecation note in `list_libraries` and once on stderr — rename it to
`vibectx.config.json`. If both names sit in one directory the new name wins and the old
one is ignored (also noted).

**Failures are one line, in one grammar:** the file, then
`libraries[i].<field> ("<name>")`, then what is wrong — never a stack trace, a validator
dump, or anything from inside the file (a config path can name any file on disk, so a
syntax error reports the position and nothing else — `invalid JSON at line L column C`
when the parser supplies a position, and a bare `invalid JSON` when it does not):

```
./vibectx.config.json: libraries[2].urls ("acme-platform"): must be a non-empty array of https URLs
./vibectx.config.json: invalid JSON at line 7 column 3
~/.config/vibectx/config.json: libraries[0].allowedHosts ("acme-platform"): "10.0.0.1" is a private, loopback or non-routable host
```

`urls` must be `https:` (the fetcher refuses anything else, so a non-https entry could only
ever be dead weight); unknown keys — top-level and inside an entry — are ignored, so a file
written for a later version still loads; a file over 1 MiB is refused.

**A broken *discovered* file is skipped, not fatal.** If the committed
`vibectx.config.json` (or the user file) fails to load, vibectx keeps going with the
remaining layers: one line on stderr —

```
vibectx: ./vibectx.config.json: libraries[0].urls ("acme"): must be a non-empty array of https URLs — file skipped, continuing without it
```

— the same fact on the `list_libraries` header
(`config: ./vibectx.config.json (project) — NOT LOADED: …`), and `vibectx doctor` counts it
as unhealthy: a `✗ config …` line, a `configIssues` entry in `--json`, and exit `1`. An
**explicit** source is different: a `--config` or `VIBECTX_CONFIG` file that cannot be
loaded is still a hard failure (exit `2`), because you asked for that file by name.
One bad file in one repository should not take down a server every teammate launches;
a flag that cannot be honoured should never be silently ignored.

**Only directories you own are searched.** The walk-up stops at the first directory whose
owner is not you, and reads no config from it — the same reasoning as git's `safe.directory`.
On a shared machine, nobody else can leave a `.git` and a `vibectx.config.json` in a
directory above yours and choose where your agent's documentation comes from. If a config
*does* sit in the directory the check stopped at, it is named as ignored rather than passed
over in silence (this is what you will see if your repository is owned by another account,
or bind-mounted with a different uid — pass `--config` explicitly there).

### Upgrading from 0.1.x

Configs written for 0.1.3 keep working, with one exception:

- **Breaking:** every URL in `urls` must be `https:`. The fetcher has always refused
  anything else, so an `http:` entry could never have served a document — but it used to
  load quietly and now names itself at startup. Change the URL to `https:` (or drop the
  entry).
- `libraries` is optional: `{}` and a file with the key commented out load as "no entries",
  exactly as before.
- `ttlHours: 0` still means "always revalidate" and is still accepted. Only negative and
  non-finite values are refused.
- Nothing else about `--config` changed: pass it and discovery is skipped entirely, so an
  existing launch command behaves exactly as it did.

## Checking coverage: `vibectx doctor`

A library can look healthy — bytes cached, refresh succeeded — and still answer
nothing (an `llms.txt` that is only a link index, a README fallback that never
mentions your topic). `doctor` makes coverage a measured property: for every
library it runs the entry's `probeQueries` through the **same `get_docs` path**
your agent uses and reports what came back.

```bash
vibectx doctor                      # human table
vibectx doctor --json               # machine shape (below)
vibectx doctor --library next.js    # one library (aliases work: --library next)
vibectx doctor --offline            # cache only; never touches the network
vibectx doctor --config ./vibectx.config.json
```

```
library         kind    cache  probe                             links  mark
next.js         readme  0.0h   2 probes: 1 answered, 1 no match  0/0    ✗
react           readme  0.0h   2 probes: 1 answered, 1 no match  0/0    ✗
supabase        readme  0.0h   2 probes: 2 answered              0/0    ✓
…
resend          readme  0.0h   2 probes: 2 answered              0/0    ✓

23/30 libraries healthy
✗ next.js: no match: "app router layout"
✗ react: no match: "context provider"
✗ tailwindcss: no match: "responsive breakpoints"
✗ prisma: no match: "upsert"
✗ hono: no match: "route params"
✗ vite: no match: "env variables"
✗ anthropic-sdk: no match: "tool use"
```

(A real `vibectx doctor` run over the shipped 30, on 2026-09-06, from a sandbox where only
`raw.githubusercontent.com` was reachable — so every entry fell back to its README
candidate and the `kind` column is `readme` throughout. Rows are elided at the `…`; the
totals and the ✗ lines are that run's, in full. With the docs sites reachable you would
expect `full-text` or `index-only` in the kind column and fewer `no match` probes: a
README is a much thinner document than an `llms-full.txt`, which is the honest limit
`doctor` exists to show you.)

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
followed, dropped, healthy, reasons }], healthy, total, configIssues: [{ path, scope,
reason }] }` — keys in that order, `null` for a missing URL or age. `configIssues` (added
in 0.2.0) lists discovered config files that were skipped; while it is non-empty the exit
code is `1` however healthy the libraries look, because the entries those files pin are
simply missing. New keys may be appended in later versions; consumers should
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
- **Cross-library search:** `search(query)` runs one BM25 query over every cached
  document and groups the hits by library, for the common case where the agent does not
  know which library owns a concept. Cache-only and offline; backed by a derived,
  self-maintaining index that stores no document text. MEASURED: a warm search is 44 ms over
  a 5.63 MB / 12-document corpus and 820–893 ms over 146 MB in 30 documents — see
  [Don't know which library? `search`](#dont-know-which-library-search).
- **Deterministic retrieval:** markdown heading-split + BM25 scoring over a camelCase-aware,
  lightly stemmed tokenizer — see [How ranking works](#how-ranking-works). No embeddings,
  no external calls at query time, same answer every run.

## Using this in a company / behind an air gap?

This tool is free and MIT-licensed, and will stay that way. If you have a **private
documentation, air-gapped, or enterprise deployment need it doesn't cover — 
[open an issue](https://github.com/BlackRaptorAI/VibeCTX/issues)** and describe
your setup. Real-world reports directly shape what gets built.

## Development

```bash
npm ci
npm test        # vitest (needs Node ≥ 20.19)
npm run build   # tsc → dist/
```

## License

MIT © 2026 Tom Hanks / BlackRaptor AI
