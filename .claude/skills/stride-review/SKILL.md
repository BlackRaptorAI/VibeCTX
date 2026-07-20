---
name: stride-review
description: >-
  Structured STRIDE threat-modeling pass over a change's trust boundaries. Use
  when threat-modeling a new or changed surface, especially Tier-3 (auth, remote
  execution, privileged commands, tenant isolation). Triggers: "threat model
  this", "STRIDE review", "what could an attacker do here". Shared by
  security-architect and red-team-reviewer.
---

# STRIDE trust-boundary review

Produce a threat model that names **trust boundaries** and enumerates threats
per boundary — not a generic "make it secure" opinion. A review without named
boundaries is not a threat model.

## Procedure

1. **List the trust boundaries the change touches.** Common examples: user ↔
   API, tenant ↔ tenant, cloud ↔ device, device ↔ hardware, platform ↔ LLM,
   platform ↔ third-party vendor. Name the ones your change actually crosses.
2. **For each boundary, walk STRIDE:**
   - **S**poofing — can identity be forged? (tokens, device/service certs,
     replayed credentials)
   - **T**ampering — can data/commands/artifacts be altered in flight or at rest?
   - **R**epudiation — is the security-relevant action audited (who/what/when)?
   - **I**nformation disclosure — can data cross the boundary to someone
     unauthorized? (cross-tenant reads, PII egress to vendors/LLM)
   - **D**enial of service — can the boundary be exhausted or blocked?
   - **E**levation of privilege — can a lower role reach a higher capability?
3. **For each applicable threat:** state the concrete scenario, then the
   mitigating control that exists or the gap that doesn't.
4. **Output** a per-boundary table (Boundary · Threat · Scenario · Control/gap ·
   Severity) and a verdict. Map findings to controls where useful (SOC 2 CC6/CC7,
   ISO A.8/A.9). Cite `file:line`.

## Rules
- Every listed threat gets either a control or a named gap — no "probably fine."
- Tenant-isolation and remote-command/privileged-execution boundaries get the
  most scrutiny; these are where real exposures tend to cluster.
- If you can't confirm a control exists, say so and mark it a gap to verify —
  don't assume coverage.
