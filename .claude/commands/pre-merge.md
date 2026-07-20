---
description: Pre-merge check — code review, Change Record completeness, slicing discipline, CI readiness
---

Run the pre-merge sequence on the current branch.

1. Use the code-reviewer subagent on `git diff main...HEAD`: conventional
   commits, PR hygiene, conventions (Zod, shared constants, AuditEvent writes,
   no secrets/PII in code or logs), slicing discipline (deployable on its own,
   flags on user-visible surfaces, no destructive migration with dependent
   code), and gate/CR completeness.
2. Verify mechanically:
   - Tests/lint/typecheck pass locally for affected packages.
   - If any gated path is touched: a docs/change-records/CR-*.md exists in this
     branch, every gate row is decided or explained-N/A, §5 filled where a
     verdict was overruled, signature block signed.
   - If Tier 3: flag that the repository maintainer (Tom Hanks / @BlackRaptorAI)'s approval will be required on the PR.
3. Report: **READY TO OPEN PR** or a blocking list with file/line specifics.
   If gate reviews are missing, tell me to run /gate-review first.

Do not open the PR or merge anything yourself.

$ARGUMENTS
