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
>
> **ONE ERROR THAT WAS WRONG WHEN WRITTEN, not merely stale.** Line 96 reads
> *"**A1–A11 and A16–A20** (15 items)"*. **A1–A11 is 11 items and A16–A20 is 5 — the range says 16
> and the number says 15, in the same table cell.** The epic (PAR-515) and the 0.2.0 milestone both
> copied the **15**, and it survived until 2026-09-10. **This is where that error entered the record.**
> The count is **16**, enumerated by PAR number. Corrected at the source in the epic and the milestone;
> the line is left standing here because this is a record.


# VibeCTX — plan revision, 2026-09-08 (audit remediation) · rev 2

**Rev 2 supersedes rev 1 of the same date.** Rev 1's central decision rested on a premise that
was false within the hour: it said "seven pull requests are stacked and unmerged, and `main`
carries the SSRF defect until they land," and accepted an exposure window on that basis. **There
are no stacked pull requests and no build branches.** Every issue the build loop produced is in
`main` at `a0852f2`. Rev 2 corrects the premise, the release train, and item A2 — which an
executed test proved understated.

Follows `VibeCTX-audit-2026-09-08.md`. State of the world: `vibectx-build-loop-resume.md`.

> **CORRECTION, 2026-09-08 (after the repository scrub).** Two classes of statement in this
> document are superseded and are annotated where they appear.
> **(a) The baseline.** `79c270c` no longer exists; history was rewritten and force-pushed. The
> baseline is **`a0852f2`**, and every A1–A10 file:line citation was re-verified against it.
> **(b) Governance.** The CI change-record gate, the `GATED` path array, the gate-enforcement map
> and the verdict-format checker were **removed from the repository**. **No path is "gated" in any
> machine-checkable sense any more, and no CI check requires a Change Record.** Change Records are
> still written — one per tagged release, one per item touching URL trust, fetching or cache
> integrity — but they live in `.vibectx-plan/change-records/` and only the build session's
> discipline enforces them. Read every "gated path" and "CR required" below as *a routing
> instruction to the build session*, never as a control that will stop a merge.
> **(c) Verdicts are still machine-checked.** Core 2.1.0 ships a `Stop` hook that validates every
> gate verdict block in-session — stricter than the deleted CI check, since it runs on every
> dispatch rather than every pull request. The verdict **schema changed in 2.0.0**: integer
> `confidence` 0–10, required `standards`, string `evidence`, no `N/A`. Records D-52 and D-53.

> **RELEASE DECISION, 2026-09-08.** All of this work ships as **0.2.0**. `package.json` goes
> 0.1.3 → 0.2.0 in the release pull request. **No interim tag** — `v0.1.3` is skipped, and
> `v0.2.0` is cut only after the whole set is complete and fully tested, as the GA release. The
> version number is free: what an earlier plan called "0.2.0 — zero-config core" landed in `main`
> but was never released, so `package.json` still reads 0.1.3 and no tag exists.
>
> **A1's approach is settled:** the host check goes into `src/link-policy.ts` as an exported
> `validateLibraryUrl`, which `config.ts` calls. That file is already gated, so A1 carries a Change
> Record. **`src/config.ts` does NOT join the GATED array** — this resolves A14 by moving the trust
> decision rather than widening the gate.
>
> **SCOPE DECISION, 2026-09-08 — read this first.** Tom decided VibeCTX stays a **documentation
> cache**. See `claude/VibeCTX-scope-decision-2026-09-08.md`. Consequences inside this document:
> **A12 is out of scope** (and PAR-660 / PAR-661 should be closed as such), **A11 is no longer
> blocked on PAR-653**, and **five items A16–A20 are added** in section C2. A1–A10, A13, A14 and
> A15 are unaffected.

**Provisional IDs `A1`–`A15` are handles for this document only.** Linear numbers get assigned at
filing. No issues have been created.

---

## What changed in the facts

**One live security finding.** `config.ts:326-333` validates a library entry's `urls` with
`isHttpsUrl`, which is exactly `new URL(v).protocol === "https:"`. `allowedHosts` goes through
`normaliseAllowedHost`, which rejects everything `isForbiddenHost` names (`link-policy.ts:34-44`:
loopback, IPv4 and IPv6 literals, `.local`, `.internal`, single-label hosts). The primary fetch
URL gets none of that. A committed `vibectx.config.json` — the product's own documented team
workflow — naming `169.254.169.254` or `localhost:8443` is fetched by `startAutowarm`
(`server.ts:195`) at server start **with no user action**, and the body reaches `list_libraries`,
`get_docs` and `search` output.

**The gated surface set was provably incomplete.** *(Historical: the CI gate described here was removed on 2026-09-08. The reasoning is kept because it is why A1 puts the check in `link-policy.ts`.)* `.vibectx-plan/change-record-policy.md` gates
`src/fetcher.ts` and `src/link-policy.ts` on the argument that they carry the network trust
boundary. The finding above is a network-trust-boundary defect in `src/config.ts`, which is not
gated. The file deciding *which* hosts may be fetched is gated; the file supplying the URL that
bypasses that decision is not.

**The strategy documents describe a competitive landscape that has moved.**
`arabold/docs-mcp-server` now runs fully offline (Ollama, or full-text search with no embeddings
at all), pins versions with semantic-versioning X-ranges, probes `llms.txt` before crawling, and
bills itself as "the open-source alternative to Context7, Nia, and Ref.Tools" — so it has not
vacated the easy-install lane the way `PRODUCT-STRATEGY.md:24-26` records. Separately, Context7's
Model Context Protocol (MCP) tool surface changed in early 2026 (`get-library-docs`, `tokens` and
`topic` no longer exist), so every Context7 comparison in the strategy docs is written against a
surface that is gone.

---

## Sequencing — corrected

**The decision stands: audit remediation is the 0.2.x milestone.** What changes is that nothing
is in its way.

Rev 1 accepted an SSRF exposure window "for as long as the stacked train takes to merge." **That
window does not exist.** `main` is clean, pushed, and 1059 tests green. A1 branches from `main`
today and merges to `main` when its gates pass. No stack, no waiting, no cherry-pick contingency.

The only sequencing constraint left is the one that was always real: **A11–A13 wait on PAR-653**,
because two of the three change what `warm` means and their fallback design depends on the real
`llms.txt` coverage rate, which only a Mac-side probe can measure.

## Release train — 0.2.0

| Milestone | Contents | State |
|---|---|---|
| Already in `main` @ `a0852f2` | PAR-706, 707, 654, 655, 656, 657, 658, 659, 652 | Landed, unreleased. `package.json` still 0.1.3; the only tag is `v0.1.1`, off `main` |
| **0.2.0 — this release** | **A1–A11 and A16–A20** (15 items), A14 folded into A1, the version bump, and the release Change Record | **The work** |
| 0.3.0 | **A13** — private and internal URL sources. Optional semantic search behind it | Deferred |
| Declined | **A12** — local `file://` sources. Close PAR-660 / PAR-661 as out of scope | Out |
| Not a build item | **A15** — strategy-document reconciliation | Tom's call |

**Order.** A1 → A2 → A3 → A4 → A5 (severity), then A6 → A7 → A8 → A9 → A10, then A11 with A16,
then A17 (must follow A6), A18, A19, A20. A20 is independent of A16–A19 and can move earlier.

**A11 is in this release.** The scope decision names version-matched documentation as one of the
five problems VibeCTX exists to solve, so it moves out of 0.3.0. It is **no longer blocked on
PAR-653** — build the core behaviour, refine the fallback when the probe numbers land.

**The release itself is work.** The local change-record policy (`.vibectx-plan/change-record-policy.md`) rule 1 requires one Change Record per
tagged release, covering the version bump, dependency and lockfile state, and what a user checking
out the tag will build and run. Under source distribution the tag **is** the release artifact.
The `package.json` bump rides in the release pull request alongside that Change Record. It is no longer a *gated* path — nothing in CI checks it — so this is a discipline, enforced by Phase 7's gate.

**GA gate.** `v0.2.0` is cut only when every item is landed with green gates, the full suite passes,
`npm audit` is clean, and PAR-653 and PAR-704 have been run from the Mac — the two human-only
verifications that four issues' claims still rest on.

**Two preconditions before any of it starts.** The agent pack must be reinstalled (every gate and
producer role below names one of its agents), and a replacement branch-handoff path must be chosen —
the `git bundle` to `.development-team-agents-backup/bundles/` mechanism was deleted with the backup
directory.

---

## Verification status of every item

Re-verified 2026-09-08 against `main` @ `a0852f2` in a built clone. **A2 was executed**, not read.

| Item | Claim | Verified how |
|---|---|---|
| A1 | `config.ts:326-333` `isHttpsUrl` checks protocol only; `normaliseAllowedHost` calls `isForbiddenHost`, `isHttpsUrl` does not | source, both functions read |
| A2 | `server.ts:52-55` `z.number().optional()` vs `:84-88` `.int().positive()` | **executed** — see below |
| A3 | `refresh.ts:29,55` call `invalidateIndex` / `indexCachedDocument` per entry inside the loop; no session; no rate limit | source |
| A4 | `cache.ts:203` and `:223` both `JSON.parse(readFileSync(...)) as CacheMeta`, unguarded | source |
| A5 | `resolve.ts:434` `saveResolvedEntry` unguarded; `cli.ts:276` awaits `resolveToolText` with no try/catch | source |
| A6 | `selectSections` sums `chunk.length` only; `assemble` joins with a 9-char separator; `get-docs.ts:272` puts `prefix`, `Source:` and `noteBlock` outside `assemble(ranked, budget)` | source, all three lines |
| A7 | Three distinct regex classes; `cleanDescription` (`resolved-store.ts:33-35`) omits U+0080–U+009F | source, all three compared |
| A8 | `list-libraries.ts:5` imports `classifySourceKind` from `./doctor.js`; `mapLimit` at `doctor.ts:210` used by `warm.ts:9` and `autowarm.ts:4`; `retrieval.ts:1` to `config.ts:5` to `project-deps.ts`; `registry.ts` 810 lines | source |
| A9 | `warm.ts:171` — `DEFAULT_REGISTRY.some((d) => d.urls === entry.urls)` | source |
| A10 | No test file uses `spawn`; ratio assertion at `test/retrieval.test.ts:366` | source, grep across `test/` |

---

## A. Security and correctness fixes (0.2.x)

### A1 — Config `urls` must clear the host policy, not just the scheme

**Fix.** Reject `isForbiddenHost(new URL(v).hostname)` as well — already exported from
`src/link-policy.ts:34`. Add a per-entry `allowInternalHosts?: boolean` to `EntrySchema`,
defaulting false, so the air-gapped and internal-docs cases the README markets stay reachable as
an opt-in a config author wrote deliberately, never as the default. That opt-in is the same
mechanism A13 needs — build it here and A13 inherits it.

**Approach decision required first (see A14).** Putting the check in `src/link-policy.ts` as an
exported `validateLibraryUrl` places the trust decision inside the single file that owns host
policy, and makes A1 a change that carries a Change Record. Validating inline in `src/config.ts` is cheaper and
gates nothing. **Recommended: the former.**

**Files.** `src/link-policy.ts` (recommended path) or `src/config.ts`; `test/config.test.ts`.

**Done-when.** A config entry whose `urls` name a loopback address, an IPv4 or IPv6 literal, a
`.local`/`.internal` host or a single-label host is rejected with the D-22 error grammar and
named in the `list_libraries` header; the same entry with `allowInternalHosts: true` loads and
fetches; both pinned. Mirror the existing `allowedHosts` test at `test/registry.test.ts:517`.

**Gate routing.** `security-architect` blocking, plus `code-reviewer` and `qa-test-engineer`.
**Change Record required** on the recommended path — written and signed locally in `.vibectx-plan/change-records/`; no CI check enforces it. **Records D-47.**

### A2 — Bound `maxTokens` on BOTH tools — *scope corrected in rev 2*

**Rev 1 said `get_docs` only. Executing the shipped schemas proved that wrong.** Against the
repo's own `zod` 3.25.76:

| value | `get_docs` `z.number().optional()` | `search` `z.number().int().positive().optional()` |
|---|---|---|
| `Infinity` (from `JSON.parse('1e400')`) | **ACCEPT** | reject |
| `1000000000` | **ACCEPT** | **ACCEPT** |
| `-5` | **ACCEPT** | reject |
| `0` | **ACCEPT** | reject |
| `3.7` | **ACCEPT** | reject |

`get_docs({library:"prisma", maxTokens: 1e9})` makes `budget * 4 = 4e9`, so
`doc.content.slice(0, 4e9)` at `get-docs.ts:148` returns the entire multi-megabyte document into
the model's context. **And `search` has no upper bound either** — `.int().positive()` admits
`1e9` just as happily. This is the defect class D-39 closed in `search`'s *rendering*, still open
in both tools' *input validation*.

**Fix.** `z.number().int().positive().max(200_000)` on **both** `get_docs` and `search`, and at
the CLI `--max-tokens` parse so the paths cannot diverge. Verified: that schema rejects every row
above and accepts 4000.

**Files.** `src/server.ts`, `src/cli.ts`, `test/server.test.ts`, `test/cli.test.ts`.

**Done-when.** Every value in the table above is a schema error the client sees, on both tools and
on the CLI, pinned — the `Infinity` row explicitly, since `JSON.parse` yields it for `1e400` and
zod 3's number parser rejects only `NaN`.

**Gate routing.** `code-reviewer`, `qa-test-engineer`. No CR.

### A3 — `refresh` opens one index session, and gets a rate limit

`refresh.ts:29` and `:55` call `invalidateIndex` and `indexCachedDocument` **per library, inside
the loop**. Each is a full read, often a full write, of `index.json` — measured at 16.9 MB on a
30-document corpus. A no-argument `refresh` iterates all 30 entries: ~90 parses, ~60
serialisations. `warm.ts:308` and `autowarm.ts:103` both open **one** `IndexSession` for the
whole run — the R2 fix documented at `search-index.ts:496-507`, which quantifies what it solved
as "7,529 ms added to an already-fresh 30-library warm". `refresh` never received it.

Separately, `refreshToolText(registry)` with no library is model-callable (`server.ts:110`) and
has **no rate limit at all**, against the resolver's `MAX_RESOLUTIONS_PER_HOUR = 100`. A model in
a retry loop is unbounded egress against thirty upstream documentation sites.

**Fix.** One `openIndexSession` at `refresh.ts:22`, session operations in the loop, `flush()`
once. Add a per-process full-refresh cap in `src/limits.ts`.

**Done-when.** A 30-library `refresh` performs one `readIndex` and one `writeIndex`, asserted by
spy count not by timing; a `[MEASURED]` line prints before/after on the probe corpus; a second
full refresh inside the cap window is refused with a stated reason.

**Folds in a queued item:** "`refresh` should also drop followed-page cache" — same function,
same session.

### A4 — `meta.json` gets a validator like every other store

`cache.ts:203,223`: `JSON.parse(readFileSync(metaPath, "utf8")) as CacheMeta` — no try/catch, no
shape check. Every other persisted store re-validates every field because the cache directory is
a trust boundary (`resolved-store.ts:14`, `project-store.ts:18`, `search-index.ts:49`). A corrupt
`.meta.json` throws out of `list-libraries.ts:37` and `refresh.ts:51`, both unguarded and
untested, taking down `list_libraries` entirely. And `meta.fetchedAt` renders **unvalidated** in
the `list_libraries` footer and in every `get_docs` `STALE:` note — while `project-store.ts:194`
validates `warmedAt` against a strict ISO-8601 regex explicitly because "that string lands
verbatim in the list_libraries footer."

**Fix.** `toCacheMeta()` mirroring `toWarmRow`: per-field validation, the shared `ISO_INSTANT`
regex, `cleanText` on anything rendered. `readCache` returns `undefined` on a bad meta rather
than throwing — D-13 applied to the one store that does not follow it.

**Done-when.** Truncated, invalid-JSON, wrong-shape and hostile-`fetchedAt` `.meta.json` each
leave `list_libraries`, `refresh`, `doctor` and `get_docs` answering correctly with the entry
reported uncached. Four tests, one per corruption class.

**Sequence before** the queued "single content+meta cache file" item — A4 is smaller, closes a
live crash, and leaves that work a validator to reuse.

**Gate routing.** `security-architect` by convention (`src/cache.ts` is integrity-bearing).
No CR — `src/cache.ts` is deliberately not hard-gated (D-44).

### A5 — `resolvePackage` honours its own contract

`resolve.ts:336` documents "Never throws for bad input or bad network." `resolve.ts:434` calls
`saveResolvedEntry` unguarded, and `resolved-store.ts:114,127` throw on EACCES, ENOSPC and
EROFS — so a read-only `$HOME` or a full disk turns `get_docs("<unknown-package>")` into an
exception through `get-docs.ts:91`.

**Fix.** Wrap it; set `saved: false` and `saveNote`, both already on the outcome type
(`resolve.ts:91`). Same treatment for the two CLI paths that throw where the MCP path catches:
`cli.ts:276` and `runSearchCli` at `cli.ts:314`. Because `index.ts:17` uses a top-level `await`,
a throw there is an unhandled rejection with a stack trace, not a clean exit 2.

**Done-when.** With the cache directory read-only, `get_docs` on an unknown name returns the
resolved document plus a `resolution not saved: <reason>` note and exit 0; `vibectx search` and
`vibectx resolve` exit 2 with one line and no stack trace on every error class the MCP path
already catches.

---

## B. Structural refinements (0.2.x)

### A6 — Price the separators and the header block in the `get_docs` budget

`search.ts:308-331` prices `BLOCK_JOIN` and `SECTION_JOIN` exactly, commenting "a budget that
ignores its own separators is not a budget". `get_docs` ignores them: `selectSections`
(`retrieval.ts:306-317`) sums `chunk.length` only while `assemble` joins with a nine-character
separator, and `get-docs.ts:272` renders the prefix, the `Source:` line and the note block
**entirely outside** `assemble(ranked, budget)`. The note block can carry five followed URLs plus
three skip lines. `test/retrieval.test.ts:768` currently encodes the overshoot as expected.

**Done-when.** The D-39 invariant — rendered response no larger than `maxTokens` times 4 — holds
for `get_docs` in both modes including a maximum note block, with the D-43 "the answer outranks
the accounting" ordering. **Amend** `test/retrieval.test.ts:768` rather than deleting it: it
becomes the assertion that the overshoot is gone.

**Gate routing.** `test-auditor` — a shipped test currently pins the wrong behaviour, which is
exactly the failure class that gate exists for.

### A7 — One control-character class, not three

| Function | Covers |
|---|---|
| `project-deps.ts:119-121` `cleanText` | U+0000–U+001F, U+007F–U+009F, U+200B–U+200F, U+202A–U+202E, U+2066–U+2069, U+FEFF |
| `debug.ts:46` `debugField` | as above **plus** U+2028 / U+2029, **minus** U+FEFF |
| `resolved-store.ts:33-35` `cleanDescription` | U+0000–U+001F and U+007F only — **no U+0080–U+009F** — then the zero-width and bidi set |

`cleanDescription`'s output lands in `entry.description` and is rendered by `get-docs.ts:107` and
`resolve.ts:312` **without** a second pass, so a U+009B (control sequence introducer) in an npm
package description reaches the `get_docs` provenance line and the `vibectx resolve` terminal
output. `list_libraries` is safe only because `list-libraries.ts:51` re-cleans via `clipText`.

**Fix.** One exported class in the new `src/text.ts` (A8); the other two call it and keep only
their own clipping. **Done-when:** a fixture containing one character from every class in the
union survives no path to any rendered output — one test, parameterised over every render site.
**Records D-48.**

### A8 — Extract the leaf modules the layering already implies

- `mapLimit`, a generic bounded-concurrency helper, lives at `doctor.ts:210` and is imported by
  `warm.ts:9` and `autowarm.ts:4`; `list-libraries.ts:5` imports `classifySourceKind` from
  `./doctor.js` though `source-kind.ts` exports it directly. So `list_libraries` — documented as
  never touching the network — transitively loads `get-docs`, `fetcher`, `resolve` and
  `cache-evict`. Fix with a new `src/concurrency.ts`; repoint `list-libraries.ts` at
  `./source-kind.js`.
- `retrieval.ts:1` imports `clipText` from `config.ts`, which imports `cleanText` from
  `project-deps.ts` — the BM25 ranker pulls in the TOML and `requirements.txt` parsers at
  runtime. `search.ts:3` likewise. Fix with a new `src/text.ts`, which is also where A7's class
  belongs.
- `registry.ts` is 810 lines of two things: a static 30-entry table (91–422) and merging, alias
  validation and lookup (431–810). Split `src/default-registry.ts`.

**Done-when.** An import-graph test asserts `list-libraries.ts` and `retrieval.ts` do not
transitively reach `fetcher.ts`; no behaviour change; the diff is moves and re-exports only,
provable with `git diff --find-renames`.

### A9 — Replace the reference-identity default check

`warm.ts:171` decides "is this a shipped default" by reference identity on an array:
`DEFAULT_REGISTRY.some((d) => d.urls === entry.urls)`. It holds only because `applyLayer`
(`registry.ts:540`) spreads entries while preserving the `urls` reference. A future
`structuredClone` or JSON round-trip silently disables every D-11 ecosystem note **with no test
failure**. This is the already-queued "`ecosystem` field on registry entries" follow-up — build
it as that: add `ecosystem?: "npm" | "pypi"` to `LibraryEntry`, populate the defaults, let
`warm`'s note read the field. **Done-when:** the D-11 note survives a `structuredClone` of the
registry, pinned by a test that performs the clone.

### A10 — The stdio integration test, and the one flaky assertion

No test file in `test/` uses `spawn`. `test/server.test.ts` uses `InMemoryTransport` with a real
`McpServer` and client — good — but `src/index.ts` never executes. Untested: the top-level
`await`, `dispatchCli` to `process.exitCode`, the `stdin.once("end")` shutdown, `CLOSE_GRACE_MS`
(`index.ts:13,46-49`), and the `process.exit(2)` config-error path. **This is the file every
user's MCP client launches, and it has zero coverage.**

**Fix.** `spawn(node, ["dist/index.js"])`, write one `tools/list` frame, read the response, close
stdin, assert exit within `CLOSE_GRACE_MS`; plus a broken-`--config` case asserting exit 2 and one
stderr line.

**Also here:** `test/retrieval.test.ts:366` asserts `largeMs / smallMs < 6` — a ratio between two
timed runs, the most flake-prone shape in the suite and the same class as the 24-hour test CI
caught once. Convert to a `[MEASURED]` print plus an absolute ceiling, per D-37.

**Extended 2026-09-08 by finding F-1.** A clean-clone baseline run at `c9cc77e` failed once in ten
(`1 failed | 1058 passed`) and never reproduced; its identity was lost to a `tail -5`. A complete
sweep found **six** timing-dependent assertions — the only ones in the suite a loaded machine can
break. `:366` is the leading candidate because `smallMs` is floored by `Math.max(…, 1)`, so a fast
small run collapses the denominator. **Unconfirmed — treat as a hypothesis, not a diagnosis.**

| Location | Assertion |
|---|---|
| `test/retrieval.test.ts:356` | `bigMs < 5000` |
| `test/retrieval.test.ts:366` | `largeMs / smallMs < 6` |
| `test/retrieval.test.ts:935` | `elapsed < 100` |
| `test/retrieval.test.ts:953` | `extractMs < 100` |
| `test/retrieval.test.ts:954` | `indexMs < 100` |
| `test/search-perf.test.ts:153` | `warmMs < D37_BUDGET_MS` |

**Done-when, extended.** All six carry a `[MEASURED]` print, and none gates on wall-clock time in a
way a loaded machine can break — note that swapping a ratio for a *tight* absolute ceiling trades one
flaky shape for another, so `< 100 ms` on 200 KB of hostile input needs the same scrutiny as `:366`.
**Plus:** F-1 is either reproduced and fixed, or the six are made deterministic and 20 consecutive
clean-clone runs pass. **If A10 lands with F-1 neither identified nor eliminated, Phase 1's gate
fails.**

**Gate routing.** `qa-test-engineer` and `test-auditor`.

---

## C. Features (0.3.0) — A11 promoted

### A11 — Version-pinned docs, derived from the manifest `warm` already read

`resolve.ts:27` fetches npm `registry.npmjs.org/<name>/latest`; GitHub READMEs come from `HEAD`.
Nothing in `src/` reads a dependency's version. An agent in a repository pinned to React 18 is
served React 19's documentation, silently, with no marker.

**Why this is the strongest item here.** Dependency auto-discovery is unique to VibeCTX — nothing
else in the category reads `package.json` and pre-warms the right docs. But VibeCTX throws away
the most valuable thing that discovery produces: `warm` already parses the version specifier next
to every name. Version-pinned documentation derived from the manifest is a capability **no
competitor has**, and it converts `warm_project` from a convenience into the reason to use the
tool. `docs-mcp-server` pins with exact versions and semver X-ranges today; Context7's is fuzzy
and mediated by a language model.

`PRODUCT-STRATEGY.md` puts this in 0.3.0 *behind* optional semantic search. **Invert that.**
Semantic search is a capability every competitor already has and one that costs VibeCTX its
second design principle; this is unclaimed ground that strengthens the first.

**Shape.** Version-aware cache keys; `get_docs(library, topic?, version?)` defaulting to the
manifest-derived version when the working directory has a project record; a per-tag resolution
chain (npm `registry.npmjs.org/<name>/<version>`, GitHub `refs/tags/<tag>` with the usual
variants) falling back to current behaviour with an explicit "no versioned document found,
showing latest" marker rather than silence.

**In 0.2.0, and no longer blocked on PAR-653** (scope and release decisions, 2026-09-08). The probe informs the *fallback*
design but does not gate the core behaviour: serve the pinned version where a versioned document
exists, and say so out loud when falling back to latest. Build the core; refine the fallback when
the numbers land.

### A12 — Local `file://` sources — **OUT OF SCOPE (2026-09-08)**

Declined by the scope decision. Serving a project's own architecture decision records, coding
standards and glossary is project-internal context, not documentation caching — it is precisely
the expansion the decision declines.

**Linear consequence: close PAR-660 and PAR-661 as out of scope**, not deferred. The original
deferral was conditional on PAR-653's coverage numbers; that condition is moot, because the
feature is declined on scope rather than on coverage.

### A13 — Private and internal URL sources with token authentication

Named in `PRODUCT-STRATEGY.md` as "Context7-can't-do-this differentiation", reaching Segments B
and C. **The safe version of this feature is exactly A1's `allowInternalHosts` opt-in** — fixing
the vulnerability and shipping the feature are the same mechanism. Touches `src/fetcher.ts` and
`src/link-policy.ts`, so a **Change Record is required** (local, unenforced by CI), with `security-architect` blocking.

---

## C2. Docs-cache scope work (added by the 2026-09-08 scope decision)

These four came out of the context-layer research and survive into the narrowed scope. Each sits
inside a documentation cache's natural boundary. Evidence for each is in
`claude/VibeCTX-context-layer-design-2026-09-08.md` §1.

### A16 — The package-existence signal

**Problem.** Spracklen et al. (USENIX Security 2025): 16 models, 576,000 samples, **205,474 unique
invented package names**; 5.2%+ for commercial models, 21.7% open-source. Attackers register the
invented names — "slopsquatting". This is the best-evidenced single failure mechanism in the
research base.

**Why it is nearly free here.** `resolve.ts` already queries `registry.npmjs.org/<name>/latest` and
`pypi.org/pypi/<name>/json`, and already validates names against npm rules and PEP 503. **The
capability exists; only the framing is missing.** Today a name neither registry knows produces an
`unresolved` documentation miss. It should produce an unambiguous *this package does not exist in
npm or PyPI* — distinct in wording from "this package exists but publishes no documentation,"
because those two facts have completely different consequences for the reader.

**Files.** `src/resolve.ts`, `src/warm.ts` (the `unresolved` status), `src/server.ts` (tool text).

**Done-when.** A name no registry knows returns the non-existence line, distinct from the
no-documentation line, in `resolve_library`, `get_docs`, the CLI and `warm`'s table; both states
pinned by tests. `--json` gains a status value, which per the existing rule **bumps
`schemaVersion`**.

**Gate routing.** `security-architect` (this is a supply-chain control), `code-reviewer`,
`qa-test-engineer`.

### A17 — A provenance stamp on every response

**Problem.** Audit §5.4 item 4. `get-docs.ts:104-113` emits provenance only on the call that
*performed* a resolution. Every later call returns the same third-party document with no marker.
Nothing says which document, which version, how old, or that the content is retrieved external
text rather than instruction.

**Fix.** A short standing envelope on every response from `get_docs` and `search`: source URL,
version or ref, fetched-at, fresh/stale, curated/resolved. Priced inside the token budget (A6 is
the prerequisite — the budget must count its own header before more header is added).

**Done-when.** No response from either tool renders documentation text without its stamp; the
stamp survives the D-43 "answer outranks accounting" degradation ordering; pinned.

**Depends on A6.**

### A18 — An unmistakable "no documentation on that"

**Problem.** `search` ends every response with what was searched, out of how many, and how to cache
the rest — deliberately, so "nothing matched" can never read as "nothing was looked at." `get_docs`
has no equivalent. A thin or empty answer invites the agent to fill the gap by guessing.

**Fix.** Carry the `search` pattern into `get_docs`: name the document that was searched, its
version, and that the topic was not found in it — as a positive statement, not an absence.

**Done-when.** Every no-match and thin-match path in both modes emits the statement; the existing
`No code snippets matched …` line is folded into the same grammar; pinned.

### A19 — Surface what `doctor` already knows

**Problem.** `doctor` classifies each source (full-text / index-only / readme) and proves retrieval
actually works — a better health signal than any competitor's repo-popularity score. **The model
never sees it.** It appears in neither `list_libraries` nor any `get_docs` response. PAR-704 is the
live case: fastify read healthy and returned nothing for every query.

**Fix.** Carry the classification into `list_libraries` entries and into the A17 stamp.

**Widens a queued item.** The existing "doctor `answered` required-term check" follow-up should be
widened to "surface doctor's verdict where the model reads it" and built here.

### A20 — The activity log (VibeCTX's own audit record)

**Problem.** VibeCTX cannot answer *"what did you actually serve, and when?"* It keeps no record of
its own activity. Two consequences, both real:

- **No evidence behind a claim of consultation.** The live example is in this repo:
  `CR-20260907-par-652-governance.md` carries a signed completion verdict attesting four retro rows
  existed and were verified line by line. They never reached the machine. An attestation outlived
  its proof because nothing recorded what was actually looked at.
- **No way to know whether VibeCTX helps.** Gloaguen et al. (ETH Zurich, Feb 2026) measured
  repository context files and found them **−2 to −3% on success and +20 to +23% on cost**. Without
  a record of what was served, VibeCTX can only *assert* value the same way those tools did before
  someone measured them.

**Fix.** A local activity record in the cache directory. One entry per retrieval: tool
(`get_docs` / `search` / `resolve_library` / `refresh`), library canonical name, the topic or query
(cleaned and clipped), the document URL, its content hash, the version if known, fresh or stale,
the outcome (`matched` / `no-match` / `not-cached` / `unresolved`), and a timestamp.

**No document text, ever.** Same rule the search index follows (D-33): the log has no authority and
holds no content. It records *what was consulted*, never *what was said*.

**Read it back through `vibectx log --json`,** in the same `schemaVersion` envelope every other
command emits. That is the entire interface — there is no special API for gates or harnesses. A
Workforce gate reads it exactly the way it reads `warm --json`, and so can anything else. This is
what keeps the feature inside the docs-cache boundary: VibeCTX reports on its own work in the shape
it already reports everything else.

**Bounds and honesty — these are not optional.**

- **Local only, never transmitted.** The honest-defaults principle admits no exception here.
- **Off switch.** `VIBECTX_NO_LOG=1`, documented alongside `VIBECTX_NO_AUTOWARM`.
- **Bounded.** A cap on entries and bytes, oldest evicted first, following the cache size cap's
  precedent. An unbounded log is a slow disk leak.
- **Validated per field on read**, per A4's rule — the cache directory is a trust boundary and this
  file is no different from `resolved.json` or a project record.
- **Topic and query strings are user text** reaching output: cleaned and clipped on write and on
  render, per D-30 and A7's single character class.
- **A privacy line in the README.** This file records what the user searched for. That is new data
  VibeCTX has never held, and it must be disclosed plainly rather than buried.

**Files.** New `src/activity-log.ts`; write hooks in `get-docs.ts`, `search.ts`, `resolve.ts`,
`refresh.ts`; `src/cli.ts` for the `log` subcommand; `src/limits.ts` for the cap; README.

**Done-when.** Every retrieval path writes exactly one entry; `vibectx log --json` emits them in the
shared schema with a stable key order; the cap is proven by a test that exceeds it; the off switch
is proven; a corrupt or unwritable log never breaks a retrieval (D-13); and a test pins that **no
document text appears in the file** under any path.

**Gate routing.** `security-architect` (new persisted data with a privacy surface), `code-reviewer`,
`qa-test-engineer`. No Change Record — it touches neither URL trust, fetching, nor cache integrity.

**Records D-51.**

**Sequencing.** Independent of A16–A19; buildable any time after A10. Worth doing early rather than
late, because it is the substrate any later measurement of the product's value depends on.

## D. Governance and plan reconciliation

### A14 — Put the URL trust decision in the file that owns host policy

`.vibectx-plan/change-record-policy.md` gates `src/fetcher.ts` and `src/link-policy.ts` because they carry
the network trust boundary. A1 is a network-trust-boundary defect in `src/config.ts`, which is
not gated. The gated set does not cover the surface it claims to.

**DECIDED 2026-09-08 — move the validation, not the gate.** Export `validateLibraryUrl` from
`src/link-policy.ts` and have `config.ts` call it. The trust decision then lives in the one
file that owns host policy, and it is not duplicated anywhere else. The alternative — adding
`'src/config.ts'` to `GATED` — puts a Change Record on every config change, which is the
over-governance PAR-652 removed. With the code in `link-policy.ts`, A14 reduces to a documentation change: record D-49 and add a
line to `src/link-policy.ts`'s header comment stating that this file is the sole owner of the URL
trust decision, so a future reader does not re-open the question. *(Rev 2 sent that line to
`docs/change-record-policy.md`; that file no longer exists in the repository, so the note goes in
the source instead, where it will actually be read.)* **Fold this into A1's Change
Record** rather than running it as a separate item. **Records D-49.**

### A15 — Reconcile the strategy documents with what ships

1. **`npx` as design principle #1.** `PRODUCT-STRATEGY.md:55` states "`npx vibectx` must just
   work"; `:100-103` makes "anything that reintroduces a setup tax" a non-goal; `:107` names the
   beachhead as "zero-config `npx`"; `LAUNCH-STRATEGY.md:100` makes it a hard launch gate and
   `:79-86` keys an invest/leave rule to weekly npm downloads. **npm distribution was abandoned
   2026-09-07.**
2. **The rival named is no longer the rival described** (`PRODUCT-STRATEGY.md:24-26`).
3. **The Context7 comparison is written against a tool surface that no longer exists.**

**And the honest consequence.** Install friction is now VibeCTX's worst competitive attribute:
clone, `npm ci`, `npm run build`, an absolute path into the MCP client config, optionally
`npm link` with a prefix fix — against `npx ctx7 setup` or pasting a `gitmcp.io/owner/repo` URL.
The offline-determinism argument for abandoning npm is sound and the audit agrees with it — but
something must replace it (a prebuilt `dist/` on a release tag, a Homebrew formula, a single-file
bundle, a one-line installer) or the beachhead segment is not reachable and the strategy should
say so rather than assert a moat the product no longer has.

**Amending adopted product direction is Tom's call.** Recorded, not patched.

**One documentation change needing no strategy decision:** lead the README with `warm_project`.
It is the one thing nothing else in the category does, and it is currently the fifth thing a
reader meets. *(A second item here — `CONTRIBUTING.md` being the wrong project's file — was
closed on 2026-09-08 by deleting the file. The repository now ships no contributor guidance at
all; writing a short VibeCTX-specific one is worth adding to Phase 7.)*

**Note, 2026-09-08:** both strategy documents were removed from the repository and from its
history. They are local-only, in `.vibectx-plan/`. The line references above still resolve
against those copies.

---

## New decisions to record

| ID | Decision |
|---|---|
| **D-47** | A library `urls` entry must clear the same host policy a followed link clears. Internal, loopback and non-routable hosts are reachable only through an explicit per-entry `allowInternalHosts: true`. Ref: A1. |
| **D-48** | One exported control and bidi character class, in `src/text.ts`, is the contract for every render path. Adding a character to it is a D-30 amendment; a local variant is a defect. Ref: A7. |
| **D-49** | The URL trust decision lives in `src/link-policy.ts`, the one file that owns host policy, and every caller — config included — calls it rather than re-implementing a subset. Ref: A14. |
| **D-51** | VibeCTX records its own activity — what was consulted, at which document hash and version, when — locally, bounded, content-free, and readable through the same `--json` envelope as every other command. It never records what was *said*, only what was *looked at*. Ref: A20. |
| **D-50** *(if A11 is taken)* | Documentation is served for the version the project's manifest pins where a versioned document exists, and the fallback to latest is always stated in the response, never silent. Ref: A11. |

D-01 through D-46 remain authoritative in `claude/vibectx-build-loop-state.md` and are the
numbering baseline.

## Reconciliation with follow-ups already queued

From `## next` in the build-loop state file, to prevent duplicate issues:

| Queued item | Disposition |
|---|---|
| `ecosystem` field on registry entries (D-11 follow-up) | **Becomes A9**, now with a concrete failure mode and a test. |
| `refresh` should also drop followed-page cache | **Folds into A3.** |
| UTF-16 vs bytes mismatch in the ~2 MB accumulation | **Confirmed** at `fetcher.ts:79` — the no-`res.body` fallback compares UTF-16 code units where the streaming path compares bytes. Low impact; stays queued, not promoted. |
| Single content+meta cache file | **Sequence after A4.** |
| Split the `unresolved` bucket in the `list_libraries` summary | Unchanged. |
| Prune project records orphaned by a moved project | Unchanged. |
| Doctor `answered` required-term check | **Widen it.** `doctor` proves retrieval works — a better signal than Context7's repo-stars trust score — but its classification never reaches `list_libraries` or a `get_docs` response, so the model never sees it. Widen to "surface doctor's verdict where the model reads it". |
| SHA-pin actions in `ci.yml` and `doctor.yml` | Unchanged; `.github/`, carries a CR. Could ride with A14. |
| Carry final URL in `DocResult` | Unchanged. |
| Monorepo layering of nested project configs | Interacts with A1: layering means more than one file can supply a `urls` entry. |
| Reserved interactive share of the 100/h resolution budget | Interacts with A3's new refresh cap — both are per-process rate limits and should share one mechanism. |

---

## Open risks

1. **A11 is a reprioritisation, not a refinement.** Promoting it past work already adopted in
   `PRODUCT-STRATEGY.md` should be decided, not absorbed.
2. **A2 and A6 are the same defect class the gates caught in `search` (D-39), surviving in
   `get_docs`** — and A2 turned out to be in `search` too. When a gate finds a defect in one
   module, the sibling is not being checked. That is the second earned row for the rebuilt retro
   log (the first is in the current-state card section 7).
3. **Nothing here is measured on real documentation.** PAR-653 is still the blocker it was on
   2026-09-05: four issues' claims, and A11's fallback design, wait on a probe from a machine that
   reaches the docs sites.
4. **Two preconditions are unmet.** The agent pack is uninstalled, and the branch-handoff path was
   deleted with the backup directory. Neither is hard to restore; both must be before A1 starts.

## Provenance

- **Every item A1–A10 was re-verified directly against `main` @ `a0852f2`** in a built clone — see
  the verification table above.
- **A2 was executed**, not read: the shipped schemas were run against the repo's own `zod`
  3.25.76. That run is what corrected A2's scope.
- **A1's exploit path is reasoned from source, not executed.** The missing check and the autowarm
  call chain were confirmed; no metadata endpoint was stood up.
- **Competitive facts come from a research pass that read Context7's and docs-mcp-server's sources
  and documentation directly.** They were not personally re-fetched by this document's author.
  Vendor-stated counts and percentages are self-reported and unverified.
- Two time-of-check-to-time-of-use windows (`cache-evict.ts:362`, `cache.ts:132-147`) remain
  **suspected, not confirmed**, and are deliberately not filed as items — both need write access
  to `$HOME`.
- Suite state **MEASURED 2026-09-08**: 1059/1059 in 32 files, lint clean, on a fresh clone.
