# Change Record — v0.1.3 release bump (unblock trusted publishing)

**Date:** 2026-09-05 · **Tier:** 2 (touches `package.json` — gated as "supply chain: dependency & publish changes")

## 1. What changed

`package.json` version 0.1.2 → **0.1.3**, and `package-lock.json` brought into
sync via `npm version 0.1.3 --no-git-tag-version`. No source, no dependency, no
workflow change.

**Why this is needed, and why now.** PAR-516 (Urgent, target date 2026-07-30,
still open) completes npm trusted publishing: OIDC + `--provenance` in place of
the granular token used for 0.1.0–0.1.2. The final step is pushing a `v*` tag so
`publish.yml` runs. **That tag would have failed**: `package.json` on `main` said
0.1.2 and npm already has 0.1.2 published, so `npm publish` refuses the
overwrite — and it refuses at the *last* step, after the OIDC exchange and
provenance signing both succeed. That failure reads as "trusted publishing is
still broken" when it is not. This PR removes that trap ahead of the tag.

**Two incidental edits, disclosed because this is a gated file.** `npm version`
rewrote two things beyond the version number:

1. the `description` field's `—` escape became a literal em dash — same
   string, different encoding;
2. a trailing newline was added (the file previously ended without one).

Neither changes package behaviour. They are called out rather than left for a
reviewer to notice in a supply-chain-gated diff.

**One pre-existing defect fixed as a side effect.** `package-lock.json` carried
version **0.1.1** while `package.json` said 0.1.2 — the lock was never bumped for
the 0.1.2 release. `npm version` resynced both to 0.1.3. `npm ci` tolerated the
drift (verified, exit 0), so nothing was broken by it, but the lock now tells the
truth.

## 2. Gate decisions

| Gate | Agent | Applies? | Verdict | Decision |
|---|---|---|---|---|
| Security (supply chain) | security-architect | Yes — version-only bump on a gated file; no dependency added, removed or re-ranged; bundled tree unchanged (evidence in §3) | Not run — author analysis | PENDING |
| Review | code-reviewer | Yes — gated-config change | Not run — author analysis | PENDING |

Neither gate ran. Stated plainly rather than left blank: this repo's gate agents
were not invoked for a two-line version bump, and the evidence a gate would ask
for is in §3 instead. If that is not acceptable for a gated path, this PR should
not merge until they run.

## 3. Analysis

Verification run on the branch, all of it the exact sequence `publish.yml`
executes:

```
npm ci        exit 0
npm run lint  exit 0   (tsc --noEmit)
npm test      exit 0   (3 files, 17 tests)
npm run build exit 0   (tsc)
```

**The published artifact is unchanged in shape.** `npm pack --dry-run` on this
branch produces 3,398 files / 14,395,056 bytes unpacked. The already-published
0.1.2 reports `dist.fileCount = 3398` and `dist.unpackedSize = 14395056` —
identical. So the bump alters the version and nothing else about what ships.

The size is intentional and not a regression: `bundleDependencies` carries
`@modelcontextprotocol/sdk` and `zod`, which is what makes `npx -y
@blackraptorai/vibectx` work without a network dependency resolve. `files` is
`["dist"]`; the tarball contains LICENSE, README.md and 15 files under `dist/`
plus that bundled tree.

**Not addressed here, and still open:** 0.1.3 will only carry provenance if the
Trusted Publisher entry is saved *before* the tag is pushed. That entry must name
repository **`VibeCTX`** — the repo was renamed from `docs-cache-mcp` on
2026-07-18 and the OIDC `repository` claim follows the new name, so an entry
naming the old one will not match regardless of 2FA. See PAR-516.

If the tag is pushed before the entry is saved, 0.1.3 publishes without
provenance (or fails auth outright) and a 0.1.4 is needed. Order matters.

## 4. Human sign-off

PENDING — human owner to review and record ACCEPT / REWORK.

This PR deliberately stops short of the release: no tag is pushed and nothing is
published by merging it.
