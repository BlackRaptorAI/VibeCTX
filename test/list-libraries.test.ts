import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeCache } from "../src/cache.js";
import type { Registry } from "../src/registry.js";
import { listLibrariesText } from "../src/list-libraries.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "vibectx-list-"));
  process.env.DOCS_CACHE_DIR = dir;
});

afterEach(() => {
  delete process.env.DOCS_CACHE_DIR;
  rmSync(dir, { recursive: true, force: true });
});

const registry: Registry = {
  entries: new Map([
    [
      "fastify",
      { name: "fastify", urls: ["https://fastify.dev/llms-full.txt", "https://fastify.dev/llms.txt"], description: "Fastify web framework reference" },
    ],
    ["react", { name: "react", urls: ["https://react.dev/llms-full.txt"], description: "React 19 documentation", ttlHours: 0 }],
    ["pgvector", { name: "pgvector", urls: ["https://raw.githubusercontent.com/pgvector/pgvector/master/README.md"] }],
  ]),
};

describe("listLibrariesText (PAR-707: kind bracket)", () => {
  it("adds a kind bracket after the cache-status bracket, classified from the cached document", () => {
    writeCache("fastify", "https://fastify.dev/llms.txt", "# Fastify\n- [A](/docs/A.md)\n- [B](/docs/B.md)\n- [C](/docs/C.md)");
    writeCache("react", "https://react.dev/llms-full.txt", "# React\n\nProse about hooks.\n\n## useEffect\n\nEffects.");
    const text = listLibrariesText(registry);
    expect(text.startsWith(`Cache dir: ${dir}\n\n`)).toBe(true);
    expect(text).toMatch(/- \*\*fastify\*\* — Fastify web framework reference \[cached \S+\] \[index-only\]/);
    expect(text).toMatch(/- \*\*react\*\* — React 19 documentation \[cached \S+ \(stale\)\] \[full-text\]/);
    expect(text).toMatch(/- \*\*pgvector\*\* —  \[not cached\] \[unknown\]/);
  });

  it("uses the first cached candidate URL for the classification", () => {
    writeCache("fastify", "https://fastify.dev/llms-full.txt", "# Fastify\n\nFull prose reference.\n\n## Server\n\nOptions.");
    writeCache("fastify", "https://fastify.dev/llms.txt", "# Fastify\n- [A](/docs/A.md)\n- [B](/docs/B.md)\n- [C](/docs/C.md)");
    expect(listLibrariesText(registry)).toMatch(/\*\*fastify\*\*.*\[full-text\]/);
  });
});
