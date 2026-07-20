---
name: change-record
description: >-
  Create or complete a Change Record (CR) for a pull request. Use when a change
  touches a Tier 2/3 surface, when the change-record-required CI check fails,
  when the user says "change record", "CR", "sign the gates", or when preparing
  a gated-path PR for merge.
---

# Change Record procedure

A Change Record is the audit evidence that gate review operated on a change.
It lives at `docs/change-records/CR-YYYYMMDD-<slug>.md`, committed **in the
same PR** as the change. The `change-record-required` CI check blocks
gated-path PRs without one.

## Steps

1. **Determine the tier.** Diff the branch against `main`. Tier 3 = touches
   auth/RBAC, schema/migrations, remote-execution paths,
   `.github/`/`.claude/` enforcement config, or your regulated domain. Tier 2 = triggers any checklist gate (PII/LLM
   data-flow, audit-trail behavior, regulated data of record, control relevance) without a
   Tier-3 path. Tier 1 = neither → no CR file needed (inline PR block suffices);
   stop and say so.
2. **Copy the template** from `docs/change-record-template.md` to
   `docs/change-records/CR-YYYYMMDD-<slug>.md` (today's date, short slug).
3. **Fill §1** (summary, PR, spec/plan links, tier, blast radius — honest, this
   deploys to production on merge).
4. **Run the applicable gate agents** on the diff — security-architect,
   privacy-counsel, compliance-officer, domain-compliance,
   data-engineer (schema) — and paste each verdict into §3. Every
   gate row in §2 gets either a decision or `N/A: <one-line reason>`. An
   unexplained N/A is a defect.
5. **The human decides.** Present each agent verdict and ask the human for
   their decision per gate (ACCEPT / ACCEPT-WITH-RISK / REWORK). Never fill in
   the "My decision" column or the signature block yourself — the human types
   those. If a decision overrules an agent FAIL, §5 (risk acceptance) is
   mandatory.
6. **Fill §4** (CI links, coverage numbers, the repository maintainer (Tom Hanks / @BlackRaptorAI) approval link for Tier 3).
7. **Emergency changes:** if this is a retroactive CR for an emergency merge,
   mark Emergency = YES and complete §6 with the bypass details.

## Rules

- One CR per PR; slug matches the branch/slice name.
- The CR is written for a stranger reading it in 18 months.
- Agent analyses are evidence attached to a human decision — not the decision.
