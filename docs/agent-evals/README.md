# Agent evals — proactive quality checks for agent definitions

The `docs/AGENT-RETROS.md` loop is **reactive**: it fires after an agent misses
in production. This directory adds the **proactive** half: a small, fixed eval
set per agent that you run *when you change that agent's definition*, so a
regression is caught before it ships a miss. Evals prevent; retros correct.

This is a convention + templates, not a running service. You execute the evals
in a Claude Code session (the bundled `skill-creator` skill can run and score
them with variance analysis, or you can run them manually and judge the output).

## When to run

- Any PR that amends an agent file in `.claude/agents/` (including retro-driven
  amendments) should run that agent's eval set and record the result in the
  Change Record / PR.
- Optionally, run the full suite before a release as a roster health check.

## What an eval is

One YAML/markdown file per agent under `agent-evals/<agent-name>.md`, containing
3–6 **cases**. Each case is:

- **input** — a realistic prompt/diff the agent would receive.
- **expect** — the properties a good response must have (a checklist, not an
  exact string): the right verdict, specific evidence cited, the required
  boundary honored, the CR-ready format, etc.
- **anti** — failure signals that should NOT appear (rubber-stamp PASS with no
  evidence, asserting unverified regulation as fact, scope-creep, etc.).

## How to score (lightweight)

For each case, the response either **meets** the `expect` checklist and avoids
the `anti` signals (pass) or not (fail). For stochastic confidence, run each
case 3–5 times and record the pass rate (variance matters more than a single
run — a gate agent that passes 3/5 is not reliable). Record in the PR:

```
agent: security-architect  ·  eval date: 2026-01-15
cases: 4  ·  runs/case: 5  ·  pass-rate: 19/20 (95%)
regressions vs last: none
```

## Priority

Gate agents first (security-architect, privacy-counsel, compliance-officer,
domain-compliance, data-telemetry schema, red-team-reviewer) — their misses are
the most expensive. Engineer and advisory agents can follow.

See `security-architect.md` in this directory for a worked example.
