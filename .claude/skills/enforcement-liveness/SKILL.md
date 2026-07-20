---
name: enforcement-liveness
description: >-
  Before certifying that a control, clamp, guard, or enforcement is "closed" or
  "enforced at" some point, prove the enforcing code actually runs on the live
  path. Use when a gate agent is about to certify an enforcement/clamp/guard, or
  a reviewer is verifying a control exists. Triggers: "closed at dispatch",
  "enforced at", "the clamp handles it", "gap closed", "is this control
  actually applied". Shared by security-architect, qa-test-engineer,
  code-reviewer, operational-readiness.
---

# Enforcement liveness — prove the control executes

The presence of a control in a file is **not** evidence that it runs. The most
expensive review miss is certifying an enforcement on a code path that never
executes — the control is decorative, and everyone downstream trusts it.

## The required check (do this before writing "closed" / "enforced" / PASS)

1. **Identify the enforcing function** (the clamp/guard/validator/permission
   check) and the exact point you are certifying it protects.
2. **Grep its callers.** `grep -rn "<functionName>"` across source. List who
   calls it.
3. **Confirm a live, reachable caller** invokes it on the path you are
   certifying. "Live" means: reached in production execution — not a test file,
   not an uninstantiated class, not a compiled/type-declaration artifact, not
   dead code behind a flag that's always off.
4. **Trace the actual path.** If you're certifying "enforced at dispatch," find
   the dispatcher that actually runs in prod and confirm *it* calls the control.
   Two functions that look alike (a real one and a dead twin) are a trap.
5. **If the only callers are dead**, the control is decorative. Verdict is
   **BLOCK / CONCERNS / NEEDS WORK**, never PASS. Say which live path is
   missing the call.

For `qa-test-engineer`: the corresponding test discipline is to **exercise the
control through its live caller**, not the control in isolation. A green unit
test on a function nothing calls proves nothing about enforcement.

For `code-reviewer`: **flag unreferenced/dead enforcement code** — a service or
guard with no production callers is a latent defect and a false sense of safety.

## Concrete example this prevents

A mandatory guard was certified "gap closed at dispatch." The clamp lived in a
`shouldAllow`-style function. But that function's only caller was a service
class that is **dead code** — never instantiated in production source; only test
files construct it. The live dispatcher on the certified path never called the
clamp at all. The guarantee was certified on a path that does not execute. One
`grep` for the callers of the enforcing function would have caught it.

## Rule

Every "closed / enforced / handled" claim about a control carries, implicitly,
the sentence: *"and I confirmed a live caller invokes it."* If you can't say
that sentence truthfully, you can't write the verdict.
