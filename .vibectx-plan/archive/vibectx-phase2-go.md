> # RETIRED — DO NOT EXECUTE. 2026-09-10.
> **The VibeCTX build loop is retired.** This is a dispatch card for a process that is no longer in
> use. Do not start a build session from it, do not follow its stop conditions, do not bundle against
> it. Kept as a historical record of how items A1–A6 and A10 were built.
> **Current state lives in git and Linear, not here:** `main` @ `839bfd7`, 1202 tests across 36 files,
> CI green on Node 22, 7 of 16 items landed. Open work is tracked in Linear under PAR-515.

# VibeCTX — Phase 2 go card · A1 (PAR-714) and A2 (PAR-715)

**Written 2026-09-09 by the oversight seat, after Phase 1 closed.** This card is authoritative for
Phase 2. Read it before anything else, then §3's reading order.

---

## 0. Stop conditions — check these first

- **UPDATED 2026-09-09: A1 (PAR-714) IS LANDED. `git -C <repo> rev-parse HEAD` on `main` must be
  `2672c81`.** If it is `2e691d1` or `c9cc77e`, something is behind — **STOP and report.**
- **A1 is DONE. Start at A2 (PAR-715).** §4's A1 section is kept for reference — read it to
  understand what shipped, do not rebuild it. A1 landed `2e691d1 → 2672c81`, six commits,
  `security-architect` PASS x2, CI green on Node 22.
- **The baseline is now 1100 passing across 33 files.** MEASURED 2026-09-09 at `2672c81` on the
  merged `main`, clean working tree. Any other count is stop-and-report.
- **`npm audit` reports 2 moderate** (`@vitest/mocker`, GHSA-82fw-gwwq-j7x9). This is dev-dependency
  drift present on unmodified `main`, not a regression. Do not try to fix it; do not treat it as a
  new finding. It is carried to Phase 7.

## 1. Role and hard rules

- **You produce and gate. You do not push.** Every push, merge and tag is Tom's, from his own
  terminal. Hand off by `git bundle create ../vibectx-handoff-bundles/PAR-714-a1-<slug>.bundle
  main..build/<branch>`. If you discover you *can* push, report it and do not use it.
- **One item at a time.** A1 completely, report through Tom, then A2. Sessions do not talk to each
  other; Tom relays in both directions.
- **D-55.** Never pipe a gate run through `tail`, `head` or `grep` before its result is known.
  Redirect in full to a file and read the summary from the file. Any failure is captured with its
  test name and assertion text before anything proceeds.
- **Honesty over completion.** An unmet done-when is reported unmet, never restated to match what
  was built. Never state a measurement you did not take; every number carries MEASURED, ASSUMED or
  CITED.
- **Do not create Linear issues.** Do not touch `.github/` or `package.json` without written
  authorisation. `.vibectx-plan/` is scaffolding — never commit it, never let it drive a code edit.

## 2. Rules added by A10 — these cost five rounds, do not rediscover them

**2.1 Do not widen a threshold to survive an escalating load test.** Under enough CPU
oversubscription every wall-clock assertion fails, so "survives the reviewer's load test" is not a
terminating condition — the reviewer can always turn the load up. A10 went ratio `<6` → absolute →
ratio `<10` across three rounds this way. The exit condition is **determinism**, or a measured
margin **at a stated load level**, not an ever-looser bound. Where a timing assertion is genuinely
needed, diagnose the root cause first — A10's real fix was scaling both corpora 4x, found by
diagnosis, not by guessing at bounds.

**2.2 Scope every gate dispatch.** A10's round-4 `code-reviewer` ran unscoped for 3h11m. Round 5,
scoped to the two open findings, returned quickly and still found something real. Hand each gate the
diff plus the specific conditions to verify, and carry the previous round's verdict so it reviews
the delta rather than re-deriving everything.

**2.3 NEVER emit a verdict block in your own output, and NEVER set `BR_VERDICT_HOOK=off`.** A verdict
emitted by the orchestrator is indistinguishable in the transcript from one it invented, which
destroys the provenance of every gate in the session. If the Stop hook wedges — it can demand a
verdict from `qa-test-engineer`, which is a producer and cannot honestly give one — **start a fresh
session.** A10 did both of these; it is a named Core defect and a disclosed gap in the Phase 1
record. Do not repeat it.

**2.5 Strip AI-attribution trailers before bundling.** Remove `Co-Authored-By: Claude …` and
`Claude-Session: …` from every commit message on your branch **before** you create the bundle and
before any gate reviews it — not afterwards, because rewriting a message after a gate has signed
changes the SHA and the artifact that landed is then one no gate saw. A10's seven commits carried
both and were merged as-is for exactly that reason; this repository is distributed as source and was
scrubbed on 2026-09-08 to remove agent apparatus from its history. Core's `clean-output` skill covers
this. MEASURED: 2 of the 174 commits on `main` before A10 carried these trailers.

**2.4 Seat names, 2.1.0.** `backend-engineer`, `qa-test-engineer` and `data-engineer` are
**PRODUCERS with edit tools**. The gates are `code-reviewer`, `test-auditor`, `schema-reviewer`,
`security-architect`, `completion-auditor`. Any plan text routing a gate to `qa-test-engineer` or
`data-engineer` is stale — a seat that can edit what it judges is not a gate.

## 3. Reading order — all in `.vibectx-plan/`

1. `vibectx-build-loop-resume.md` — **§0 status, §9 gate log including the Phase 1 oversight record.**
2. `VibeCTX-020-phased-build-plan.md` — **Phase 2 and Gate 2.** Note Gate 1 carries an amendment
   dated 2026-09-09.
3. `VibeCTX-plan-revision-2026-09-08.md` — **§A1, §A2, §A14.**
4. `VibeCTX-scope-decision-2026-09-08.md` — scope, and the claims the product may not make.
5. `VibeCTX-audit-2026-09-08.md` — **§4.1 and §4.2**, the evidence behind A1 and A2.
6. `vibectx-build-loop-state.md` — decisions D-01–D-55.

## 4. The work

**A1 (PAR-714) first. It is the only live security defect in the repository.**

`config.ts:326-333` validates a library entry's `urls` with `isHttpsUrl` — protocol only. A committed
`vibectx.config.json` naming `169.254.169.254` or `localhost:8443` is fetched by `startAutowarm`
(`server.ts:195`) at server start with no user action, and the body reaches `list_libraries`,
`get_docs` and `search` output.

- **Approach is SETTLED (D-49, A14 folded in):** export `validateLibraryUrl` from
  `src/link-policy.ts`; `config.ts` calls it. Do **not** re-implement a subset in `config.ts`, and do
  **not** add `src/config.ts` to any gated list — that list no longer exists.
- Add a per-entry `allowInternalHosts?: boolean` to `EntrySchema`, defaulting false. **Records D-47.**
- Add a line to `src/link-policy.ts`'s header comment stating it is the sole owner of the URL trust
  decision. **Records D-49.**
- **Files:** `src/link-policy.ts`, `src/config.ts`, `test/config.test.ts`. Mirror the existing
  `allowedHosts` test at `test/registry.test.ts:517`.
- **Change Record REQUIRED.** Written locally to `.vibectx-plan/change-records/`. Use
  **`.vibectx-plan/change-record-template.md`** — the live one, copied from Core 2.1.0. The file
  named `change-record-template.RETIRED-pre-2.0.0.md` beside it **will fail the validator**. This is
  the first Change Record in this project under the 2.0.0 schema: integer `confidence` 0–10,
  `standards` required, `evidence` a string, no `N/A` verdict.
- **The four retired governance files** (`change-record-policy.md`, `gate-enforcement-map.md`,
  `branch-protection-checklist.md`, the retired template) describe a CI gate, a `GATED` array and a
  validator that no longer exist. **Do not cite them as authority.** A gate did exactly that on
  2026-09-08 and reached a right answer by a dead route.

**A2 (PAR-715) second.** `z.number().int().positive().max(200_000)` on `get_docs`, on `search`, and
at the CLI `--max-tokens` parse. Executed evidence: `get_docs` currently accepts `Infinity` (from
`JSON.parse('1e400')`), `1e9`, `-5`, `0` and `3.7`; `search` accepts `1e9`. **Both tools, not one.**
Files: `src/server.ts`, `src/cli.ts`, `test/server.test.ts`, `test/cli.test.ts`. No Change Record.

## 5. Gate routing — corrected for 2.1.0

| Item | Gates |
|---|---|
| **A1** | **`security-architect` — BLOCKING**, plus `code-reviewer` and `test-auditor` |
| **A2** | `code-reviewer` and `test-auditor` |
| both | `completion-auditor` last |

The plan revision's A1 line says `qa-test-engineer`; that is stale — see §2.4. `security-architect`
and `schema-reviewer` have never been dispatched in this project; A1 is the first exercise of
`security-architect` and closes part of Phase 0 criterion 5.

**`security-architect` must return PASS**, not CONCERNS-with-conditions-open. That is Gate 2's
explicit wording.

## 6. Gate 2 — the criteria you are building to

The A1 half must **prove absence of request**, following the pattern already proven at
`test/fetcher.test.ts:425-562`: run a real `http.Server` on 127.0.0.1 and assert `listenerHits === []`.
A test that only checks the rejection message does not prove nothing was fetched.

- Config `urls` naming each of: a loopback address · an IPv4 literal · an IPv6 literal · a `.local`
  host · a `.internal` host · a single-label host · `localhost:8443` → **each rejected**, D-22 error
  grammar, named in the `list_libraries` header
- **Listener hit count is zero for every one of those seven cases**
- The same entry with `allowInternalHosts: true` → loads and fetches
- **Enforcement liveness:** a test proves `validateLibraryUrl` fires on the `startAutowarm` path, not
  only on the direct config-load path. That is the path the exploit uses. Load the
  `enforcement-liveness` skill before certifying this.
- The `maxTokens` matrix — `Infinity`, `1000000000`, `-5`, `0`, `3.7` → **all rejected** on
  `get_docs`, on `search`, and at the CLI; `4000` accepted on all three
- A1's Change Record written, carrying a `security-architect` verdict, stating D-47 and D-49
- `security-architect` verdict is **PASS**
- Gates 0–1 re-run green, count recorded

**Rollback trigger:** if `allowInternalHosts` cannot be made to work without widening the default,
ship the rejection alone and defer the opt-in to A13. **The safe default is not negotiable; the
opt-in is.**

## 7. When you are done

Bundle each item separately. Report through Tom with: the branch and final SHA, the per-commit
`--name-status` scope check, the full suite count, each gate's verdict, and every done-when marked
met or unmet. **Paste the gate output; do not summarise it** — Phase 1's chat summary contained a
false statement about the diff that the gate log did not.

**Do not start Phase 3.** Do not pick up another item.
