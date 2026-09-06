import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  documentHash,
  indexCachedDocument,
  indexDocument,
  invalidateIndex,
  readIndex,
  resetSearchIndexMemo,
  searchIndexPath,
  toIndexedDocument,
  writeIndex,
  MAX_INDEX_FILE_BYTES,
  MAX_INDEXED_DOC_BYTES,
  SEARCH_INDEX_SCHEMA_VERSION,
  type IndexedDocument,
} from "../src/search-index.js";
import { queryIndex, splitSections, weighSections } from "../src/retrieval.js";
import { RETRIEVAL_VERSION } from "../src/tokenize.js";

/**
 * PAR-659 · D-33 — the index is a derived cache. These cases are the proof that nothing on
 * disk can make `search` say something the document cache does not hold: the file carries no
 * text at all, every field is re-validated on read, and a hash that does not match the cached
 * document takes the whole entry out of play (the last half is exercised in search.test.ts,
 * which owns the query path).
 */

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "vibectx-index-"));
  process.env.DOCS_CACHE_DIR = dir;
  resetSearchIndexMemo();
});
afterEach(() => {
  delete process.env.DOCS_CACHE_DIR;
  rmSync(dir, { recursive: true, force: true });
});

const URL_ = "https://hono.dev/llms.txt";
const AT = "2026-09-06T06:00:00.000Z";
const DOC = [
  "# Hono",
  "",
  "A small web framework.",
  "",
  "## Streaming",
  "",
  "Use `streamSSE` to send server-sent events to the client.",
  "",
  "## Routing",
  "",
  "Route params are read with `c.req.param`.",
].join("\n");

const plant = (body: unknown): void => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(searchIndexPath(), typeof body === "string" ? body : JSON.stringify(body), "utf8");
};

const one = (): Map<string, IndexedDocument> => {
  const doc = indexDocument(URL_, DOC, AT);
  expect(doc).toBeDefined();
  return new Map([["hono", doc!]]);
};

describe("search-index · indexDocument (PAR-659, D-33)", () => {
  it("hashes the document text as the first 16 hex characters of sha256", () => {
    expect(documentHash(DOC)).toBe(createHash("sha256").update(DOC, "utf8").digest("hex").slice(0, 16));
    expect(documentHash(DOC)).toMatch(/^[0-9a-f]{16}$/);
    expect(documentHash(`${DOC} `)).not.toBe(documentHash(DOC));
  });

  it("stores one length per section and postings in ascending section order, carrying no text", () => {
    const doc = indexDocument(URL_, DOC, AT)!;
    expect(doc.lengths).toHaveLength(splitSections(DOC).length);
    for (const posting of doc.postings.values()) {
      expect(posting.length % 2).toBe(0);
      const ids = posting.filter((_, i) => i % 2 === 0);
      expect(ids).toEqual([...ids].sort((a, b) => a - b));
    }
    // The property that makes even a hash-matching planted index harmless: the file holds no
    // heading, no path and no body — there is no text in it to render.
    const serialised = JSON.stringify({ ...doc, postings: [...doc.postings] });
    expect(serialised).not.toContain("Streaming");
    expect(serialised).not.toContain("server-sent");
    expect(serialised).not.toContain("streamSSE");
  });

  it("weights exactly as rankSplitSections does: postings reproduce weighSections term for term", () => {
    const sections = splitSections(DOC);
    const doc = indexDocument(URL_, DOC, AT)!;
    const { terms, index } = queryIndex("streaming server-sent events routing hono framework");
    const expected = weighSections(sections, index);
    expect(terms.length).toBeGreaterThan(0);
    for (let sid = 0; sid < sections.length; sid++) {
      expect(doc.lengths[sid]).toBe(expected[sid].length);
      for (let t = 0; t < terms.length; t++) {
        const posting = doc.postings.get(terms[t]) ?? [];
        let tf = 0;
        for (let i = 0; i < posting.length; i += 2) if (posting[i] === sid) tf = posting[i + 1];
        expect(tf).toBe(expected[sid].tf[t]);
      }
    }
  });

  it("D-36: refuses a document over MAX_INDEXED_DOC_BYTES (the caller tokenizes it instead)", () => {
    expect(indexDocument(URL_, "x".repeat(MAX_INDEXED_DOC_BYTES + 1), AT)).toBeUndefined();
    expect(indexDocument(URL_, "# ok\n\nbody text", AT)).toBeDefined();
  });
});

describe("search-index · file discipline (PAR-659, D-33)", () => {
  it("round-trips a document through write → read", () => {
    expect(writeIndex(one())).toBe(true);
    const { libraries, problem } = readIndex();
    expect(problem).toBeUndefined();
    const built = indexDocument(URL_, DOC, AT)!;
    const back = libraries.get("hono")!;
    expect(back.url).toBe(URL_);
    expect(back.fetchedAt).toBe(AT);
    expect(back.hash).toBe(documentHash(DOC));
    expect(back.lengths).toEqual(built.lengths);
    expect([...back.postings].sort()).toEqual([...built.postings].sort());
  });

  it("writes byte-identical files for the same data (libraries and terms sorted), leaving no temp file", () => {
    writeIndex(one());
    const first = readFileSync(searchIndexPath(), "utf8");
    writeIndex(one());
    expect(readFileSync(searchIndexPath(), "utf8")).toBe(first);
    const terms = Object.keys(JSON.parse(first).libraries.hono.postings);
    expect(terms).toEqual([...terms].sort());
    expect(readdirSync(dir).filter((n) => n.endsWith(".tmp"))).toEqual([]);
  });

  it("a missing file is the ordinary first-run state, not a problem", () => {
    const { libraries, problem } = readIndex();
    expect(libraries.size).toBe(0);
    expect(problem).toBeUndefined();
  });

  it("a corrupt file reads as empty with a problem note", () => {
    plant("{not json");
    const { libraries, problem } = readIndex();
    expect(libraries.size).toBe(0);
    expect(problem).toMatch(/unreadable/);
  });

  it("a bad envelope rejects the WHOLE file, valid entries included", () => {
    const entry = { url: URL_, fetchedAt: AT, hash: documentHash(DOC), lengths: [1], postings: { stream: [0, 1] } };
    plant({ schemaVersion: SEARCH_INDEX_SCHEMA_VERSION + 1, libraries: { hono: entry } });
    expect(readIndex().libraries.size).toBe(0);
    expect(readIndex().problem).toMatch(/schemaVersion/);
    plant({ schemaVersion: SEARCH_INDEX_SCHEMA_VERSION, libraries: [entry] });
    expect(readIndex().libraries.size).toBe(0);
    plant([1, 2, 3]);
    expect(readIndex().libraries.size).toBe(0);
    plant({ libraries: { hono: entry } });
    expect(readIndex().libraries.size).toBe(0);
  });

  it("D-38: the envelope carries the retrieval version, and a file built by another one is refused WHOLE", () => {
    writeIndex(one());
    const onDisk = JSON.parse(readFileSync(searchIndexPath(), "utf8"));
    expect(onDisk.retrievalVersion).toBe(RETRIEVAL_VERSION);
    expect(readIndex().libraries.size).toBe(1);

    // The same postings, the same hashes, the same documents — only the code that built them
    // is claimed to be different. That is the case the CONTENT HASH cannot see.
    plant({ ...onDisk, retrievalVersion: RETRIEVAL_VERSION + 1 });
    expect(readIndex().libraries.size).toBe(0);
    expect(readIndex().problem).toMatch(/retrieval version/);
    plant({ ...onDisk, retrievalVersion: undefined });
    expect(readIndex().libraries.size).toBe(0);
  });

  it("D-40: a payload over MAX_INDEX_FILE_BYTES sheds its largest entries instead of writing a file no read will accept", () => {
    // MEASURED before D-40: `search` wrote a 74,686,064-byte index that every later read then
    // refused, so every subsequent search re-tokenized seven documents and rewrote the same
    // 74.7 MB — 21.5 s per search, for ever. The shape that produced it is a pathological
    // vocabulary, which is what this builds directly: many distinct terms, little text.
    const fat = (terms: number, seed: string): IndexedDocument => {
      const postings = new Map<string, number[]>();
      // Terms at the tokenizer's own MAX_TOKEN_CHARS, so the fixture reaches the 64 MiB cap in
      // as few map entries as the shape allows.
      for (let i = 0; i < terms; i++) postings.set(`${seed}${String(i).padStart(62, "0")}`, [0, 1]);
      return { url: URL_, fetchedAt: AT, hash: documentHash(DOC), lengths: [terms], postings };
    };
    const libraries = new Map<string, IndexedDocument>();
    libraries.set("small", one().get("hono")!);
    for (let i = 0; i < 3; i++) libraries.set(`huge-${i}`, fat(320_000, `t${i}`));
    const notes: string[] = [];
    const shed: string[][] = [];
    expect(writeIndex(libraries, (m) => notes.push(m), (s) => shed.push(s))).toBe(true);

    expect(statSync(searchIndexPath()).size).toBeLessThanOrEqual(MAX_INDEX_FILE_BYTES);
    expect(shed[0].length).toBeGreaterThan(0);
    expect(notes.join("")).toMatch(/would exceed the \d+-byte limit/);
    // The file it wrote is one it can READ BACK — the property D-40 exists for, and the one
    // the 74.7 MB file did not have.
    const back = readIndex();
    expect(back.problem).toBeUndefined();
    expect(back.libraries.size).toBe(libraries.size - shed[0].length);
    // Largest first: the small entry survives whatever else goes.
    expect(back.libraries.has("small")).toBe(true);
    expect(shed[0].every((n) => n.startsWith("huge-"))).toBe(true);
  }, 180_000);

  it("S2: an unreadable index never reports a byte of the file", () => {
    // MEASURED: a symlinked index.json leaked `SUPERSECRE…` into the MCP response, because V8's
    // syntax-error message quotes a run of the offending source.
    plant('{"schemaVersion":1,"libraries":SUPERSECRETTOKEN-abcdef}');
    const leaky = readIndex().problem!;
    expect(leaky).toMatch(/invalid JSON/);
    expect(leaky).not.toContain("SUPERSECRET");
    expect(leaky.length).toBeLessThan(120);
    // Where the parser gives a position, the position is what is reported — and only that.
    plant('{"schemaVersion" 1, "secret": "SUPERSECRETTOKEN"}');
    const positioned = readIndex().problem!;
    expect(positioned).toMatch(/invalid JSON at position \d+/);
    expect(positioned).not.toContain("SUPERSECRET");
    plant("");
    expect(readIndex().problem).toMatch(/invalid JSON/);
  });

  it("K2: a NEWER schemaVersion on disk is never overwritten", () => {
    plant({ schemaVersion: SEARCH_INDEX_SCHEMA_VERSION + 1, libraries: {} });
    const before = readFileSync(searchIndexPath(), "utf8");
    const notes: string[] = [];
    expect(writeIndex(one(), (m) => notes.push(m))).toBe(false);
    expect(readFileSync(searchIndexPath(), "utf8")).toBe(before);
    expect(notes.join("")).toMatch(/newer schemaVersion/);
  });
});

describe("search-index · validate-on-read drops bad entries (PAR-659, D-33)", () => {
  const valid = { url: URL_, fetchedAt: AT, hash: documentHash(DOC), lengths: [4, 7], postings: { stream: [0, 3, 1, 1] } };
  const rejects = (mutate: Record<string, unknown>): void => {
    expect(toIndexedDocument({ ...valid, ...mutate })).toBeUndefined();
  };

  it("accepts the valid shape", () => {
    const doc = toIndexedDocument(valid)!;
    expect(doc.hash).toBe(valid.hash);
    expect(doc.postings.get("stream")).toEqual([0, 3, 1, 1]);
  });

  it("rejects a url that is not an https URL the link policy accepts", () => {
    rejects({ url: "http://hono.dev/llms.txt" });
    rejects({ url: "https://user:pw@hono.dev/llms.txt" });
    rejects({ url: "file:///etc/passwd" });
    rejects({ url: 42 });
    rejects({ url: undefined });
  });

  it("rejects a fetchedAt that is not a strict ISO-8601 UTC instant", () => {
    rejects({ fetchedAt: "2026-09-06" });
    rejects({ fetchedAt: "2020-01-01 (‮evil)" });
    rejects({ fetchedAt: "2026-13-45T06:00:00Z" });
    rejects({ fetchedAt: 1_757_000_000_000 });
  });

  it("rejects a hash that is not 16 lowercase hex characters", () => {
    rejects({ hash: documentHash(DOC).toUpperCase() });
    rejects({ hash: "abc" });
    rejects({ hash: `${documentHash(DOC).slice(0, 15)}z` });
    rejects({ hash: createHash("sha256").update(DOC).digest("hex") });
  });

  it("rejects postings that point outside the section list, or carry a zero frequency", () => {
    rejects({ postings: { stream: [2, 1] } }); // section 2 does not exist
    rejects({ postings: { stream: [0, 0] } });
    rejects({ postings: { stream: [0] } }); // odd length
    rejects({ postings: { stream: [] } });
    rejects({ postings: { stream: [0.5, 1] } });
    rejects({ postings: { stream: "0,1" } });
    rejects({ postings: { ["x".repeat(65)]: [0, 1] } });
    rejects({ postings: [[0, 1]] });
  });

  it("rejects lengths that are not non-negative integers", () => {
    rejects({ lengths: [-1, 2] });
    rejects({ lengths: [1.5] });
    rejects({ lengths: "4,7" });
  });

  it("a __proto__ posting key is data, never a prototype write", () => {
    const doc = toIndexedDocument({ ...valid, postings: { ["__proto__"]: [0, 1], stream: [0, 1] } });
    expect(doc).toBeDefined();
    expect((({}) as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.getPrototypeOf({})).toBe(Object.prototype);
  });

  it("one bad entry is dropped and the rest of the file survives", () => {
    plant({
      schemaVersion: SEARCH_INDEX_SCHEMA_VERSION,
      retrievalVersion: RETRIEVAL_VERSION,
      libraries: { hono: valid, react: { ...valid, hash: "nope" }, React: valid },
    });
    const { libraries, problem } = readIndex();
    expect([...libraries.keys()]).toEqual(["hono"]);
    expect(problem).toMatch(/2 invalid entries dropped/);
  });
});

describe("search-index · invalidate and the incremental hook (PAR-659, D-34)", () => {
  it("invalidateIndex removes one library and leaves the others", () => {
    const libraries = one();
    libraries.set("react", indexDocument("https://react.dev/llms.txt", "# React\n\nhooks and effects", AT)!);
    writeIndex(libraries);
    expect(invalidateIndex("hono")).toBe(true);
    expect([...readIndex().libraries.keys()]).toEqual(["react"]);
  });

  it("invalidateIndex folds the name and reports false for a library it does not hold", () => {
    writeIndex(one());
    expect(invalidateIndex("nothing-here")).toBe(false);
    expect(invalidateIndex(" HONO ")).toBe(true);
    expect(readIndex().libraries.size).toBe(0);
  });

  it("indexCachedDocument writes the entry and replaces it when the document changed", () => {
    indexCachedDocument("hono", URL_, DOC, AT);
    expect(readIndex().libraries.get("hono")!.hash).toBe(documentHash(DOC));
    const changed = `${DOC}\n\n## Websockets\n\nUpgrade the connection.`;
    indexCachedDocument("hono", URL_, changed, "2026-09-06T07:00:00.000Z");
    const back = readIndex().libraries.get("hono")!;
    expect(back.hash).toBe(documentHash(changed));
    expect(back.fetchedAt).toBe("2026-09-06T07:00:00.000Z");
  });

  it("indexCachedDocument never throws and never indexes a document too large to index (D-36)", () => {
    const notes: string[] = [];
    indexCachedDocument("hono", URL_, "x".repeat(MAX_INDEXED_DOC_BYTES + 1), AT, (m) => notes.push(m));
    expect(readIndex().libraries.size).toBe(0);
    expect(() => indexCachedDocument("", URL_, DOC, AT, (m) => notes.push(m))).not.toThrow();
    expect(readIndex().libraries.size).toBe(0);
  });
});
