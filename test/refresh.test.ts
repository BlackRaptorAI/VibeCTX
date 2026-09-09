import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readCache, writeCache } from "../src/cache.js";
import type { Registry } from "../src/registry.js";
import { refreshToolText, resetFullRefreshWindow } from "../src/refresh.js";
import { documentHash, indexCachedDocument, readIndex, resetSearchIndexMemo } from "../src/search-index.js";
import { runSearch } from "../src/search.js";
import { MAX_FULL_REFRESHES_PER_HOUR } from "../src/limits.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "vibectx-refresh-"));
  process.env.VIBECTX_CACHE_DIR = dir;
  resetSearchIndexMemo();
  resetFullRefreshWindow();
});

afterEach(() => {
  delete process.env.VIBECTX_CACHE_DIR;
  rmSync(dir, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

function stubFetch(pages: Record<string, string>) {
  const spy = vi.fn(async (url: unknown) => {
    const body = pages[String(url)];
    if (body === undefined) return new Response("not found", { status: 404 });
    return new Response(body, { status: 200, headers: { "content-type": "text/plain" } });
  });
  vi.stubGlobal("fetch", spy);
  return spy;
}

const REACT_URL = "https://react.dev/llms-full.txt";
const HONO_URL = "https://hono.dev/llms.txt";
const registry: Registry = {
  entries: new Map([
    ["react", { name: "react", urls: [REACT_URL], aliases: ["reactjs"] }],
    ["hono", { name: "hono", urls: [HONO_URL] }],
  ]),
};

describe("refreshToolText (MCP refresh tool body, PAR-654)", () => {
  it("refreshes the canonical entry when given an alias, bypassing a fresh cache", async () => {
    writeCache("react", REACT_URL, "# React old");
    const spy = stubFetch({ [REACT_URL]: "# React new" });
    const out = await refreshToolText(registry, "reactjs");
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(REACT_URL, expect.anything());
    expect(out).toBe(`react: refreshed from ${REACT_URL} (11 chars)`);
    expect(readCache("react", REACT_URL, 168)?.content).toBe("# React new");
  });

  it("refreshes every library when no name is given, one line each, and reports failures", async () => {
    stubFetch({ [REACT_URL]: "# React new" }); // hono 404s
    const out = await refreshToolText(registry);
    expect(out.split("\n")).toEqual([
      `react: refreshed from ${REACT_URL} (11 chars)`,
      "hono: FAILED — all candidate URLs unreachable",
    ]);
  });

  it("an unknown library returns the Unknown-library text listing canonical names, without fetching (refresh never resolves)", async () => {
    const spy = stubFetch({});
    expect(await refreshToolText(registry, "nope")).toBe('Unknown library "nope". Known: react, hono');
    expect(spy).not.toHaveBeenCalled();
  });

  it("re-resolves a resolved entry through its ecosystem instead of only refetching its urls (PAR-655)", async () => {
    const resolvedHono = {
      name: "hono",
      urls: ["https://hono.dev/llms.txt", "https://raw.githubusercontent.com/honojs/hono/main/README.md"],
      resolved: { source: "npm" as const, resolvedAt: "2026-09-06T00:00:00.000Z", metadataUrl: "https://registry.npmjs.org/hono/latest", homepage: "https://hono.dev/" },
    };
    const reg: Registry = { entries: new Map([["hono", resolvedHono]]) };
    const spy = stubFetch({
      "https://registry.npmjs.org/hono/latest": JSON.stringify({ homepage: "https://hono.dev", repository: "https://github.com/honojs/hono" }),
      "https://hono.dev/llms-full.txt": "# Hono full",
    });
    const out = await refreshToolText(reg, "hono");
    expect(spy.mock.calls[0][0]).toBe("https://registry.npmjs.org/hono/latest");
    expect(out).toBe("hono: re-resolved via npm — refreshed from https://hono.dev/llms-full.txt (11 chars)");
    // The live registry now carries the new candidate list (llms-full.txt was learned).
    expect(reg.entries.get("hono")?.urls[0]).toBe("https://hono.dev/llms-full.txt");
    expect(readCache("hono", "https://hono.dev/llms-full.txt", 168)?.content).toBe("# Hono full");
  });

  it("reports a resolved entry whose re-resolution fails, keeping the old entry", async () => {
    const resolvedHono = {
      name: "hono",
      urls: ["https://hono.dev/llms.txt"],
      resolved: { source: "npm" as const, resolvedAt: "2026-09-06T00:00:00.000Z", metadataUrl: "https://registry.npmjs.org/hono/latest" },
    };
    const reg: Registry = { entries: new Map([["hono", resolvedHono]]) };
    stubFetch({});
    const out = await refreshToolText(reg, "hono");
    expect(out).toMatch(/^hono: FAILED — Could not resolve "hono": npm: no metadata/);
    expect(reg.entries.get("hono")).toBe(resolvedHono);
  });

  /**
   * PAR-659 · D-34 — the done-when case: `refresh` invalidates that library's search-index
   * entry. Both halves are pinned, because only the pair is safe: a SUCCESSFUL refresh leaves
   * the entry rebuilt against the new text, and a FAILED one leaves it gone rather than
   * describing a document the cache no longer matches.
   */
  it("PAR-659 D-34: refresh invalidates the library's search-index entry and rebuilds it from the refreshed text", async () => {
    writeCache("react", REACT_URL, "# React old");
    indexCachedDocument("react", REACT_URL, "# React old", "2026-09-06T00:00:00.000Z");
    indexCachedDocument("hono", HONO_URL, "# Hono", "2026-09-06T00:00:00.000Z");
    expect(readIndex().libraries.get("react")!.hash).toBe(documentHash("# React old"));

    stubFetch({ [REACT_URL]: "# React new" });
    await refreshToolText(registry, "reactjs");

    const after = readIndex().libraries;
    expect(after.get("react")!.hash).toBe(documentHash("# React new")); // rebuilt, not stale
    expect(after.get("hono")!.hash).toBe(documentHash("# Hono")); // every other library untouched
  });

  it("PAR-659 R1: a SUCCESSFUL refresh of a RESOLVED entry rebuilds the index — it used to leave it deleted", async () => {
    // The missing hook the review gate found: this branch invalidated the entry and then
    // returned through `resolvePackage`, which had no index hook of its own — so a refresh
    // that WORKED left the library unindexed until something else happened to rewrite it, and
    // every search until then re-tokenized it.
    const resolvedHono = {
      name: "hono",
      urls: [HONO_URL],
      resolved: { source: "npm" as const, resolvedAt: "2026-09-06T00:00:00.000Z", metadataUrl: "https://registry.npmjs.org/hono/latest" },
    };
    const reg: Registry = { entries: new Map([["hono", resolvedHono]]) };
    indexCachedDocument("hono", HONO_URL, "# Hono old", "2026-09-06T00:00:00.000Z");
    stubFetch({
      "https://registry.npmjs.org/hono/latest": JSON.stringify({ homepage: "https://hono.dev" }),
      "https://hono.dev/llms-full.txt": "# Hono new\n\n## Streaming\n\nStream events to the client.",
    });

    const out = await refreshToolText(reg, "hono");
    expect(out).toMatch(/^hono: re-resolved via npm/);
    const entry = readIndex().libraries.get("hono")!;
    expect(entry.hash).toBe(documentHash("# Hono new\n\n## Streaming\n\nStream events to the client."));
    expect(entry.url).toBe("https://hono.dev/llms-full.txt");

    // …and the first search after it costs no tokenizing at all.
    resetSearchIndexMemo();
    expect(runSearch(reg, { query: "streaming events" }).tokenized).toBe(0);
  });

  it("PAR-659 D-34: a refresh that FAILS leaves the entry invalidated rather than stale", async () => {
    // An index entry left over from an earlier session whose cached document is gone: exactly
    // the state that must not survive a failed refresh.
    indexCachedDocument("hono", HONO_URL, "# Hono", "2026-09-06T00:00:00.000Z");
    indexCachedDocument("react", REACT_URL, "# React", "2026-09-06T00:00:00.000Z");
    stubFetch({}); // every candidate 404s

    expect(await refreshToolText(registry, "hono")).toBe("hono: FAILED — all candidate URLs unreachable");
    expect([...readIndex().libraries.keys()]).toEqual(["react"]);
  });

  it("S2: a hostile resolved entry under an exact-case key cannot make refresh overwrite the curated `react`", async () => {
    const curated = { name: "react", urls: [REACT_URL] };
    const hostile = {
      name: "React",
      urls: ["https://evil.example.com/react.txt"],
      resolved: { source: "npm" as const, resolvedAt: "2026-09-06T00:00:00.000Z", metadataUrl: "https://registry.npmjs.org/react/latest" },
    };
    const reg: Registry = { entries: new Map([["react", curated], ["React", hostile]]) };
    stubFetch({
      "https://registry.npmjs.org/react/latest": JSON.stringify({ homepage: "https://evil.example.com" }),
      "https://evil.example.com/llms.txt": "# evil",
    });
    const out = await refreshToolText(reg, "React");
    expect(out).toBe('React: not replaced — "react" is a curated entry (default, config or alias); a resolved record cannot override it');
    expect(reg.entries.get("react")).toBe(curated);
    expect(readCache("react", REACT_URL, 168)).toBeUndefined();
  });

  it("A4: a corrupt .meta.json on the entry being refreshed no longer crashes refresh (audit finding 4.5: refresh.ts:51 was unguarded and untested)", async () => {
    writeCache("react", REACT_URL, "# React old");
    const metaPath = join(dir, "react", `${REACT_URL.replace(/[^a-z0-9]/gi, "_")}.meta.json`);
    writeFileSync(metaPath, "{ not json", "utf8");
    stubFetch({ [REACT_URL]: "# React new" });
    await expect(refreshToolText(registry, "reactjs")).resolves.toBe(`react: refreshed from ${REACT_URL} (11 chars)`);
    expect(readCache("react", REACT_URL, 168)?.content).toBe("# React new"); // the corrupt meta was silently discarded, not fatal
  });

  describe("A3 (PAR-716) · the full-refresh rate cap", () => {
    it("a second full refresh inside the cap window is refused, with a stated reason", async () => {
      stubFetch({ [REACT_URL]: "# React new", [HONO_URL]: "# Hono new" });
      for (let i = 0; i < MAX_FULL_REFRESHES_PER_HOUR; i++) {
        const out = await refreshToolText(registry);
        expect(out).not.toMatch(/refresh limit reached/);
      }
      const spy = stubFetch({ [REACT_URL]: "# React new", [HONO_URL]: "# Hono new" });
      const out = await refreshToolText(registry);
      expect(out).toBe(
        `refresh limit reached (${MAX_FULL_REFRESHES_PER_HOUR} full refreshes per hour per process); try again later, or refresh one library at a time`,
      );
      expect(spy).not.toHaveBeenCalled(); // refused before any network attempt, not after
    });

    it("single-library refresh stays uncapped — only the no-argument (full) form is limited", async () => {
      stubFetch({ [REACT_URL]: "# React new", [HONO_URL]: "# Hono new" });
      for (let i = 0; i < MAX_FULL_REFRESHES_PER_HOUR; i++) await refreshToolText(registry);
      const spy = stubFetch({ [REACT_URL]: "# React newer" });
      const out = await refreshToolText(registry, "reactjs");
      expect(out).toBe(`react: refreshed from ${REACT_URL} (13 chars)`);
      expect(spy).toHaveBeenCalled();
    });
  });

  describe("A3 (PAR-716) · dropping the followed-page cache on a successful refresh", () => {
    const FOLLOWED_URL = "https://react.dev/streaming.md";

    it("a successful refresh drops every OTHER cached page for that library — fetched under the primary this refresh just replaced", async () => {
      writeCache("react", REACT_URL, "# React old");
      writeCache("react", FOLLOWED_URL, "# Streaming (followed under the old primary)");
      writeCache("hono", HONO_URL, "# Hono unrelated"); // a different library's cache: untouched either way
      expect(readCache("react", FOLLOWED_URL, 168)?.content).toBeDefined();

      stubFetch({ [REACT_URL]: "# React new" });
      await refreshToolText(registry, "reactjs");

      expect(readCache("react", FOLLOWED_URL, 168)).toBeUndefined(); // dropped
      expect(readCache("react", REACT_URL, 168)?.content).toBe("# React new"); // the fresh primary survives
      expect(readCache("hono", HONO_URL, 168)?.content).toBe("# Hono unrelated"); // another library, untouched
    });

    it("a refresh with NOTHING cached and no candidate reachable is FAILED outright — nothing to drop", async () => {
      stubFetch({}); // react 404s everywhere, no prior cache to fall back on
      const out = await refreshToolText(registry, "reactjs");
      expect(out).toBe("react: FAILED — all candidate URLs unreachable");
    });

    it("a refresh that falls back to STALE cache (every candidate unreachable, but a prior cache exists) does NOT drop the followed-page cache — the primary itself did not change", async () => {
      writeCache("react", REACT_URL, "# React old");
      writeCache("react", FOLLOWED_URL, "# Streaming");
      stubFetch({}); // every candidate URL 404s; getLibraryDoc falls back to serving the old cache, staleNote set

      const out = await refreshToolText(registry, "reactjs");

      expect(out).toBe(`react: refreshed from ${REACT_URL} (11 chars)`); // reports "refreshed" — the entry is rebuilt from the SAME stale content, not deleted
      expect(readCache("react", REACT_URL, 168)?.content).toBe("# React old"); // unchanged
      expect(readCache("react", FOLLOWED_URL, 168)?.content).toBe("# Streaming"); // untouched — nothing about the primary changed
    });

    it("a successful re-resolution of a RESOLVED entry also drops its old followed-page cache, keyed off the new chosen URL", async () => {
      const resolvedHono = {
        name: "hono",
        urls: [HONO_URL],
        resolved: { source: "npm" as const, resolvedAt: "2026-09-06T00:00:00.000Z", metadataUrl: "https://registry.npmjs.org/hono/latest" },
      };
      const reg: Registry = { entries: new Map([["hono", resolvedHono]]) };
      writeCache("hono", HONO_URL, "# Hono old");
      const oldFollowed = "https://hono.dev/old-followed.md";
      writeCache("hono", oldFollowed, "# Old followed page");
      stubFetch({
        "https://registry.npmjs.org/hono/latest": JSON.stringify({ homepage: "https://hono.dev" }),
        "https://hono.dev/llms-full.txt": "# Hono new",
      });

      const out = await refreshToolText(reg, "hono");

      expect(out).toMatch(/^hono: re-resolved via npm/);
      expect(readCache("hono", oldFollowed, 168)).toBeUndefined(); // dropped
      expect(readCache("hono", "https://hono.dev/llms-full.txt", 168)?.content).toBe("# Hono new"); // the new primary survives
    });
  });
});
