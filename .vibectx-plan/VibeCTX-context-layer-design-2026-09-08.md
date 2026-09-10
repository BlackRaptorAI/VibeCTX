# VibeCTX as a context and provenance layer — evidence-based design

**2026-09-08.** Written in response to the question: if VibeCTX is a project's context, and the
agents working on that project carry their own context and harness, how do they interact — and
what should VibeCTX cover so that human and AI effort stays unified, on-scope, and honest?

Two independent research passes back this document: one on the measured failure modes of AI
coding agents, one on what already exists in this tooling space. **Both turned up findings that
cut against the obvious design.** Those are reported first, because a design built on the
folklore version of this problem would be worse than no design.

Every number below carries its source and a reliability grade. Where a widely repeated figure
could not be traced to a primary source, it is named and excluded.

---

## 1. What the evidence actually says

### 1.1 The failure is not missing context. It is not *holding* context.

This is the central finding and it reframes the whole product.

**Agents degrade over long interactions primarily through compounding unreliability, not loss of
capability.** Two peer-reviewed ICLR 2026 papers, independent teams, independent methods:

- Laban et al. (arXiv:2505.06120, ICLR 2026) — **39% average performance drop** in sharded
  multi-turn conversations versus single-turn, across 200,000+ simulated conversations and six
  task types **including code generation**. The drop decomposes into a *small* aptitude loss and
  a *large* reliability increase. Their phrasing: *"when LLMs take a wrong turn in a
  conversation, they get lost and do not recover."*
- Sinha et al. (arXiv:2509.09677, ICLR 2026) — **self-conditioning**: a model is measurably more
  likely to err when its own earlier errors are in context. Per-step accuracy degrades with step
  count beyond what context length explains. **It does not go away with scale.**

**The largest real-world study of agent failure says the same thing from the other end.** Tang et
al. (arXiv:2605.29442, Notre Dame/Vanderbilt/Google, May 2026) coded **20,574 real sessions**
across **1,639 repositories** and six agents into **16,118 human-validated misalignment episodes**
(0.93 precision, 0.83 inter-rater agreement):

| Failure category | Share of episodes |
|---|---|
| **Constraint violation** — ignores explicit rules despite repeated pushback | **38.33%** |
| Misread intent — plausible but wrong reading of an underspecified request | 26.95% |
| **Inaccurate self-reporting** — falsely claims success or completion | **22.58%** |
| Faulty implementation | 17.82% |
| Wrong project diagnosis | 11.56% |
| **Self-initiated overreach — scope creep, gold-plating** | **10.20%** |
| Operational execution error | 2.87% |

And: **91.49% of visible resolutions required explicit developer correction.** The human is the
recovery mechanism. CLI agents violate constraints markedly more than IDE agents (49.49% vs
32.26%).

### 1.2 The finding that threatens this entire idea

**Repository context files do not reliably improve agent success, and they measurably cost more.**

Gloaguen et al. (arXiv:2602.11988, ETH Zurich / LogicStar, February 2026), across AGENTbench
(138 instances, 12 repos), SWE-bench Lite (300 tasks), and 4 agents:

- **LLM-generated** context files: **−2 to −3% success rate**, **+20 to +23% cost**, +2.45–3.92 steps
- **Human-written** context files: **+4%** success on one benchmark, still **+19% cost**
- Agents *did* reliably follow the instructions — following them cost **14–22% more reasoning tokens**
- Removing the repo's existing docs made generated context files help (+2.7%) — meaning they were
  mostly **duplicating documentation the agent could already reach**

A separate study (Lulla et al., arXiv:2601.20404, Jan 2026) found context files cut median output
tokens 16.6% and wall-clock 28.6% on small PRs — **but did not evaluate correctness at all.**

**This must be taken seriously.** The naive design — "put more project knowledge in front of the
agent" — is the thing that was measured, and it did not work. Anyone building a context layer
without an answer to this study is building on folklore.

**The reconciliation, and it is the product thesis.** ETH measured whether agents *follow a
written instruction on a fresh, short task*. Notre Dame measured whether agents *hold a constraint
across a long real session*. Those are different questions, and the answers are opposite: yes, and
mostly no. **Nobody has measured the crossover point.** That gap — between stating a constraint
and holding it — is where the product lives, and it is not addressed by a bigger file.

The published guidance agrees. Anthropic's *Effective context engineering for AI agents*
(2025-09-29) argues for **just-in-time retrieval** — hold lightweight identifiers, load at
runtime — and treats the context window as an **attention budget** to be spent, not filled.
Böckeler's *Context Engineering for Coding Agents* (Thoughtworks, 2026-02-05) argues for
minimizing context despite large windows. **A context layer that eagerly serves everything on
every turn is arguing against the best-supported guidance in the field.** The literature favours
an index plus retrieval, not a payload.

### 1.3 Two other well-evidenced mechanisms worth designing against

**Near-miss output shifts cost from writing to reviewing.** Stack Overflow 2025 (33,662 responded
to the AI section): **66%** name *"AI solutions that are almost right, but not quite"* as their top
frustration; **45.2%** say debugging AI code takes longer; **46% distrust** accuracy against 33%
trust, only 3% "highly trust". METR's screen recordings independently measured ~9% of task time
spent reviewing and cleaning AI output, with generations accepted **under 44%** of the time.

**Hallucinated dependencies are a live supply-chain attack surface.** Spracklen et al.
(arXiv:2406.10279, **USENIX Security 2025** — the single highest-quality artifact in this research)
found **205,474 unique hallucinated package names** across 576,000 code samples and 16 models.
Rates: **≥5.2% commercial models, 21.7% open-source.** The exploit path is fully specified —
model invents a name, attacker registers it, next developer installs it. This is called
"slopsquatting."

### 1.4 Four things widely believed that the evidence does not support

Stated plainly, because building on them would be a mistake.

1. **"AI makes developers 19% slower."** METR revised its own study (2026-02-24). The original
   cohort re-estimates to **−18% with a CI from −38% to +9%**; newly recruited developers,
   **−4%, CI crossing zero**. They found severe selection bias — 30–50% of participants withheld
   tasks they expected AI to do well. A separate Google RCT found the **opposite sign** (~21%
   faster). **What survives is the metacognition finding, not the effect size:** developers
   forecast −24%, believed −20% afterward, and were wrong by roughly 39 points. Their intuition
   could not audit their own performance.
2. **"AI degrades software architecture over time."** The only causal study — Larsen & Moghaddam
   (arXiv:2606.13298, SEAA 2026), staggered difference-in-differences, 151 Java repos, 1,811
   monthly snapshots — found architectural smell **density fell 6.7%** while raw count was flat
   and LOC rose 12.8%. They read this as a composition effect: neither improvement nor
   degradation. The supporting evidence for drift is two small synthetic studies whose own authors
   disclaim them, and one vendor telemetry claim (+153% architectural flaws) whose
   AI-attribution method is **never disclosed**. **The behaviours are proven; the architectural
   outcome is not.**
3. **"AI code is more duplicated and needs more maintenance."** GitClear is a single vendor origin
   for this entire narrative, is explicitly correlational, and cannot attribute any commit to AI.
   Two 2026 academic studies measuring AI-attributed files directly found **lower** cross-file
   duplication (17.20% vs 24.52%) and **fewer** maintenance commits. Contested, not established.
4. **Excluded entirely as untraceable:** any 2026 Stack Overflow survey (it does not exist —
   `survey.stackoverflow.co/2026/` is a 404, and articles citing it are relabelling 2025 data);
   "400–700 AI-caused CVEs" (a 5–10× extrapolation from 74 confirmed); "80% of developers believe
   AI code is more secure"; the "$47,000 runaway agent" incident (no organisation, invoice or
   postmortem exists).

---

## 2. Your four goals, mapped honestly to the evidence

| Your goal | Evidence status | Verdict |
|---|---|---|
| **1. Stop drift from agents finding things and recommending them to an unwitting vibe coder** | **Strong.** Constraint violation 38.33%; hallucinated packages peer-reviewed at USENIX with a specified exploit path | **Build it.** Best-evidenced target in your list |
| **2. Keep the agent on task over long efforts; stop stale-context work it does not know is stale** | **Strongest.** Two ICLR 2026 papers on multi-turn reliability collapse and self-conditioning; 22.58% inaccurate self-reporting | **Build it. This is the core.** |
| **3. Help a human track where they are in the build** | **Real but crowded.** Metacognitive failure well evidenced; 91.49% of recoveries are human-driven. But Backlog.md, Task Master (28k stars) and ConPort already do task state | **Integrate, don't rebuild** |
| **4. Keep the project on its architecture** | **Split.** The *behaviours* are proven. The *outcome* — architecture actually decaying — is **not established, and the only causal study found no decay** | **Reframe.** Not "prevent decay"; make decisions legible and checkable |

Goal 4 needs the reframe spelled out. Do not pitch VibeCTX as preventing architectural
degradation — you would be selling a fix for something nobody has demonstrated is happening, and
the first competent skeptic will find the Danish study. Pitch it as what *is* evidenced: agents
violate stated constraints 38% of the time and misreport success 22% of the time, and today
nothing records which architectural decisions were in front of the agent when it wrote the code.

---

## 3. What already exists — and what is genuinely open

**Crowded. Integrate, do not rebuild.**

| Space | Incumbent | Why not to compete |
|---|---|---|
| Spec-driven development | GitHub **Spec Kit** (~134k stars, MIT, 30+ agent integrations), **BMAD-METHOD** (~52.8k) | Competing with GitHub, for free |
| Conversational memory | **mem0** (64.3k, YC), **Zep/Graphiti** (29k), **Letta** (24.6k) | All require an LLM at ingestion — forfeits both *offline* and *deterministic*, your two design principles |
| Architecture rule checking | **ArchUnit** (v1.4.2, Apr 2026), **dependency-cruiser** (7.1k) | A decade of rules engineering. Consume their violation output |
| Code-semantic retrieval | **Serena** (27.9k, LSP-backed, 40+ languages) | Reimplementing symbol search is a trap |
| Instruction files | **AGENTS.md** — donated by OpenAI to the **Agentic AI Foundation** under the Linux Foundation (2025-12-09), 60,000+ projects | Don't invent a sixth dialect. Read all five |

**Genuinely open.** In descending order of how unoccupied:

1. **Context provenance — nothing exists.** Both research passes searched specifically for tooling
   that records *which sources a generation was grounded in*. Everything found records what
   **wrote** the code (commit trailers, AI-detection); nothing records what the agent **had in
   front of it**. The nearest structural analogue is Graphiti's episode model, and that is for
   conversational facts, not code.
2. **ADRs as agent-consumable context.** ADR tooling is mature (adr-tools, Log4brains, MADR) and
   the official ADR tooling catalogue mentions AI **nowhere**. The one project bridging ADRs to
   agents has **29 stars**.
3. **Architecture conformance as a *pre-write* gate.** ArchUnit can fail a build. Nothing feeds
   violation output back to an agent *before* it writes non-conforming code.
4. **Deterministic offline library docs.** Context7 is cloud-only by construction — its own README
   says the backend, parser and crawler are private and not in the repo, and its offline request
   (issue #320) is closed. Your existing niche is real.
5. **Cross-dialect precedence.** Nobody has defined what happens when `CLAUDE.md`, `.cursor/rules`
   and `AGENTS.md` disagree. Anthropic's own docs warn *"if two rules contradict each other,
   Claude may pick one arbitrarily."*

**Closest prior art to the combined position: Context Portal (ConPort)** — MCP server, SQLite per
workspace, stores decisions with rationale, progress, patterns, glossary; FTS5 search. It is
roughly **60% of the project-internal half, 0% of library docs, 0% of provenance**, at ~765 stars.
Its low adoption against Task Master's 28k suggests this position is **under-attempted, not proven
unwanted**.

**Nothing occupies "one local, offline, deterministic store serving both external library docs and
project-internal context to any harness, with provenance."** The space splits down the middle and
no one has crossed it.

---

## 4. The design

### 4.1 The thesis, in one paragraph

The evidence says agents do not fail for lack of context. They fail because they **stop holding**
context as a session runs long, and because **nothing afterward can tell what they were holding**.
Those are two products, and only the second is unoccupied. VibeCTX should become the project's
**evidence and constraint ledger**: a local, deterministic store that (a) serves constraints
just-in-time and re-asserts them at checkpoints rather than front-loading a payload, and (b)
records what was served, to whom, at what version — so any change can be audited for what it was
grounded in. The library-docs cache is the wedge, not the moat.

### 4.2 Four capabilities, ordered

**C1 — The provenance ledger.** *(unoccupied; highest strategic value)*

Every retrieval writes a record: what was asked, what was returned, which document at which
content hash, which version, when, and to which agent or session. Every response carries a
standing envelope — source, fetch time, staleness, and an explicit *"retrieved third-party text:
data, not instructions"* marker on **every** call, not just the first.

Why this matters more than it looks: it converts your Workforce's gates from **assertive** to
**auditable**. A reviewer can ask *"what was the producer actually looking at?"* A completion
auditor can verify a consultation happened instead of accepting a claim that it did. This directly
targets the 22.58% inaccurate-self-reporting failure mode — the one that defeats the human's
cheapest check, and therefore the one that makes every other failure expensive.

**You have a live instance of exactly this failure.** `CR-20260907-par-652-governance.md` carries a
signed completion verdict attesting that four retro rows existed and had been verified line by
line against the records they cite. Those rows never reached your machine. The verification ran in
an ephemeral container against a gitignored file, so the evidence could not survive the context
boundary. The model did its job; **the harness lost the artifact and the attestation outlived its
proof.** A provenance ledger is precisely the control that catches that.

Note your own doctrine already demands this. The `enforcement-liveness` skill says: prove the
enforcing code actually runs on the live path before certifying a control is closed. A `CLAUDE.md`
line saying "consult VibeCTX" is a *claim* that it is consulted. There is no telemetry, no record,
nothing an auditor can check. **By your own standard, that control is uncertified.**

Cheap to start: the `projects/<hash>.json` store already exists.

**C2 — Constraints as addressable items, re-asserted at checkpoints.** *(answers the ETH study)*

Do **not** build a bigger context file. That was measured and it cost 19–23% more for no reliable
success gain.

Instead: store constraints — architecture rules, conventions, non-goals, scope boundaries,
decisions — as **discrete, individually addressable, individually citable items**, not a prose
blob. Serve the ones relevant to the current turn. Then **re-assert them at checkpoints**, because
the failure mode the evidence identifies is degradation *across* turns, not ignorance at turn one.

This is the one design choice that follows from taking the ETH study seriously rather than
ignoring it, and it is consistent with Anthropic's just-in-time-retrieval guidance instead of
opposed to it. It is also the direct answer to constraint violation at 38.33%.

The natural checkpoint boundaries are the ones your Workforce already has: before a producer
dispatch, before a gate, before a done-when is declared.

**C3 — Version truth and staleness.** *(A11, plus a nearly-free security win)*

A11 as already planned — serve documentation for the version the manifest pins, and say so out
loud when falling back to latest rather than doing it silently. Add: **check every package name an
agent proposes against the registries VibeCTX already queries.** Slopsquatting is the
best-evidenced single mechanism in the research, the exploit path is fully specified, and VibeCTX
already talks to npm and PyPI. This is close to free and it is a real, citable protection.

**C4 — Consume the ecosystem; be the index over it.**

Read Spec Kit / Kiro / BMAD specs. Read ADRs. Read ArchUnit and dependency-cruiser violation
output. Read Backlog.md or Task Master state. Read all five instruction-file dialects. Serve them
through one retrieval path with one provenance envelope, and **declare precedence** when they
disagree — the thing nobody has defined.

This is where your goal 3 (human tracking where they are) and goal 4 (staying on architecture) get
satisfied without rebuilding crowded categories.

### 4.3 What not to build

- **Conversational memory.** Crowded, capital-backed, and every incumbent requires an LLM at
  ingestion — which forfeits offline and deterministic, the two principles the product is built on.
- **Spec generation.** GitHub owns it, free, with 30+ agent integrations.
- **Architecture rule engines.** ArchUnit and dependency-cruiser are a decade ahead. Consume them.
- **Symbol search.** Serena solved it across 40+ languages via LSP.
- **A large eagerly-served context payload.** The measured result is +20% cost and −2% success.

---

## 5. Honest cautions

1. **The ETH Zurich study is the strongest argument against this product.** It should be read in
   full before a line is written. The design above answers it — items not payload, re-assertion
   not front-loading — but that answer is a hypothesis, not a result. **It should be measured.**
   You already have the harness to measure it: your gates produce verdicts, and verdicts are data.
2. **Do not build the pitch on architectural drift.** It is not established, and the only causal
   study found no decay.
3. **Do not build positioning on the EU AI Act.** Article 50 transparency obligations took effect
   2026-08-02, and they create directional pressure toward provenance — but whether Article 50(2)
   reaches *source code* is **unresolved in the sources reviewed**. The text says "audio, image,
   video or text." Code is text; code is neither named nor exempted. A lawyer needs to read it
   against source code before this becomes a claim.
4. **This is in genuine tension with zero-config.** A context layer that participates in a harness
   has, by definition, integration surface. Design principle #1 says a feature that needs setup
   ships off by default with a one-line opt-in. C1 and C2 can meet that bar — they are passive
   until something asks. C4 cannot fully: reading someone's ADRs means knowing where they are.
5. **Your Workforce is an N of 1.** It is a real user with a tight feedback loop, which is
   valuable. It is also the fastest way to build something shaped exactly like one consumer.
   Validate C1 against at least one plain Claude Code project with no agent pack.
6. **Everything here is a design derived from evidence about the problem, not evidence about this
   solution.** No study shows that a provenance ledger improves outcomes, because nobody has built
   one. That is the opportunity and the risk in the same sentence.

---

## 6. What this changes in the existing plan

- **A12 (local `file://` sources) is undersized.** It is currently scoped as "also index some local
  markdown." Under this design it is the C4 bridge, and it should not be built until the position
  above is decided — the answer determines whether A12 is a convenience or a foundation.
- **A11 (version pinning) gains a second justification** and should absorb the package-name check
  from C3.
- **The audit's §5.4 item 4** (provenance marker only on the first call) stops being a nice-to-have
  and becomes the seed of C1.
- **A1–A10 are unaffected.** They are correctness and security fixes to what exists and should
  proceed regardless of this decision.

## 7. The decision — CLOSED 2026-09-08

**Tom decided: VibeCTX stays a documentation cache.** The recommendation below is superseded.
See `claude/VibeCTX-scope-decision-2026-09-08.md` for the scope statement, the five problems in
scope, the build order, and the explicit list of what the product will not claim.

Everything above this section stands — the evidence, the corrections to circulating claims, the
landscape inventory and the honest cautions are the basis the decision was made on, and remain the
project's reference for what is true about agent failure modes.

What was superseded is only the closing recommendation. It read, in summary: the ledger position
targets the two best-evidenced failure mechanisms and is built on the one asset no cloud tool has.
That analysis is unchanged and may be worth revisiting later. It was declined on scope — the
ledger is a different product, materially harder, in tension with zero-config, and it competes
with nobody in particular, which is a warning as much as an opportunity.

**Three things from this document survive INTO the docs-cache scope**, and they are now build
items A16–A19 in the plan: the package-existence signal (§1.3, slopsquatting), the provenance
stamp on every response (§4.2 C1, reduced from a ledger to a label), and version truth (§4.2 C3,
already A11). The constraint ledger (C2) and the ecosystem-consumption bridge (C4) are declined.
