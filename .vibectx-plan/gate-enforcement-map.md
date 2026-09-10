> **RETIRED 2026-09-08 — HISTORICAL REFERENCE ONLY.**
>
> The CI enforcement this map described was removed from the repository and its history by
> `a0852f2`. Nothing here is wired to anything. Enforcement now lives in the BlackRaptor Core 2.1.0
> `Stop` hook, which validates gate verdicts in-session on the live path. See **D-52**.

# Gate enforcement map (template)

For each review gate, record HOW it is enforced. Three honest categories:

- **Mechanical** — CODEOWNERS or a required CI check blocks the merge. Reliable.
- **Partial** — known paths are covered mechanically, but the concern is
  broader than those paths; the Change Record covers the rest.
- **Checklist-only** — a data-flow or behavioral property no path expresses
  (e.g. "does this send PII to the LLM"); only the Change Record covers it.

| Gate | Agent | Enforcement | Mechanism / paths | Gap covered by CR |
|---|---|---|---|---|
| Security — auth/authz | security-architect | N/A | not applicable to VibeCTX (local single-user CLI/MCP tool: no UI, no accounts, no tenancy, no PII, no regulated data, no fleet) | — |
| Security — outbound request guard (SSRF) | security-architect | Mechanical | `src/fetcher.ts`, `src/link-policy.ts` in the CI `GATED` list. **Not** the in-session hook: `.claude/hooks/protect-tier3.py` deliberately does not block these two (its own comment says so), so everyday coding stays friction-free — CI is the enforcement of record | — |
| Security — cache/index integrity (paths, atomic writes, derived cache) | security-architect | Convention-routed | `src/cache.ts`, `src/atomic-store.ts`, `src/search-index.ts` — routed to the gate by whoever dispatches the review (build-loop state file `## roles`), **not** by CI | Everything: no CI check fires. Accepted cost, see `.vibectx-plan/change-record-policy.md` |
| Schema | data-engineer / schema-reviewer | Convention-routed | no database — the schemas are the zod tool-input schemas in `src/index.ts`, the `vibectx.config.json` shape in `src/registry.ts`, and the on-disk record shapes (`projects/*.json`, `resolved.json`, `index.json`). **None of those paths is in the CI `GATED` list**, so nothing mechanical fires on a schema change; it reaches the gate because whoever dispatches the review routes it (build-loop state file `## roles`) | Everything: no CI check fires on these paths |
| CI/CD + enforcement config | devops-sre | Mechanical | `.github/` and **all of** `.claude/` in the CI `GATED` list. The in-session hook blocks a deliberate subset of that — `.claude/hooks/`, `agents/`, `commands/`, `skills/` and `settings.json` — and `package.json` | — |
| Privacy — PII at rest | privacy-counsel | Partial | none — the tool stores only public documentation and never collects telemetry | New PII fields elsewhere |
| Privacy — PII to LLM / cross-border | privacy-counsel | Checklist-only | — | Data-flow property |
| Domain (not applicable to VibeCTX (local single-user CLI/MCP tool: no UI, no accounts, no tenancy, no PII, no regulated data, no fleet)) | domain-compliance | Checklist-only until the module exists | (future not applicable to VibeCTX (local single-user CLI/MCP tool: no UI, no accounts, no tenancy, no PII, no regulated data, no fleet)) | Eligibility/behavioral judgments |
| Compliance — control continuity | compliance-officer | Checklist-only | — | Behavior, not paths |
| Human oversight — HITL on consequential automated actions | operational-readiness | Checklist-only | — | Behavioral property: designed human checkpoint, fail-safe default, audited override |
| Quality — tests/coverage | qa-test-engineer | Mechanical (see the caveat below) | `.github/workflows/ci.yml` — `npm run lint`, `npm test`, `npm run build` on every PR | Test honesty (CR + review) |

**Caveat on every "Mechanical" row above.** A CI job only *blocks* a merge once it is marked
a required check in branch protection. `.vibectx-plan/branch-protection-checklist.md` still carries
both "mark the test/lint checks required" and "mark `change-record-required` required" as
unchecked, and `.github/CODEOWNERS` is not present in this repo either. Until those are done,
every row above reports rather than blocks. That is a setting on the repository, not a change
to any file here, so it cannot be closed from a PR — but the map must not read as though it
had been (PAR-652c, schema K1).

**What the in-session hook is, and is not.** `.claude/hooks/protect-tier3.py` blocks edits
inside an agent session. It is bypassable by construction (its own docstring says so) and its
list is a deliberate SUBSET of the CI `GATED` array — it does **not** cover `src/fetcher.ts`
or `src/link-policy.ts`. Do not cite it as the enforcement for any row; it is accident
prevention layered on top of CI.

Two structural limits that make the Change Record mandatory, not optional:
CODEOWNERS requires only ONE listed owner per matching line, and it sees paths,
not behavior. Keep this map in sync with the hook, CODEOWNERS, and the CI
GATED list whenever any of them changes.

**When a Change Record is required at all** — one per tagged release, plus one
per PR touching a gated path — is written down once in
[`.vibectx-plan/change-record-policy.md`](change-record-policy.md), which also carries the
gated-path table and the reasoning for what is deliberately left out of it
(oversight decision D-44). That policy, the `GATED` array in
`.github/workflows/change-record-required.yml`, and this map are three copies of
one list; if they disagree, the workflow is authoritative for CI and the policy
is authoritative for intent.

A **convention-routed** row is honest about being weaker than "Partial": the
concern has named paths, but nothing mechanical fires on them. It depends on the
dispatcher remembering.
