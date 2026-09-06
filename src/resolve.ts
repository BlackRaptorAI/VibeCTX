import { installResolvedEntry, resolveLibrary, type LibraryEntry, type Registry, type ResolvedMeta } from "./registry.js";
import {
  MAX_METADATA_FETCHES,
  MAX_LLMS_CANDIDATES,
  MAX_README_CANDIDATES,
  MAX_FETCHES_PER_RESOLUTION,
  MAX_RESOLUTIONS_PER_HOUR,
  README_VARIANTS,
} from "./limits.js";

export { MAX_METADATA_FETCHES, MAX_LLMS_CANDIDATES, MAX_README_CANDIDATES, README_VARIANTS, MAX_URLS_PER_ENTRY, MAX_FETCHES_PER_RESOLUTION, MAX_RESOLUTIONS_PER_HOUR } from "./limits.js";
import { fetchUrl, getLibraryDoc } from "./fetcher.js";
import { derivedAllowedHosts, sanitizeRemoteUrl } from "./link-policy.js";
import { npmNameError, normalisePyPiName, pypiNameError } from "./package-names.js";
import { cleanDescription, resolvedStorePath, saveResolvedEntry } from "./resolved-store.js";
import { classifySourceKind, type SourceKind } from "./source-kind.js";

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
  entry?: LibraryEntry;
  /** False when resolved.json could not be written (another schema version on disk); `saveNote` says why. */
  saved?: boolean;
  saveNote?: string;
  /** What was attempted, one phrase per step; the failure message is built from it. */
  attempts: string[];
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

/** Candidate URLs in probe order: llms-full.txt / llms.txt under the docs URL's path and
 *  origin, then the homepage's; then the GitHub README variants at `HEAD`. */
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

/** The one-line failure text: what was tried, then how to pin the library by hand. */
export function couldNotResolveMessage(name: string, attempts: string[]): string {
  return (
    `Could not resolve "${name}": ${attempts.join("; ")}. ` +
    `Add it to vibectx.config.json like: { "name": "${name}", "urls": ["https://..."] }`
  );
}

async function fetchMetadata(url: string): Promise<{ json?: unknown; why?: string }> {
  const out = await fetchUrl(url, { maxBytes: METADATA_MAX_BYTES, publicFinalUrl: true });
  if (out.status === "too-large") return { why: `larger than ${METADATA_MAX_BYTES / (1024 * 1024)} MiB` };
  if (out.status !== "ok" || out.body === undefined) return { why: "404 or unreachable" };
  try {
    return { json: JSON.parse(out.body) };
  } catch {
    return { why: "response was not JSON" };
  }
}

function metadataUrlFor(eco: Ecosystem, name: string): string {
  // npm's conventional scoped form keeps the leading "@" and encodes the "/" (`@scope%2Fname`).
  return eco === "npm"
    ? `https://registry.npmjs.org/${encodeURIComponent(name).replace(/^%40/, "@")}/latest`
    : `https://pypi.org/pypi/${encodeURIComponent(normalisePyPiName(name))}/json`;
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
  return [
    `Resolved "${out.name}" via ${LABEL[out.source!]} — ${out.metadataUrl}`,
    ...(out.entry?.description ? [`  description: (package-supplied) ${out.entry.description}`] : []),
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
 * Resolve one package name. Never throws for bad input or bad network: the outcome's
 * `text` is always a plain message. `ecosystem` restricts the lookup to one registry.
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
  opts: { ecosystem?: Ecosystem; now?: () => Date; warn?: (message: string) => void } = {},
): Promise<ResolveOutcome> {
  const name = rawName.trim();
  const folded = name.toLowerCase(); // the registry's fold()
  const attempts: string[] = [];
  const fail = (): ResolveOutcome => ({ name, ok: false, candidates: [], attempts, text: couldNotResolveMessage(name, attempts) });
  const now = opts.now ?? (() => new Date());

  const nameErrors: Record<Ecosystem, string | undefined> = { npm: npmNameError(folded), pypi: pypiNameError(name) };
  if (nameErrors.npm !== undefined && nameErrors.pypi !== undefined) {
    attempts.push(`"${name}" is not a valid npm or PyPI package name; nothing was fetched`);
    return fail();
  }
  if (!takeResolutionSlot(now().getTime())) {
    attempts.push(`resolution limit reached (${MAX_RESOLUTIONS_PER_HOUR} per hour per process); try again later, or pin the library`);
    return fail();
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
    const metadataUrl = metadataUrlFor(eco, eco === "npm" ? folded : name);
    fetched += 1;
    const { json, why } = await fetchMetadata(metadataUrl);
    if (json === undefined) {
      attempts.push(`${label}: no metadata (${why})`);
      continue;
    }
    const meta = eco === "npm" ? parseNpmMetadata(json, metadataUrl) : parsePyPiMetadata(json, metadataUrl);
    if (eco === "npm" && isNpmPlaceholder(meta)) {
      attempts.push("npm: name is held by npm's security-holder placeholder (no package)");
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
  if (order.length === 0) return fail();

  // Phase 2: probe each found ecosystem's candidates in order; the first usable document wins.
  let budget = MAX_FETCHES_PER_RESOLUTION - fetched;
  for (const { eco, meta, candidates } of order) {
    const urls = candidates.slice(0, Math.max(0, budget)); // the hard ceiling; structurally never binding
    budget -= urls.length;
    if (urls.length === 0) break;
    // PyPI names are keyed by their PEP 503 form (L3): typing_extensions and Typing-Extensions are one record.
    const entryName = eco === "pypi" ? normalisePyPiName(name) : folded;
    const entry = buildEntry(entryName, meta, urls, now());
    const doc = await getLibraryDoc(entry, { forceRefresh: true });
    if (!doc) {
      attempts.push(
        `${LABEL[eco]} metadata found (${describeMeta(meta)}); none of ${urls.length} candidate URLs served a document: ${urls.join(", ")}`,
      );
      continue;
    }
    let saveNote: string | undefined;
    const saved = saveResolvedEntry(entry, (m) => {
      saveNote = m.replace(/^vibectx: not saving "[^"]*" — /, "").trim();
      (opts.warn ?? ((x: string) => process.stderr.write(x)))(m);
    });
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
      entry,
      saved,
      saveNote,
      attempts,
      text: "",
    };
    out.text = formatResolved(out);
    return out;
  }
  return fail();
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
 */
export async function resolveToolText(registry: Registry, name: string, ecosystem?: Ecosystem): Promise<string> {
  // S2: judge "already curated" on the folded key too, so an exact-case resolved entry
  // sitting beside a curated one ("React" next to "react") cannot slip past.
  const existing = lookupLibrary(registry, name);
  const curated = existing && !existing.resolved ? existing : lookupLibrary(registry, name.trim().toLowerCase());
  if (curated && !curated.resolved) {
    const existingCurated = curated;
    return [
      `"${name}" is already in the registry as "${existingCurated.name}" — nothing to resolve.`,
      "  urls (probed in order):",
      ...existingCurated.urls.map((u, i) => `    ${i + 1}. ${u}`),
      `  Use get_docs("${existingCurated.name}"); override the entry in vibectx.config.json to change its sources.`,
    ].join("\n");
  }
  const out = await resolvePackage(name, { ecosystem });
  if (out.ok && out.entry) installResolvedEntry(registry, out.entry); // refuses a curated key (S2); replaces a resolved one
  return out.text;
}
