> # THE BUILD LOOP IS RETIRED — 2026-09-10.
> **This document is a historical record, not a live plan.** The relay of build sessions, go cards and
> handoff bundles that produced items A1–A6 and A10 is no longer in use for this project. Nothing here
> should be resumed, and no further entries will be appended.
> **What it records is accurate as of `main` @ `839bfd7`** — 1202 tests across 36 files, CI green on
> Node 22, Phases 0–4 closed, 7 of 16 items landed. **Everything still open is tracked in Linear under
> PAR-515**, which is the authority from here.

# VibeCTX 0.2.0 — phased build plan with blocking test gates

**2026-09-08.** Eight phases. **No phase may begin until the previous phase's gate is green and its evidence is recorded.** The gate is a set of runnable checks with pass/fail answers, not a judgment call.

Companion documents: `claude/VibeCTX-scope-decision-2026-09-08.md` (what is in scope) · `claude/VibeCTX-plan-revision-2026-09-08.md` (per-item detail) · `claude/vibectx-build-loop-resume.md` (state) · `claude/vibectx-build-session-go.md` (kickoff).

---

## The rules that govern every phase

1. **A gate is evidence, not assertion.** Every criterion below is a command whose output is recorded. "It works" is not a gate result; a paste of the run is.
2. **Regression is part of every gate.** Each phase re-runs every prior phase's gate. A phase that breaks an earlier gate has not passed its own.
3. **A single blocking FAIL stops the phase.** Verdicts are never averaged into a pass.
4. **An unmet done-when is reported unmet.** Never restated to match what was built. PAR-658 is the precedent, and it is the reason that issue is still open.
5. **Prove the control runs on the live path.** A test that exercises a function directly does not prove the function is reached in production. Where a phase adds a guard, the gate must show it firing on the real path.
6. **Test count is recorded at every gate.** Baseline is **1059 in 32 files** (MEASURED 2026-09-08, fresh clone of `a0852f2`). A phase that adds behaviour and no tests is visible immediately.

**On rounds.** This project's own history says a first-pass gate rarely passes: PAR-656 took **five** producer rounds, PAR-659 took **four** with three FAILs in round one, PAR-652 took three. **Plan for two to four rounds per item.** A phase gate failing is the process working, not a setback.

---

## Phase 0 — Preconditions

**No code. Nothing else starts until this is closed.**

| Work | Owner |
|---|---|
| ~~Reinstall the agent pack~~ **DONE 2026-09-08 — nothing to reinstall.** The packs are Claude Code **plugins**, installed at user scope from the `blackraptor` marketplace, all five at **2.1.0**, enabled. What was removed from VibeCTX was a hand-vendored 2.0.0 duplicate of a pack that was already installed. Verify with `claude plugin list`; do not vendor anything into the repo. | Tom — closed |
| ~~Choose the replacement branch-handoff path~~ **DECIDED 2026-09-08 (D-54): bundles into `../vibectx-handoff-bundles/`, a sibling of the repo.** Remaining work is the **dry run** — one throwaway branch moved end to end by that path. | Build session proposes, Tom lands |
| Write the pack's project context — `CLAUDE.md`, `BUSINESS-CONTEXT.md`, `USER-PREFS.md` at the repo root, via `context-onboarding`. VibeCTX is a **bare repo** to the Engineering pack, which is project-scoped. All three are gitignored as of `273a8ca`. Source them from `README.md`, the scope decision and this card; mark inferred facts `ASSUMED` and unknown ones `UNKNOWN` — a plausible invention here becomes a standing instruction to every agent that follows. | Build session, Tom approves |
| Rebuild the cloud clone and confirm the baseline | Build session |

### Gate 0

```
git clone git@github.com:BlackRaptorAI/VibeCTX.git && cd VibeCTX
npm ci && npm run lint && npx vitest run
```

- [ ] `npm ci` clean, `npm run lint` clean
- [ ] **1059 passing in 32 files** — if not 1059, stop and report before touching anything
- [ ] **Never pipe a gate run through `tail`, `head` or `grep` before its result is known.** Redirect the full output to a file and read the summary from it. A failure whose test name and assertion were discarded by a pipe costs more to recover than the whole run costs to repeat — this happened on 2026-09-08 and produced finding F-1.
- [ ] **Any failure is captured with its test name and its assertion text before anything proceeds.** "Stop and report" is not a next move on its own.
- [ ] `npm audit` reports **0 vulnerabilities**
- [ ] `claude plugin list` shows **blackraptor-core** and **blackraptor-engineering** at **2.1.0**, enabled
- [ ] All producer/gate roles resolve when dispatched. **Seat names changed in 2.1.0:** schema sign-off is `schema-reviewer` (not `data-engineer`); test/coverage sign-off is `test-auditor` (not `qa-test-engineer`). `product-marketing` is no longer in the Engineering pack.
- [ ] `git status --porcelain` in the repo is **empty** after the plugin check — a plugin install must never write into the working tree
- [ ] The handoff path is written down and a dry run has moved one branch end to end

**Estimated effort:** 0.5 day (ASSUMED — mostly waiting on decisions, not work)

---

## Phase 1 — The safety net

**A10 — the stdio integration test.**

This is deliberately first. `src/index.ts` is the file every MCP client actually launches and it has **zero coverage** today. Building its test before anything else means **every subsequent phase gate can re-run a real end-to-end smoke test** rather than trusting that the built artifact still starts.

| Item | |
|---|---|
| **PAR-723 (A10)** | `spawn(node, ["dist/index.js"])`, one `tools/list` frame, clean shutdown, exit-2 path. Convert the ratio-between-timed-runs assertion at `test/retrieval.test.ts:366` to a `[MEASURED]` print plus an absolute ceiling. |

### Gate 1 — this becomes the standing smoke test

```
npm run build && npx vitest run
```

- [ ] A spawned `node dist/index.js` answers a `tools/list` frame listing **all seven tools**
- [ ] A deliberately broken `--config` exits **2**, one stderr line, **no stack trace**
- [ ] Closing stdin exits within `CLOSE_GRACE_MS`
- [x] ~~`grep -rn "largeMs / smallMs" test/` returns **nothing**~~ — **AMENDED 2026-09-09 by Tom.**
  A ratio between two timed runs is permitted where it is the only shape that can detect a complexity
  regression, provided the flakiness root cause is diagnosed rather than guessed, both corpora are sized
  so scheduler jitter is proportionally small, and the bound carries measured margin under load.
  Superseded criterion: no ratio assertion at all. Basis: A10's diagnosed fix — denominator floored by
  `Math.max(…,1)`, corpora scaled 4x, [MEASURED] ratio 3.20–4.82 across 40+ load-tested runs.
  **This criterion was changed after A10 was built; it was not satisfied as originally written.**
  Gate log §9 records it as an amendment, not as a pass.
- [ ] `grep -rln "spawn" test/` returns **at least one file** — the harness exists
- [ ] Suite green, count **> 1059**, count recorded
- [ ] Gate 0 re-run green

**Amendment note, 2026-09-09.** As printed, Gate 1 never mentioned F-1, the other five timing assertions,
or the 20 consecutive clean-clone runs — those lived only in A10's extended done-when in
`VibeCTX-plan-revision-2026-09-08.md`, and A10 was judged against both. A phase gate's checklist is not
the whole gate for an item whose done-when extends it; read every future phase gate alongside its items'
done-whens.

**Rollback trigger:** if the spawned process cannot be made to exit deterministically, stop and redesign the harness — a flaky smoke test is worse than none, because every later gate would inherit its flakiness.

**Estimated effort:** 1 day (ASSUMED)

---

## Phase 2 — Stop the bleeding

**A1 and A2 — the live security defect and the unbounded inputs.**

| Item | |
|---|---|
| **PAR-714 (A1)** | `validateLibraryUrl` exported from `src/link-policy.ts`; `config.ts` calls it; `allowInternalHosts` opt-in. **Change Record required** — local, in `.vibectx-plan/change-records/`; no CI check enforces it. A14's note folds in. |
| **PAR-715 (A2)** | `z.number().int().positive().max(200_000)` on `get_docs`, `search`, and the CLI. |

### Gate 2 — the security regression suite

**The A1 half must prove absence of request**, following the pattern already proven at `test/fetcher.test.ts:425-562`: run a real `http.Server` on 127.0.0.1 and assert `listenerHits === []`. A test that only checks the rejection message does not prove nothing was fetched.

- [ ] Config `urls` naming each of: a loopback address · an IPv4 literal · an IPv6 literal · a `.local` host · a `.internal` host · a single-label host · `localhost:8443` → **each rejected**, D-22 error grammar, named in the `list_libraries` header
- [ ] **Listener hit count is zero for every one of those seven cases**
- [ ] The same entry with `allowInternalHosts: true` → loads and fetches
- [ ] **Enforcement liveness:** a test proves `validateLibraryUrl` fires on the `startAutowarm` path, not only on the direct config-load path. This is the path the exploit used.
- [ ] The `maxTokens` matrix — `Infinity` (from `JSON.parse('1e400')`), `1000000000`, `-5`, `0`, `3.7` → **all rejected** on `get_docs`, on `search`, and at the CLI; `4000` accepted on all three
- [ ] A1's Change Record is written to `.vibectx-plan/change-records/`, carries a `security-architect` verdict, and states the D-47 decision. *(The machine validator `validate_verdict.py` was removed from the repository on 2026-09-08 — this criterion is checked by reading, not by running a script.)*
- [ ] `security-architect` verdict is **PASS**, not CONCERNS-with-conditions-open
- [ ] Gates 0–1 re-run green

**Rollback trigger:** if `allowInternalHosts` cannot be made to work without widening the default, ship the rejection alone and defer the opt-in to A13. **The safe default is not negotiable; the opt-in is.**

**Estimated effort:** 1.5 days (ASSUMED — A1 carries a CR and a blocking security gate)

---

## Phase 3 — Store integrity

**A4 and A5 — the tool crashing or lying when its own files are bad.**

| Item | |
|---|---|
| **PAR-717 (A4)** | `toCacheMeta()` validator; `readCache` returns `undefined` rather than throwing. |
| **PAR-718 (A5)** | Guard `saveResolvedEntry`; guard the two CLI paths that throw where the MCP path catches. |

### Gate 3 — the corruption matrix

**Four corruption classes × four consumers = sixteen cases**, each of which must leave the tool answering correctly with the entry reported uncached:

| | `list_libraries` | `refresh` | `doctor` | `get_docs` |
|---|---|---|---|---|
| truncated `.meta.json` | ☐ | ☐ | ☐ | ☐ |
| invalid JSON | ☐ | ☐ | ☐ | ☐ |
| wrong shape | ☐ | ☐ | ☐ | ☐ |
| hostile `fetchedAt` | ☐ | ☐ | ☐ | ☐ |

- [ ] With the cache directory **read-only**: `get_docs` on an unknown package name returns the resolved document **plus** a `resolution not saved: <reason>` note, **exit 0**
- [x] ~~With the cache directory read-only: `vibectx search` and `vibectx resolve` exit **2**, one line, **no stack trace** — verified through the Phase 1 spawn harness, so an unhandled rejection cannot hide~~ — **AMENDED 2026-09-09 by the oversight seat.**
  **The exit code `2` was wrong when this criterion was written.** `README.md` documents `2` as a
  **usage or config error** — that paragraph predates this criterion and predates A5's diff, so it is
  not self-justification; oversight confirmed it appears as unchanged context in `c50faf0`. A
  read-only cache directory is a runtime I/O failure, neither usage nor config. Both guards below the
  CLI layer catch it first, so the commands report **differentiated real outcomes (`0` or `1`)**
  rather than a generic catch-all — **more** informative than `2`, not less.
  **The substance of the criterion is unchanged and WAS met:** one line, no stack trace, verified
  through the Phase 1 spawn harness against a real `chmod 0o500` directory in a real spawned process,
  asserting on stack-trace *shape* (`/\n\s+at\s/`) rather than message text.
  **This criterion was changed after A5 was built; the `exit 2` clause was not satisfied as
  originally written, and could not have been by any correct implementation.** Recorded in the same
  form as Gate 1's amendment — the criterion was oversight's error, not the build session's.
- [ ] `grep -c "as CacheMeta" src/cache.ts` returns **0**
- [ ] Gates 0–2 re-run green

**Rollback trigger:** none. Both items are additive guards; if either cannot be completed, it does not block Phase 4 — but it must be recorded as carried, not silently dropped.

**Estimated effort:** 1.5 days (ASSUMED)

---

## Phase 4 — Work and budget correctness

**A3 and A6 — the tool doing far more work, and returning far more, than it should.**

**A6 must land here because A17 in Phase 6 depends on it.** The budget has to count its own header before a provenance stamp adds more header.

| Item | |
|---|---|
| **PAR-716 (A3)** | One `IndexSession` for the whole refresh; a per-process full-refresh cap. |
| **PAR-719 (A6)** | Price `SECTION_JOIN`, the `Source:` line and the note block into the `get_docs` budget. |

### Gate 4

- [x] ~~A 30-library `refresh` performs **exactly one** `readIndex` and **exactly one** `writeIndex`~~ — **AMENDED 2026-09-10 by the oversight seat.** Now reads: a 30-library `refresh` performs a **CONSTANT** number of `readIndex`/`writeIndex` calls, independent of library count — **asserted by spy count, never by timing.**
  **MEASURED at `bf89bd5`:** 3 reads / 1 write when content changed; **1 read / 0 writes when nothing changed** — better than the criterion demanded, in the case a scheduled refresh hits most often.
  **"Exactly one read" could not be satisfied by any correct implementation scoped to `refresh.ts`.** Oversight traced all three: (1) `openIndexSession`'s lazy snapshot at `search-index.ts:539`; (2) `flush()`'s deliberate re-read at `:600`, which exists because the index is a **shared** cache another process may have written between the first `add` and the flush — deleting it would be a correctness regression, and it is shared with `warm` and `autowarm`; (3) one `invalidateIndex` on the still-O(n) resolved-entry path at `refresh.ts:66`, which reads, finds nothing to delete, and returns **without writing** — which is why the write count is 1 and not 2.
  **The criterion was measuring the wrong thing.** The audit's evidence was ~90 parses and ~60 serialisations of a 16.9 MB file — an **O(n) vs O(1)** problem. "Exactly one" is a stricter and different claim than "constant," and only the second is what the defect was about. **The criterion was oversight's error, not the build session's; the session reported it UNMET as literally written rather than restating it, which is plan rule 4 working.**
- [~] A `[MEASURED]` line prints the before/after on the probe corpus and is pasted into the phase record — **PARTIALLY MET, and honestly labelled.** The **after** is measured. The **before** is printed as `[A3 ESTIMATED, pre-fix] ~90 reads, ~60 writes` and carries its own disclaimer: *"never independently re-measured here."* A `test-auditor` round caught the two registers sharing one line and forced the split.
  **Consequence, stated rather than glossed:** the *shape* of the improvement is established (constant vs. per-library, from the measured 3-vs-30 comparison); its *magnitude* is not. Nothing should cite "90 reads to 3" as a measured result. Under D-37 the number is the record — and the before-number is an estimate.
- [ ] A second full refresh inside the cap window is **refused with a stated reason**
- [ ] **The budget invariant holds for `get_docs` across ALL THREE render paths:** rendered response ≤ `maxTokens × 4`, including a **maximum-size note block** (five followed URLs plus three skip lines)
  **AMENDED 2026-09-09 by the oversight seat, BEFORE the item was built.** This read *"in both
  modes."* `GetDocsMode` is `"sections" | "snippets"`, but a **third render path** exists that
  PAR-719 never mentions: the **no-topic table-of-contents branch at `get-docs.ts:150-158`**, and it
  is the worst offender. `const head = doc.content.slice(0, budget * 4)` alone consumes the entire
  allowance, and the stale-note prefix, the `Source:` line and a table of contents of up to 60
  heading lines are then prepended — kilobytes of overshoot, against 9 characters per gap for the
  separator defect. **Gates 1 and 3 were both amended AFTER their items were built; this one is
  corrected in front of the work.**
- [ ] The D-43 ordering survives — at any budget the answer outranks the accounting
- [ ] `test/retrieval.test.ts:825` (was `:768` — line drifted; MEASURED at `c50faf0`) is **amended, not deleted**, and now asserts the overshoot is gone
- [ ] `test-auditor` verdict is **PASS** — this gate exists because a shipped test currently pins the wrong behaviour
- [ ] Gates 0–3 re-run green

**Rollback trigger:** if pricing the note block makes small-budget responses unusable, cap the note block rather than exempting it. **An exempt header is how this defect started.**

**Estimated effort:** 2 days (ASSUMED)

---

## Phase 5 — Structure

**A8, A7, A9 — refactors with a proof obligation.**

Order matters: **A8 first** (it creates `src/text.ts`), **then A7** (its character class lives there), **then A9** (easier once the default registry is split out).

| Item | |
|---|---|
| **PAR-721 (A8)** | Extract `text.ts`, `concurrency.ts`, `default-registry.ts`. |
| **PAR-720 (A7)** | One control-character class, in `text.ts`. |
| **PAR-722 (A9)** | `ecosystem` field replaces reference identity. |

### Gate 5 — behaviour identity is the gate

- [ ] An **import-graph test** asserts `list-libraries.ts` and `retrieval.ts` do **not** transitively reach `fetcher.ts`
  **VALIDATED 2026-09-10 at `bf89bd5` — half of this is ALREADY TRUE, and the criterion reads as though neither is.**
  `retrieval.ts` imports only `config.js` and `tokenize.js`; `tokenize.ts` imports nothing, and
  `config.ts` → `project-deps.js` / `link-policy.js` / `registry.js`, **none of which reference
  `fetcher.js` (measured: 0 refs each)**. **`retrieval.ts` already satisfies this criterion.**
  `list-libraries.ts` reaches `fetcher.ts` through **exactly one edge — `autowarm.js`** (`doctor`,
  `cache`, `config`, `registry`, `project-store`: 0 refs each). **That single edge is the whole of
  the real work here.** Write the test to assert both, but do not budget as though both are broken.
- [ ] `git diff --find-renames` on the A8 branch shows **moves and re-exports only**
- [ ] **The behaviour-identity proof:** the full suite passes A8 with **zero test changes attributable to the refactor**. Any existing test that had to change is a **defect, not an improvement** — investigate before proceeding.
- [ ] A fixture carrying one character from **every class in the union** (U+0000–U+001F, U+007F–U+009F, U+200B–U+200F, U+2028/2029, U+202A–U+202E, U+2066–U+2069, U+FEFF) survives **no** render path: `get_docs` provenance line, `resolve` CLI output, `list_libraries`, `warm` table, `doctor`, debug fields
  **VALIDATED 2026-09-10 at `bf89bd5`. THE STATED UNION MATCHES NO EXISTING IMPLEMENTATION, AND THE
  THREE IMPLEMENTATIONS DISAGREE WITH EACH OTHER.** Measured:
  | Site | Has U+2028/29 | Has U+FEFF | Has U+0080–U+009F | Replaces with |
  |---|---|---|---|---|
  | `project-deps.ts:120` `cleanText` — **the one `config.clipText` calls, so the widest-reaching** | **NO** | yes | yes | `""` |
  | `debug.ts:46` | yes | **NO** | yes | `""` |
  | `resolved-store.ts:34-35` | **NO** | yes | **NO** | **`" "` for C0/DEL**, `""` for the rest |
  **Consequence: U+2028 / U+2029 are stripped by `debug.ts` ALONE.** They survive `clipText`, and
  therefore survive config errors, `list_libraries`, and provenance lines. That is a live gap today,
  not a hypothetical the refactor might introduce.
  **AND THE CRITERION OMITS REPLACEMENT SEMANTICS ENTIRELY.** `resolved-store.ts` substitutes a
  **space** for C0/DEL where the others delete. "Survives no render path" cannot be assessed without
  settling that: a character replaced by a space has not survived, but the string is not the same
  either. **A7 must decide delete-vs-substitute and record it under D-48, or the "one class" is one
  character set with two behaviours.**
- [ ] D-30's asymmetry is **unchanged** — section bodies are still raw, and the test pinning that still passes
- [ ] The D-11 ecosystem note survives a `structuredClone` of the registry, proven by a test that performs the clone
- [ ] Gates 0–4 re-run green

**Rollback trigger:** if the import-graph test cannot be made to pass without changing behaviour, **stop and split the item.** A refactor that changes behaviour is a feature in disguise and needs its own gates.

**Estimated effort:** 2.5 days (ASSUMED)

---

## Phase 6 — The five problems

**A11 + A16, then A17, A18, A19, A20.** This is the phase that delivers what the scope decision says the product is for.

Order: **A11 and A16 together** (one job — both read the manifest) → **A17** (needs Phase 4's A6) → **A18** → **A19** → **A20** (independent; can move earlier if a producer is free).

| Item | |
|---|---|
| **PAR-724 (A11)** + **PAR-725 (A16)** | Version-matched documentation; the package-existence signal. |
| **PAR-726 (A17)** | Provenance stamp on every response. |
| **PAR-727 (A18)** | Unmistakable "no documentation on that". |
| **PAR-728 (A19)** | Surface `doctor`'s verdict where the model reads it. |
| **PAR-729 (A20)** | The activity log. |

### Gate 6 — the acceptance suite, written against the five problems

**This gate tests the product's stated purpose, not the implementation.** Each item maps to one of the five problems in the scope decision.

**1. Invented packages**
- [ ] A name that exists in neither npm nor PyPI returns **"does not exist in npm or PyPI"**, in `resolve_library`, `get_docs`, the CLI, and `warm`'s status column
- [ ] A real package that publishes no reachable docs returns a **visibly different** statement
- [ ] Both wordings pinned; a test asserts they are not the same string
- [ ] `--json` `schemaVersion` **bumped** — a status value was added
  **VALIDATED 2026-09-10 at `bf89bd5`. THERE ARE TWO SCHEMA VERSIONS AND THIS SAYS NEITHER.**
  `DOCTOR_SCHEMA_VERSION = 1` (`doctor.ts:60`) and `WARM_SCHEMA_VERSION` (`warm.ts:79`), which is
  **`= PROJECT_RECORD_SCHEMA_VERSION`, welded deliberately so "the two can never drift"**
  (`warm.ts:76`). A new status lands in **`warm`'s** column — so bumping warm's version **also bumps
  the ON-DISK project-record version**, a consequence this criterion does not acknowledge.
  **OPEN DESIGN QUESTION, not oversight's to answer:** `warm.ts:277` says an additive change needs no
  bump ("new keys may be appended"), but `warm.ts:78` says older readers **drop rows with an unknown
  status** — so a new *value* in an existing column is not additive for readers even though it adds
  no key. **Decide this deliberately and record it before A16 starts.**

**2. Wrong-version manuals**
- [ ] A project pinned to a non-latest version of a registry library receives **that version's** documentation where one exists
- [ ] Where none exists, the response carries **"no versioned document found, showing latest"** — verified on every fallback path, with **no silent substitution anywhere**

**3. Unlabelled answers**
- [ ] **No response** from `get_docs` or `search` renders documentation text without a stamp carrying source, version, fetched-at, fresh/stale, curated-vs-resolved
- [ ] The stamp survives D-43 degradation — under a squeezed budget the section body wins, but the stamp is not the first casualty
- [ ] The Phase 4 budget invariant **still holds with the stamp present** (this is the A6 dependency paying off)

**4. Quiet gaps**
- [ ] Every no-match and thin-match path in **both modes** emits a positive statement naming the document searched, its version and age
- [ ] The existing `No code snippets matched …` line is folded into the same grammar
  **VALIDATED 2026-09-10 at `bf89bd5`. THAT LITERAL LINE DOES NOT EXIST, AND THERE ARE TWO NO-MATCH
  GRAMMARS IN TWO MODULES, ALREADY DIVERGENT.**
  It is **composed**, not literal: `get-docs.ts:234` builds
  `No ${what} matched "${topic}" in ${entry.name} docs (source: ${doc.url})`, with `what` supplied as
  `"code snippets"` (`:260`) or `"sections"` (`:277`).
  **The second grammar is `search.ts:757`:** `No sections matched "${query}" — ${where}.` Different
  module, different shape, no `source:` clause.
  **This criterion's "both modes" covers only `get_docs`. `search`'s no-match line is a THIRD path it
  does not reach** — the same undercount that Gate 4's "both modes" carried before A6 found the
  no-topic render path. **Scope A18 to all three or say explicitly that `search` is out.**

**5. Healthy-but-empty**
- [ ] A library in the **PAR-704 fastify shape** (index-only source, failing probe) is marked as such wherever the model reads library state
- [ ] That fixture is committed as a permanent regression test
  **VALIDATED 2026-09-10 — ALREADY SATISFIED for the `doctor` path.** `test/doctor.test.ts:133`
  ("fastify shape: index-only, follows a link, answered from the followed page, healthy") and `:158`
  ("index-only with every followed link failing is unhealthy") already commit the shape, and
  `classifySourceKind` is pinned at `:98-101`. **The new work is the OTHER half of this bullet —
  marking it "wherever the model reads library state" (`list_libraries`, `get_docs`) — not the
  fixture.** Do not budget for building a fixture that exists.

**A20 — the activity log**
- [ ] Every retrieval path writes **exactly one** entry
- [ ] `vibectx log --json` emits the shared `schemaVersion` envelope with stable key order
- [ ] **A test pins that no document text appears in the log under any path**
- [ ] The cap is proven by a test that exceeds it; oldest evicted first
- [ ] `VIBECTX_NO_LOG=1` proven to suppress all writes
- [ ] A corrupt or unwritable log **never breaks a retrieval** (D-13)
- [ ] The README privacy line exists

- [ ] `security-architect` PASS on A16 (supply-chain control) and A20 (new persisted data)
- [ ] Gates 0–5 re-run green

**Rollback trigger:** if A11's per-tag resolution cannot be made reliable across ecosystems, **ship the marker without the resolution** — a response that says "I only have latest, you pinned 18.2" is most of the value and none of the risk. Do not ship silent substitution.

**Estimated effort:** 5–6 days (ASSUMED — A11 is the largest single item in the release)

---

## Phase 7 — Release

**No code. Verification, signatures, and the tag.**

### Gate 7 — the GA gate

**Automated**
- [ ] Gates 0–6 all re-run green on a **fresh clone**, not an incremental working tree
- [ ] `npm ci` clean · `npm run lint` clean · full suite green, final count recorded · `npm audit --omit=dev` **0 vulnerabilities**
  **AMENDED 2026-09-10 by the oversight seat, BEFORE Phase 7 starts. `npm audit` (all deps) CANNOT
  return 0 today and no work in this release will change that.** MEASURED at `839bfd7`: **2 moderate**
  — *Vitest: Path Traversal / Arbitrary File Read via `@vitest/mocker`* (GHSA-82fw-gwwq-j7x9). The fix
  is `vitest@5.0.0`, **a breaking change** that would put all 1202 tests through revalidation for a
  dev-tool advisory.
  **`vitest` is a `devDependency` and `files: ["dist"]`, so it never reaches a user.** Runtime
  dependencies are exactly `@modelcontextprotocol/sdk` and `zod`. **MEASURED: `npm audit --omit=dev`
  → `found 0 vulnerabilities`.** The amended criterion tests the property the original was protecting
  — nothing vulnerable reaches a user — and is achievable. **The dev-tool advisory is recorded, not
  waved away:** a vitest 5 upgrade is a real item, it just is not a release blocker.
- [ ] **Node version is part of this criterion.** `package.json` promises `engines: >=18`, but the
  suite's own toolchain does not honour that: MEASURED, `vitest@3.2.7` allows `^18.0.0`, while its
  `vite@7.3.6` dependency requires **`^20.19.0 || >=22.12.0`**. **On Node 18 a fresh clone installs
  but `npm test` will not run.** Either raise `engines`, or state the tested floor. Same finding as
  `CR-20260907-source-distribution.md` condition **F8**, still open.

**Human-only, and neither can be skipped**
- [ ] **PAR-653** — `vibectx doctor`, `vibectx warm`, and `node scripts/eval-retrieval.mjs` run **from the Mac**, where docs sites are reachable. Numbers pasted into the issue **as measured, whatever they say.**
- [ ] **PAR-704** — the live fastify check, from the Mac.

**Governance**
- [ ] **ELEVEN outstanding Change Record signatures** (~~thirteen~~ — **MEASURED 2026-09-10**), now local-only in `.vibectx-plan/change-records/`. Two need real judgment, not a rubber stamp:
  **Count, measured file by file:** 14 CR files — **10 carry an unfilled `Signed: ______`**, **1**
  (`CR-20260731-agent-repair.md`) uses an older template whose `## 4. Human sign-off` reads
  **"PENDING"**, and **3 are already signed** (`install-dev-team`, `add-research-integrity`,
  `par-714-url-host-policy`). **Note for whoever counts next: `CR-20260907-source-distribution.md`
  uses italic `*Signed:*`, not bold — a naive grep for `**Signed:**` undercounts by one.**
  - **PAR-658** — an ACCEPT-WITH-RISK on an unmet done-when, **or** the PAR-653 numbers that settle it
  - **PAR-652** — Tier-3 §2, §5 and §7. **Its §5 retro-log claim is known false**: the four AGENT-RETROS rows it attests to never reached the machine.
    **VALIDATED 2026-09-10 — this annotation is CORRECT, and the reason is worth recording.**
    `docs/AGENT-RETROS.md` **does not exist in the repository and appears nowhere in git history on
    any branch.** It is listed in `.vibectx-plan/scrub-paths.txt`, so it was **deliberately removed**
    in the source-distribution scrub.
    **The gates did NOT fabricate.** `code-reviewer` cites `docs/AGENT-RETROS.md:75` and
    `completion-auditor` reports a MEASURED honesty sweep finding "all four rows hold against the
    records they cite" — both read a file that genuinely existed when they ran. **What is true is
    that the CR now attests to content no reader can verify**, which is exactly what this annotation
    says. Oversight began building a gate-fabrication finding here and **one more check — the scrub
    list — dissolved it.** Recorded so nobody re-derives the wrong conclusion from the same evidence.
- [ ] Release Change Record — version bump, dependency and lockfile state, and what a user checking out the tag will build and run
  **CITATION CORRECTED 2026-09-10.** This read *"per `.vibectx-plan/change-record-policy.md` rule 1."*
  **That file is marked "RETIRED — HISTORICAL REFERENCE ONLY. DO NOT CITE THIS FILE AS AUTHORITY."**
  **The live rule, from that file's own retirement header:** a Change Record is expected **for a
  tagged release, and for any item touching URL trust, fetching, or cache integrity** — enforced by
  this plan's phase gates, not by GitHub (D-52). **No path is gated and no CI check requires a CR.**
  **AND THE HEADER NAMES AN ERROR THIS SEAT COMMITTED FOUR TIMES:** *"A gate that cites this file's
  gated list as evidence — '`src/config.ts` is absent from GATED, therefore no CR' — is reasoning
  from a control that does not exist. The conclusion may still be right; the justification is not."*
  Oversight cleared **A3, A4, A5 and A6** with exactly that reasoning ("no gated path touched, so no
  CR due"). **See the open question recorded against A3 and A4 below.**
- [ ] **OPEN — A3 and A4 may owe Change Records. Tom's call, not oversight's.** Under the live rule,
  **cache integrity** triggers a CR. **A4 (PAR-717)** rewrote `src/cache.ts`'s `.meta.json` validator;
  **A3 (PAR-716)** added `dropFollowedPageCache`, a **filesystem-delete primitive**, to the same file
  and changed `src/search-index.ts`. **Both are cache integrity on any reading.** A5 and A6 touched
  neither cache nor URL trust nor fetching, so their conclusion stands even though the justification
  was wrong. **A1 correctly has one** (`CR-20260909-par-714-url-host-policy.md`).
  **If A3 and A4 owe CRs, the outstanding count is 13, not 11.**
- [ ] `package.json` **0.1.3 → 0.2.0**, riding in the release PR with the release Change Record

**The ship gate — on a machine that has never run VibeCTX**
```
git clone git@github.com:BlackRaptorAI/VibeCTX.git
cd VibeCTX && npm ci && npm run build
claude mcp add vibectx -- node /absolute/path/to/VibeCTX/dist/index.js
cd ~/some-nextjs-supabase-project && vibectx warm
```
> **SHIP-GATE DEFECT — this sequence FAILS as written. Found 2026-09-10, before Phase 7 started.**
> **`npm ci` does not put a package's own `bin` on `PATH`.** `package.json` declares
> `bin: { vibectx: "dist/index.js" }`, but that only links on `npm install -g` / `npm link`, or into
> `node_modules/.bin` when the package is a *dependency* of something else. In a fresh clone it is
> neither. **MEASURED three ways on a machine with no prior VibeCTX install: `which vibectx` → not
> found; `node_modules/.bin/` → no `vibectx`; global bin dir → not linked.** So the final line
> `cd ~/some-nextjs-supabase-project && vibectx warm` **exits `command not found`** — in a different
> directory, `npx` will not rescue it either.
> **A linking step is missing.** Add `npm link` (or `npm i -g .`) after `npm run build`, and say what
> it needs — on a stock Node install the global prefix is root-owned.
> **THIS WAS ALREADY KNOWN AND DID NOT REACH THE PLAN.** `CR-20260907-source-distribution.md`
> carries it as an open gate condition, **F6**: *"`npm link` is given unqualified; on a stock Node
> install the global prefix is root-owned and the README omits that step."* **That CR is dated
> 2026-09-07; Gate 7 was written 2026-09-08 and repeats the omission.** The failure here is not the
> missing line — it is that a gate found it, wrote it down, and the plan was authored past it.
> **Whoever writes Phase 7 should read the open conditions on the 11 unsigned CRs first.**
- [ ] Go **offline**. Real questions return correct sections from cache.
- [ ] `vibectx doctor` reports every configured library as full-text or readme with a passing topic query — **and that verdict is visible to the model** (A19)

**Then, and only then**
- [ ] Tom pushes, merges, and tags **`v0.2.0`**

**Estimated effort:** 1 day of work, plus however long the two Mac-side verifications take

---

## Schedule — and an honest word about it

| Phase | Effort (ASSUMED) | Cumulative |
|---|---|---|
| 0 — Preconditions | 0.5 d | 0.5 d |
| 1 — Safety net | 1 d | 1.5 d |
| 2 — Stop the bleeding | 1.5 d | 3 d |
| 3 — Store integrity | 1.5 d | 4.5 d |
| 4 — Work and budget | 2 d | 6.5 d |
| 5 — Structure | 2.5 d | 9 d |
| 6 — The five problems | 5–6 d | 14–15 d |
| 7 — Release | 1 d + verification | 15–16 d |

**That is ~16 focused working days, and it is the optimistic read.** Two things will stretch it:

**The gate rounds.** This project's own record says an item takes two to five producer rounds. PAR-656 took five. PAR-659 took four, with **three FAILs in round one**. Sixteen items at three rounds average is not sixteen days of work — the rework is where the time goes, and it is also where the quality comes from.

**Capacity.** One founder, also carrying the Paragon platform.

**Realistic window: five to seven calendar weeks**, putting GA in **mid-to-late October 2026**.

**RESOLVED 2026-09-10 — the date was moved. Tom's decision; recorded here, in the Linear project
field, and in a dated project status update (health: at risk).** The project target date is now
**2026-10-31**, matching the 0.2.0 milestone, which had said so since 2026-09-08. **The two were
disagreeing and the earlier date was the one nobody believed** — this section already said it could
not hold.

**MEASURED at the time of the move:** 7 of 16 items landed (A1, A2, A3, A4, A5, A6, A10); Phases 0–4
closed; `main` @ `839bfd7`, 1202 tests in 36 files. Remaining: 9 items across Phases 5–7, plus
PAR-749, 11 Change Record signatures, and the two human-only Mac verifications.

**The two things that stretched it, named rather than absorbed.** (1) **Gate rounds ran higher than
this plan assumed** — it budgeted two to five per item; **A3 took nine and A6 took nine.** Not waste:
those rounds found a symlinked-root delete escape, a durability bug, a provenance bypass and four
consecutive overclaimed guarantees. The schedule simply was not built for it. (2) **Scope grew
through discovery** — six items landing produced **eight new issues**, two of them Urgent correctness
defects. **Finding them is the process working; not budgeting for them was this estimate's error.**

**The fallback below is unchanged and still stands.**

~~**The Linear project target date is still 2026-09-30.**~~ That date cannot hold — it is three weeks away for sixteen items plus two human verifications. I set the 0.2.0 milestone to 2026-10-31, which is defensible against the optimistic estimate but tight against the realistic one. **That is a commitment to move, and it is yours to move.** The honest options are: extend the date, or cut Phase 5 (structure) and Phase 6's A19/A20 into a 0.2.1 — those five items are the only ones a user would not immediately miss.

---

## What this plan deliberately does not do

- **It does not front-load the features.** A11 and A16 are the differentiators, and they come sixth. Building them on unbounded input, an unvalidated cache and a budget that miscounts would mean shipping the interesting work on a foundation the audit already flagged.
- **It does not treat refactoring as free.** Phase 5's gate is behaviour identity, with an explicit rule that a test needing to change is a defect.
- **It does not let a phase pass on a promise.** Every criterion above has a command behind it, and the evidence goes in the record.
