# Branch Protection Checklist — Solo Author Mode

Target: `main` on `BlackRaptorAI/BlackRaptorAI/VibeCTX`.
Context: written for a solo coder (Released as an npm package (@blackraptorai/vibectx): a release is a version bump plus `npm publish`. There is no always-on production service and no merge-to-prod deploy — the published package IS the artifact, so tests and review are the safety net before publish);
GitHub blocks self-approval. Every setting below is chosen for that reality.

> GitHub offers two mechanisms: classic **branch protection rules** and newer
> **rulesets**. This checklist is written for classic branch protection
> (Settings → Branches). Rulesets can express the same things and add logged
> bypasses — noted where relevant. GitHub's UI changes; verify each toggle
> exists where described.

## Prerequisites (do these first)

- [ ] Create team **@BlackRaptorAI**, add **your second approver only**, grant
      write access to the repo.
- [ ] Install the kit's CODEOWNERS template as `.github/CODEOWNERS`.
- [ ] Install the kit's `change-record-required.yml` into `.github/workflows/` and let it
      run once on a test PR (a check must run at least once before GitHub lets
      you mark it "required").

## Settings — "Require a pull request before merging"

- [ ] **Require a pull request before merging: ON.** Direct pushes to `main`
      are the biggest single risk in a no-staging repo.
- [ ] **Required approvals: 0.** Not a typo. With 1+, every PR needs an
      approval you can't give yourself, so you'd be blocked on all work.
      the repository maintainer (Tom Hanks / @BlackRaptorAI)-gating comes from the next toggle, not this number.
- [ ] **Require review from Code Owners: ON.** With the sparse CODEOWNERS,
      only Tier-3 paths request the repository maintainer (Tom Hanks / @BlackRaptorAI); everything else merges without review.
      ⚠ **Verify with two test PRs**: (a) one touching only a non-gated path should be
      mergeable with green checks and no approval; (b) one touching
      a Tier-3 path should be blocked until the repository maintainer (Tom Hanks / @BlackRaptorAI) approves.
      If (a) is blocked, the 0-approvals + code-owners combination isn't
      behaving as expected on your plan/UI version — stop and reassess.
- [ ] **Dismiss stale pull request approvals when new commits are pushed: ON.**
      Otherwise you could get the repository maintainer (Tom Hanks / @BlackRaptorAI)'s approval, then push different code and
      merge. With this ON, that window closes — strong audit story.
- [ ] **Require approval of the most recent reviewable push: ON** (if shown).
      Complements the above for the same reason.

## Settings — status checks (Layer 1, where most enforcement lives)

- [ ] **Require status checks to pass before merging: ON.**
- [ ] **Require branches to be up to date before merging: ON.** In a
      deploy-on-merge repo, testing against stale `main` means deploying an
      untested combination.
- [ ] Mark **required**: your test/lint/typecheck/coverage checks,
      and **`change-record-required`** (the file-presence check).

## Settings — the rest

- [ ] **Require conversation resolution before merging: ON.** Cheap; makes
      the repository maintainer (Tom Hanks / @BlackRaptorAI)'s questions un-ignorable.
- [ ] **Require linear history: optional.** Nice for audit-trail readability;
      adopt if you already squash-merge.
- [ ] **Allow force pushes: OFF. Allow deletions: OFF.**
- [ ] **Require signed commits: optional but recommended** for a SOC 2 story —
      cryptographically ties commits to you. Skip if it adds friction you
      won't sustain.

## The "Do not allow bypassing the above settings" / include-administrators decision

You're an org admin, so this toggle decides whether the rules bind *you*.

- **Recommended: ON (rules bind admins), plus a documented emergency path.**
  If OFF, every control above is advisory for you, and an auditor will note it.
- Emergency path (prod down, the repository maintainer (Tom Hanks / @BlackRaptorAI) unreachable): temporarily disable the rule
  or use a ruleset bypass, merge the hotfix, re-enable, then within 24h file a
  retroactive Change Record marked **EMERGENCY** with what/why/when.
- If you use **rulesets** instead of classic rules, prefer them for exactly
  this: bypasses are logged automatically, giving you evidence instead of a
  hole.

## Verification (do all three before trusting the setup)

- [ ] Test PR touching a non-gated path → merges with green checks, no review.
- [ ] Test PR touching a Tier-3 path → blocked until the repository maintainer (Tom Hanks / @BlackRaptorAI) approves; approval
      dismissed if you push again.
- [ ] Test PR touching a gated path with no Change Record file → blocked by
      `change-record-required`.

## For your auditor (control description language)

Describe this as: *"Compensating controls for a single-developer environment:
(1) mandatory CI quality gates on all production changes; (2) documented
self-attestation Change Records for security/privacy/compliance review,
informed by automated analysis; (3) enforced second-person authorization on
high-risk code paths."* Confirm acceptability with your specific auditor —
SOC 2 permits compensating controls, but acceptance is auditor-specific.
