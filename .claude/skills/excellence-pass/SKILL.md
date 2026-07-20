---
name: excellence-pass
description: >-
  The five behaviors that separate top-tier agent output from merely-correct
  output — run as an explicit final pass after a draft is complete and
  verified, before delivery. Load for any substantive work product (code,
  analysis, model, legal draft, ops/strategy plan). Triggers: "before I
  deliver", "final quality pass", "excellence pass", any high-stakes
  deliverable. Especially valuable for lower-tier (e.g. sonnet) agents, whose
  observed gap concentrates in exactly these checks.
---

# The Excellence Pass

Distilled from the Agent Operating Standard (`docs/agent-operating-standard.md`).
Instructions cannot transfer raw model capability — but they CAN force the
disciplined process a stronger model applies by default and a weaker run skips.
A small controlled battery (four tasks across three model tiers, one run each)
suggested the quality separation lived almost entirely in the five behaviors
below: the strongest tier did them unprompted; the others did them well **when
told** and skipped them **when not**. Treat that as a working hypothesis about
*which* behaviors matter, not a measured effect size — and make them explicit.

**When to run:** after your draft is complete AND verified, before delivery,
on any substantive work product. **Scale to stakes** — a quick answer stays
quick; anything a human will send, sign, deploy, or fund decisions with gets
the full pass. Do not turn trivial tasks into checklist theater.

## The five checks (run each, confirm each)

1. **Enforce the hidden contract.** Every task has requirements nobody stated:
   exact input formats (not what a lenient parser accepts), valid ranges,
   units, encodings, boundary values, version/platform-specific behavior,
   type look-alikes (`bool` passing as `int`). Enumerate them and enforce them.
   Ask: *"what input or condition that technically 'works' would still violate
   the spirit of the spec?"* — then guard against it with a clear error.
2. **Verify by an INDEPENDENT method.** Checking with the same method that
   produced the answer catches typos, not wrong thinking. Cross-check by a
   *different* route: a brute-force reference against the clever implementation,
   a bottom-up rebuild of a number computed top-down, a second source for a
   claim, recomputation in code for arithmetic done in prose. (This is the
   spec-side twin of `enforcement-liveness` — prove the answer two ways.)
3. **Add the second-order layer.** Ask: *"what would the top practitioner in
   this field add that wasn't requested?"* — the sensitivity behind the point
   estimate, the discounted figure behind the nominal, the marginal number
   behind the blended, the implication the inputs contain but don't state (flat
   per-unit revenue ⇒ no expansion ⇒ NRR < 100%). Include the one or two that
   would change a decision; skip decoration.
4. **Draft the interfaces, don't describe them.** Anything the deliverable
   depends on to function is part of the deliverable: the definitions a clause
   requires, the companion clause it interlocks with, the config a script
   needs, the assumptions tab a model reads from. "You'll also need X" is an
   incomplete deliverable — draft X, then check cross-references and
   cross-document consistency.
5. **Model the counterfactual.** For any recommendation between options,
   quantify each path over time — don't just argue qualitatively. Find the
   crossover / breakeven / threshold where the answer flips, then state the
   assumptions that would flip it so the reader knows exactly what to verify.
   (In testing, the most decision-relevant insights came from this step — e.g.
   the "cash-rich" option having *less* cash by month 7.)

## Domain-specific "observed gaps" (apply the ones that fit the task)

- **Code** — enforce the input contract strictly (reject look-alikes, guard
  out-of-range, raise clear errors, don't let a lenient stdlib widen your API);
  cross-check a non-trivial algorithm against a second independent route
  (brute-force / property sweep / bounded exhaustive), not hand-picked
  examples; deliver call-site guidance (invariants callers could silently
  break).
- **Research/analysis** — triangulate ≥2 independent sources per load-bearing
  claim; date-stamp findings; steelman the opposing view and beat it or change
  the conclusion; real "Sources" section, no source no claim.
- **Spreadsheets/financial** — formulas not hardcoded values; a single
  Assumptions section (units + source + date); built-in cross-foot/balance
  checks; the second-order layer (discounted vs nominal, marginal vs blended,
  the sensitivity that shows how close a metric is to flipping); compute the
  threshold at which a benchmark judgment reverses and show the headroom.
- **Legal** — never invent authority (bracket `[VERIFY: …]`); bracket open
  business terms `[AMOUNT]`/`[DATE]`; draft the companion provisions (defs,
  LoL interface, insurance, survival), don't just flag them; check
  cross-document interlocks (a breach-notification window must leave the
  customer time for its own statutory deadline; indemnity super-cap vs
  insurance limits); end with a "draft for qualified counsel" notice.
- **Ops/strategy** — structure as Objective → Current state → Options → Rec +
  rationale → Execution (owner/deadline/definition-of-done each) → Risks
  (likelihood/impact/mitigation) → Metrics + review cadence + kill criteria;
  quantify the counterfactual over time and locate the crossover; reframe a
  deal rather than just accept/reject (which terms convert it, priced).

## Model-tier note (how hard to enforce, per tier)

Set this to your own roster. The pattern that held in testing:

- **Top tier (your strongest model — e.g. the orchestration/architecture and
  deep-judgment/gate seats):** these behaviors are largely default. The skill
  is a checklist backstop, not a script; the residual gap is narrow
  completeness (a missing range guard; a sensitivity noted but not *computed*),
  so keep the latitude but still run checks 1, 2, and 3.
- **Everyday build tier (e.g. sonnet):** strong on core correctness; the
  observed gap is concentrated in EXACTLY checks 1 (hidden contract), 2
  (independent cross-check), and 5 (quantified counterfactual). Run the pass as
  an explicit, confirmable checklist — and before delivering, list three ways
  the output could be wrong and check each.

If your deployment has access to a stronger frontier model than `opus`, the
orchestration and architecture seats are where the extra capability pays for
itself first — there, these behaviors are closest to free.

**Producer/reviewer pairing** (high-stakes): a builder produces against this
standard; a different agent (a gate, or a stronger tier) reviews adversarially
(see `gate-verdict-format` §Adversarial method); the producer revises. This
pairing reliably beats either agent alone.
