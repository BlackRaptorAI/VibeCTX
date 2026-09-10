# `.vibectx-plan/` — planning scaffolding for the 0.2.0 release

**This folder is not product.** It is not shipped, not imported by anything in `src/`, and is
gitignored as of `a0852f2`. It describes the work; `src/` and `test/` are the work.

Written 2026-09-08 against `main` @ `a0852f2`. Mirrors the Claude project docs of the same names —
this folder exists because a Claude Code CLI session cannot reach a claude.ai project.

## Start here

> ## THE BUILD LOOP IS RETIRED — 2026-09-10. Do not start here.
>
> **`vibectx-build-session-go.md` is a RETIRED dispatch card. Do not read it first and do not execute
> it.** The relay of build sessions, go cards and handoff bundles that produced A1–A6 and A10 is no
> longer in use. It, the three phase go cards, both oversight handoffs, the build plan and both loop
> files all carry retirement banners.
>
> **Start with Linear instead: epic PAR-515 and the 0.2.0 milestone are the authority for open work.**
> This folder is history plus two live references — `CLAUDE.md` for the SHA and test count, and
> `change-records/` for the records themselves.

~~**`vibectx-build-session-go.md`** — the kickoff. Read it first.~~ **RETIRED — see above.**

## The eight planning files

| File | What it is |
|---|---|
| `vibectx-build-session-go.md` | **The go block.** Operating instruction for the build session. |
| `VibeCTX-020-phased-build-plan.md` | **The operating document.** Eight phases, each with a blocking test gate that has commands behind it. |
| `VibeCTX-scope-decision-2026-09-08.md` | **Scope.** What VibeCTX is, the five problems in scope, the non-goals, and **the claims the product may not make.** |
| `vibectx-build-loop-resume.md` | **Current state.** Repository facts, environment constraints, settled decisions. **Gate records go here.** |
| `VibeCTX-plan-revision-2026-09-08.md` | **The queue.** Per-item detail: problem, fix, files, done-when, gate routing, Change Record requirement. |
| `VibeCTX-audit-2026-09-08.md` | **The evidence** behind A1–A10, with file:line references, all re-verified at `a0852f2`. |
| `VibeCTX-context-layer-design-2026-09-08.md` | **Research.** Measured agent failure modes and the tooling landscape. **§1.4 lists widely circulated claims that do not survive scrutiny — read it before writing any number into a Change Record.** |
| `vibectx-build-loop-state.md` | **Decision archive.** ~~D-01–D-46~~ — **D-01–D-55 as of 2026-09-10** (MEASURED: highest in-file is D-55). **D-56 exists in `vibectx-build-loop-resume.md`, not here** — the archive and the record disagree about where decisions live, which is itself a PAR-754 item. **Retired as a live document 2026-09-10.** |

## Also here — rescued from the repository, 2026-09-08

These were removed from the repository and from its history. They are local-only now; nothing in
CI reads them.

- `change-records/` — **14 Change Records** (~~13~~ — MEASURED 2026-09-10, `ls change-records/CR-*.md`).
  **11 are unsigned**, 3 signed. New Change Records are written here. **Their 51 recorded gate
  conditions have never been triaged — PAR-753.**
- **`change-record-template.md` — LIVE. Use this one.** Copied verbatim 2026-09-08 from
  BlackRaptor Core 2.1.0's `change-record` skill (Golden @ `f66121a`, `_source/dist/public`).
  Re-copy from the skill if the pack updates; do not edit it here.
- `change-record-policy.md`, `change-record-template.RETIRED-pre-2.0.0.md`,
  `gate-enforcement-map.md`, `branch-protection-checklist.md` — **read these as history, not as
  instructions.** They describe a CI gate, a `GATED` path array and a verdict validator that no
  longer exist, and the retired template will fail the Stop-hook validator (D-53).
- `PRODUCT-STRATEGY.md`, `LAUNCH-STRATEGY.md` — internal strategy, never published.
- `scrub-paths.txt` — the exact path list `git filter-repo` removed.

## The four facts most worth not getting wrong

1. **`main` is at `839bfd7`** — RECONCILED 2026-09-10 (PAR-754 list 1), every figure re-derived
   from the repository. **207 commits, 80 tracked files, clean, pushed, 1202 tests passing across
   36 files**, CI green on Node 22. Nothing is stacked and there are no open pull requests.
   `273a8ca` differs from the scrub commit `a0852f2` in `.gitignore` alone, so every source
   citation written against `a0852f2` still resolves.
   ~~`main` is at `c9cc77e`, 174 commits, 75 tracked files, 1059 tests across 32 files.~~
   **That figure was accurate when written and went stale the same day.** `c9cc77e` is a real
   ancestor of `main`, but its own message reads *"chore: phase 0 handoff-path dry run (throwaway,
   safe to discard)"* — **a throwaway dry-run commit was recorded as the project's baseline.**
   **This section is titled "the four facts most worth not getting wrong," and fact 1 was wrong.**
   Fact 2 below was re-verified 2026-09-10 and is correct: `79c270c` is on no branch and no ref
   contains it (`git merge-base --is-ancestor` → false; `git for-each-ref --contains` → empty). It
   still resolves in a local clone only as an unreachable object that has not been garbage-collected.
   **Authority for these numbers is `CLAUDE.md`'s test-baseline line, not this file.** Per PAR-754,
   a document that restates a fact is a document that will eventually contradict it.
2. **`79c270c` no longer exists.** History was rewritten on 2026-09-08 and force-pushed. Any
   document, Linear issue or note citing it is stale. A pre-scrub backup of everything is at
   `~/vibectx-pre-scrub-backup.bundle`.
3. **No agent session can push to this repository.** Every push is Tom's, from his own terminal.
4. **A phase does not end when its items merge.** It ends when its gate is green and the evidence
   is written into `vibectx-build-loop-resume.md`. That rule is the whole point of the plan.
