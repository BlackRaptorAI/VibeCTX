---
name: expand-contract-migration
description: >-
  How to change a database schema safely when merge deploys to production and
  features ship across multiple PRs. Use for any schema/migration change, or when
  planning a rename/drop/type change on a live table. Triggers: "migrate this
  schema", "rename a column", "add a NOT NULL", "expand/contract". Shared by
  data-engineer and principal-architect (planning).
---

# Expand / contract migrations

If merge = production deploy and a feature spans several PRs, a schema change
must never leave the main branch in a state where deployed code and the database
disagree. The rule: **expand first, migrate data, switch code, contract last —
each a separate deploy.**

## The four phases (each its own PR/deploy)

1. **Expand (additive only).** Add the new column/table — nullable or with a
   default. No existing code reads it yet. Safe to deploy alone; nothing breaks.
2. **Backfill.** Populate the new shape from the old (batched, idempotent, no
   long locks). Verify.
3. **Switch code.** Point reads/writes at the new shape, behind a flag if the
   behavior is user-visible. Old column still exists as a safety net.
4. **Contract (destructive) — last, and only when nothing references the old
   shape.** Drop/rename the old column, tighten to NOT NULL, remove the flag.

## Hard rules
- **Never combine a destructive migration with the code that depends on it in
  one PR.** A half-applied slice (migration ran, code not yet live, or vice
  versa) must still work.
- Renames are expand+contract, not an in-place alias shortcut across a deploy
  boundary — add new, backfill, switch, drop old.
- Migrations are reversible and tested up *and* down; check lock/scale impact at
  volume before merging.
- Never silently drop or mutate historical records that serve as audit or
  regulatory evidence.

## Example — rename `created` → `created_at`
1. Add `created_at` (nullable). Deploy.
2. Backfill it from the old column. Verify counts match.
3. Switch all reads/writes to the new name. Deploy.
4. Once no code references the old column, drop it. Deploy.

(Combining these into one PR — shipping code that reads `created_at` before the
column exists and is backfilled, or dropping `created` while code still reads
it — is exactly how live checks silently break. Mismatched field names across a
deploy boundary are a classic, avoidable outage.)
