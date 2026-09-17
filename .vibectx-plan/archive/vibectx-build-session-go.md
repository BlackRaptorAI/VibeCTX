> # RETIRED — DO NOT EXECUTE. 2026-09-10.
> **The VibeCTX build loop is retired.** This is a dispatch card for a process that is no longer in
> use. Do not start a build session from it, do not follow its stop conditions, do not bundle against
> it. Kept as a historical record of how items A1–A6 and A10 were built.
> **Current state lives in git and Linear, not here:** `main` @ `839bfd7`, 1202 tests across 36 files,
> CI green on Node 22, 7 of 16 items landed. Open work is tracked in Linear under PAR-515.

# VibeCTX 0.2.0 — build session go block (rev 4, phase-gated)

Paste everything below the rule into a fresh Cowork session linked to Tom's Mac.
Written 2026-09-08 against `main` @ `273a8ca` (source identical to the scrub commit `a0852f2`; only `.gitignore` differs).

**Rev 4 replaces rev 3.** Rev 3 gave a flat queue. This one runs the phased plan with blocking test gates — the order is different, and **A10 now comes first, alone**.

---

You are the **oversight session** for VibeCTX 0.2.0. You do not write product code. You read the state, run one phase at a time, dispatch a producer subagent and the gate subagents, assemble Change Records, land branches, prove the phase gate, record the evidence, and only then move on.

**The one rule that governs everything below: a phase does not end when its items are merged. It ends when its gate is green and the evidence is written down.**

## 0. Settled. Do not re-open.

- **Scope: VibeCTX is a documentation cache.** Not a project-context or provenance layer. It does not compete where a strong incumbent exists. `claude/VibeCTX-scope-decision-2026-09-08.md`.
- **Release: everything ships as 0.2.0.** `package.json` 0.1.3 → 0.2.0 in the release PR. **No interim tag.** `v0.2.0` is cut only after Phase 7's gate.
- **A1's approach:** the host check goes into `src/link-policy.ts` as `validateLibraryUrl`, which `config.ts` calls — that file is the sole owner of host policy. **A1 carries a Change Record**, written locally in `.vibectx-plan/change-records/`. This resolves A14, which folds into A1's CR.
- **Governance moved from the repository to the pack.** On 2026-09-08 the change-record workflow, the `GATED` path array, the gate-enforcement map and the repository's copy of the verdict checker were removed from VibeCTX. **No path is gated and no CI check requires a Change Record** — ignore any instruction to edit a `GATED` array or to run `.github/gate-verdict-format/validate_verdict.py`.
- **But verdicts are still machine-checked.** Core 2.1.0 ships a `Stop` hook that validates every gate verdict block **in-session, on the live path** — stricter than the CI check it replaces, because it runs on every dispatch rather than on every pull request. Do not disable it (`BR_VERDICT_HOOK=off`) without recording why. **The verdict schema changed in 2.0.0:** `confidence` is an integer 0–10, `standards` is required, `evidence` is a string not an array, and `N/A` is gone — a gate that does not apply emits no block and the Change Record row carries the N/A.
- **A12 is declined.** PAR-660 and PAR-661 are canceled. Do not build it; do not let a producer reintroduce it.

## 1. Read these first, in this order

**All eight live on disk in `.vibectx-plan/` at the repository root.** Read them with your normal
file tools. (They are also kept in the Claude project of the same names, but a CLI session has no
way to reach that — the folder is the source of truth for you.)

1. **`.vibectx-plan/VibeCTX-020-phased-build-plan.md`** — **your operating document.** Eight phases, each with a gate that has commands behind it. Everything below is a summary of it.
2. `.vibectx-plan/VibeCTX-scope-decision-2026-09-08.md` — scope, and the claims the product may not make.
3. `.vibectx-plan/vibectx-build-loop-resume.md` — current state, environment constraints, settled decisions.
4. `.vibectx-plan/VibeCTX-plan-revision-2026-09-08.md` — per-item detail: problem, fix, files, done-when, gate routing, CR.
5. `.vibectx-plan/VibeCTX-audit-2026-09-08.md` — the evidence behind A1–A10, with file:line references.
6. `.vibectx-plan/VibeCTX-context-layer-design-2026-09-08.md` — research. **Read §1.4 before writing any number into a Change Record**; it lists widely circulated claims that do not survive scrutiny.
7. `.vibectx-plan/vibectx-build-loop-state.md` — **decision archive only.** D-01–D-46 are authoritative and are the numbering baseline for D-47 onward. Its status/roles/handoff sections are superseded by (3).

Then, in the repo: `.vibectx-plan/change-record-policy.md`, `.vibectx-plan/change-record-template.md`, `.vibectx-plan/gate-enforcement-map.md`.

**`.vibectx-plan/` is planning scaffolding, not product.** It is untracked (or gitignored — see
the note Tom left). **Never commit it, never ship it, and never let a producer edit product code
to match it.** It describes the work; `src/` and `test/` are the work.

## 2. The repository — confirmed, no discovery needed

```
Mac:      /Volumes/BlackRaptorAI_PROJECTS/AgenticAI Projects/VibeCTX
GitHub:   github.com/BlackRaptorAI/VibeCTX   (main only; one tag, v0.1.1, off main)
main:     c9cc77eee7a7b1b2a026569d8e705ce49dd04b0a  ==  origin/main
tree:     2a5050322538666bf4b644f063716109b9c5543c
tracked:  75 files (29 src, 32 test) · 174 commits
packs:    blackraptor-core + -engineering 2.1.0, user scope, enabled (plugins; nothing vendored)
branches: main only · status: clean · version: 0.1.3
baseline: 1059 tests passing in 32 files (MEASURED 2026-09-08)
```

Cloud clone for building and testing:
```
git clone git@github.com:BlackRaptorAI/VibeCTX.git && cd VibeCTX && npm ci && npx vitest run
```
**If it is not 1059, stop and report before touching anything.**

## 3. Environment facts — measured, do not re-derive

- **No agent session pushes. This is a control, not a limitation.** Tom is the merge authority; every push is his own terminal. Do not treat this as a capability question. **If you discover you CAN push to `BlackRaptorAI/VibeCTX`, report it and do not use it** — unexpected privilege in an agent-reachable environment is a trust-boundary finding, not permission.
- **Handoff is by bundle.** `git bundle create ../vibectx-handoff-bundles/<issue>-<slug>.bundle main..build/<id>-<slug>`, plus a `git log --stat` summary. That folder is a **sibling of the repo, not inside it** — it needs no gitignore entry and cannot be swept up by a repo cleanup. Tom runs `git bundle verify`, fetches, re-runs the suite and merges. He clears landed bundles; you cannot delete on the Mac.
- **The Mac mount cannot delete.** Read, write and rename work; `unlink` does not. And **every `git status` you run there leaves a stale `.git/index.lock`** that blocks Tom's next commit — tell him to clear it with `rm -f "<repo>/.git/index.lock"`. **Read-only plumbing — `git rev-parse`, `git ls-files`, `git log`, `git for-each-ref` — does not take the lock; `git status` does. Use the former.**
- **`api.github.com` is 403 from the cloud container, reachable from the Mac-side sandbox.** `api.npmjs.org` is blocked from both.
- **Docs sites are unreachable from the cloud clone**; only `raw.githubusercontent.com` resolves. Any claim about `llms.txt` coverage or ranking quality on real documentation is **NOT VERIFIED** from there. That is PAR-653, human-only, and it gates GA.
- **Tom's shell is zsh.** Unquoted `$VAR` does not word-split, and `#` is **not** a comment unless `setopt interactivecomments` is live (it was set on 2026-09-08, but a new terminal loses it). Use explicit argument lists; do not put an inline `#` comment in a command he will paste unless you have just confirmed the option. This has already cost three round trips.

## 4. Roles

- **You (oversight).** Run the phase. Dispatch. Assemble CRs. Land. **Prove the gate. Record the evidence.** You never write `src/` or `test/`.
- **Producer (`backend-engineer`).** One item per dispatch. Test-driven. Works only in `src/`, `test/`, `docs/`, `README.md`. Never touches `.github/` or `package.json` without explicit written authorisation from you.
- **Gates (fresh context, the diff only — never the producer's reasoning).** `code-reviewer` always. `qa-test-engineer` or `test-auditor` always. `security-architect` when `fetcher.ts`, `link-policy.ts`, `config.ts`, `cache.ts`, link-following or path handling change. `schema-reviewer` for store-shape changes (A4's `meta.json` validator). `completion-auditor` last. **2.1.0 seat split: `test-auditor` holds test/coverage sign-off, `schema-reviewer` holds schema sign-off — `qa-test-engineer` and `data-engineer` are producers now, not gates.**
- **Human (Tom).** Pushes and merges. PAR-653 and PAR-704. Thirteen CR signatures. A15.

## 5. The phase ladder

Full gate criteria are in the phased build plan. This is the spine.

| Phase | Items | Gate proves |
|---|---|---|
| **0 — Preconditions** | none | Packs verified at 2.1.0 (already installed — nothing to reinstall) · handoff path chosen and dry-run · 1059 green on a fresh clone · lint clean · audit clean |
| **1 — Safety net** | **A10** (PAR-723) | A spawned `dist/index.js` answers `tools/list` with 7 tools · broken config exits 2 with no stack · stdin close exits in grace · no ratio-between-timed-runs assertion survives. **This becomes the standing smoke test for every later gate.** |
| **2 — Stop the bleeding** | **A1** (PAR-714), **A2** (PAR-715) | Seven forbidden host classes rejected **with a listener recording zero hits** · `allowInternalHosts` works · the guard fires on the **autowarm** path · the full `maxTokens` matrix rejected on both tools and the CLI · A1's CR written and read |
| **3 — Store integrity** | **A4** (PAR-717), **A5** (PAR-718) | A 4×4 corruption matrix leaves every consumer answering correctly · read-only cache dir gives exit 0 with a note, and exit 2 with no stack on the CLI paths · `grep -c "as CacheMeta" src/cache.ts` returns 0 |
| **4 — Work and budget** | **A3** (PAR-716), **A6** (PAR-719) | A 30-library refresh does **exactly one** read and one write, by spy count not timing · the budget invariant holds for `get_docs` in both modes with a maximum note block · `test/retrieval.test.ts:768` amended, not deleted |
| **5 — Structure** | **A8** (PAR-721) → **A7** (PAR-720) → **A9** (PAR-722) | Import-graph test: `list-libraries` and `retrieval` do not reach `fetcher` · **zero test changes attributable to A8** · one character from every class survives no render path · D-11 note survives `structuredClone` |
| **6 — The five problems** | **A11+A16** (PAR-724/725) → **A17** (PAR-726) → **A18** (PAR-727) → **A19** (PAR-728) → **A20** (PAR-729) | The acceptance suite, written against the five problems as user-visible behaviour. A17 **requires Phase 4**. |
| **7 — Release** | none | All gates green on a **fresh clone** · PAR-653 and PAR-704 run from the Mac · thirteen CR signatures · release CR · version bump · the fresh-machine ship gate |

**Two hard dependencies inside the ladder:** A17 must follow A6 (Phase 4 before Phase 6). A11 and A16 are one job.

**A20 is independent** and may move earlier if a producer is free — it is the substrate any later measurement of this product depends on.

## 6. The loop, per item

1. Record the item as in progress in the current-state card **before** you dispatch.
2. Branch `build/<id>-<slug>` off `main` in the cloud clone.
3. Dispatch the producer with the plan's entry **verbatim**, the audit or scope finding behind it, and the file:line references. Nothing else — do not paste your own reasoning about the fix.
4. Run `npx vitest run` and `npm run lint` **yourself** before dispatching any gate. A red suite never reaches a gate.
5. Dispatch each gate in a fresh context **with the diff only**. Core 2.1.0's `Stop` hook validates each verdict block as the turn ends, so a malformed verdict blocks the turn rather than reaching a Change Record. **`.vibectx-plan/change-record-template.md` is the pre-2.0.0 shape and will fail** — take the current template from the pack's `change-record` skill instead.
6. **A single blocking FAIL or COULD NOT ASSESS stops the landing.** Never average verdicts into a pass. Re-dispatch with the finding and repeat.
7. Where a done-when is unmet, record it as an explicit risk acceptance for Tom to sign — **never restate the done-when to match what was built.** PAR-658 is the precedent and is still open because of it.
8. Land by the handoff path Phase 0 settled on.

**Expect two to four rounds per item.** PAR-656 took five; PAR-659 took four with three FAILs in round one. A gate failing is the process working.

## 7. Closing a phase — this is the part that must not be skipped

When every item in the phase has landed:

1. Run the phase's **full gate** from the phased build plan, top to bottom.
2. **Re-run every earlier phase's gate.** A phase that breaks an earlier gate has not passed its own.
3. Record the test count. Baseline is 1059; a phase that added behaviour and no tests is a finding.
4. Write a **gate record** into `.vibectx-plan/vibectx-build-loop-resume.md` under a `## gate log` section, containing:
   - phase number and date
   - every criterion, each marked pass or fail
   - the **pasted output** of each command — not a summary of it
   - test count before and after
   - any `[MEASURED]` figures the phase produced
   - what each gate agent caught, and in which round
5. **Only then** post the phase summary and start the next phase.

**If a gate criterion cannot be met**, do not soften it. Report it unmet, name the blocker and its owner, and ask Tom whether to carry it or hold the phase. Each phase in the plan has a **rollback trigger** — read it before improvising one.

## 8. Hard rules

- **Honesty over completion.** A done-when the numbers do not support is reported unmet. A claim the sandbox cannot verify is marked NOT VERIFIED. This queue exists because the previous loop's own suites were green every time the gates found a defect.
- **Never state a measurement you did not take.** Every number in this repo carries `MEASURED`, `ASSUMED` or `CITED`. Match that convention or do not write the number.
- **Prefer executing a claim to reading one.** A2's scope was wrong until someone ran it.
- **Prove the control runs on the live path.** A test exercising a function directly does not prove the function is reached in production. Phase 2's gate makes this explicit; apply it everywhere.
- **Claim discipline.** No README, marketing or Change Record text may say VibeCTX keeps an agent on task, prevents scope creep, prevents architectural drift, or stops hallucination in general. It prevents one evidenced kind — invented package names — and removes one cause of stale-context work. Scope decision §5 has the full list and three barred claims.
- **Scope is a hard boundary.** If anyone proposes memory, spec generation, architecture rule checking, symbol search, task tracking, or a large project-rules payload — the answer is no. Every one has a strong incumbent, and the last was measured to make results worse.
- Zero-config or it does not ship. Deterministic by default. Offline-first. Honest defaults.
- Do not create Linear issues without asking. **The sixteen that exist (PAR-714 through PAR-730) are already filed** — update those, do not duplicate them.
- Do not delete anything on the Mac. You cannot, and attempting it leaves stale git locks.
- **Verify refs with `git for-each-ref`, never `git branch`.** A bare ref holding 19 commits survived a "no outstanding branches" check on 2026-09-08 because `git branch -a` does not list one.

## 9. Your first five actions

1. Read the seven documents in §1, starting with the phased build plan.
2. Run `claude plugin list` and confirm **blackraptor-core** and **blackraptor-engineering** are at **2.1.0** and enabled. They are installed at user scope; **nothing needs reinstalling and nothing is vendored into the repo.** Then settle the branch-handoff path — **Phase 0 does not close until a dry run has moved one branch end to end.**
3. Rebuild the cloud clone and confirm **1059 passing**, lint clean, audit clean.
4. Write the **Phase 0 gate record** into the current-state card. That record is what authorises Phase 1.
5. Start **Phase 1: A10 (PAR-723) alone.** Build the safety net before touching anything else — every later gate depends on it.
