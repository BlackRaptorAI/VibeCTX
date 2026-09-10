> ## SUPERSEDED FACTS — reconciled 2026-09-10 (PAR-754 list 1). The analysis stands; some numbers do not.
>
> **This is a DATED RECORD, written against `main` @ `a0852f2`. Its body has NOT been rewritten** —
> doing so would falsify it as a record of what was known on 2026-09-08. Read its findings as of that
> date, and take current facts from the sources below.
>
> | This document says | Current, MEASURED 2026-09-10 |
> |---|---|
> | `main` @ `a0852f2`, 1059 tests in 32 files | **`839bfd7`, 1202 tests in 36 files**, CI green on Node 22 |
> | `npm audit` clean | **2 moderate** (`vitest` via `@vitest/mocker`, dev-only); **`--omit=dev` → 0** |
> | (where stated) 13 outstanding Change Records | **11 unsigned**, 3 signed, 14 files |
>
> **Authority for current facts:** `CLAUDE.md` (SHA, test count) and Linear — epic PAR-515, the 0.2.0
> milestone, the issues. **Not this file.**
>
> **Any citation of `change-record-policy.md`, `branch-protection-checklist.md` or
> `gate-enforcement-map.md` in this document is a citation of a RETIRED file.** All three were retired
> 2026-09-08 and carry "HISTORICAL REFERENCE ONLY" banners; the change-record policy adds "DO NOT CITE
> THIS FILE AS AUTHORITY." **No path is gated and no CI check requires a Change Record (D-52).** The
> live rule: a Change Record is expected for a tagged release, and for any item touching URL trust,
> fetching, or cache integrity.

# VibeCTX — code and capability audit

**Date:** 2026-09-08 · **Scope:** `main` @ `a0852f2` (fresh clone from GitHub), 9,105 lines of TypeScript across 29 files in `src/`, 13,175 lines across 32 test files, plus `.vibectx-plan/PRODUCT-STRATEGY.md` and the README.
**Method:** full read of `src/` and `test/`; independent web research on the competitive set; five findings re-verified line by line by me directly.

---

## 1. What it is for

The stated purpose, from `.vibectx-plan/PRODUCT-STRATEGY.md` (decided 2026-07-20):

> **VibeCTX: batteries-included docs for your AI coding agent — feature-rich like the heavy tools, instant like the hosted ones, fully local.**

Concretely: a local Model Context Protocol (MCP) server that fetches official library documentation — preferring each project's published `llms.txt` / `llms-full.txt` — caches it to disk with a time-to-live (TTL), and serves the sections best matching the agent's question. No network at query time, no cloud account, no embeddings, identical output every run.

The four design principles are zero-config, deterministic-by-default, offline-first, honest defaults. **The code honours all four.** That is worth saying plainly, because it is the part most projects get wrong: the retrieval path really is model-free and network-free, staleness really is flagged rather than hidden, and there really is no telemetry.

**The purpose has drifted in one respect the strategy doc has not caught up with.** Principle #1 is literally `npx vibectx` must just work — and npm distribution was abandoned on 2026-09-07 in favour of clone-and-build. That is the right call on the merits (an `npx` git-spec install must reach the network on every launch, which is self-defeating for a tool whose premise is offline determinism), but it inverts the product's own beachhead thesis. `PRODUCT-STRATEGY.md:55`, `:100-103`, `:107` and `LAUNCH-STRATEGY.md:79-86,100` all still assert the opposite. This is already logged as open item #1 in the build-loop resume card; I am confirming it is real and that it is now the largest single strategic inconsistency in the repo.

---

## 2. Verdict

**Code quality: high — materially above the median for an open-source project of this size, and better than most production code I read.** Zero `any` in `src/`. `strict: true`. A 1.45:1 test-to-source ratio with genuinely behavioural tests. Server-side request forgery (SSRF) handling that is both correct and correctly tested against a real listener. A hand-written, regex-free tokenizer. Comments that record what was tried, what it measured, and why it was wrong, with `MEASURED` / `ASSUMED` / `CITED` provenance labels on numbers.

**The gate process is visibly working.** The list of defects the gates caught — eviction deleting a real user file through a symlinked cache root, `maxTokens` never enforced in `search` at 9.9×–322× over budget, a search index that ignored the tokenizer that built it — is a record of a review process finding things the producer's own green test suite did not. That is the expensive, rare thing, and it is present.

**Capability: narrower than the strategy document implies, and the gap is concentrated in one place.** Seven MCP tools ship; the 0.3.0 differentiators (version-specific docs, private/internal URL sources, local `file://` sources) do not exist in the code — `grep -rn "file://" src/` returns nothing, and no module reads a dependency version.

**One security finding I would fix before anything else** (§4.1). Everything else is engineering debt, not exposure.

---

## 3. Architecture, broadly

The real dependency graph:

```
index.ts ──► cli.ts, server.ts, autowarm, config, registry
server.ts ─► get-docs, search, refresh, list-libraries, doctor, resolve, warm, …

TOOLS      get-docs   search   warm   doctor   refresh   list-libraries   resolve
              │         │        │      │        │            │             │
RETRIEVAL  retrieval ◄──┴────────┴──────┘        │            │        source-kind
              │                                   │            │             │
FETCH      fetcher ◄───────────────────────────────┴────────────┴─────────────┘
              │
STORE      cache ─► cache-evict, atomic-store, resolved-store, project-store, search-index
LEAF       tokenize  link-policy  package-names  limits  version  debug
```

**The layering is right.** Transport → tools → retrieval → fetch → store, with genuine leaf modules at the bottom. There are no runtime cycles: `registry ↔ config` and `registry ↔ resolved-store` are deliberately broken with `import type`. The command-line interface (CLI) and MCP paths share tool bodies rather than duplicating them (`doctorToolText` and `runDoctorCli` both call `runDoctor`), which is the correct shape.

Three boundary violations are real and cheap to fix:

- **`doctor.ts` is being used as a utility module.** `mapLimit`, a generic bounded-concurrency helper, lives at `doctor.ts:210` and is imported by `warm.ts` and `autowarm.ts`; `list-libraries.ts:5` imports `classifySourceKind` from `doctor.js` when `source-kind.ts` exports it directly. Consequence: `list_libraries` — a pure cache-read tool documented as never touching the network — transitively loads `get-docs`, `fetcher`, `resolve` and `cache-evict`.
- **The ranker depends on the config loader.** `retrieval.ts:1` imports `clipText` from `config.ts`, which imports `cleanText` from `project-deps.ts`. So the BM25 (Best Matching 25) engine pulls in the TOML and requirements.txt parsers at runtime. Extract a `text.ts` leaf.
- **`registry.ts` is 810 lines of two different things** — lines 91–422 are a static 30-entry data table, 431–810 are merging, alias validation and lookup. Split `default-registry.ts` from `registry.ts`.

**One design detail is fragile in a way worth flagging.** `warm.ts:171` decides "is this a shipped default" by *reference identity* on an array: `DEFAULT_REGISTRY.some((d) => d.urls === entry.urls)`. It works today only because `applyLayer` spreads entries while preserving the `urls` reference. Any future `structuredClone` or JSON round-trip silently disables the ecosystem notes with no test failure. Add an explicit `ecosystem?: "npm" | "pypi"` field — already queued at `warm.ts:45`.

**One undocumented invariant is load-bearing.** `saveResolvedEntry`, `writeIndex` and `IndexSession.flush` are safe under `warm`'s four-way concurrency only because they are fully synchronous read-modify-write sequences with no `await` inside them. Node's single thread makes them atomic. Adding one `await` inside any of the three introduces a silent lost-update race. That should be a comment at each site, at minimum.

---

## 4. Code findings

Severity is mine. **Findings 1–3 I verified myself, line by line, in the clone.** The rest come from a full read of `src/` and are traced to specific lines.

### 4.1 HIGH — config `urls` are checked for `https:` and nothing else (SSRF)

`config.ts:326-333` validates a library entry's `urls` with `isHttpsUrl`, which is exactly `new URL(v).protocol === "https:"`. Meanwhile `allowedHosts` goes through `normaliseAllowedHost`, which rejects everything `isForbiddenHost` names (`link-policy.ts:34-44`: loopback, IPv4 literals, IPv6, `.local`, `.internal`, single-label hosts). **The primary fetch URL gets none of that.**

The exploit uses the product's own documented team workflow — commit `vibectx.config.json` to the repo so every teammate's agent gets the same context:

```json
{ "libraries": [{ "name": "internal-docs",
                  "urls": ["https://169.254.169.254/latest/meta-data/iam/security-credentials/"] }] }
```

Clone the repo, start the agent in it. `config.ts:156-176` walks up to the git root; the directory is owned by the cloner so the uid check passes; `startAutowarm` (`server.ts:195`) fetches it at startup **with no user action**, and the body lands in `list_libraries`, `get_docs` and `search` output. `localhost:8443` and `metadata.internal` work identically.

**Fix:** one added condition at `config.ts:326` — also reject `isForbiddenHost(new URL(v).hostname)`. If internal hosts are wanted for the air-gapped use case the README markets, gate them behind an explicit per-entry `allowInternalHosts: true` so the default is safe. There is no test for a private host in a config `urls` entry; the equivalent test for `allowedHosts` exists at `test/registry.test.ts:517`.

*Caveat: I verified the code path and the absence of the check. I did not execute the exploit — no live agent environment and no metadata endpoint to reach. The reasoning is from the source as written.*

### 4.2 HIGH — `get_docs.maxTokens` is unvalidated where `search`'s is not

`server.ts:52-55` declares `maxTokens: z.number().optional()`. `server.ts:84-88` declares `search`'s as `z.number().int().positive().optional()`. The asymmetry is almost certainly an oversight: `get_docs({library: "prisma", maxTokens: 1000000000})` makes `budget * 4 = 4e9`, so `doc.content.slice(0, 4e9)` at `get-docs.ts:148` returns the entire multi-megabyte document into the model's context. This is the same class as the `search` budget defect the gates already caught at 9.9×–322×, left open on the other tool. **Fix:** `z.number().int().positive().max(200_000)`.

### 4.3 HIGH — `refresh` does roughly a gigabyte of JSON work per invocation

`refresh.ts:29` calls `invalidateIndex(name)` and `:55` calls `indexCachedDocument(...)` **per library, inside the loop**. Each is a full read (and often write) of `index.json` — measured at 16.9 MB on a 30-document corpus. Refreshing all 30 entries is ~90 parses and ~60 serialisations of that file.

`warm.ts:308` and `autowarm.ts:103` both open **one** `IndexSession` for the whole run — that is precisely the fix documented at `search-index.ts:496-507`, which quantifies the problem it solved as "7,529 ms added to an already-fresh 30-library warm". **`refresh` never received it.** Open one `openIndexSession` at `refresh.ts:22` and `flush()` once.

`refresh` with no argument is also model-callable (`server.ts:110`) and has **no rate limit at all**, in contrast to the resolver's `MAX_RESOLUTIONS_PER_HOUR = 100`. A model in a retry loop is unbounded network egress against thirty upstream documentation sites.

### 4.4 MEDIUM — `resolvePackage`'s "never throws" contract is false

`resolve.ts:336` documents "Never throws for bad input or bad network." `resolve.ts:434` calls `saveResolvedEntry` unguarded, and `resolved-store.ts:114,127` (`mkdirSync`, `writeAtomic`) throw on EACCES/ENOSPC/EROFS. A read-only `$HOME` or a full disk turns `get_docs("some-unknown-package")` into an exception through `get-docs.ts:91`. The outcome type already has `saved: false` and `saveNote` fields — wrap the call and use them.

### 4.5 MEDIUM — `meta.json` is the one store with no validation

`cache.ts:203,223`: `JSON.parse(readFileSync(metaPath, "utf8")) as CacheMeta`. No try/catch, no shape check. Every other persisted store in this codebase re-validates every field precisely because the cache directory is a trust boundary — `resolved-store.ts:14`, `project-store.ts:18`, `search-index.ts:49`. A corrupt `.meta.json` takes down the whole `list_libraries` tool (`list-libraries.ts:37`, unguarded and untested) and `refresh.ts:51`.

Worse: `meta.fetchedAt` is rendered **unvalidated** at `list-libraries.ts:43` and in the `STALE:` note of every `get_docs` response. `project-store.ts:194` validates `warmedAt` against a strict ISO-8601 regex explicitly because "that string lands verbatim in the list_libraries footer" — the cache meta lands in the same footer with none of that treatment. Add a `toCacheMeta()` validator mirroring `toWarmRow`.

### 4.6 MEDIUM — the `get_docs` budget ignores its own separators

`search.ts:308-331` prices `BLOCK_JOIN` and `SECTION_JOIN` exactly, with a comment reading "a budget that ignores its own separators is not a budget". `get_docs` is the module that ignores them: `retrieval.ts:306-328` sums only `chunk.length` while `assemble` joins with a 9-character separator, and `get-docs.ts:272` prepends the `Source:` line and the followed-link note block **entirely outside the budget**. `test/retrieval.test.ts:768` encodes the overshoot as expected behaviour for snippets. This is the same defect the gates caught in `search`, unfixed in its sibling.

### 4.7 MEDIUM — three different control-character strippers

| Function | Strips |
|---|---|
| `project-deps.ts:119` `cleanText` | C0, C1, ZWSP–RLM, LRE–RLO, LRI–PDI, BOM |
| `debug.ts:46` `debugField` | as above **+ U+2028/2029**, **− BOM** |
| `resolved-store.ts:33-35` `cleanDescription` | C0 + U+007F only — **no C1 (U+0080–U+009F)** |

`cleanDescription`'s output lands in `entry.description` and is rendered by `get-docs.ts:107` and `resolve.ts:312` **without** a second pass. So a U+009B (CSI) in an npm package description reaches the `get_docs` provenance line and the `vibectx resolve` terminal output. Consolidate onto one exported character class.

### 4.8 Performance, beyond `refresh`

The README already publishes the scale table honestly (5.63 MB / 12 docs → 44 ms; 146 MB / 30 docs → 820–893 ms) and names the causes. Confirming in code: `search.ts:442` hashes the **full document** for every candidate library on every query — 30 × 5 MB of SHA-256 per search — and `search.ts:565` re-reads and re-splits the cached document for each rendered group. A `(mtime, size)` fast-path before hashing eliminates most of that. Smaller: `get-docs.ts:175,179` runs `extractLinks` twice over a multi-megabyte document; `get-docs.ts:243` builds a Set keyed on full section bodies (a second copy of the document); `retrieval.ts:311,324` renders every chosen section twice.

### 4.9 What is genuinely good

Stated as findings, because a balanced audit owes them:

1. **SSRF handling in `fetcher.ts` is correct and correctly tested.** `redirect: "manual"`, every `Location` checked before it is requested, a final-URL re-check, one shared `isAllowedLink` so no caller can apply a weaker rule — and `test/fetcher.test.ts:425-562` proves it against a **real `http.Server` on 127.0.0.1**, asserting `listenerHits === []`. Proving a request was *not* made is the only assertion that actually tests an SSRF guard, and it is here.
2. **The regular-expression denial-of-service (ReDoS) discipline is real, not aspirational.** A tokenizer with zero regexes (hand-written charCode scanners), hand-written TOML/YAML/requirements parsers, a link regex whose character classes are chosen specifically to prevent re-scanning, and tests firing 200 KB of pathological input at each.
3. **The retrieval version (`tokenize.ts:31`) is a genuinely good idea.** Recognising that a content hash proves the *document* unchanged and therefore cannot catch a *tokenizer* change — and that the failure mode is a silently empty answer rather than a visible error — is insight most projects buy only after shipping the bug.
4. **Fixtures assert their own preconditions.** `test/search.test.ts:906-923` plants an index just under the cap and asserts *that the fixture is under the cap and would exceed it once the new entry joins*, with the comment "a fixture failing either would prove nothing". That is the direct antidote to the tautological test the gates caught earlier. I looked for another tautological test and did not find one.
5. **Numbers carry provenance.** `cache-evict.ts:76-88` says of its own constant: "WHERE THIS NUMBER COMES FROM — nowhere. 16 MiB is a chosen constant… That is the number to argue with." Very few codebases admit that.
6. **Trust boundaries are named and enforced per field**, and `link-policy.ts:186-207` re-derives `allowedHosts` on load so a persisted record cannot widen its own permissions. That is sophisticated.

### 4.10 Test gaps

- **No stdio integration test.** `test/server.test.ts` uses `InMemoryTransport` with a real `McpServer` — good — but `index.ts` is never executed. Untested: the top-level `await`, `dispatchCli` → `process.exitCode`, the `stdin.once("end")` shutdown, `CLOSE_GRACE_MS`, and the `process.exit(2)` config-error path. A `spawn(node, ["dist/index.js"])` test writing one `tools/list` frame would cover the one file with zero coverage — and it is the file every user's MCP client actually launches.
- **~15 wall-clock assertions.** `test/retrieval.test.ts:366` asserts a *ratio* between two timed runs (`largeMs/smallMs < 6`) — the most flake-prone shape in the suite, and the same class as the 24-hour test CI already caught once.
- No corrupt-`meta.json` case for `list-libraries` or `refresh` (§4.5). No private-host config case (§4.1).

---

## 5. Feature comparison

### 5.1 A correction that matters

**Context7's tool surface has changed, and the repo's strategy documents are written against the old one.** As of the current `@upstash/context7-mcp` v4.x, `get-library-docs`, the `tokens` parameter and the `topic` parameter **no longer exist**. The surface is now two tools:

- `resolve-library-id(query, libraryName)` — both required strings
- `query-docs(libraryId, query)` — both required strings

Filtering and token budgeting moved server-side behind a reranker. Upstash's own blog post (2026-01-07) claims the change cut token usage 9.7k → 3.3k, latency 24s → 15s, and tool calls 3.95 → 2.96 across "80+ coding questions" — **their numbers, self-reported, not independently verified.**

*Provenance: this section comes from a research pass that read the Context7 MCP source directly at `raw.githubusercontent.com/upstash/context7/master/packages/mcp/src/`. I did not personally re-fetch those files. Treat the tool schemas as high-confidence (read from source) and every count or percentage as vendor-stated.*

### 5.2 Where VibeCTX sits

| Capability | VibeCTX | Context7 | docs-mcp-server | Ref | GitMCP |
|---|---|---|---|---|---|
| Works fully offline | **✅ only one** | ❌ (local binary still calls `context7.com/api`) | ✅ (Ollama or FTS-only) | ❌ | ❌ |
| Deterministic / reproducible | **✅ only one** | ❌ (server reranker + rolling index) | ✅ | ❌ (session-stateful *by design*) | ⚠️ |
| **Reads your manifests and pre-warms deps** | **✅ only one, anywhere** | ❌ | ❌ | ❌ | ❌ |
| Multi-library search in one call | ✅ | ❌ (one `libraryId`) | ❌ (`library` required) | ✅ | ❌ |
| Code-snippet mode | ✅ (`mode: "snippets"`) | ✅ (`codeSnippets`/`infoSnippets`) | ⚠️ chunks | ⚠️ page slices | ❌ |
| **Version pinning** | ❌ | ⚠️ `/org/project/version`, LLM-matched | ✅ **exact + semver X-ranges** | ❌ | ❌ |
| **Private / internal docs** | ❌ | ✅ Pro+ ($5/1M tokens) | ✅ free, local | ✅ | ❌ |
| **Local `file://` sources** | ❌ | ❌ | ✅ | ⚠️ upload | ❌ |
| Semantic / vector ranking | ❌ by design | ✅ | ✅ optional hybrid | ✅ | ❌ |
| Library coverage | 30 curated + any npm/PyPI resolved | 122K (self-stated) | 0 — you build it | ? | any public repo |
| Quality/trust score per library | ❌ | ✅ Source Reputation + Benchmark Score | ❌ | ❌ | ❌ |
| Prompt-injection screening of ingested docs | ❌ | ✅ (two-pass, per their blog) | ❌ | ❌ | ❌ |
| Cost | free, MIT | free 1,000 calls/mo | free | free 200 lifetime credits | free |
| Install friction | **high** (clone + build + absolute path) | very low (`npx ctx7 setup`, one-click badges) | highest | low | **lowest** (paste a URL) |

### 5.3 The three findings that matter

**(a) Dependency auto-discovery is unique to VibeCTX, and it is under-exploited.** Nothing else in the category reads `package.json` / `requirements.txt` / `pyproject.toml` and pre-warms the right docs. This is the one capability a *local* tool is structurally positioned to own — it has the repo and the lockfile; a remote index does not. `warm_project` is the differentiator, and the README buries it under `get_docs` and `search`.

**(b) The strategy document names the wrong rival.** It positions against Context7 ("docs-mcp-server *vacated* the easy-install lane"). That premise has weakened: `arabold/docs-mcp-server` now bills itself as "the open-source alternative to Context7, Nia, and Ref.Tools", runs fully offline with Ollama or with full-text search and no embeddings at all, ships a web UI, a Docker image, Agent Skills, and a documented search-quality benchmark — and it already probes `llms.txt` before crawling. **It occupies the local/private/version-pinned/hybrid-search quadrant VibeCTX is walking toward.** Its remaining weakness is real (you must scrape each library before it is useful, and Node 22 + Docker is still a tax) but it is not the vacated lane the doc describes.

**(c) Install friction is now VibeCTX's worst competitive attribute, and it moved the wrong way.** Clone → `npm ci` → `npm run build` → absolute path into the MCP config → optionally `npm link` with a prefix fix — against `npx ctx7 setup` or pasting a `gitmcp.io/owner/repo` URL. The offline-determinism argument for abandoning npm is technically sound, but the beachhead segment ("solo vibe coders / free-tier refugees") is precisely the segment that will not do a four-step build.

### 5.4 Feature gaps, ranked by strategic cost

1. **Version pinning.** `resolve.ts:27` fetches npm `/latest`; GitHub READMEs come from `HEAD`. So an agent working in a repo pinned to React 18 gets React 19's docs, silently. This is worse for VibeCTX than for the hosted tools, because VibeCTX *already read the manifest and knows the pinned version*. It is listed as 0.3.0 in the strategy doc; I would move it to the top of 0.3.0 and treat it as the natural completion of `warm`, not a separate feature. `docs-mcp-server` supports semver X-ranges (`5.2.x`) today.
2. **Local `file://` sources and convention docs.** `grep -rn "file://" src/` returns nothing. This was 0.2.1-deferred. It is the "serve your own ADRs, standards and glossary so the agent writes code your way" story — pure differentiation, zero infrastructure, and the thing that makes a committed config worth committing.
3. **Private / internal URL sources with token auth.** Explicitly named in the strategy as "Context7-can't-do-this differentiation". Note the interaction with §4.1: the *safe* version of this feature is exactly the explicit `allowInternalHosts` opt-in that closes the SSRF hole. Fixing the vulnerability and shipping the feature are the same work.
4. **No provenance marker on repeat calls.** `get-docs.ts:104-113` emits "not a curated entry; verify this is the package you meant" **only on the call that performed the resolution**. Every subsequent `get_docs` for that name returns the same third-party document with no marker. Since documents fetched from the internet go straight into a model's context, and no competitor-style injection screening exists, the standing marker is cheap insurance. I agree with the decision *not* to sanitise section bodies — laundering characters inside a code sample corrupts the answer, and plain-English instructions survive any character filter — but the framing should be permanent, not one-shot.
5. **No per-library quality signal.** Context7 exposes Source Reputation and a Benchmark Score. VibeCTX has `doctor`, which is arguably better (it *proves retrieval works* rather than scoring a repo's stars) — but `doctor`'s classification is not surfaced in `list_libraries` or in `get_docs` responses, so the model never sees it.

---

## 6. What I would change

**Fix now — one afternoon, high value:**

1. **`config.ts:326` — add the `isForbiddenHost` check** to `urls`, with an explicit `allowInternalHosts` opt-in for the intentional case. Add the missing test. *(§4.1)*
2. **`server.ts:52-55` — `z.number().int().positive().max(200_000)`** on `get_docs.maxTokens`. One line. *(§4.2)*
3. **`refresh.ts:22` — open one `IndexSession`**, flush once. And put a rate limit on the no-argument `refresh`, which is model-callable and currently unbounded. *(§4.3)*
4. **`cache.ts` — add `toCacheMeta()`**, mirroring `toWarmRow`; return `undefined` on a bad meta. *(§4.5)*
5. **Wrap `saveResolvedEntry` at `resolve.ts:434`** — the `saved`/`saveNote` fields already exist. *(§4.4)*

**Fix next — a day each:**

6. Price the separators and the header block in the `get_docs` budget, matching what `search` already does. *(§4.6)*
7. Consolidate the three control-character strippers onto one exported class. *(§4.7)*
8. Add the stdio integration test — `spawn(node, ["dist/index.js"])`, one `tools/list` frame. `index.ts` is the file every user launches and the only one with zero coverage. *(§4.10)*
9. Extract `text.ts` and `concurrency.ts` leaves; point `list-libraries.ts` at `source-kind.js`; split `default-registry.ts` out of `registry.ts`. *(§3)*
10. Replace the `urls` reference-identity check in `warm.ts:171` with the queued `ecosystem` field. *(§3)*

**Change the plan, not the code:**

11. **Reconcile `PRODUCT-STRATEGY.md` and `LAUNCH-STRATEGY.md` with source distribution.** They currently assert the opposite of what ships. This is your call, not an agent's — but leaving two adopted strategy documents contradicting the product is a worse state than either resolution.
12. **Promote version pinning ahead of semantic search in 0.3.0.** Semantic search is a capability every competitor has and that costs you your determinism principle. Version-pinned docs derived from the manifest you already read is a capability *no competitor has*, and it makes `warm` the reason to use VibeCTX rather than a convenience on top of it. If I could change one thing about the roadmap, it is this.
13. **Solve install friction, or accept that the beachhead segment is gone.** The offline argument against `npx` is correct. But something has to replace it: a prebuilt `dist/` on a release tag, a Homebrew formula, a single-file bundle, or a one-line installer script that does the clone-and-build. Four manual steps plus an absolute path is not "the easiest to install and configure" — which is the stated moat.
14. **Lead the README with `warm_project`.** It is the one thing nothing else in the category does. It is currently the fifth thing a reader meets.

---

## 7. Uncertainty

*Amended 2026-09-08, later the same day: items marked below were re-verified or executed after the
first issue of this audit. The amendments are recorded in `claude/vibectx-build-loop-resume.md`.*

- Findings §4.1–§4.10 were traced to specific lines during the audit. **All of them have since
  been re-verified directly against the source at `a0852f2`** — twice: once before the 2026-09-08
  history rewrite (then `79c270c`) and again line by line after it, at the SHA named here — see the verification table in the
  current-state card.
- **§4.1's exploit path is reasoned from source, not executed.** The missing check and the
  autowarm call chain were confirmed; no metadata endpoint was stood up. This caveat stands.
- ~~The zod-accepts-`Infinity` half of §4.2 was read, not executed.~~ **AMENDED — executed
  2026-09-08 against the shipped schemas with the repo's own `zod` 3.25.76.** `get_docs.maxTokens`
  accepts `Infinity` (from `JSON.parse('1e400')`), `1000000000`, `-5`, `0` and `3.7`; `search`
  rejects all but `1000000000`. **New finding from that run: `search.maxTokens` is `.int().positive()`
  with no upper bound, so it is unbounded too.** §4.2 as written understates the defect — it is
  both tools, not one.
- Two time-of-check-to-time-of-use (TOCTOU) windows exist at `cache-evict.ts:362` and
  `cache.ts:132-147`. Both need write access to `$HOME`. They remain **suspected, not confirmed** —
  the window is visible in the code but no race was constructed. A test that swaps the path between
  the `lstat` and the following call would settle each.
- ~~The test suite was not re-run in this pass; the 1,059 figure is carried from the build-loop
  resume card.~~ **AMENDED — MEASURED 2026-09-08** on a fresh clone of `main` @ `a0852f2`:
  `npm ci` clean, `npm run lint` clean, `npx vitest run` **1059/1059 passing in 32 files**, 72.5 s.
