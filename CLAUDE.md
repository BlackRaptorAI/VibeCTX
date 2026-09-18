# VibeCTX — CLAUDE.md

VibeCTX is a local MCP (Model Context Protocol) server. It fetches official library docs
(llms.txt first), caches them on disk, and serves the relevant sections to coding agents —
offline, deterministic, no recurring cost. MIT licensed.

## Commands

```
npm ci
npm run build   # tsc -> dist/
npm test        # vitest run   (needs Node ^20.19.0 || ^22.12.0 || >=24.0.0; CI runs the ends, R-1/PAR-829)
npm run lint    # tsc --noEmit
```

## How we work (lean loop — D-70)

1. Take one issue from the Linear **0.2.0** milestone. Its **Done when** section is the spec.
2. Branch `par-<number>-<slug>` off `main`. Independent issues may run in parallel git worktrees.
3. Write the failing tests first, then the code. `npm run lint && npm test` must be green.
4. Review once, on the diff, in a fresh subagent:
   - always `code-reviewer`
   - also `security-architect` if the change touches URL/host policy, fetching, redirects,
     config URL handling, the cache or search index on disk, or any file delete/rename.
   Fix blocking findings. File everything else as a Linear issue. No second round unless the
   first found something blocking.
5. Before pushing: `git fetch origin && git diff --stat origin/main HEAD` (two dots, not
   three — three-dot hides exactly the failure this catches). Confirm by eye that it deletes
   nothing belonging to another item — a branch that fell behind `main` can otherwise look, at
   merge time, like it reverts work someone else just landed (this has happened).
   Push the branch and open a PR. The PR description holds: what changed, each Done-when line
   marked met / not met, the review findings (paste them), and that `git diff --stat` output.
   Link the PR on the Linear issue.
6. **Never merge and never push to `main`.** Tom merges (squash).
   To bring a PR branch up to date: `git fetch origin && git merge origin/main`, fix conflicts,
   re-run lint + tests, push. Merge, don't rebase — force-push is blocked.
7. If a Done-when is wrong or can't be met, say so in the PR and move on. Tom decides.

Before cutting a release tag, see `RELEASING.md` — a merged-and-reviewed PR is not yet a
released one, and that gap has bitten this repo.

Not used on this repo: per-item Change Records, verdict JSON blocks, phase gates, go blocks,
handoff bundles, test-count baselines, MEASURED annotations. CI is the record of test results.
One Change Record is written per release.

## Rules that still matter

- Source-only distribution. Install is `git clone && npm ci && npm run build && npm link`.
  Never suggest `npm install`/`npx` for VibeCTX — npm 0.1.2 is stale and can't be updated.
- Offline and deterministic: no embeddings, no network at query time. BM25 over heading-split
  markdown.
- Honest output: stale cache is served flagged `STALE:`; fallbacks are stated, never silent.
- Security invariants (do not weaken): https-only URLs; every library URL and redirect clears
  `src/link-policy.ts` host policy; internal hosts only via `allowInternalHosts`; symlinks are
  refused, never followed, in discovery, config walk-up and cache eviction; response bodies and
  inputs are bounded.
- Producers edit `src/`, `test/`, `docs/`, `README.md`, `RELEASING.md`. Ask before touching
  `.github/` or `package.json`.
- Product decisions get one line in `.vibectx-plan/DECISIONS.md`. Process notes do not.
- Pick the D-number after your last `git fetch origin` (step 5), right before opening the PR —
  never when the work starts. Two sessions can still both fetch before either has opened a PR
  and pick the same next number; if that happens, whichever merges second renumbers before
  merging. Has collided three times: D-71, D-76, D-78.

## Scope and claims

VibeCTX is a documentation cache. It does not do conversation memory, spec writing,
architecture-rule checking, code symbol search, task tracking, or project-rules payloads.

Public text may claim only: it flags invented package names, and it serves the docs for the
version you pinned. Never claim it keeps agents on task, prevents drift or scope creep, or stops
hallucination in general. Don't cite the "19% slower" study, "AI degrades architecture", or a
"2026 Stack Overflow survey".
