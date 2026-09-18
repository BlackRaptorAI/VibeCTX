# VibeCTX — DECISIONS

**LIVE. This file is the authority for project decisions.** Created 2026-09-10 by Tom's decision
(**D-58**), because the two files that previously held decisions were both retired the same day and
nothing owned them afterward.

**Where facts live (D-57):** `CLAUDE.md` owns code facts — the test count and the commit it was
measured at. **Linear owns everything else** — item count, what is done, the release gate,
priorities. **This file owns the decisions.** Every other document points; nothing restates.

**D-01 through D-56 below were MOVED here, not copied.** They were extracted verbatim by script from
`vibectx-build-loop-state.md` (D-01–D-46 as bullets, D-47–D-55 as a table) and
`vibectx-build-loop-resume.md` (D-56) — **no decision was retyped**, so none can have been
transcribed wrong. Verified on extraction: 46 + 9 = 55 distinct numbers, **range D-01 to D-55, no
gaps**. Those two files are retired; their decision sections are marked MOVED.

**Numbering continues at D-70.**

---

## D-01 – D-46

- **D-46** 2026-09-07 — Nothing is renamed or deleted through a path not proven to be a real directory: the cache root and the legacy cache path are lstat'd first, a symlink in either position is refused once on stderr and the operation skipped, never followed. Closes a security finding in which eviction through a symlinked root deleted a real user file outside the cache. Ref: `src/cache-evict.ts`, `src/cache.ts` (5646651, 47bc3cb).
- **D-45** 2026-09-07 — Cache rebrand: `VIBECTX_CACHE_DIR` wins, `DOCS_CACHE_DIR` works through 0.2.x with a once-per-process deprecation note; `~/.docs-cache-mcp` migrates to `~/.vibectx` by rename on first run — never a copy, never onto an existing target, never following a symlink, and a failed rename falls back to the old path for that run and says so. A test trips at the removal version if a deprecation branch survives. Ref: `src/cache.ts` (45831e3, 47bc3cb, 1b84f70).
- **D-44** ~~2026-09-07~~ **SUPERSEDED 2026-09-08** — the CI change-record gate, the `GATED` array, the enforcement map and the verdict checker were all removed from the repository; no path is gated and no CI check requires a Change Record. Records are still written, locally, in `.vibectx-plan/change-records/`. *Original text:* The CI change-record gate covers `.github/`, `.claude/`, `package.json`, `src/fetcher.ts`, `src/link-policy.ts`, and its matcher reads `previous_filename` so a rename cannot escape it. Cache, atomic-store and search-index paths stay convention-routed via the security gate's routing rule — hard-gating them would put a CR on every retrieval change, which is the over-governance PAR-652 exists to remove. Ref: `.github/workflows/change-record-required.yml`, `.vibectx-plan/change-record-policy.md` (18fac45, 65c74ba). *(An earlier 2026-09-06 entry under the same id states the same rule; this is the later, fuller one.)*
- **D-43** 2026-09-06 — In `search`, the answer wins over the accounting: at ANY budget the response carries the best-scoring library's name, its `Source:` line and at least one section of its text; other libraries drop first, then the body is clipped, then the footer shortens, then the footer goes — never the section, and an irreducible minimum over budget is announced. `n shown` counts sections actually emitted. Closes the completion-auditor's finding that below the footer reserve the response was blank lines plus a footer claiming "1 shown", exit 0. Ref: `src/search.ts` (8c127f3, bc4f856).
- **D-42** 2026-09-06 — A library `writeIndex` sheds is remembered for the process, keyed by document hash: search neither rebuilds nor rewrites it (was 64 MB / 14.5 s per call, indefinitely), but still tokenizes it directly and still names the cost in the response; a changed document is retried, `invalidateIndex` clears it, and the memo is never serialised. Ref: `src/search-index.ts` (c09df2c, b5c1ff1, 1b9e77e).
- **D-41** 2026-09-06 — `search`'s `query` is bounded at 1000 chars at the MCP schema, the CLI (clip reported on stderr and in `--json` notes) and `runSearch`. A 200k-term query previously exhausted a 2 GB heap and killed the server. Ref: `src/server.ts`, `src/cli.ts`, `src/search.ts` (1d655b8, 63645b5).
- **D-40** 2026-09-06 — `writeIndex` sheds largest-first below the size `readIndex` refuses and names what it shed, so search can never poison its own index (it previously wrote a 74.7 MB file every later read rejected). Ref: `src/search-index.ts` (b7445a2).
- **D-39** 2026-09-06 — The token budget is priced on what is actually returned: bodies, headings and paths are attached before selection, and both the rendered response and the summed `--json` bodies stay within `maxTokens*4`. Placeholder pricing had produced 9.9×–322× the budget. Ref: `src/search.ts` (340b5a5).
- **D-38** 2026-09-06 — The search index is keyed to the code that built it: `RETRIEVAL_VERSION` (`src/tokenize.ts`) is stamped on the envelope and bumped whenever the tokenizer, stemmer, `splitSections` or the BM25 weights change; a mismatch refuses the file whole. The content hash proves the document is unchanged, which is exactly why a tokenizer change slipped past it and returned silently wrong answers. Ref: `src/tokenize.ts`, `src/search-index.ts` (b7445a2).
- **D-37** 2026-09-06 — Search performance is measured, not asserted: a test proves warm search over ≥10 indexed documents / ≥5 MB and reports the time (44 ms), a second proves the index is actually used (1 tokenize call with it, >2,640 without), and the README states both the 5.63 MB row and the 143 MB row rather than averaging them. Ref: `test/search-perf.test.ts` (7fb21fa).
- **D-36** 2026-09-06 — Search bounds: `MAX_INDEXED_DOC_BYTES` 8 MiB, `MAX_INDEX_FILE_BYTES` 64 MiB, `MAX_LAZY_INDEX_DOCS` 40, `MAX_RENDERED_LIBRARIES` 8 (all ASSUMED, all test-pinned); every attacker-influenced string reaching output is `cleanText`'d and clipped per D-30. Ref: `src/search.ts`, `src/search-index.ts`.
- **D-35** 2026-09-06 — `search(query, maxTokens?, libraries?)` is cache-only: never a fetch, never a resolution, no network (fetch-spy asserted). Grouped by library, libraries by best section, sections by score then document order, round-robin across libraries with at least one section from the best library always returned; per-group `Source:` and stale marker; a closing "n of m configured libraries searched" line with the `warm` suggestion. Ref: `src/search.ts` (50caff9).
- **D-34** 2026-09-06 — Only registry-known libraries and only their PRIMARY cached document are indexed (never followed pages); indexing hooks the single writer every path reaches (`resolvePackage`/`getLibraryDoc`) with one read and one merge-write per run; `refresh` invalidates and rebuilds, and a failed refresh leaves the entry invalidated rather than stale. Ref: `src/resolve.ts`, `src/search-index.ts` (c490803, 14ef2c0, 7e04d09).
- **D-33** 2026-09-06 — The search index is a derived cache with no authority: it stores NO document text, every posting carries a content hash checked before use, and every rendered body is re-read and re-split from the cache — so a corrupt, stale or planted index can never make `search` return content the cache does not hold. A missing index degrades to on-the-fly indexing; a failed write is a note, never a failed search. Ref: `src/search-index.ts`, `src/search.ts` (4f206bc, 50caff9).
- **D-32** 2026-09-06 — The eval gold set is a versioned data contract: `docs/eval/probe-gold.json` carries `schemaVersion: 1`, the script validates version/shape/regexes and asserts `unanswerable === (expect.length === 0)`, and refuses to print numbers from a gold set it cannot read. Ref: `scripts/eval-retrieval.mjs` (755dda6).
- **D-31** 2026-09-06 — The primary document and each followed page are split into sections SEPARATELY and the lists concatenated (an unclosed fence in one document can no longer swallow another); the `# <link title>` marker stays as the followed page's root heading. Ref: `src/get-docs.ts` (1f88912).
- **D-30** 2026-09-06 — Derived render fields (`headingPath`, `Snippet.lang`, `Snippet.context`) pass `cleanText` + a clip (200/200/20); section BODIES are deliberately NOT cleaned — the body is the document — and the asymmetry is pinned by a test. Ref: `src/retrieval.ts` (c3b4b13).
- **D-29** 2026-09-06 — The snippet budget is a hard cap: `assembleSnippets` clips the ASSEMBLED chunk (path + context + lang + fence + code) to `maxTokens*4`, always emitting at least one clipped snippet. Closes a MEASURED 2000× overshoot. Ref: `src/retrieval.ts` (c3b4b13).
- **D-28** 2026-09-06 — A rendered snippet is inescapable: its fence is one backtick wider than the longest run in the code AND in the rendered language (which is itself stripped of backticks/tildes), so no code content or info string can break out of or swallow past the fence. The only residual is `clipSnippet`'s final slice cutting mid-fence below one block's overhead — cap over well-formedness, pinned. Ref: `src/retrieval.ts` (c3b4b13, f90187c).
- **D-27** 2026-09-06 — Retrieval changes are MEASURED, not asserted: a gold set of the 60 registry probe questions plus a script that runs the legacy ranker and the new one side by side; the gold set is never tuned to the ranker, and a done-when the numbers do not support is reported as unmet. Ref: `docs/eval/`, `scripts/eval-retrieval.mjs` (50593fe).
- **D-26** 2026-09-06 — `get_docs(mode?: "sections"|"snippets")`; a snippet is a fenced block with its language, its section's heading path and the nearest preceding prose line; scored by section BM25 + 2× code-token overlap; index following, stale prefix and provenance identical to sections mode. Ref: `src/retrieval.ts`, `src/get-docs.ts`, `src/server.ts` (60074b4).
- **D-25** 2026-09-06 — Sections carry `level` and `path`; output renders `## A > B > C`; a `#` inside a fenced block is not a heading (known limits: unclosed fences run to EOF; fences indented 4+ spaces or by a tab are unrecognised — MEASURED 0/802 real fence lines). Ref: `src/retrieval.ts` (1d2591e).
- **D-24** 2026-09-06 — Okapi BM25 over the per-call section corpus: k1 1.2, b 0.75, IDF ln(1+(N−n+0.5)/(n+0.5)), own-heading tokens 3× / ancestor path 1× / body 1×, zero-scoring sections dropped, ties broken by an explicit document-order index. Ref: `src/retrieval.ts` (1d2591e).
- **D-23** 2026-09-06 — Tokenizer: lowercase, non-alphanumeric + camelCase/PascalCase split by a LINEAR scanner, the whole lowercased compound kept as well, light stemmer (amended twice: de-doubling, then a Porter step-1b silent-`e` restore on a three-letter CVC stem after `noted→not` and `seed→see` were found), stopwords with an all-stopword fallback, 2-char tokens kept, `MAX_TOKEN_CHARS` 64. Documented non-convergences: using, handler, middleware, indices, setting/set, seed, embed/embedded. Ref: `src/tokenize.ts` (204218a, b1757a6, d0b9ea2).
- **D-22** 2026-09-06 — One locator grammar and one path form for every config error: `<display path>: libraries[i].<field> ("<name>"): <message>` for zod and semantic errors; display path `./…` beneath cwd, `~/…` under HOME, absolute otherwise, cleaned and clipped (200) at construction; the CLI prints the line once; every line ≤ 300 chars. Ref: `src/config.ts` (5619587, 1ae6ca4).
- **D-21** 2026-09-06 — 0.1.3 config compatibility: `libraries` optional (`{}`/null → empty), `ttlHours: 0` accepted (always revalidate), negative/non-finite refused; unknown keys ignored at both levels; https-only `urls` is the one breaking change, documented under "Upgrading from 0.1.x". Ref: `src/config.ts` (c632c83), README.
- **D-20** 2026-09-06 — The config walk-up trusts only directories owned by the current uid (git `safe.directory` analogue; skipped where `getuid` is unavailable). A foreign-owned directory holding a config is named in the header and on stderr whenever no project file was found. Ref: `src/config.ts` (f2e1432, af5a90d, 1460445).
- **D-19** 2026-09-06 — Discovered config failures degrade: the file is skipped, one stderr line, `— NOT LOADED: <reason>` in the `list_libraries` header, doctor `configIssues` + exit 1, warm `notes[]`. Explicit `--config` / `VIBECTX_CONFIG` failures stay fatal (exit 2). No partial layer is ever applied. Ref: `src/registry.ts` `loadRegistryFrom` (73baa1b, 93e2c4b, a380de3).
- **D-18** 2026-09-06 — `list_libraries` opens with `config: <sources, highest precedence first, with scope>` or `config: none (shipped defaults)`; config-supplied strings cleaned and clipped (200) at render. Ref: `src/list-libraries.ts` (0020b97, 483ba1a, b963dec).
- **D-17** 2026-09-06 — Config files validated with zod: `libraries[]` of `name`, https `urls[]`, optional aliases/probeQueries/allowedHosts/description/ttlHours; > 1 MiB refused (ASSUMED cap); JSON syntax errors report line/column only. Ref: `src/config.ts` (000bbfa, 5619587).
- **D-16** 2026-09-06 — Legacy `docs-cache.config.json` accepted at project and user locations through 0.2.x with a deprecation note; `vibectx.config.json` wins when both exist. Ref: `src/config.ts` (000bbfa).
- **D-15** 2026-09-06 — The walk-up is confined to the repository: stop after the directory containing `.git` (file or dir); no `.git` → cwd only; nearest file wins; multiple project files not layered (follow-up). Symlinked config allowed if a regular file. Ref: `src/config.ts` (000bbfa).
- **D-14** 2026-09-06 — Config precedence: flag > `VIBECTX_CONFIG` > project `vibectx.config.json` > user `$XDG_CONFIG_HOME/vibectx/config.json` (default `~/.config/vibectx/config.json`) > defaults; an explicit flag/env source is authoritative and skips discovery (0.1.x behaviour preserved); layers merge by library name through the existing D-06/D-07 path. Ref: `src/registry.ts` `loadRegistryFrom` (81aaf81).
- **D-13** 2026-09-06 — Project-record persistence is best-effort: a `writeProjectRecord` failure (or K2 refusal) is a stderr warn plus a report note `project record not written: …`, never a failed run / exit 2. Ref: `src/warm.ts` (e89c06b, d9ae8e0), `CR-20260906-par-656-warm.md`.
- **D-12** 2026-09-06 — `force` (bypass the 24 h failure memo) is CLI-only; the MCP `warm_project` input schema is `dir?` alone, so a client cannot re-spend the shared 100/h resolution cap. Ref: `src/server.ts` (860878e).
- **D-11** 2026-09-06 — Curated entries match a dependency by name regardless of ecosystem; when the manifest ecosystem differs the row carries a note. An `ecosystem` field on registry entries is a follow-up. *(That follow-up is now A9 / PAR-722.)* Ref: `src/warm.ts` (9fc1092).
- **D-10** 2026-09-06 (amended a2a34c2, ab5f097) — MCP `warm_project(dir?)` accepts only the server's working directory or a directory beneath it, decided on REAL paths (realpath both sides; non-existent tail → realpath of the nearest existing ancestor + tail; undecidable → refuse). CLI `vibectx warm [dir]` is unrestricted. Ref: `src/warm.ts` `isWithinCwd`, security rounds 2–4 in `CR-20260906-par-656-warm.md`.
- **D-09** 2026-09-06 — Symlinks are refused everywhere in dependency discovery (manifests, `-r` includes, lockfiles): lstat every component, and realpath containment under the project root. Ref: `src/project-deps.ts` `checkPath` (e61abe7, b0e9b92).
- **D-08** 2026-09-06 — Redirects are followed hop-by-hop with every `Location` pre-flighted (https + non-forbidden host for all callers; allowed-host policy for followed links). Narrows D-04: curated primaries keep cross-host https but never http/IP/localhost. Ref: `src/fetcher.ts` (6b7a2ef), `CR-20260906-par-655-resolve.md`.
- **D-07** 2026-09-06 — An override that omits `aliases` inherits the replaced entry's aliases; `[]` clears. Ref: `src/registry.ts` (90c8b18).
- **D-06** 2026-09-06 — Config beats default alias: a config name/alias equal to a DEFAULT alias drops that alias from a copy of the default, no error (removes the 0.1.3-config breaking change the schema gate found). Alias vs any CANONICAL name, duplicate config aliases, and self-alias remain errors. Ref: `src/registry.ts` (90c8b18), `CR-20260906-par-654-registry.md`.
- **D-05** 2026-09-06 — Byte caps: 25 MiB primary / 2 MiB followed page (ASSUMED values; prisma llms-full ~5 MB CITED from PAR-704). Ref: `src/fetcher.ts` (3cf699f).
- **D-04** 2026-09-06 — Redirect post-check applies to FOLLOWED links only; primary registry URLs stay exempt (they legitimately cross hosts). Ref: `src/fetcher.ts` (3cf699f), security re-review 2 in `CR-20260906-release-0.1.3.md`.
- **D-03** 2026-09-05 — Stacked branches when an issue depends on an unmerged predecessor; PRs merge in train order. *(No longer operative — there are no stacked branches. Retained for the record.)*
- **D-02** 2026-09-05 — Branch per issue + PR for Tom to merge; no direct pushes to main. **Still operative.**
- **D-01** 2026-09-05 — Builder runs in the oversight session's cloud clone, not on the Mac VM (the VM has no network and cannot run vitest). **Still operative.**

---

## D-47 – D-55

| ID | Decision | Item |
|---|---|---|
| **D-47** | A library `urls` entry must clear the same host policy a followed link clears. Internal, loopback and non-routable hosts are reachable only through an explicit per-entry `allowInternalHosts: true`. | A1 / PAR-714 |
| **D-48** | One exported control and bidi character class is the contract for every render path. Adding a character to it is a D-30 amendment; a local variant is a defect. | A7 / PAR-720 |
| **D-49** | The URL trust decision lives in `src/link-policy.ts`, the one file that owns host policy, and every caller — config included — calls it rather than re-implementing a subset. | A14, folded into A1 |
| **D-50** | Documentation is served for the version the project's manifest pins where a versioned document exists, and the fallback to latest is always stated, never silent. **Executed 2026-09-17 — see D-76.** | A11 / PAR-724 |
| **D-51** | VibeCTX records its own activity, locally, bounded and content-free, readable through the same `--json` envelope as every other command. It never records what was *said*, only what was *looked at*. | A20 / PAR-729 |
| **D-52** | Agent packs are consumed as Claude Code plugins from the `blackraptor` marketplace, never vendored into the repository. Verdict enforcement lives in the pack's `Stop` hook, not in VibeCTX's CI. Supersedes D-44. | governance |
| **D-53** | The operating pack version for 0.2.0 is **2.1.0**. Gate verdicts follow the 2.0.0 schema (integer confidence, required `standards`, string `evidence`, no `N/A`); the 13 pre-existing Change Records predate it and are re-emitted rather than hand-patched. | governance |
| **D-55** | A gate run's output is never piped through `tail`/`head`/`grep` before its result is known — redirect in full and read the summary from the file. A failure whose test name and assertion were discarded costs more to recover than repeating the run. Any failure is captured with its identity before anything proceeds. | testing / process |
| **D-54** | Branch handoff is by `git bundle` into `../vibectx-handoff-bundles/`, a sibling of the repo — outside the working tree, so it needs no gitignore entry and cannot be swept up by a repo cleanup. Tom verifies, fetches, tests and merges from his own terminal. **No agent session pushes: that is the human-in-the-loop control, not a statement about credentials.** A session that discovers it can push reports it and does not use it. | handoff / governance |

---

## D-56

- **D-56** 2026-09-10 — A6's AI-attribution trailers are stripped by a **message-only history
  rewrite**; the gate verdicts attach to the **trees** they reviewed, not to the commit identifiers
  those trees carried. Not re-gated: a message rewrite changes no byte of any tree, and re-gating
  would itself mint new SHAs. Required with it: capture the old identifiers first, record the
  old→new SHA mapping, and **prove `git diff <old-tip> <new-tip>` is empty**. Executed and verified
  2026-09-10. **Scoped to A6 — rule 2.5 is unchanged and this is a remedy, not a precedent.**
  Full text: `vibectx-build-loop-resume.md` §9. | A6 / PAR-719 |

---

## D-57 – D-67 — decided 2026-09-10 by Tom

- **D-57** 2026-09-10 — **One home per fact.** `CLAUDE.md` owns code facts (test count, and the
  commit at which it was measured). **Linear owns everything else** (item count, landed set, the GA
  gate, priorities, open work). Every other document **points rather than restates**. Reason: the
  same seven facts were restated across eight places, and on 2026-09-10 four were updated and a
  fifth — the epic — was missed. `CLAUDE.md`'s existing "versioned to a commit" rule held all week;
  every copy without a rule drifted. | PAR-754 |
- **D-58** 2026-09-10 — **Decisions live in this file**, `.vibectx-plan/DECISIONS.md`. Repo-local,
  because build sessions work inside the repo and must be able to read the rules they are held to.
  Kept out of `CLAUDE.md` so that file stays short enough to actually be read. | PAR-754 |
- **D-59** 2026-09-10 — **The 0.2.0 milestone in Linear is the sole authority for the GA gate.** The
  copy in `VibeCTX-020-phased-build-plan.md` is struck, and that file stays fully retired. Fixes a
  contradiction the oversight seat created on 2026-09-10 by banner-marking the plan historical while
  it still held the release criteria. | PAR-754 |

  > **EXECUTED 2026-09-16 by the oversight seat, in both halves. D-59 was decided 2026-09-10 and
  > nothing was struck for six days** — the plan's retirement banner never mentioned the GA gate, so
  > `### Gate 7 — the GA gate` went on reading as live release criteria to anyone who landed there by
  > search rather than by scrolling past the banner.
  >
  > **Half one — the struck copy.** `VibeCTX-020-phased-build-plan.md` now names the strike in its
  > banner, and § Gate 7 is marked `STRUCK, D-59` **at its own heading**, with a note that at least
  > one criterion in it is known wrong: the ship sequence omits `npm link`, without which
  > `vibectx warm` exits `command not found` on a fresh clone (`CR-20260907-source-distribution.md`
  > condition **F6**). The section is kept, not deleted — it is the record of what the gate looked
  > like on 2026-09-08.
  >
  > **Half two — the authority itself was stale, and pointed back at the struck copy.** D-59 makes
  > the Linear 0.2.0 milestone sole authority; **its closing line read *"Full detail in
  > `claude/VibeCTX-020-phased-build-plan.md` (Gate 7)"*.** An authority citing the copy it
  > supersedes is a loop, and striking one end without the other would have left it. Six corrections
  > applied to the milestone, listed at its bottom in that milestone's own established convention:
  > 7 of 16 → **8** landed; `839bfd7`/1202-in-36 → `b9ee0cf`, baseline **1271/40** at `47677b4`; the
  > Change Record ledger to **16 records, 4 human-signed, 12 unsigned** with PAR-753 named as its
  > single authority; the A3/A4 question closed; and the back-pointer removed.
  >
  > **One correction was a refusal to carry a claim forward.** The milestone said *"CI green on Node
  > 22"*, measured at `839bfd7`. It now states plainly that **CI on `47677b4` is UNVERIFIED** and is
  > a human-only check — `47677b4` is the first Node 22 exercise, every local run having been Node
  > 26. **Inheriting a green claim across a commit it was never measured on is how a measurement
  > outlives its evidence**, which is the failure D-67 exists to prevent.
  >
  > **Also closed here: PAR-754's List 3, as MOOT.** `gate-enforcement-map.md` cites the retired
  > `change-record-policy.md` in two places — but that map has carried its own RETIRED banner since
  > 2026-09-08. A retired document citing a retired document is not a live hazard. Its banner now
  > says so, states the live Change Record rule once so no reader has to follow either chain, and
  > **leaves the two citations exactly as written** — rewriting them would imply the map is
  > maintained, and it is not.
- **D-60** 2026-09-10 — **A3 (PAR-716) and A4 (PAR-717) owe Change Records.** Both changed cache
  integrity, which the live rule names directly; A3 additionally added a filesystem-delete
  primitive. They were originally cleared with "no gated path touched," which reasons from a control
  that has not existed since `a0852f2`. ~~**Outstanding Change Records: 11 → 13.**~~ **CORRECTED
  2026-09-16 under D-65: 12 → 14.** The original figures predate D-65's signature audit, which found
  `CR-20260909-par-714` agent-signed and therefore unsigned, moving the ledger from 11 unsigned to
  12. A5 and A6 touched neither cache, URL trust, nor fetching — their clearance stands despite the
  same faulty justification. | PAR-753 |

  > **EXECUTED 2026-09-16 by the oversight seat. Both records are written**, after a recovery attempt
  > for the original gate verdicts by Tom's ruling (try to recover; if not found, write the records
  > with the verdicts marked unrecoverable):
  >
  > - `change-records/CR-20260909-par-717-cache-meta-validation.md`
  > - `change-records/CR-20260910-par-716-refresh-index-session.md`
  >
  > **Ledger: 14 records → 16. Unsigned: 12 → 14.** The **71-condition triage surface is
  > unchanged** — both new records have an **empty §3**, so they add no gate conditions to PAR-753.
  >
  > **RECOVERY FAILED, and the search is documented in each record's §3 so nobody repeats it.** Five
  > sources, MEASURED 2026-09-16 at `main` @ `47677b4`: `.vibectx-plan/**/*.md` (only the template
  > holds verdict blocks); **all 230 commit messages across all branches — zero verdict blocks**;
  > the eight A3/A4 commit messages read individually; Linear PAR-716 and PAR-717 comments; and the
  > session transcripts reachable from the oversight container. **No A3 or A4 verdict block exists
  > anywhere reachable.**
  >
  > **The two causes are different, and the second is the one to learn from.** A4's verdicts were
  > **forfeited by a `validate-verdicts.sh` Stop-hook wedge** — one of four such wedges (A10, A1, A4,
  > A5). **A3 had no wedge.** Its verdicts were produced complete and schema-complete — thirteen gate
  > dispatches carrying `evidence`, `standards` and `falsifier` — relayed into an oversight session,
  > and **never written to any durable store.** So **the most heavily gated item in this project now
  > has the same evidentiary standing as the least**, because of where its evidence was put rather
  > than whether it existed. **A verdict that is not written to a durable store did not happen.**
  >
  > Neither record may be signed as equivalent to one written at the time, and each says so in its
  > own §7. Both carry ACCEPT-WITH-RISK entries in §5 that are Tom's to take, not the seat's.
- **D-61** 2026-09-10 — **PAR-741, 742, 743 and 745 are merged into PAR-749** and handled as one
  design item. They are two root causes — a lossy name transform used as a storage key, and
  `.meta.json` read at four different trust levels — not four defects. One decision, one gate pass,
  one test that enumerates every call site, which is what prevents a fifth instance. | PAR-749 |
- **D-62** 2026-09-10 — **The zero-config principle is rewritten as one honest line:** install is
  four commands, and after that there is nothing to configure — no database, no API key, no config
  file, 30 libraries built in. MEASURED 2026-09-10: runtime dependencies are exactly
  `@modelcontextprotocol/sdk` and `zod`; no database driver in `src/`; `DEFAULT_REGISTRY`
  (`registry.ts:90`) ships 30 entries. **The "or it doesn't ship" launch gate and the `npx` install
  claim are struck as false** — `npx` distribution was abandoned 2026-09-07. Applies to
  `PRODUCT-STRATEGY.md` and `LAUNCH-STRATEGY.md`. This was item **A15**. | A15 |

  > **EXECUTED 2026-09-16 by the oversight seat, by Tom's ruling. Both files are RETIRED with a
  > banner, not line-edited** — each rests on the dead premise in three places
  > (`PRODUCT-STRATEGY.md:70, :78, :130`; `LAUNCH-STRATEGY.md:32, :38, :123`, re-measured after the
  > banners), so patching sentences would have left a strategy that still assumes a distribution
  > model that does not exist. What each file still gets right is named in its banner so nothing
  > useful is thrown away with the premise.
  >
  > **A THIRD instance was found 2026-09-15 that D-62 does not name, and it is the one that
  > matters:** `.vibectx-plan/change-records/CR-20260906-release-0.1.3.md:40` reads *"Every consumer
  > that runs `npx -y @blackraptorai/vibectx` at the new pin."* **That file is TRACKED (D-64)**,
  > unlike the two gitignored strategy files — so a developer who clones the repository receives it,
  > and the two D-62 named receive nobody. It is bannered **SUPERSEDED**, with its body left
  > unedited: a Change Record is a point-in-time record and rewriting it would falsify it.
  >
  > **Fact carried in the banner, worth stating here too:** 0.1.3 was never published. `0.1.2`
  > (July 2026) is still `latest` on npmjs.com, it predates the SSRF, ReDoS and unbounded-body
  > fixes that CR records, and the npm account is no longer accessible — so **those three defects
  > are still open in the only published package, and it can be neither deprecated nor
  > superseded.** That is a fact about the world, not a documentation defect, and it is not closed
  > by this decision.
- **D-63** 2026-09-10 — **`ecosystem` is an internal field on `LibraryEntry`, never a config key.**
  Registry entries keep a single name-keyed namespace; **D-11 stands unchanged.** REJECTED: making
  `ecosystem` settable in `vibectx.config.json`. MEASURED 2026-09-10 at `main` @ `64d05e8` —
  `evidentEcosystem` (`warm.ts:166`) has exactly one caller, `ecosystemNote` (`warm.ts:174`), whose
  only caller is `warm.ts:216`, where the value is joined into a display string. It reaches **no
  lookup, no fetch, no cache key, no exit code.** A config entry is a registry hit (`warm.ts:208`,
  `get-docs.ts:111`), so `resolvePackage` is never called for one and a user-supplied ecosystem
  would have no resolution to influence. Adding it to `EntrySchema` would turn an inert key into a
  hard config error, stack a third branch **above** the very mechanism A9 exists to delete, and
  claim the key name permanently — all paid in the user-facing schema, for one advisory note.
  **Correction recorded with it:** the silent strip of an unknown `ecosystem` key is **D-21 working
  as designed** — README:959 states it to users ("a file written for a later version still loads")
  and `test/config.test.ts:341` pins it with a literal `futureField: "ignored, not an error"`. The
  oversight seat originally filed it on PAR-722 as a trap; it is not one. **The internal cleanup is
  approved and is A9's existing scope** — no new item. | A9 / PAR-722 |
- **D-64** 2026-09-10 — **`.vibectx-plan/` is TRACKED in git.** Decided by Tom: a developer who
  clones VibeCTX must receive the decisions, Change Records, audit and scope statement the work is
  held to. **Five files stay local-only**, named individually in `.gitignore`:
  `PRODUCT-STRATEGY.md` and `LAUNCH-STRATEGY.md` — internal business strategy removed from the
  repository **and all history** on 2026-09-08 (`a0852f2` + `git filter-repo` + force push), so
  re-adding them would silently reverse that decision, and a developer evaluating the code does not
  need them — plus `scrub-paths.txt` (the inventory of what was scrubbed), `gitignore-new` and
  `plugin-list-2026-09-08.txt` (local scratch, no reader value). MEASURED before committing: **no
  credential value appears anywhere in the directory** — the only 40-character strings are git SHAs,
  and the one credentials passage (`vibectx-oversight-handoff-addendum-2026-09-08.md` §3) records
  that `GH_TOKEN` and `GITHUB_TOKEN` are *set* in a cloud container, never their values; the only
  absolute local path is the external volume name. **Corrects a premise raised the same day:**
  build sessions could ALWAYS read `.vibectx-plan/` — `git worktree list` shows one worktree and
  every item branch and rebase in the reflog was created in it, and `.gitignore` hides files from
  git, not from a shell. Tracking buys the clone case, version history, and survival off a single
  external volume — **not** build-session visibility, which was never missing. **Still single-copy:
  `CLAUDE.md`**, the D-57 authority for the test count, stays gitignored and is **not in a clone**.
  **CORRECTED within the hour of writing this:** it IS now mirrored, to the Claude project as
  `claude/CLAUDE.md`, and `CLAUDE.md`'s own baseline rule was amended the same day to require
  re-mirroring whenever the test count changes. The "mirrored nowhere" clause above was true when
  written and false minutes later — **an instance of the exact defect D-57 exists to prevent,
  committed inside the decision that cites D-57.** Left visible rather than silently rewritten. | PAR-754 |
- **D-65** 2026-09-10 — **A Change Record's §7 signature is Tom's initials. Never an agent's. A record
  signed by anyone else is UNSIGNED.** MEASURED by `grep -rn "Signed:" .vibectx-plan/change-records/*.md`
  across all 14 records, full output read:
  `CR-20260720-install-dev-team.md:82` → `TH (Tom Hanks, BlackRaptor AI)`;
  `CR-20260722-add-research-integrity.md:68` → `TH (Tom Hanks, BlackRaptor AI)`;
  `CR-20260909-par-714-url-host-policy.md:246` → `Phase 2 build session (Claude Sonnet 5) — producer
  role, not a gate seat`; the other 11 → `______________`.
  **An agent signed a Change Record in a line that states in the same breath that it had no standing
  to sign, and the oversight seat counted it as one of "3 signed."** A rule was breached once and
  then recorded as compliance by the seat meant to enforce it.
  **Corrected ledger: 14 records, 2 human-signed, 12 unsigned.** Both valid signatures are July 2026
  and cover agent-pack installation — **zero 0.2.0-era records carry a human signature.**
  Consequences: outstanding is **12** (or **14** once D-60's A3/A4 records exist), not 11 and not 13;
  and `CR-20260909-par-714`'s **20 conditions are NOT discharged**, taking PAR-753's triage surface
  from 51 to **71**. Found by an independent audit of the oversight seat, then verified directly. | PAR-753 |

  > **LEDGER UPDATED 2026-09-16 — and D-65's own breakdown was off by one.**
  >
  > **The headline number survives. The sub-count did not.** Re-running D-65's exact command today,
  > `grep -rn "Signed:" .vibectx-plan/change-records/*.md`, returns **15 lines across 16 files** —
  > because **`CR-20260731-agent-repair.md` has no `Signed:` line at all.** It predates the current
  > template: four sections, no §7, and its *"## 4. Human sign-off"* reads **PENDING**. On the
  > 14-record tree D-65 measured, the same command returned **13** lines, so *"the other 11 →*
  > `______________`*"* was really **10 blanks plus one record the method could not see.**
  >
  > **2 + 1 + 10 + 1 = 14, so "12 unsigned" was right** — the agent-signed record and the
  > no-signature-line record both count as unsigned, and they cancelled the error. **A correct total
  > reached through a wrong breakdown is still a wrong measurement**, and it is recorded here because
  > the next audit that trusts the breakdown rather than the total will be wrong by one.
  >
  > **A second trap, for whoever audits next.** `CR-20260907-source-distribution.md:170` writes
  > `*Signed:*` in single asterisks, not `**Signed:**`. A stricter pattern anchored on `^\*\*Signed:\*\*`
  > silently drops it — **this seat's own first pass did exactly that today** and would have reported
  > 14 signature lines for 16 files. D-65's looser `"Signed:"` is the correct form; do not tighten it.
  >
  > **Ledger as of 2026-09-16: 16 records — 4 human-signed, 12 unsigned.**
  >
  > | | |
  > |---|---|
  > | Human-signed | `CR-20260720-install-dev-team` · `CR-20260722-add-research-integrity` (July 2026) · **`CR-20260909-par-717-cache-meta-validation`** · **`CR-20260910-par-716-refresh-index-session`** (2026-09-16) |
  > | Agent-signed, therefore UNSIGNED | `CR-20260909-par-714-url-host-policy:246` |
  > | Blank signature line | 10 records |
  > | **No signature line at all** | `CR-20260731-agent-repair.md` — pre-template, §4 reads PENDING |
  >
  > **The two signed today are the first 0.2.0-era records to carry a human signature**, closing the
  > *"zero 0.2.0-era records are human-signed"* finding above. Tom took the decision in-session on
  > 2026-09-16 after the nine §5 risk acceptances were enumerated, and authorized the signature; each
  > §7 records how it was given. **That is the same form as the two July signatures** — both read
  > *"signature authorized in-session"* — and D-65 counts those as the only valid ones. It is **not**
  > the form D-65 struck, which was an agent signing under its own name.
  >
  > **PAR-753's 71-condition triage surface is unchanged.** Both new records carry an empty §3, so
  > signing them discharged no gate conditions — it accepted nine named risks instead. | PAR-753 |
- **D-66** 2026-09-10 — **Every go block opens with the commit it was written against, and a step 0
  that checks it.** `Written against <sha>. Step 0: git rev-parse --short HEAD. If it differs, STOP
  and report — every line number below is void.` Reason: `main` moved `839bfd7` → `64d05e8` →
  `4f3aa07` inside one day, while four completed validations cite `64d05e8` and PAR-754's own
  done-when requires them checked at `839bfd7`. **Those four validations do not satisfy their own
  acceptance criterion as written.** One line in every block removes the whole class. | PAR-754 |
- **D-67** 2026-09-10 — **No annotation may say MEASURED without carrying the command and its
  output.** Not "measured at `4f3aa07`: lines 90–421" but the `grep -n` and the `sed -n` with what
  they printed. Reason: the `registry.ts` data range went `91–422` → corrected to `90–422` →
  corrected again to `90–421`. **An off-by-one that survives a correction is not carelessness; it
  means the re-read used the same method as the read.** Carrying the command converts a re-read into
  a re-run, and turns a third party's check into a copy-paste instead of a re-derivation. Retro-apply
  to PAR-720, 721, 722 and 653 — those are the issues about to be built from. | PAR-754 |

---

## D-68 — decided 2026-09-11 by Tom

- **D-68** 2026-09-11 — **Before dispatching an instruction that depends on a language or runtime
  rule the oversight seat is not certain of, build a minimal reproduction and RUN it.** Not the
  refactor — **the mechanism.** Six lines in a scratch directory, never the repo. Where the question
  cannot be reduced to something runnable, say so in the go block and mark it an **ASSUMPTION** for
  the build session to verify before it touches anything.

  **Evidence (D-67 — the command and its output):**

  ```
  status.ts:    export const inFlight = new Set<string>();
                export let started = false;

  autowarm.ts:  import { inFlight, started } from "./status.js";
                export function startAutowarm() {
                  inFlight.add("react");   // line 3
                  started = true;          // line 4
                }

  $ tsc --noEmit                                   # TypeScript 5.6.3
  autowarm.ts(4,3): error TS2632: Cannot assign to 'started' because it is an import.
  ```

  And the escape hatch a builder reaches for on seeing that error:

  ```
  autowarm.ts:  import * as s from "./status.js";
                export function startAutowarm() { s.started = true; }

  $ tsc --noEmit
  autowarm.ts(3,5): error TS2540: Cannot assign to 'started' because it is a read-only property.

  $ node main.mjs                                  # if it had somehow compiled
  TypeError: Cannot assign to read only property 'started' of object '[object Module]'
  ```

  **Note what did NOT error: line 3.** Mutating an imported `const Set` across a module boundary is
  legal; reassigning an imported `let` is not. **That asymmetry is the whole reason A8's mutation
  list looked complete while being fatal** — it named `:54, :112, :126, :133`, all four `Set`
  methods, and omitted `:55` and `:97`, the two scalar reassignments.

  **Cost: about 40 seconds, in the oversight seat's own container. No repo, no build session, no
  Mac.** The earlier claim *"I have no shell in the build sandbox, so I cannot test this"* was a real
  limit wrongly generalised: the mechanism question needs none of those things. Four senior
  specialists caught this defect by reading, which worked but cost three full reviews; the probe
  cost forty seconds.

  **Limit, stated plainly so this is not over-claimed:** a probe proves **language mechanics only.**
  It cannot show whether an existing test breaks, whether an assertion is vacuous, or whether a
  refactor works in the real codebase. Those need the real files and the real suite, and they remain
  the build session's job. | A8 / PAR-721 |

---

## D-69 — decided 2026-09-15 by Tom

- **D-69** 2026-09-15 — **A go block may only require a step the receiving seat can actually
  perform.** Before dispatch, the **tool grants of every gate named must be read, not assumed.**
  Routing work to a seat that cannot execute it is a **router defect, never a gate defect.**

  The dispatch artefact this rule governs is the **`.vibectx-plan/go/` folder** (created 2026-09-11):
  a go block is a versioned document in the repository, written by the oversight seat and read by a
  build session, not a message pasted once and lost. `go/README.md` distinguishes it from the
  retired phase go cards in the parent directory.

  **Evidence (D-67 — the command and its output).** Measured 2026-09-15 from
  `BlackRaptor_Workforce_Golden/_source/dist/public/dev/*.md`, YAML frontmatter:

  ```
  $ grep -m1 -E '^tools:' dev/{test-auditor,code-reviewer,security-architect,schema-reviewer,completion-auditor}.md

  test-auditor        tools: Read, Grep, Glob                       <- no Bash
  schema-reviewer     tools: Read, Grep, Glob                       <- no Bash
  security-architect  tools: Read, Grep, Glob, WebSearch, WebFetch  <- no Bash
  code-reviewer       tools: Read, Grep, Glob, Bash
  completion-auditor  tools: Bash, Read, Grep, Glob
  ```

  Of the 23 agents in `dev/`, **`code-reviewer` and `completion-auditor` are the only read-only
  gates granted `Bash`.** Every producer seat has it. "Gates read, producers run" is the pack's
  design, not an oversight.

  **What this rule exists to prevent.** A8 was routed to `test-auditor` with steps that required a
  shell — a suite count and a `git diff` — in a dispatch whose own text read *"do not route it to a
  gate that cannot execute."* The gate disclosed the limit in the correct field and returned
  CONCERNS. **Round 2's CONCERNS was therefore not an unclosed condition; it was the gate correctly
  refusing to certify something outside its reach.**

  **Correct routing, recorded so it is not re-derived:** `test-auditor` answers *are these
  assertions real and non-tautological* — read-only, by the method its own charter prescribes
  (*"Break the code in my head. Which of these tests goes red?"*). **`completion-auditor` — the gate
  with `Bash` — answers *did they run*.** Two questions, two seats.

  **Correction carried by this decision.** The oversight seat previously recorded this as a
  **"systemic defect in the gate's environment"** on **PAR-721**, which reads: *"A quality gate that
  cannot run the suite cannot gate test work — that is a systemic defect in the gate's environment,
  not a defect in A8, and it needs its own item."* That claim is **wrong** and is to be struck. The
  gate behaved correctly in every instance; the router did not.

  **Scope of that correction, checked rather than assumed.** This decision first named **PAR-753** as
  carrying the same claim. **It does not** — verified 2026-09-15 by reading the full issue body.
  PAR-721 is the only VibeCTX record carrying it. The first draft of this decision asserted two
  records from memory and was corrected in the same session, before the file was committed. **That
  is the error this decision exists to stop, committed inside the decision itself.** It is left on
  the record rather than quietly edited out. The
  Agents-side filing **PAR-750** never made that claim and needs no correction — the measured
  frontmatter was posted to it on 2026-09-15, confirming its §3 hypothesis and narrowing two of its
  three proposed remedies.

  **Limit, stated plainly.** Reading a grant proves what a seat *can* run. It does not prove the
  seat *will* run it, nor that the step is the right one. | A8 / PAR-721 · PAR-750

---

## D-70 — decided 2026-09-17 by Tom

- **D-70** 2026-09-17 — **Lean process for the rest of 0.2.0.** Each Linear issue is built in
  one Claude Code session on Tom's Mac: branch off `main`, tests first, lint + tests green, one
  `code-reviewer` pass on the diff (plus one `security-architect` pass when the change touches
  URL/host policy, fetching, redirects, config URL handling, the on-disk cache or search index,
  or any file delete/rename), then a PR whose description carries the done-when status and the
  review findings. Tom squash-merges. `main` is protected on GitHub (PR required, `test` check
  required, branch up to date, no bypass); that protection plus the deny rules in
  `.claude/settings.json` replace the no-push rule and the bundle handoff. One Change Record per
  release, signed by Tom. Full 0.2.0 scope is unchanged.
  **Supersedes:** D-01; D-52 (verdict-enforcement clause only — the packs are still consumed as
  plugins); D-53; D-54; D-57 (test-count clause only — CI is now the record); D-66; D-67; D-68;
  D-69. **Amends D-64:** `CLAUDE.md` and `.claude/settings.json` are now tracked.
  **Unchanged:** D-02, D-58, D-59, D-65.
  **Retired for this repo:** the oversight seat, phase gates, go blocks, handoff bundles,
  per-item Change Records, verdict blocks and the verdict Stop hook, test-count baselines, and
  MEASURED annotations. The old process documents are in `.vibectx-plan/archive/`.

---

## D-71 — decided 2026-09-17 by Tom

- **D-71** 2026-09-17 — **A cache storage key must be verifiable against the record it names —
  BOTH the key is made collision-resistant AND every reader verifies the record against the
  request.** Consolidates PAR-741, PAR-742, PAR-743 and PAR-745 (already merged into
  **PAR-749** on 2026-09-10, D-61) into one design item, built as PAR-749.

  **Two roots.** (1) `urlSlug` and `libDir`'s name-folding regexes were lossy and used
  directly as storage keys with no collision check: two distinct URLs (or library names)
  differing only in a character the fold maps to `_` produced the identical file name, and
  `readCache` never compared the requested URL against the `url` field the meta file itself
  carried — so a collision (or a foreign file planted under a name-shaped slug) could serve
  one document's content under another's name, silently. (2) `.meta.json` had four readers at
  four different trust levels — a strict per-field validator, a strict validator plus a
  provenance round-trip, an ad hoc lax parse, and no check at all.

  **Fix, both halves, in the same item.** `urlSlug` and the library-directory fold (now
  `libDirName`) each append a short hash (12 hex characters, SHA-256-derived, 48 bits) of the
  FULL, untruncated input to the folded, human-legible prefix — an ACCIDENTAL collision between
  two unrelated inputs is now astronomically unlikely (not a mathematical impossibility; a
  48-bit digest is a collision-resistance bound, not an injectivity guarantee), whatever their
  folded form. On the URL dimension that is deliberately not the only defense: `readCache` and
  `touchCache` now additionally verify the meta's own `url` against the URL actually requested
  and treat a mismatch as a miss/no-op — this is the check that actually makes serving the
  wrong document impossible, independent of hash collision resistance. The library-name
  dimension has no equivalent second check (a library name is not itself stored in
  `.meta.json`); accepted, because the input space there is narrower (an npm/package name, not
  an arbitrary URL) and the worst case is loss of re-fetchable cache, never wrong content served
  as right. The strict validator (`toCacheMeta`) and the provenance check
  (`urlSlug(meta.url) === slug`, generalised as `metaMatchesSlug`) are extracted to a new
  shared module, `src/cache-meta.ts`, imported by both `src/cache.ts` and `src/cache-evict.ts`
  — there is no longer a second, laxer `.meta.json` parser anywhere in the codebase.
  `cache-evict.ts`'s recency reader now uses the same shared validator; its stale comments
  asserting the pre-A4 ("an unparsable `fetchedAt` reads as stale") behaviour are corrected.
  `enforceCacheSizeCap`'s own delete decision deliberately keeps deciding by proven
  `<slug>.md`/`<slug>.meta.json` pair shape under an already-D-46-proven root, not by the
  `metaMatchesSlug` identity proof `dropFollowedPageCache` needs — eviction frees space from
  any such pair regardless of whose URL its meta claims, and it is by the same mechanism (it
  discovers whatever pairs exist on disk rather than deriving an expected name from a URL) that
  it keeps reaching pre-D-71 ("old-format") cache files for cleanup, with no special-case code.

  **Migration:** none needed, deliberately. Existing cache entries under old (non-hash-suffixed)
  names are simply not found by the new key derivation, so they are orphaned and re-fetched
  fresh under the new name on next use — this is a full cache invalidation on upgrade, for
  every user, not a background migration; a user relying on `offline` mode should run
  `vibectx warm` while online before or right after upgrading, or `get_docs`/`search` degrade
  for anything not yet re-cached. Orphaned old-format files are only reclaimed once the cache
  actually exceeds `VIBECTX_CACHE_MAX_MB` (default 512 MB) and `enforceCacheSizeCap` sweeps —
  under a typical, unexceeded cache they persist on disk indefinitely (wasted space, not a
  correctness or security issue: `scanCache` discovers pairs by walking disk rather than
  deriving expected names, so old- and new-format entries for the same logical document can
  coexist without aliasing each other). Flagged for the 0.2.0 release note / Change Record,
  not just here.

  **Verified disproven, recorded so nobody re-derives it (PAR-749's own text):** the Root 1
  collision never undermined A3's provenance check in `dropFollowedPageCache` —
  `keep.has(slug)` short-circuits before `urlSlug(meta.url) !== slug`, so a collision caused a
  false KEEP (preservation, the safe direction), never a wrong delete. The harm was entirely on
  the read path (`readCache`), which this item closes.

  **Gates:** `code-reviewer` + `security-architect` (D-70 lean process — this item touches
  cache-key derivation, the on-disk cache, and eviction/delete paths). | PAR-749

---

## D-72 — decided 2026-09-17, executing A7 / PAR-720

- **D-72** 2026-09-17 — **D-48's class is the character SET, not the substitution; each call
  site's replacement choice is its own decision, made once and shared.** `src/text.ts` exports
  one binding onto the union class, `stripControlBidi(s, replacement = "")`, so the set is
  defined exactly once and every caller supplies only what to put in a matched character's
  place. `cleanText`/`clipText` (list_libraries, warm, project-deps, config, the CLI) and
  `debugField` keep deleting — technical/structural text (paths, names, debug fields) where a
  merged character is harmless. `resolved-store.ts`'s `cleanDescription` keeps its pre-existing
  choice of a space for C0/DEL/C1 (a tab or newline used as a real word separator must not run
  two words together — unchanged behaviour, already true before this item), but now ALSO spaces
  the zero-width/bidi/BOM characters it used to delete, because the one-class contract does not
  allow splitting the union into "space these, delete those" at a single call site without
  reintroducing the local-variant defect D-48 exists to forbid. Measured, that is the one real
  behaviour change: a zero-width joiner or similar mid-word mark in a description
  (`"x" + U+200D + "y"`) now renders `"x y"` where it used to render `"xy"` (code-reviewer, A7
  round 1). Accepted: this
  text is already flagged `(package-supplied)` and untrusted, `\s+` collapse absorbs most cases,
  and a visible space artifact next to two words running together is the smaller defect. The
  union itself also grew: U+2028/U+2029 (line/paragraph separator) were previously caught only
  by `debug.ts`'s own copy of the class and now apply everywhere; U+0080–U+009E and U+FEFF now
  apply to `cleanDescription`, which previously missed them.
  Ref: `src/text.ts`, `src/debug.ts`, `src/resolved-store.ts`, `test/control-bidi-union.test.ts`
  (A7 / PAR-720).

---

## D-73 — decided 2026-09-17, executing A17 / PAR-726

- **D-73** 2026-09-17 — **The provenance stamp ships without a version/ref field; A11
  (PAR-724) has not been built, and there is nothing to read.** PAR-726's own Fix section lists
  "version or ref (from A11)" as one of four standing-stamp fields, on the premise that A11
  already landed. Checked against the actual tree before starting (`git log --all --grep
  PAR-724`: zero commits; grepped `LibraryEntry`/`ResolvedMeta`/`ResolveOutcome`/`CacheMeta`/
  `DocResult` for a version field: none exists anywhere in `src/`) — the premise is false. A11
  is Todo, not started, and is a substantial separate item (version-aware cache keys, a
  per-tag npm/GitHub resolution chain) that this item is not the place to build as a side
  effect. Per this repo's `CLAUDE.md`: "If a Done-when is wrong or can't be met, say so in the
  PR and move on."
  **What shipped instead:** the stamp carries the four facts that DO exist and are readable
  without new plumbing — source URL, fetched-at (ISO, from cache meta — `fetcher.ts`'s
  `DocResult` and `cache.ts`'s `writeCache`/`touchCache` now return the exact value they
  persisted, not a second, separately-taken `new Date()`), fresh-or-stale (past the entry's
  TTL), and curated-or-resolved (`entry.resolved === undefined`, the same reading
  `list-libraries.ts` already established). One shared renderer, `sourceStampLine` in
  `src/retrieval.ts`, used by both `get_docs` (`get-docs.ts`'s `docStamp`) and `search`
  (`search.ts`'s `groupHeader`), so the wording cannot drift between the two tools the way the
  three pre-A7 control-character classes did — the same lesson D-48 already recorded, applied
  here to what a header states rather than what a regex matches.
  **No version claim is fabricated or silently omitted without a trace:** the stamp simply
  does not have a version slot yet. When A11 lands, it is a straightforward extension of
  `StampFacts`/`sourceStampLine`, not a rework of this item's plumbing.
  Ref: `src/retrieval.ts` (`sourceStampLine`), `src/get-docs.ts`, `src/search.ts`,
  `src/fetcher.ts`, `src/cache.ts` (A17 / PAR-726).
  **Superseded 2026-09-17 by D-76**, which closes this gap exactly the way predicted above —
  `StampFacts` gained an optional `version` field, `sourceStampLine`/`fitStampLine` extended,
  nothing about A17's own plumbing reworked.

---

## D-76 — decided 2026-09-17, executing A11 / PAR-724

- **D-76** 2026-09-17 — **D-50 executed: documentation is version-matched where a manifest
  names an unambiguous exact pin, and the fallback to latest is always stated, never silent.**
  Checked against the tree before starting: no version field existed anywhere (`ProjectDependency`,
  `LibraryEntry`, `ResolveOutcome`, `StampFacts`) — D-73's premise (that A11 had already landed
  when A17 was built) was confirmed false, exactly as D-73 itself found.
  **What "an unambiguous exact pin" means, precisely** — the premise in A11's own Shape ("`warm`
  already parses the version specifier next to every dependency name, then discards it") was
  ALSO checked against the tree and found false: no version specifier was parsed anywhere in
  `src/project-deps.ts` before this item, discarded or otherwise (`ProjectDependency` had no
  version-shaped field to discard into). Parsing was built from scratch, scoped deliberately
  narrow: a bare semver in package.json (`"1.2.3"`, never `"^1.2.3"`), a PEP 508 `==` pin in
  requirements.txt / `[project].dependencies` (`django==4.2.3`, never `>=`/`~=`/a second
  comma-separated constraint), and a plain quoted Poetry string with no range character
  (`django = "4.2.3"`, never `^`/`~`/an inline table). A range is not a pin — `get_docs` has no
  single version to match documentation against for one, and inventing the range's lower bound
  as "the" version would itself be a silent fabrication of the kind D-50 forbids. Lockfile
  resolved-version capture (`package-lock.json`'s `packages["node_modules/<name>"].version`,
  pnpm's equivalent) is NOT built — those lockfiles are read today only when the manifest itself
  is ABSENT (an existing, pre-A11 constraint unrelated to this item), so wiring resolved-version
  capture through them would need restructuring that discovery path, out of this item's scope.
  Filed as a follow-up, not silently dropped.
  **The resolution chain, per the Shape's own naming** — when `get_docs(library, topic?,
  version?)` is given a version: for an unknown name, `resolvePackage` gains one extra
  metadata fetch at the exact pinned version (`registry.npmjs.org/<name>/<version>`,
  `pypi.org/pypi/<name>/<version>/json` — both real, documented per-version registry endpoints)
  to confirm the version is registered and read its (possibly different) repository field, then
  tries GitHub tag-README candidates at `refs/tags/v<version>/<file>` and
  `refs/tags/<version>/<file>` (the explicit `refs/tags/` ref form, not a bare tag name as the
  ref segment — the same shape the existing `HEAD` candidates already use, `refs/tags/`
  disambiguates a tag from a same-named branch) BEFORE the existing unversioned llms.txt/README
  chain. A CURATED (default-registry or config) entry is deliberately never re-resolved for a
  version — its `urls` are hand-picked doc sources, not registry-metadata-derived, so there is
  no version-specific candidate to try; `get_docs` says so explicitly rather than silently
  ignoring the argument. An already-RESOLVED (non-curated) entry IS re-resolved for a version,
  reusing the same re-resolution machinery `warm.ts`'s D-11 ecosystem-mismatch handling already
  established.
  **Non-silent fallback (D-50's own words), both directions:** `StampFacts` gained an optional
  `version` field, set ONLY on a genuine version-specific match — never merely because a version
  was requested. When a version was requested and none was matched, the response states the
  substitution explicitly (`retrieval.ts`'s `versionFallbackNote`) rather than leaving a stamp
  with no version field to be silently misread as "no version was asked for".
  **Cache keys are already version-aware, no structural change needed:** the cache is keyed by
  `(library, url)` (D-71/PAR-749), and a version-specific candidate URL
  (`.../refs/tags/v1.2.3/README.md`) is a different string from an unversioned one, so it
  already lands in a distinct cache entry — verified, not merely assumed, by a regression test
  proving two different pinned versions of the same library get isolated cache entries. The
  UNVERSIONED fallback candidates (llms.txt, homepage) are, by contrast, genuinely
  version-agnostic URLs and deliberately DO share one cache entry across every version that
  falls back to them — that is the correct behaviour (one fetch, not one per requested version,
  for content that is not actually version-partitioned), made safe by the fallback statement
  above rather than by adding a cache dimension that would just paper over the same fact.
  Ref: `src/limits.ts`, `src/resolve.ts`, `src/retrieval.ts`, `src/project-deps.ts`,
  `src/get-docs.ts`, `src/warm.ts`, `src/server.ts` (A11 / PAR-724).

  **Round 1 review (code-reviewer + security-architect), two blocking findings fixed before
  merge:**
  - **security-architect S-1/S-2 (BLOCKING):** `version` — an MCP tool argument or a
    manifest-captured string, neither trusted — reached a URL template
    (`versionReadmeCandidates`'s `raw.githubusercontent.com/<owner>/<repo>/refs/tags/<tag>/…`)
    and a rendered response (`resolvePackage`'s attempt lines) with no shape check: a `version`
    containing `../../../../evil/repo/HEAD` escaped the intended GitHub path via ordinary URL
    dot-segment normalisation, and a `version` containing a newline could forge a fake second
    response line, the exact A17/S-1 class one interpolation over. Fixed with one shared gate,
    `VERSION_SHAPE` (`src/package-names.ts`, D-48: one definition, not a local variant per
    module) — alnum-first, then alnum/`.`/`+`/`_`/`-` only, which makes both attacks
    structurally impossible (no `/`, `\`, or control character can ever appear) rather than
    merely encoded or cleaned away. A version failing the shape is refused for fetching but
    still named, safely clipped, in a non-silent note. Belt-and-braces: `versionReadmeCandidates`
    itself re-proves the built URL still starts with the intended prefix after a `new URL()`
    round-trip, and the Poetry manifest branch (the one parser whose old range-character
    denylist did not exclude `/`) now shares the same gate.
  - **code-reviewer B1 (BLOCKING):** a version-pinned resolution replaced the library's live
    registry entry AND `resolved.json` with the version-tag URL first in `urls`, so a LATER,
    plain `get_docs("<lib>")` (no version) would resolve straight to it and silently serve the
    pinned document — D-50's rule violated in the other direction ("asked for latest, got a
    pin"). Fixed by splitting what serves THIS call from what gets installed/persisted:
    `ResolveOutcome.entry` keeps the full candidate list (so the document this call just cached
    is actually reachable); a new `ResolveOutcome.persistedEntry`, set only when it differs,
    carries the unversioned candidates alone and is what every caller now installs
    (`installResolvedEntry(registry, out.persistedEntry ?? out.entry)`) and what
    `saveResolvedEntry` writes. Regression test: resolve a version, then call `get_docs` again
    with no version in the same process — the second call must not carry the pinned document.
  - **code-reviewer B2 (BLOCKING):** re-resolving an already-resolved entry for a version could
    fail outright (network down, rate-limited) without ever checking anything, and the response
    still said "No document found for version X" — an affirmative claim the run never earned.
    Fixed with a distinct, honest note for that case ("Could not check version X — the
    resolution limit was reached / the check failed; showing the previously cached document
    instead"), and `offline` is now honoured on this branch too (should-fix #4, same round).
  - **code-reviewer B3:** this entry originally claimed a regression test proved the
    cache-isolation reasoning above before that test existed. It exists now
    (`test/resolve.test.ts`, "cache isolation across pinned versions"); the claim is no longer
    aspirational.
  - **should-fix, applied:** the npm `security-holder` placeholder is no longer counted toward
    A16's existence claim (it is a real, registered record, not a genuine 404); the thin-match
    comment no longer claims a mitigation that cannot apply at that exact budget.
  Ref (round 1 fixes): `src/package-names.ts`, `src/resolve.ts`, `src/get-docs.ts`,
  `src/project-deps.ts`, `src/server.ts`.

---

## D-77 — decided 2026-09-17, executing A16 / PAR-725

- **D-77** 2026-09-17 — **A name that does not exist in npm or PyPI is now a structurally
  distinct signal from a name that exists but has no reachable documentation.** Before this,
  `resolve.ts` already queried both registries and already produced two different free-text
  attempt strings for the two cases internally, but neither the `ResolveOutcome` type nor the
  rendered message distinguished them for a caller — both read as one undifferentiated
  "unresolved" outcome.
  **The wording is scoped to what was actually checked, never broader:** "does not exist in npm
  or PyPI" is used ONLY when both registries were genuinely queried and both answered a real
  HTTP 404 (`fetcher.ts`'s new `FetchOutcome.httpStatus`, set only on a received response —
  never on a timeout, a DNS failure or any other miss reason, which stay ambiguous and make no
  existence claim). A caller that deliberately restricts the lookup to one registry
  (`resolvePackage`'s `ecosystem` option — `warm.ts` always does this, matching a dependency to
  the ecosystem its own manifest names) gets the narrower, equally honest claim scoped to just
  that registry ("does not exist in npm"), never the two-registry phrasing it did not earn.
  This is why `warm`'s own "not found" status is reachable at all: `warm` never queries both
  registries for one dependency (by design, to halve metadata fetches and avoid the
  same-name-on-both-registries ambiguity — a pre-existing decision, unchanged here), so the
  two-registry claim alone would have made this status permanently unreachable from `warm`.
  **Claim discipline (this repo's CLAUDE.md):** the only existence claim produced anywhere is
  the fact itself — "X does not exist in npm or PyPI" (or the registry-scoped variant) — worded
  so it cannot be read as "VibeCTX prevents hallucination" in general; the sibling wording for
  the other case ("exists but publishes no documentation VibeCTX can reach") says in the same
  sentence that this is NOT a sign the package doesn't exist, so the two cases cannot be
  confused for each other even by a careless read.
  **Four surfaces, one signal:** `resolve_library` / `get_docs` (both render
  `couldNotResolveMessage`'s text directly, so no separate wiring was needed once the message
  itself carried the distinction), the CLI (`vibectx resolve` prints the same text; the exit-code
  check on the literal prefix `Could not resolve` still holds under every wording variant — pinned
  by test), and `warm`'s status column (`"not found"` added to `WarmStatus`, distinct from
  `"unresolved"`).
  **Schema bump, per this repo's own K3 rule:** `PROJECT_RECORD_SCHEMA_VERSION` 1 → 2 — the
  first REAL exercise of the bump machinery every schema-version constant in this codebase had
  been carrying since 0.2.0 planning began, still at 1 everywhere else. An older reader that
  stayed on version 1 and saw a `"not found"` row under an unchanged version would have silently
  dropped it (K3's own stated reason for the rule); the bump makes that reader refuse the whole
  file instead, with a visible "newer schemaVersion" note — the honest failure mode.
  Ref: `src/fetcher.ts`, `src/resolve.ts`, `src/project-store.ts`, `src/warm.ts`,
  `src/server.ts` (A16 / PAR-725).

  **Round 1 review, one should-fix applied:** npm's `security-holder` placeholder (a real,
  registered record — a taken-down name parked on npm's own security-holder account, not a
  genuine 404) is no longer counted toward the "does not exist" claim — see D-76's own round-1
  addendum for the full history; this line exists here because it is squarely an A16 claim-
  discipline concern, not an A11 fetch-path one.

---

## D-74 — decided 2026-09-17, executing PAR-776

- **D-74** 2026-09-17 — **A redirected primary document's `url` stays the CANDIDATE
  throughout; the URL it actually landed on is carried in a new, parallel `finalUrl` field
  rather than repointing what `url` means.** `DocResult.url` was, before this item, read two
  different ways by different callers without either being wrong on its own terms: `search.ts`'s
  `primaryCached()` and the on-disk search index's hash+url gate iterate `entry.urls` (the
  candidates) to correlate a cached document with its index entry, and `doctor.ts` calls
  `readCache(entry.name, source.url, ttlHours)` directly — both need the exact candidate, never
  wherever a redirect moved the content. `get-docs.ts`, meanwhile, needs the URL the content was
  ACTUALLY served from to resolve the document's own relative links and to run the host-policy
  check, and used `doc.url` for that too — so a primary document that redirected cross-host had
  its links resolved and checked against the wrong host. Repointing `url` to mean "wherever this
  ended up" would have fixed `get-docs.ts` and broken the other two.
  **What shipped instead:** a new field, `finalUrl`, threaded through `DocResult`, `FetchOutcome`,
  `CacheMeta` (persisted, so a later cache hit with no network call still knows it), and
  `GetDocsOutcome.source` (added only when it differs from the candidate). `get-docs.ts`'s link
  extraction, ranking, host-policy check and followed-link fetch now use `finalUrl`;
  `indexCachedDocument` and `source.url` deliberately still use the candidate `url`, unchanged,
  matching `search.ts`'s and `doctor.ts`'s existing contract. The rendered `Source:` stamp
  (`retrieval.ts`'s `sourceStampLine`) names the final URL and states `(redirected from
  <candidate>)` when they differ.
  **A read-side trust gap this decision does NOT license:** a persisted `finalUrl` is
  attacker-reachable the same way `url` always was (a hand-edited or corrupted `.meta.json`), and
  is used as the same-origin base for the host-policy check on read — so it is validated on read
  with the same `sanitizeRemoteUrl` rule (https, no userinfo, non-forbidden host, ≤2048 chars)
  the write side already guarantees via `hopAllowed` on every redirect hop, not the looser
  `validMetaUrl` bound `url` itself uses (which deliberately allows an internal host under
  `allowInternalHosts`, D-47 — `finalUrl` never should, since no redirect hop is ever allowed to
  land on one regardless of that flag).
  Ref: `src/cache-meta.ts` (`CacheMeta.finalUrl`, `toCacheMeta`), `src/cache.ts`
  (`writeCache`/`touchCache`), `src/fetcher.ts` (`DocResult.finalUrl`, `FetchOutcome.finalUrl`),
  `src/get-docs.ts`, `src/retrieval.ts` (`StampFacts.redirectedFrom`) (PAR-776).

---

## D-75 — decided 2026-09-17, executing PAR-778

- **D-75** 2026-09-17 — **`package.json`'s `engines.node` floor is `>=20.19.0`, exactly matching
  the version `vitest`'s `vite` dependency requires (`^20.19.0 || >=22.12.0`) at its low end,
  not the fuller range.** The declared floor (`>=18` before this) covered building and running
  the server but not the test toolchain, so a fresh clone on Node 18 installed successfully and
  then failed `npm test` with no warning at install time (`engine-strict` is off, MEASURED —
  npm reports `EBADENGINE` but does not refuse the install). CI already runs Node 22, which
  satisfies both ends of `vite`'s range regardless of which floor `engines` states.
  **Known, accepted gap:** `>=20.19.0` alone does not reject Node 22.0.0–22.11.x, which passes
  the `engines` check but still fails on `vite`'s actual requirement (the gap between
  `20.19.0` and `22.12.0`'s lower bound in a plain `>=` comparison). The fully accurate value
  would be the disjunctive range itself (`"^20.19.0 || >=22.12.0"`); PAR-778's Done-when
  specified the simpler `>=20.19.0` exactly, and that is what shipped — the simpler promise,
  not a tighter enforcement gate. `engines` remains advisory either way (`engine-strict` is not
  set), so neither form actually blocks an install; the value it did have was accuracy of the
  documented claim, which this closes for the common case.
  Ref: `package.json`, `package-lock.json`, `README.md`, `CONTRIBUTING.md` (PAR-778).

---

## D-78 — decided 2026-09-17, executing PAR-777

- **D-78** 2026-09-17 — **Two spellings of a name that differ only by PEP 503 punctuation
  folding (`foo-bar` / `foo_bar` / `Foo.Bar`) are the SAME package for registry identity —
  applied with no ecosystem check — but remain DISTINCT for cache-directory key derivation
  (D-71).** `normalisePyPiName` (`src/package-names.ts`) already existed and was already used,
  with no ecosystem check, at three read-only/fail-safe call sites (`resolveLibrary`'s lookup
  fallback; `curatedKeys`/`isTaken`'s resolved-record guard) — this item extends the SAME rule
  to `validateAliases` and `applyLayer`'s config-layer merge, the two places PAR-777's own
  Problem statement named as still comparing by exact case-fold only.
  **The two decisions are not in tension, though they look it side by side:** D-71 calls
  `foo.bar`/`foo_bar` "two DISTINCT, independently valid npm names" for `urlSlug`/`libDirName`
  — a cache key only needs to be collision-RESISTANT (every key is hash-suffixed regardless of
  spelling), so folding punctuation there would buy nothing and cost the human-readable prefix
  its meaning. A REGISTRY name needs the opposite property: recognising that two spellings name
  the SAME PyPI project is the entire point (that recognition is what PAR-777 was filed to
  restore). Two different questions, each answered consistently on its own terms.
  **Accepted, examined risk, not an unexamined one:** unlike the three precedent call sites
  (which only ever find-or-refuse, never remove anything), `applyLayer`'s merge can DELETE an
  existing canonical entry and replace it with a different one under a twin spelling. If two
  genuinely unrelated packages ever shared a PEP 503 form, a config entry for one would
  silently evict the other from the registry — the shipped defaults contain no such pair
  (checked by hand and pinned by test), and npm's own registry has rejected new names differing
  only by punctuation runs since well before this was written, but a pair predating that rule
  is not impossible. Accepted for the same reason the three precedent sites already accepted
  the parallel risk: the failure costs a confusing override or config error to diagnose, never
  a wrong document silently served through a hijacked cache entry.
  **A related, adjacent gap NOT closed by this item:** `resolved-store.ts`'s persisted
  `resolved.json` still dedupes by exact name only, so it can hold both `typing-extensions` and
  `typing_extensions` on disk (the in-memory `installResolvedEntry` guard catches it at use
  time; the file itself does not). Filed separately as a Linear follow-up — PAR-777's own
  Problem statement names only `validateAliases` and the config merge.
  Ref: `src/registry.ts` (`validateAliases`, `applyLayer`), `src/package-names.ts`
  (`normalisePyPiName`) (PAR-777).

---

## D-79 — decided 2026-09-17, executing A19 / PAR-728

- **D-79** 2026-09-17 — **`vibectx doctor`'s per-library verdict is persisted (new store,
  `doctor.json`) so `list_libraries` and `get_docs` can surface it without re-running a probe on
  every call, and `DoctorReport` gains an optional `eviction` key with no schema bump.**
  **Premise check against the tree first:** A19's own problem statement ("the classification
  appears in neither `list_libraries` nor any `get_docs` response") was partly stale —
  `list_libraries` already showed `[${kind}]` per row, derived directly from the cached document
  via `classifySourceKind` (PAR-707), independent of any doctor run. What was genuinely missing,
  and is the actual PAR-704 gap this item closes, is a PROBE verdict: whether a real topic query
  against the entry actually answered, which only `doctor` computes and — before this — never
  persists, so a library can be cleanly cached, `[index-only]`, and still fail every real query
  with no warning anywhere outside a manual `vibectx doctor` run.
  **Persistence, not re-probing:** doctor's verdict requires running probe queries through
  `getDocsDetailed`, which can touch the network — not something `list_libraries` (documented as
  network-free) or `get_docs` (a per-call budget, not a batch job) can afford to redo on every
  call. `runDoctor` now writes each `LibraryReport`'s `{kind, healthy, reasons}` to a new store
  (`src/doctor-store.ts`), mirroring `resolved-store.ts`'s exact K1 (every field re-validated on
  read, a malformed record dropped whole rather than partially trusted)/K2 (a file with a newer
  schemaVersion is left alone)/atomic-write shape; `list-libraries.ts` and `get-docs.ts` read it
  back cheaply. The verdict is therefore only as fresh as the last `doctor` run — stated in the
  store module's own doc comment, the same staleness the README already accepts for `doctor`
  results in general.
  **Where it surfaces, and how:** `list_libraries` gets a new `[doctor: <first reason>]` bracket,
  appended after the existing `[resolved]` tag, present only when a persisted verdict for that
  entry is unhealthy — absent (not "healthy") when doctor has never checked it, so the note never
  overclaims the way the existing `[unknown]` kind already declines to. `get_docs`'s stamp
  (`StampFacts`/`sourceStampLine`, A17/PAR-726) gains an optional `doctorKind`, set to the source
  kind doctor found ONLY when unhealthy, rendered as `· doctor check failed (<kind>)` and
  dropped together with `version`/`redirectedFrom` in `fitStampLine`'s existing "no invented
  priority between independently-added optional fields" degrade step — the same idiom `version`
  (D-76) and `redirectedFrom` (D-74) already established, reused rather than a new mechanism
  invented for a third field.
  **`DoctorReport.eviction` (CR-20260907-par-652-governance, `doctor-json-eviction`):** the
  cache-eviction summary `formatDoctorTable` has always rendered in its TEXT output
  (`lastEvictionSummary()`, PAR-652 item 7a) now also appears on the JSON report, as a plain new
  optional key — no schemaVersion bump, per `DOCTOR_SCHEMA_VERSION`'s own documented rule that a
  new key may be appended without one. Computed once in `runDoctor` and stored on the report;
  `formatDoctorTable` was changed to read `report.eviction` rather than calling
  `lastEvictionSummary()` a second time itself, so the text table and the JSON output can never
  state two different answers to the same question from two separate reads of that process-wide
  singleton.
  Ref: `src/doctor-store.ts` (new), `src/doctor.ts`, `src/list-libraries.ts`, `src/get-docs.ts`,
  `src/retrieval.ts` (A19 / PAR-728).

  **Round 1 review (code-reviewer + security-architect), findings fixed before merge:**
  - **security-architect S-1 (BLOCKING):** the cache directory — and `doctor.json` with it — is
    process-global, but a library's config (and so `reasons`, built in part from config-authored
    `probeQueries` text and from raw error messages that can carry filesystem paths or internal
    hostnames) is per project. Rendering `reasons` in `list_libraries` would have leaked one
    project's config-authored or error text into another project's tool response. Fixed by never
    rendering `reasons` in either surface — `list-libraries.ts`'s `[doctor: ...]` note and
    `get_docs`'s stamp both state only the closed `kind` enum and the check date; `reasons`
    stays persisted (a same-project `doctor --json` reader can still see it) and still
    cleaned/clipped on read, but no caller may treat that cleaning as sufficient to render it
    across a project boundary.
  - **security-architect S-2 / code-reviewer B2 (BLOCKING, found independently by both):**
    `saveDoctorVerdicts`'s `warn` defaulted to a no-op, so a K2 refusal or a write failure was
    silent forever — no stderr line, no report note, exactly the "fallbacks are stated, never
    silent" rule this file's own D-13 exists to prevent. Fixed by defaulting `warn` to stderr
    (matching `resolved-store.ts`/`writeProjectRecord`'s own default exactly) and adding
    `DoctorReport.notes?: string[]` — a new optional key, no schema bump — rendered by
    `formatDoctorTable` as `note: ...` lines, the same pattern `warm.ts` already established for
    its own best-effort persistence failures.
  - **security-architect S-3 (BLOCKING):** `checkedAt` was validated only by
    `Number.isFinite(Date.parse(...))`, which is not a length backstop (`cache-meta.ts`'s own
    MEASURED finding: an arbitrarily long fractional-seconds run still parses to a finite
    timestamp) — a third, unbounded copy of a gap that file's own comment already tracks for two
    OTHER stores. Fixed by exporting `cache-meta.ts`'s `ISO_INSTANT` and reusing it here (D-48:
    one definition, not a third local variant) rather than duplicating the gap. Verdict COUNT was
    also unbounded (the file merges by name and never prunes) — fixed with a new
    `MAX_DOCTOR_VERDICTS` (`limits.ts`, 500, ~1.71 MiB worst case), oldest-by-`checkedAt` dropped
    first once a save would exceed it, the same rule `ACTIVITY_LOG_MAX_ENTRIES` applies to its
    own file.
  - **code-reviewer B1 (BLOCKING):** an `--offline` doctor run's "unreachable" is the EXPECTED,
    correct answer for that call (README's own documented `--offline` behaviour), not a genuine
    probe failure — persisting it poisoned every later ONLINE response with a stale, misleading
    warning the moment the library was actually fetched and answered fine. Fixed: `runDoctor`
    skips persistence entirely for an offline run; an earlier online verdict already on disk is
    left untouched.
  - **code-reviewer B3 (BLOCKING):** an unhealthy verdict's stamp/note carried no date, so it
    read as a present-tense fact forever, even long after the library was fixed and simply never
    re-checked. Fixed: `checkedAt` is now rendered in both surfaces (`retrieval.ts`'s new
    `StampFacts.doctorCheckedAt`, always set together with `doctorKind`; `list-libraries.ts`'s
    note gained `, checked <date>`).
  - **Should-fix, applied:** N-2 (a persisted `reasons` element that was not a string used to be
    silently filtered rather than dropping the whole record — the K1 doc comment's own claim);
    N-3 (a forged `reasons` array was filtered/sliced in full before being bounded — now bounded
    to `MAX_RAW_REASONS` first); N-4 (`SOURCE_KINDS` is now a `Record<SourceKind, true>`, which
    fails to compile if `SourceKind` gains a member this file does not also list, rather than
    silently rejecting the new kind at runtime); N-5 (`saveDoctorVerdicts` now round-trips each
    verdict through `toDoctorVerdict(toRecord(v))` before writing, matching
    `saveResolvedEntry`'s "the write side must produce something the read side would accept");
    README updated for all three user-visible contract changes (the stamp shape, the `doctor
    --json` key list, and the new `list_libraries`/`get_docs` doctor-verdict surfacing) —
    code-reviewer S1.
  - **Filed as Linear follow-ups, not fixed here** (all explicitly non-blocking): a persisted
    verdict is keyed by bare library name with no URL/config scoping, so two projects with
    different configs for the same name share one verdict (security-architect's accepted
    fixed-vocabulary display closes the information-leak half of this; the correctness half —
    a same-named-different-library verdict misapplied — is not); `readDoctorVerdicts()` has no
    memoisation on what is now a per-call hot path; `doctor`'s own probes read their own
    just-persisted verdict, adding a small self-referential stamp cost to the very measurement
    that produced it; nothing prunes a verdict for a library removed from every registry (bounded
    by `MAX_DOCTOR_VERDICTS`, not actively pruned); `doctor.json` is read without an `lstat`
    regular-file gate first, a gap shared with `resolved-store.ts`'s own read path (parity, not a
    new regression, but a new HOT-PATH exposure); `search` responses do not carry the same
    doctor-verdict note `get_docs` does.
  Ref (round 1 fixes): `src/doctor-store.ts`, `src/doctor.ts`, `src/list-libraries.ts`,
  `src/get-docs.ts`, `src/retrieval.ts`, `src/cache-meta.ts`, `src/limits.ts`, `src/cli.ts`,
  `README.md`.

---

## D-80 — decided 2026-09-17, executing R-1 / PAR-829 (supersedes this entry's own prior text)

- **D-80** 2026-09-17, updated 2026-09-18 — **`package.json`'s `engines.node` is `^20.19.0 ||
  ^22.12.0 || >=24.0.0` — the INTERSECTION of `vite`'s and `vitest`'s own declared ranges, read
  directly from `node_modules/{vite,vitest}/package.json` rather than trusted from any prior
  record — not a plain floor approximating either, and not derived from `vite` alone (see the
  2026-09-18 update below: deriving from one dependency and ignoring the other is exactly the
  class of gap this decision exists to close, and it recurred one dependency over).**
  **What this entry originally recorded, and why that was wrong to leave standing:** this
  entry first recorded CI proving the floor's LOWER bound only, leaving `engines.node
  >=20.19.0` in place and noting (via two rounds of code-reviewer correction — see git history
  for that discussion, now superseded) that the field silently admitted Node 21.x and
  22.0.0–22.11.x, versions `vite`'s own range excludes. Tom's decision (2026-09-17): a field
  that states something false should be corrected, not documented around. A user on Node 21
  passed the old `engines` check and then hit a broken test toolchain — the gap was real, not
  merely theoretical, and the fix is one field, not a permanent caveat.
  **The fix, and what changed with it:** `engines.node` now matches `vite`'s range exactly.
  `package-lock.json` regenerated (`npm install --package-lock-only`; one line changed — the
  root package's own `engines` field — no dependency version drift). Every place the old floor
  was stated (`README.md`, `CLAUDE.md`, `CONTRIBUTING.md`) is corrected to the same range.
  **This is advisory, not enforced — stated plainly, not implied:** no `.npmrc` in this repo
  sets `engine-strict`, so `npm ci` on an excluded version (Node 21.x, 22.0.0–22.11.x) still
  only warns (`EBADENGINE`) rather than failing — unchanged by this fix, and true of the old
  floor too. The value of this change is that the field now STATES the true requirement;
  enforcement was never what D-75 or this entry claimed for it.
  **CI, and what is and is not tested (as of 2026-09-17 — SUPERSEDED, see the 2026-09-18 update
  below and its own round 4 finding B-1; a third matrix leg WAS later needed, once the range
  gained a third band):** the `test-matrix` job's two matrix legs at the time
  (`.github/workflows/ci.yml`) proved both ends of the two-band disjunction — `20.19.x` (the low
  end) and `22`, which resolves to the latest available, ≥22.12 (the high end). The excluded
  middle band (Node 21.x, 22.0.0–22.11.x) was deliberately NOT a CI leg: there is nothing
  SUPPORTED in that band to run the suite against, so a leg there could only ever prove "the
  toolchain the field says is unsupported does or does not happen to work today" — not a claim
  this project makes about any other unsupported version either. Documenting a version as
  unsupported and having tested it are different, weaker-vs-stronger claims; this entry does
  not conflate them — that reasoning still holds, unchanged; only the LEG COUNT needed to cover
  every actually-supported band changed, once there were three of them instead of two.
  **Verified locally first, on macOS, then MEASURED for real on PR #26's own CI run:** locally,
  `npm ci && npm run lint && npm test && npm run build` passed clean on Node v26.0.0 (default;
  satisfies `>=22.12.0`) and Node 20.20.2 (Homebrew's closest available build to `20.19.x`;
  satisfies `^20.19.0`) — but code-reviewer round 3 correctly flagged that claim as macOS-only:
  `@napi-rs/lzma-linux-x64-gnu@1.5.1`, an OPTIONAL `linux-x64`-only dependency of `rollup`
  declaring `engines.node: "^22.20 || ^24.12 || >=25"` (excludes ALL of `20.19.x`), cannot have
  been exercised on macOS at all, since npm never even considers an optional dependency whose
  `os`/`cpu` doesn't match the current platform. **Resolved by the actual CI run, not left as a
  guess:** on PR #26 (<https://github.com/BlackRaptorAI/VibeCTX/actions/runs/35300888578>,
  2026-09-18), `test-matrix (20.19.x)` (resolved to Node 20.19.6, the exact `ubuntu-latest`
  platform where that package could matter) ran `npm ci` with NO `EBADENGINE` and no mention of
  `napi-rs`/`lzma` anywhere in the job log at all — npm silently omitted the optional dependency
  rather than warning about its unmet engines. PASS, 1m12s, 45 files / 1627 tests, clean build.
  `test-matrix (22)` (resolved to Node 22.23.2) PASS likewise, same 45/1627 result. The required
  `test` gate job PASSED under the bare name `test`, confirming empirically — not just by
  analysis — that branch protection needed no settings change. This is the first run ever to
  exercise `20.19.x`; the local proxies above were never cited as a substitute for it.
  **Still open, unchanged by this entry:** `release-0.2.0` (unmerged) carries its own,
  independently-written Node-floor row in `CR-20260917-release-0.2.0.md` §5, written before
  this fix — it is now doubly stale (both "no CI leg at 20.19.x" and "engines is a plain
  floor" no longer hold on this branch) and must be reconciled against this branch's own CR row
  when `release-0.2.0` merges, not before; a `git merge-tree` check already confirmed a textual
  conflict between the two rows.
  Ref: `package.json`, `package-lock.json`, `.github/workflows/ci.yml`,
  `.vibectx-plan/change-records/CR-20260917-release-0.2.0.md`, `README.md`, `CLAUDE.md`,
  `CONTRIBUTING.md` (R-1 / PAR-829, commit `7907983`).

  **2026-09-18 update (PAR-830 fallout): `vitest` bumped to 4.1.11 — clearing two moderate
  advisories, unrelated to this item — and its own declared `engines.node` narrowed to
  `^20.0.0 || ^22.0.0 || >=24.0.0`, DIFFERENT from and narrower than `vite`'s
  `^20.19.0 || >=22.12.0` in the 22.x/23.x band. The 2026-09-17 fix above had derived
  `engines.node` from `vite` alone; it never looked at `vitest`'s own range at all.**
  **The diagnostic Tom asked for, before anything was changed:** run `npm test` after the
  merge+`npm ci` and check whether `test/engines.test.ts` — which asserted `ours === vite's
  engines.node` by STRING EQUALITY — still passed. It did. `vite` itself bumped to 8.3.0 in the
  same `npm install` but kept the identical `^20.19.0 || >=22.12.0` string, so the equality
  check had nothing to disagree with; it never once consulted `vitest`'s range, so it could not
  have caught `vitest` narrowing regardless of what `vite` did. **This is finding (b) from the
  item's own framing, not (a): the test was pinning a literal comparison, not enforcing an
  invariant** — it would keep passing forever against a `vitest` bump that moved its range
  anywhere, because nothing in it ever read `vitest`'s `package.json` at all.
  **The real gap this exposed — "the Node 23 hole":** a bare `>=22.12.0` (the 2026-09-17 value)
  admits Node 23.x. `vitest`'s new range does not: `^22.0.0` stops before 23.0.0, and the next
  band starts at `>=24.0.0` — nothing covers 23.x. Left uncorrected, `engines.node` would have
  silently re-admitted exactly the class of defect this whole item exists to close, one Node
  major over from the one it already fixed.
  **The fix:** `engines.node` is now the INTERSECTION of `vite`'s and `vitest`'s ranges —
  `^20.19.0 || ^22.12.0 || >=24.0.0` — computed and VERIFIED with `semver.subset()`
  (`semver@7.8.5`, added as a new devDependency; there was no existing semver-range library
  anywhere in the tree to reuse, and Tom's own instruction was explicit: approximating this by
  hand is the failure mode, not an acceptable shortcut — `semver.subset()` itself has a real
  boundary quirk around caret-expanded prerelease exclusions (`<23.0.0` vs the internally
  normalized `<23.0.0-0`) that was hit and worked around while deriving this, which is itself
  evidence FOR using the library rather than hand-rolling the same interval algebra worse).
  `test/engines.test.ts` was rewritten from a single string-equality assertion into three: `ours`
  is a `semver.subset()` of `vite`'s range, `ours` is a `semver.subset()` of `vitest`'s range,
  and — a non-vacuity check, D-24's own "an empty result is not a passing result" pattern
  applied here — Node `23.0.0` is confirmed to fail `semver.satisfies(v, ours)`, so the test
  cannot pass by accident against a range that silently reopened the hole. VERIFIED the new test
  actually discriminates, not just that it passes: reverted `engines.node` to the OLD
  `>=22.12.0` value locally and re-ran it — 2 of 3 assertions failed exactly as the subset/hole
  checks predict — then restored the fix. `package-lock.json` regenerated via `npm install
  --save-dev semver` and `npm install --package-lock-only`; `npm ci` afterward reinstalls clean
  from it. An unrelated cosmetic side effect of `npm install` rewriting `package.json` (the
  `description` field's em dash re-escaped from a literal character to `—`, and the
  file's trailing newline added) was reverted by hand so the diff carries only the intended
  two-line change (`engines.node`, the new `semver` devDependency) — neither is a semantic
  difference, but an unexplained unrelated diff line is exactly what CLAUDE.md's own
  diff-stat-by-eye rule (added this same day, PAR-831) exists to catch.
  **Verified on the merged tree:** `npm ci && npm run lint && npm test && npm run build` clean
  on Node v26.0.0 (this session's local machine — satisfies the range's `>=24.0.0` band, the
  one CI did NOT cover until round 4's B-1 fix below added a third leg) — 45 files, 1629 tests
  (was 1627: two new assertions in the rewritten `engines.test.ts`, later four — see round 4).
  CI's own matrix legs are the actual proof for each band, re-run after this push — see the
  round 4 review below for that result.
  D-number re-checked against `origin/main`, `release-0.2.0`, and (now merged) `par-831` after
  this merge: still only D-79 exists on any of them; D-80 stays D-80, no renumbering (per
  CLAUDE.md/PAR-831's own new rule — pick right before opening the PR, which this already was).
  Ref (2026-09-18 update): `package.json`, `package-lock.json`, `test/engines.test.ts`
  (rewritten), `.github/workflows/ci.yml`, `README.md`, `CONTRIBUTING.md`, `CLAUDE.md`
  (PAR-830 fallout, R-1 / PAR-829).

  **Round 3 review (code-reviewer — a fresh pass on the manifest fix; rounds 1/2 reviewed this
  entry's now-superseded prior text and are not repeated here), PASS with should-fixes, no
  blocking finding:**
  - Independently verified: `engines.node` matches `node_modules/vite/package.json` (v7.3.6)
    exactly; `npm ls vite --all` shows one resolved version; `package-lock.json` is
    byte-identical to a from-scratch `npm install --package-lock-only` re-run (no hand-edit, no
    drift); the "advisory, not enforced" claim MEASURED directly (a scratch package with an
    impossible `engines.node` warns and exits 0 under plain `npm ci`, and exits 1 only once
    `engine-strict=true` is added) rather than merely recalled; both matrix legs resolve inside
    the new range (`20.19.x` → 20.19.6, `22` → 22.23.2 at review time, both confirmed against
    `nodejs.org`'s and `actions/node-versions`' own version listings); `release-0.2.0`'s row is
    confirmed still open and still conflicting via `git merge-tree`.
  - **Should-fix, applied:** `D-3/PAR-778` in the CR row was a dangling reference (no such
    entry exists; the real one is `D-75`) — corrected. This entry's and the CR row's dates said
    2026-09-18; every commit carrying them is 2026-09-17 local time, and the file's own
    convention (D-78, D-79) dates by commit day — corrected to 2026-09-17. The "neither
    producing an EBADENGINE warning" claim (above) was gathered entirely on macOS and did not
    account for `@napi-rs/lzma-linux-x64-gnu@1.5.1` — an optional, `linux-x64`-only dependency
    of `rollup` whose own `engines.node` (`^22.20 || ^24.12 || >=25`) excludes ALL of `20.19.x`
    and cannot have been exercised outside `ubuntu-latest` — narrowed to say so explicitly
    rather than read as a platform-general claim. A drift guard was added
    (`test/engines.test.ts`): nothing previously would have caught a future `vite`/`vitest`
    bump moving its declared range out from under `engines.node` — the exact failure mode this
    item exists to fix, now closed permanently rather than once. Two imprecise "at the floor
    itself" claims (README, CONTRIBUTING) were corrected: `20.19.x` resolves to the latest
    20.19 patch, not the literal `20.19.0` minimum, so CI proves the 20.19 LINE, not the exact
    boundary value.
  - **Explicitly considered and rejected:** setting `engine-strict=true` to make the exclusion
    enforced, not merely documented. `@napi-rs/lzma-linux-x64-gnu`'s own range excludes ALL of
    `20.19.x` — turning on tree-wide strict enforcement to defend the 20.19 line would risk
    BREAKING install on the 20.19 line, via an optional native accelerator nobody is thinking
    about. Advisory is the correct choice here, not merely the current one, and this is why.
  Ref (round 3 fixes): `test/engines.test.ts` (new),
  `.vibectx-plan/change-records/CR-20260917-release-0.2.0.md`, `README.md`, `CONTRIBUTING.md`.

  **Round 4 review (code-reviewer — the 2026-09-18 PAR-830-fallout fix above), CONCERNS with
  one blocking finding, fixed before push:**
  - Independently re-verified, by an INDEPENDENT route rather than trusting `semver.subset()`:
    enumerated 20 boundary versions and compared membership in `engines.node` against a
    hand-computed `inVite(v) && inVitest(v)` predicate — zero mismatches. Confirmed
    `semver.subset()`'s argument order is order-sensitive and was not accidentally inverted
    (the flipped calls both correctly return `false`). Reproduced the "revert and re-run"
    regression check independently and got the same two failures. Confirmed the `package.json`
    diff against `origin/main` carries exactly the two claimed semantic changes and nothing
    else, and that `npm ci` reinstalls clean from the committed lockfile with 0 vulnerabilities.
    Swept the whole repo for stale `>=22.12.0` references and found none outside legitimate
    historical citations. Ran the full gate on Node v26.0.0: clean, 45 files / 1629 tests.
  - **B-1 (BLOCKING):** the range grew from two bands to three (`^20.19.0`, `^22.12.0`,
    `>=24.0.0`), but the CI matrix still had two legs (`20.19.x`, `22`) — and `22` is now the
    MIDDLE band's representative, not the high end. The unbounded top band, `>=24.0.0`, had NO
    CI leg at all — every "CI tests both ends" claim in `ci.yml`, `README.md`,
    `CONTRIBUTING.md`, `CLAUDE.md`, this entry (above) and the CR row was therefore false, the
    same class of defect this whole item exists to close. Pointedly: the reviewer's own gate
    run was on Node v26.0.0, which satisfies the range only via the untested `>=24.0.0` band —
    "verified locally on Node v26" was, without a third leg, verifying precisely the band CI
    did not cover. Fixed by adding the missing leg (`"24"`, resolves to the latest ≥24.0.0)
    rather than re-wording the coverage claim around the gap — CI now runs three legs, one per
    band, and every "tests X" claim across the repo is true again, not just less false.
  - **Should-fix, applied:** `test/engines.test.ts`'s module comment cited a nonexistent
    `D-81` — dropped (there is no D-81 anywhere in the repo; this entry stays D-80). Added a
    fourth test assertion (S-2): `semver.subset()` alone proves `engines.node` does not
    OVER-claim support, but says nothing about UNDER-claiming it — `">=24.0.0"` alone, or any
    other needlessly narrow range still fully inside both dependencies' bounds, would have
    passed all three prior assertions. The new assertion requires each band's low edge
    (`20.19.0`, `22.12.0`, `24.0.0`) to satisfy `engines.node`, MEASURED to actually fail
    against the over-narrow example above before the fix, and to pass after it. The CR row's
    correction (round 3's own addition) had landed in a trailing cell while the Evidence and
    Status cells two columns over still asserted the superseded `^20.19.0 || >=22.12.0` value
    in the present tense — rewritten as one coherent, non-contradictory row stating the current
    truth first, with the round-by-round history pointed at this entry instead of duplicated.
  Ref (round 4 fixes): `.github/workflows/ci.yml`, `test/engines.test.ts`,
  `.vibectx-plan/change-records/CR-20260917-release-0.2.0.md`, `README.md`, `CONTRIBUTING.md`,
  `CLAUDE.md`.

## D-81 — decided 2026-09-18, executing PAR-832 root cause B (clerk)

- **D-81** 2026-09-18 — `clerk`'s curated `urls` now try `https://clerk.com/docs/llms.txt`
  first, ahead of `https://clerk.com/llms-full.txt`. Investigated and MEASURED 2026-09-18, not
  taken from the filing issue's own claim: `llms-full.txt` is 768 bytes (curl/Node `fetch`
  agree) and is not a content index at all — it is a meta-index of OTHER `llms-full.txt` files
  (Documentation, Articles, Blog, Changelog, Glossary, Dashboard index). None of those six link
  titles overlaps either of clerk's own `probeQueries` ("middleware protect routes", "useUser
  hook"), so `rankLinks` scores every candidate 0 and index-following never starts — `doctor`
  reported clerk `matched 0, dropped {0,0,0}`, a distinct shape from a real link-index page that
  simply has some links refused (that shape follows > 0 and drops some).
  `docs/llms.txt` (520,419 bytes, MEASURED) is the real thing: an index of `.md`-suffixed doc
  pages whose titles include a direct hit for each probe (`useUser()`; "Protect content from
  unauthenticated users"). `getLibraryDoc` (`src/fetcher.ts`) tries `entry.urls` in order and
  commits to the first one that fetches successfully — a 200-OK meta-index still fetches
  successfully, so nothing in that loop would ever fall through to a better candidate on its
  own. The fix is the ORDER, not new code.
  **Explicitly rejected:** substituting `docs/llms-full.txt` (a real, complete content dump,
  unlike the meta-index) in `llms-full.txt`'s place. MEASURED 2026-09-18: 27,860,399 bytes —
  over `PRIMARY_DOC_MAX_BYTES` (25 MiB / 26,214,400 bytes) and would be refused outright.
  **Coverage check, this entry's own scope (bare-host `llms-full.txt` first candidates only —
  an entry whose first candidate carries a path, like `ai-sdk`'s or `supabase`'s, is out of this
  narrower scope even where it also 404s):** every one of the other 29 curated entries whose
  first candidate is a bare-host `llms-full.txt` was checked live (GET, real status + byte
  count, redirects followed, Node's own `fetch` — not just `curl`, to rule out a client-specific
  block; re-run twice, stable both times) for the same failure shape (a 200 response whose body
  is itself a tiny link-only meta-index). None were found. Two other, DIFFERENT and unrelated
  shapes turned up in the same sweep and are explicitly NOT this decision's scope: 12
  first-candidate URLs across the registry now 404 — among the bare-host `llms-full.txt` set,
  `nextjs.org` (a PAR-832 sibling — root cause A, not investigated here), `docs.stripe.com`,
  `react.dev`, `tailwindcss.com`, `ui.shadcn.com`, `firebase.google.com`, `playwright.dev`,
  `reactrouter.com`, `docs.astro.build`, `motion.dev` (also a PAR-832 sibling), plus two with a
  path (`ai-sdk.dev/docs`, `supabase.com/docs`) outside this scope — harmless today for every
  entry with a working fallback, because a 404 IS caught by the existing try-next-candidate
  fallback, unlike a 200-OK meta-index; and `docs.anthropic.com/llms-full.txt` redirects to a
  35,109,013-byte document, itself over `PRIMARY_DOC_MAX_BYTES`. Neither is this issue's failure
  shape and neither is fixed here — noted for whoever picks up the registry's other stale
  entries (including PAR-832's next.js/motion root causes), not actioned.
  **Verified live, on a FRESH cache:** `vibectx doctor --library clerk --json` against a fresh
  cache, real network, MEASURED 2026-09-18 — `url: "https://clerk.com/docs/llms.txt"`, both
  probes `index-followed` (5 followed / 0 dropped each, 10/0 total), `healthy: true`.
  **Known gap, not fixed here:** an install that already holds a FRESH cached copy of
  `llms-full.txt` (under the old order's 168 h default TTL) keeps being served it after this
  fix ships, because `getLibraryDoc`'s cache-first loop (`src/fetcher.ts`) also walks
  `entry.urls` in order and cache entries are keyed per-URL (`urlSlug`, `src/cache.ts`) — a
  fresh hit on `urls[1]` (the meta-index, post-fix) returns before `urls[0]` is ever tried.
  MEASURED by reproducing both states against the same warmed cache dir: pre-fix code / fresh
  cache → `llms-full.txt`, unhealthy (the PAR-832 symptom); fixed code / that SAME cache →
  still `llms-full.txt`, still unhealthy; fixed code / fresh cache → `docs/llms.txt`, healthy.
  Self-heals once the cached copy passes its TTL. `vibectx warm --force` does NOT clear it —
  `src/warm.ts` only forces retry of a recent RESOLUTION failure, never `forceRefresh` on the
  document itself (MEASURED: ran it against the poisoned cache, no change). What does work today:
  deleting that library's cache directory, waiting out the TTL, or the MCP `refresh` tool
  (`src/refresh.ts` calls `getLibraryDoc` with `forceRefresh: true`, skipping the cache loop
  entirely). The general defect — a curated `urls` reorder cannot invalidate a still-fresh cache
  keyed to the old winner — is not specific to clerk and will recur on every other PAR-832 root
  cause that turns out to need a reorder; filed as its own issue rather than fixed here.
  Ref: `src/registry.ts` (clerk's `urls`), `test/registry.test.ts` ("clerk's curated urls prefer
  the real index over the llms-full.txt meta-index (D-81/PAR-832)").

---

## D-82 — decided 2026-09-18, executing PAR-832a (Accept-header negotiation only)

- **D-82** 2026-09-18 — **A followed index link that comes back `text/html` is asked once for
  markdown via `Accept: text/markdown, text/plain;q=0.9, */*;q=0.1`; if it is STILL `text/html`,
  it is simply `unavailable` — no retry. Scoped to followed index links only; the
  primary-document fetch path is unchanged.**
  **What this entry originally proposed, and why it was cut down:** the first version of this
  fix ALSO retried a still-HTML response once more with a `.md`-suffixed url (closes
  ui.shadcn.com and nextjs.org's `/learn/*` tutorial pages, neither of which negotiates on
  `Accept`). Two independent reviews (code-reviewer, security-architect), run in parallel on
  that version, both found the SAME defect by different routes: the retry's loop-termination
  check — `url.endsWith(".md")` tested against the whole href — fails open for any followed
  link whose url carries a query string or a fragment. `withMdSuffix` correctly appends `.md`
  to the URL's PATH only (`new URL` parsing, `u.pathname += ".md"` — confirmed by both reviews
  to be incapable of a host/protocol escape), but `...guide?v=1` becomes `...guide.md?v=1`,
  which does not end in `.md` — so the SAME guard that was supposed to stop the recursion at
  one level lets it re-arm on the very URL it just produced, appending `.md` again forever
  (`guide.md.md?v=1`, `guide.md.md.md?v=1`, …), bounded only by the origin eventually answering
  a non-2xx to an absurdly long path. code-reviewer additionally confirmed such links are LIVE
  on the shipped registry today — 31 fragment-carrying same-host links in hono's own cached
  index alone — and that no existing test caught the bug: a candidate fix applied and reverted
  left the suite 1637/1637 either way, because every fixture used a bare-path URL. Tom's
  decision: ship the negotiation half now; the retry half defers to 0.2.1 with this bug as the
  stated reason, not merged behind a flag — dead code carrying a known unbounded-request defect
  is worse than no code. `withMdSuffix`, the retry guard, and the retry's own `fetchUrl` call
  were all REMOVED from `src/fetcher.ts`, not disabled.
  **What remains, and what it closes:** `FetchOptions` gained one field, `accept?: string`,
  read only when present. `getLibraryDoc` — `src/fetcher.ts`, the primary-document path, NOT
  `src/cache.ts` (an earlier draft of this entry named the wrong file) — never sets it, so
  primary-document fetches stay byte-for-byte unchanged; content negotiation there would risk
  changing what gets cached for a library that already works today, a far larger blast radius
  than this item's own scope. Verified, not merely asserted: a test pins that `getLibraryDoc`
  against an HTML response sends no `accept` header and performs exactly one request. MEASURED
  directly against the real sites (2026-09-18): hono.dev and motion.dev honour `Accept:
  text/markdown` on the same URL; nextjs.org's `/docs/` and `/blog/` pages do too; nextjs.org's
  `/learn/*` tutorial pages and ui.shadcn.com do not negotiate under any `Accept` value and stay
  `unavailable` — no vibectx defect on those two, a real gap in what those sites serve (or, for
  shadcn, a convention — the `.md`-suffix retry — that this item does not ship.
  **Security, corrected from this entry's earlier text (code-reviewer/security-architect,
  independently, on the version WITH the retry):** the original text framed the recursive
  call's own `isAllowedLink` re-check as "the retry is re-validated, not trusted because its
  parent was" — implying that check was THE control. Both reviews found this overclaimed:
  `isAllowedLink` (`src/link-policy.ts`) constrains only protocol, userinfo, host and port, all
  of which are structurally invariant under a pathname-only mutation (`new URL` parsing never
  touches them when only `.pathname` is set) — so on a `.md`-suffixed same-host URL, that
  re-check is a TAUTOLOGY once the original passed it, not a control that could ever refuse
  something the first check allowed. It was defence-in-depth, not the actual gate. The REAL
  control was `fetchUrl`'s own per-hop redirect guard (`hopAllowed`, `MAX_REDIRECT_HOPS`, the
  final-host `linkGuard` check) — confirmed by both reviews to be exercised identically on
  every request this feature issues, retried or not, since every request still goes through
  the one `fetchUrl` function. This correction is now moot for the shipped SCOPE of this item
  (no retry exists to re-validate), but is recorded here because the CLAIM was wrong regardless
  of whether the code it described shipped — a security property asserted in a decision record
  should be an accurate description of the mechanism, not of the intent.
  **Verified against the real sites, not just fixtures:** `vibectx doctor` on a fresh cache —
  next.js `healthy: true, followed: 1, dropped: 2` (the `/blog/...` link succeeds; the two
  `/learn/*` links remain unavailable, exactly as this item's own scope predicts); hono
  `healthy: true, followed: 9`; motion `healthy: true, followed: 10, dropped: 0`; shadcn
  `healthy: false, followed: 0, dropped: 5` — unchanged from before ANY PAR-832 work, exactly as
  expected, since it needs the deferred retry; clerk `healthy: true` — PAR-832's OTHER root
  cause, fixed by the separate D-81/PR #30, already on `main` before this branch last merged it.
  A full-registry `doctor --json` run: **28/30** — composition changed (clerk flipped healthy,
  shadcn flipped unhealthy relative to the CR-20260917 baseline) but the total count is
  unchanged from the version WITH the retry, because shadcn was the only one of the four root-A
  libraries that specifically needed the now-deferred half. tailwindcss remains its own
  pre-existing, unrelated gap.
  Ref: `src/fetcher.ts`, `test/fetcher.test.ts`, `test/debug.test.ts` (PAR-832a, PAR-832).
