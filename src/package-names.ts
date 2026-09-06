/**
 * Package-name validation for the resolver (PAR-655). Names come from agents and
 * the command line and are interpolated into registry URLs, so anything that is
 * not a plausible package name is refused before any network call.
 */

const MAX_NAME_LENGTH = 214;

/** npm: lowercase; optional `@scope/`; each part starts with `[a-z0-9~-]` and continues
 *  with `[a-z0-9._~-]` (no leading `.` or `_`; nothing that needs URL encoding). */
const NPM_PART = "[a-z0-9~-][a-z0-9._~-]*";
const NPM_NAME_RE = new RegExp(`^(@${NPM_PART}/)?${NPM_PART}$`);

/** PEP 508 name grammar (case-insensitive): starts and ends with a letter or digit,
 *  `-`, `_` and `.` allowed inside. */
const PYPI_NAME_RE = /^([a-z0-9]|[a-z0-9][a-z0-9._-]*[a-z0-9])$/i;

/** Why `name` is not a valid npm package name, or undefined when it is. */
export function npmNameError(name: string): string | undefined {
  if (name.length === 0 || name.trim() !== name) return "npm package names cannot be empty or padded";
  if (name.length > MAX_NAME_LENGTH) return `npm package names are at most ${MAX_NAME_LENGTH} characters`;
  if (name !== name.toLowerCase()) return "npm package names are lowercase";
  if (!NPM_NAME_RE.test(name)) return "not a valid npm package name (letters, digits, - _ . ~, optional @scope/)";
  return undefined;
}

/** PEP 503 normalisation: runs of `-`, `_`, `.` become one `-`; lowercase. */
export function normalisePyPiName(name: string): string {
  return name.trim().replace(/[-_.]+/g, "-").toLowerCase();
}

/** Why `name` is not a valid PyPI project name, or undefined when it is. */
export function pypiNameError(name: string): string | undefined {
  if (name.length === 0 || name.trim() !== name) return "PyPI project names cannot be empty or padded";
  if (name.length > MAX_NAME_LENGTH) return `PyPI project names are at most ${MAX_NAME_LENGTH} characters`;
  if (!PYPI_NAME_RE.test(name)) return "not a valid PyPI project name (letters, digits, - _ . ; PEP 508)";
  return undefined;
}

/** Undefined when either ecosystem would accept the name; otherwise one combined reason. */
export function packageNameError(name: string): string | undefined {
  if (npmNameError(name) === undefined || pypiNameError(name) === undefined) return undefined;
  return `"${name}" is not a valid npm or PyPI package name`;
}
