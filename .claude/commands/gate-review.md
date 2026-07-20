---
description: Run the applicable gate agents on the current diff and produce a Change-Record-ready verdict block
---

Run gate reviews for the current branch's changes.

1. Get the diff: `git diff main...HEAD` plus the list of changed files
   (`git diff main...HEAD --name-only`).
2. Map changed files to gates (see docs/gate-enforcement-map.md):
   - auth/RBAC/tenant/remote-access/firmware paths → security-architect
   - personal data, LLM data-flow, cross-border → privacy-counsel
   - audit-trail, access-control, retention, change-mgmt → compliance-officer
   - regulated data of record → domain-compliance
   - your schema paths → data-engineer
   - automated/AI-driven/irreversible consequential actions (remote commands,
     auto-remediation, bulk operations) → operational-readiness
3. Invoke each applicable gate agent as a subagent with the diff and ask for
   its Change-Record-ready verdict (PASS / CONCERNS / FAIL with analysis).
   Run independent gates in parallel.
4. Output:
   - The risk tier of this change (Tier 1/2/3) with the deciding paths.
   - A gate table matching §2 of the Change Record template, verdicts filled,
     "My decision" column left blank for the human.
   - Each agent's full analysis in a §3-ready block.
   - If Tier 2/3: remind me to create the CR file (use the change-record skill)
     and, if Tier 3, that the repository maintainer (Tom Hanks / @BlackRaptorAI)'s approval is required.

Do not fill in human decisions or signatures. If no gate applies, say the
change is Tier 1 and no CR file is needed.

$ARGUMENTS
