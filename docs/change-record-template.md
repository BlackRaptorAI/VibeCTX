# Change Record — CR-YYYYMMDD-<short-slug>

<!--
USAGE
  1. Copy this file to docs/change-records/CR-YYYYMMDD-<slug>.md IN THE SAME PR
     as the change. The change-record-required CI check looks for it there.
  2. Fill every section. Gates that don't apply: mark N/A with one line of why.
     An unexplained N/A is the rubber stamp an auditor looks for.
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
| Spec / plan | docs/specs//___ / docs/plans//___ |
| Author | Tom Hanks |
| Date | YYYY-MM-DD |
| Risk tier | Tier 1 (routine) / Tier 2 (sensitive) / Tier 3 (two-person rule) |
| Emergency? | No / **YES — retroactive, see §6** |

**What changed and why (2–5 sentences):**

**Blast radius if wrong (prod deploys on merge — be honest):**

## 2. Gate decisions

For each gate: run the named agent on the diff, read its verdict, decide, sign.
"Agent verdict" is what the agent concluded; "My decision" is yours — they may
differ, and when they do, §5 is mandatory.

| Gate | Agent | Applies? | Agent verdict (PASS / FAIL / CONCERNS) | My decision (ACCEPT / ACCEPT-WITH-RISK / REWORK) | Initials + date |
|---|---|---|---|---|---|
| Security (auth/RBAC/tenant/remote-access) | security-architect | Yes / N/A: ___ | | | |
| Privacy (PII, LLM data-flow, cross-border) | privacy-counsel | Yes / N/A: ___ | | | |
| Compliance (SOC 2 / ISO control continuity, audit-trail writes) | compliance-officer | Yes / N/A: ___ | | | |
| Domain (none — VibeCTX handles public developer documentation; it is not a regulated domain) | domain-compliance | Yes / N/A: ___ | | | |
| Schema (migrations) | data-engineer | Yes / N/A: ___ | | | |
| Quality (TDD followed, coverage thresholds) | qa-test-engineer | CI-enforced; note exceptions: ___ | | | |

## 3. Agent analysis (evidence)

Paste each consulted agent's full verdict, or link to its committed output.
Include the model/agent-file version if the agent definitions have changed.

<details><summary>security-architect</summary>

```
(paste)
```
</details>

<details><summary>privacy-counsel</summary>

```
(paste)
```
</details>

<!-- add blocks for other consulted agents -->

## 4. Mechanical evidence (Layer 1)

- CI run: <link to green check run on the merged SHA>
- Coverage: ___% overall / ___% critical paths
- Two-person rule (Tier 3 only): the repository maintainer (Tom Hanks / @BlackRaptorAI) approval on PR #___ — <link>

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
