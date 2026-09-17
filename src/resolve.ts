import { installResolvedEntry, resolveLibrary, type LibraryEntry, type Registry, type ResolvedMeta } from "./registry.js";
import {
  MAX_METADATA_FETCHES,
  MAX_LLMS_CANDIDATES,
  MAX_README_CANDIDATES,
  MAX_VERSION_TAG_VARIANTS,
  MAX_VERSIONED_README_CANDIDATES,
  MAX_VERSION_METADATA_FETCHES,
  MAX_FETCHES_PER_RESOLUTION,
  MAX_RESOLUTIONS_PER_HOUR,
  README_VARIANTS,
} from "./limits.js";

export {
  MAX_METADATA_FETCHES,
  MAX_LLMS_CANDIDATES,
  MAX_README_CANDIDATES,
  MAX_VERSION_TAG_VARIANTS,
  MAX_VERSIONED_README_CANDIDATES,
  MAX_VERSION_METADATA_FETCHES,
  README_VARIANTS,
  MAX_URLS_PER_ENTRY,
  MAX_FETCHES_PER_RESOLUTION,
  MAX_RESOLUTIONS_PER_HOUR,
} from "./limits.js";
import { fetchUrl, getLibraryDoc, isDocUnchanged } from "./fetcher.js";
import { derivedAllowedHosts, sanitizeRemoteUrl } from "./link-policy.js";
import { npmNameError, normalisePyPiName, pypiNameError } from "./package-names.js";
import { cleanDescription, resolvedStorePath, saveResolvedEntry } from "./resolved-store.js";
import { indexCachedDocument, documentHash } from "./search-index.js";
import { classifySourceKind, type SourceKind } from "./source-kind.js";
import { recordActivity } from "./activity-log.js";

/**
 * resolve_library (PAR-655): any npm / PyPI package name → a docs source, with no
 * registry curation. Transport-free; index.ts, cli.ts, get-docs.ts and refresh.ts
 * delegate here.
 *
 * Chain (stop at the first usable document):
 *   1. registry hit — handled by the callers via resolveLibrary; this module never
 *      overrides a real entry.
 *   2. package metadata: npm `registry.npmjs.org/<name>/latest` (the latest-version
 *      document: 3–20 KB against 1–6 MB for the full packument — MEASURED 2026-09-06),
 *      then PyPI `pypi.org/pypi/<name>/json`. npm first, with a docs-site preference
 *      (see resolvePackage); `ecosystem` overrides.
 *   3. candidate synthesis: `<origin+path>/llms-full.txt`, `<origin+path>/llms.txt`,
 *      `<origin>/llms-full.txt`, `<origin>/llms.txt` on the docs URL (if any), then
 *      on the homepage; deduplicated; at most MAX_LLMS_CANDIDATES.
 *   4. GitHub README: `raw.githubusercontent.com/<o>/<r>/HEAD/<README variant>` — HEAD is
 *      the default branch, so no main/master guess; see README_VARIANTS.
 *   5. nothing usable → one plain line saying what was tried and how to pin it in config.
 *
 * Fetch bound per name (src/limits.ts): MAX_METADATA_FETCHES (2) + the preferred
 * ecosystem's candidates (≤ 8 llms + 4 README = 12) + — only if none of those served —
 * the other found ecosystem's (≤ 12): MAX_FETCHES_PER_RESOLUTION = 26 (R2). In
 * practice the second list is 4 (an ecosystem held back as README-only has no llms
 * candidates), so the reachable maximum is 18. Candidates are probed by getLibraryDoc,
 * which stops at the first usable document and caches it under the entry name, so
 * get_docs serves it immediately afterwards. A process may start at most
 * MAX_RESOLUTIONS_PER_HOUR resolutions (L2).
 *
 * Everything a registry returns is attacker-influenced (anyone can publish a package):
 * URLs go through sanitizeRemoteUrl (https, no userinfo, no IP / localhost / private
 * hosts), repositories must be github.com and are only ever turned into
 * raw.githubusercontent.com URLs, descriptions are flattened and capped.
 */

export type Ecosystem = "npm" | "pypi";

/** Registry metadata documents above this are treated as "no metadata". PyPI's JSON
 *  lists every release; boto3's is 3.3 MB (MEASURED 2026-09-06). ASSUMED headroom. */
export const METADATA_MAX_BYTES = 8 * 1024 * 1024;

export interface GitHubRepo {
  owner: string;
  repo: string;
}

export interface PackageMetadata {
  source: Ecosystem;
  metadataUrl: string;
  /** Sanitized https URLs. A github.com "homepage" is reported as `repository` instead. */
  homepage?: string;
  docsUrl?: string;
  repository?: GitHubRepo;
  description?: string;
}

export interface ResolveOutcome {
  /** The name as given (trimmed); the entry itself is stored under the folded name
   *  (npm) or the PEP 503 normalised name (PyPI). */
  name: string;
  ok: boolean;
  source?: Ecosystem;
  metadataUrl?: string;
  homepage?: string;
  docsUrl?: string;
  repository?: GitHubRepo;
  /** Every candidate URL, in probe order (the entry's `urls`). */
  candidates: string[];
  /** The candidate that served a document. */
  chosen?: string;
  kind?: SourceKind;
  chars?: number;
  /** `documentHash` (search-index.ts) of the chosen document's content — what the activity
   *  log records instead of the text (A20/PAR-729, D-51). Set exactly when `chosen` is. */
  contentHash?: string;
  entry?: LibraryEntry;
  /** False when resolved.json could not be written — another schema version on disk (K2), or
   *  (A5, PAR-718) the write itself failing on a read-only `$HOME` or a full disk; `saveNote`
   *  says which. */
  saved?: boolean;
  saveNote?: string;
  /** What was attempted, one phrase per step; the failure message is built from it. */
  attempts: string[];
  /** True when the per-hour resolution cap refused this name before any fetch (L2) — so a
   *  caller running many names (`warm`) can tell "try later" from "not resolvable". */
  limited?: true;
  /** A16/PAR-725 — true when every ecosystem this call actually queried (not one skipped for
   *  an invalid name or an `ecosystem` restriction) answered its metadata lookup with a genuine
   *  HTTP 404: the name does not exist in npm or PyPI, distinct from "exists, but nothing
   *  usable was found" (see `couldNotResolveMessage`'s two distinct wordings). Undefined —
   *  never `false` — whenever existence could not be established either way (a network error,
   *  a name-validation skip, or a real document was found), so a caller reads "undefined" as
   *  "no claim", not as "confirmed to exist". */
  notFound?: true;
  /** A11/PAR-724 — the version `resolvePackage` was asked to match, when one was given, whether
   *  or not it was actually matched (see `versionMatched`). Absent when no version was
   *  requested. */
  requestedVersion?: string;
  /** A11/PAR-724 — true when `chosen` is a version-SPECIFIC document (a GitHub tag README
   *  probed at `requestedVersion`), never merely because a version was requested. Undefined —
   *  including when `requestedVersion` is set — means the chain fell back to the unversioned
   *  candidates; the caller states that fallback explicitly (see `retrieval.ts`'s
   *  `versionFallbackNote`) rather than leaving the substitution silent (D-50). */
  versionMatched?: true;
  /** PAR-744 (F-7) — true when `chosen`'s content is NOT new: either a 304 revalidation
   *  (`doc.notModified`) or a stale-cache fallback because the network was unreachable
   *  (`doc.staleNote`). `refresh.ts`'s resolved-entry branch uses this to decide whether a
   *  re-resolution should drop the library's followed-page cache — the same distinction
   *  `DocResult.notModified`/`staleNote` already give the direct-fetch path. Before this field
   *  existed, `ResolveOutcome` carried no staleness signal at all, so every successful
   *  re-resolution dropped followed pages unconditionally. */
  unchanged?: true;
  /** True when `chosen`'s content is the STALE fallback — the network was unreachable on every
   *  candidate and `getLibraryDoc` re-served a past-TTL cached copy (`doc.staleNote`). Deliberately
   *  NARROWER than `unchanged` above: `unchanged` also covers a 304 revalidation, which is
   *  content that is current (its TTL was just refreshed by `touchCache`), not stale — conflating
   *  the two here would report a stale fallback as `fresh` (code-reviewer, A20/PAR-729 round 1,
   *  B1: `resolveToolText`'s activity-log entry logged `fresh: true` unconditionally whenever
   *  `chosen` was set, on the mistaken assumption that `forceRefresh: true` guarantees a current
   *  document — it does not; `fetcher.ts`'s own stale-fallback branch is reachable through this
   *  exact `getLibraryDoc(entry, { forceRefresh: true })` call, on a re-resolution whose network
   *  is down). */
  stale?: true;
  /** The text the tool / CLI shows. */
  text: string;
}

const LABEL: Record<Ecosystem, string> = { npm: "npm", pypi: "PyPI" };
const GITHUB_HOSTS = new Set(["github.com", "www.github.com"]);
const REPO_SEGMENT = /^[A-Za-z0-9_.-]+$/;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function repoFrom(owner: string, repoRaw: string): GitHubRepo | undefined {
  const repo = repoRaw.replace(/\.git$/, "");
  if (!REPO_SEGMENT.test(owner) || !REPO_SEGMENT.test(repo)) return undefined;
  if (owner === "." || owner === ".." || repo === "." || repo === "..") return undefined;
  return { owner, repo };
}

/**
 * Owner / repo from any repository form npm or PyPI emit — `git+https://github.com/o/r.git`,
 * `https://github.com/o/r#readme`, `git://`, `git@github.com:o/r.git`, `ssh://git@github.com/o/r`,
 * `github:o/r`, `o/r`, or a `{ url }` object. github.com only (no other forge, no lookalike,
 * no subdomain); no userinfo on https; segments limited to `[A-Za-z0-9_.-]`.
 */
export function parseGitHubRepo(value: unknown): GitHubRepo | undefined {
  const raw = isRecord(value) ? value.url : value;
  if (typeof raw !== "string") return undefined;
  const s = raw.trim();
  if (s.length === 0 || s.length > 2048) return undefined;
  let m = /^(?:github:)?([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(s);
  if (m) return repoFrom(m[1], m[2]);
  m = /^git@github\.com:([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)\/?$/.exec(s);
  if (m) return repoFrom(m[1], m[2]);
  let url: URL;
  try {
    url = new URL(s.replace(/^git\+/, ""));
  } catch {
    return undefined;
  }
  if (!["https:", "http:", "git:", "ssh:"].includes(url.protocol)) return undefined;
  if (!GITHUB_HOSTS.has(url.hostname)) return undefined;
  if (url.protocol !== "ssh:" && (url.username !== "" || url.password !== "")) return undefined;
  const parts = url.pathname.split("/").filter((p) => p.length > 0);
  if (parts.length < 2 || parts[0].includes("%") || parts[1].includes("%")) return undefined;
  return repoFrom(parts[0], parts[1]);
}

function isGitHubUrl(url: string): boolean {
  try {
    return GITHUB_HOSTS.has(new URL(url).hostname);
  } catch {
    return false;
  }
}

/** Assign a sanitized URL to homepage / docsUrl, or — when it points at github.com — to
 *  the repository slot (github.com is not a docs host we can probe for llms.txt). */
function place(meta: PackageMetadata, slot: "homepage" | "docsUrl", value: unknown): void {
  const url = sanitizeRemoteUrl(value);
  if (!url) return;
  if (isGitHubUrl(url)) {
    if (!meta.repository) {
      const repo = parseGitHubRepo(url);
      if (repo) meta.repository = repo;
    }
    return;
  }
  if (meta[slot] === undefined) meta[slot] = url;
}

/** npm `/<name>/latest` document → metadata. Hostile or malformed fields are skipped, never fatal. */
export function parseNpmMetadata(json: unknown, metadataUrl: string): PackageMetadata {
  const meta: PackageMetadata = { source: "npm", metadataUrl };
  if (!isRecord(json)) return meta;
  const repo = parseGitHubRepo(json.repository);
  if (repo) meta.repository = repo;
  place(meta, "homepage", json.homepage);
  const description = cleanDescription(json.description);
  if (description) meta.description = description;
  return meta;
}

const DOCS_KEYS = /^(docs?|documentation)\b/;
const HOME_KEYS = /^(home ?page|home)$/;
const REPO_KEYS = /^(source( code)?|repository|repo|github|code)$/;

/** PyPI `/pypi/<name>/json` document → metadata from `info.project_urls` (keys matched
 *  case-insensitively: Documentation / Docs, Homepage / Home page, Source / Repository /
 *  GitHub / Code), falling back to `info.home_page`; `info.summary` is the description. */
export function parsePyPiMetadata(json: unknown, metadataUrl: string): PackageMetadata {
  const meta: PackageMetadata = { source: "pypi", metadataUrl };
  if (!isRecord(json) || !isRecord(json.info)) return meta;
  const info = json.info;
  let docs: unknown;
  let home: unknown;
  let repo: unknown;
  if (isRecord(info.project_urls)) {
    for (const [key, value] of Object.entries(info.project_urls)) {
      const k = key.trim().toLowerCase();
      if (docs === undefined && DOCS_KEYS.test(k)) docs = value;
      else if (home === undefined && HOME_KEYS.test(k)) home = value;
      else if (repo === undefined && REPO_KEYS.test(k)) repo = value;
    }
  }
  const parsedRepo = parseGitHubRepo(repo);
  if (parsedRepo) meta.repository = parsedRepo;
  place(meta, "docsUrl", docs);
  place(meta, "homepage", home);
  place(meta, "homepage", info.home_page);
  const description = cleanDescription(info.summary);
  if (description) meta.description = description;
  return meta;
}

/** A11/PAR-724 — `v<version>` and bare `<version>`, the two GitHub tag-name spellings this
 *  chain tries; see `MAX_VERSION_TAG_VARIANTS`'s own comment for why only these two. */
export function versionTagVariants(version: string): string[] {
  return [`v${version}`, version];
}

/** A11/PAR-724 — README variants at `refs/tags/<tag>` for each tag spelling, in probe order
 *  (tag first, then filename — so `v<version>/README.md` is tried before `<version>/README.md`),
 *  capped at MAX_VERSIONED_README_CANDIDATES. `refs/tags/<tag>` rather than the bare tag name as
 *  the ref segment (the form `synthesizeCandidates` already uses for `HEAD`): unlike `HEAD`, a
 *  tag name can collide with a branch of the same name, and the explicit `refs/tags/` form is
 *  the one that disambiguates on raw.githubusercontent.com. */
export function versionReadmeCandidates(repo: GitHubRepo, version: string): string[] {
  const urls: string[] = [];
  for (const tag of versionTagVariants(version)) {
    for (const f of README_VARIANTS) urls.push(`https://raw.githubusercontent.com/${repo.owner}/${repo.repo}/refs/tags/${tag}/${f}`);
  }
  return urls.slice(0, MAX_VERSIONED_README_CANDIDATES);
}

/** Candidate URLs in probe order: llms-full.txt / llms.txt under the docs URL's path and
 *  origin, then the homepage's; then the GitHub README variants at `HEAD`. Never includes
 *  version-specific candidates — those are a separate, higher-priority list the caller
 *  (`resolvePackage`) prepends itself (via `versionReadmeCandidates`) only for the ecosystem it
 *  actually looked up a version for; this function stays the same unversioned chain every
 *  caller, versioned or not, still falls back to. */
export function synthesizeCandidates(meta: PackageMetadata): string[] {
  const llms: string[] = [];
  const push = (u: string) => {
    if (llms.length < MAX_LLMS_CANDIDATES && !llms.includes(u)) llms.push(u);
  };
  for (const base of [meta.docsUrl, meta.homepage]) {
    if (!base) continue;
    const u = new URL(base);
    const segments = u.pathname.split("/").filter((s) => s.length > 0);
    if (segments.length > 0 && /\.[a-z0-9]+$/i.test(segments[segments.length - 1])) segments.pop(); // index.html etc.
    const path = segments.length > 0 ? `/${segments.join("/")}` : "";
    if (path) {
      push(`${u.origin}${path}/llms-full.txt`);
      push(`${u.origin}${path}/llms.txt`);
    }
    push(`${u.origin}/llms-full.txt`);
    push(`${u.origin}/llms.txt`);
  }
  const readme = meta.repository
    ? README_VARIANTS.map((f) => `https://raw.githubusercontent.com/${meta.repository!.owner}/${meta.repository!.repo}/HEAD/${f}`)
    : [];
  return [...llms, ...readme.slice(0, MAX_README_CANDIDATES)];
}

function buildEntry(name: string, meta: PackageMetadata, urls: string[], now: Date): LibraryEntry {
  const resolved: ResolvedMeta = { source: meta.source, resolvedAt: now.toISOString(), metadataUrl: meta.metadataUrl };
  if (meta.homepage) resolved.homepage = meta.homepage;
  if (meta.docsUrl) resolved.docsUrl = meta.docsUrl;
  const entry: LibraryEntry = { name, urls, allowedHosts: derivedAllowedHosts(resolved), resolved };
  if (meta.description) entry.description = meta.description;
  return entry;
}

function describeMeta(meta: PackageMetadata): string {
  const parts: string[] = [];
  if (meta.homepage) parts.push(`homepage ${meta.homepage}`);
  if (meta.docsUrl) parts.push(`docs ${meta.docsUrl}`);
  if (meta.repository) parts.push(`repository github.com/${meta.repository.owner}/${meta.repository.repo}`);
  return parts.join(", ");
}

/** A16/PAR-725 — the two distinct existence wordings, and the generic (existence-not-
 *  established) one, all sharing the same `Could not resolve "<name>": ` lead and pin-it-by-hand
 *  tail so `runResolveCli`'s `text.startsWith("Could not resolve")` exit-code check keeps working
 *  under every variant. `"not-found"`: every ecosystem this call actually queried answered with
 *  a genuine 404 — the SAFETY signal (a name an LLM could have invented, distinct from a real
 *  package with no reachable docs). `"exists"`: at least one ecosystem's metadata was found, so
 *  the name is real, but no document was reachable — the ordinary documentation-miss case.
 *  Undefined: existence was never established either way (bad network, invalid name, rate
 *  limit) — no claim is made, per the same discipline `ResolveOutcome.notFound` documents.
 *  Claim discipline (PAR-725 Shape): the ONLY existence claim made anywhere is "this name does
 *  not exist in npm or PyPI" — never phrased as preventing hallucination in general. */
export function couldNotResolveMessage(
  name: string,
  attempts: string[],
  opts: { existence?: "not-found" | "exists"; notFoundEcosystems?: Ecosystem[] } = {},
): string {
  // A16/PAR-725 — "not-found" is scoped to whichever registry (or registries) actually
  // confirmed the absence: "npm or PyPI" for an unrestricted call that checked both, or just
  // "npm" / "PyPI" for a caller that deliberately restricted the lookup to one (`warm.ts`
  // always does, per the manifest's own ecosystem) — narrower, not broader, so it is never an
  // overclaim. Falls back to the general "npm or PyPI" phrasing if this is ever called with
  // `existence: "not-found"` and no ecosystem list (defensive; every real call site supplies one).
  const registries = opts.notFoundEcosystems?.length ? opts.notFoundEcosystems.map((e) => LABEL[e]).join(" or ") : "npm or PyPI";
  const existence =
    opts.existence === "not-found"
      ? `"${name}" does not exist in ${registries}. `
      : opts.existence === "exists"
        ? `"${name}" exists but publishes no documentation VibeCTX can reach — this is not a sign the package doesn't exist. `
        : "";
  return (
    `Could not resolve "${name}": ${existence}${attempts.join("; ")}. ` +
    `Add it to vibectx.config.json like: { "name": "${name}", "urls": ["https://..."] }`
  );
}

async function fetchMetadata(url: string): Promise<{ json?: unknown; why?: string; notFound?: true }> {
  const out = await fetchUrl(url, { maxBytes: METADATA_MAX_BYTES, publicFinalUrl: true });
  if (out.status === "too-large") return { why: `larger than ${METADATA_MAX_BYTES / (1024 * 1024)} MiB` };
  // A16/PAR-725 — `httpStatus` (fetcher.ts) is set only for a real, received 404/etc response
  // (the "http-status" miss reason); every other miss (redirect loop, DNS failure, a timeout)
  // leaves it undefined, so this is the one branch that can honestly say "the registry said no
  // such package" rather than "something went wrong asking".
  if (out.status === "miss" && out.httpStatus === 404) return { why: "404 (not found)", notFound: true };
  if (out.status !== "ok" || out.body === undefined) return { why: "unreachable" };
  try {
    return { json: JSON.parse(out.body) };
  } catch {
    return { why: "response was not JSON" };
  }
}

/** A11/PAR-724 — `version` selects the exact-version metadata document instead of `/latest`:
 *  npm's `registry.npmjs.org/<name>/<version>` and PyPI's `pypi.org/pypi/<name>/<version>/json`
 *  are both real, documented per-version endpoints (the same shape the unversioned lookup
 *  already uses, with the version in place of `latest`). */
function metadataUrlFor(eco: Ecosystem, name: string, version?: string): string {
  // npm's conventional scoped form keeps the leading "@" and encodes the "/" (`@scope%2Fname`).
  if (eco === "npm") {
    const base = `https://registry.npmjs.org/${encodeURIComponent(name).replace(/^%40/, "@")}`;
    return `${base}/${encodeURIComponent(version ?? "latest")}`;
  }
  const base = `https://pypi.org/pypi/${encodeURIComponent(normalisePyPiName(name))}`;
  return version ? `${base}/${encodeURIComponent(version)}/json` : `${base}/json`;
}

/** Resolutions started in the current sliding hour (L2); process-wide. */
let resolutionStarts: number[] = [];

/** Test hook: forget the sliding window. */
export function resetResolutionWindow(): void {
  resolutionStarts = [];
}

/** True when another resolution may start now; records it if so. */
function takeResolutionSlot(nowMs: number): boolean {
  resolutionStarts = resolutionStarts.filter((t) => nowMs - t < 3600_000);
  if (resolutionStarts.length >= MAX_RESOLUTIONS_PER_HOUR) return false;
  resolutionStarts.push(nowMs);
  return true;
}

function formatResolved(out: ResolveOutcome): string {
  const chosenAt = out.candidates.indexOf(out.chosen ?? "");
  const rows = out.candidates.map((u, i) => {
    const verdict = i < chosenAt ? "no document" : i === chosenAt ? "chosen" : "not tried";
    return `    ${i + 1}. ${u} — ${verdict}`;
  });
  const repo = out.repository ? `https://github.com/${out.repository.owner}/${out.repository.repo}` : "—";
  const hosts = out.entry?.allowedHosts?.length ? out.entry.allowedHosts.join(", ") : "none";
  const saved = out.saved === false
    ? `  NOT saved: ${out.saveNote ?? "resolved.json could not be written"} — this resolution lives in memory until restart; get_docs("${out.entry?.name}") works now.`
    : `  saved to ${resolvedStorePath()} — get_docs("${out.entry?.name}") works now; pin or override it in vibectx.config.json.`;
  // A11/PAR-724 — non-silent per D-50: whenever a version was requested, say plainly whether
  // it was matched or the resolution fell back to the latest available document.
  const version = out.requestedVersion
    ? [`  version:    ${out.requestedVersion} (${out.versionMatched ? "matched" : "no versioned document found; showing latest"})`]
    : [];
  return [
    `Resolved "${out.name}" via ${LABEL[out.source!]} — ${out.metadataUrl}`,
    ...(out.entry?.description ? [`  description: (package-supplied) ${out.entry.description}`] : []),
    ...version,
    `  homepage:   ${out.homepage ?? "—"}`,
    `  docs:       ${out.docsUrl ?? "—"}`,
    `  repository: ${repo}`,
    "  candidates (probed in order; first usable document wins):",
    ...rows,
    `  chosen: ${out.chosen} (${out.kind}, ${(out.chars ?? 0).toLocaleString()} chars)`,
    `  followed-link hosts: ${hosts} (plus the source document's own host; https only)`,
    saved,
  ].join("\n");
}

/** npm parks taken-down / reserved names on this repository; such a name has no package. */
function isNpmPlaceholder(meta: PackageMetadata): boolean {
  return meta.repository?.owner === "npm" && meta.repository.repo === "security-holder";
}

/** A homepage or docs URL that is not github.com — the signal that this ecosystem's
 *  package is the documented project rather than a same-named repo-only package. */
function hasDocsSite(meta: PackageMetadata): boolean {
  return meta.homepage !== undefined || meta.docsUrl !== undefined;
}

/**
 * Resolve one package name. Never throws — not for bad input, not for a bad network, and
 * (A5, PAR-718) not for a failed cache or record write (EACCES/ENOSPC/EROFS: a read-only
 * `$HOME` or a full disk): the outcome's `text` is always a plain message. `ecosystem`
 * restricts the lookup to one registry.
 *
 * RESIDUAL, disclosed rather than silently accepted (see the `getLibraryDoc` call site
 * below): when the cache write fails before ANY document has been fetched for this library
 * (no per-library directory existed yet), the document itself is lost — recovering it is
 * `cache.ts`'s job, out of this item's authorised scope — and this reports the name as
 * unresolvable rather than serving the fetched text. When the write that fails is only
 * `resolved.json`'s (the document was already cached), the document IS still returned, with
 * `saved: false` and `saveNote` explaining why.
 *
 * Ecosystem choice without an override — npm first, then PyPI, with a docs-site
 * preference: an ecosystem whose metadata carries a homepage / docs URL is taken at
 * once (no second metadata fetch); one that offers only a repository README is held
 * while the other ecosystem is consulted, and loses to it if that one has a docs site.
 * MEASURED 2026-09-06: `httpx`, `fastapi` and `django` all exist on npm as unrelated
 * README-only or placeholder packages, so plain npm-first misresolves Python names.
 */
export async function resolvePackage(
  rawName: string,
  opts: { ecosystem?: Ecosystem; version?: string; now?: () => Date; warn?: (message: string) => void } = {},
): Promise<ResolveOutcome> {
  const name = rawName.trim();
  const folded = name.toLowerCase(); // the registry's fold()
  const attempts: string[] = [];
  // A16/PAR-725 — ecosystems this call actually queried (not skipped for an invalid name or an
  // `ecosystem` restriction), and which of those came back a genuine 404. Declared here, ahead
  // of `fail`, so `fail`'s own closure sees the values phase 1 fills in — both start empty for
  // the two early-return cases below, where nothing has been queried yet.
  const triedEcosystems: Ecosystem[] = [];
  const notFoundIn: Ecosystem[] = [];
  // A16/PAR-725 — `existence` names which of the two distinct wordings applies; undefined makes
  // no claim either way (see `couldNotResolveMessage`'s own comment for the three cases). When
  // "not-found", `notFoundIn` (by then populated) says WHICH registry/registries confirmed the
  // absence — `opts.ecosystem` narrows the claim to just that one, an equally honest, narrower
  // reading of the same signal ("does not exist in npm" is still true and useful when the
  // caller deliberately asked only about npm — see `warm.ts`, which always restricts by the
  // manifest's own ecosystem and could never reach the two-registry claim otherwise).
  const fail = (existence?: "not-found" | "exists"): ResolveOutcome => ({
    name,
    ok: false,
    candidates: [],
    attempts,
    notFound: existence === "not-found" ? true : undefined,
    requestedVersion: opts.version,
    text: couldNotResolveMessage(name, attempts, { existence, notFoundEcosystems: notFoundIn }),
  });
  const now = opts.now ?? (() => new Date());

  const nameErrors: Record<Ecosystem, string | undefined> = { npm: npmNameError(folded), pypi: pypiNameError(name) };
  if (nameErrors.npm !== undefined && nameErrors.pypi !== undefined) {
    attempts.push(`"${name}" is not a valid npm or PyPI package name; nothing was fetched`);
    return fail();
  }
  if (!takeResolutionSlot(now().getTime())) {
    attempts.push(`resolution limit reached (${MAX_RESOLUTIONS_PER_HOUR} per hour per process); try again later, or pin the library`);
    return { ...fail(), limited: true };
  }

  // Phase 1: gather metadata (at most MAX_METADATA_FETCHES), stopping early on a docs site.
  const found: { eco: Ecosystem; meta: PackageMetadata; candidates: string[] }[] = [];
  let fetched = 0;
  for (const eco of ["npm", "pypi"] as const) {
    const label = LABEL[eco];
    if (opts.ecosystem !== undefined && opts.ecosystem !== eco) {
      attempts.push(`${label}: not tried (ecosystem ${opts.ecosystem})`);
      continue;
    }
    if (nameErrors[eco] !== undefined) {
      attempts.push(`${label}: not tried (not a valid ${label} name)`);
      continue;
    }
    if (fetched >= MAX_METADATA_FETCHES) break;
    triedEcosystems.push(eco);
    const metadataUrl = metadataUrlFor(eco, eco === "npm" ? folded : name);
    fetched += 1;
    const { json, why, notFound } = await fetchMetadata(metadataUrl);
    if (json === undefined) {
      attempts.push(`${label}: no metadata (${why})`);
      if (notFound) notFoundIn.push(eco);
      continue;
    }
    const meta = eco === "npm" ? parseNpmMetadata(json, metadataUrl) : parsePyPiMetadata(json, metadataUrl);
    if (eco === "npm" && isNpmPlaceholder(meta)) {
      attempts.push("npm: name is held by npm's security-holder placeholder (no package)");
      notFoundIn.push(eco); // A16: npm's own "reserved, no package" marker is "does not exist"
      continue;
    }
    const candidates = synthesizeCandidates(meta);
    if (candidates.length === 0) {
      attempts.push(`${label} metadata found but it has no https homepage, docs URL or GitHub repository`);
      continue;
    }
    found.push({ eco, meta, candidates });
    if (hasDocsSite(meta)) break;
  }
  // Docs-site ecosystem first, then the rest in registry order (R2: a dead end falls through).
  const order = [...found.filter((f) => hasDocsSite(f.meta)), ...found.filter((f) => !hasDocsSite(f.meta))];
  // A16/PAR-725 — the claim is specifically "does not exist in npm OR PyPI", so it is only
  // honest when BOTH were actually queried and BOTH came back a genuine 404 — never when an
  // `ecosystem` restriction or a name invalid for one of them left only one actually checked
  // (npm-only 404 does not prove a name absent from PyPI too, and vice versa).
  // Every ecosystem actually queried came back a genuine 404: an unrestricted call needs BOTH
  // (npm alone 404ing proves nothing about PyPI), but a caller that explicitly restricted the
  // lookup to one ecosystem (`opts.ecosystem`) already narrowed the question to just that
  // registry, so its own 404 already answers it in full — see `fail`'s comment above.
  const doesNotExist =
    triedEcosystems.length > 0 &&
    triedEcosystems.every((eco) => notFoundIn.includes(eco)) &&
    (opts.ecosystem !== undefined || triedEcosystems.length === 2);
  if (order.length === 0) return fail(doesNotExist ? "not-found" : undefined);

  // A11/PAR-724 — Phase 1.5: when a version is pinned, one extra metadata fetch at the exact
  // version, for the chosen ecosystem only (order[0]) — confirms the version is registered and
  // may reveal a repository that differs from `/latest`'s (a package that moved forges between
  // releases, say). Never blocks resolution either way: the unversioned fallback chain below
  // still runs regardless of what this fetch finds.
  let versionRepo: GitHubRepo | undefined;
  if (opts.version !== undefined) {
    const { eco, meta } = order[0];
    const label = LABEL[eco];
    const versionUrl = metadataUrlFor(eco, eco === "npm" ? folded : name, opts.version);
    fetched += 1;
    const { json, why } = await fetchMetadata(versionUrl);
    if (json !== undefined) {
      const vMeta = eco === "npm" ? parseNpmMetadata(json, versionUrl) : parsePyPiMetadata(json, versionUrl);
      versionRepo = vMeta.repository ?? meta.repository;
      attempts.push(`${label}: version ${opts.version} metadata found`);
    } else {
      versionRepo = meta.repository; // still try the version-tag README against the latest repo
      attempts.push(`${label}: version ${opts.version} not found in registry metadata (${why})`);
    }
  }

  // Phase 2: probe each found ecosystem's candidates in order; the first usable document wins.
  let budget = MAX_FETCHES_PER_RESOLUTION - fetched;
  for (let orderIndex = 0; orderIndex < order.length; orderIndex++) {
    const { eco, meta, candidates } = order[orderIndex];
    // A11/PAR-724 — version-specific candidates only for the ecosystem the version metadata
    // fetch above actually ran against (order[0]); an ecosystem tried later in this loop only
    // as R2's dead-end fallback gets the unversioned chain, same as an unversioned call always did.
    const versionCandidates =
      orderIndex === 0 && opts.version !== undefined && versionRepo ? versionReadmeCandidates(versionRepo, opts.version) : [];
    const versionUrlSet = new Set(versionCandidates);
    const urls = [...versionCandidates, ...candidates].slice(0, Math.max(0, budget)); // the hard ceiling
    budget -= urls.length;
    if (urls.length === 0) break;
    // PyPI names are keyed by their PEP 503 form (L3): typing_extensions and Typing-Extensions are one record.
    const entryName = eco === "pypi" ? normalisePyPiName(name) : folded;
    const entry = buildEntry(entryName, meta, urls, now());
    // A5 (PAR-718): this function's contract is "never throws for bad input or bad network"
    // (see the docstring above) — but `getLibraryDoc` also WRITES the document to the cache
    // (`cache.ts`'s `writeCache`), and that write throws on EACCES/ENOSPC/EROFS (a read-only
    // `$HOME` or a full disk), not just on a bad network. Caught here rather than left to
    // propagate: the caller only ever sees "this candidate set produced nothing", not a stack
    // trace. RESIDUAL, disclosed rather than silently accepted: the document itself is lost in
    // this branch — it WAS fetched, but a throw during the cache write aborts `getLibraryDoc`
    // before it returns the content, and recovering that content is `cache.ts`'s job, not this
    // function's (out of A5's authorised scope — carried forward, see the go-card handoff).
    let doc: Awaited<ReturnType<typeof getLibraryDoc>>;
    try {
      doc = await getLibraryDoc(entry, { forceRefresh: true });
    } catch (e) {
      // Not "none of N candidates served a document" (the sibling message below, where all N
      // really were tried) — `getLibraryDoc` stops at the first candidate that fetched
      // successfully and aborts on ITS cache write, so fewer than `urls.length` were probed.
      attempts.push(
        `${LABEL[eco]} metadata found (${describeMeta(meta)}); the cache write failed while probing its candidates: ${e instanceof Error ? e.message : String(e)}`,
      );
      continue;
    }
    if (!doc) {
      attempts.push(
        `${LABEL[eco]} metadata found (${describeMeta(meta)}); none of ${urls.length} candidate URLs served a document: ${urls.join(", ")}`,
      );
      continue;
    }
    // D-34 (PAR-659, R1) — RESOLUTION IS A WRITER OF A PRIMARY CACHED DOCUMENT, so it keeps
    // the cross-library search index current like every other writer. The hooks used to sit at
    // the CALLERS, and two callers had none: `warm`'s `resolved+cached` branch left a
    // newly-resolved library unindexed, and `refresh`'s resolved branch invalidated the entry
    // and then returned without rebuilding it — so a SUCCESSFUL refresh left that library
    // deleted from the index until something else rewrote it.
    //
    // One hook here closes the class rather than the two instances: both callers reach the
    // cache through this function, and this is the only place that holds the document text and
    // the entry name together without a second read. (A hook inside `cache.ts`'s `writeCache`
    // would have been lower still, but that writer also serves FOLLOWED PAGES, which D-34
    // deliberately does not index — it would have filed a followed page under the library's
    // name and displaced its primary document.)
    let saveNote: string | undefined;
    let saved: boolean;
    // A5 (PAR-718): `saveResolvedEntry` throws on EACCES/ENOSPC/EROFS (`resolved-store.ts`'s
    // own `mkdirSync`/`writeAtomic`) — a read-only `$HOME` or a full disk turned a resolution
    // that HAD already produced a real document (the fetch and cache-write above succeeded)
    // into an uncaught exception through `get-docs.ts`. `saved`/`saveNote` are already on
    // `ResolveOutcome` for exactly this case (the K2 "newer schema on disk" refusal below sets
    // them via `warn` without throwing); a caught write exception now sets them the same way,
    // so the caller sees "resolved, not saved, here is why" rather than a stack trace.
    //
    // Deliberately broad, not narrowed to the I/O errors above: `saveResolvedEntry` also
    // throws two invariant errors (`resolved-store.ts:110,112`, "not a resolved entry" / "does
    // not pass resolved-record validation") that `buildEntry`'s own construction should make
    // unreachable here. Catching them too means an invariant violation degrades to the same
    // "not saved" outcome BY DESIGN rather than surfacing as a distinct crash — the same
    // trade-off this item makes everywhere else, made explicit rather than left implicit.
    try {
      saved = saveResolvedEntry(entry, (m) => {
        saveNote = m.replace(/^vibectx: not saving "[^"]*" — /, "").trim();
        (opts.warn ?? ((x: string) => process.stderr.write(x)))(m);
      });
    } catch (e) {
      saved = false;
      saveNote = (e instanceof Error ? e.message : String(e)).replace(/\s+/g, " ").trim();
      (opts.warn ?? ((x: string) => process.stderr.write(x)))(`vibectx: resolution not saved for "${entry.name}": ${saveNote}\n`);
    }
    // …and the index is written only once the RECORD is, in that order. Indexing first filed a
    // posting list under a library name that a refused save leaves no trace of anywhere else —
    // an orphan no later process could ever use, spending the index's size budget (D-40) that a
    // library the registry does know might then be shed to make room in.
    if (saved) indexCachedDocument(entry.name, doc.url, doc.content, undefined, opts.warn);
    const out: ResolveOutcome = {
      name,
      ok: true,
      source: eco,
      metadataUrl: meta.metadataUrl,
      homepage: meta.homepage,
      docsUrl: meta.docsUrl,
      repository: meta.repository,
      candidates: urls,
      chosen: doc.url,
      kind: classifySourceKind(doc.url, doc.content),
      chars: doc.content.length,
      contentHash: documentHash(doc.content),
      entry,
      saved,
      saveNote,
      attempts,
      requestedVersion: opts.version,
      text: "",
    };
    if (isDocUnchanged(doc)) out.unchanged = true;
    if (doc.staleNote !== undefined) out.stale = true;
    if (versionUrlSet.has(doc.url)) out.versionMatched = true;
    out.text = formatResolved(out);
    return out;
  }
  // A16/PAR-725 — every ecosystem in `order` was reached because its metadata fetch succeeded
  // (the `order.length === 0` case above already returned), so the name is confirmed to exist —
  // this is the ordinary "no reachable document" case, not "does not exist".
  return fail("exists");
}

/** The lookup the tools use before resolving. `resolveLibrary` already tries the PEP 503
 *  form (curated entries first), so this is a named alias kept for the call sites (L3). */
export function lookupLibrary(registry: Registry, name: string): LibraryEntry | undefined {
  return resolveLibrary(registry, name);
}

/**
 * The MCP `resolve_library` tool body / `vibectx resolve`. A canonical name or alias that
 * is already a real (non-resolved) entry is reported without any network call; anything
 * else is resolved, adopted into the live registry (a resolved entry may be re-resolved,
 * e.g. to switch ecosystem) and reported.
 *
 * A20/PAR-729 (D-51): both branches write exactly one activity-log entry. The already-
 * curated fast path counts as `matched` — the name resolved to a real entry, even though no
 * network call was made; a failed `resolvePackage` is `unresolved`, and `library` falls back
 * to the requested name (cleaned by the log's own field bound) since no canonical one exists.
 */
export async function resolveToolText(registry: Registry, name: string, ecosystem?: Ecosystem): Promise<string> {
  // S2: judge "already curated" on the folded key too, so an exact-case resolved entry
  // sitting beside a curated one ("React" next to "react") cannot slip past.
  const existing = lookupLibrary(registry, name);
  const curated = existing && !existing.resolved ? existing : lookupLibrary(registry, name.trim().toLowerCase());
  if (curated && !curated.resolved) {
    const existingCurated = curated;
    recordActivity({ tool: "resolve_library", library: existingCurated.name, outcome: "matched" });
    return [
      `"${name}" is already in the registry as "${existingCurated.name}" — nothing to resolve.`,
      "  urls (probed in order):",
      ...existingCurated.urls.map((u, i) => `    ${i + 1}. ${u}`),
      `  Use get_docs("${existingCurated.name}"); override the entry in vibectx.config.json to change its sources.`,
    ].join("\n");
  }
  const out = await resolvePackage(name, { ecosystem });
  if (out.ok && out.entry) installResolvedEntry(registry, out.entry); // refuses a curated key (S2); replaces a resolved one
  recordActivity({
    tool: "resolve_library",
    library: out.entry?.name ?? name,
    url: out.chosen,
    contentHash: out.contentHash,
    // code-reviewer, A20/PAR-729 round 1, B1: NOT unconditionally true — `forceRefresh: true`
    // does not guarantee a current document; `out.stale` says whether the network was down and
    // `getLibraryDoc` fell back to a past-TTL cached copy (see `ResolveOutcome.stale`'s comment).
    fresh: out.chosen ? !out.stale : undefined,
    outcome: out.ok ? "matched" : "unresolved",
  });
  return out.text;
}
