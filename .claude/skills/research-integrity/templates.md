# Research-Integrity — Artifact Templates

Fillable templates for the `research-integrity` skill. Use the ones the task's tier and mode call for (proportionality — LITE tasks need only the triage card + a source-verification line + the report format; don't generate the whole set). Full catalog + rationale: `research-integrity-spec.md` §6.

---

## 0. Intake triage card *(all tasks)*
```
Task: <one line>
Stakes/reversibility tier: LITE | STANDARD | HEAVY   (escalation triggers seen: <none | ...>)
Mode: A (synthesis) | B (direct-source) | C-internal | C-publishable
Load-bearing claims + root-availability:
  - <claim> → rootable | consilience-only | unknowable(HARD-FAIL → assumption only)
Reviewer required (HEAVY/publishable)? yes → evidence-auditor | no
```

## 1. ACH matrix — Analysis of Competing Hypotheses *(Modes A, B)*
Rank by evidence *inconsistent* with each hypothesis, not consistent. Conclusion = the **least-disconfirmed**, plus what was rejected and why.
```
Evidence (reliability grade, root-ID) | Diagnosticity | H1 | H2 | H3
E1  (B2, root=doi:...)                 | high          | C  | I  | I
E2  (D4, root=vendor-blog)             | low           | C  | C  | N/A
...
Per-hypothesis  Inconsistent tally:      —   | 3  | 1  | 4
```
`C`=consistent, `I`=inconsistent, `N/A`=not applicable. High-consistency + zero-diagnosticity evidence (everyone echoes it) is formally worthless — flag it.

## 2. Admiralty source grid + anchored grade *(all)*
Grade the **source** and the **claim** separately.
```
Source reliability:  A completely reliable · B usually · C fairly · D not usually · E unreliable · F cannot judge
Claim credibility:   1 confirmed by independent sources · 2 probably true · 3 possibly · 4 doubtful · 5 improbable · 6 cannot judge
Record as {reliability}{credibility}, e.g. B2. Watch the A1/B2/C3 diagonal — over-clustering there is a bias smell.
```

## 3. GRADE / Summary-of-Findings profile *(Mode A)*
```
Claim/outcome | #studies & design | risk-of-bias | inconsistency | indirectness | imprecision(OIS/CI) | pub-bias | non-independence | qualifier-drift | effect + CI | CERTAINTY (High/Mod/Low/VeryLow)
```
Rules: **certainty = the lowest surviving domain** (bottleneck, not average). **Single study caps at Moderate.** One footnote per downgraded domain.

## 4. Citation-chain ledger + effective-N *(all)*
```
Claim: <text>
Citing node → what IT cites → hops-to-root → root type (primary data / method / bare assertion / dead-end) → reached origin? Y/N
  sourceA → cites sourceX → 2 → primary-dataset → Y
  sourceB → cites sourceX → 2 → (same origin)   → Y
  sourceC → own measurement → 0 → primary        → Y
RAW sources: 3   →   EFFECTIVE-N independent origins: 2   (sourceX-lineage, sourceC)
```

## 5. Independence audit (7 channels) *(all)*
A pair is independent only if **all** are "no":
```
Sources | same data? | same author/org? | one cites the other upstream? | same funder? | one propagated from the other? | shared model/training-corpus? | temporal cascade (later just echoes earlier)?
```
Channel #6 (shared-model/corpus) over-fires — treat as **flag-and-argue** for load-bearing claims, not auto-reject.

## 6. Qualifier-drift diff *(all — esp. before publishing)*
```
Origin wording:  "<verbatim, with its hedges/scope>"
Our wording:     "<ours>"
Modal/scope changes: <none = PASS | "may" → "does", "in one bank" → "companies", range → point>
```

## 7. Consilience worksheet *(when origin unreachable)*
```
Line | method | data | investigator | NAMED error mode | disjoint from other lines? (argue; default: correlated)
Convergent confidence only if ≥2 lines with argued-disjoint error modes.
```

## 8. Key Assumptions Check *(A, B, C)*
```
Assumption | why we believe it | confidence H/M/L | what would falsify it | still supported? | if false, does the conclusion collapse?
```

## 9. Mode-B decision matrix *(Mode B)*
Lock weights (timestamped) BEFORE any scoring. ≤7 criteria; weights sum to 100%.
```
Weights locked: <timestamp>
Criterion (weight%) | Option A (score 1–5, weighted, provenance-tier, source URL/hash) | Option B ... 
MoSCoW knockouts applied: <options eliminated + why>
Sensitivity: per-weight ±10/20% → rank stable? ROBUST | FRAGILE (which weight flips it)
Pre-mortem (T+12mo failure): <top risks + mitigations>
Recommendation + confidence + dissent:
```

## 10. Source-integrity scorecard + astroturf screen *(Mode B testimony)*
```
Source | hands-on tier | independence {organic / disclosed-incentivized / insider / affiliate / undisclosed→reject} | track record | reliability A–F | credibility 1–6
Astroturf red flags: near-duplicate wording · burst vs baseline · bimodal 5★/1★ · new-account cluster · co-review collusion · extreme sentiment + low detail · no verified purchase · undisclosed #ad
```

## 11. Vendor-fact verification + hash-vault *(Mode B, Lite)*
```
Claim | reviewer-reported value | PRIMARY-source value | URL | retrieval date | content hash | TTL/re-check date | status {verified / conflict / unverifiable / stale}
```

## 12. Pre-registration *(Mode C — lite version for C-internal)*
```
Status: pre-data | post-data(exploratory, labeled)
Question / hypothesis:
Dependent variable + exact operationalization:
Conditions & assignment (randomization?):
EXACT primary analysis (test, model, comparisons):
Outlier / exclusion rules (decided now):
Sample size + how derived (power):
Secondary / exploratory (labeled separately):
Instrument adversarial-review done? <what a hostile reviewer flagged + fixes>
```

## 13. Report structure (BLUF / Minto) *(all — the output)*
```
BLUF: <the judgment, one line, up front>
Basis: <graded evidence — each load-bearing claim: our claim · reliability×credibility · effective-N · root status · confidence>
Dissent / strongest counter-case: <preserved, not buried>
What would change this: <the load-bearing assumptions + sensitivities>
So what: <the decision/action it supports>
Every line tagged: [fact] / [assumption] / [our-inference]
```
