# Change Record — CR-20260909-par-714-url-host-policy

Written under the **2.1.0 / 2.0.0-schema** template (`change-record-template.md`, copied from
Core 2.1.0 on 2026-09-08). This is the first Change Record in this project under that schema:
integer `confidence` 0–10, `standards` required, `evidence` a string, no `N/A` verdict value.

The four retired governance files beside this one (`change-record-policy.md`,
`gate-enforcement-map.md`, `branch-protection-checklist.md`, `change-record-template.RETIRED-pre-2.0.0.md`)
describe a CI gate, a `GATED` array and a validator that no longer exist in this repository and
were **not** cited as authority anywhere in this record or in the gate reviews below.

## 1. Change summary

| Field | Value |
|---|---|
| CR ID | CR-20260909-par-714-url-host-policy |
| PR | none yet — local branch, not pushed (no agent session can push to this repository) |
| Spec / plan | `.vibectx-plan/vibectx-phase2-go.md` §4 (A1) · `.vibectx-plan/VibeCTX-020-phased-build-plan.md` Phase 2 / Gate 2 · `.vibectx-plan/VibeCTX-plan-revision-2026-09-08.md` §A1, §A14 |
| Author | Phase 2 build session (Claude Sonnet 5), producer role |
| Date | 2026-09-09 |
| Risk tier | Tier 2 (sensitive) — closes an active SSRF; touches the URL trust boundary |
| Emergency? | No |

**What changed and why.** `src/config.ts` validated a config library entry's `urls` with
`isHttpsUrl` — protocol only, no host check — so a committed `vibectx.config.json` naming an
internal, loopback or link-local host was fetched by `startAutowarm` at server startup with no
user action, and the response reached `list_libraries`, `get_docs` and `search` tool output
(SSRF; VibeCTX-audit-2026-09-08.md §4.1). `src/link-policy.ts` now exports `validateLibraryUrl`,
the sole gate on this decision (D-49), applying the same `isForbiddenHost` check `allowedHosts`
already used, with a new explicit per-entry `allowInternalHosts` opt-in (D-47, default false) for
the air-gapped / internal-docs case. `src/config.ts`'s `EntrySchema` calls it per-URL via
`superRefine` rather than re-implementing any part of it. A2 (PAR-715, the `maxTokens` bound) is
a separate item and is **not** in this branch or this record.

**Blast radius if wrong.** This is a local MCP server with no shared production deployment — the
"blast radius" is any user who upgrades to a version with this fix and has, or is given, a
`vibectx.config.json` naming an internal host without `allowInternalHosts: true`: that config
layer is now rejected (soft-skip on auto-discovery, fatal on an explicit `--config`/env source),
and the affected entries fall back to whatever the layers below provide (user config, then
shipped defaults). No data loss; the failure mode is "that library is unavailable until the
config is fixed," reported in one line naming the file, entry and reason. If the fix itself were
wrong in the *other* direction (too permissive), the blast radius is the original vulnerability:
an internal endpoint's response reaching model-visible tool output.

## 2. Gate decisions

| Gate role | Seat (2.1.0 naming) | Applies? | Agent verdict (final) | My decision | Initials + date |
|---|---|---|---|---|---|
| Security (SSRF / URL trust boundary) | `security-architect` — **BLOCKING** | Yes | **PASS** (round 1 confidence 8, round 2 confidence 8 — holds) | ACCEPT | build-session, 2026-09-09 |
| Review (conventions, correctness, reuse) | `code-reviewer` | Yes | **PASS** (round 3, confidence 9, mutation-verified) — round 1 FAIL was process-only (this CR did not yet exist); round 2 CONCERNS on two measured test defects, both fixed and reverified | ACCEPT | build-session, 2026-09-09 |
| Quality (test adequacy) | `test-auditor` | Yes | **PASS** (round 2, scoped, confidence 8) — round 1 CONCERNS on one real defect (inert listener assertion), fixed and reverified | ACCEPT | build-session, 2026-09-09 |
| Schema (migrations) | `schema-reviewer` | N/A: no database schema or migration in this change — `EntrySchema` is a runtime zod validator, not a persisted-data schema | — | — | — |
| Privacy | `privacy-counsel` | N/A: no new personal data collected, stored or sent to a model; the change *rejects* certain URLs rather than processing new data | — | — | — |
| Compliance (SOC2/ISO) | `compliance-officer` | N/A: this project carries no SOC2/ISO control program | — | — | — |
| Domain | `domain-compliance` | N/A: VibeCTX is not in a regulated domain | — | — | — |
| Operational readiness (HITL) | `operational-readiness` | N/A: no automated/consequential action is introduced; the change makes an existing automatic action (startup autowarm fetch) safer, and its only human-facing surface is a one-line rejection message this record verifies | — | — | — |
| UX | `ux-designer` | N/A: no user interface; the one behavior-visible change is a stderr/header message, reviewed under Quality/Review above | — | — | — |
| Completion | `completion-auditor` | Yes, before handoff to Tom | Not yet run — see §4 | — | — |

`security-architect`'s round-1 PASS carried confidence 8 with zero conditions; its round-2 PASS
(scoped to the delta after round-2 test/doc fixes) also carried confidence 8 with zero
conditions and two non-blocking recommendations, both accepted below (§5, R3/R5 — R1/R2/R4 were
implemented, not merely accepted). Per Gate 2's explicit wording ("`security-architect` verdict
is PASS, not CONCERNS-with-conditions-open"), this is met.

## 3. Agent analysis (evidence)

Three review rounds ran on this branch as it was built and fixed in response to findings — this
section is the full history, not just the final verdicts, per this project's D-55 rule ("paste
the gate output; do not summarise it") and the rule against ever emitting a verdict block in the
orchestrator's own output. Every block below is verbatim from the named agent's own output.

### Round 1 (branch tip `ec9ff35`)

<details><summary>security-architect — round 1 — PASS</summary>

```verdict
{"gate":"security","agent":"security-architect","artifact":"A1 / PAR-714 — branch build/a1-url-host-policy (base main@2e691d1): config-authored `urls` host policy (src/link-policy.ts validateLibraryUrl, src/config.ts EntrySchema.superRefine, tests in test/{config,link-policy,autowarm,registry,warm}.test.ts)","verdict":"PASS","confidence":8,"falsifier":"A reachable path that puts a config-file-derived LibraryEntry into registry.entries without going through readConfigFile's ConfigSchema.safeParse — or evidence that EntrySchema's superRefine does not execute on a shape-valid entry in the installed zod build (e.g. a run of test/config.test.ts:518-533 passing with src/link-policy.ts:106's isForbiddenHost call reverted).","evidence":"src/link-policy.ts:92-107 (validateLibraryUrl calls isForbiddenHost at :106, after the https-only :104 and userinfo :105 checks); src/config.ts:364-374 (superRefine per urls element, passing entry.allowInternalHosts) with the type gate at :362; sole caller trace src/config.ts:367 -> :381 -> :460 -> src/registry.ts:655 -> :598 -> :688 -> src/index.ts:30, then src/server.ts:195; zod semantics verified in node_modules/zod/v3/types.js:3238-3250 + 3560-3592 and helpers/parseUtil.js:82-99 (a failing z.custom aborts the object, so the refinement never runs on a malformed urls and the entry is rejected regardless); fetcher.ts:275 passes publicFinalUrl:false for a non-resolved entry, so admission time is the only gate; enforcement-liveness test test/autowarm.test.ts:300-351 fails on revert at :338, :340 and :349. NOT EXECUTED: no shell in this session — no test run and no git diff; change set bounded by mtime ordering to 7 files under src/ and test/.","standards":[{"designation":"CWE-918: Server-Side Request Forgery (SSRF)","edition":"CWE 4.20","clause":"Base weakness entry 918 (Mapping: ALLOWED)","access":"full text","verified":"2026-09-09"},{"designation":"none: practice applied: STRIDE per-trust-boundary threat model over the committed-config, startup-fetch and persisted-resolution boundaries, plus a caller-trace enforcement-liveness proof of the validating function on the live path","edition":"n/a","clause":"n/a","access":"full text","verified":"2026-09-09"}],"conditions":[]}
```

Residual risks named (not blocking): name-based host checks cannot see through DNS
(`https://127.0.0.1.nip.io/`); config-authored URLs can still direct startup fetches at arbitrary
*public* hosts (inherent to the product); no cap on `urls.length` per entry (pre-existing, not in
A1's scope). Recommendations R1 (strengthen the listener assertion), R2 (test a top-level
`allowInternalHosts` is inert), R3 (document the field in README, since its absence could push a
blocked user toward the stale unsafe `0.1.2` release on npm) — all non-blocking, R1 and R3
implemented in round 2, R2 not implemented (accepted as a gap, §5).

</details>

<details><summary>code-reviewer — round 1 — FAIL (process only)</summary>

```verdict
{"gate":"review","agent":"code-reviewer","artifact":"branch build/a1-url-host-policy (main@2e691d1..ec9ff35), A1/PAR-714 config urls host policy","verdict":"FAIL","confidence":9,"falsifier":"A Change Record at .vibectx-plan/change-records/ for PAR-714 carrying a security-architect PASS verdict and stating D-47 — its existence would clear the sole blocking finding and move this to PASS or CONCERNS on the Should-fix items alone.","evidence":"VibeCTX-020-phased-build-plan.md:103,115,116,121 requires a Change Record and a security-architect PASS for PAR-714; grep -rl 'PAR-714' .vibectx-plan/change-records/ returns nothing across 13 existing CRs. Gates green locally: lint exit 0, npm test exit 0 (1096 passed/33 files), build exit 0. Supporting: README.md:615 claim falsified by src/config.ts:362 new allowInternalHosts field, undocumented at README.md:816-823; src/link-policy.ts:142 refuses internal index links so the opt-in is narrower than its comment at :86-88 claims; src/config.ts:365 unguarded forEach depends on zod fatal default confirmed at node_modules/zod/src/v3/types.ts:4935.","standards":["none: practice applied: the repository's own live phase-gate criteria in .vibectx-plan/VibeCTX-020-phased-build-plan.md (Gate 2) and decisions D-47/D-49/D-52 in vibectx-build-loop-state.md. The superseded .vibectx-plan/change-record-policy.md was deliberately NOT relied on: it is marked RETIRED and its header states that citing its gated-path list is reasoning from a control that no longer exists."],"conditions":["Write .vibectx-plan/change-records/CR-<date>-par-714-url-host-policy.md, state decision D-47, and obtain a security-architect verdict of PASS (not CONCERNS-with-conditions-open) per build plan lines 115-116.","Document allowInternalHosts in README.md's config-field reference (:816-823) and qualify the now-false 'every fetch vibectx makes' claim at README.md:615.","Narrow the src/link-policy.ts:86-88 comment, or document the limitation: allowInternalHosts opens the primary fetch only; isAllowedLink (:142) still refuses every internal index link.","Have the security-architect explicitly narrow the two Gate 2 criteria that are not met as written — listener-zero is proven for 1 of 7 cases, and 'loads and fetches' is proven only as far as 'is scheduled for fetch' (fetchDoc stubbed at test/autowarm.test.ts:98)."]}
```

FAIL was on the missing Change Record (this document) and a security-architect PASS being on
record — both now satisfied by this record's existence and §2 above. All four should-fix/nit
items it raised (S1–S6, three condition items) were addressed in round 2 (README documentation,
comment narrowing) — see round 2 below.

</details>

<details><summary>test-auditor — round 1 — CONCERNS (real defect found)</summary>

```verdict
{"gate":"quality","agent":"test-auditor","artifact":"build/a1-url-host-policy @ ec9ff35 — test/autowarm.test.ts, test/config.test.ts, test/link-policy.test.ts (A1 / PAR-714)","verdict":"CONCERNS","confidence":7,"falsifier":"Executing the suite with isForbiddenHost's host check deleted from src/link-policy.ts and observing autowarm.test.ts:350 go red (listenerHits non-empty) would disprove the headline finding and move this to PASS.","conditions":["Replace the inert listener assertion at test/autowarm.test.ts:350: an https:// target against a plain node:http server can never invoke the request handler, so instrument the TCP accept instead — server.on(\"connection\", () => { connections += 1; }) with expect(connections).toBe(0) — which fires regardless of protocol and goes red under a reverted fix.","Add a positive control to the A1 liveness block proving the listener instrument can record a hit, mirroring test/fetcher.test.ts:500-507; without one, no absence-of-request assertion in that block is trustworthy.","Extend the real-http.Server / zero-hit proof from 1 of 7 forbidden shapes to all seven, as Gate 2 criterion 2 requires.","Assert config.files[].error for the remaining six forbidden shapes at the discovery layer, not only the direct readConfigFile throw (Gate 2 criterion 1).","Add one assertion that an A1 host rejection surfaces in the rendered list_libraries header via describeConfig/listLibrariesText; current NOT LOADED header coverage is only invalid-JSON and not-a-regular-file.","Correct the block comment at test/autowarm.test.ts:292-299, which overstates the proof as network-level.","Strengthen test/link-policy.test.ts:188 from /^urls:/ to per-shape failure-mode messages, so a mutation in one branch of isForbiddenHost cannot be absorbed by an overlapping branch.","Run the full suite on a clean clone and reconcile the pass/file count against the CLAUDE.md baseline (1061 / 33 at 2e691d1) and the gate log before merge — not performed in this audit."],"standards":["none: practice applied: acceptance-criteria-to-test traceability, with per-assertion mutation analysis against the reverted fix and enforcement-liveness review of the startAutowarm path"],"evidence":"test/autowarm.test.ts:350 — expect(listenerHits).toEqual([]) cannot fail: the target is https://127.0.0.1:<port> (line 331) but the server is node:http createServer (line 312), so the TLS ClientHello dies in llhttp and the request callback never runs. The cited model pattern uses http:// targets (test/fetcher.test.ts:471,495) and carries a positive control (test/fetcher.test.ts:500-507); this block has neither. Regression is still caught by test/autowarm.test.ts:338, :340 and :349. Strong coverage confirmed at test/config.test.ts:508-523 (all seven shapes, anchored D-22 regex) and test/config.test.ts:549-571 (opt-in non-bypass, default-false, non-boolean). Full-suite pass count NOT MEASURED — Bash disabled in this session."}
```

Headline finding — the `listenerHits`-only assertion was inert (an `https://` target against a
plain, non-TLS test server means the TLS handshake fails before the HTTP request handler ever
runs, so that assertion could not go red under a reverted fix) — confirmed by every subsequent
round and fixed in round 2 with a TCP-connection-level counter.

</details>

### Round 2 (branch tip `027bcd7`) — scoped to the delta since round 1

<details><summary>security-architect — round 2 — PASS holds</summary>

```verdict
{"gate":"security","agent":"security-architect","artifact":"A1/PAR-714 round-2 delta on branch build/a1-url-host-policy (ec9ff35..027bcd7): src/config.ts superRefine guard, test/autowarm.test.ts connections instrument, test/config.test.ts assertion, README.md + link-policy.ts doc comment","verdict":"PASS","confidence":8,"falsifier":"A git diff of ec9ff35..027bcd7 showing a change to any src/ file other than config.ts and link-policy.ts (which I read in full at the tip but could not diff — no Bash tool this session), or evidence that allowInternalHosts is read anywhere other than src/config.ts:373","evidence":"src/config.ts:370 guard can fire only on input the shape check at src/config.ts:346 already rejected, so it cannot turn a rejection into an acceptance; live call preserved at src/config.ts:373 on the traced path index.ts:30 -> registry.ts:688 -> registry.ts:655 -> superRefine; src/link-policy.ts:106-108 keeps https-only and no-userinfo unconditional under the opt-in; src/link-policy.ts:144 and src/get-docs.ts:181 keep followed links refused; src/fetcher.ts:275 confirms the README's primary-fetch claim is true and not describing a dead feature; test/autowarm.test.ts:325-327 binds the counter to the TCP connection event with a positive control at :342-351","standards":["none: practice applied: delta-scoped STRIDE re-check of the config->registry->autowarm trust boundary plus the shared enforcement-liveness caller-trace procedure"],"conditions":[]}
```

Two new non-blocking recommendations: R4 (make the `Array.isArray` guard self-contained by
adding its own zod issue rather than relying on a silent skip — not implemented, accepted as a
gap, §5) and R5 (the README's list of what `allowInternalHosts` unlocks reads as narrower than
`isForbiddenHost` actually is — e.g. it also permits public IP literals, since every such URL is
author-written in the same entry the security impact is nil, but the sentence should be exactly
true — not implemented, accepted as a gap, §5).

</details>

<details><summary>code-reviewer — round 2 — CONCERNS (two measured defects)</summary>

```verdict
{"gate":"review","agent":"code-reviewer","artifact":"branch build/a1-url-host-policy @ 027bcd7, scoped round-2 diff ec9ff35..027bcd7 (S1-S6 + round-1 test-auditor finding)","verdict":"CONCERNS","confidence":8,"falsifier":"A measurement showing node:net cannot bind ::1 without OS-level interface configuration on the supported Node/OS matrix would make test/autowarm.test.ts:380-386's exclusion rationale accurate and drop Should-fix #1, leaving only nits and a PASS.","evidence":"Measured: fetch('https://[::1]:<port>') against a node:http server bound to '::1' yielded connections=1, listenerHits=[], ERR_SSL_WRONG_VERSION_NUMBER on Node 26.0.0 — contradicting test/autowarm.test.ts:381-383. Separately measured: https-to-plain-http on 127.0.0.1 gives connections=1/listenerHits=[] (confirms the connections fix at test/autowarm.test.ts:375 is live and the round-1 auditor finding is resolved); localhost with setDefaultAutoSelectFamily(false) gives connections=0 (test/autowarm.test.ts:396 is autoSelectFamily-dependent). Gates: npm test 1098/1098 across 33 files exit 0; npm run lint exit 0.","standards":["none: practice applied: independent re-execution of each runtime behaviour claim in the diff (five Node probes plus both repo gates) rather than review of the assertions' prose"],"conditions":["test/autowarm.test.ts:380-386 — either add a real-listener case for the [::1] shape (making it 3 of 7) or correct the exclusion rationale to name only the four shapes for which it is true; as written it records a false reason for narrowing a security gate","test/autowarm.test.ts:342-351 — extend the positive control to fetch http://localhost:<port> so the localhost case at line 396 proves its own instrument rather than depending on Node's autoSelectFamily default","If the [::1] case is not added, security-architect must explicitly narrow the Gate 2 'listener hit count zero for every one of the seven forbidden shapes' criterion in the Change Record, with the corrected list of what is genuinely impractical to bind"]}
```

Both conditions were caused by my own inaccurate comment (claiming `[::1]` was unbindable when
it measurably is not) and an undisclosed environment dependency — both fixed in round 3: a real
`[::1]` listener case was added, and the positive control was extended to prove the `localhost`
case live in the same run.

</details>

<details><summary>test-auditor — round 2 — PASS (scoped to the headline defect)</summary>

```verdict
{"gate":"quality","agent":"test-auditor","artifact":"branch build/a1-url-host-policy @ 027bcd7 — SCOPED round-2: test/autowarm.test.ts enforcement-liveness block only","verdict":"PASS","confidence":8,"falsifier":"Executing the mutation (delete isForbiddenHost from validateLibraryUrl, src/link-policy.ts:108) and observing connections stay 0 — which would happen if any second host gate exists between config admission and fetcher.ts:144, e.g. if getLibraryDoc passed publicFinalUrl:true for configured entries. Source shows it passes entry.resolved !== undefined (false here), so no such gate exists; an executed run proving otherwise flips this to FAIL.","conditions":["carry-forward, unchanged and out of scope this round: five of seven Gate-2 forbidden shapes still have no real-listener proof","carry-forward, unchanged: no test asserts the rejection surfaces in the rendered list_libraries header","carry-forward, unchanged: test/link-policy.test.ts's /^urls:/ assertions cannot localize which rule fired","recommended, non-blocking: bind the stand-in listener on both address families so the localhost case's connections===0 does not depend on Node's autoSelectFamily default","recommended, non-blocking: add a TLS-protocol positive control asserting connections===1 with listenerHits===[] on the same port"],"standards":["none: practice applied: mutation-based test-adequacy analysis and enforcement-liveness tracing from assertion to the production fetch call site"],"evidence":"test/autowarm.test.ts:325-328 connection counter registered before listen; :342-351 non-vacuous plain-http positive control (connections===1, listenerHits===['GET /probe']); :375-376 and :396-397 negative cases now assert connections===0; :422-423 redundant listenerHits assertion removed with stated reason; :292-306 comment corrected. Mutation chain confirmed via src/config.ts:373 (sole host gate; src/registry.ts has none) and src/fetcher.ts:275 publicFinalUrl:false for configured entries, leaving src/fetcher.ts:144's real fetch unguarded to a live local port. Not executed: Bash unavailable this session."}
```

The "carry-forward" items are explicit residual scope, not defects: 4 of the 7 forbidden shapes
genuinely cannot be given a real, controllable listener (see round 3 below — one more, `[::1]`,
was added; the remaining 4 are covered by message-grammar and unit-level tests instead, §5). The
`list_libraries` header assertion was added in round 3.

</details>

### Round 3 (branch tip `2672c81`, final) — scoped confirmation of round-2's two conditions plus two additions

<details><summary>code-reviewer — round 3 — PASS, mutation-verified</summary>

```verdict
{"gate":"review","agent":"code-reviewer","artifact":"build/a1-url-host-policy, scoped to 027bcd7..6bd5b2e (test/autowarm.test.ts, test/config.test.ts)","verdict":"PASS","confidence":9,"falsifier":"Removing src/link-policy.ts:108's isForbiddenHost call with both new tests left intact leaving the autowarm suite green — that would show the [::1] and localhost cases are decorative. Measured the opposite: v6Connections 1->2 and summary.attempted 0->1 under mutation.","evidence":"Mutation of src/link-policy.ts:108 in a scratch clone: 14 tests fail incl. both new cases; variant 3 drives v6Connections 1->2, a real TCP connect to the real [::1] listener (test/autowarm.test.ts:409-450). Concern 2: under --no-network-family-autoselection on a ::1-first resolver, the extended positive control (test/autowarm.test.ts:356-359) fails red as the only failure. Cache fix: src/registry.ts:610 gates readResolvedEntries -> resolved-store.ts:26 -> cacheRoot -> cache.ts:147 renameSync; src/config.ts has no cache access; autowarm.test.ts:25-29 sandboxes VIBECTX_CACHE_DIR for its unflagged callers. npm test 1100 passed/33 files exit 0; npm run lint exit 0.","standards":["none: practice applied: mutation-based enforcement-liveness verification (revert the guard, confirm the negative assertion moves) plus adversarial reproduction of the round-2 failure mode"],"conditions":[]}
```

This round independently reproduced the enforcement mutation in a **separate scratch clone**
(not the working branch) and confirmed by execution, not reading, that: the new `[::1]` case is
load-bearing (a reverted fix drives its connection counter from 1→2); the extended positive
control genuinely proves `localhost`'s address resolution in this run (verified by re-running
under `--no-network-family-autoselection`, round 2's exact failure condition, and observing only
the positive control — not the negative case — go red, meaning the negative case can no longer
be vacuously green under that condition); and the real one-time-cache-migration side effect a
draft of the `list_libraries`-header test caused (see below) is closed by `includeResolved:
false`, with no other unprotected `loadDiscoveredRegistry` caller in the diff. Two non-blocking
nits from this round (an overclaiming code comment, `let`→`const`) were fixed in the branch's
final commit; the third (silent `catch { return; }` skip on an IPv6-less runner reading as a pass
rather than an explicit skip) is accepted as a gap, §5.

</details>

**Note on a defect this branch found in itself, not in the security fix.** An earlier version of
the `list_libraries`-header test (added between round 2 and round 3) called
`loadDiscoveredRegistry` without sandboxing the cache directory. `test/config.test.ts` had never
previously needed `VIBECTX_CACHE_DIR` set (nothing in the file touched the cache), so that one
call fell through to the real build machine's home directory and triggered the tool's own
documented one-time `~/.docs-cache-mcp` → `~/.vibectx` migration (`src/cache.ts:108-157`,
decision D-45) — non-destructive (a rename the tool performs automatically and idempotently for
any real user; no data was lost, and no `.docs-cache-mcp` remains to migrate again) but a genuine
test-isolation defect, since it touched a real directory outside any test's temp sandbox. Fixed
in the same round by passing `includeResolved: false` (this test does not exercise resolved
entries), and confirmed in round 3 as the sole such call and as fully closing the only
cache-reaching branch reachable from that function. Disclosed here in full rather than omitted,
per this project's honesty-over-completion rule.

## 4. Mechanical evidence (Layer 1)

- CI run: none yet — this branch has not been pushed; no agent session in this project can push
  (`.vibectx-plan/vibectx-phase2-go.md` §1). CI will run on Node 22 once Tom merges, per
  `.github/workflows/ci.yml` (`npm ci` → `npm run lint` → `npm test` → `npm run build`).
- Local gates, MEASURED at tip `2672c81` on this machine (Node v26.0.0):
  - `npm run lint` (`tsc --noEmit`): exit 0.
  - `npm test` (`vitest run`): **1100 passed / 1100, across 33 files**, exit 0. (Baseline before
    this branch: 1061 passing across 33 files at `main` @ `2e691d1` — +39 tests, 0 removed, 0
    files added, fully accounted for across seven `it`/`it.each` additions in three test files.)
  - `npm run build` (`tsc`): exit 0.
  - `npm audit`: 2 moderate (`@vitest/mocker`, GHSA-82fw-gwwq-j7x9) — unchanged from the recorded
    ground state on unmodified `main`; dev-dependency drift, not introduced by this branch, and
    not fixable without an out-of-scope breaking `vitest@5.0.0` upgrade. Carried to Phase 7 per
    the go card, not re-litigated here.
  - Repeated runs for flake-checking: `test/autowarm.test.ts` alone run 3× consecutively both
    immediately after the round-2 fix (19/19 each time) and after the round-3 `[::1]`/`localhost`
    additions (20/20 each time, IPv6 loopback available on this machine each run).
  - Per-commit scope check (`git show --name-status`) on all six commits: every commit touches
    only `src/config.ts`, `src/link-policy.ts`, `test/*.ts` and `README.md`. `git diff
    main..HEAD -- .github/ package.json package-lock.json .vibectx-plan/` is byte-empty.
- Coverage: no line/branch coverage tool is configured in this project (vitest run without
  `--coverage`); adequacy was judged by the three gate rounds above via mutation-based
  enforcement-liveness verification (round 1 test-auditor's revert-and-observe method, round 3
  code-reviewer's independent scratch-clone reproduction), not a coverage percentage.
- Two-person rule: N/A — Tier 2, not Tier 3.

## 5. Deviations & risk acceptance

| What | Agent said | I decided | Why acceptable | Revisit by |
|---|---|---|---|---|
| Gate 2's literal wording — "listener hit count is zero for every one of those seven cases" — is met for 3 of 7 (loopback, `localhost`, IPv6 literal), not all 7 | code-reviewer (round 2) required either full coverage or an explicit narrowing by security-architect; security-architect (round 1 residual risks, round 2 evidence) treated the caller-trace admission-control proof as the primary evidence and the real-listener tests as corroborating, not sole, proof | ACCEPT-WITH-RISK: the remaining 4 shapes (`169.254.169.254`/link-local, `.local`, `.internal`, single-label) cannot be given a real, controllable listener without OS-level interface assignment or DNS/hosts-file manipulation — infrastructure a unit/integration test should not fake. Absence-of-fetch for these 4 is proven instead by (a) `test/config.test.ts`'s D-22-grammar rejection at config-load time — the entry never becomes a `LibraryEntry`, so it structurally cannot reach `startAutowarm` regardless of network topology, and (b) `test/link-policy.test.ts`'s unit-level `validateLibraryUrl` coverage of the same shapes | If a future change makes any of these 4 hosts reachable via a lightweight test double (e.g. a DNS-stub library), extend real-listener coverage to them |
| A top-level `"allowInternalHosts": true` (beside `libraries`, not inside an entry) is not explicitly tested to be inert | security-architect R2 (round 1, non-blocking) | ACCEPT: `ConfigSchema` (`src/config.ts`) declares only a `libraries` key; any other top-level key is stripped by zod's default `unknownKeys: "strip"` behavior, already exercised generally by the `futureField` case in `test/config.test.ts`'s "accepts a well-formed file" test. The specific case is structurally guaranteed, not merely likely | Add the explicit test if `ConfigSchema` ever gains `.passthrough()` or a second top-level key |
| The `Array.isArray(entry.urls)` guard in `config.ts`'s `superRefine` silently returns rather than adding its own zod issue | security-architect R4 (round 2, non-blocking) | ACCEPT: it is fail-closed in conjunction with the shape check immediately above it (verified independently by both security-architect and code-reviewer across two rounds — the guard can only fire on input the shape check already rejected), and is defense-in-depth against a *future* zod behavior change, not a live gap today | Revisit if the shape check above it is ever weakened or the two are separated |
| README's `allowInternalHosts` description names four host shapes it unlocks but `isForbiddenHost` also covers plain IP literals (including public ones) and trailing-dot hosts | security-architect R5 (round 2, non-blocking, claim-discipline) | ACCEPT: security impact is nil (every such URL is author-written in the same entry the flag sits on — there is no attacker-controlled input this affects), and the omission makes the flag sound *narrower*, not broader, than it is, which is the safe direction to be imprecise in | Tighten the wording in a documentation-only pass if this file is touched again |
| `test/autowarm.test.ts`'s `[::1]` case skips silently (`catch { return; }`) rather than reporting an explicit skip if IPv6 loopback is unavailable | code-reviewer (round 3, nit) | ACCEPT: on every machine this branch was built and tested on, IPv6 loopback was available and the test ran (confirmed 20/20 across 3 repeated runs); a silent skip reducing coverage on an unusual runner is a real but minor risk | Switch to `ctx.skip()` if this project adopts a CI runner without IPv6 |
| `CLAUDE.md`'s test baseline (`1061 passing across 33 files` at `main` @ `2e691d1`) is stale against this branch (`1100` at `2672c81`) | code-reviewer (round 1 and round 3) | Not yet updated — `CLAUDE.md` is untracked/gitignored and describes `main`, which this branch has not yet reached | Tom updates `CLAUDE.md`'s baseline line (and this gate log, per its own rule) in the same session he merges this branch |

No deviation above required reopening a CLOSED gate; all three gates' final states are PASS (§2).

## 6. Emergency addendum

Not applicable — Emergency = No.

## 7. Sign-off

> I ran the applicable gate reviews, read the analyses, and take responsibility for the decisions
> recorded above.

**Signed:** Phase 2 build session (Claude Sonnet 5) — producer role, not a gate seat
**Date:** 2026-09-09

**This record does not constitute merge authorization.** Per `.vibectx-plan/vibectx-phase2-go.md`
§1, no agent session pushes to this repository; Tom reviews this record, the bundle, and the gate
log, and merges from his own terminal.
