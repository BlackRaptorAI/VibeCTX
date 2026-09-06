import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readResolvedEntries,
  saveResolvedEntry,
  resolvedStorePath,
  toResolvedEntry,
  RESOLVED_SCHEMA_VERSION,
} from "../src/resolved-store.js";
import type { LibraryEntry } from "../src/registry.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "vibectx-resolved-"));
  process.env.DOCS_CACHE_DIR = dir;
});

afterEach(() => {
  delete process.env.DOCS_CACHE_DIR;
  rmSync(dir, { recursive: true, force: true });
});

const hono: LibraryEntry = {
  name: "hono",
  urls: ["https://hono.dev/llms-full.txt", "https://hono.dev/llms.txt", "https://raw.githubusercontent.com/honojs/hono/main/README.md"],
  description: "Web framework built on Web Standards",
  allowedHosts: ["hono.dev", "docs.hono.dev"],
  resolved: {
    source: "npm",
    resolvedAt: "2026-09-06T05:00:00.000Z",
    metadataUrl: "https://registry.npmjs.org/hono/latest",
    homepage: "https://hono.dev/",
  },
};

const httpx: LibraryEntry = {
  name: "httpx",
  urls: ["https://www.python-httpx.org/llms.txt", "https://raw.githubusercontent.com/encode/httpx/master/README.md"],
  allowedHosts: ["github.com", "www.python-httpx.org", "docs.github.com"],
  resolved: {
    source: "pypi",
    resolvedAt: "2026-09-06T05:00:00.000Z",
    metadataUrl: "https://pypi.org/pypi/httpx/json",
    homepage: "https://github.com/encode/httpx",
    docsUrl: "https://www.python-httpx.org/",
  },
};

describe("resolved store (<cacheRoot>/resolved.json)", () => {
  it("lives under the cache root and reads as empty when absent", () => {
    expect(resolvedStorePath()).toBe(join(dir, "resolved.json"));
    expect(readResolvedEntries()).toEqual([]);
  });

  it("round-trips an entry, creating the cache root, and leaves no temp file behind", () => {
    saveResolvedEntry(hono);
    expect(readdirSync(dir)).toEqual(["resolved.json"]);
    const raw = JSON.parse(readFileSync(join(dir, "resolved.json"), "utf8"));
    expect(raw.schemaVersion).toBe(RESOLVED_SCHEMA_VERSION);
    expect(raw.entries).toHaveLength(1);
    expect(raw.entries[0].allowedHosts).toBeUndefined(); // derived on load, never persisted
    expect(readResolvedEntries()).toEqual([hono]);
  });

  it("merges entries by name (last save wins) and keeps the others", () => {
    saveResolvedEntry(hono);
    saveResolvedEntry(httpx);
    saveResolvedEntry({ ...hono, urls: ["https://hono.dev/llms.txt"] });
    const entries = readResolvedEntries();
    expect(entries.map((e) => e.name)).toEqual(["hono", "httpx"]);
    expect(entries[0].urls).toEqual(["https://hono.dev/llms.txt"]);
    expect(entries[1]).toEqual(httpx);
  });

  it("ignores a corrupt file on read and overwrites it on the next save", () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "resolved.json"), "{ not json", "utf8");
    expect(readResolvedEntries()).toEqual([]);
    saveResolvedEntry(hono);
    expect(readResolvedEntries()).toEqual([hono]);
  });

  it("ignores a file of the wrong shape and one with a future schema version", () => {
    writeFileSync(join(dir, "resolved.json"), JSON.stringify([hono]), "utf8");
    expect(readResolvedEntries()).toEqual([]);
    writeFileSync(join(dir, "resolved.json"), JSON.stringify({ schemaVersion: 99, entries: [hono] }), "utf8");
    expect(readResolvedEntries()).toEqual([]);
  });

  it("skips malformed records and keeps the valid ones", () => {
    const record = (e: LibraryEntry) => ({ name: e.name, urls: e.urls, description: e.description, resolved: e.resolved });
    writeFileSync(
      join(dir, "resolved.json"),
      JSON.stringify({
        schemaVersion: 1,
        entries: [
          record(hono),
          null,
          "string",
          { ...record(httpx), name: "https://evil.example/x" }, // invalid package name
          { ...record(httpx), name: "no-urls", urls: [] },
          { ...record(httpx), name: "http-url", urls: ["http://x.example.com/llms.txt"] },
          { ...record(httpx), name: "ip-url", urls: ["https://169.254.169.254/llms.txt"] },
          { ...record(httpx), name: "no-resolved", resolved: undefined },
          { ...record(httpx), name: "bad-source", resolved: { ...httpx.resolved, source: "gem" } },
          { ...record(httpx), name: "bad-meta", resolved: { ...httpx.resolved, metadataUrl: "https://evil.example/pypi/httpx/json" } },
          { ...record(httpx), name: "bad-date", resolved: { ...httpx.resolved, resolvedAt: "yesterday" } },
        ],
      }),
      "utf8",
    );
    expect(readResolvedEntries().map((e) => e.name)).toEqual(["hono"]);
  });

  it("never trusts persisted allowedHosts: they are re-derived from the homepage / docs URL", () => {
    writeFileSync(
      join(dir, "resolved.json"),
      JSON.stringify({
        schemaVersion: 1,
        entries: [{ name: "hono", urls: hono.urls, allowedHosts: ["*.internal", "169.254.169.254", "evil.example.net"], resolved: hono.resolved }],
      }),
      "utf8",
    );
    expect(readResolvedEntries()[0].allowedHosts).toEqual(["hono.dev", "docs.hono.dev"]);
  });

  it("drops a hostile homepage / docsUrl from the record instead of rejecting it, and drops ttlHours / aliases / probeQueries", () => {
    writeFileSync(
      join(dir, "resolved.json"),
      JSON.stringify({
        schemaVersion: 1,
        entries: [
          {
            name: "hono",
            urls: hono.urls,
            ttlHours: 0,
            aliases: ["react"],
            probeQueries: ["x"],
            resolved: { ...hono.resolved, homepage: "http://hono.dev", docsUrl: "https://u:p@hono.dev/docs" },
          },
        ],
      }),
      "utf8",
    );
    const [e] = readResolvedEntries();
    expect(e.resolved?.homepage).toBeUndefined();
    expect(e.resolved?.docsUrl).toBeUndefined();
    expect(e.allowedHosts).toEqual([]);
    expect(e.ttlHours).toBeUndefined();
    expect(e.aliases).toBeUndefined();
    expect(e.probeQueries).toBeUndefined();
  });

  it("caps and single-lines the description, and caps the number of urls at 10", () => {
    const e = toResolvedEntry({
      name: "hono",
      urls: Array.from({ length: 12 }, (_, i) => `https://hono.dev/${i}.txt`),
      description: `line one\nline two ${"x".repeat(500)}`,
      resolved: hono.resolved,
    });
    expect(e?.urls).toHaveLength(10);
    expect(e?.description).not.toContain("\n");
    expect(e?.description?.length).toBeLessThanOrEqual(200);
  });

  it("refuses to save an entry that is not a resolved entry", () => {
    expect(() => saveResolvedEntry({ name: "hono", urls: ["https://hono.dev/llms.txt"] })).toThrow(/resolved/);
    expect(existsSync(join(dir, "resolved.json"))).toBe(false);
  });
});
