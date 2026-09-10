# Change Record — CR-20260906-par-654-registry

## 1. Change summary

| Field | Value |
|---|---|
| CR ID | CR-20260906-par-654-registry |
| PR | #___ (branch `build/par-654-registry`, stacked on `build/par-707-doctor`; range 3b220c8…a3aa6af + this CR commit) |
| Spec / plan | Linear PAR-654 (0.2.0 / 2); PAR-653 (probe) consumes the result; docs/plans/vibectx-build-loop-state.md D-06, D-07 |
| Author | Tom Hanks (BlackRaptor AI) — produced by the vendored engineering pack 2.0.0 under oversight |
| Date | 2026-09-06 |
| Risk tier | Tier 1 — no gated surface touched (`.claude/`, `.github/`, `package.json` unchanged; `src/fetcher.ts` / `src/cache.ts` unchanged). CR written voluntarily to carry the gate verdicts. |
| Emergency? | No |

**What changed and why (2–5 sentences):**
The default registry shipped nine libraries chosen for Paragon's platform; the product's stated audience asks for Next.js, Supabase, Tailwind, Stripe, shadcn and got `Unknown library`. The default registry is now the vibe-coder top-30, each entry with ordered candidate URLs (llms-full → llms.txt → a GitHub-raw fallback that was fetched and returned 200 from the build sandbox) and two realistic probe queries for `vibectx doctor`. Entries gain optional `aliases` (`next`, `tailwind`, `remix`, …) resolved by one function used by every tool. Paragon's five removed entries are preserved as a complete example config (`docs/examples/paragon.vibectx.config.json`). Two precedence rules were decided during review: a config entry beats a default alias (so existing configs keep loading), and an override that omits `aliases` inherits them.

**Blast radius if wrong (prod deploys on merge — be honest):**
Every `get_docs`/`refresh`/`doctor`/`list_libraries` call resolves names through `resolveLibrary`; a bug there would misroute a request to the wrong library's docs (visible: the response names its source URL). Removing Paragon's five from the defaults is intentional and breaks nothing for Paragon once its committed config carries them (the example file is that config). No docs-site URL is asserted as verified anywhere — coverage is measured by `doctor` (PAR-653), not claimed here.

**Behaviour changes worth knowing (release notes):**
1. Default registry replaced: fastify, timescaledb, pgvector, aws-cdk, fastify-type-provider-zod no longer resolve without a config; prisma, react, playwright, anthropic-sdk kept (react's fallback URL changed; kept entries' primary URLs unchanged so caches stay valid).
2. `aliases?: string[]` on config entries; lookups fold case and whitespace; config names/aliases are normalised before validation.
3. Precedence (D-06): a config name or alias equal to a *default alias* wins silently (the default's alias is dropped on a copy). Still errors, with an actionable hint: an alias equal to any canonical name; two config entries sharing an alias; an alias equal to its own name.
4. Inheritance (D-07): an override that omits `aliases` inherits the replaced entry's aliases; `aliases: []` clears them.
5. `list_libraries` shows `(aka …)` for aliased entries; `refresh`'s unknown-library text now lists known canonical names.
6. Unknown top-level config keys (e.g. `$comment`) are ignored — now documented.
7. The weekly `doctor` workflow now checks 30 libraries; docs-site coverage is NOT VERIFIED from the sandbox — the first Mac/CI run (PAR-653) decides which candidate URLs hold.

## 2. Gate decisions

| Gate role | Your pack's seat (see `seat-list.md`) | Applies? | Agent verdict (PASS / CONCERNS / FAIL / COULD NOT ASSESS) | My decision (ACCEPT / ACCEPT-WITH-RISK / REWORK) | Initials + date |
|---|---|---|---|---|---|
| Security (auth/RBAC/tenant/remote-access) | `security-architect` | N/A: `src/fetcher.ts` / `src/cache.ts` untouched; no new fetch path; URLs are operator/registry data as before | | | |
| Privacy (PII, LLM data-flow, cross-border) | `privacy-counsel` | N/A: no personal data | | | |
| Compliance | `compliance-officer` | N/A | | | |
| Domain (regulated) | `domain-compliance` | N/A | | | |
| Schema (migrations, expand/contract, lock impact) | `schema-reviewer` (interface shapes: config, tool text, `--json`) | Yes | Round 1 CONCERNS (3 conditions) → **re-review PASS (9/10)** | | |
| Operational readiness | `operational-readiness` | N/A | | | |
| UX | `ux-designer` | N/A: no UI | | | |
| Quality (TDD followed, coverage thresholds) | `test-auditor` | Yes | Round 1 CONCERNS (1 condition) → **re-review PASS (8/10)** | | |
| Review (last gate before merge; conventions, routing) | `code-reviewer` | Yes | Round 1 CONCERNS (3 conditions) → **re-review PASS (9/10)** | | |

**Producer:** `backend-engineer` charter, two rounds (3776df1…c40778f; 90c8b18…a3aa6af). **Oversight decisions:** D-06 (config beats default alias), D-07 (override inherits aliases) — recorded in the state file and `loadRegistry`'s doc comment. **Closing gate:** `completion-auditor` — §3.

## 3. Agent analysis (evidence)

<details><summary>code-reviewer — re-review (final)</summary>

```verdict
{"gate":"review","agent":"code-reviewer","artifact":"PAR-654 / build/par-654-registry 3b220c8...a3aa6af (re-review)","verdict":"PASS","confidence":9,"falsifier":"a config input under which two registry keys still fold to the same trim().toLowerCase() value, or a caller of registry.entries.get/.has outside src/registry.ts","evidence":"src/registry.ts:391 fold(); :458-460 config keys normalised before storage; :463-473 D-06 drops claimed aliases on a spread copy; :475-479 D-07 inheritance; :481 validateAliases unconditional; grep entries.get(|entries.has( outside registry.ts → none. MEASURED (scratchpad/re.mjs, 2026-09-06): {name:\"Next.js\"} → 30 entries, NEXT.JS → override; alias \"React\" rejected naming both sides; \" bar \" resolves; {name:\"next\"} → 31 entries, default copy aliases [nextjs], DEFAULT_REGISTRY unmutated; omit/[]/list → inherit/clear/replace; suite 204/204, tsc clean","standards":["none: practice applied: adversarial diff re-review per gate-verdict-format plus enforcement-liveness caller grep; behaviours re-executed against a3aa6af"],"conditions":[]}
```

Round 1 (at c40778f) CONCERNS: (1) case/whitespace folding on lookup but exact-match validation created ambiguous keys — MEASURED `{name:"Next.js"}` produced a 31st entry; (2) decide the schema-gate row; (3) decide alias inheritance on override. All three closed: folding before validation/storage (90c8b18), schema gate below, D-07. The reviewer independently fetched all 30 GitHub-raw fallbacks (30/30 HTTP 200 with markdown, MEASURED 2026-09-06) and confirmed no docs-site URL is asserted as verified in code or README.
</details>

<details><summary>test-auditor — re-review (final)</summary>

```verdict
{"gate":"quality","agent":"test-auditor","artifact":"PAR-654 / build/par-654-registry 3b220c8...a3aa6af (re-review)","verdict":"PASS","confidence":8,"falsifier":"a mutant that routes getDocsToolText or refreshToolText around resolveLibrary surviving the suite, or a new test found reaching the real network","standards":["none: practice applied: acceptance-criteria-to-test traceability with mutation testing on a scratch copy"],"evidence":"src/get-docs.ts:67 and src/refresh.ts:10 — mutants (a) and (b) each killed by test/get-docs.test.ts:333 and test/refresh.test.ts:42; D-06 in-place mutation killed by test/registry.test.ts:239 (+2); D-07 drop killed by :247,:265; fold removal killed by :276,:291,:302; suite 204/204, tsc clean (MEASURED). Surviving low mutant: moving validateAliases back under if(configPath) at src/registry.ts:480 passes — test at :219 is not.toThrow and cannot fail"}
```

Round 1 (at c40778f) CONCERNS: `get_docs`/`refresh` alias resolution lived in the untested transport layer (`src/index.ts` 0 % covered). Closed by extracting `getDocsToolText` and `refreshToolText` with alias/unknown tests (e8905d9). Round-1 mutants: 9 killed of 9. Coverage (scratch v8): registry.ts 100 % lines. Low, accepted: the "validateAliases runs with no config" test is `not.toThrow` and cannot fail — the static default-integrity test still guards the shipped defaults.
</details>

<details><summary>schema-reviewer — re-review (final)</summary>

```verdict
{"gate":"schema","agent":"schema-reviewer","artifact":"PAR-654 / build/par-654-registry 3b220c8...a3aa6af (re-review)","verdict":"PASS","confidence":9,"falsifier":"any 0.1.3-valid vibectx.config.json that fails loadRegistry on a3aa6af, or a doctor --json key added/renamed without a schemaVersion bump","conditions":[],"standards":["none: practice applied: additive/backward-compatible interface-shape review (expand/contract applied to config, tool-text and --json shapes)"],"evidence":"src/registry.ts:462-476 — D-06: config name/alias equal to a default alias drops it from a copy of the default (MEASURED: legacy-next.json → 31 entries, next → config url, next.js aliases [\"nextjs\"]; legacy-ai.json loads; alias-vs-default-alias.json loads, tailwindcss aliases []). src/registry.ts:474-478 — D-07 inheritance (MEASURED: {name:\"next.js\",aliases:[]} clears; omitted aliases inherit). src/registry.ts:391,457-458 — keys folded before validation/storage (MEASURED: [\"Tailwind\",\" next \"] stored as [\"tailwind\",\"next\"]). src/registry.ts:405-410 — alias-vs-canonical hint now names the side and requires urls (MEASURED CLI exit 2 text). README.md:93-107 documents $comment/unknown keys, folding and the three precedence rules; matches code. src/doctor.ts:47-76 — LibraryReport/DoctorReport unchanged, schemaVersion 1 (MEASURED --json top keys schemaVersion,generatedAt,libraries,healthy,total). src/refresh.ts:12 — unknown-library text gained `Known: …` (additive tool text, not a machine shape). npx vitest run 204/204; tsc --noEmit clean; build ok (MEASURED)."}
```

Round 1 (at c40778f) CONCERNS: a 0.1.3 config declaring `name: "next"` (or any of 16 new default aliases) failed to load — a breaking change. Rather than release-note it, oversight chose D-06 so such configs load unchanged; the gate re-ran its seven probe configs plus three new ones and confirmed. No version bump needed on compatibility grounds.
</details>

<details><summary>completion-auditor (closing gate)</summary>

```verdict
{"gate":"completion","agent":"completion-auditor","artifact":"PAR-654 / build/par-654-registry 3b220c8..79a61d0","verdict":"CONCERNS","confidence":8,"falsifier":"a get_docs(\"supabase\",\"row level security\") run from a network that reaches supabase.com/docs/llms-full.txt returning the RLS policy section with no config file — that flips this to PASS; a default entry lacking a description or URL that test/registry.test.ts:56 does not catch flips it to FAIL","evidence":"MEASURED 2026-09-06 at 79a61d0: 9 commits all ancestors; npm ci ok, tsc clean, vitest 204/204 in 9 files, build ok; doctor --offline --json → 30 rows all unreachable on an empty DOCS_CACHE_DIR; --library next → row next.js; paragon example config → fastify row; validator 3 blocks ALL_PASS; no Tier-3 path in diff; test/registry.test.ts:56-74 it.each over DEFAULT_REGISTRY asserts description (:59) and urls≥1 (:60); listLibrariesText → 30 rows, 0 missing descriptions; LIVE: supabase.com llms candidates curl 000 (unreachable), GitHub-raw fallback 200 in 232 ms but getDocsToolText returned the '## Deno' section, not RLS (README has no RLS text; only 'Support Policy'); doctor classifies that probe 'answered' via src/doctor.ts:189 — 19/30 healthy, 48/60 probes answered, matches CR §4","standards":["none: practice applied: ground-truth re-derivation per completion-auditor checklist (hash resolution, build/test/CLI re-execution, validator, done-criteria traceability, phantom-mechanism check)"],"conditions":["Human fills CR §5 row 1 (docs-site coverage NOT VERIFIED) with an explicit decision before merge","Run get_docs(\"supabase\",\"row level security\") or `vibectx doctor --library supabase` from the Mac (PAR-653) and record whether the RLS policy section is returned before moving Linear PAR-654 past In Review","Note in CR §4 that the sandbox figure is 19/30 libraries healthy (48/60 probes 'answered' by section-count, not by topical correctness)"]}
```

Condition 3 closed in §4 below. Conditions 1–2 are human steps (§5 / PAR-653). **Important finding for PAR-653 and a `doctor` follow-up:** `answered` means "≥1 section returned", not "the right section" — the supabase README fallback returned a `## Deno` section for "row level security" and doctor counted it answered. Doctor measures retrieval, not correctness (README says so), but a keyword-overlap threshold or a required-term check on the probe would make `answered` mean more. Queued in the state file as a 0.2.x item.
</details>

## 4. Mechanical evidence (Layer 1)

- CI run: <link on PR>
- Local at a3aa6af (MEASURED 2026-09-06, Node 22.22.2): `npm run lint` clean; `npx vitest run` 204/204 in 9 files.
- GitHub-raw fallbacks: 30/30 HTTP 200 with markdown (producer and code-reviewer independently, 2026-09-06). Docs-site `llms*.txt` candidates: 0/30 reachable from the sandbox — NOT VERIFIED.
- Sandbox `doctor` on the new registry (GitHub-only network): 30 rows, all kind `readme` (fallbacks); **19/30 libraries healthy, 48/60 probes `answered`** — where `answered` means a section was returned (section-count), not that it was topically correct (completion-auditor: supabase's README fallback returned `## Deno` for "row level security" and was counted answered).

## 5. Deviations & risk acceptance

| What | Agent said | I decided | Why acceptable | Revisit by |
|---|---|---|---|---|
| Docs-site coverage of the 30 default entries is NOT VERIFIED | all gates + producer | ___ | Sandbox cannot reach docs sites; `vibectx doctor` from the Mac (PAR-653) is the measurement, and the registry ships GitHub-raw fallbacks that were fetched | PAR-653 run, before 0.2.0 tag |
| Weekly `doctor` workflow may go red on the first run if several llms candidates are absent | producer follow-up | ___ | Intended signal; adjust URLs/probes in the registry, not the check | After first workflow run |
| `validateAliases`-without-config test cannot fail (low) | test-auditor | ___ | Defaults are compile-time; the static duplicate/collision test guards them | 0.2.x |

## 6. Emergency addendum

Not applicable.

## 7. Sign-off

**Signed:** ______________  **Date:** ___________
