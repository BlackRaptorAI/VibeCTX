# Gate enforcement map (template)

For each review gate, record HOW it is enforced. Three honest categories:

- **Mechanical** — CODEOWNERS or a required CI check blocks the merge. Reliable.
- **Partial** — known paths are covered mechanically, but the concern is
  broader than those paths; the Change Record covers the rest.
- **Checklist-only** — a data-flow or behavioral property no path expresses
  (e.g. "does this send PII to the LLM"); only the Change Record covers it.

| Gate | Agent | Enforcement | Mechanism / paths | Gap covered by CR |
|---|---|---|---|---|
| Security — auth/authz | security-architect | Mechanical | none — VibeCTX has no authentication surface (a local stdio server with no user accounts or sessions) in CODEOWNERS + hook | New auth surfaces outside listed paths |
| Schema | data-engineer | Mechanical | the Zod tool-input schemas that define the MCP tool contracts (in `src/index.ts` and `src/registry.ts`) | — |
| CI/CD + enforcement config | devops-sre | Mechanical | `.github/`, `.claude/hooks/` | — |
| Privacy — PII at rest | privacy-counsel | Partial | none — VibeCTX processes public library documentation, not personal data | New PII fields elsewhere |
| Privacy — PII to LLM / cross-border | privacy-counsel | Checklist-only | — | Data-flow property |
| Domain (none — VibeCTX handles public developer documentation; it is not a regulated domain) | domain-compliance | Checklist-only until the module exists | (future none) | Eligibility/behavioral judgments |
| Compliance — control continuity | compliance-officer | Checklist-only | — | Behavior, not paths |
| Human oversight — HITL on consequential automated actions | operational-readiness | Checklist-only | — | Behavioral property: designed human checkpoint, fail-safe default, audited override |
| Quality — tests/coverage | qa-test-engineer | Mechanical | required CI checks | Test honesty (CR + review) |

Two structural limits that make the Change Record mandatory, not optional:
CODEOWNERS requires only ONE listed owner per matching line, and it sees paths,
not behavior. Keep this map in sync with the hook, CODEOWNERS, and the CI
GATED list whenever any of them changes.
