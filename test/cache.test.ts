import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, rmSync, readdirSync, readFileSync, writeFileSync, mkdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { readCache, writeCache, touchCache, cacheRoot, toCacheMeta, dropFollowedPageCache, urlSlug } from "../src/cache.js";
import { sweepTempFiles, sweepCacheTempFiles, tempPathFor, SWEEP_MIN_AGE_MS } from "../src/atomic-store.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "docs-cache-test-"));
  process.env.VIBECTX_CACHE_DIR = dir;
});

afterEach(() => {
  delete process.env.VIBECTX_CACHE_DIR;
  rmSync(dir, { recursive: true, force: true });
});

describe("cache", () => {
  it("honors VIBECTX_CACHE_DIR", () => {
    expect(cacheRoot()).toBe(dir);
  });

  it("round-trips content with metadata", () => {
    writeCache("fastify", "https://fastify.dev/llms.txt", "# Fastify docs");
    const hit = readCache("fastify", "https://fastify.dev/llms.txt", 168);
    expect(hit?.content).toBe("# Fastify docs");
    expect(hit?.meta.url).toBe("https://fastify.dev/llms.txt");
    expect(hit?.stale).toBe(false);
  });

  it("misses for unknown urls", () => {
    expect(readCache("fastify", "https://nope.example/x", 168)).toBeUndefined();
  });

  it("marks entries stale past TTL", () => {
    writeCache("react", "https://react.dev/llms.txt", "# React");
    // TTL of zero hours: anything already written is instantly stale.
    const hit = readCache("react", "https://react.dev/llms.txt", 0);
    expect(hit?.stale).toBe(true);
    expect(hit?.content).toBe("# React"); // stale content still served
  });
});

describe("N-6, superseded by A4 — a hostile or missing fetchedAt reads as UNCACHED, not stale-but-served", () => {
  // N-6 originally made an unparsable fetchedAt read as stale (ageMs went NaN, and
  // `!(NaN < x)` is true) rather than fresh forever — better than the alternative, but it
  // still served content under a meta this process could not trust. A4's toCacheMeta
  // supersedes it: any of the four corruption classes (truncated, invalid JSON, wrong
  // shape, hostile fetchedAt) now drops the WHOLE meta, so readCache reports the entry
  // uncached, matching every other corrupt-file case (a torn content/meta pair, PAR-656 S4).
  const URL_ = "https://react.dev/llms.txt";
  const metaPath = () => join(dir, "react", `${URL_.replace(/[^a-z0-9]/gi, "_")}.meta.json`);

  it.each(["yesterday", "", "not-a-date"])("fetchedAt %j → uncached (readCache returns undefined), not silently served", (bad) => {
    writeCache("react", URL_, "# React");
    writeFileSync(metaPath(), JSON.stringify({ url: URL_, fetchedAt: bad }), "utf8");
    expect(readCache("react", URL_, 168)).toBeUndefined();
  });

  it("a missing fetchedAt is uncached too, and a good one is still fresh", () => {
    writeCache("react", URL_, "# React");
    writeFileSync(metaPath(), JSON.stringify({ url: URL_ }), "utf8");
    expect(readCache("react", URL_, 168)).toBeUndefined();
    writeCache("react", URL_, "# React");
    expect(readCache("react", URL_, 168)?.stale).toBe(false);
  });
});

describe("A4 (PAR-717) — toCacheMeta, the four corruption classes", () => {
  const URL_ = "https://react.dev/llms.txt";
  const metaPath = () => join(dir, "react", `${URL_.replace(/[^a-z0-9]/gi, "_")}.meta.json`);
  const contentPath = () => join(dir, "react", `${URL_.replace(/[^a-z0-9]/gi, "_")}.md`);

  it("truncated .meta.json: readCache reports the entry uncached, never throws", () => {
    writeCache("react", URL_, "# React");
    const original = readFileSync(metaPath(), "utf8");
    writeFileSync(metaPath(), original.slice(0, Math.floor(original.length / 2)), "utf8");
    let hit: ReturnType<typeof readCache>;
    expect(() => {
      hit = readCache("react", URL_, 168);
    }).not.toThrow();
    expect(hit).toBeUndefined();
  });

  it("invalid JSON: readCache reports the entry uncached, never throws", () => {
    writeCache("react", URL_, "# React");
    writeFileSync(metaPath(), "{ not json", "utf8");
    let hit: ReturnType<typeof readCache>;
    expect(() => {
      hit = readCache("react", URL_, 168);
    }).not.toThrow();
    expect(hit).toBeUndefined();
  });

  it("wrong shape (valid JSON, wrong type for url/fetchedAt): readCache reports the entry uncached", () => {
    writeCache("react", URL_, "# React");
    writeFileSync(metaPath(), JSON.stringify({ url: 12345, fetchedAt: ["not", "a", "string"] }), "utf8");
    expect(readCache("react", URL_, 168)).toBeUndefined();
    // The content file is untouched — only the meta was corrupted; a fresh write repairs it.
    expect(readFileSync(contentPath(), "utf8")).toBe("# React");
  });

  it("hostile fetchedAt (well-shaped, impossible date): readCache reports the entry uncached", () => {
    writeCache("react", URL_, "# React");
    writeFileSync(metaPath(), JSON.stringify({ url: URL_, fetchedAt: "2026-13-45T06:00:00Z" }), "utf8");
    expect(readCache("react", URL_, 168)).toBeUndefined();
  });

  it("a valid meta with an oversized etag drops only the etag field, not the whole record", () => {
    writeCache("react", URL_, "# React");
    writeFileSync(metaPath(), JSON.stringify({ url: URL_, fetchedAt: new Date().toISOString(), etag: "x".repeat(600) }), "utf8");
    const hit = readCache("react", URL_, 168);
    expect(hit?.content).toBe("# React");
    expect(hit?.meta.etag).toBeUndefined();
  });

  it("a valid meta with a hostile etag (control character) drops only the etag field, not the whole record", () => {
    // S1 (code-reviewer A4 round 2): an etag containing a byte fetch's Headers refuses makes
    // fetchUrl throw at header construction; without a shape check the corrupt etag would be
    // re-read from this same file on every following attempt and pin the entry stale forever.
    writeCache("react", URL_, "# React");
    writeFileSync(metaPath(), JSON.stringify({ url: URL_, fetchedAt: new Date().toISOString(), etag: '"abc\ndef"' }), "utf8");
    const hit = readCache("react", URL_, 168);
    expect(hit?.content).toBe("# React");
    expect(hit?.meta.etag).toBeUndefined();
  });

  it("touchCache on a corrupt meta is a no-op, not a throw — the next readCache still reports it uncached", () => {
    writeCache("react", URL_, "# React");
    writeFileSync(metaPath(), "{ not json", "utf8");
    expect(() => touchCache("react", URL_)).not.toThrow();
    expect(readCache("react", URL_, 168)).toBeUndefined();
  });
});

describe("toCacheMeta — field-level boundaries (S5, code-reviewer A4 round 2)", () => {
  const AT = "2026-09-06T07:00:00.000Z";
  const valid = { url: "https://react.dev/llms.txt", fetchedAt: AT };
  const rejects = (mutate: Record<string, unknown>): void => {
    expect(toCacheMeta({ ...valid, ...mutate })).toBeUndefined();
  };

  it("accepts the valid shape, and only the three documented fields survive", () => {
    const meta = toCacheMeta({ ...valid, etag: '"v1"', extra: "dropped" })!;
    expect(meta).toEqual({ url: valid.url, fetchedAt: AT, etag: '"v1"' });
  });

  it("an own __proto__ key (what JSON.parse produces, unlike an object literal) is data, never a prototype write", () => {
    // Computed-property syntax, matching search-index.test.ts's equivalent regression: this
    // creates an OWN property literally named "__proto__", the shape JSON.parse('{"__proto__":…}')
    // actually produces — a plain `{ __proto__: {...} }` object literal would set the
    // prototype instead and prove nothing.
    const raw = { ...valid, ["__proto__"]: { polluted: true } };
    const meta = toCacheMeta(raw);
    expect(meta).toEqual({ url: valid.url, fetchedAt: AT });
    expect(Object.getPrototypeOf({})).toBe(Object.prototype);
  });

  it("rejects a non-object, an array, or null", () => {
    expect(toCacheMeta(null)).toBeUndefined();
    expect(toCacheMeta("a string")).toBeUndefined();
    expect(toCacheMeta(["array"])).toBeUndefined();
    expect(toCacheMeta(42)).toBeUndefined();
  });

  it("rejects a url that is missing, wrong type, empty, oversized, or unparseable — accepts at exactly the length cap", () => {
    rejects({ url: undefined });
    rejects({ url: 42 });
    rejects({ url: "" });
    rejects({ url: "not a url" });
    const atCap = `https://a.example/${"x".repeat(2048 - "https://a.example/".length)}`;
    expect(atCap.length).toBe(2048);
    expect(toCacheMeta({ ...valid, url: atCap })?.url).toBe(atCap);
    rejects({ url: `${atCap}x` }); // one over
  });

  it("rejects a fetchedAt that is missing, wrong type, or not a strict ISO-8601 UTC instant — accepts at exactly the 9-digit fraction cap", () => {
    rejects({ fetchedAt: undefined });
    rejects({ fetchedAt: 1_757_000_000_000 });
    rejects({ fetchedAt: "2026-09-06" });
    rejects({ fetchedAt: "2026-13-45T06:00:00Z" }); // well-shaped, impossible
    rejects({ fetchedAt: `2020-01-01T00:00:00.${"1".repeat(10)}Z` }); // fraction over 9 digits
    // Both sides of the boundary pinned (security-architect A4 round 2): every other field's
    // cap in this describe block is tested accept-at and reject-past — this one previously
    // tested only the reject side.
    const atCap = `2020-01-01T00:00:00.${"1".repeat(9)}Z`;
    expect(toCacheMeta({ ...valid, fetchedAt: atCap })?.fetchedAt).toBe(atCap);
  });

  it("etag: dropped alone (not the whole record) when empty, oversized, or carrying a byte outside HTTP field-value characters — accepted at exactly the length cap", () => {
    expect(toCacheMeta({ ...valid, etag: "" })?.etag).toBeUndefined();
    const atCap = "x".repeat(512);
    expect(toCacheMeta({ ...valid, etag: atCap })?.etag).toBe(atCap);
    expect(toCacheMeta({ ...valid, etag: `${atCap}x` })?.etag).toBeUndefined(); // one over
    // S1 (code-reviewer A4 round 2): a newline (or any non-printable-ASCII byte) makes `fetch`
    // throw when the etag is next sent as If-None-Match — well inside the length cap, so length
    // alone does not catch it.
    expect(toCacheMeta({ ...valid, etag: '"abc\ndef"' })?.etag).toBeUndefined();
    expect(toCacheMeta({ ...valid, etag: "café" })?.etag).toBeUndefined(); // non-ASCII
    // The rest of the record still survives an etag rejection.
    expect(toCacheMeta({ ...valid, etag: '"abc\ndef"' })).toEqual({ url: valid.url, fetchedAt: AT });
  });
});

describe("A4 security gate, round 1 (security-architect: CONCERNS → fixed)", () => {
  const URL_ = "https://react.dev/llms.txt";
  const metaPath = () => join(dir, "react", `${URL_.replace(/[^a-z0-9]/gi, "_")}.meta.json`);
  const contentPath = () => join(dir, "react", `${URL_.replace(/[^a-z0-9]/gi, "_")}.md`);

  it("F1: a directory where the content file should be reads as uncached, not a throw (existsSync is true for a directory too)", () => {
    writeCache("react", URL_, "# React");
    rmSync(contentPath(), { force: true });
    mkdirSync(contentPath());
    let hit: ReturnType<typeof readCache>;
    expect(() => {
      hit = readCache("react", URL_, 168);
    }).not.toThrow();
    expect(hit).toBeUndefined();
  });

  it("F2: an absurdly long fetchedAt fractional-seconds group is rejected — Date.parse alone is not a length backstop", () => {
    writeCache("react", URL_, "# React");
    // MEASURED: Date.parse("2020-01-01T00:00:00." + "1".repeat(10_000) + "Z") returns a finite
    // timestamp, so an unbounded (\.\d+)? group would let this straight past the old regex,
    // through to the unclipped list_libraries footer and every STALE: note.
    const hostile = `2020-01-01T00:00:00.${"1".repeat(10_000)}Z`;
    writeFileSync(metaPath(), JSON.stringify({ url: URL_, fetchedAt: hostile }), "utf8");
    expect(readCache("react", URL_, 168)).toBeUndefined();
  });

  it("a plain millisecond fetchedAt (what writeCache actually produces) still passes", () => {
    writeCache("react", URL_, "# React");
    expect(readCache("react", URL_, 168)?.stale).toBe(false);
  });

  // D-47's allowInternalHosts case: meta.url is accepted even for an internal-host URL,
  // deliberately not held to sanitizeRemoteUrl's forbidden-host check. That is safe ONLY
  // because CacheHit.meta.url has no consumer anywhere in src/ (see toCacheMeta's docstring,
  // MEASURED by security-architect via grep) — if a future change ever renders or dereferences
  // it, this exemption must be revisited.
  it("accepts meta.url for an internal-host URL (D-47) rather than applying the fetch-time host policy", () => {
    writeCache("internal-lib", "https://127.0.0.1:9999/llms.txt", "# Internal doc");
    const hit = readCache("internal-lib", "https://127.0.0.1:9999/llms.txt", 168);
    expect(hit?.meta.url).toBe("https://127.0.0.1:9999/llms.txt");
  });

  it("source tripwire (test-auditor B, A4 round 3): no src/ file reads CacheHit.meta.url as a property — the invariant the D-47 exemption above rests on", () => {
    const srcDir = new URL("../src/", import.meta.url);
    const offenders: string[] = [];
    for (const name of readdirSync(srcDir).filter((f) => f.endsWith(".ts"))) {
      const text = readFileSync(new URL(name, srcDir), "utf8");
      // `.meta.url` as a property access (e.g. `hit.meta.url`) — never `import.meta.url`,
      // which is unrelated JS syntax that happens to share the substring.
      if (/(?<!import)\.meta\.url\b/.test(text)) offenders.push(name);
    }
    expect(offenders).toEqual([]);
  });
});

describe("cache — atomic writes (PAR-656 S4)", () => {
  const URL_ = "https://react.dev/llms.txt";
  const paths = () => {
    const d = join(dir, "react");
    const slug = URL_.replace(/[^a-z0-9]/gi, "_");
    return { dir: d, content: join(d, `${slug}.md`), meta: join(d, `${slug}.meta.json`) };
  };

  it("writes content then meta, each via a temp file + rename in the same directory, leaving no temp file behind", () => {
    writeCache("react", URL_, "# React", '"v1"');
    const p = paths();
    expect(readdirSync(p.dir).sort()).toEqual([basename(p.content), basename(p.meta)]);
    expect(readCache("react", URL_, 168)?.meta.etag).toBe('"v1"');
  });

  it("write-side asymmetry, closed (security-architect A4 round 2): a hostile or oversized etag is never written to disk, not merely dropped again on the next read", () => {
    writeCache("react", URL_, "# React", '"abc\ndef"');
    const p = paths();
    expect(readFileSync(p.meta, "utf8")).not.toContain("\\n"); // no escaped newline landed in the file at all
    expect(readCache("react", URL_, 168)?.meta.etag).toBeUndefined();
    writeCache("hono", "https://hono.dev/llms.txt", "# Hono", "x".repeat(600));
    const honoMeta = join(dir, "hono", `${"https://hono.dev/llms.txt".replace(/[^a-z0-9]/gi, "_")}.meta.json`);
    expect(JSON.parse(readFileSync(honoMeta, "utf8")).etag).toBeUndefined();
  });

  it("a reader never sees a torn pair: content present with meta missing is a miss; meta present with content missing is a miss", () => {
    writeCache("react", URL_, "# React");
    const p = paths();
    const meta = readFileSync(p.meta, "utf8");
    rmSync(p.meta);
    expect(readCache("react", URL_, 168)).toBeUndefined(); // crash after content rename, before meta rename
    writeFileSync(p.meta, meta, "utf8");
    rmSync(p.content);
    expect(readCache("react", URL_, 168)).toBeUndefined();
  });

  it("a failed write (the library dir is a file) throws and leaves no temp file where the dir should be", () => {
    writeFileSync(join(dir, "react"), "not a dir", "utf8");
    expect(() => writeCache("react", URL_, "# React")).toThrow();
    expect(readdirSync(dir)).toEqual(["react"]);
  });

  it("an overwrite replaces the old content in one step: after the write there is exactly one content file and it is the new one", () => {
    writeCache("react", URL_, "# old");
    writeCache("react", URL_, "# new");
    const p = paths();
    expect(readdirSync(p.dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
    expect(readFileSync(p.content, "utf8")).toBe("# new");
  });

  it("touchCache rewrites meta via rename too (no temp file left) and refreshes fetchedAt", async () => {
    writeCache("react", URL_, "# React");
    const before = readCache("react", URL_, 168)!.meta.fetchedAt;
    await new Promise((r) => setTimeout(r, 5));
    touchCache("react", URL_);
    const p = paths();
    expect(readdirSync(p.dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
    expect(readCache("react", URL_, 168)!.meta.fetchedAt > before).toBe(true);
  });

  it("touchCache preserves a valid etag across the toCacheMeta round-trip (N4, test-auditor A4) — a 304 must not cost the next If-None-Match", () => {
    // MEASURED by mutation reasoning (test-auditor): dropping the etag in touchCache turned
    // no test in the suite red before this one existed — every other touchCache/304 test
    // seeds no etag, or seeds one but never re-reads meta.etag afterward.
    writeCache("react", URL_, "# React", '"v1"');
    touchCache("react", URL_);
    expect(readCache("react", URL_, 168)?.meta.etag).toBe('"v1"');
  });
});

describe("S-C — orphan temp files are swept from the cache directories", () => {
  const URL_ = "https://react.dev/llms.txt";
  const orphan = (dirPath: string, base: string) => join(dirPath, `${base}.4242.1757000000000.tmp`);

  it("sweepTempFiles removes only names the atomic writers produce, and never throws on a missing directory", () => {
    mkdirSync(join(dir, "projects"), { recursive: true });
    writeFileSync(orphan(dir, "resolved.json"), "{}", "utf8");
    writeFileSync(orphan(join(dir, "projects"), "abc.json"), "{}", "utf8");
    writeFileSync(join(dir, "notes.tmp"), "mine", "utf8"); // not our shape: untouched
    writeFileSync(join(dir, "resolved.json"), "{}", "utf8");
    sweepTempFiles(dir);
    sweepTempFiles(join(dir, "projects"));
    expect(() => sweepTempFiles(join(dir, "does-not-exist"))).not.toThrow();
    expect(readdirSync(dir).sort()).toEqual(["notes.tmp", "projects", "resolved.json"]);
    expect(readdirSync(join(dir, "projects"))).toEqual([]);
  });

  it("leaves a temp file younger than SWEEP_MIN_AGE_MS alone — it is another process's write in flight, not an orphan", () => {
    expect(SWEEP_MIN_AGE_MS).toBe(60_000);
    const inFlight = tempPathFor(join(dir, "resolved.json")); // stamped with Date.now()
    const justInside = join(dir, `resolved.json.4242.${Date.now() - (SWEEP_MIN_AGE_MS - 5_000)}.tmp`);
    const justOutside = join(dir, `resolved.json.4242.${Date.now() - (SWEEP_MIN_AGE_MS + 5_000)}.tmp`);
    const skewed = join(dir, `resolved.json.4242.${Date.now() + 5_000}.tmp`); // a clock that ran ahead
    for (const p of [inFlight, justInside, justOutside, skewed]) writeFileSync(p, "half a file", "utf8");
    sweepTempFiles(dir);
    expect(existsSync(inFlight)).toBe(true);
    expect(existsSync(justInside)).toBe(true);
    expect(existsSync(skewed)).toBe(true);
    expect(existsSync(justOutside)).toBe(false);
  });

  it("sweepCacheTempFiles reaches the per-library document directories too, and leaves real files alone", () => {
    writeCache("react", URL_, "# React");
    const libDir = join(dir, "react");
    writeFileSync(orphan(libDir, "page.md"), "half a document", "utf8");
    writeFileSync(orphan(join(dir, "react"), "page.meta.json"), "{", "utf8");
    const before = readdirSync(libDir).filter((f) => !f.endsWith(".tmp")).sort();
    sweepCacheTempFiles(dir);
    expect(readdirSync(libDir).sort()).toEqual(before);
    expect(readCache("react", URL_, 168)?.content).toBe("# React");
  });

  it("S-C symlink safety: the sweep never descends a symlinked directory and never removes a symlink's target", () => {
    // The cache directory is a trust boundary: anything that can write there could plant a
    // symlink to have the startup sweep delete a file outside the cache. lstat, never stat.
    const outside = mkdtempSync(join(tmpdir(), "docs-cache-outside-"));
    try {
      // (a) a symlinked SUBDIRECTORY of the cache root whose target holds a temp-shaped file
      const outsideTemp = join(outside, "user.9.9.tmp");
      writeFileSync(outsideTemp, "not the cache's to delete", "utf8");
      symlinkSync(outside, join(dir, "linked-lib"));
      // (b) a symlink inside the cache root NAMED like a temp file, pointing at a real file
      const outsideVictim = join(outside, "victim.txt");
      writeFileSync(outsideVictim, "precious", "utf8");
      symlinkSync(outsideVictim, orphan(dir, "victim"));
      // a genuine orphan beside them is still swept
      writeFileSync(orphan(dir, "resolved.json"), "{}", "utf8");

      sweepCacheTempFiles(dir);

      expect(existsSync(outsideTemp)).toBe(true); // not descended
      expect(readFileSync(outsideVictim, "utf8")).toBe("precious"); // not followed
      expect(existsSync(orphan(dir, "resolved.json"))).toBe(false); // real orphan still gone
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

/**
 * A3 (PAR-716), round 1 (code-reviewer, B1) — `dropFollowedPageCache` must prove the cache
 * ROOT is a real directory before it deletes anything, the same D-46 rule `cache-evict.ts`
 * carries for eviction (see its own "the cache root is refused unless it is a real directory"
 * suite, mirrored here). `libDir()` alone does not give this: `lstat` on
 * `<symlinked-root>/<library>` answers `isDirectory() === true` because it stats the target,
 * so checking only the library directory let a symlink planted at the root position aim every
 * `rmSync` in this function wherever the link pointed.
 */
describe("A3 (PAR-716) · dropFollowedPageCache", () => {
  it("D-46: deletes nothing through a symlinked cache root", () => {
    const home = mkdtempSync(join(tmpdir(), "vibectx-userfiles-"));
    const parent = mkdtempSync(join(tmpdir(), "vibectx-linkroot-"));
    try {
      mkdirSync(join(home, "react"), { recursive: true });
      const victim = join(home, "react", "thesis.md");
      writeFileSync(victim, "# My thesis, not vibectx's to delete", "utf8");
      writeFileSync(join(home, "react", "thesis.meta.json"), JSON.stringify({ url: "https://example.com/thesis.md", fetchedAt: "1999-01-01T00:00:00.000Z" }), "utf8");

      const linked = join(parent, "root");
      symlinkSync(home, linked);
      process.env.VIBECTX_CACHE_DIR = linked;

      dropFollowedPageCache("react", ["https://react.dev/llms.txt"]);

      expect(existsSync(victim)).toBe(true); // zero unlinks through the symlinked root
      expect(existsSync(join(home, "react", "thesis.meta.json"))).toBe(true);
    } finally {
      process.env.VIBECTX_CACHE_DIR = dir;
      rmSync(parent, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("drops every cached page for the library except the ones in keepUrls", () => {
    const PRIMARY = "https://react.dev/llms.txt";
    const FOLLOWED = "https://react.dev/streaming.md";
    const SIBLING = "https://react.dev/llms-full.txt";
    writeCache("react", PRIMARY, "# React");
    writeCache("react", FOLLOWED, "# Streaming");
    writeCache("react", SIBLING, "# React full");
    writeCache("hono", "https://hono.dev/llms.txt", "# Hono"); // another library: untouched

    dropFollowedPageCache("react", [PRIMARY, SIBLING]);

    expect(readCache("react", PRIMARY, 168)?.content).toBe("# React");
    expect(readCache("react", SIBLING, 168)?.content).toBe("# React full"); // a kept candidate, not a followed page
    expect(readCache("react", FOLLOWED, 168)).toBeUndefined(); // dropped
    expect(readCache("hono", "https://hono.dev/llms.txt", 168)?.content).toBe("# Hono");
  });

  it("never follows or removes a symlinked file inside a real library directory", () => {
    const outside = mkdtempSync(join(tmpdir(), "docs-cache-outside-"));
    try {
      writeCache("react", "https://react.dev/llms.txt", "# React");
      const outsideVictim = join(outside, "victim.md");
      writeFileSync(outsideVictim, "precious", "utf8");
      const planted = join(dir, "react", "planted.md");
      symlinkSync(outsideVictim, planted);

      dropFollowedPageCache("react", ["https://react.dev/llms.txt"]);

      expect(readFileSync(outsideVictim, "utf8")).toBe("precious"); // not followed
      // Round 2 (test-auditor, F4): the SYMLINK ITSELF must also survive — asserting only the
      // target's content cannot fail regardless of the guard, because `rmSync` on a plain path
      // never resolves a final-component symlink, so the target is unreachable either way.
      expect(existsSync(planted)).toBe(true); // not removed
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("is best-effort: an entry with no cache directory at all is a silent no-op", () => {
    expect(() => dropFollowedPageCache("never-cached", ["https://example.com/llms.txt"])).not.toThrow();
  });

  /**
   * Round 2 (security-architect, C2; test-auditor, F1) — the provenance clamp that bounds this
   * function's blast radius against a `VIBECTX_CACHE_DIR` aimed at a directory vibectx does not
   * own. Every case here must leave the file(s) in place: the clamp exists precisely so a
   * planted or corrupt file is NOT deleted on name shape alone.
   */
  describe("round 2 (security-architect, C2) · only a proven <slug>.md/<slug>.meta.json pair is deleted", () => {
    it("a lone .md with no .meta.json companion survives", () => {
      writeCache("react", "https://react.dev/llms.txt", "# React");
      writeFileSync(join(dir, "react", "orphan.md"), "not vibectx's to delete", "utf8");

      dropFollowedPageCache("react", ["https://react.dev/llms.txt"]);

      expect(existsSync(join(dir, "react", "orphan.md"))).toBe(true);
    });

    it("a lone .meta.json with no .md companion survives", () => {
      writeCache("react", "https://react.dev/llms.txt", "# React");
      writeFileSync(join(dir, "react", "orphan.meta.json"), JSON.stringify({ url: "https://example.com/x", fetchedAt: "2026-01-01T00:00:00.000Z" }), "utf8");

      dropFollowedPageCache("react", ["https://react.dev/llms.txt"]);

      expect(existsSync(join(dir, "react", "orphan.meta.json"))).toBe(true);
    });

    it("a .md whose .meta.json fails validation (truncated JSON) survives with both halves intact", () => {
      writeCache("react", "https://react.dev/llms.txt", "# React");
      writeCache("react", "https://react.dev/streaming.md", "# Streaming");
      const slug = urlSlug("https://react.dev/streaming.md");
      writeFileSync(join(dir, "react", `${slug}.meta.json`), "{ not json", "utf8");

      dropFollowedPageCache("react", ["https://react.dev/llms.txt"]);

      expect(existsSync(join(dir, "react", `${slug}.md`))).toBe(true);
      expect(existsSync(join(dir, "react", `${slug}.meta.json`))).toBe(true);
    });

    it("a .md whose .meta.json exceeds the size bound survives, without being parsed", () => {
      writeCache("react", "https://react.dev/llms.txt", "# React");
      writeCache("react", "https://react.dev/streaming.md", "# Streaming");
      const slug = urlSlug("https://react.dev/streaming.md");
      // Oversized but otherwise well-formed JSON, so a failure here can only be the size guard.
      const oversized = JSON.stringify({ url: "https://react.dev/streaming.md", fetchedAt: "2026-01-01T00:00:00.000Z", etag: "x".repeat(5000) });
      writeFileSync(join(dir, "react", `${slug}.meta.json`), oversized, "utf8");

      dropFollowedPageCache("react", ["https://react.dev/llms.txt"]);

      expect(existsSync(join(dir, "react", `${slug}.md`))).toBe(true);
    });

    it("round 3 (code-reviewer, SF-A): a foreign pair literally named .md / .meta.json (empty slug) is never deleted", () => {
      writeCache("react", "https://react.dev/llms.txt", "# React");
      // A pair this tool did not write, whose slug happens to be empty — urlSlug() can never
      // produce "" for a non-empty URL, so no legitimate followed page ever has this name.
      writeFileSync(join(dir, "react", ".md"), "not vibectx's, empty slug", "utf8");
      writeFileSync(join(dir, "react", ".meta.json"), JSON.stringify({ url: "https://example.com/x", fetchedAt: "2026-01-01T00:00:00.000Z" }), "utf8");

      dropFollowedPageCache("react", ["https://react.dev/llms.txt"]);

      expect(existsSync(join(dir, "react", ".md"))).toBe(true);
      expect(existsSync(join(dir, "react", ".meta.json"))).toBe(true);
    });

    it("C3: a successful drop reports the count once, through the injected warn", () => {
      writeCache("react", "https://react.dev/llms.txt", "# React");
      writeCache("react", "https://react.dev/streaming.md", "# Streaming");
      writeCache("react", "https://react.dev/guide.md", "# Guide");
      const said: string[] = [];

      dropFollowedPageCache("react", ["https://react.dev/llms.txt"], (m) => said.push(m));

      expect(said).toHaveLength(1);
      expect(said[0]).toContain("dropped 2 stale followed-pages");
      expect(said[0]).toContain("react");
      expect(readCache("react", "https://react.dev/streaming.md", 168)).toBeUndefined();
      expect(readCache("react", "https://react.dev/guide.md", 168)).toBeUndefined();
    });

    it("nothing to drop: warn is never called", () => {
      writeCache("react", "https://react.dev/llms.txt", "# React");
      const said: string[] = [];

      dropFollowedPageCache("react", ["https://react.dev/llms.txt"], (m) => said.push(m));

      expect(said).toHaveLength(0);
    });
  });
});
