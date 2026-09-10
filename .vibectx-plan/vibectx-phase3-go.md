> # RETIRED — DO NOT EXECUTE. 2026-09-10.
> **The VibeCTX build loop is retired.** This is a dispatch card for a process that is no longer in
> use. Do not start a build session from it, do not follow its stop conditions, do not bundle against
> it. Kept as a historical record of how items A1–A6 and A10 were built.
> **Current state lives in git and Linear, not here:** `main` @ `839bfd7`, 1202 tests across 36 files,
> CI green on Node 22, 7 of 16 items landed. Open work is tracked in Linear under PAR-515.

# VibeCTX — Phase 3 go card · A4 (PAR-717) and A5 (PAR-718)

**Written 2026-09-09 by the oversight seat, after Phase 2 closed.** Authoritative for Phase 3.
Read it in full before anything else, then §3's reading order.

---

## 0. Stop conditions — check these first

- **`git rev-parse HEAD` on `main` must be `262909a`.** Anything older means Phase 2 is not fully
  landed — **STOP and report.**
- **Baseline: 1103 passing across 33 files.** MEASURED 2026-09-09 at `262909a`, post-merge, CI green
  on Node 22. Any other count on a fresh clone is stop-and-report.
- **`npm audit` reports 2 moderate** (`@vitest/mocker`, GHSA-82fw-gwwq-j7x9) — dev-dependency drift
  present on unmodified `main`, not a regression. Do not fix it, do not re-report it. Carried to
  Phase 7.
- **Phases 0, 1 and 2 are CLOSED.** A10, A1 and A2 are landed. Do not rebuild them.

## 1. Role and hard rules

- **You produce and gate. You do not push.** Every push, merge and tag is Tom's, from his own
  terminal. Hand off by `git bundle create ../vibectx-handoff-bundles/PAR-<n>-<slug>.bundle
  main..build/<branch>`. If you discover you *can* push, report it and do not use it.
- **One item at a time.** A4 completely, report through Tom, then A5. Sessions never talk to each
  other; Tom relays both ways.
- **D-55.** Never pipe a gate run through `tail`, `head` or `grep` before its result is known.
  Redirect in full to a file and read the summary from the file. Capture any failure's test name and
  assertion text before anything else proceeds.
- **Honesty over completion.** An unmet done-when is reported unmet, never restated to match what
  was built. Every number carries MEASURED, ASSUMED or CITED.
- **Do not create Linear issues. Do not touch `.github/`, `package.json` or `scripts/`** without
  written authorisation — the producer file set is `src/`, `test/`, `docs/`, `README.md`.
  `.vibectx-plan/` is scaffolding: never commit it, never let it drive a code edit.

## 2. Rules carried from A10, A1 and A2 — these were paid for, do not rediscover them

**2.1 Do not widen a threshold to survive an escalating load test.** Under enough CPU
oversubscription every wall-clock assertion fails, so "survives the reviewer's load test" is not a
terminating condition. The exit condition is determinism, or a measured margin **at a stated load
level**. Diagnose the root cause before touching a bound. A10 spent three rounds learning this.

**2.2 Scope every gate dispatch.** A10's round-4 `code-reviewer` ran unscoped for 3h11m; round 5,
scoped to two named findings, returned promptly and still found something real. Hand each gate the
diff plus the specific conditions to verify, and carry the previous round's verdict so it reviews
the delta rather than re-deriving everything.

**2.3 NEVER AUTHOR a verdict, and NEVER set `BR_VERDICT_HOOK=off`.** Pasting a verdict a gate
actually returned is *required* — see §7. What is forbidden is **composing one yourself**: for a
gate that did not run, or to satisfy a Stop hook demanding a verdict the run never produced. A
verdict the orchestrator wrote is indistinguishable from an invented one and destroys the provenance
of every gate in the session. Test: **did a gate dispatch return this text?** If no, it must not
appear. If the Stop hook wedges — it can demand a verdict from `qa-test-engineer`,
a producer that cannot honestly give one — **start a fresh session.** A10 did both of these; A1 hit
the same trap, refused both, and stopped. Follow A1.

**2.4 Seat names, 2.1.0.** `backend-engineer`, `qa-test-engineer` and `data-engineer` are
**PRODUCERS with edit tools**. The gates are `code-reviewer`, `test-auditor`, `schema-reviewer`,
`security-architect`, `completion-auditor`. Any plan text routing a gate to a producer is stale.

**2.5 Strip AI-attribution trailers before bundling.** Remove `Co-Authored-By: Claude …` and
`Claude-Session: …` from every commit **before** the bundle and before any gate reviews it — never
after, because rewriting a message post-verdict changes the SHA and what lands is then something no
gate saw. A10 merged with them; A1 and A2 were clean.

**2.6 A containment argument must be recorded with its falsifier.** A2 bounds `maxTokens` at three
edges and deliberately leaves `get-docs.ts:139` and `search.ts:419` unclamped, on the argument that
the two MCP schemas and the CLI parse are the only externally reachable entry points. That argument
is sound today and **silently false** the day someone adds an `exports` map. It is documented at
`src/search.ts:104-118` with `code-reviewer`'s falsifier attached. **If you leave a path unguarded on
a containment argument, write the claim and the thing that would falsify it — in the source, and in
the Change Record if the item has one.**

## 3. Reading order — all in `.vibectx-plan/`

1. `vibectx-build-loop-resume.md` — **§0 status and §9 gate log**, including Phases 1 and 2 and the
   PAR-653 record.
2. `VibeCTX-020-phased-build-plan.md` — **Phase 3 and Gate 3.** Gate 1 carries a dated amendment.
3. `VibeCTX-plan-revision-2026-09-08.md` — **§A4 and §A5.**
4. `VibeCTX-audit-2026-09-08.md` — **§4.5 (A4) and §4.4 (A5)**, the evidence.
5. `vibectx-build-loop-state.md` — decisions **D-13** (best-effort persistence) and D-01–D-55.

## 4. The work

**A4 (PAR-717) first — `meta.json` gets a validator like every other store.**

`cache.ts:203` and `:223` both do `JSON.parse(readFileSync(metaPath, "utf8")) as CacheMeta` — no
try/catch, no shape check. Every other persisted store re-validates every field because the cache
directory is a trust boundary (`resolved-store.ts:14`, `project-store.ts:18`, `search-index.ts:49`).
A corrupt `.meta.json` throws out of `list-libraries.ts:37` and `refresh.ts:51`, both unguarded and
untested, taking `list_libraries` down entirely. Worse, `meta.fetchedAt` renders **unvalidated** in
the `list_libraries` footer and in every `get_docs` `STALE:` note — while `project-store.ts:194`
validates `warmedAt` against a strict ISO-8601 regex *explicitly because* that string lands verbatim
in the same footer.

- **Fix:** a `toCacheMeta()` validator mirroring `toWarmRow` — per-field validation, the shared
  `ISO_INSTANT` regex, `cleanText` on anything rendered. `readCache` returns `undefined` on a bad
  meta rather than throwing. **This is D-13 applied to the one store that does not follow it.**
- **Files:** `src/cache.ts`, plus tests. No Change Record — `src/cache.ts` is deliberately not
  hard-gated (D-44).

**A5 (PAR-718) second — `resolvePackage` honours its own contract.**

`resolve.ts:336` documents "Never throws for bad input or bad network." `resolve.ts:434` calls
`saveResolvedEntry` unguarded, and `resolved-store.ts:114,127` throw on EACCES, ENOSPC and EROFS — so
a read-only `$HOME` or a full disk turns `get_docs("<unknown-package>")` into an exception through
`get-docs.ts:91`. Same for the two CLI paths that throw where the MCP path catches: `cli.ts:276` and
`runSearchCli` at `cli.ts:314`. Because `index.ts:17` uses a top-level `await`, a throw there is an
unhandled rejection with a stack trace, not a clean exit 2.

- **Fix:** wrap it; set `saved: false` and `saveNote`, both already on the outcome type
  (`resolve.ts:91`). Give the two CLI paths the same treatment.
- **Files:** `src/resolve.ts`, `src/cli.ts`, plus tests. No Change Record.

## 5. Gate routing — 2.1.0 names

| Item | Gates |
|---|---|
| **A4** | `security-architect` (by convention — `src/cache.ts` is integrity-bearing), `code-reviewer`, `test-auditor` |
| **A5** | `code-reviewer`, `test-auditor` |
| both | `completion-auditor` last |

`schema-reviewer` has still never been dispatched in this project. If either item is judged to
change a persisted shape, route it there and say so — that closes the last open name in Phase 0
criterion 5.

## 6. Gate 3 — the criteria you are building to

**Four corruption classes x four consumers = sixteen cases.** Each must leave the tool answering
correctly with the entry reported **uncached** — never crashing, never silently wrong.

| | `list_libraries` | `refresh` | `doctor` | `get_docs` |
|---|---|---|---|---|
| truncated `.meta.json` | | | | |
| invalid JSON | | | | |
| wrong shape | | | | |
| hostile `fetchedAt` | | | | |

Plus:

- With the cache directory **read-only**: `get_docs` on an unknown package name returns the resolved
  document **plus** a `resolution not saved: <reason>` note, **exit 0**
- With the cache directory read-only: `vibectx search` and `vibectx resolve` report **one line, no
  stack trace** — verified **through the Phase 1 spawn harness**, so an unhandled rejection cannot
  hide behind an in-process test.
  **AMENDED 2026-09-09:** this originally demanded **exit `2`**. That was oversight's error —
  `README.md` documents `2` as a *usage or config error*, and a read-only directory is neither. The
  guards below the CLI catch it first and report differentiated real outcomes (`0`/`1`). See the
  phased build plan's Gate 3 for the full annotation.
- `grep -c "as CacheMeta" src/cache.ts` returns **0**
- Gates 0–2 re-run green, count recorded

**Note the read-only-directory cases need a real read-only directory, not a mocked failure.** A5's
whole point is behaviour under EACCES/EROFS; a stubbed throw proves the handler exists, not that the
real path reaches it. A1 set the standard here — its enforcement-liveness tests bind real listeners
rather than asserting on a message.

**Rollback trigger:** none. Both items are additive guards. If either cannot be completed it does not
block Phase 4 — but it is **recorded as carried, not silently dropped.**

## 7. When you are done

Bundle each item separately. Report through Tom with: branch and final SHA, the per-commit
`--name-status` scope check, the full suite count, each gate's verdict **pasted verbatim, not
summarised**, and every done-when marked met or unmet.

Phase 1's chat summary contained a false statement about its own diff while the gate log was
accurate — **paste the output, do not describe it.**

**Do not start Phase 4.** Do not pick up another item.
