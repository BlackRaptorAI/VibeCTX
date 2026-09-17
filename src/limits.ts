/**
 * Resolver bounds (PAR-655), in one place so the store, the resolver and the tests
 * agree. See src/resolve.ts for how each is spent.
 */

/** Registry metadata documents fetched per resolution: npm, then PyPI. */
export const MAX_METADATA_FETCHES = 2;
/** llms-full.txt / llms.txt probes per ecosystem: 2 bases (docs URL, homepage) × 4 URLs. */
export const MAX_LLMS_CANDIDATES = 8;
/** README filename variants tried at GitHub's `HEAD` ref (the default branch, whatever
 *  its name — MEASURED 2026-09-06 on raw.githubusercontent.com). raw is case-sensitive:
 *  express ships `Readme.md`, resend `readme.md`, django `README.rst`. */
export const README_VARIANTS = ["README.md", "readme.md", "Readme.md", "README.rst"] as const;
export const MAX_README_CANDIDATES = README_VARIANTS.length;
/** A11/PAR-724 — tag-name spellings tried at GitHub's `refs/tags/<tag>` ref when a
 *  version is pinned: `v<version>` (the overwhelmingly common convention) and bare
 *  `<version>`. Not a general "usual variants" enumerator — two is what covers the
 *  ordinary case without multiplying the fetch budget further; anything else (a
 *  `<name>@<version>` monorepo tag, say) falls through to the unversioned chain below,
 *  same as an unreachable README always has. */
export const MAX_VERSION_TAG_VARIANTS = 2;
/** README filename variants × tag variants, at GitHub's `refs/tags/<tag>` ref, tried
 *  before the unversioned chain when a version is pinned (A11/PAR-724). */
export const MAX_VERSIONED_README_CANDIDATES = MAX_VERSION_TAG_VARIANTS * README_VARIANTS.length;
/** One extra registry metadata fetch, for the chosen ecosystem only, at the exact pinned
 *  version — separate from MAX_METADATA_FETCHES (which is spent on the unversioned `/latest`
 *  lookup every resolution needs regardless) because it fires only when a version is given
 *  (A11/PAR-724). Narrower purpose than the `/latest` fetch: confirm the version is
 *  registered and read its (possibly different) repository field, not synthesize documents
 *  from it directly. */
export const MAX_VERSION_METADATA_FETCHES = 1;
/** Candidate URLs one resolved entry may carry (= one ecosystem's full probe list, version
 *  candidates included). */
export const MAX_URLS_PER_ENTRY = MAX_LLMS_CANDIDATES + MAX_README_CANDIDATES + MAX_VERSIONED_README_CANDIDATES;
/** Hard ceiling on requests one resolution may issue: both metadata documents, the one
 *  version-specific metadata fetch when a version is pinned, then the preferred ecosystem's
 *  candidates and — if none served — the other's (R2). */
export const MAX_FETCHES_PER_RESOLUTION =
  MAX_METADATA_FETCHES + MAX_VERSION_METADATA_FETCHES + MAX_METADATA_FETCHES * MAX_URLS_PER_ENTRY;
/** Resolutions (name validated, metadata about to be fetched) one process may start per hour. */
export const MAX_RESOLUTIONS_PER_HOUR = 100;

/**
 * Full (no-argument) `refresh` calls one process may start per hour (A3, PAR-716). A no-name
 * `refresh` is model-callable and iterates the whole registry — up to thirty upstream fetches
 * per call, against thirty different documentation sites — with no limit before this. ASSUMED,
 * the same way MAX_RESOLUTIONS_PER_HOUR is: not derived from a cost measurement, a judgement
 * about acceptable retry-loop egress. Set an order of magnitude below the resolver's cap
 * because one call here already costs on the order of MAX_RESOLUTIONS_PER_HOUR/3 site-hits by
 * itself, not one. Single-library `refresh` is uncapped — the concern is bulk egress from the
 * no-argument form, not routine per-library use. */
export const MAX_FULL_REFRESHES_PER_HOUR = 5;

/**
 * `activity.json`'s entry cap (D-51, A20, PAR-729): oldest dropped first once a write would
 * exceed it — see `activity-log.ts`'s own top comment for why this single count also bounds
 * the file's bytes. ASSUMED, the same way `DEFAULT_CACHE_MAX_MB` is: not derived from a
 * measurement of how much history is useful, a judgement about what a local, single-user
 * activity record should cost on disk. MEASURED (`activity-log.ts`): 2,000 entries at every
 * field's worst-case length is ~2.06 MiB, pretty-printed exactly as the file is written.
 */
export const ACTIVITY_LOG_MAX_ENTRIES = 2000;
