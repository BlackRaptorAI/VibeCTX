import { describe, it, expect } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { VERSION, USER_AGENT, UNKNOWN_VERSION, versionFrom } from "../src/version.js";
import { buildServer } from "../src/server.js";
import type { Registry } from "../src/registry.js";

/**
 * PAR-652 item 6: the version was hard-coded in two places (`src/server.ts` and the
 * user-agent in `src/fetcher.ts`) and had already drifted once. There is one source of
 * truth — the package manifest — and this file pins every consumer to it by reading the
 * manifest independently rather than by comparing two constants to each other.
 */

const MANIFEST = fileURLToPath(new URL("../package.json", import.meta.url));
const manifestVersion = (JSON.parse(readFileSync(MANIFEST, "utf8")) as { version: string }).version;

const emptyRegistry = (): Registry => ({ entries: new Map() });

describe("the version is read from package.json, never written twice", () => {
  it("VERSION equals the manifest's version", () => {
    expect(manifestVersion).toMatch(/^\d+\.\d+\.\d+/); // the manifest itself is sane
    expect(VERSION).toBe(manifestVersion);
  });

  it("the advertised MCP server version equals package.json's version", async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = buildServer(emptyRegistry());
    await server.connect(serverTransport);
    const client = new Client({ name: "probe", version: "0" });
    await client.connect(clientTransport);
    expect(client.getServerVersion()).toEqual({ name: "vibectx", version: manifestVersion });
    await client.close();
  });

  it("the user-agent carries that same version", () => {
    expect(USER_AGENT).toContain(`vibectx/${manifestVersion}`);
    expect(USER_AGENT).toBe(`vibectx/${manifestVersion} (+https://github.com/BlackRaptorAI/VibeCTX)`);
  });

  it("no source file hard-codes a version string of its own", async () => {
    // The defect this closes: `src/server.ts` said 0.1.3 while the manifest could move.
    const { readdirSync } = await import("node:fs");
    const srcDir = fileURLToPath(new URL("../src", import.meta.url));
    const offenders: string[] = [];
    for (const name of readdirSync(srcDir)) {
      if (!name.endsWith(".ts") || name === "version.ts") continue;
      const text = readFileSync(`${srcDir}/${name}`, "utf8");
      for (const line of text.split("\n")) {
        if (line.trimStart().startsWith("*") || line.trimStart().startsWith("//")) continue; // prose may cite an old release
        if (/\bversion\s*:\s*["'`]\d+\.\d+\.\d+/.test(line) || /vibectx\/\d+\.\d+\.\d+/.test(line)) {
          offenders.push(`${name}: ${line.trim()}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

/**
 * PAR-652c review R2. The docstring promised a `0.0.0-unknown` fallback "so a manifest that
 * somehow cannot be read degrades … rather than throwing at import time and taking the server
 * down with it" — and the `require` was unguarded, so it did exactly the thing the comment
 * denied. These cases use a REAL `createRequire` rooted in a directory with no manifest above
 * it, so the guard is proven against a real `MODULE_NOT_FOUND` rather than a stubbed thrower.
 */
describe("an unreadable manifest degrades the version — it never kills the process", () => {
  /** A directory whose parent holds no package.json, plus one whose parent holds a bad one. */
  function rootedAt(parentManifest?: string): { load: (s: string) => unknown; dir: string } {
    const dir = mkdtempSync(join(tmpdir(), "vibectx-manifest-"));
    const pkgDir = join(dir, "pkg");
    mkdirSync(pkgDir, { recursive: true });
    if (parentManifest !== undefined) writeFileSync(join(dir, "package.json"), parentManifest, "utf8");
    return { load: createRequire(pathToFileURL(join(pkgDir, "version.js"))), dir };
  }

  it("the unguarded require really does throw — this is the failure being guarded", () => {
    const { load, dir } = rootedAt();
    try {
      expect(() => load("../package.json")).toThrowError(/Cannot find module/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a missing manifest yields 0.0.0-unknown instead of throwing at import", () => {
    const { load, dir } = rootedAt();
    try {
      expect(versionFrom(load)).toBe(UNKNOWN_VERSION);
      expect(UNKNOWN_VERSION).toBe("0.0.0-unknown");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("an unparsable manifest yields 0.0.0-unknown", () => {
    const { load, dir } = rootedAt("{not json");
    try {
      expect(versionFrom(load)).toBe(UNKNOWN_VERSION);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a manifest with no version, an empty one, or a non-string one falls back too", () => {
    for (const body of ['{"name":"x"}', '{"version":""}', '{"version":3}', '{"version":null}']) {
      const { load, dir } = rootedAt(body);
      try {
        expect(versionFrom(load)).toBe(UNKNOWN_VERSION);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it("a readable manifest still wins — the guard costs the good case nothing", () => {
    const { load, dir } = rootedAt('{"version":"9.9.9-test"}');
    try {
      expect(versionFrom(load)).toBe("9.9.9-test");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
