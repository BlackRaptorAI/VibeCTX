# VibeCTX — scope decision, 2026-09-08

**Decided by Tom, 2026-09-08.** This closes the open question at the end of
`claude/VibeCTX-context-layer-design-2026-09-08.md`.

**VibeCTX stays a documentation cache.** It will not become a project context and provenance
layer. It will not compete in any category that already has a strong incumbent. It will solve the
problems a documentation cache can genuinely solve, and it will say plainly which problems it does
not solve.

This document is written in plain language on purpose. It is the scope statement, and a scope
statement nobody can read is not a control.

---

## 1. What VibeCTX is

VibeCTX downloads the instruction manuals for the tools a project uses, saves them on the user's
own computer, and hands the right pages to an AI coding agent when it asks. It works offline. It
gives the same answer every time.

**That is the whole product.** It does not store a project's decisions, tasks, architecture, or
team rules. It has no memory of past conversations. It does not write specs or plans.

## 2. The five problems VibeCTX will fix

Each of these is inside a documentation cache's natural boundary, and each is backed by evidence
in `claude/VibeCTX-context-layer-design-2026-09-08.md` §1.

### 2.1 Agents invent packages that do not exist

Spracklen et al. (USENIX Security 2025) tested 16 models across 576,000 code samples and found
**205,474 unique invented package names**. Commercial models invent them at 5.2% or higher;
open-source models at 21.7%. Attackers register the invented names and put malicious code inside
them — "slopsquatting."

**Why this is ours.** VibeCTX already queries npm and PyPI to find documentation. It is already in
position to answer "that package does not exist." The capability is nearly free; only the framing
is missing. Today a failed resolution reads as a documentation miss. It should read as a safety
signal.

This is the single best-evidenced failure mechanism in the entire research base, and it is one of
the few a documentation cache can address directly.

### 2.2 Agents read the wrong version's manual

`resolve.ts:27` fetches npm `<name>/latest`; GitHub READMEs come from `HEAD`. Nothing in `src/`
reads a dependency's version. So a project pinned to React 18 is served React 19's documentation,
silently, with no marker.

**Why this is ours, and only ours.** `warm` already parses the version specifier next to every
dependency name. VibeCTX has the project folder; the cloud tools never do. This is the one
capability no competitor can copy, and today the product reads the version and throws it away.

### 2.3 Answers arrive with no label

Returned documentation carries a provenance line only on the call that first resolved a package.
Every call after that returns third-party text with nothing saying where it came from, how old it
is, or which version it describes. So the model cannot weigh it, the user cannot check it, and a
reviewer cannot tell whether a claim came from the manual or was invented.

### 2.4 Quiet gaps invite invention

When VibeCTX has nothing on a topic, a thin or empty answer is the worst possible response,
because the agent fills the gap by guessing. `search` handles this well — every response ends with
how many libraries were searched, out of how many, and how to cache the rest. `get_docs` does not.

### 2.5 Reporting healthy while returning nothing

Already observed in production (PAR-704): fastify appeared healthy in `list_libraries` and
returned "No sections matched" for every topic query. `doctor` was built to catch exactly this
class, but its classification never reaches the model — it appears in neither `list_libraries` nor
any `get_docs` response.

## 3. The build, in order

**All of it ships as 0.2.0.** `package.json` goes 0.1.3 → 0.2.0 in the release pull request; there
is no interim tag; `v0.2.0` is cut as the GA release only after the whole set is complete and fully
tested. A11 moves into this release because version-matched documentation is one of the five
problems above. A13 stays 0.3.0. A12 is declined.

| Order | Work | Status |
|---|---|---|
| 1 | **A1–A10** — the audit remediation. One live security defect (A1); the rest are correctness, performance and test-coverage fixes. | Planned, verified, ready |
| 2 | **A11** — version-matched documentation, and **A16** — the package-existence signal. One job: both come from reading the project's manifest. | A11 planned; A16 new |
| 3 | **A17** — a provenance stamp on every response, not just the first. | New; promoted from audit §5.4 item 4 |
| 4 | **A18** — an unmistakable "no documentation on that" from `get_docs`. | New |
| 5 | **A19** — surface `doctor`'s per-library verdict where the model reads it. | New; promoted from the queued follow-up |
| 6 | **A20** — VibeCTX's own activity log: what was consulted, at which version and hash, when. Local, bounded, content-free, read through `vibectx log --json`. | New |

**A11 is no longer blocked on PAR-653.** The probe informs the fallback design but does not gate
the core behaviour: serving the pinned version where a versioned document exists, and saying so
out loud when falling back. Build the core; refine the fallback when the numbers land.

### 3.1 On A20, and why it stays inside the boundary

A20 was nearly cut. The reasoning that nearly cut it was that a consultation record is what turns a
docs cache into part of an agent harness — and becoming part of a harness is what this decision
declines.

That reasoning was wrong, and the distinction matters. **Logging what VibeCTX served is a record of
VibeCTX's own activity** — the same category as `projects/<hash>.json`, which already exists and
already records what `warm` did. What would have been out of scope is a *query interface built for
gates*. There is none: the log is read through `vibectx log --json`, the same envelope every other
command emits. Any harness reads it the way it reads `warm --json`, and a solo user with plain
Claude Code reads it the same way.

It earns its place twice over. It is the only evidence that a consultation an agent claims to have
made actually happened — and it is the only way this project will ever know whether VibeCTX helps,
rather than asserting it the way the tools in the ETH Zurich study did before someone measured them.

## 4. What VibeCTX will not build, and why

| Not building | Incumbent | Reason |
|---|---|---|
| Memory of past conversations | mem0 (64.3k stars), Zep/Graphiti (29k), Letta (24.6k) | Every incumbent requires an LLM at ingestion, which forfeits **offline** and **deterministic** — the two principles the product exists for |
| Writing specs and plans | GitHub Spec Kit (~134k stars, MIT, 30+ agent integrations), BMAD (~52.8k) | Competing with GitHub, for free |
| Architecture rule checking | ArchUnit (v1.4.2), dependency-cruiser (7.1k) | A decade of rules engineering ahead of us |
| Code symbol search | Serena (27.9k, LSP-backed, 40+ languages) | Solved |
| Task and progress tracking | Backlog.md (6.7k), Task Master (28k) | Solved, and closer to the harness than to a docs cache |
| A large project-rules payload served to the agent | — | **Measured and it failed.** Gloaguen et al. (ETH Zurich, Feb 2026): LLM-generated context files −2 to −3% success, +20 to +23% cost; human-written +4% on one benchmark, still +19% cost |

### 4.1 Items dropped from the existing plan

**A12 — local `file://` sources and convention documents: OUT OF SCOPE.** Serving a project's own
architecture decision records, coding standards and glossary is project-internal context, not
documentation caching. It is the expansion this decision declines.

**Consequence for Linear: PAR-660 and PAR-661 should be closed as out of scope**, not left in
Backlog awaiting PAR-653's coverage numbers. The deferral logic is moot — the feature is declined
on scope, not on coverage.

**A13 — private and internal URL sources: STAYS IN.** Documentation behind an authenticated URL is
still documentation. This is a docs cache serving private docs, not a context store. It remains
0.3.0 work and it inherits the `allowInternalHosts` opt-in that A1 builds.

**A14 and A15 stand.** Both are governance and plan reconciliation, unaffected by this decision.

## 5. What VibeCTX will NOT fix — stated plainly

This section exists so nobody, inside or outside, oversells the product.

Tang et al. (Notre Dame / Vanderbilt / Google, May 2026) coded **20,574 real agent sessions** into
**16,118 human-validated failures**. The three most common:

| Failure | Share | Can a docs cache fix it? |
|---|---|---|
| Constraint violation — ignores rules it was already given | **38.33%** | **No** |
| Misread intent — plausible but wrong reading of the request | **26.95%** | **No** |
| Inaccurate self-reporting — claims success it did not achieve | **22.58%** | **Partly** — a provenance stamp lets a reviewer check a claim's source; it does not stop the false claim |

Two further well-evidenced mechanisms are also out of reach: multi-turn reliability collapse
(Laban et al., ICLR 2026 — a 39% drop, agents "get lost and do not recover") and self-conditioning
on prior errors (Sinha et al., ICLR 2026). **Both belong to the harness that runs the agent, not
to the tool that hands it manuals.**

**No claim may be made, in the README, in marketing, or in a Change Record, that VibeCTX keeps an
agent on task, prevents scope creep, prevents architectural drift, or stops hallucination in
general.** It prevents one specific and well-evidenced kind of hallucination — invented package
names — and it removes one specific cause of stale-context work — wrong-version documentation.
Those are the claims the evidence supports. They are worth making. Nothing wider is.

Additionally, per the design doc §1.4, three widely circulated claims are **barred from any VibeCTX
material** because they do not survive scrutiny: that AI makes developers 19% slower (revised by
its own authors to −4% with a confidence interval crossing zero), that AI degrades software
architecture over time (the only causal study found no degradation), and anything sourced to a
2026 Stack Overflow Developer Survey (no such survey exists).

## 6. The product in one sentence

> **VibeCTX gives your AI the right manual, for the right version, with a label saying where it
> came from — and says so out loud when it doesn't have one.**

## 7. What this changes elsewhere in the project

- `claude/VibeCTX-context-layer-design-2026-09-08.md` §7 — the open decision is now closed. The
  research and the evidence in that document remain valid and are the basis for this one; only its
  final recommendation is superseded.
- `claude/VibeCTX-plan-revision-2026-09-08.md` — A16–A19 added; A12 marked out of scope; A11
  unblocked from PAR-653.
- `claude/vibectx-build-session-go.md` — queue updated.
- `.vibectx-plan/PRODUCT-STRATEGY.md` and `.vibectx-plan/LAUNCH-STRATEGY.md` (in the repo) — A15 still stands, and
  this decision makes it more urgent, not less: the strategy documents describe a beachhead reached
  by `npx`, a rival that has moved, and a competitor surface that no longer exists. A scope
  decision this clear deserves strategy documents that match it.
