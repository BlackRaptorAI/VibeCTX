> **RETIRED 2026-09-08 — HISTORICAL REFERENCE ONLY. DO NOT CITE THIS FILE AS AUTHORITY.**
>
> This policy and everything it describes were removed from the VibeCTX repository **and from its
> history** by commit `a0852f2`: `.github/workflows/change-record-required.yml`,
> `.github/gate-verdict-format/`, the `GATED` path array, and the gate-enforcement map.
> **No path is gated. No CI check requires a Change Record.** A gate that cites this file's gated
> list as evidence — "`src/config.ts` is absent from GATED, therefore no CR" — is reasoning from a
> control that does not exist. The conclusion may still be right; the justification is not.
>
> **What is live instead.** Verdicts are validated in-session by the `Stop` hook shipped in
> BlackRaptor Core 2.1.0. Change Records are written locally to `.vibectx-plan/change-records/`.
> A Change Record is expected for a tagged release, and for any item touching URL trust, fetching
> or cache integrity — enforced by the build plan's phase gates, not by GitHub. See **D-52** and
> **D-53** in `vibectx-build-loop-state.md`.
>
> Kept only so the reasoning behind past decisions stays readable.

# Change-record policy (VibeCTX)

**Why this file exists separately.** `docs/agent-operating-standard.md` is a portable
standard — it is written to be copied into other repositories. This is the opposite: it is
the rule for *this* repository only, and it is the text the CI gate
(`.github/workflows/change-record-required.yml`) and `.vibectx-plan/gate-enforcement-map.md` are
kept in sync with.

VibeCTX is a local, single-user CLI/MCP tool: no accounts, no tenancy, no PII, no fleet, no
production deploy. The blast radius of a normal change is one developer's cache directory.
Governance sized for a multi-tenant service would make every retrieval tweak a paperwork
exercise, and a gate that fires on everything is a gate nobody reads.

## The rule

A Change Record (`.vibectx-plan/change-records/CR-YYYYMMDD-<slug>.md`) is required in exactly two
cases:

1. **One CR per tagged release**, covering the supply-chain concerns of that release:
   version bump, dependency and lockfile changes, `files`/`bin`, and what a user who
   checks out that tag will build and run. VibeCTX is distributed as source — users clone
   this repository and build it — so a tag IS the release; there is no publish step and no
   registry artifact to review.
2. **One CR per pull request that touches a gated surface** — the paths in the `GATED`
   array of `.github/workflows/change-record-required.yml`, which is the machine-readable
   form of the list below.

Everything else — a new tool, a ranking change, a README rewrite, a test-only PR — needs no
Change Record. It still needs tests, `npm run lint`, and review; the CR is not the review.

## The gated surfaces (oversight decision D-44, 2026-09-06)

| Path | Why it is gated |
|---|---|
| `.github/` | The enforcement mechanism itself. A PR that can edit the gate can remove the gate. |
| `.claude/` | The agent charters and hooks — same argument. Kept in the list for the day it is tracked again; it is gitignored and local-only today, so it cannot appear in a PR. The verdict checker it used to hold moved to `.github/gate-verdict-format/` on 2026-09-08 and is covered by the row above. |
| `package.json` | Supply chain: dependencies, `files`, `bin`, version, publish scripts. |
| `src/fetcher.ts` | The SSRF guard: redirect pre-flight, https/host policy, byte caps. Every outbound request in the product goes through it. |
| `src/link-policy.ts` | The allowed-host decision `src/fetcher.ts` enforces. Gated with it, because the guard is only as good as the policy it calls. |

**Deliberately NOT gated: `src/cache.ts`, `src/atomic-store.ts`, `src/search-index.ts`.**
They are integrity-bearing (path handling, atomic writes, a derived cache the model reads
from), and the gate map routes them to `security-architect` **by convention** — the reviewer
routing rule, not a CI check. Hard-gating them would put a Change Record on every retrieval
and caching change, which is the over-governance this policy exists to remove. The
convention route is recorded in `.vibectx-plan/gate-enforcement-map.md` and in the build loop's
state file (`docs/plans/vibectx-build-loop-state.md`, `## roles`).

The honest limitation: a convention route is enforced by whoever dispatches the review, not
by CI. If a cache or index change lands without a security review, nothing fails — that is
the accepted cost of the trade, and it is why the two files that carry the *network* trust
boundary stay hard-gated.

## What a CR must contain

`.vibectx-plan/change-record-template.md` is the shape. The CI gate additionally requires at least
one machine-validated verdict block per CR
(`.github/gate-verdict-format/validate_verdict.py --require`, run from the base ref). That
checker and its schema live in the repository under `.github/`, which is a gated path, so
changing the checker is itself a gated change; `--self-test` runs its fixtures in CI.
A gated PR whose CR carries zero verdict blocks fails: a missing gate is treated as a FAIL,
not as a silence.

## Keeping the three copies in sync

The gated list exists in three places and they must agree:

1. `.github/workflows/change-record-required.yml` — the `GATED` array (authoritative for CI).
2. `.vibectx-plan/gate-enforcement-map.md` — the per-gate enforcement table.
3. This file's table.

Changing any one of them is itself a `.github/` or `.claude/` change, so it carries a Change
Record by rule 2 — the list cannot be widened or narrowed silently.

## Release status reporting

`scripts/metrics.mjs` prints a short status block (the repository's open-issue, star and
fork counts) for a human to paste into the tracker. It reports no install count: source
distribution makes clones unobservable without push access to the repository, and the
script says so rather than substituting a number that measures something else. It is deliberately not wired to a schedule or to an issue tracker: a new
workflow is a `.github/` change, and this policy's whole purpose is to not add governance
machinery that nobody asked for. Run it by hand:

```
node scripts/metrics.mjs
```

It degrades honestly — an unreachable endpoint and a missing field are both reported as
such, never as a zero.

---

*Owner: oversight (the build-loop main session). Last reviewed 2026-09-07 (source distribution).*
