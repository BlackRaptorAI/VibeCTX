> # THE BUILD LOOP IS RETIRED — 2026-09-10.
> **This handoff instructs a session to take over the oversight seat of a process that no longer runs.**
> The relay of build sessions, go cards and handoff bundles is retired for this project. **Do not take
> the seat from this card and do not follow its reading order into the build-loop documents** — they
> are marked historical.
> **Its facts remain accurate for the period it covers.** Current state: `main` @ `839bfd7`, 1202 tests
> across 36 files, CI green on Node 22, 7 of 16 items landed. **Open work is tracked in Linear under
> PAR-515**, which is the authority from here.

# VibeCTX — oversight handoff ADDENDUM, 2026-09-08 (session 2)

**Read this WITH `vibectx-oversight-handoff.md`, not instead of it.** That card is unchanged and
still correct. This addendum records what a second oversight session established before it was
restarted. It adds no new work and changes no state.

**Nothing landed. A10 / PAR-723 is still in flight. `main` is still `c9cc77e`. The handoff folder
is still empty.** Section 2 of the handoff card stands exactly as written.

---

## 1. The rule that would have prevented this session ending early

**Never dispatch an agent whose slug is in Core's `GATES` set in order to test whether it exists.**
Read the roster instead — `ListPlugins`, or the agent list the session already carries. A failed
dispatch is indistinguishable from a real one to the verdict hook, and it wedges the session
permanently (§4). This session did exactly that, burned four turns, and had to be restarted.

The instinct behind it was the project's own doctrine — *prefer executing a claim to reading one.*
That doctrine has a boundary: it applies when reading is **insufficient**, not when reading has
already answered. `ListPlugins` had already given the answer. **MEASURED** — cause diagnosed from
the hook source, §4.

## 2. What this seat could and could not do — session capability

**MEASURED, two independent ways** (`ListPlugins`, and the agent roster returned in a dispatch
error): **`blackraptor-engineering` is not enabled in this Cowork session.** Core, council,
hardware and marketing are, all reachable.

Consequence: `code-reviewer`, `test-auditor`, `schema-reviewer`, `security-architect`,
`completion-auditor` and `backend-engineer` are **not dispatchable from a Cowork session**. Core's
`change-record`, `gate-verdict-format` and `enforcement-liveness` skills **are** available, so a
Change Record can be drafted and a verdict block checked against the 2.0.0 schema — but no gate
verdict can be produced.

**NOT VERIFIED:** whether the pack is installed at user scope and simply not surfaced to a Cowork
session, or absent entirely. A catalog keyword search returned only a generic Anthropic
`engineering` plugin from `knowledge-work-plugins` — **not** a substitute: it ships skills and
connectors, no seats, no verdict schema. **The decisive check is `claude plugin list` in the
command-line session on the Mac** — the same command that produced Phase 0 criterion 1's PASS.

**No folder was connected** (`connectedFolders` empty; device online). So `.vibectx-plan/` and the
repo were unreadable, and every fact above about VibeCTX itself came from the claude.ai project
copies alone. **The two copies could not be checked against each other.**

**Standing position while both hold:** oversight is a **judge-only** seat. It can judge a relayed
A10 report against §A10's done-when. It **cannot close Phase 1's gate**, because closing it
requires verdicts it cannot produce. Signing that gate from a relayed summary would reproduce
handoff §11 failure #1 exactly.

## 3. Trust-boundary finding — credentials in the cloud container

**MEASURED:** the Cowork cloud container's environment has **`GH_TOKEN` and `GITHUB_TOKEN` both
set**. Also present: a `GIT_ASKPASS`, three `GIT_CONFIG_*` pairs, and a proxy-auth git config.

This is the **D-54** case. The tokens were **not used**, and their scope was **NOT TESTED** —
establishing whether they reach `BlackRaptorAI/VibeCTX` would mean authenticating with them, which
is the act the rule exists to prevent. Unknown whether they are repo-scoped, write-capable, or a
generic proxy credential unrelated to this repository.

**Disposition: Tom's.** Every push stays on his side of the line regardless. Whether the credential
wants scoping or rotating is a separate decision, and the scope check should be run by him.

## 4. Core 2.1.0 defect — a failed gate dispatch wedges the session

**Not a VibeCTX item. Do not put it in the A-queue.** File against Core.

**Diagnosed from source**, `blackraptor-core/hooks/validate-verdicts.py`:

- The helper iterates **the entire transcript**, not the current turn, collecting every `tool_use`
  block where `name` is `Task`/`Agent` and the `subagent_type` slug is in its 17-name `GATES` set.
- It keys on the dispatch being **attempted**. A dispatch to a slug that does not resolve still
  writes that `tool_use` block into the transcript, where it is permanent. The agent never ran, so
  no honest verdict for it can ever exist — and the hook re-demands one on every subsequent turn.
- The apparent intermittency is the loop guard `if payload.get("stop_hook_active"): return 0` — a
  turn already continuing because the hook blocked is not blocked again. It alternates; it is not
  random, and it has nothing to do with the wording of the turn.

**Two false hypotheses were entertained and discarded before the source was read** — that the hook
matched on seat names appearing in prose, and that it was session-sticky in some looser sense.
Both were reported as hypotheses and neither was recorded as a cause. **Same discipline A10 owes
F-1: no cause recorded without a captured failure.**

**Why this matters beyond the annoyance.** Emitting a verdict block to clear the hook *would have
worked* — and the transcript would then hold a schema-valid, signed `code-reviewer` verdict for a
review that never happened. **The control designed to prevent unearned attestations can be made to
manufacture one.** That is handoff §11 failure #1 with the gate as the author.

**Remedy chosen: a fresh session**, not `BR_VERDICT_HOOK=off`. A new transcript carries no poisoned
block and the control stays armed at full strength. The kill switch would have disabled a live
governance control for a whole session to route around one bad entry — the wrong trade with A10
inbound.

## 5. Enforcement-liveness evidence — for the gate log

Phase 0 criterion 4 records the `Stop` hook observed firing once. **It fired repeatedly in this
session, in a second and independent environment (Cowork cloud, not the command-line session), and
was never disabled.** The block was refused rather than satisfied, on the grounds that no gate had
run. That strengthens criterion 4's evidence and is worth appending to the gate log.

It also demonstrates the hook's **failure mode**, which criterion 4 did not previously cover: it
enforces the presence of a verdict, not the occurrence of a review.

## 6. A gap in the plan documents — Gate 1 predates F-1

`VibeCTX-020-phased-build-plan.md` Gate 1 checks: seven tools on a spawned `dist/index.js`, exit 2
on a broken `--config`, shutdown within `CLOSE_GRACE_MS`, `grep largeMs / smallMs` empty, a `spawn`
harness present, count above 1059, Gate 0 green.

**None of those criteria mentions F-1, the other five timing assertions, or the 20 consecutive
clean-clone runs.** Those live only in A10's extended done-when in
`VibeCTX-plan-revision-2026-09-08.md`. **Judging A10 against Gate 1 as printed is the exact route
by which F-1 slips** — the failure handoff §4 warns about. Gate 1 needs three criteria added, and
that edit was not made: it changes an authoritative document and was left for Tom's approval.

## 7. Stale gate routing still in the plan

A10's "Gate routing" line reads `qa-test-engineer` **and** `test-auditor`. Under 2.1.0 the
test/coverage gate is `test-auditor`; `qa-test-engineer` is a **producer with edit tools**. A1, A16
and A20 carry the same stale pairing. **If A10's report arrives with a `qa-test-engineer` verdict
serving as its test gate, that is a seat judging what it can edit** — report it, do not accept it.

## 8. What did not change

No code. No branches. No pushes. No Linear issues. No edits to any authoritative document. The
gate log is untouched — §5 above is a proposed addition, not a made one. `.vibectx-plan/` on the
Mac does **not** contain this addendum, so the two copies now diverge until Tom mirrors it.

**The next event is still the build session reporting A10 through Tom.**
