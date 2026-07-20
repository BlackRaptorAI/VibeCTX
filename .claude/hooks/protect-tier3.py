#!/usr/bin/env python3
"""PreToolUse hook: block modifications to Tier-3 protected paths.

Fail-closed enforcement of the Tier-3 boundary for ALL Claude Code sessions
and subagents in this repo. Prompts instruct agents not to touch these paths;
this hook makes them unable to.

Coverage:
  - Edit/Write/MultiEdit/NotebookEdit: blocked on protected paths. Paths are
    matched case-insensitively (macOS/Windows default filesystems are
    case-insensitive) and with symlinks resolved (realpath).
  - Bash: heuristic — blocked when the command references a protected path AND
    contains a write-shaped operation (redirect, sed -i, tee, mv, cp, rm, git
    checkout/restore/apply, patch, chmod, dd, truncate). Reads (cat/grep/ls)
    pass. This catches accidents, not determined adversaries.
  - Malformed input or a missing file path on an edit tool: BLOCKED (fail
    closed). If a Claude Code update changes the hook payload shape, edits to
    anything will be blocked until this hook is updated — that is deliberate.
  - The guard guards itself: .claude/settings.json and .claude/hooks/ are on
    the protected list.

Boundary of record: this hook is IN-SESSION accident-prevention and is
bypassable by construction (especially the Bash heuristic). The enforcement of
record for Tier 3 is SERVER-SIDE — branch protection + CODEOWNERS + the
change-record-required CI check. Do not rely on this hook as the only control.

Contract (Claude Code hooks):
  stdin  = JSON: { tool_name, tool_input: {...}, cwd, ... }
  exit 0 = allow · exit 2 = block; stderr is fed back to Claude as the reason

Intentional Tier-3 work: run with  ALLOW_TIER3=1 claude
Blocked attempts and overrides are logged to .claude/hooks/tier3-attempts.log.
"""
import json
import os
import re
import sys
from datetime import datetime, timezone

# VibeCTX Tier-3 paths. Keep this list in sync with the GATED list in
# .github/workflows/change-record-required.yml (and CODEOWNERS if/when a
# second-key team exists). The first two prefixes + settings.json protect the
# enforcement mechanism itself — keep them.
# NOTE: VibeCTX's genuinely security-sensitive source — the docs fetcher
# (SSRF / untrusted-content parsing, src/fetcher.ts) and the cache writer
# (path handling, src/cache.ts) — is deliberately NOT hard-gated here so
# everyday coding stays friction-free; treat those two as security-review-
# sensitive by convention (route non-trivial changes past security-architect).
TIER3_PREFIXES = [
    ".github/",
    ".claude/hooks/",
]
TIER3_FILES = [
    ".claude/settings.json",
    "package.json",             # supply chain: dependency & publish changes are deliberate
]
REPO_MARKER = ""  # set at runtime from the project directory name (see main)
WRITE_CMD = re.compile(
    r"(>>?|\bsed\b[^|;&]*\s-i|\btee\b|\bmv\b|\bcp\b|\brm\b|\btouch\b"
    r"|\bgit\s+(apply|checkout|restore)\b|\bpatch\b|\bchmod\b|\bdd\b|\btruncate\b)"
)

# Lowercased views for case-insensitive matching. macOS and Windows default
# filesystems are case-insensitive, so a case variant (e.g. .GitHub/) must not
# slip past the guard. Recomputed from the lists above.
_TIER3_FILES_LC = {f.lower() for f in TIER3_FILES}
_TIER3_PREFIXES_LC = tuple(p.lower() for p in TIER3_PREFIXES)


def match(rel: str) -> bool:
    r = rel.lower()  # case-insensitive; see _TIER3_*_LC above
    if r in _TIER3_FILES_LC or r.startswith(_TIER3_PREFIXES_LC):
        return True
    marker = REPO_MARKER.lower()
    if marker and marker in r:  # session rooted above the repo
        sub = r.split(marker, 1)[1]
        return sub in _TIER3_FILES_LC or sub.startswith(_TIER3_PREFIXES_LC)
    return False


def log(project_dir: str, entry: dict) -> None:
    try:
        entry["ts"] = datetime.now(timezone.utc).isoformat()
        path = os.path.join(project_dir, ".claude", "hooks", "tier3-attempts.log")
        with open(path, "a") as f:
            f.write(json.dumps(entry) + "\n")
    except Exception:
        pass


def block(msg: str) -> int:
    sys.stderr.write(
        msg + "\n"
        "If this change is part of an approved Tier-3 slice: stop, tell the human to re-run "
        "the session with ALLOW_TIER3=1 (the override is logged), and note that the "
        "change requires a Change Record and second-person approval on the PR.\n"
        "Otherwise: propose the change as a diff in your response instead of applying it.\n"
    )
    return 2


def main() -> int:
    allow = os.environ.get("ALLOW_TIER3") == "1"
    try:
        payload = json.load(sys.stdin)
    except Exception:
        return 0 if allow else block(
            "BLOCKED (fail-closed): hook received malformed input and cannot verify the "
            "target path. This may mean a Claude Code update changed the hook payload — "
            "the human should check .claude/hooks/protect-tier3.py against current docs."
        )

    tool = payload.get("tool_name", "")
    tool_input = payload.get("tool_input") or {}
    project_dir = os.environ.get("CLAUDE_PROJECT_DIR") or payload.get("cwd") or os.getcwd()
    session = payload.get("session_id", "")
    global REPO_MARKER
    REPO_MARKER = os.path.basename(os.path.realpath(project_dir)) + "/"

    if tool == "Bash":
        cmd = tool_input.get("command") or ""
        refs = [p for p in TIER3_FILES + TIER3_PREFIXES if p in cmd]
        if refs and WRITE_CMD.search(cmd):
            action = "OVERRIDE-ALLOWED" if allow else "BLOCKED"
            log(project_dir, {"path": ";".join(refs), "tool": "Bash", "action": action,
                              "session": session, "cmd": cmd[:200]})
            if allow:
                return 0
            return block(
                f"BLOCKED: this shell command references Tier-3 protected path(s) "
                f"({', '.join(refs)}) and contains a write-shaped operation. Modifying "
                "Tier-3 files via Bash is not permitted (read-only commands are fine)."
            )
        return 0

    # Edit-shaped tools
    raw_path = tool_input.get("file_path") or tool_input.get("notebook_path")
    if not raw_path:
        return 0 if allow else block(
            f"BLOCKED (fail-closed): {tool} call carries no file path the hook can verify."
        )

    abs_path = os.path.realpath(
        raw_path if os.path.isabs(raw_path)
        else os.path.join(payload.get("cwd") or project_dir, raw_path)
    )
    try:
        rel = os.path.relpath(abs_path, os.path.realpath(project_dir))
    except ValueError:
        return 0
    rel = rel.replace(os.sep, "/")
    if rel.startswith("..") and (not REPO_MARKER or REPO_MARKER not in rel):
        return 0  # outside the repo: not our concern

    if not match(rel):
        return 0

    action = "OVERRIDE-ALLOWED" if allow else "BLOCKED"
    log(project_dir, {"path": rel, "tool": tool, "action": action, "session": session})
    if allow:
        return 0
    return block(
        f"BLOCKED: '{rel}' is a Tier-3 protected path (auth/RBAC, schema, remote-execution, "
        "CI, agent-guard config, or your regulated domain). Agents may not modify it directly."
    )


if __name__ == "__main__":
    sys.exit(main())
