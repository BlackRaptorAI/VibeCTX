#!/usr/bin/env node
/**
 * PAR-652 item 9 — the project's status numbers, printed for a human to paste.
 *
 *   node scripts/metrics.mjs
 *
 * Deliberately NOT wired to a schedule or to an issue tracker. A new workflow is a
 * `.github/` change, and this repository's change-record policy (docs/change-record-policy.md)
 * exists to REMOVE governance machinery nobody asked for, not to add a cron job that posts
 * numbers into a tracker where they will rot.
 *
 * It reads two things, both public and unauthenticated:
 *   - npm download counts for @blackraptorai/vibectx, from api.npmjs.org
 *   - the repository's open-issue count, from api.github.com
 *
 * HONEST DEGRADATION is the whole design constraint, because both are expected to fail
 * today: the package is unpublished (PAR-516) and api.github.com is unreachable from the
 * build sandbox. A number this script cannot obtain is never printed as `0` — a zero is a
 * measurement and would be a lie here. It prints what it could not reach and why, and it
 * exits 0 either way: not knowing is a normal outcome, not a failure of the script.
 */

const PACKAGE = "@blackraptorai/vibectx";
const REPO = "BlackRaptorAI/VibeCTX";
const TIMEOUT_MS = 10_000;

/**
 * One GET, JSON or an explanation. Never throws.
 * Returns { ok: true, data } | { ok: false, why } — `why` is what a person needs to see.
 */
async function getJson(url) {
  try {
    const res = await fetch(url, {
      headers: { "user-agent": `vibectx-metrics (+https://github.com/${REPO})`, accept: "application/json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.status === 404) return { ok: false, why: "not found (404)", notFound: true };
    if (!res.ok) return { ok: false, why: `HTTP ${res.status}` };
    return { ok: true, data: await res.json() };
  } catch (e) {
    const cause = e?.cause?.code ?? e?.code;
    const name = e?.name === "TimeoutError" ? `timed out after ${TIMEOUT_MS / 1000}s` : undefined;
    return { ok: false, why: name ?? (cause ? `${cause}` : e?.message ?? String(e)) };
  }
}

/** npm downloads for one window, or the reason there is no number. */
async function downloads(window) {
  const r = await getJson(`https://api.npmjs.org/downloads/point/${window}/${encodeURIComponent(PACKAGE)}`);
  if (r.ok && typeof r.data?.downloads === "number") return { value: r.data.downloads };
  if (r.notFound) return { unknown: "npm has no record of this package — it is not published yet" };
  return { unknown: `npm download API unreachable (${r.why})` };
}

async function openIssues() {
  const r = await getJson(`https://api.github.com/repos/${REPO}`);
  if (r.ok && typeof r.data?.open_issues_count === "number") {
    // GitHub's `open_issues_count` counts open pull requests as issues. Say so rather than
    // presenting it as an issue count it is not.
    return { value: r.data.open_issues_count, note: "includes open pull requests (GitHub counts them as issues)" };
  }
  if (r.notFound) return { unknown: "the repository is private or does not exist under that name" };
  return { unknown: `GitHub API unreachable (${r.why})` };
}

const line = (label, result, suffix = "") => {
  if (result.unknown !== undefined) return `  ${label.padEnd(22)} unknown — ${result.unknown}`;
  return `  ${label.padEnd(22)} ${result.value}${suffix}${result.note ? ` (${result.note})` : ""}`;
};

const [day, week, month, issues] = await Promise.all([
  downloads("last-day"),
  downloads("last-week"),
  downloads("last-month"),
  openIssues(),
]);

const known = [day, week, month, issues].filter((r) => r.unknown === undefined).length;

console.log(
  [
    `VibeCTX status — ${new Date().toISOString().slice(0, 10)}`,
    `  package               ${PACKAGE}`,
    `  repository            ${REPO}`,
    "",
    line("npm downloads (day)", day),
    line("npm downloads (week)", week),
    line("npm downloads (month)", month),
    line("open issues", issues),
    "",
    known === 4
      ? "  All four figures were retrieved live just now."
      : `  ${4 - known} of 4 figures could not be retrieved; the reason is on the line itself.`,
    "  MEASURED where a number is shown; an `unknown` line is not a zero.",
  ].join("\n"),
);
