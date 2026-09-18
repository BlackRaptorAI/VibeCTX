# RELEASING.md — pre-tag reconciliation checklist

Run this before cutting any release tag, after the last PR for the release has merged. **An
open PR at tag time is a decision, never an oversight.** Merge it, or record in the release
Change Record's §5 exactly which PR is deliberately deferred and why — never leave one open
silently and tag anyway.

Why this exists (PAR-831): the 2026-09-17 release nearly shipped with two finished, twice-reviewed,
CLEAN-reported PRs (PAR-811, PAR-747) left out of `main` — each had no worktree driving it to
merge, so nothing pushed it there — while eight follow-up issues had already been filed against
PAR-811's fix, and twenty milestone issues still read Todo in Linear while their code was
already merged. No CI check, branch-protection rule, or per-PR review gate catches this: each
gate checks its own PR correctly and never the set. It was caught by hand. This checklist is
the one control for checking the set.

## 1. Reconcile merged PRs against Linear

```
gh pr list --state merged --limit 50 --json number,headRefName,mergedAt
```

Branch names carry the PAR number (`par-<number>-<slug>`). For every merged PR in the release
window, confirm its Linear issue is `Done` or `Canceled` — not still `Todo`/`In Progress`.

## 2. Find stragglers — every open PR is a decision

```
gh pr list --state open
```

For each one: merge it now, or write into the release Change Record's §5 which PR is deferred
and why (e.g. "0.2.1, tracked as PAR-nnn"). An open PR the checklist didn't mention is the
failure mode this step exists to catch.

## 3. Reconcile the milestone against the repository

Every issue in the release milestone is `Done` or `Canceled`. Any whose Done-when was not
fully met says so plainly, with the reason and a revisit-by — the PAR-658 pattern: its
done-when ("correct section in top result improves over the current ranker") was recorded as
NOT MET, in the release Change Record's §5 (not a Linear comment), with the actual reason
(the eval corpus was GitHub READMEs, not the docs-site primaries the ranker was designed for
— not a gold-set problem) and a revisit-by (re-run the eval once the real corpus is reachable,
before any external ranking claim) — rather than being marked Done on a technicality or left
Todo with no explanation.

## 4. Re-measure after the last merge, not before

A number measured before the last PR landed describes a `main` that no longer exists. Record
these once, in the release Change Record — not as a `CLAUDE.md` baseline to check future runs
against (`CLAUDE.md` deliberately carries no such baseline; this is a point-in-time release
figure, not a regression gate):

- `npm test` — the test count and pass/fail, taken on `main` at the commit the release is
  actually cut from.
- `npm audit` and `npm audit --omit=dev` — record both; if they differ, say why the gap is (or
  isn't) an accepted risk, in the same release Change Record.

## 5. Version bump

`package.json`'s version bump happens in the release PR, on top of the reconciled `main` from
steps 1–3 above — not on an earlier commit taken before a straggler PR merged.
