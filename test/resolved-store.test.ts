import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readResolvedEntries,
  saveResolvedEntry,
  resolvedStorePath,
  toResolvedEntry,
  cleanDescription,
  RESOLVED_SCHEMA_VERSION,
} from "../src/resolved-store.js";
import { MAX_URLS_PER_ENTRY, MAX_LLMS_CANDIDATES, MAX_README_CANDIDATES } from "../src/limits.js";
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

  it("caps and single-lines the description, and caps the number of urls at the resolver bound (K1)", () => {
    expect(MAX_URLS_PER_ENTRY).toBe(MAX_LLMS_CANDIDATES + MAX_README_CANDIDATES);
    const e = toResolvedEntry({
      name: "hono",
      urls: Array.from({ length: MAX_URLS_PER_ENTRY + 1 }, (_, i) => `https://hono.dev/${i}.txt`),
      description: `line one\nline two ${"x".repeat(500)}`,
      resolved: hono.resolved,
    });
    expect(e?.urls).toHaveLength(MAX_URLS_PER_ENTRY);
    expect(e?.description).not.toContain("\n");
    expect(e?.description?.length).toBeLessThanOrEqual(200);
  });

  it("round-trips an entry with the full 12-URL candidate list intact (K1)", () => {
    const urls = Array.from({ length: MAX_URLS_PER_ENTRY }, (_, i) => `https://hono.dev/c${i}/llms.txt`);
    saveResolvedEntry({ ...hono, urls });
    expect(readResolvedEntries()[0].urls).toEqual(urls);
    expect(urls).toHaveLength(12);
  });

  it("S2: rejects a record whose name is not already trimmed and lower-cased (a planted `React` cannot shadow `react`)", () => {
    for (const name of ["React", "NextJS", " hono", "hono ", "Next.js", "HTTPX"]) {
      expect(toResolvedEntry({ name, urls: hono.urls, resolved: hono.resolved }), name).toBeUndefined();
    }
    expect(toResolvedEntry({ name: "next.js", urls: hono.urls, resolved: hono.resolved })?.name).toBe("next.js");
  });

  it("K2: does not overwrite a resolved.json of another schema version; the save is refused with a note", () => {
    const foreign = JSON.stringify({ schemaVersion: 2, entries: [{ future: true }] });
    writeFileSync(join(dir, "resolved.json"), foreign, "utf8");
    const notes: string[] = [];
    expect(saveResolvedEntry(hono, (m) => notes.push(m))).toBe(false);
    expect(readFileSync(join(dir, "resolved.json"), "utf8")).toBe(foreign);
    expect(notes.join("")).toMatch(/schemaVersion 2/);
    // A corrupt (unparseable) file is not "another version": it is replaced.
    writeFileSync(join(dir, "resolved.json"), "{{{", "utf8");
    expect(saveResolvedEntry(hono, (m) => notes.push(m))).toBe(true);
    expect(readResolvedEntries()).toEqual([hono]);
  });

  it("L1: cleanDescription strips bidi and zero-width characters as well as control characters", () => {
    expect(cleanDescription("\u202Eevil\u200B text\u2066\u2069\u200F\u200D ok\u0007")).toBe("evil text ok");
    expect(cleanDescription("\u200B\u200B")).toBeUndefined();
  });

  it("refuses to save an entry that is not a resolved entry", () => {
    expect(() => saveResolvedEntry({ name: "hono", urls: ["https://hono.dev/llms.txt"] })).toThrow(/resolved/);
    expect(existsSync(join(dir, "resolved.json"))).toBe(false);
  });
});

describe("K2 (PAR-656) — resolved.json upgrade policy aligned with the project store", () => {
  it("a LOWER schemaVersion is replaced on save without a note; a HIGHER one stays protected", () => {
    writeFileSync(join(dir, "resolved.json"), JSON.stringify({ schemaVersion: 0, entries: [] }), "utf8");
    const notes: string[] = [];
    expect(saveResolvedEntry(hono, (m) => notes.push(m))).toBe(true);
    expect(notes).toEqual([]);
    expect(readResolvedEntries()).toEqual([hono]);
    const future = JSON.stringify({ schemaVersion: RESOLVED_SCHEMA_VERSION + 1, entries: [] });
    writeFileSync(join(dir, "resolved.json"), future, "utf8");
    expect(saveResolvedEntry(hono, (m) => notes.push(m))).toBe(false);
    expect(readFileSync(join(dir, "resolved.json"), "utf8")).toBe(future);
    expect(notes.join("")).toMatch(/newer schemaVersion 2/);
  });
});
