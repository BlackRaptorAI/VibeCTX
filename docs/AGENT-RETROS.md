# Agent Retros — the feedback loop for the agent team

Agent definitions are not finished documents; they are coaching records. When an
agent's output proves wrong in the real world, the miss gets logged here and the
agent's file gets amended — the same way you'd coach a human who missed
something. Without this loop, the same class of miss recurs forever and the
gate reviews decay into theater.

Install location: `docs/`. The log lives in this file; keep it in the repo so
it's versioned and auditable.

## What counts as a miss (triggers)

- A gate agent said PASS/APPROVE/COMPLIANT and a defect in that gate's domain
  shipped anyway (security bug, privacy exposure, broken control, bad MRV data,
  schema problem).
- `qa-test-engineer` passed a test suite that turned out to be tautological,
  over-mocked, or blind to the failure that occurred.
- An agent's FAIL/BLOCK was wrong in a costly way — repeated false alarms that
  trained you to ignore it are also a miss (crying wolf erodes the gate).
- An engineer agent repeatedly violates a convention its file already states
  (the instruction isn't landing — it needs restating, an example, or a check).
- An incident postmortem identifies something an agent reviewed and should have
  caught.

Routine imperfection is not a miss. Log the ones where you'd coach a human.

## The retro (10 minutes, not a ceremony)

1. **Reproduce the moment.** Re-run the agent on the same diff/spec it reviewed.
   Did it miss because of missing knowledge, missing instruction, missing
   context (it never saw the relevant file), or bad luck?
2. **Classify:**
   - *Instruction gap* → amend the agent's file (new rule, sharper wording, a
     concrete example of the failure).
   - *Context gap* → fix how the agent is invoked (what files/diff it's given),
     often in `principal-architect`'s routing or the runbook, not the agent.
   - *Knowledge gap* → add reference material (repo doc, checklist, standard)
     the agent is told to read, rather than prose in the prompt.
   - *Judgment/model limit* → note it; consider a stronger model for that agent
     or a second-agent cross-check on that class of change.
3. **Amend the file in a PR** (agent files under `.claude/agents/` — `.github/`
   isn't touched, so this is a normal Tier-1 change unless you gate it).
4. **Log it below.** One row per miss.

## Amendment rules

- Every amendment cites its retro row (date) in the PR description.
- Prefer adding a *concrete example of the failure* to the agent file over
  adding another abstract rule — examples steer models better than principles.
- If an agent's file grows past ~2 pages, prune: move reference detail into
  docs the agent reads, keep the prompt for judgment and boundaries.
- Review this log during the `compliance-officer` gate-compliance sweep: open
  rows older than a month mean the loop is broken.

## Retro log

| Date | Agent | What happened (PR/incident) | Root cause class | Amendment made (PR) | Verified by re-run? |
|---|---|---|---|---|---|
| — | — | — | — | — | — |
