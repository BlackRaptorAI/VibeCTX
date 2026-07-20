# VibeCTX — Product Strategy & Feature Roadmap

**Owner:** Tom (BlackRaptorAI). **Decided:** 2026-07-20 (CEO, after two Executive
Council convenings). This document is the durable record of the council
verdicts and the CEO's product direction. It supersedes the "minimal-only /
demand-triggered backlog" posture of GitHub issue #2.

---

## The two council verdicts (recorded)

**Convening 1 — "Is there a paid commercial play?" → NO (HIGH confidence).**
Evidence: Context7 shipped a $10/seat Pro tier serving private repos + team
collaboration; the free field is held by `docs-mcp-server` (MIT, ~1.5k★, 72
releases) and the AGENTS.md standard. VibeCTX stays **free MIT OSS** — no paid
tier. This verdict stands.

**Convening 2 — "Would the minimal design be adopted; what's the market?" →
FOR-A-NICHE (Medium-High).** Key findings:
- The docs-to-agent category is proven at scale (Context7 ~54k★, ~8M npm
  downloads). MCP is mainstream (97M monthly SDK downloads, 10k+ servers,
  ~90% of pro devs use an AI coding tool).
- **docs-mcp-server *vacated* the easy-install lane** by requiring Node 22 +
  Docker + an embedding provider. That friction is the opening.
- The offline/deterministic sub-lane is real but modest (tens of thousands of
  devs). Ceiling is governed by **llms.txt adoption** (~5–10% of sites today).
- ICP = **Segment A (solo vibe coders / free-tier refugees)** + **Segment B
  (2–20-dev startups, latency/determinism-sensitive)**. The Context7 free-tier
  cut (Jan 2026, ~92%) created a live pool of frustrated users — a **wasting
  discovery window**.
- Product-strategy dissent (adopted by the CEO): **"no embeddings ever" is a
  liability.** The one independent dev who built a local-first Context7
  alternative is already planning to add embeddings.

## CEO direction (2026-07-20)

Reconcile the two verdicts into a **feature-rich but zero-config** product.
Be feature-rich — approaching docs-mcp-server / Context7 in *capability* —
**with the intent that we are the easiest to install and configure.** Target
segments **A–B, and reach into C (mid-market DevEx)** where zero-config +
optional team features make us adoptable as a standard. Stay free MIT OSS.
Build it right, then push it — **for the right reasons, once it's built.**

## The identity (the one sentence)

> **VibeCTX: batteries-included docs for your AI coding agent — feature-rich
> like the heavy tools, instant like the hosted ones, fully local. `npx` and
> it works; add power only if you want it.**

The moat is **zero-config**, not feature-scarcity. Every feature ships with a
sensible default that requires no setup; power is opt-in, never required.

## The design principles (the bar every feature must clear)

1. **Zero-config or it doesn't ship.** `npx vibectx` must just work — no
   Docker, no database to run, no embedding key to obtain, no config file
   required. A feature that needs setup ships **off by default** with a
   one-line opt-in.
2. **Deterministic by default; embeddings never *required*.** Keyword/BM25 is
   the always-on, offline, reproducible baseline. Optional semantic search
   works out-of-the-box (bundled/zero-config local model) for those who want
   it — capability without the setup tax that sank docs-mcp-server's ease.
3. **Offline-first.** Cache to disk; serve stale (flagged) when the network is
   down. The inner agent loop never blocks on a cloud round-trip.
4. **Honest defaults.** No telemetry without opt-in; stale results labeled;
   no overclaiming in docs or UI.

## Revamped feature set (roadmap)

**Shipped (0.1.x):** llms.txt-first fetch, disk cache (etag/TTL, stale-serve),
heading-split + keyword retrieval, curated 9-library registry, config override,
`list_libraries` / `get_docs` / `refresh`. SSRF same-origin link guard.

**0.2.0 — "Batteries-included, zero-config" (the headline release):**
- **Auto-resolve any package** (`resolve_library`): npm/PyPI metadata →
  llms.txt probing → README/docs fallback. No registry curation required —
  ask for any library, get docs. (Approaches Context7's breadth; the SSRF
  guard is the precondition, already shipped.)
- **Local sources** (`file://` dirs): index a project's own docs, ADRs,
  specs — markdown/text/MDX first, more formats as they prove out.
- **Convention / rules docs as a first-class source** — "how we do things
  here": coding standards, glossary, architecture decisions, served so the
  agent writes code your way.
- **Shareable committed config** (`vibectx.config.json`): check it into the
  repo → every teammate's agent gets byte-identical context. The team
  multiplier; pure differentiation, zero infra.
- **Cross-library search:** one query across the whole cached corpus.
- **Snippet extraction + BM25:** ranked fenced code blocks; better keyword
  scoring — stays deterministic and model-free.

**0.3.0 — "Power, opt-in":**
- **Optional zero-config semantic search:** embeddings that work out of the
  box (bundled small local model or a zero-setup default), off unless enabled.
  Determinism preserved as the default path.
- **Private/internal URL sources** with env-token auth (Context7-can't-do-this
  differentiation; reaches Segment B/C).
- **Version-specific docs:** per-tag resolution, version-aware cache keys.
- **GitHub repo sources** (public first).

**Non-goals (the discipline that protects the moat):** a required Docker
deployment; a required embedding provider; a heavyweight web UI; a required
database. Anything that reintroduces a setup tax is off the table — that tax
is precisely the competitors' weakness we exist to exploit.

## Reachable segments after the revamp

- **A (solo / refugees):** zero-config `npx` + auto-resolve any package →
  strictly better than Context7's throttled free tier. **Beachhead.**
- **B (2–20 startups):** committed config + local sources + optional private
  URLs + offline/deterministic → the team story, no SaaS, no cloud loop.
- **C (mid-market DevEx):** committed team config + convention docs + private
  sources make VibeCTX adoptable as a *dev-local standard* — the segment the
  minimal-only design would have foreclosed, now reachable **because** breadth
  arrived without the setup tax. (Not the org's sanctioned enterprise tool;
  that's still docs-mcp-server/Context7 Pro territory.)

## The honest ceiling (do not forget)

Still a **secondary credibility asset**, not the primary business (the primary
is the Paragon Energy platform). Realistic best case: low-thousands of stars,
a devoted daily-user base — plausibly exceeding docs-mcp-server because we
remove its adoption tax, never threatening Context7's default status. Governed
by llms.txt coverage. Build it excellent and cheap; do not staff it like a
category contender.

## Cheap validation probes (run alongside the build)
1. **Refugee test** — surface it in the Context7 free-tier-backlash threads;
   measure whether frustrated users install and say it solved their problem.
2. **Coverage test** — of the top 50 libraries the ICP actually uses, what %
   have llms.txt good enough that keyword retrieval answers correctly? Under
   50% = a measured ceiling and a reason to prioritize the optional-semantic
   path.
