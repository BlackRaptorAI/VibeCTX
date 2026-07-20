# VibeCTX — Launch / Go-to-Market Strategy

**By gtm-strategy (council), 2026-07-20. Free MIT OSS, secondary credibility
asset, zero budget, organic/earned distribution only. Gate: nothing pushed
until 0.2.0 is genuinely good ("push for the right reasons, once it's built").**

## The wedge (core message)

**"Zero-config local docs for your AI coding agent. One command. No cloud
dependency. No rate limits. Ever."** — the three real fears of the ICP in
2026: setup friction, cloud lock-in, hitting a rate wall mid-session.

Launch-moment hook (Context7-refugee segment, factual not cheap-shot):
"Context7 cut its free tier ~92%. VibeCTX is the local alternative — run it
yourself, no account, no limits, `npx` and it works." Names the market event,
not an attack on their product.

Message hierarchy: primary = zero-config/no-limits/one-command; secondary =
feature-rich (auto-resolve any package, local files, committed team config,
offline BM25); tertiary (Segment B) = committed `vibectx.config.json` → every
teammate's agent gets identical context, zero infra.

## Channels, ranked by ROI (zero budget)

**Tier 1 — high ROI, low effort, compounds forever:**
- **MCP registries** (mcp.so, Smithery.ai, glama.ai/mcp, PulseMCP) — submit to
  all four; a few hours, indexes permanently; ~20–30% of steady-state installs.
- **awesome-mcp-servers lists** (punkpeye, wong2, appcypher) — one-time PRs to
  the "Documentation/Knowledge" category; sustains baseline discovery + SEO.

**Tier 2 — medium ROI, spike-then-decay:**
- **Show HN** — highest variance; front page = ~200–2,000 visitors; honest
  builder's-note framing; ONLY after 0.2.0 is solid (a rough launch here is
  worse than none). Retained-user metric matters more than stars.
- **Reddit** (r/ClaudeAI, r/cursor, r/LocalLLaMA, r/webdev) — NOT an
  announcement post; (a) one honest "I built this" in r/ClaudeAI + (b) helpful
  comments in existing Context7-alternative threads (converts better — found
  when they're already searching).

**Tier 3 — worth doing once:**
- **dev.to/Medium** post titled after the real search query — permanent search
  traffic, slow/steady.
- **X/Twitter** — reply to Context7-rate-limit threads helpfully; do NOT build
  a content calendar (wrong channel for this scale).

**Skip:** Product Hunt (category dead for MCP), YouTube (wrong format), paid
newsletters (budget).

## Launch sequence

**Pre-launch (during the 0.2.0 build):** run the two probes NOW — (1) refugee
test: honest comment in active Context7-cut threads offering testers; (2)
coverage test: of the ICP's top-50 libraries, what % have llms.txt good enough
for keyword retrieval? <50% ⇒ auto-resolve README fallback is the critical
path. Stage registry submissions (write descriptions/metadata) so launch day
is a 30-min action. Treat the README as the landing page.

**Launch moment (48h):** Day0 AM publish 0.2.0 + README → Day0 PM submit 4
registries + 3 awesome-list PRs → Day0 eve r/ClaudeAI "I built this" → Day1 AM
Show HN (3 paras: problem, difference, honest not-yet list) → Day1 PM r/cursor
+ r/LocalLLaMA (IDE angle / offline angle) + dev.to post.

**Post-launch (wk 2–8, low effort):** answer every issue/comment <24h (aliveness
signal beats star count); join Context7-alternative threads helpfully; if a
popular library has weak llms.txt, that's a technical blog post.

## Honesty guardrails (brand defense — the founder's brand IS the asset)

Never claim: "better than Context7" (claim the axis — zero-config/local/no-
limits — not the overall); "production-ready"; "works with every library"
(coverage ceiling is real, document it); any unverifiable guarantee. Every
README/launch claim must be reader-testable within 5 minutes of install.
Engage the backlash audience as "here is a local option," never "they betrayed
you" (don't echo "quietly slashed"). If Context7 responds, be collegial. This
aligns with the product's own "honest defaults" principle.

## Metrics that matter

Stars are vanity. Truth = **retained weekly npm downloads at week 4 vs week-1
peak.** >30% = real retention; <10% = curiosity that didn't convert. Watch:
(1) week-4 retention; (2) issue nature (real use-case errors/feature asks =
engagement; silence = nobody cared); (3) organic mentions not from the founder.

**Invest more** iff: organic wild mentions + week-4 downloads >500 + ≥1 user
publicly committed their `vibectx.config.json`. **Leave it** iff: week-4 <200,
no organic mentions, issues are only bugs → fix bugs, keep listings current,
stop investing launch effort.

## What we lose / risks

1. **Founder-time diversion from the primary objective (dominant risk)** —
   budget it: ~4 concentrated launch days, then ≤2 hrs/week maintenance, held
   regardless of response.
2. **Cheap-shot brand risk** — mitigated by the guardrails.
3. **Over-investment in a niche** — the signal thresholds are the circuit
   breaker; realistic ceiling is modest.
4. **Discovery window closing** — the Context7-backlash pool is a wasting
   asset; don't delay for perfection, but the floor is genuinely good.
5. **Product can't keep the promise (existential GTM risk)** — enforce
   "zero-config or it doesn't ship" as a hard launch gate: if `npx vibectx`
   needs any extra step for the common case, don't launch.

## What would change the plan
- Coverage probe <30% ⇒ narrow the narrative, wait for optional semantic
  search (0.3.0); don't claim "resolves any library" before coverage is real.
- A direct zero-config-local competitor ships first ⇒ shift to the Segment-B
  committed-team-config angle.
- A Paragon Energy critical gate needs full founder attention ⇒ defer cleanly;
  a mediocre half-effort launch is worse than a delayed good one.
