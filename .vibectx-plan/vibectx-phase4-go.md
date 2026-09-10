> # RETIRED — DO NOT EXECUTE. 2026-09-10.
> **The VibeCTX build loop is retired.** This is a dispatch card for a process that is no longer in
> use. Do not start a build session from it, do not follow its stop conditions, do not bundle against
> it. Kept as a historical record of how items A1–A6 and A10 were built.
> **Current state lives in git and Linear, not here:** `main` @ `839bfd7`, 1202 tests across 36 files,
> CI green on Node 22, 7 of 16 items landed. Open work is tracked in Linear under PAR-515.

# VibeCTX — Phase 4 go card · A3 (PAR-716) and A6 (PAR-719)

**Authored by the oversight seat, 2026-09-09, after Phase 3 closed at `main` @ `c50faf0`.**
Prerequisite: **`c50faf0`**. Baseline: **1136 passing across 34 files.**

---

## 0. Stop conditions — check these first

- `git rev-parse --short HEAD` on a clean `main` is **`c50faf0`**. If it is not, stop and report.
- `npx vitest run` on a clean tree is **1136 / 34**. Any deviation is a stop-and-report condition,
  not noise. It is not yours to diagnose.
- If either check fails, **report and stop.** Do not build on an unknown baseline.

---

## 1. Role and hard rules

You are a build session. You produce; the gates judge; Tom lands.

- **One item at a time.** A3 completely, report through Tom, then A6. Sessions never talk to each
  other.
- **No session pushes.** Bundle to `../vibectx-handoff-bundles/` (D-54). Tom lands every commit.
- **Never pipe a gate run through `tail`/`head`/`grep` before its result is known** (D-55).
- **An unmet done-when is reported unmet** (plan rule 4). Never restated to match what was built.
  PAR-658 is the precedent and is still open for exactly this reason.

---

## 2. Rules carried from A10, A1, A2, A4 and A5 — these were paid for, do not rediscover them

**2.1 Do not widen a threshold against escalating load.** If a bound fails under more load, the
finding is the bound, not the test.

**2.2 Scope every gate dispatch.** Hand the gate the diff and the specific conditions to verify, and
carry the previous round's verdict so it reviews the delta rather than re-deriving everything.

**2.3 NEVER AUTHOR a verdict, and NEVER set `BR_VERDICT_HOOK=off`.** Pasting a verdict a gate
actually returned is *required* — see §8. What is forbidden is **composing one yourself**: for a gate
that did not run, or to satisfy a Stop hook demanding a verdict the run never produced. Test: **did a
gate dispatch return this text?** If no, it must not appear. If the Stop hook wedges — it can demand
a verdict from a producer that cannot honestly give one — **start a fresh session.** A1, A4 and A5
all did this correctly. Follow them.

**2.4 Seat names, 2.1.0.** `backend-engineer`, `qa-test-engineer` and `data-engineer` are
**PRODUCERS with edit tools**. The gates are `code-reviewer`, `test-auditor`, `schema-reviewer`,
`security-architect`, `completion-auditor`. **Both of this phase's issues name `qa-test-engineer` as
a gate. Both are wrong** — see §6. A5 hit the identical error and routed correctly; do the same.

**2.5 Strip AI-attribution trailers before bundling.** Remove `Co-Authored-By: Claude …` and
`Claude-Session: …` from every commit **before** the bundle and before any gate reviews it. Held on
A4 and A5; keep it at two for two.

**2.6 A containment argument must be recorded with its falsifier.** If you close N cases by arguing
they converge on one code path, name the condition that would break the argument and **check it**.
Gate 3 closed this way and the falsifier fired — `cache-evict.ts` reads `.meta.json` by its own path
(PAR-741). The check is what turned an assumption into a finding.

**2.7 NEW — a "while you're here" clause is done-when, not a footnote.** A5 silently dropped one
(PAR-740) because it sat under *Dependencies*, where neither the gates nor oversight look. **This
card lifts every such clause into §5's done-when lists.** Treat them as gating.

---

## 3. Reading order — all in `.vibectx-plan/`

1. `vibectx-build-loop-resume.md` — **§9 first, newest entries backwards.** State, decisions, and
   the record of what has already gone wrong.
2. `VibeCTX-020-phased-build-plan.md` — **§Phase 4 and Gate 4.**
3. `VibeCTX-audit-2026-09-08.md` — **§4.3 (A3) and §4.6 (A6)**, the evidence.
4. `VibeCTX-plan-revision-2026-09-08.md` — **§A3 and §A6.**
5. `src/search-index.ts:496-507` before touching A3 — the R2 fix `refresh` never received, with its
   own measured cost.

---

## 4. What oversight measured before writing this card

**Do not re-derive these. Do verify them if you doubt them.** Measured at `c50faf0`:

| Plan says | Actually at `c50faf0` |
|---|---|
| `test/retrieval.test.ts:768` pins the overshoot | **`:825`** — line drifted, assertion is present and unchanged |
| `get-docs.ts:272` is the render site | **`:280`** (sections) — and there are **three** render sites, not one: `:280`, `:263` (snippets), **`:158` (no-topic)** |
| `retrieval.ts:306-317` sums `chunk.length` | **`:312` / `:314`** (sections), **`:524` / `:526`** (snippets) |
| `src/limits.ts` for the refresh cap | Exists, 1,393 bytes |
| `refresh.ts:29` / `:55` index thrash | Confirmed: `invalidateIndex` at `:29`, `indexCachedDocument` at `:55`, both in the loop |
| A3 "folds in: refresh should drop followed-page cache" | **`refresh.ts` contains no `followed` handling at all.** This is new work, not a modification — see §5 |

---

## 5. The work

### A3 (PAR-716) first — one index session, and a rate limit

Two halves, both real. `refresh` iterating 30 entries does roughly **90 parses and 60
serialisations** of a 16.9 MB `index.json`. `warm.ts:308` and `autowarm.ts:103` already open **one**
`IndexSession` for a whole run; `refresh` never received that fix. Separately,
`refreshToolText(registry)` is model-callable with **no cap at all**, against the resolver's
`MAX_RESOLUTIONS_PER_HOUR = 100`.

**Done when — all five, and the last two are lifted out of the issue's *Dependencies* per rule 2.7:**

1. A 30-library `refresh` performs **exactly one** `readIndex` and **exactly one** `writeIndex`,
   **asserted by spy count, never by timing.**
2. A `[MEASURED]` line prints before/after on the probe corpus. **The number is the record, not the
   threshold** (D-37).
3. A second full refresh inside the cap window is **refused with a stated reason** — the reason is
   part of the criterion, not decoration.
4. **The followed-page cache drop.** `refresh` has no `followed` handling today, so this is new
   behaviour, not an edit. **If it cannot be specified crisply, report it unmet and say why** — do
   not invent a semantics for it. An unmet done-when reported honestly is a pass for the process.
5. **The rate-limit mechanism is shaped to be shared.** A queued item ("reserved interactive share of
   the 100/h resolution budget") is the same class of per-process limit. Whichever lands first sets
   the shape. **You are first — so leave a mechanism the second item can adopt, and say in the commit
   what shape you chose and why.**

### A6 (PAR-719) second — price the separators and the header block

`search.ts:308-331` prices `BLOCK_JOIN` and `SECTION_JOIN` exactly, under a comment reading *"a
budget that ignores its own separators is not a budget."* **`get_docs` is the module that ignores
them.** Same defect class as A2, one module over.

**A6 BLOCKS A17 in Phase 6.** The provenance stamp adds header text to every response; the budget
must count its own header before more header is added.

**Done when:**

1. The **D-39 invariant** — rendered response no larger than `maxTokens × 4` — holds across **all
   three render paths** (see the finding below), including a **maximum-size note block**: five
   followed URLs plus three skip lines.
2. The **D-43 ordering survives**: at any budget, the answer outranks the accounting.
3. **`test/retrieval.test.ts:825` is AMENDED, not deleted**, and becomes the assertion that the
   overshoot is gone. It currently reads
   `expect(out.length).toBeLessThanOrEqual(budget + 2 * (chosen.length - 1))` — **a shipped test
   pinning the wrong behaviour.** Deleting it destroys the evidence that it was wrong.
4. **`test-auditor` returns PASS.** Gate 4 names this specifically because a shipped test pins the
   defect; that is the exact failure class this gate exists for.

> ### OVERSIGHT FINDING — read before starting A6. PAR-719 undercounts the defect.
>
> The issue and Gate 4 both say the invariant must hold **"in both modes."** `GetDocsMode` is
> `"sections" | "snippets"` — but there is a **third render path** the issue never mentions: the
> **no-topic table-of-contents branch** at `get-docs.ts:150-158`.
>
> It is the **worst offender of the three.** It computes
> `const head = doc.content.slice(0, budget * 4)` — which alone consumes the **entire** `maxTokens ×
> 4` allowance — and *then* prepends the stale-note prefix, the `Source:` line, and a table of
> contents of **up to 60 heading lines**. Every one of those characters is pure overshoot. Where the
> separator defect costs 9 characters per gap, this can cost **kilobytes**.
>
> **Gate 4's "both modes" wording is therefore amended to "all three render paths" — amended BEFORE
> the item is built, not after.** Gates 1 and 3 were both amended after the fact; this is the first
> time the plan is corrected in front of the work, which is where a correction belongs.
>
> **Verify this yourself before acting on it.** Oversight has been wrong twice this week by
> publishing a reading before checking a primary source. If your reading of `:150-158` differs from
> the above, **your reading wins and oversight's finding is the thing to correct.**

---

## 6. Gate routing — 2.1.0 names, corrected

| Item | Gates |
|---|---|
| **A3** | `code-reviewer`, `test-auditor` |
| **A6** | `test-auditor` (**named first deliberately** — the shipped test pins the defect), `code-reviewer` |

**Both issues say `qa-test-engineer`. That seat is a PRODUCER, not a gate** (rule 2.4). Route to
`test-auditor` and **say so in your report** so the correction is recorded rather than silent — A5
made the right call here but framed it as following an instruction, which left the authority
ambiguous. **This card is the authority.**

**No Change Record for either item.** The gated paths are `src/fetcher.ts` and `src/link-policy.ts`
only; neither item touches them. Confirm with `git diff --name-only` before bundling rather than
trusting this line.

---

## 7. Gate 4 — the criteria you are building to

- [ ] 30-library `refresh`: **exactly one** `readIndex`, **exactly one** `writeIndex` — spy count,
      never timing
- [ ] `[MEASURED]` before/after line printed and pasted into the phase record
- [ ] A second full refresh inside the cap window is refused **with a stated reason**
- [ ] The budget invariant holds for `get_docs` across **all three render paths** (§5 finding),
      including a maximum-size note block
- [ ] D-43 ordering survives — at any budget the answer outranks the accounting
- [ ] `test/retrieval.test.ts:825` **amended, not deleted**, now asserting the overshoot is gone
- [ ] `test-auditor` verdict is **PASS**
- [ ] Gates 0–3 re-run green, count recorded

**Rollback trigger:** if pricing the note block makes small-budget responses unusable, **cap the note
block rather than exempting it. An exempt header is how this defect started.**

---

## 8. When you are done

Bundle each item separately. Report through Tom with:

- branch and final SHA
- the per-commit `--name-status` scope check
- the full suite count
- **each gate's verdict pasted verbatim, not summarised**
- every done-when marked **met or unmet** — including A3's item 4, which may honestly be unmet
- the `[MEASURED]` lines in full

**Paste the output, do not describe it.** Phase 1's chat summary contained a false statement about
its own diff while the gate log was accurate.

**Expect the Stop hook to wedge.** It has on four of five items (A10, A1, A4, A5). When it does:
stop, hold, report. **Do not fabricate a verdict and do not disable the check.** A wedge costs a
fresh session; a fabricated verdict costs the provenance of every gate in the project.

**Do not start Phase 5. Do not pick up another item.**
