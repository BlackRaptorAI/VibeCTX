---
description: Run an adversarial pre-pentest review on a target surface — threat model, OWASP/abuse-case review, proof-of-vulnerability tests, readiness report
---

Run a red-team review of: $ARGUMENTS
(If no target given, ask me to scope one — e.g. "auth", "sessions", "the whole platform pre-launch".)

Use the red-team-reviewer subagent. It must:

1. Threat-model the target: enumerate trust boundaries and, per boundary, attacker goals (forge/replay creds, tenant escape, cross-account resource access, data/secret exfiltration, privilege escalation, injection incl. prompt injection, remote-execution abuse).
2. Enumerate abuse cases and review for vulnerability classes (OWASP web + LLM Top 10, authz bypass, IDOR/tenant-scoping, injection, SSRF, weak crypto, secrets exposure, missing rate limits). Cite file:line for every finding.
3. For credible findings, specify a failing proof-of-vulnerability test against your own code in the test environment (never against live/production or any third party). Hand the test to qa-test-engineer to implement and run; do not write the fix.
4. Produce a ranked findings list (P0–P3) with evidence + proof-test specs, and a pentest-readiness report with a coverage map.

Hard limits (enforced): defensive review of YOUR code only; no weaponized exploits or attack tooling; no live/production or third-party targets; this pass COMPLEMENTS, never replaces, an independent human penetration test — say so in the report.

Stop and show me the ranked findings + readiness report. I decide what to file and fix (through the normal governed workflow) and when to engage the human pentest firm.
