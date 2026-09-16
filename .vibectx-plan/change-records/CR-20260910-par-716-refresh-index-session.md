> # WRITTEN RETROACTIVELY — 2026-09-16, six days after the change landed
>
> **This record exists because of D-60.** A3 was originally cleared with *"no gated path touched, so
> no CR due"* — reasoning from `change-record-policy.md`, retired since `a0852f2`. D-60 struck that
> reasoning: A3 changed cache integrity **and added a filesystem-delete primitive**, so it owes a
> Change Record.
>
> **§3 is empty, and A3's case is the sharper one.** Unlike A4, **A3's verdicts did exist and were
> schema-complete** — thirteen gate dispatches, `evidence`, `standards` and `falsifier` all present,
> no Stop-hook wedge. They were relayed into an oversight session that is no longer reachable and
> were never written to any durable store. **Nothing was broken. Nobody wrote them down.**

# Change Record — CR-20260910-par-716-refresh-index-session

## 1. Change summary

| Field | Value |
|---|---|
| CR ID | CR-20260910-par-716-refresh-index-session |
| PR | none — landed by fast-forward to `main` @ `bf89bd5`; this repository has no PR for it |
| Spec / plan | Linear **PAR-716** (0.2.0 / A3) · `.vibectx-plan/vibectx-build-loop-resume.md` §9 |
| Author of the change | Phase 4 build session, under oversight. Producer: `backend-engineer`. |
| Author of this record | VibeCTX oversight seat, **2026-09-16**, retroactively under D-60 |
| Date of change | 2026-09-10 |
| Risk tier | **Tier 2 — cache integrity, plus a new destructive capability.** `dropFollowedPageCache` deletes files from the cache directory; A3 introduced it. **Recorded reading, not a measurement** — the CI gate map that would have set this mechanically was removed by `a0852f2`. Tom's to confirm. |
| Emergency? | No |

**What changed and why:**
`refresh` opened and re-parsed the on-disk search index once per library. The audit measured roughly
ninety parses of a 16.9 MB file in a single run — an **O(n) in library count** problem, not a
constant-factor one. A3 makes `refresh` open **one index session** for the whole run, adds a
full-refresh rate cap, and drops a library's followed-page cache when its primary document is
genuinely replaced so those pages are re-followed against the new document rather than served from a
stale set. Seven commits, eleven files, from prerequisite `c50faf0`.

**Blast radius if wrong:**
`refresh` is the command a user runs to update everything, and increasingly on a schedule,
unattended. The index session is shared with `warm` and `autowarm`, so a durability mistake in
`flush()` corrupts the search index for every command that reads it. **The followed-page cache drop
is a delete on the user's disk** — the first destructive primitive in this codebase — so a key-
derivation mistake deletes the wrong library's pages. No data leaves the machine.

## 2. Gate decisions

**Read the "Agent verdict" column with §3 open.** Every entry is a **second-hand attribution**
recovered from the commit series and the contemporaneous oversight record. No cell in that column is
a verdict block.

| Gate role | Seat | Applies? | Agent verdict | My decision | Initials + date |
|---|---|---|---|---|---|
| Security | `security-architect` | **Yes** — filesystem-delete primitive + cache trust boundary | **RAN, 4 dispatches. VERDICT NOT RECOVERABLE.** Findings `C1`–`C5` (round 2), `N1` (round 4) closed | **ACCEPT-WITH-RISK** | TH 2026-09-16 |
| Privacy | `privacy-counsel` | N/A: no personal data; local-only cache of public documentation. | — | — | — |
| Compliance | `compliance-officer` | N/A: no SOC 2 / ISO control surface. | — | — | — |
| Domain | — | N/A: no regulated domain. | — | — | — |
| Schema | `schema-reviewer` | **Yes** — `index.json`'s on-disk shape and the session/flush contract | **NOT DISPATCHED.** PAR-716 did not route it. Recorded as a routing gap, not a clean N/A. | **ACCEPT-WITH-RISK** | TH 2026-09-16 |
| Operational readiness | `operational-readiness` | **Arguably yes** — this is the unattended-scheduled-run command, and A3 added a rate cap and a delete to it | **NOT DISPATCHED.** Recorded as a routing gap. | **ACCEPT-WITH-RISK** | TH 2026-09-16 |
| UX | `ux-designer` | N/A: no user interface. | — | — | — |
| Quality | `test-auditor` | **Yes** — 5 dispatches. `F8`, `F8a`, `F9` (blocking), `F12`, `F13` closed | **RAN. VERDICT NOT RECOVERABLE.** | **ACCEPT-WITH-RISK** | TH 2026-09-16 |
| Review | `code-reviewer` | **Yes** — 4 dispatches. Round-1 **FAIL**; `B1`, `B2`, `S1`–`S7`, `N1`, `SF-1`–`SF-3` | **RAN. VERDICT NOT RECOVERABLE.** | **ACCEPT-WITH-RISK** | TH 2026-09-16 |

**The round-1 FAIL is the most important thing in this table, and it was a gate catching oversight.**
`code-reviewer` failed A3 at round 1 because folding the followed-page-cache clause into the item had
introduced a **filesystem-delete primitive** — changing the item's risk class. **`security-architect`
was not in oversight's routing and had to be added mid-review.** The contemporaneous record is blunt
about whose error that was:

> *"**That routing error was oversight's** — rule 2.7 lifted the clause into done-when without
> recognising it was a new destructive capability, not an edit. A delete primitive arriving through a
> footnote is a scoping failure, caught only because a gate refused to review it as routed."*

**A dispatch-count discrepancy, recorded rather than resolved.** The oversight comment on PAR-716
reads *"`code-reviewer` ×4, `test-auditor` ×5, `security-architect` ×4 — **nine rounds**."* **4 + 5 + 4
is 13, not 9**, and the commit series shows **six** numbered fix rounds (`40c0721`, `4938dc9`,
`c8b1f25`, `250ecc8`, `217a2dd`, `1170ab8`, `bf89bd5`). Three numbers that do not reconcile. The
per-seat counts are used above because they are the most specific; **"nine" is not repeated here, and
none of the three is verified.** Without the verdict blocks this cannot be settled.

## 3. Agent analysis (evidence)

> ## NO VERDICT BLOCKS EXIST FOR THIS CHANGE. NONE ARE PASTED BELOW.
>
> **Nothing may be written into this section that was not emitted by a gate.** A reconstructed
> verdict is a fabricated verdict.

**Why they are missing — and this cause is different from A4's.** A4's were forfeited by a
`validate-verdicts.sh` Stop-hook wedge. **A3 had no wedge.** Its verdicts were produced, complete,
and relayed. The contemporaneous oversight record says so twice:

> *"`code-reviewer` ×4, `test-auditor` ×5, `security-architect` ×4 … verdicts **verbatim and
> schema-complete** (`evidence`, `standards`, `falsifier`). **No Stop-hook wedge**, breaking a run of
> four of five items."*

> *"A3's verdicts, relayed the same day, carried full `evidence`, `standards` and `falsifier`."*

They were relayed into an oversight chat session and **never written to any durable store** — not the
commit messages, not Linear, not `.vibectx-plan/`. **The strongest-gated item in this project has the
same evidentiary standing as the weakest, because of where its evidence was put.** That is the whole
lesson of this record.

**The search, so nobody repeats it. Five sources, MEASURED 2026-09-16 at `main` @ `47677b4`:**

| Source | Method | Result |
|---|---|---|
| `.vibectx-plan/**/*.md` | `grep -rc '"gate"'` | Only the change-record template and its retired twin. **No A3 verdict.** |
| All commit messages, all branches | `git log --all --format='%B'` over **230 commits** | **0 verdict blocks** |
| The seven A3 commits `c50faf0..bf89bd5` | each message read | Name the rounds and findings. **No verdict blocks.** |
| Linear PAR-716 | all comments | One oversight record describing the verdicts. **The verdicts themselves are not in it.** |
| Session transcripts in the oversight container | `/root/.claude/projects/` — the only transcript present, plus 5 subagent logs | Verdict blocks found name **A8** and CRs already written. **Nothing for A3.** |

**What stands in their place.** Findings are traceable to individual commits at round resolution
(`B1` symlinked-root delete and `B2` flush durability at `4938dc9`; `C1`–`C5` and `SF-1`–`SF-3` at
`c8b1f25`; the converged round-3 set at `250ecc8`; `N1`/`F8` at `217a2dd`; `F9` at `1170ab8`; `F13` at
`bf89bd5`). Every fix was hand mutation-tested by the producer before being reported fixed. **That
evidences that the gates ran and what they raised. It does not evidence what they concluded.**

## 4. Mechanical evidence (Layer 1)

- **CI:** green on Node 22 — `success` at `bf89bd509f4338f504c02587bb14695678119261`. **Verified by SHA.**
- **Suite:** 1136/34 → **1171 passing across 36 files** (+35 tests, +2 files: `test/rate-limit.test.ts`, `test/refresh-index-session.test.ts`).
- **Artifact verification:** bundle required exactly `c50faf0`; seven commits, eleven files; **zero attribution trailers** (rule 2.5).
- Two-person rule: not applicable (Tier 2).

**Done-when 1 is UNMET as literally written, and that is oversight's error, not the session's.**
MEASURED at `bf89bd5`: **3 reads / 1 write** when content changed; **1 read / 0 writes when nothing
changed** — better than the criterion asked for, in the case a scheduled refresh hits most often. All
three reads traced independently: `openIndexSession`'s lazy snapshot (`search-index.ts:539`);
`flush()`'s deliberate re-read (`:600`, **load-bearing** — the index is a shared cache another process
may have written between the first `add` and the flush, and it is shared with `warm`/`autowarm`); one
`invalidateIndex` on the still-O(n) resolved path (`refresh.ts:66`), which reads, finds nothing to
delete, and returns **without writing**.

*"Exactly one read" was unsatisfiable by anything scoped to `refresh.ts`, and it measured the wrong
property* — the audit's evidence was an O(n)-vs-O(1) problem, and "exactly one" is a stricter,
different claim than "constant." **Gate 4 was amended to constant-in-library-count.** The session
reporting this UNMET rather than restating it is plan rule 4 working as designed.

**One criterion is PARTIALLY met.** The `[MEASURED]` before/after print: the **after** is measured;
the **before** prints as `[A3 ESTIMATED, pre-fix] ~90 reads, ~60 writes` with its own disclaimer,
*"never independently re-measured here."* A `test-auditor` round forced the two registers onto
separate labelled lines. **The shape of the improvement is established; the magnitude is not. Nothing
may cite "90 reads to 3" as a measured result** — under D-37 the number is the record, and that one
is an estimate.

## 5. Deviations & risk acceptance

| What | Agent said | I decided | Why acceptable | Revisit by |
|---|---|---|---|---|
| **Thirteen gate dispatches produced complete verdicts and none survive.** §3 cannot meet this template's evidence standard. | Complete, schema-complete, and lost | **ACCEPT-WITH-RISK** — taken TH 2026-09-16 | Corroborated four ways: oversight traced all three index reads to source itself; CI green on the exact SHA; findings traceable to individual commits at round resolution; every fix hand mutation-tested before being reported fixed. **None of that recovers what the gates concluded.** Re-gating `bf89bd5` today would judge a tree five commits stale. | Only if a defect is found in the index-session or delete path. Then re-gate rather than trust this record. |
| A **filesystem-delete primitive** reached done-when through a footnote in a *Dependencies* clause, not through scope review. | `code-reviewer` round-1 **FAIL** | **ACCEPT** — the gate caught it and `security-architect` was added mid-review | The capability shipped reviewed. What failed was oversight's routing, and it failed safe because a gate refused to review the item as routed. Generalised as the process finding below. | — |
| `schema-reviewer` and `operational-readiness` were not dispatched on a change to an on-disk contract and to the unattended-run command. | Not dispatched | **ACCEPT-WITH-RISK** — taken TH 2026-09-16 | `test-auditor` ×5 and `security-architect` ×4 covered behaviour and the trust boundary. Uncovered: index-format evolution, and operability of the new rate cap under a scheduled run. | The next change to `index.json`'s shape, or the first unattended-`refresh` field report. |
| Done-when 1 UNMET as written; Gate 4 amended. | Session reported UNMET | **ACCEPT** — the criterion was wrong | Measured behaviour is better than the criterion asked for in the common case. Oversight wrote the bad criterion. | — |
| Five findings carried, not fixed. | Disclosed and filed with real numbers | **ACCEPT** | **PAR-742** (F-5), **PAR-743** (F-6), **PAR-745** (F-8) — since consolidated into **PAR-749** (C-1); **PAR-744** (F-7, needs gated `fetcher.ts`, so it owes its own CR); **PAR-746** (F-9). The session correctly refused to invent PAR numbers. | PAR-749, PAR-744 |

**Process finding, worth more than any single item here.** A *"fix this while you're here"* clause
buried in an issue's **Dependencies** section is invisible to the gates and to the oversight check —
both read **Done when**. Here it cost a finding and smuggled in a destructive capability. **Every
remaining item must carry such clauses in Done when.**

## 6. Emergency addendum

Not applicable — Emergency = No.

## 7. Sign-off

> I ran the applicable gate reviews, read the analyses, and take responsibility for the decisions
> recorded above.

**A §7 signature is Tom's, never an agent's (D-65).** Signing this record means accepting §5's five
entries — first among them that thirteen complete gate verdicts existed and were not written down.

**Signed:** TH (Tom Hanks, BlackRaptor AI) — signature authorized in-session 2026-09-16  **Date:** 2026-09-16

> **How this signature was given, recorded so it is never mistaken for an agent's.** D-65 holds that a
> §7 signature is Tom's initials and that a record signed by anyone else is UNSIGNED. **Tom took this
> decision in-session on 2026-09-16**, after the five §5 risk acceptances were enumerated to him, and
> authorized the signature; the oversight seat transcribed it. **That is the same form as the two
> valid signatures in this repository** — `CR-20260720-install-dev-team.md:82` and
> `CR-20260722-add-research-integrity.md:68`, both reading *"signature authorized in-session"* — and
> D-65 counts those two as the only valid ones. **It is NOT the form D-65 struck**, which was an agent
> signing under its own name (`CR-20260909-par-714-url-host-policy.md:246`).
