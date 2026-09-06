import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { VERSION, USER_AGENT } from "../src/version.js";
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
