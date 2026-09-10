# Change Record — CR-20260720-install-dev-team

## 1. Change summary

| Field | Value |
|---|---|
| CR ID | CR-20260720-install-dev-team |
| Repo | BlackRaptorAI/VibeCTX |
| Author | Tom Hanks (BlackRaptor AI) |
| Date | 2026-07-20 |
| Risk tier | Tier 2 (adds `.claude/` agent roster, `.github/` CI gate, governance docs — no product-source `src/` change) |
| Emergency? | No |

**What changed and why:**

Installs the **BlackRaptor Agents — development team** into VibeCTX for future
coding, from the public template
[`BlackRaptorAI/BlackRaptor_Agents`](https://github.com/BlackRaptorAI/BlackRaptor_Agents/tree/main/development)
(which already carries the Excellence Pass / Agent Operating Standard). Landed:

- **`.claude/agents/` — 23 dev agents** (opus ×12, sonnet ×11; no `fable` — the
  public template tops out at `opus`). Each charter carries one tier-appropriate
  **Output-quality discipline** line (the Excellence Pass).
- **`.claude/skills/` — 7 skills** including `excellence-pass`, plus
  `change-record`, `enforcement-liveness`, `gate-verdict-format`, `stride-review`,
  `owasp-llm-checklist`, `expand-contract-migration`.
- **`.claude/hooks/protect-tier3.py` + `settings.json`** — the Tier-3 write-guard
  (smoke-tested: blocks `package.json` and `.claude/settings.json` edits without
  `ALLOW_TIER3=1`, allows normal `src/` edits).
- **`.github/`** — `change-record-required` CI gate + PR template.
- **`docs/`** — `agent-operating-standard.md`, governance templates, `AGENT-RETROS.md`,
  eval convention, and `specs/` `plans/` `change-records/` dirs.

**VibeCTX-specific customization (Excellence Pass — enforce the real contract):**
All ~154 template placeholders were filled with VibeCTX's actual facts (a
headless TypeScript MCP server that caches library docs; npm-published; no
database, no UI, no edge, no PII, no regulated domain).

**Roster trim — 7 dormant stubs.** Seven roles cover surfaces VibeCTX does not
have — `edge-agent-engineer` (no hardware), `frontend-engineer` / `ux-designer`
(headless, no UI), `ai-ml-engineer` (ships no model), `data-engineer` (only a
disk cache), `domain-compliance` (no regulated domain), `privacy-counsel` (no
PII). Rather than ship charters full of "N/A", these were replaced with clean
**dormant-role stubs** that keep the role in the roster, retain the tier +
Output-quality line, and point to the full template to restore if scope grows.
The 16 applicable roles carry full, VibeCTX-customized charters.

**Tier-3 gated paths for VibeCTX:** `.github/`, `.claude/`, and `package.json`
(supply chain / publish). `src/fetcher.ts` (SSRF) and `src/cache.ts` (path
handling) are security-review-sensitive by convention but NOT hard-gated, to
keep everyday coding friction-free. Hook and CI GATED list are in sync.

**Blast radius if wrong:** developer-workflow tooling only; no change to
`src/`, the published package, or runtime behavior.

## 2. Gate decisions

| Gate | Applies? | Verdict | Decision | Initials + date |
|---|---|---|---|---|
| Security (Tier-3 guard correctness, no secret exposure) | Yes | Hook smoke-tested live (block/allow both verified); no secrets added | ACCEPT | TH 2026-07-20 |
| Supply chain | Yes | No dependency change; `package.json` now Tier-3-gated | ACCEPT | TH 2026-07-20 |

## 3. Verification

- 0 unfilled `{{PLACEHOLDER}}` tokens remain across `.claude/`, `docs/`, `.github/`.
- 23 agents, each with exactly one tier-matched Output-quality discipline line.
- No Paragon-specific identifiers leaked into VibeCTX (scanned).
- Tier-3 hook: BLOCKS `package.json` / `.claude/settings.json` without the flag
  (exit 2), ALLOWS with `ALLOW_TIER3=1` and for normal `src/` files (exit 0).
- No `src/` product code changed; build unaffected.

## 4. Deviations & risk acceptance

Roster trim to dormant stubs (§1) is a deliberate scope decision, not a defect —
recorded here so the full roster can be restored per-role if VibeCTX grows.

## 5. Sign-off

> I reviewed the installation and customization and take responsibility for the
> decisions recorded above.

**Signed:** TH (Tom Hanks, BlackRaptor AI) — signature authorized in-session 2026-07-20  **Date:** 2026-07-20
