> # THE BUILD LOOP IS RETIRED — 2026-09-10.
> **This handoff instructs a session to take over the oversight seat of a process that no longer runs.**
> The relay of build sessions, go cards and handoff bundles is retired for this project. **Do not take
> the seat from this card and do not follow its reading order into the build-loop documents** — they
> are marked historical.
> **Its facts remain accurate for the period it covers.** Current state: `main` @ `839bfd7`, 1202 tests
> across 36 files, CI green on Node 22, 7 of 16 items landed. **Open work is tracked in Linear under
> PAR-515**, which is the authority from here.

# VibeCTX — oversight session handoff

**Written 2026-09-08, 22:00. Read this first, then `vibectx-build-loop-resume.md` §0.**

You are taking over the **oversight** seat for VibeCTX 0.2.0. This card exists because the previous
oversight session ran long; nothing here is inferred from memory — every fact was executed or read
at `c9cc77e` on 2026-09-08.

---

## 1. Your role, and the one rule about it

**You are oversight. You do not write product code.** You read state, judge what the build session
returns, dispatch gates, assemble Change Records, prove phase gates, and record evidence.

**There is no loop.** You and the build session never talk to each other. **Tom relays in both
directions, one step at a time.** He has asked for one step per message — honour that. Give a single
command block, wait for its output, then give the next. Do not stack five steps and hope.

**Every push is Tom's.** No agent session pushes to `BlackRaptorAI/VibeCTX`. That is the
human-in-the-loop control, not a statement about credentials (**D-54**). If you discover you *can*
push, report it and do not use it — unexpected privilege in an agent-reachable environment is a
trust-boundary finding, not permission.

## 2. Where things stand

```
main          c9cc77eee7a7b1b2a026569d8e705ce49dd04b0a  ==  origin/main
              174 commits · 75 tracked · lint clean · build clean · npm audit 0
baseline      1059 tests across 32 files (9 of 10 clean-clone runs — see F-1)
branches      main only · handoff folder empty · nothing outstanding
packs         blackraptor-core / -engineering / -council / -hardware / -marketing
              all 2.1.0, user scope, enabled. Nothing vendored into the repo.
context       CLAUDE.md · BUSINESS-CONTEXT.md · USER-PREFS.md at the repo root,
              provenance-marked, all gitignored
Phase 0       CLOSED (gate log §9), with finding F-1 routed to A10
Phase 1       A10 / PAR-723 — IN FLIGHT in a separate build session. NOTHING HAS LANDED.
```

**The next event is the build session reporting A10 through Tom.** Until then there is nothing to
do. Do not start Phase 2. Do not pick up another item.

## 3. Reading order

All of these are on disk in `.vibectx-plan/` at the repo root. A CLI session cannot reach the
claude.ai project, so the folder is the source of truth.

1. `vibectx-build-loop-resume.md` — **§0 status, §9 gate log.** Current state and Phase 0's evidence.
2. `VibeCTX-020-phased-build-plan.md` — the operating document. Eight phases, blocking gates.
3. `VibeCTX-plan-revision-2026-09-08.md` — per-item detail. **§A10 is the live item.**
4. `VibeCTX-scope-decision-2026-09-08.md` — scope, and the claims the product may not make.
5. `vibectx-build-loop-state.md` — decision archive, D-01–D-55.
6. `VibeCTX-audit-2026-09-08.md` — the evidence behind A1–A10, file:line, verified at `a0852f2`
   (source identical to `c9cc77e` apart from `.gitignore` and one empty commit).
7. `VibeCTX-context-layer-design-2026-09-08.md` — research. **§1.4 lists claims that do not survive
   scrutiny — read before writing any number into a Change Record.**

`.vibectx-plan/` is gitignored scaffolding. Never commit it, never ship it, never change product
code to match it.

## 4. When A10 comes back — what to check, and what will slip past you

Judge it against §A10's done-when. Three things are easy to miss:

**F-1 is the one that will slip.** A clean-clone run at `c9cc77e` reported `1 failed | 1058 passed`
and never reproduced in nine further runs. Its identity was lost to a `tail -5`. **A green suite is
not evidence that F-1 was addressed.** A10 does not close unless F-1 was reproduced and fixed, or
the six timing assertions were made deterministic and **20 consecutive clean-clone runs** pass. If
the report is silent on F-1, that is an unmet done-when — report it unmet, do not infer.

**The `vitest.config.ts` decision is Tom's, not the producer's.** There is no vitest config in this
repo, so `testTimeout` defaults to 5000 ms and a spawned-process test will exceed it. Creating one
adds a 76th tracked file to a repository deliberately cut to 75. If the build session created it
without asking, that is a scope breach to raise — not a detail to wave through.

**The six timing assertions, complete sweep at `c9cc77e`:**

| Location | Assertion | Shape |
|---|---|---|
| `test/retrieval.test.ts:356` | `bigMs < 5000` | absolute, generous |
| `test/retrieval.test.ts:366` | `largeMs / smallMs < 6` | **ratio — leading F-1 candidate** |
| `test/retrieval.test.ts:935` | `elapsed < 100` | absolute, tight |
| `test/retrieval.test.ts:953` | `extractMs < 100` | absolute, tight |
| `test/retrieval.test.ts:954` | `indexMs < 100` | absolute, tight |
| `test/search-perf.test.ts:153` | `warmMs < D37_BUDGET_MS` | absolute |

`:366` is the leading candidate because `smallMs` is floored by `Math.max(…, 1)`. **This is a
hypothesis, not a diagnosis** — no run has been captured failing on it. Do not let it be recorded as
the cause without a captured failure. And note that swapping a ratio for a *tight* absolute ceiling
trades one flaky shape for another.

## 5. Gates and records

**Seats, current names.** Producers: `backend-engineer`, `qa-test-engineer`, `data-engineer`.
Gates: `code-reviewer`, `test-auditor` (test/coverage — moved from `qa-test-engineer` in 2.0.0),
`schema-reviewer` (schema — moved from `data-engineer`), `security-architect`,
`completion-auditor` last. **Dispatching `qa-test-engineer` or `data-engineer` as a gate gets you a
seat that can edit what it judges.**

Only `code-reviewer` has been exercised so far. The rest resolve as work reaches them — that is
Phase 0 criterion 5, recorded PARTIAL on purpose.

**Verdicts are machine-checked in-session.** Core 2.1.0 ships a `Stop` hook that validates every
verdict block on the live path; it has been observed firing and refusing a turn. Kill switch
`BR_VERDICT_HOOK=off` — do not use it without recording why.

**Schema (changed in pack 2.0.0):** `confidence` is an integer 0–10; `standards` is required;
`evidence` is a string, not an array; `N/A` was removed — a gate that does not apply emits no block
and the Change Record row carries the N/A.

**Use `.vibectx-plan/change-record-template.md`** — copied verbatim from Core 2.1.0's
`change-record` skill. `change-record-template.RETIRED-pre-2.0.0.md` beside it is the old shape and
will fail. The 13 existing Change Records in `.vibectx-plan/change-records/` all predate the schema
and must be re-emitted, not hand-patched (**D-53**). That is a Phase 7 release-gate item — do not
let it arrive as a surprise at GA.

**Four retired governance files** (`change-record-policy.md`, `gate-enforcement-map.md`,
`branch-protection-checklist.md`, the retired template) each open with a RETIRED banner. They
describe a CI gate, a `GATED` array and a validator that no longer exist. **Do not cite them as
authority** — a gate did exactly that on 2026-09-08 and reached a right answer by a dead route.

## 6. Landing work

Build session, in its clone:

```
git bundle create ../vibectx-handoff-bundles/<ISSUE>-<slug>.bundle main..build/<id>-<slug>
git log --stat main..build/<id>-<slug>
```

Tom, from his own terminal:

```
git bundle verify <bundle>
git fetch <bundle> build/<id>-<slug>:build/<id>-<slug>
git log --stat main..build/<id>-<slug>
npx vitest run
git merge --ff-only build/<id>-<slug>
git push origin main
git branch -d build/<id>-<slug>
rm <bundle>
```

`../vibectx-handoff-bundles/` is a **sibling of the repo**, not inside it — no gitignore dependence,
and a repo cleanup cannot sweep it. Tom clears spent bundles; an agent shell on the Mac cannot
delete. Proven end to end on 2026-09-08 (**D-54**).

## 7. Environment — measured, do not re-derive

- **The repo is private. Clone over SSH** (`git@github.com:BlackRaptorAI/VibeCTX.git`). HTTPS
  prompts for credentials. The plan's HTTPS commands were corrected on 2026-09-08.
- **`node_modules/` is not on the volume by default** — `npm ci` first or vitest will not run.
- **The Mac mount cannot delete.** An agent shell there reads, writes and renames but cannot
  `unlink`. **`git status` run through that mount leaves a stale `.git/index.lock` that blocks Tom's
  next commit** — clear with `rm -f "<repo>/.git/index.lock"`. Read-only plumbing (`git rev-parse`,
  `git ls-files`, `git log`, `git for-each-ref`) does not take the lock. **Use those instead.**
- **Verify refs with `git for-each-ref`, never `git branch`.** A bare ref holding 19 commits
  survived a "no outstanding branches" check because `git branch -a` does not list one.
- **Tom's shell is zsh.** `#` is not a comment unless `setopt interactivecomments` is live (set
  2026-09-08, but a new terminal loses it). Do not paste inline `#` comments without confirming.
- **Docs sites are unreachable from a cloud clone**; only `raw.githubusercontent.com` resolves. Any
  claim about `llms.txt` coverage or ranking quality on real documentation is NOT VERIFIED from
  there. That is PAR-653, human-only, and it gates GA.

## 8. Decisions this session added

| ID | Decision |
|---|---|
| **D-52** | Agent packs are consumed as plugins from the `blackraptor` marketplace, never vendored. Verdict enforcement lives in the pack's `Stop` hook, not in VibeCTX's CI. Supersedes D-44. |
| **D-53** | Operating pack version is **2.1.0**. Verdicts follow the 2.0.0 schema; the 13 pre-existing Change Records are re-emitted, not patched. |
| **D-54** | Branch handoff by `git bundle` into `../vibectx-handoff-bundles/`; Tom lands. No agent pushes — a control, not a capability limit. |
| **D-55** | Never pipe a gate run through `tail`/`head`/`grep` before its result is known. Redirect in full, read the summary from the file. Any failure is captured with its identity before anything proceeds. |

## 9. Open items, in priority order

1. **A10 / PAR-723 — in flight.** Judge on return. F-1 is the criterion that will slip.
2. **`vitest.config.ts`** — Tom's decision if A10 needs it.
3. **`workforce-doctor` output** — never seen. Ask for it in A10's report.
4. **13 Change Records re-emitted** to the 2.0.0 schema — Phase 7 gate item, start early.
5. **Ten Linear issues still cite `79c270c`** in their bodies (PAR-654…707). The epic PAR-515 carries
   a BASELINE CHANGED banner; the rest were left rather than burn context. Sweep when convenient.
6. **GitHub object retention** — a force-push does not immediately GC unreachable objects; the
   scrubbed commits may remain reachable by direct SHA. **NOT VERIFIED** against GitHub's current
   documentation. Confirm before 0.2.0 ships; required if the repo is ever made public.
7. **Phase 0 criterion 5** — five of six seats still unexercised. They resolve as work reaches them.

## 10. Hard rules

- **Honesty over completion.** A done-when the numbers do not support is reported unmet, never
  restated to match what was built. PAR-658 is the precedent and is still open because of it.
- **Never state a measurement you did not take.** Every number carries `MEASURED`, `ASSUMED` or
  `CITED`.
- **Prefer executing a claim to reading one.** A2's scope was wrong until someone ran it.
- **Prove the control runs on the live path.** A test exercising a function directly does not prove
  the function is reached in production.
- **Claim discipline.** No README, marketing or Change Record text may say VibeCTX keeps an agent on
  task, prevents scope creep, prevents architectural drift, or stops hallucination in general. It
  prevents one evidenced kind — invented package names — and removes one cause of stale-context
  work. Scope decision §5 has the barred claims.
- **Scope is a hard boundary.** Memory, spec generation, architecture rule checking, symbol search,
  task tracking, a large project-rules payload — the answer is no. Every one has a strong incumbent,
  and the last was measured to make results worse.
- Do not create Linear issues without asking. PAR-714 through PAR-730 are already filed.
- Do not delete anything on the Mac. You cannot, and attempting it leaves stale git locks.

## 11. What went wrong on 2026-09-08, so it does not repeat

Four failures, all the same shape — **a confident claim from an incomplete look**:

1. A signed completion verdict attested to four `AGENT-RETROS.md` rows that never reached the
   machine. The file was gitignored; the filled version existed only in an ephemeral container.
2. `refs/bundle-main` held 19 commits, including the vendored agent pack, through a "no outstanding
   branches" check that used `git branch` instead of `git for-each-ref`.
3. A gate's PASS cited `change-record-policy.md`'s `GATED` list as evidence — a control deleted
   hours earlier. Right answer, dead route.
4. Oversight itself claimed A10 was misaimed and that `search-perf.test.ts` had no timing assertion.
   **Both false**, from a grep pattern too narrow to match `largeMs / smallMs`. Nothing caught it but
   continuing to look. Acting on it would have rescoped a correct item toward the wrong tests.

The vendored 2.0.0 pack duplicate is the common root of the first three: the repository's copy
drifted from the real pack while both claimed to be the same thing. It is gone from `HEAD` and from
history. **Do not re-create it in any form.**
