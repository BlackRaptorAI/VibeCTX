# Change Record — CR-20260906-par-655-resolve

## 1. Change summary

| Field | Value |
|---|---|
| CR ID | CR-20260906-par-655-resolve |
| PR | #___ (branch `build/par-655-resolve`, stacked on `build/par-654-registry`; range 17ac495…1c774f1 + this CR commit) |
| Spec / plan | Linear PAR-655 (0.2.0 / 3); docs/plans/vibectx-build-loop-state.md D-04 (primary redirect exemption, now narrowed — see D-08) |
| Author | Tom Hanks (BlackRaptor AI) — produced by the vendored engineering pack 2.0.0 under oversight |
| Date | 2026-09-06 |
| Risk tier | Tier 1 by the gate map (no `.claude/`, `.github/`, `package.json` change) — but the highest-risk product change in 0.2.0: `src/fetcher.ts` link policy and redirect handling changed, routed to security-architect (three rounds). CR written to carry the verdicts. |
| Emergency? | No |

**What changed and why (2–5 sentences):**
"Ask for any library, get docs" is the promise the product is positioned on; until now an unknown name returned `Unknown library`. `resolve_library(name)` resolves any npm or PyPI package: registry/alias hit → package metadata (npm `/latest`, PyPI JSON; docs-site preference with other-ecosystem fallback) → `llms-full.txt`/`llms.txt` candidates synthesized from the homepage/docs URL → GitHub README via `raw.githubusercontent.com` (`HEAD`, four filename variants) → a clear could-not-resolve message. Resolutions persist to `<cacheRoot>/resolved.json` (atomic, validated on load, never above defaults/config); `get_docs` resolves implicitly with a provenance line; CLI `vibectx resolve`; `refresh` re-resolves; `list_libraries` marks `[resolved]`. The strict same-origin guard for followed links became an allowed-host policy (`allowedHosts` on entries; derived hosts for resolved entries), with one policy function used by the pre-check, the safety check, and — new — every redirect hop. Because a package publisher can now choose a primary URL, the security gate required and this change closes the previously accepted blind-SSRF-via-redirect follow-up: `fetchUrl` follows redirects hop-by-hop with every `Location` pre-flighted before it is requested.

**Blast radius if wrong (prod deploys on merge — be honest):**
`get_docs` on an unknown name now issues up to 26 outbound requests (metadata + candidates + README variants) to registry.npmjs.org, pypi.org, docs hosts, and raw.githubusercontent.com — capped at 100 resolutions per process-hour. A wrong policy would let attacker-published metadata steer fetches; the gate's local-listener probes show zero requests reach http/IP/localhost targets on any hop for any caller. A typo (`reakt`) resolves to a real unrelated package — mitigated by the provenance line and nearest-curated-name hint, not prevented. Curated and config entries cannot be shadowed or overwritten by persisted resolutions (tested with planted records).

**Behaviour changes worth knowing (release notes):**
1. Unknown library names resolve online (npm, then PyPI; docs-site preference). Offline behaviour unchanged. Response begins with `> Resolved "<name>" via <ecosystem> on this call — not a curated entry … nearest curated name: "<x>"`.
2. New MCP tool `resolve_library(name, ecosystem?)`; CLI `vibectx resolve <name> [--npm|--pypi] [--config]` (exit 0/1/2); `list_libraries` marks `[resolved]` and prefixes package-supplied descriptions with `(package-supplied)`.
3. `<cacheRoot>/resolved.json` (schemaVersion 1, internal file): validated on load; unknown schema versions are ignored and never overwritten; persisted `allowedHosts` are never honoured (re-derived).
4. `allowedHosts?: string[]` on config entries (hostnames, optional `*.` prefix; folded; no IPs/localhost/.local/.internal/trailing-dot).
5. Redirects: hop-by-hop, ≤5 hops, every `Location` must be `https:` on a non-forbidden host (all callers) and within the allowed-host policy (followed links); the body is never read and no request is issued on refusal. **D-08 narrows D-04:** curated primaries still follow cross-host https freely, but never to http/IP/localhost.
6. Resolution bounds: ≤26 fetches per name (2 metadata + 12 candidates preferred ecosystem + 12 fallback, worst case 18 in practice); 100 resolutions per process-hour; 8 MiB metadata cap.
7. Curated/config names and aliases also claim their PEP 503 spelling; PyPI resolutions are keyed by PEP 503 name; lookups fall back to PEP 503 comparison curated-first (so `react_router` finds `react-router`).
8. Known, documented limits: name-based host checks cannot stop DNS tricks (`127.0.0.1.nip.io` — TLS name verification prevents a body read); llms.txt discovery NOT VERIFIED live from the build sandbox (docs hosts blocked) — the GitHub README path was exercised live against npm and PyPI packages.

## 2. Gate decisions

| Gate role | Your pack's seat (see `seat-list.md`) | Applies? | Agent verdict (PASS / CONCERNS / FAIL / COULD NOT ASSESS) | My decision (ACCEPT / ACCEPT-WITH-RISK / REWORK) | Initials + date |
|---|---|---|---|---|---|
| Security (auth/RBAC/tenant/remote-access) | `security-architect` | Yes — link policy, redirect handling, untrusted metadata, persisted store | Round 1 **FAIL** (blind SSRF via redirect-follow; planted `resolved.json` shadowing) → **re-review PASS (9/10, no conditions)** | | |
| Privacy | `privacy-counsel` | N/A: no personal data; package metadata is public | | | |
| Compliance | `compliance-officer` | N/A | | | |
| Domain | `domain-compliance` | N/A | | | |
| Schema (interface shapes: config, resolved.json, tool inputs, text) | `schema-reviewer` | Yes | Round 1 CONCERNS (3) → re-review CONCERNS (1: PEP 503 precedence) → **re-review 2 PASS (9/10)** | | |
| Operational readiness | `operational-readiness` | N/A: no automated consequential action; outbound fetches are bounded and documented | | | |
| UX | `ux-designer` | N/A | | | |
| Quality (TDD followed, coverage thresholds) | `test-auditor` | Yes | Round 1 CONCERNS (2) → **re-review PASS (9/10)** — 10 mutants, all non-equivalent ones killed | | |
| Review (last gate before merge) | `code-reviewer` | Yes | Round 1 CONCERNS (3) → **re-review PASS (8/10)** | | |

**Producer:** `backend-engineer` charter, three rounds (70c0464…491f490; 6b7a2ef…1eae135; 1c774f1). **Oversight decision D-08:** hop-by-hop redirect pre-flight for all callers; curated primaries keep cross-host https (D-04) but never http/IP/localhost. **Closing gate:** `completion-auditor` — §3.

## 3. Agent analysis (evidence)

<details><summary>security-architect — re-review (final)</summary>

```verdict
{"gate":"security","agent":"security-architect","artifact":"PAR-655 / build/par-655-resolve 0a08464...1eae135 (re-review)","verdict":"PASS","confidence":9,"falsifier":"any request from fetchUrl reaching an http/IP/localhost/trailing-dot target on any hop for the linkGuard, publicFinalUrl or curated-primary path, or a resolved.json record that makes resolveLibrary return a non-curated entry for a curated name or alias","evidence":"src/fetcher.ts:65-69,111-146 hop-by-hop manual redirects pre-flighted by isPublicHttpsUrl (+isAllowedLink under linkGuard) — MEASURED probe2b at 1eae135: zero requests at a real 127.0.0.1 listener across 12 redirect shapes on all three caller paths, 5 hops served / 6 hops miss, 304 and stale paths intact; src/resolved-store.ts:49 + src/registry.ts:532-539 — MEASURED probe3b: planted React/NextJS/'next.js ' records dropped and every curated entry object unchanged after refresh, resolve_library, get_docs and direct install; src/resolve.ts:353-359 cap before first fetch (105 names -> 200 fetches, 5 refused); suite 467/467, tsc clean","standards":["none: practice applied: STRIDE re-walk of server->remote-host and server->disk-cache boundaries; enforcement-liveness caller tracing; executed local-listener and hostile-file probes"],"conditions":[]}
```

Round 1 (at 491f490) **FAIL**: F1 [HIGH] `redirect:"follow"` issued the redirected request before the policy ran — a real 127.0.0.1 listener received `GET /admin/reboot?x=1` on the `publicFinalUrl`, `linkGuard` and live `getLibraryDoc(resolved)` paths; with PAR-655 a package publisher chooses the primary URL, so the 0.1.3 acceptance no longer held. F2 [MEDIUM] a planted `resolved.json` record named `React` shadowed the curated `react` (exact-match preference) and `refresh` overwrote it. Both closed in 6b7a2ef/26ad0d8 and re-probed. Residual advisory: a `Location` carrying userinfo is still requested on the no-guard paths (reaches only the attacker's own host); `127.0.0.1.nip.io` remains name-accepted (documented; TLS blocks a body read). Commit 1c774f1 (after this verdict) touched only `src/registry.ts`, `src/resolve.ts` lookup, README and tests — no fetcher/link-policy change (verified by oversight: `git diff 1eae135..1c774f1 --stat -- src/fetcher.ts src/link-policy.ts` is empty).
</details>

<details><summary>code-reviewer — re-review (final)</summary>

```verdict
{"gate":"review","agent":"code-reviewer","artifact":"PAR-655 / build/par-655-resolve 0a08464...1eae135 (re-review)","verdict":"PASS","confidence":8,"falsifier":"a live run of the built head in which `vibectx resolve left-pad` (no flag) fails to resolve, or `isForbiddenHost(\"localhost.\")` returns false, or implicit get_docs(\"reakt\") returns text that does not begin with the provenance line","evidence":"MEASURED on 1eae135: lint clean, 467/467 tests; src/link-policy.ts:37 trailing dot refused (metadata.google.internal., localhost., foo., x.local., example.com. all forbidden in isForbiddenHost, sanitizeRemoteUrl and fetcher isPublicHttpsUrl); src/resolve.ts:397-414 other-ecosystem fallback — `resolve left-pad` returns stevemao/left-pad README exit 0; src/limits.ts:19 MAX_FETCHES_PER_RESOLUTION=26 matches README 'at most 26 requests… worst case 18'; src/get-docs.ts:83-101 get_docs(\"reakt\") starts with the provenance line carrying (package-supplied) description, repository and nearest curated name \"react\"; src/registry.ts:532-540 installResolvedEntry refuses a resolved 'react' over the curated one and refuses an unmarked entry; PEP 503 key: typing_extensions / Typing.Extensions both hit the typing-extensions record","standards":["none: practice applied: adversarial diff re-review per gate-verdict-format, enforcement-liveness spot-checks of the redirect hop guard and install guard, live CLI execution against registry.npmjs.org, pypi.org and raw.githubusercontent.com"],"conditions":[]}
```

Round 1 CONCERNS: trailing-dot FQDNs bypassed `isForbiddenHost`; docs-site preference dead-ended (`left-pad`: a PyPI squatter with a docs-looking homepage blocked npm's README); implicit resolution carried no provenance. All closed. The reviewer judged the producer's four spec deviations on evidence and accepted each (npm `/latest`; README via `HEAD` + variants — `Django` chose `README.rst` at position 8; docs-site preference with fallback; `--npm|--pypi`).
</details>

<details><summary>test-auditor — re-review (final)</summary>

```verdict
{"gate":"quality","agent":"test-auditor","artifact":"PAR-655 / build/par-655-resolve 0a08464...1eae135 (re-review)","verdict":"PASS","confidence":9,"falsifier":"a surviving non-equivalent mutant on the redirect hop loop (src/fetcher.ts:118-135) or on installResolvedEntry (src/registry.ts:532-539) — every one I wrote went red","conditions":[],"standards":["none: practice applied: mutation testing (10 mutants on a fresh scratch copy of 1eae135) plus acceptance-criteria-to-test traceability"],"evidence":"MEASURED on scratch copy of 1eae135: 467/467 green x3 plus 10 mutant runs, tsc clean; red counts — M2 1 (Q1, test/get-docs.test.ts), M8b 0 (equivalent mutant: 2 bases x 4 URLs = 8 = MAX_LLMS_CANDIDATES, cap at src/resolve.ts:215 unreachable), Ma 1, Mb 2, Mc 1, Md 3, Me 2, Mf 1, Mg 3, Mh 2; listener tests use node:http createServer on 127.0.0.1:0 (test/fetcher.test.ts:420-430), assert recorded listenerHits (:455,:465,:479,:486-488), close in afterEach (:433-435); Q2 asserts toHaveBeenCalledTimes(18) equality (test/resolve.test.ts:508-509); coverage fetcher 87.92/90.98 (145-151 post-loop belt-and-braces unreachable), get-docs 100/96.72, registry 100/97.36, resolve 98.39/95.45, resolved-store 97.29/97.5, link-policy 100/99.06, limits 100/100, package-names 100/100, refresh 100/93.75, source-kind 84.61/80"}
```

Round 1 CONCERNS: no end-to-end test of a resolved entry following links under derived hosts (mutant survived); fetch-bound test loose. Both closed. Final suite at 1c774f1: 471/471 (four PEP 503 precedence tests added after this verdict).
</details>

<details><summary>schema-reviewer — re-review 2 (final)</summary>

```verdict
{"gate":"schema","agent":"schema-reviewer","artifact":"PAR-655 / build/par-655-resolve 0a08464...1c774f1 (re-review 2)","verdict":"PASS","confidence":9,"falsifier":"a config entry `typing_extensions` plus a persisted or live resolved record `typing-extensions` yielding two registry keys, or resolveLibrary('Typing.Extensions') returning the resolved record instead of the pin","conditions":[],"standards":["none: practice applied: additive/backward-compatible interface change review (versioned store, loader allow-list, precedence parity with README)"],"evidence":"MEASURED 2026-09-06 on a scratch build of 1c774f1: config typing_extensions + persisted typing-extensions → one key ['typing_extensions'] (src/registry.ts:518-541 curatedKeys/isTaken); resolveLibrary for typing_extensions / typing-extensions / Typing.Extensions all return the pin's URL (src/registry.ts:583-597, curated-first); installResolvedEntry(typing-extensions) → false (src/registry.ts:552); README.md:232-235 precedence bullet present. Side effect: react_router → react-router, Next_JS → next.js, shadcn_ui → shadcn — lookup semantics only; no persisted, config, doctor --json or list_libraries shape changes. Observation: two config entries that are PEP 503 twins (foo-bar, foo_bar) both load and a non-exact lookup (foo.bar) returns the first in registry order — exact keys still resolve exactly; validateAliases does not flag the twin. 471/471 vitest."}
```

Rounds 1–2 CONCERNS: persisted URL cap (10) below the resolver bound (12); a foreign `schemaVersion` file was overwritten on save; README lacked `resolve` exit codes / non-contract note; PEP 503 precedence gap. All closed. Follow-up (non-blocking): flag PEP 503 twin config entries in `validateAliases`.
</details>

<details><summary>completion-auditor (closing gate)</summary>

```verdict
{"gate":"completion","agent":"completion-auditor","artifact":"PAR-655 / build/par-655-resolve 17ac495..91622df","verdict":"CONCERNS","confidence":8,"falsifier":"a fresh-install get_docs(\"httpx\",\"timeouts\") from a host that reaches www.python-httpx.org returning the llms.txt-derived timeouts section, plus a test asserting isAllowedLink(\"file:///etc/passwd\", src) is false","evidence":"MEASURED 2026-09-06 at 91622df: lint 0, vitest 471/471, build 0; CLI resolve httpx exit 0 (README.md chosen), nonsense exit 1, URL exit 1 'nothing was fetched', --bogus exit 2; doctor --offline 1/1; resolved.json schemaVersion 1 no allowedHosts; get_docs drizzle-orm/migrations -> README '## Ecosystem', httpx/timeouts -> README '## Features' (docs hosts proxy-403, llms.txt unmeasurable); src/fetcher.ts:117-131 hop loop, src/resolve.ts:290,401 caps live; file: link refused at src/link-policy.ts:109 but only tested via sanitizeRemoteUrl (test/link-policy.test.ts:217); state next stale at docs/plans/vibectx-build-loop-state.md:53,56-57","standards":["none: practice applied: ground-truth re-derivation (git/npm/vitest/live CLI), done-criteria traceability, phantom-mechanism hunt per gate-verdict-format"],"conditions":["add file:///etc/passwd to the refused-link loop at test/fetcher.test.ts:195 (or an isAllowedLink case) and keep 471+ green","prune docs/plans/vibectx-build-loop-state.md next: drop line 53 and the shipped hop-by-hop item from lines 56-57","record in CR §5 row 1 that both done-condition queries answered from the GitHub README fallback in the sandbox"]}
```

All three conditions closed before landing: 766d537 adds `file:`/`javascript:`/`data:` refusal tests on the link guard and through `getLinkedPage`/`fetchLinkedPage` with zero fetch calls (suite 473/473); state file `next` pruned; §5 row 1 amended below. Done-criteria: both queries MET on a fresh install with no config, answered from the GitHub README fallback (drizzle-orm → `## Ecosystem`, httpx → `## Features` "Strict timeouts everywhere") — llms.txt path unmeasurable from the sandbox.
</details>

## 4. Mechanical evidence (Layer 1)

- CI run: <link on PR>
- Local at 1c774f1 (MEASURED 2026-09-06, Node 22.22.2): `npm run lint` clean; `npx vitest run` 471/471 in 13 files; `npm run build` clean.
- Live from the build sandbox (registry.npmjs.org, pypi.org, raw.githubusercontent.com reachable): `httpx`, `fastapi`, `Django` (README.rst), `requests`, `flask` via PyPI; `@tanstack/react-query`, `express`, `left-pad`, `is-odd`, `reakt` via npm; nonsense name → could-not-resolve after 2 fetches; `https://evil.example/x` refused with 0 fetches. Local-listener probes: zero requests to forbidden redirect targets across 12 shapes and all caller paths.
- Coverage (scratch v8): new modules 96–100 % statements; fetcher 87.9 % (post-loop belt-and-braces unreachable by design).

## 5. Deviations & risk acceptance

| What | Agent said | I decided | Why acceptable | Revisit by |
|---|---|---|---|---|
| llms.txt discovery NOT VERIFIED against live docs hosts; both done-condition queries (`drizzle-orm`/migrations, `httpx`/timeouts) answered from the GitHub README fallback in the sandbox | producer + all gates + completion-auditor | ___ | Sandbox blocks docs hosts (proxy 403); README/GitHub path exercised live; `vibectx doctor` / `resolve httpx` from the Mac (PAR-653) is the measurement | PAR-653 run |
| Typo resolves to a real unrelated package | code-reviewer (closed by provenance line) | ___ | Provenance line + nearest curated name; fuzzy refusal would break legitimate lookups | 0.2.x |
| `127.0.0.1.nip.io`-class DNS tricks name-accepted | security [LOW] | ___ | TLS name verification prevents any body read; documented in README security note | If a DNS-resolution check is ever added |
| Userinfo `Location` requested on no-guard paths | security advisory | ___ | Reaches only the attacker's own host; `linkGuard` path refuses | 0.2.x |
| No cross-process resolution quota (100/h is per process) | security [LOW] | ___ | Local single-user tool; documented | — |
| PEP 503 twin config entries both load | schema observation | ___ | Exact keys resolve exactly; validation follow-up queued | 0.2.x |

## 6. Emergency addendum

Not applicable.

## 7. Sign-off

**Signed:** ______________  **Date:** ___________
