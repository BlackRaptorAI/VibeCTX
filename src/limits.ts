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
/** Candidate URLs one resolved entry may carry (= one ecosystem's full probe list). */
export const MAX_URLS_PER_ENTRY = MAX_LLMS_CANDIDATES + MAX_README_CANDIDATES;
/** Hard ceiling on requests one resolution may issue: both metadata documents, then the
 *  preferred ecosystem's candidates and — if none served — the other's (R2). */
export const MAX_FETCHES_PER_RESOLUTION = MAX_METADATA_FETCHES + MAX_METADATA_FETCHES * MAX_URLS_PER_ENTRY;
/** Resolutions (name validated, metadata about to be fetched) one process may start per hour. */
export const MAX_RESOLUTIONS_PER_HOUR = 100;
