<!--
  COPIED VERBATIM 2026-09-08 from BlackRaptor Workforce Core 2.1.0 —
  _source/dist/public/skills/change-record/references/change-record-template.md
  in BlackRaptor_Workforce_Golden @ f66121a (the authoritative emitted tree; the
  dist/subset-* trees are a stale 2.0.0 build and were NOT used).

  This is the LIVE template. The pre-2.0.0 copy that shipped in the VibeCTX repo is
  kept beside it as change-record-template.RETIRED-pre-2.0.0.md and will fail the
  Stop-hook validator. See D-53.

  If the pack is updated, re-copy from the skill rather than editing this file.
-->

# Change Record — CR-YYYYMMDD-<short-slug>

<!--
USAGE
  1. Copy this file to docs/change-records/CR-YYYYMMDD-<slug>.md IN THE SAME PR
     as the change. The change-record-required CI check looks for it there.
  2. Fill every section. Gates that don't apply: mark N/A in the Applies? column
     with one line of why, and paste NO verdict block for them — `N/A` stopped
     being a verdict value in schema v3, so a gate that did not run emits nothing.
     An unexplained N/A is the rubber stamp an auditor looks for.
     A gate that ran and could not finish is COULD NOT ASSESS, which is BLOCKING —
     it is not the same as N/A and must not be recorded as one.
  3. This file IS the audit evidence that the control operated. Write it for a
     stranger reading it in 18 months.

PHASE 2 (CI-posted verdicts): when agent reviews later run in CI, their output
gets appended under "Agent Analysis" automatically. Your signature block does
NOT change — the human decision remains the control; agent output is evidence
attached to it.
-->

## 1. Change summary

| Field | Value |
|---|---|
| CR ID | CR-YYYYMMDD-<slug> |
| PR | #___ |
| Spec / plan | <spec-dir>/___ / <plan-dir>/___ |
| Author | <your name> |
| Date | YYYY-MM-DD |
| Risk tier | Tier 1 (routine) / Tier 2 (sensitive) / Tier 3 (two-person rule) |
| Emergency? | No / **YES — retroactive, see §6** |

**What changed and why (2–5 sentences):**

**Blast radius if wrong (prod deploys on merge — be honest):**

## 2. Gate decisions

For each gate ROLE: run **your pack's agent for that role** (see your pack's `seat-list.md`,
which maps each role to its agent or marks it `N/A`) on the diff, read its verdict, decide, sign.
This template is **roster-neutral** — it names roles, not agents, so it is correct in every pack.
"Agent verdict" is what the agent concluded; "My decision" is yours — they may differ, and when
they do, §5 is mandatory.

| Gate role | Your pack's seat (see `seat-list.md`) | Applies? | Agent verdict (PASS / CONCERNS / FAIL / COULD NOT ASSESS) | My decision (ACCEPT / ACCEPT-WITH-RISK / REWORK) | Initials + date |
|---|---|---|---|---|---|
| Security (auth/RBAC/tenant/remote-access) | `security` seat | Yes / N/A: ___ | | | |
| Privacy (PII, LLM data-flow, cross-border) | `privacy` seat | Yes / N/A: ___ | | | |
| Compliance (SOC 2 / ISO control continuity, audit-trail writes) | `compliance` seat | Yes / N/A: ___ | | | |
| Domain (<regulated domain>) | `domain` seat | Yes / N/A: ___ | | | |
| Schema (migrations, expand/contract, lock impact) | `schema` seat | Yes / N/A: ___ | | | |
| Operational readiness (HITL on consequential/automated action; operability) | `operational-readiness` seat | Yes / N/A: ___ | | | |
| UX (design system, interaction, a11y) | `ux` seat | Yes / N/A: ___ | | | |
| Quality (TDD followed, coverage thresholds) | `quality` seat | CI-enforced; note exceptions: ___ | | | |
| Review (last gate before merge; conventions, routing) | `review` seat | Yes / N/A: ___ | | | |

## 3. Agent analysis (evidence)

Paste each consulted agent's full verdict, or link to its committed output.
Include the model/agent-file version if the agent definitions have changed.
**Each gate agent emits a machine `verdict` block (see the `gate-verdict-format`
skill); paste it in a fenced `verdict` block below — the `change-record-required`
CI check parses and validates it.**

<details><summary>security-architect</summary>

```verdict
{"gate":"security","agent":"security-architect","artifact":"PR #___ / <files>","verdict":"___","confidence":0,"falsifier":"the one fact that would flip this","evidence":"file:line — basis","standards":["none: practice applied: ___"]}
```

(prose analysis here)
</details>

<details><summary>privacy-counsel</summary>

```verdict
{"gate":"privacy","agent":"privacy-counsel","artifact":"PR #___","verdict":"___","confidence":0,"falsifier":"...","evidence":"file:line — basis","standards":["none: practice applied: ___"]}
```

(prose analysis here)
</details>

<!-- add a <details> block with its own ```verdict fence for each consulted gate agent -->

## 4. Mechanical evidence (Layer 1)

- CI run: <link to green check run on the merged SHA>
- Coverage: ___% overall / ___% critical paths
- Two-person rule (Tier 3 only): <second approver> approval on PR #___ — <link>

## 5. Deviations & risk acceptance

Required if any decision above is ACCEPT-WITH-RISK, or differs from the agent's
verdict. Empty otherwise.

| What | Agent said | I decided | Why acceptable | Revisit by |
|---|---|---|---|---|
| | | | | |

## 6. Emergency addendum (only if Emergency = YES)

- What broke, when, user impact:
- Why the normal gate path was bypassed:
- Bypass mechanism used (rule disabled / ruleset bypass) and duration:
- Retroactive gate review completed on: ___ (fill §2–§3 after the fact)

## 7. Sign-off

> I ran the applicable gate reviews, read the analyses, and take responsibility
> for the decisions recorded above.

**Signed:** ______________  **Date:** ___________
