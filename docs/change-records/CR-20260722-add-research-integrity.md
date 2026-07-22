# Change Record — CR-20260722-add-research-integrity

## 1. Change summary

| Field | Value |
|---|---|
| CR ID | CR-20260722-add-research-integrity |
| Repo | BlackRaptorAI/VibeCTX |
| Author | Tom Hanks (BlackRaptor AI) |
| Date | 2026-07-22 |
| Risk tier | Tier 2 (adds `.claude/` agent + skill; no product-source `src/` change) |
| Emergency? | No |

**What changed and why:**

Brings the agent kit current with the upstream template
[`BlackRaptorAI/BlackRaptor_Agents`](https://github.com/BlackRaptorAI/BlackRaptor_Agents/tree/main/development).
Since the `CR-20260720-install-dev-team` install, upstream added the
**research-integrity** capability — the roster went 23 → 24 agents and the skill
set 7 → 8. This CR pulls both into VibeCTX.

- **`.claude/agents/evidence-auditor.md`** — the independent adversarial gate for
  research, analysis, and evidence-based reporting (the research analog of
  `red-team-reviewer` / `completion-auditor`). Read/analysis-only: grades sources
  (reliability × credibility), collapses citation chains to independent origins
  (effective-N / anti-woozle), separates root-veracity from root-reachability,
  checks qualifier drift, enforces a release gate — PASS / CONCERNS / FAIL.
- **`.claude/skills/research-integrity/`** — the three-mode research methodology
  engine (evidence synthesis · direct-source aggregation · original primary
  research) with intake triage, source × evidence grading, citation-independence +
  consilience, root-to-mechanism verification, a release gate, and analytic-judgment
  output. Ships `SKILL.md` + `templates.md` (fillable artifacts). `evidence-auditor`
  is its HEAVY-tier reviewer, which is why the two land together.

The generic upstream editions are used (no Paragon/golden content); no VibeCTX
customization was required — both are domain-neutral methodology, not stack-specific,
so they apply as-is even to the roles kept as dormant stubs at install.

**Tier-3 gated paths touched:** `.claude/` only. No `.github/` or `package.json` change.

**Blast radius if wrong:** developer-workflow tooling only; no change to product
source, the build, the published `@blackraptorai/vibectx` package, or runtime behavior.

## 2. Gate decisions

| Gate | Applies? | Verdict | Decision | Initials + date |
|---|---|---|---|---|
| Security (no secret exposure, read-only reviewer) | Yes | `evidence-auditor` is read/analysis-only; no secrets added | ACCEPT | TH 2026-07-22 |
| Supply chain (published npm package) | Yes | No dependency, `package.json`, or publishable-source change; `.claude/` only | ACCEPT | TH 2026-07-22 |

## 3. Verification

- 0 unfilled `{{PLACEHOLDER}}` tokens in the added files (verified — generic methodology).
- No Paragon / `governed-agents` / golden-source leakage in either file (scanned).
- Agent roster now 24 (was 23); skill set now 8 (was 7): adds only `research-integrity`.
- `evidence-auditor` carries only read/analysis tools (Read, Grep, Glob, WebSearch,
  WebFetch, Task*) — no write/exec — consistent with the read-only-reviewer policy.
- No product source changed; the published package is unaffected.

## 4. Deviations & risk acceptance

None. Both additions are generic methodology and apply to VibeCTX as-is.

## 5. Sign-off

> I reviewed the addition and take responsibility for the decisions recorded above.

**Signed:** _PENDING — TH review_  **Date:** _______
