import { createRequire } from "node:module";

/**
 * One source of truth for the product's version: the package manifest.
 *
 * It was written down twice before this (the `McpServer` name/version in `src/server.ts`
 * and the user-agent in `src/fetcher.ts`), which is one place too many — a release bumps
 * `package.json` and the two literals drift silently, so a client asking the server what it
 * is talking to gets an answer that used to be true.
 *
 * `createRequire(import.meta.url)` resolves `../package.json` relative to THIS module, and
 * the layout makes that the same file in both places it has to work:
 *   - installed from npm, `dist/version.js` sits one level under the package root, beside
 *     which `package.json` always ships (npm includes it regardless of `files`);
 *   - in a source checkout under vitest, `src/version.ts` is one level under the repo root.
 * A JSON import assertion would be the modern spelling, but its syntax is still unstable
 * across the Node versions this package supports (>=18), and `createRequire` is not.
 *
 * The fallback exists so a manifest that somehow cannot be read degrades to an obviously
 * wrong version rather than throwing at import time and taking the server down with it.
 */
const manifest = createRequire(import.meta.url)("../package.json") as { version?: unknown };

export const VERSION: string = typeof manifest.version === "string" && manifest.version.length > 0 ? manifest.version : "0.0.0-unknown";

/** The user-agent every outbound request carries. Same version, by construction. */
export const USER_AGENT = `vibectx/${VERSION} (+https://github.com/BlackRaptorAI/VibeCTX)`;
