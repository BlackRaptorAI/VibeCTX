# Contributing to VibeCTX

VibeCTX is a local MCP (Model Context Protocol) server: it fetches official library
documentation (llms.txt-first), caches it to disk, and serves the relevant sections to coding
agents — offline, deterministically, at no recurring cost.

If you are evaluating the project or about to change it, read this page and then
[`.vibectx-plan/README.md`](.vibectx-plan/README.md), which is the index to the project record.

## Before you write code: what VibeCTX is, and is not

**VibeCTX is a documentation cache and stays one.** It will not grow memory of past
conversations, spec or plan writing, architecture-rule checking, code symbol search, or task
tracking. Each of those has a strong incumbent, and the last was measured to make results worse.
The full statement — the five problems in scope, the non-goals, and the claims the product may
not make — is in
[`.vibectx-plan/VibeCTX-scope-decision-2026-09-08.md`](.vibectx-plan/VibeCTX-scope-decision-2026-09-08.md).

A pull request that adds capability outside that boundary will be declined on scope, however good
the code is. Open an issue first and make the scope case.

### Four design principles

- **Zero-config.** Clone, install, build — then it works, with 30 libraries built in. No database,
  no API key, no config file required.
- **Deterministic by default.** No embeddings and no network calls at query time. Retrieval is
  markdown heading-split plus BM25 over a camelCase-aware, lightly stemmed tokenizer. The same
  query returns the same answer every run.
- **Offline-first.** A cached corpus answers with the network unplugged.
- **Honest defaults.** A stale cache is served *flagged* `STALE:`, never silently. When VibeCTX
  has nothing on a topic it says so rather than returning something adjacent.

## Setup

```bash
git clone https://github.com/BlackRaptorAI/VibeCTX.git
cd VibeCTX
npm ci
npm run build
```

**Do not `npm install @blackraptorai/vibectx`.** The 0.1.2 package published to npm in July 2026
is still tagged `latest`, is stale, and predates a hotfix that closed a redirect-escape SSRF, a
ReDoS link regex and unbounded response bodies. The npm account is no longer accessible, so it
cannot be deprecated or superseded. **This repository is the only current source.**

### Node versions

`package.json` declares `engines: >=18`, which covers building and running the server. **Running
the test suite needs Node ≥ 20.19** — `vitest`'s `vite` dependency declares
`^20.19.0 || >=22.12.0`, so on Node 18 a fresh clone installs and then `npm test` will not run.
CI builds and tests on **Node 22**, which is the version this is actually proven on.

That mismatch between the declared floor and the testable floor is a known open item, not a
surprise to report.

## Build, test, lint

```bash
npm run build   # tsc → dist/
npm test        # vitest run  (needs Node >= 20.19)
npm run lint    # tsc --noEmit
npm run dev     # tsc --watch
```

**The suite must be fully green with no skips.** Deliberately not stated here: how many tests
there are. Every hand-copied restatement of that number in this project has eventually gone stale,
so measure it — `npm test` prints it — rather than reading it from a document.

CI runs two workflows: `ci.yml` (build, lint, test) and `doctor.yml` (a weekly retrieval health
check). **No CI check gates on a Change Record**; see below.

## Testing conventions

- **No assertion may compare two wall-clock measurements.** A ratio between two timed runs is the
  most flake-prone shape there is, and it has bitten this repository. Print a `[MEASURED]` line
  and assert an **absolute** ceiling instead — the number is the record, the threshold is not.
- **Prefer measuring behaviour over mocking it.** Spy on real call counts (index reads, fetches)
  rather than asserting on elapsed time.
- **A test that passes on day one against unchanged code tests nothing.** If you add an assertion,
  confirm it fails against the code as it is now.
- Cache, config and index files are **trust boundaries**. Anything read back from disk is
  re-validated field by field; a corrupt file degrades the caller, it never throws out of it.

## The project record

`.vibectx-plan/` is tracked in this repository. It is not product — nothing in `src/` imports it,
and `package.json` ships only `dist/` — but it is where the reasoning lives:

| Path | What it is |
|---|---|
| [`.vibectx-plan/DECISIONS.md`](.vibectx-plan/DECISIONS.md) | **The decision register.** Every `D-nn` referenced in a code comment, issue or Change Record resolves here. Read it before arguing with a design choice — most have already been argued. |
| [`.vibectx-plan/change-records/`](.vibectx-plan/change-records/) | Change Records with their gate verdicts and conditions. |
| [`.vibectx-plan/VibeCTX-audit-2026-09-08.md`](.vibectx-plan/VibeCTX-audit-2026-09-08.md) | The code audit the current release remediates, with file:line evidence. |
| [`.vibectx-plan/VibeCTX-scope-decision-2026-09-08.md`](.vibectx-plan/VibeCTX-scope-decision-2026-09-08.md) | Scope, non-goals, and the claim discipline below. |
| [`.vibectx-plan/README.md`](.vibectx-plan/README.md) | Index to all of the above, including which documents are retired. |

Several documents in there carry **retirement banners**. Those describe a CI gate, a `GATED` path
array and a verdict validator that were removed from this repository and from its history on
2026-09-08. They are kept so past reasoning stays readable. **Do not cite a retired document as
authority** — each one names its live replacement in its own banner.

Five files referenced by the index are deliberately *not* in the repository: two internal strategy
documents removed from history, and three local scratch files. You are not missing anything you
need.

## Change Records

A Change Record is a short document recording what a change did, what could go wrong, and which
review gates signed off. **No CI check enforces one** — the workflow that used to was removed.

One is expected for:

- a **tagged release**, and
- any change touching **URL trust, fetching, or cache integrity**.

Write it into `.vibectx-plan/change-records/` using
[`.vibectx-plan/change-record-template.md`](.vibectx-plan/change-record-template.md) — that is the
live template. `change-record-template.RETIRED-pre-2.0.0.md` is the old shape and will fail
validation.

For an outside contribution, describing the same content in the pull request body is fine. Say
what you changed, what you measured, and what you could not rule out.

## Claim discipline — binding on all text, not just marketing

This applies to README changes, code comments, issues and Change Records alike.

**No text in this project may say VibeCTX keeps an agent on task, prevents scope creep, prevents
architectural drift, or stops hallucination in general.** It prevents one evidenced kind of
hallucination — invented package names — and removes one cause of stale-context work: wrong-version
documentation. Nothing wider.

Three specific claims are barred outright because they do not survive checking: that AI makes
developers 19% slower (the authors' own revision puts it near −4%, with a confidence interval
crossing zero); that AI degrades software architecture over time (the only causal study found no
degradation); and anything attributed to "a 2026 Stack Overflow Developer Survey" (no such survey
exists).

If you cite a number, cite where it came from and prefer a primary source. "Measured" means you
ran something and can say what.

## Pull requests

- **One concern per pull request.** A refactor and a behaviour change in the same diff cannot be
  reviewed as either.
- **A pure refactor must not change behaviour.** If the suite needed edits to go green, that is a
  defect in the refactor, not an improvement to the tests.
- Say what you **measured**, not what you expect. Include the command and its output.
- Changes to `.github/` or `package.json` — raise an issue first; they affect how everyone builds.
- Note anything you could not verify. An honest "not tested" is worth more than a confident guess,
  and this project's review culture treats an unverified claim as the defect.

## Reporting a problem

Open an issue at <https://github.com/BlackRaptorAI/VibeCTX/issues>. Useful reports include: the
library name, the URL VibeCTX resolved, your Node version, and what you expected instead. If
retrieval returned the wrong section, paste the query and the heading path it returned — that is
usually enough to reproduce.

Private-documentation, air-gapped and enterprise deployment needs are worth raising too; real
setups shape what gets built.

## License

MIT © 2026 Tom Hanks / BlackRaptor AI. By contributing you agree your contribution is licensed
under the same terms.
