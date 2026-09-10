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

**Numbering continues at D-68.**

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
| **D-50** | Documentation is served for the version the project's manifest pins where a versioned document exists, and the fallback to latest is always stated, never silent. | A11 / PAR-724 |
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
- **D-60** 2026-09-10 — **A3 (PAR-716) and A4 (PAR-717) owe Change Records.** Both changed cache
  integrity, which the live rule names directly; A3 additionally added a filesystem-delete
  primitive. They were originally cleared with "no gated path touched," which reasons from a control
  that has not existed since `a0852f2`. **Outstanding Change Records: 11 → 13.** A5 and A6 touched
  neither cache, URL trust, nor fetching — their clearance stands despite the same faulty
  justification. | PAR-753 |
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
