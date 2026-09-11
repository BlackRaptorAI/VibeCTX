# `.vibectx-plan/go/` — LIVE per-item dispatch documents

**These are not the retired phase go cards.** `vibectx-build-session-go.md`,
`vibectx-phase2-go.md`, `-phase3-`, `-phase4-` and the two oversight handoffs in the parent
directory are **RETIRED** — they describe the build-loop relay that was stopped on 2026-09-10 and
they carry retirement banners. Do not execute them.

**This folder is different and it is live.** One document per work item, written by the oversight
seat, read by a build session. Created 2026-09-11 (D-69) so a dispatch is a versioned artefact in
the repository rather than a wall of text in a chat window.

## How a dispatch works

1. Oversight writes `go/<ITEM>-<PAR-nnn>.md` here and commits it.
2. Tom pastes a **short** block into the build session naming this path and the validation
   baseline.
3. The build session reads the document in full, works, and reports back through Tom.

## The rules every document here follows

- **It names the commit its line numbers were validated against** (D-66), and step 0 proves
  `src/` and `test/` are unchanged since — **not** that `HEAD` equals that commit. Documentation
  commits move `HEAD` without invalidating a single code citation.
- **Every number carries the command that produced it** (D-67).
- **Anything resting on a language or runtime rule has been run, not reasoned** (D-68), with the
  output pasted in.
- A document is superseded by editing it in place and committing. **The git history is the trail** —
  there is no second copy to drift.
