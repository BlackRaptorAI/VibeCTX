---
name: research-integrity
description: >-
  Load for ANY research, analysis, or evidence-based reporting task — market /
  competitive research, source appraisal, "which X is best / most
  cost-effective", market sizing or statistics, synthesizing studies, or before
  publishing any finding or citing a number a decision rests on. Enforces
  mode-appropriate methodology, separate source-reliability × evidence-certainty
  grading, citation-independence (anti-woozle), root-to-mechanism verification,
  and a release gate so conclusions withstand scrutiny and challenge. Triggers:
  "research X", "is there a market for", "which is better", "how big is",
  "what does the evidence say", "cite a source", "before we publish".
---

> Design rationale: `research-integrity-spec.md` (in `docs/`). Fillable artifact templates: `templates.md` (this folder).

# Research Integrity

We are usually **analysts appraising and synthesizing what others produced** — occasionally generating our own data. The job is not to find the stat that fits the story; it is to reach **our own graded judgment that survives adversarial challenge**, and to trace claims to the **root** (primary source) and the **mechanism** (why it's true) — because the root holds the justification and the path forward. This skill is the process. Scale it to stakes (§1).

## 0. Non-negotiables (every mode)
1. **Grade two things separately, never as one word:** source *reliability* (trust the messenger?) and claim *certainty* (how much do we believe *this* claim?). Use the Admiralty grid (reliability A–F × credibility 1–6) + a GRADE-style certainty for a body of evidence.
2. **Repetition ≠ evidence. Independence is the master variable.** Collapse citation chains to their **origin** and count the **effective-N of independent origins**, not raw source volume. N sources reciting one origin = one source. (This is the Woozle effect — how "everyone knows" a number that traces to one weak study. Don't continue one; don't originate one.)
3. **A reachable root is not a true root.** Separate **root-reachability** (did we find the origin?) from **root-veracity** (is the origin likely correct?). Never let the first stand in for the second.
4. **Mechanism must be a *testable entailment*, not a story.** "Why it's true" earns nothing unless it implies something else observable ("if this holds, X and Y must also be true") that you then check. Articulate confabulation is not understanding.
5. **Disconfirmation beats confirmation.** Rank hypotheses/options by evidence *inconsistent* with each (ACH), and actively fetch the strongest *credible dissent*. A claim you didn't try to kill is ungraded.
6. **Freeze the method before the answer** (Mode C especially): commit the question + analysis plan / decision weights before you see the data or scores.
7. **Our judgment ≠ raw reporting.** Every output labels each claim as sourced-fact / stated-assumption / our-inference, carries calibrated confidence, and **preserves dissent**.
8. **The release gate.** Grade everything internally; **publish only claims that clear the "withstands reasonable scrutiny" bar.** Low-confidence material stays in the working set, labeled — it informs thinking, it is not asserted externally.

## 1. Intake triage (run FIRST — sets how heavy to go)
| Tier | When | Effort |
|---|---|---|
| **LITE** | low-stakes AND reversible AND not published (e.g. "which $400 dev GPU") | trace-to-root the 1–2 load-bearing numbers, verify at the primary/vendor source, one-axis grade, BLUF out. Skip the heavy artifacts. |
| **STANDARD** | consequential but internal/reversible | full mode track; core artifacts; single-grader + a self-blind-order pass. |
| **HEAVY** | irreversible, high-cost, adversarial, OR public-facing/publishable (it becomes someone's root) | full track + escalation artifacts + **`evidence-auditor` review before it's trusted**. |
**Escalation is one-way and automatic:** if irreversibility, a spend threshold, external publication, or a load-bearing claim graded Low-with-no-fallback appears mid-task → promote a tier and re-open the gate.

Also triage each load-bearing claim: **rootable** (primary source reachable → normal), **consilience-only** (no single root but independent lines → §Consilience), **unknowable** (neither → HARD-FAIL: may enter only as a labeled *assumption*, and the decision must be robust whether it's true or false).

## 2. Mode-selector (after triage, before researching)
First tag each artifact by **genre, not its title**: a peer-reviewed/registered study → Mode-A tools; a vendor/grey/practitioner artifact (whitepaper, marketing benchmark, forum post, analyst PDF) → Mode-B tools **even if it's called a "study."**

- **Mode A — Evidence synthesis:** appraise & synthesize others' *scientific* studies/reports. *(Woozle risk: continuing — amplifying a weak/echoed primary.)*
- **Mode B — Direct-source aggregation:** gather direct facts + practitioner testimony (specs, prices, benchmarks, reviews) into OUR dataset to drive a **decision** ("best architecture for X", "most cost-effective Y"). *(Woozle risk: both — echoed specs + bandwagon "popular ≠ best".)*
- **Mode C — Original primary research:** we generate NEW data with our own instrument. **C-internal** (a benchmark we run to decide → feeds a Mode-B matrix) vs **C-publishable** (intended to become a public root → full instrument-validity load). *(Woozle risk: originating — we could start one.)*

A mixed task decomposes into sub-tasks, each classified separately.

## 3. Per-track method (condensed — see `templates.md` for the artifacts)
**Mode A:** find the body of evidence (not one paper) → appraise each (risk-of-bias) → **collapse citations to independent origins** (effective-N ledger) → run **ACH** across the competing conclusions → grade the body (GRADE/SoF; **single-study cap = Moderate**; imprecision computed) → state our judgment + dissent.

**Mode B:** define the decision + **lock weighted criteria BEFORE scoring** (≤7 criteria, weights sum 100%, timestamped) → MoSCoW knockouts → gather facts+testimony → **verify every spec/price at the primary/vendor source** (hash + retrieval date + TTL) → score each option, tagging provenance per cell → **astroturf/independence screen** on testimony (weight by demonstrated hands-on use + independence) → **sensitivity/robustness** (±10–20% on weights; ROBUST/FRAGILE) → pre-mortem → graded recommendation.

**Mode C:** pre-register (question, DV, conditions, exact analysis, stopping rule) → design the instrument (avoid leading/double-barreled; validity/reliability) → **adversarial instrument review** ("what would make this produce a flattering-but-false result?") → pick the population + medium/channel to reach it (coverage/sampling/nonresponse — Total Survey Error) → pilot → refine → field → analyze the *pre-registered* way → publishable data is labeled with its method; C-internal data is labeled *"provisional — not collected under publishable controls."*

## 4. Consilience (when the origin is unreachable)
Independent lines converge → confidence — **but only if independent.** For each line, name its method/data/investigator AND its **error mode**; convergence counts only when the error modes are **disjoint** (default assumption: correlated, so argue it). Same-origin echoes are not lines.

## 5. The release gate (before anything external)
Publish a claim only when: root reached OR consilience argued; **root-veracity** assessed (not just reachability); **effective-N ≥ 2 independent origins** (or an explicit, logged single-source override for a fully-verified gold-standard primary — caps at Moderate otherwise); the **qualifier-drift diff** vs the origin's wording is empty (we didn't harden a hedge); dissent recorded; and the claim clears its tier's confidence floor. **HEAVY / publishable → `evidence-auditor` signs off first.** Anything failing stays internal, labeled.

## 6. Output format (analytic judgment, not a link dump)
BLUF (the judgment first) → the graded evidence (each load-bearing claim: our claim · source reliability×credibility · effective-N · root status · confidence) → **preserved dissent / strongest counter-case** → what would change the answer → the "so what". Label every line sourced-fact / assumption / our-inference.

## Tier defaults (starting config — tune from real runs via `AGENT-RETROS.md`)
Dual-grading: LITE none · STANDARD ≥10% sample · HEAVY all load-bearing. · Reviewer: distinct-role subagent + rules checks now; `evidence-auditor` for HEAVY; different model family later. · TTL: prices 7d · specs 90d · literature 12mo · security advisories 24h. · Single gold-standard source may reach High only via a logged reviewer override (else capped Moderate).

## Producer/reviewer
You (the producer) run this skill. For **HEAVY or publishable** work, a **separate reviewer must be independent of you** — invoke **`evidence-auditor`** (a distinct gate agent), never self-review. That independence is the point; a same-architecture self-check is correlated failure, not review.
