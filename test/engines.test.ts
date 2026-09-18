import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * R-1/PAR-829, D-80 (code-reviewer round 3, S-2): `package.json`'s `engines.node` is a
 * hand-copy of `vite`'s own declared range, not derived from it — nothing else would catch a
 * future `vite`/`vitest` bump silently moving that range and leaving `engines.node` wrong
 * again, which is the exact failure this item exists to fix. A drift guard, not a floor check.
 */
function readJson(relativePath: string): { engines?: { node?: string } } {
  return JSON.parse(readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8"));
}

describe("engines.node tracks vite's own declared range", () => {
  it("equals node_modules/vite's engines.node exactly", () => {
    const ours = readJson("../package.json").engines?.node;
    const vite = readJson("../node_modules/vite/package.json").engines?.node;
    expect(vite).toBeDefined(); // the comparison is meaningless if vite ever drops this field
    expect(ours).toBe(vite);
  });
});
