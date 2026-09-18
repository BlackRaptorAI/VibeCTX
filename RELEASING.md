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
4. **`.vibectx-plan/DECISIONS.md`.** Only for a standing constraint with no expiry of its
   own — e.g. no external ranking claim until a gold set is re-labelled. A decision, not a
   status.
5. **The tracker (Linear).** Discoverability, not authority. An issue POINTS AT levels 1–4
   rather than restating their content — two independent prose copies of the same fact is how
   they drift apart from each other.

Every issue in the release milestone is `Done` or `Canceled`. Any whose Done-when was not
fully met records why at the strongest level available, and the milestone issue points at that
record rather than repeating it.

**Worked example — PAR-658.** Its done-when (PAR-658: `"correct section in top result"`
improves over 0.1.2) is recorded NOT MET. What actually settled why is level 2, not level 3 or
5: `docs/eval/probe-gold.json`'s own `provenance` field states "hand-labelled against GitHub
README fallbacks on 2026-09-06; docs-site llms.txt unreachable from the build sandbox" — the
gold set's LABELS were hand-written against README fallbacks because the real docs-site
documents were unreachable at labelling time. The EVAL CORPUS is those real docs-site
`llms-full.txt` documents, reachable now — the corpus is not the problem; the labels are,
because they describe different documents than the corpus they are graded against today. That
is exactly why the project's own remediation, PAR-827, is a RE-LABEL of the gold set, not a
re-fetch of the corpus. Revisit-by is not running the eval again now that the corpus is
reachable — it already is, and re-running it unchanged fixes nothing. The actual revisit-by is
PAR-827: re-label `probe-gold.json` against the real corpora, extend the validator (level 1) to
refuse when a resolved URL disagrees with the corpus its gold set declares, then re-run. No
external ranking claim ships before that.

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
