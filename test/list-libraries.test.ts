import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeCache } from "../src/cache.js";
import { loadRegistry, type Registry } from "../src/registry.js";
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

  it("shows aliases briefly after the name, and nothing extra for entries without them (PAR-654)", () => {
    const withAliases: Registry = {
      entries: new Map([
        ["next.js", { name: "next.js", urls: ["https://nextjs.org/llms.txt"], description: "Next.js", aliases: ["next", "nextjs"] }],
        ["hono", { name: "hono", urls: ["https://hono.dev/llms.txt"], description: "Hono", aliases: [] }],
        ["zod", { name: "zod", urls: ["https://zod.dev/llms.txt"], description: "Zod" }],
      ]),
    };
    const text = listLibrariesText(withAliases);
    expect(text).toMatch(/- \*\*next\.js\*\* \(aka next, nextjs\) — Next\.js \[not cached\] \[unknown\]/);
    expect(text).toMatch(/- \*\*hono\*\* — Hono \[not cached\]/);
    expect(text).toMatch(/- \*\*zod\*\* — Zod \[not cached\]/);
    expect(text).not.toMatch(/hono\*\* \(aka/);
  });

  it("D-06: after a config claims a default alias as its name, that alias leaves the default's aka list", () => {
    const config = join(dir, "vibectx.config.json");
    writeFileSync(config, JSON.stringify({ libraries: [{ name: "next", urls: ["https://example.com/next.txt"] }] }), "utf8");
    const text = listLibrariesText(loadRegistry(config));
    expect(text).toMatch(/- \*\*next\.js\*\* \(aka nextjs\) — /);
    expect(text).not.toMatch(/aka next,/);
    expect(text).toMatch(/- \*\*next\*\* —  \[not cached\]/);
  });

  it("uses the first cached candidate URL for the classification", () => {
    writeCache("fastify", "https://fastify.dev/llms-full.txt", "# Fastify\n\nFull prose reference.\n\n## Server\n\nOptions.");
    writeCache("fastify", "https://fastify.dev/llms.txt", "# Fastify\n- [A](/docs/A.md)\n- [B](/docs/B.md)\n- [C](/docs/C.md)");
    expect(listLibrariesText(registry)).toMatch(/\*\*fastify\*\*.*\[full-text\]/);
  });

  it("marks resolved entries with [resolved] after the kind bracket (PAR-655)", () => {
    const withResolved: Registry = {
      entries: new Map([
        ["zod", { name: "zod", urls: ["https://zod.dev/llms.txt"], description: "Zod" }],
        [
          "elysia",
          {
            name: "elysia",
            urls: ["https://elysiajs.com/llms.txt"],
            description: "Ergonomic framework",
            resolved: { source: "npm", resolvedAt: "2026-09-06T00:00:00.000Z", metadataUrl: "https://registry.npmjs.org/elysia/latest" },
          },
        ],
      ]),
    };
    const text = listLibrariesText(withResolved);
    expect(text).toMatch(/- \*\*zod\*\* — Zod \[not cached\] \[unknown\]$/m);
    expect(text).toMatch(/- \*\*elysia\*\* — \(package-supplied\) Ergonomic framework \[not cached\] \[unknown\] \[resolved\]$/m);
  });
});

import { writeProjectRecord } from "../src/project-store.js";

describe("listLibrariesText (PAR-656: warming… marker and project line)", () => {
  it("appends warming… inside the status bracket for entries the startup autowarm has in flight", () => {
    writeCache("react", "https://react.dev/llms-full.txt", "# React\n\nProse.");
    const text = listLibrariesText(registry, { warming: new Set(["react", "pgvector"]), projectDir: dir });
    expect(text).toMatch(/- \*\*react\*\* — React 19 documentation \[cached \S+ \(stale\), warming…\] \[full-text\]/);
    expect(text).toMatch(/- \*\*pgvector\*\* —  \[not cached, warming…\] \[unknown\]/);
    expect(text).toMatch(/- \*\*fastify\*\* — Fastify web framework reference \[not cached\] \[unknown\]/);
  });

  it("ends with one project-deps line when a warm record exists for the working directory, and with nothing extra otherwise", () => {
    const without = listLibrariesText(registry, { projectDir: dir, warming: new Set() });
    expect(without).not.toContain("Project deps");
    writeProjectRecord({
      schemaVersion: 1,
      dir,
      manifests: ["package.json"],
      dependencies: [
        { name: "react", ecosystem: "npm", source: "package.json", library: "react", status: "cached", url: "https://react.dev/llms-full.txt" },
        { name: "zz", ecosystem: "npm", source: "package.json", status: "unresolved" },
        { name: "eslint", ecosystem: "npm", source: "package.json", status: "denied (noise list)" },
      ],
      warmedAt: "2026-09-06T06:00:00.000Z",
    });
    const text = listLibrariesText(registry, { projectDir: dir, warming: new Set() });
    const lines = text.split("\n");
    expect(lines[lines.length - 1]).toBe(`Project deps (${dir}): 1 cached, 1 unresolved, 1 denied — warmed 2026-09-06T06:00:00.000Z`);
    expect(lines[lines.length - 2]).toBe("");
    expect(text.match(/Project deps/g)).toHaveLength(1);
  });

  it("defaults to process.cwd() for the project line and the live autowarm set for the marker", () => {
    const cwd = vi.spyOn(process, "cwd").mockReturnValue(dir);
    try {
      writeProjectRecord({ schemaVersion: 1, dir, manifests: ["package.json"], dependencies: [], warmedAt: "2026-09-06T06:00:00.000Z" });
      expect(listLibrariesText(registry)).toContain(`Project deps (${dir}): 0 cached, 0 unresolved, 0 denied`);
    } finally {
      cwd.mockRestore();
    }
  });
});
