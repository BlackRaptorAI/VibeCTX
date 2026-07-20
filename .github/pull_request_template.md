## Summary

<!-- What changed and why, 2-4 sentences. Link the spec/plan. -->

## Test plan

<!-- How this was verified. -->

## Change Record (inline — Tier 1 only)

**Risk tier:** Tier 1 — no gated paths touched
**Spec/plan:** docs/specs//____ · docs/plans//____

### Gates
<!-- Delete lines that don't apply, but explain any deletion in one clause.
     Tier 2/3: delete this whole section and use the full CR file in
     docs/change-records/ instead — CI enforces it on gated paths. -->
- [ ] Security — N/A (no auth/tenant/remote-access surface) — or: agent verdict ____, my decision ____
- [ ] Privacy — N/A (no personal data touched) — or: agent verdict ____, my decision ____
- [ ] Compliance — N/A (no control-relevant behavior changed) — or: ____
- [ ] Domain — N/A (no regulated data-of-record touched) — or: ____
- [ ] Schema — N/A (no schema/migration changes)
- [x] Quality — TDD followed; coverage enforced by CI

### Attestation
- [ ] I ran the applicable agent reviews and my decisions are recorded above.
- [ ] This PR touches **no** Tier-3 path (auth/RBAC, schema, remote-execution,
      enforcement config, regulated domain). If it did, a full CR file would be in
      `docs/change-records/` and the repository maintainer (Tom Hanks / @BlackRaptorAI)'s review requested.

Signed: @BlackRaptorAI · YYYY-MM-DD
