> # WRITTEN RETROACTIVELY — 2026-09-16, seven days after the change landed
>
> **This record exists because of D-60.** A4 was originally cleared with *"no gated path touched, so
> no CR due"* — reasoning from `change-record-policy.md`, a control that has not existed since
> `a0852f2`. D-60 struck that reasoning and ruled that **A4 owes a Change Record**, because it changed
> cache integrity, which the live rule names directly.
>
> **§3 is empty, and that is the point of this record.** The gates ran. Their verbatim verdict blocks
> were forfeited by a `validate-verdicts.sh` Stop-hook wedge and **no longer exist anywhere**. The
> search is documented in §3. **Do not read this record as equivalent to one written at the time.**

# Change Record — CR-20260909-par-717-cache-meta-validation

## 1. Change summary

| Field | Value |
|---|---|
| CR ID | CR-20260909-par-717-cache-meta-validation |
| PR | none — landed by fast-forward to `main` @ `611f581`; this repository has no PR for it |
| Spec / plan | Linear **PAR-717** (0.2.0 / A4) · `.vibectx-plan/vibectx-build-loop-resume.md` §9, "A4 (PAR-717) landed" |
| Author of the change | Phase 3 build session, under oversight. Producer: `backend-engineer`. |
| Author of this record | VibeCTX oversight seat, **2026-09-16**, retroactively under D-60 |
| Date of change | 2026-09-09 |
| Risk tier | **Tier 2 — cache integrity.** Not Tier 3: no tagged release, no two-person rule. **Recorded reading, not a measurement** — the CI gate map that would have set this mechanically was removed by `a0852f2`, and the commit message's own line *"src/cache.ts is deliberately not hard-gated (D-44)"* is the reasoning D-60 struck. Tom's to confirm. |
| Emergency? | No |

**What changed and why:**
`src/cache.ts` did `JSON.parse(readFileSync(metaPath)) as CacheMeta` with no shape check and no
`try`/`catch`, unlike every other persisted store in the codebase (`resolved-store.ts`,
`project-store.ts`, `search-index.ts`), each of which treats the cache directory as the trust
boundary it is. A corrupt `.meta.json` threw uncaught out of `list_libraries` and `refresh`, and
silently aborted `autowarm`'s entire startup pre-scan batch rather than just the one bad entry.
`toCacheMeta()` / `readCacheMeta()` now validate every field on read (URL shape, strict ISO-8601
`fetchedAt`, HTTP-field-value-shaped `etag`); `readCache` / `touchCache` report a corrupt entry as
uncached instead of throwing. `writeCache` applies the same `etag` validation on write, closing an
asymmetry where a nonconforming server's `etag` could reach disk unfiltered.

**Blast radius if wrong:**
Every read of the local document cache — `get_docs`, `list_libraries`, `refresh`, `warm`, `autowarm`.
A validator that is too strict silently converts healthy cached documents into misses, so the tool
refetches everything and an offline user gets nothing; too lax and the original uncaught throw
returns. No network surface and no data leaves the machine. **Two real bugs were caught mid-review
and are part of this change:** a control character in a cached `etag` could pin an entry stale
forever, and a corrupt cache entry aborted `autowarm`'s pre-scan for *every other* configured
library, not only itself.

## 2. Gate decisions

**Read the "Agent verdict" column with §3 open.** Every entry in it is a **second-hand attribution**
recovered from the commit message and the contemporaneous oversight record — not a verdict block.
No cell in that column is evidence in the sense this template means.

| Gate role | Seat | Applies? | Agent verdict | My decision | Initials + date |
|---|---|---|---|---|---|
| Security | `security-architect` | **Yes** — cache directory is a trust boundary | **RAN, 3 rounds. VERDICT NOT RECOVERABLE.** Findings `F1`, `F5` closed (rounds 1–2) | **ACCEPT-WITH-RISK** | TH 2026-09-16 |
| Privacy | `privacy-counsel` | N/A: no personal data. VibeCTX caches public library documentation on the user's own disk; no accounts, no telemetry, nothing leaves the machine. | — | — | — |
| Compliance | `compliance-officer` | N/A: no SOC 2 / ISO control surface. Local single-user MIT tool, no audit-trail writes. | — | — | — |
| Domain | — | N/A: no regulated domain. | — | — | — |
| Schema | `schema-reviewer` | **Yes** — this change *is* an on-disk record-shape contract (`.meta.json`) | **NOT DISPATCHED.** PAR-717 did not route it. Recorded as a routing gap, not a clean N/A. | **ACCEPT-WITH-RISK** | TH 2026-09-16 |
| Operational readiness | `operational-readiness` | N/A: no consequential automated action; no HITL surface. | — | — | — |
| UX | `ux-designer` | N/A: no user interface. | — | — | — |
| Quality | `test-auditor` | **Yes** — 2 rounds. A round-3 source tripwire landed at `test/cache.test.ts`. | **RAN. VERDICT NOT RECOVERABLE.** | **ACCEPT-WITH-RISK** | TH 2026-09-16 |
| Review | `code-reviewer` | **Yes** — 2 rounds. Findings `S1`, `S2`, `S5`, `N1`, `N4` closed (round 2) | **RAN. VERDICT NOT RECOVERABLE.** | **ACCEPT-WITH-RISK** | TH 2026-09-16 |

**Two routing notes, both recorded rather than smoothed over.**

1. **PAR-717's text named `qa-test-engineer` as a gate. It is a PRODUCER in Workforce 2.1.0, not a
   gate.** The build session routed to `test-auditor` instead. **The session was right and the issue
   text was wrong.** (Later generalised as D-69: confirm a seat can perform a step before writing it
   into a dispatch.)
2. **`completion-auditor` did not run.** PAR-717 did not require it. Recorded because it is the seat
   that checks done-when coverage — and its absence is exactly why oversight measured the done-when
   itself rather than accepting the session's report (§4).

## 3. Agent analysis (evidence)

> ## NO VERDICT BLOCKS EXIST FOR THIS CHANGE. NONE ARE PASTED BELOW.
>
> **This section is deliberately empty of verdicts, and nothing may be written into it that was not
> emitted by a gate.** A reconstructed verdict is a fabricated verdict.

**Why they are missing — cause, recorded contemporaneously.** The `validate-verdicts.sh` Stop hook
wedged the session. `.vibectx-plan/vibectx-build-loop-resume.md` records the cost in general terms:

> *"**STOP-HOOK WEDGE: FOUR OF FIVE ITEMS.** A10, A1, A4, A5. … **Each wedge costs one fresh session
> and forfeits the verdict blocks**, which is precisely why three of five items now have weaker
> evidentiary standing than A2."*

and, on this item specifically:

> *"oversight holds **no verbatim verdict blocks** for A4. Commit-message attribution is
> *corroborating evidence that gates ran*; it is **not a verdict**, and it cannot be, because the
> producer wrote it. … **If the A4 session's verdicts exist, they belong pasted into this entry.**"*

They did not exist then and do not exist now.

**The search, so nobody repeats it. Five sources, MEASURED 2026-09-16 at `main` @ `47677b4`:**

| Source | Method | Result |
|---|---|---|
| `.vibectx-plan/**/*.md` | `grep -rc '"gate"'` | Only `change-record-template.md` and its retired twin. **No A4 verdict.** |
| All commit messages, all branches | `git log --all --format='%B' \| grep -c '"gate"'` over **230 commits** | **0** |
| `611f581`'s own message | read in full | Names the rounds and the findings. **Contains no verdict block.** |
| Linear PAR-717 | all comments | One oversight record. **No pasted verdict.** It states the absence itself. |
| Session transcripts in the oversight container | `/root/.claude/projects/` — the only transcript present, plus 5 subagent logs | Verdict blocks found name **A8** and CRs already written (PAR-652, 657, 706, 707). **Nothing for A4.** |

**What stands in their place, and its exact weight.** Seventeen distinct, individually-answerable
findings (`F1`, `F5`, `S1`, `S2`, `S5`, `N1`, `N4`, and a round-3 test tripwire) are traceable to
individual code sites and tests in the diff. That is strong evidence the gates **ran**. It is **not**
evidence of what they **measured**, and it cannot be: the producer wrote the commit message.

**A2 landed with five verdicts pasted verbatim. That is the standard. This record does not meet it.**

## 4. Mechanical evidence (Layer 1)

- **CI:** green on Node 22 — `conclusion: success`, `headSha 611f58152762fa93ec8584b1a7813ad6613530fc`. **Verified by SHA, not by run title.**
- **Suite:** 1103 → **1127 passing across 33 files** (no new test files).
- **Artifact verification before the branch went near `main`:** bundle verifies against prerequisite `262909a`; one commit, seven files; gated paths byte-empty; **zero AI-attribution trailers** (rule 2.5).
- `grep -c "as CacheMeta" src/cache.ts` → **0**.
- **Done-when, measured by the oversight seat rather than accepted from the report:**

| PAR-717 criterion | Measured |
|---|---|
| `toCacheMeta()` mirroring `toWarmRow` | `src/cache.ts:106`, shared `ISO_INSTANT` at `:40` |
| `readCache` returns `undefined` on bad meta (D-13) | `:127` routes through `toCacheMeta` |
| Four corruption classes, one test each | `test/cache.test.ts:71` — truncated `:76`, invalid JSON `:87`, wrong shape `:97`, hostile `fetchedAt` `:105` |
| `list_libraries` no longer crashes | `test/list-libraries.test.ts:237` |
| `refresh` no longer crashes | `test/refresh.test.ts:179` |

- Two-person rule: not applicable (Tier 2).

## 5. Deviations & risk acceptance

| What | Agent said | I decided | Why acceptable | Revisit by |
|---|---|---|---|---|
| **The verdict blocks for three gates that ran are permanently lost.** §3 cannot meet this template's evidence standard. | Unknown — that is the deviation | **ACCEPT-WITH-RISK** — taken TH 2026-09-16 | The change is independently corroborated four ways: oversight measured every done-when criterion itself against the source; CI is green on the exact SHA; seventeen findings are traceable to code sites; `grep -c "as CacheMeta"` returns 0. **None of that tells us what the gates concluded.** The residual risk is that a gate raised something that was never carried forward. Re-gating `611f581` today would produce verdicts against a tree seven commits stale, which is a different artifact. | Only if a defect is later found in `src/cache.ts`'s validator. Then re-gate rather than trust this record. |
| `schema-reviewer` was not dispatched on a change that defines an on-disk record shape. | Not dispatched | **ACCEPT-WITH-RISK** — taken TH 2026-09-16 | `test-auditor` covered the four corruption classes behaviourally and `security-architect` ran three rounds on the trust boundary. The uncovered question is contract *evolution* — whether a future `.meta.json` version can be read by this validator. | The next change to `.meta.json`'s shape. |
| Two findings carried, not fixed — deliberately outside A4's authorised scope. | Disclosed by the session | **ACCEPT** | Both are tracked: `cache-evict.ts`'s own laxer `.meta.json` reader → **PAR-741**, since consolidated into **PAR-749** (C-1). The unbounded ISO-8601 fraction group in `project-store.ts` and `search-index.ts` → still untracked as its own item. | PAR-749 |

## 6. Emergency addendum

Not applicable — Emergency = No.

## 7. Sign-off

> I ran the applicable gate reviews, read the analyses, and take responsibility for the decisions
> recorded above.

**A §7 signature is Tom's, never an agent's (D-65).** An agent-signed record is an unsigned record.
**Signing this one means accepting §5's three risk acceptances**, the first of which is that three
gate verdicts are gone and cannot be produced.

**Signed:** TH (Tom Hanks, BlackRaptor AI) — signature authorized in-session 2026-09-16  **Date:** 2026-09-16

> **How this signature was given, recorded so it is never mistaken for an agent's.** D-65 holds that a
> §7 signature is Tom's initials and that a record signed by anyone else is UNSIGNED. **Tom took this
> decision in-session on 2026-09-16**, after the three §5 risk acceptances were enumerated to him, and
> authorized the signature; the oversight seat transcribed it. **That is the same form as the two
> valid signatures in this repository** — `CR-20260720-install-dev-team.md:82` and
> `CR-20260722-add-research-integrity.md:68`, both reading *"signature authorized in-session"* — and
> D-65 counts those two as the only valid ones. **It is NOT the form D-65 struck**, which was an agent
> signing under its own name (`CR-20260909-par-714-url-host-policy.md:246`).
