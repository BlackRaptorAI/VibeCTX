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
and why (e.g. deferred to 0.2.1, tracked as PAR-nnn). An open PR the checklist didn't mention
is the failure mode this step exists to catch.

## 3. Where a finding belongs, strongest first — then reconcile the milestone against it

Prose is the fallback, not the goal. Where a tool can be made to refuse rather than merely
warn, file that enforcement change instead of a warning a future reader has to find and
believe. A finding that lives only in prose is exactly how PAR-653's own blocker stayed
invisible while its own issue body still told readers to run the probe, and PAR-746 records
the general class: a finding that exists only in a comment, a code comment, or a chat relay is
not a tracked finding.

Strongest to weakest:

1. **Enforced in code, at the point of use.** Where a tool can refuse to produce a misleading
   result, that IS the record — nobody has to remember it or read it to be protected by it.
2. **In the data.** A provenance or metadata field that travels with the artifact itself, so
   anyone reading the artifact reads the caveat with it.
3. **The release Change Record, §5.** The release-time status: what shipped with its done-when
   unmet, and why. Versioned with the tag; what an auditor opens later.
4. **`.vibectx-plan/DECISIONS.md`.** Only once a finding stops being a one-release status and
   becomes a standing constraint with no expiry of its own — hypothetically, "no external
   ranking claim ships until a gold set is re-labelled" would belong here, though as of this
   writing that constraint is recorded only in the Change Record (§5) below, not yet promoted.
   A decision, not a status.
5. **The tracker (Linear).** Discoverability, not authority. An issue POINTS AT levels 1–4
   rather than restating their content — two independent prose copies of the same fact is how
   they drift apart from each other.

Every issue in the release milestone is `Done` or `Canceled`. Any whose Done-when was not
fully met records why at the strongest level available, and the milestone issue points at that
record rather than repeating it.

**Worked example — PAR-658.** Its done-when (PAR-658: `"correct section in top result"`
improves over 0.1.2) is recorded NOT MET. Level 2 is what a reader of the artifact itself would
see first: `docs/eval/probe-gold.json`'s own `provenance` field states "hand-labelled against
GitHub README fallbacks on 2026-09-06; docs-site llms.txt unreachable from the build sandbox" —
the gold set's LABELS were hand-written against README fallbacks because the real docs-site
documents were unreachable at labelling time. (The file's own `corpus` field says the same
thing, frozen at that same labelling-time snapshot — it describes what was fetched on
2026-09-06, not what the eval fetches when re-run today, so read it as historical, not current.)
The EVAL CORPUS, when the script is actually re-run, is those real docs-site `llms-full.txt`
documents — reachable from a machine with real network access (PAR-827: "the eval was run for
the first time from Tom's Mac, where the real documents ARE reachable"), still NOT reachable
from the build sandbox itself. The corpus is not the problem; the labels are, because they
describe different documents than the corpus they are graded against today. Level 3, the
release Change Record, is where that conclusion is actually written down as the release-time
status (`CR-20260917-release-0.2.0.md` §5) — level 2 is the evidence it cites, not a
freestanding record of the conclusion on its own.

That mismatch is exactly why the project's own remediation, PAR-827, is a RE-LABEL of the gold
set, not a re-fetch of the corpus. Revisit-by is not running the eval again now that a machine
capable of reaching the corpus exists — one already does, and re-running it unchanged fixes
nothing. The actual revisit-by, per PAR-827's own Fix section, is: re-label `probe-gold.json`
against the real corpora, then re-run `scripts/eval-retrieval.mjs` and post the result to
PAR-658. No external ranking claim ships before that. (A stronger fix than re-labelling alone,
not yet filed: extend the validator to refuse when a resolved URL disagrees with the corpus its
gold set declares — level 1 of the hierarchy above — so this class of mismatch can't recur
silently. That is a proposal, not something PAR-827 currently commits to.)

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
