---
description: Kick off Phase 1 (definition) for a new feature — PM interview, consults, spec, tier, plan
---

Start the feature-definition workflow for: $ARGUMENTS

Follow the team lifecycle (your team charter):

1. Use the principal-architect subagent to orchestrate. It restates the outcome
   and identifies blast radius in the codebase.
2. Use the product-manager subagent to interview me — users/roles affected,
   scope, MVP cut, acceptance criteria, instrumented success metrics. Ask me
   the questions directly and wait for answers; don't invent business facts.
3. Consult in parallel where the feature warrants it: ux-designer (workflows),
   security-architect (early threat surface), privacy-counsel and
   domain-compliance (regulatory constraints that shape scope), and
   operational-readiness (who operates it, the operational outcome, and any
   human-in-the-loop checkpoints the automation needs).
4. Draft the spec in docs/specs// format, including NFR budgets and
   failure modes, and classify the risk tier.
5. Present the spec for my approval. Iterate until I approve — do not proceed
   to a plan without my explicit approval.
6. On approval: use principal-architect to decompose into a dated plan in
   docs/plans//, sliced trunk-based (each slice deployable, dark
   behind flags, schema expand/contract first, flag-flip last), with a risk
   tier and test strategy per slice (confirm with qa-test-engineer).

Deliverables: the spec file, the plan file, and a summary of gates each slice
will trigger.
