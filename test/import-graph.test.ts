import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync, readdirSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { listLibrariesText } from "../src/list-libraries.js";
import type { Registry } from "../src/registry.js";

/**
 * A8 / PAR-721 done-when: an import-graph test asserting BOTH
 *   (a) list-libraries.ts does NOT transitively reach fetcher.ts
 *   (b) retrieval.ts does NOT reach config.ts or project-deps.ts
 *
 * PARSER: syntactic, not semantic. It classifies five import/export forms by their own
 * surface syntax (`type` keyword placement) and treats everything else as a value edge.
 * This is correct on THIS codebase today only because every type-only edge here is
 * EXPLICITLY marked with `type` -- tsconfig sets neither verbatimModuleSyntax nor
 * isolatedModules, so nothing enforces that. A real compiler additionally elides an
 * unmarked `import { T } from "./d.js"` when T is used only as a type -- broader than the
 * syntactic rule -- so this parser can report an edge tsc would actually erase. That is a
 * known, accepted imprecision (see the fixture test below), not a bug: it can only ever
 * OVER-report edges, never hide a real one, so a passing done-when here is never a false
 * negative on either (a) or (b).
 *
 * It parses src/*.ts on disk, never dist/*.js: `npm test` is `vitest run`, which builds
 * nothing, and CI runs lint -> test -> build (the build comes AFTER tests). dist/ is
 * gitignored, so on a fresh clone it does not exist at test time -- a defensive
 * `existsSync(dist)` guard here would make this test permanently skipped and permanently
 * green, which is exactly the vacuous-pass failure mode this file exists to avoid.
 */

const SRC_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "src");

type Token = { type: "code" | "string" | "comment"; text: string };

/** Comment- and string-literal-aware scan. Comments are discarded outright; string/
 *  template contents are kept as their own tokens so a later mask step can blank them out
 *  -- this codebase's URLs (`"https://..."`) contain `//`, so a naive line-comment regex
 *  applied to raw source would corrupt real code. Template-literal `${...}` interpolation
 *  is not specially handled (this codebase's imports never use template specifiers), a
 *  known, narrow limitation. */
function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const n = src.length;
  let buf = "";
  const flush = () => {
    if (buf.length > 0) {
      tokens.push({ type: "code", text: buf });
      buf = "";
    }
  };
  while (i < n) {
    const c = src[i];
    const c2 = src[i + 1];
    if (c === "/" && c2 === "/") {
      flush();
      let j = i;
      while (j < n && src[j] !== "\n") j++;
      tokens.push({ type: "comment", text: src.slice(i, j) });
      i = j;
      continue;
    }
    if (c === "/" && c2 === "*") {
      flush();
      let j = i + 2;
      while (j < n && !(src[j] === "*" && src[j + 1] === "/")) j++;
      j = Math.min(j + 2, n);
      tokens.push({ type: "comment", text: src.slice(i, j) });
      i = j;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      flush();
      const quote = c;
      let j = i + 1;
      while (j < n) {
        if (src[j] === "\\") {
          j += 2;
          continue;
        }
        if (src[j] === quote) {
          j += 1;
          break;
        }
        j += 1;
      }
      tokens.push({ type: "string", text: src.slice(i, j) });
      i = j;
      continue;
    }
    buf += c;
    i += 1;
  }
  flush();
  return tokens;
}

/** Replace every string token with an opaque placeholder (never a syntax character), so
 *  the structural regexes below can never match text that only appears INSIDE a string
 *  literal -- the fixture test for "a module name inside a string literal" below depends
 *  on this. Comments contribute nothing (already dropped by tokenize). */
function maskStrings(tokens: Token[]): { masked: string; strings: string[] } {
  const strings: string[] = [];
  let masked = "";
  for (const t of tokens) {
    if (t.type === "code") {
      masked += t.text;
    } else if (t.type === "string") {
      const idx = strings.length;
      strings.push(t.text.slice(1, -1));
      masked += `@@S${idx}@@`;
    }
  }
  return { masked, strings };
}

/** An import/export clause (the part between `import`/`export` and `from`) is type-only
 *  when every individual specifier in a `{ ... }` clause carries its own `type` keyword;
 *  a bare default identifier or a `* as ns` namespace form is always a value. A clause
 *  mixing a `type X` with a plain `Y` -- `{ type T, value }` -- counts as an edge (a mixed
 *  clause counts, per the five documented import forms). */
function isTypeOnlyClause(clause: string): boolean {
  const trimmed = clause.trim();
  if (trimmed.startsWith("*")) return false; // namespace import/export: always a value
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    const inner = trimmed.slice(1, -1);
    const items = inner
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    // `import {} from "./x.js"` is a real ESM statement with an empty named-binding list --
    // still a runtime side-effect import, exactly like a bare `import "./x.js"`. An empty
    // clause is therefore a VALUE edge, not type-only (no import in this codebase uses this
    // form today, but a parser that got this wrong would silently drop a real future edge).
    if (items.length === 0) return false;
    return items.every((it) => /^type\s+/.test(it));
  }
  // a bare default identifier, or "Default, {...}" / "Default, * as ns": default forces a value edge
  return false;
}

interface Extracted {
  specifier: string;
  /** true when this import/export contributes NO runtime edge. */
  isType: boolean;
}

/**
 * Five forms recognised, matching the go block's own list, over the MASKED text (so a
 * specifier can only ever come from a real `@@S<N>@@` placeholder, never from raw text
 * inside a string or comment -- those never survive tokenize/maskStrings in the first
 * place). Clause capture groups use `[^;]+?` (not `[^;\n]+?`): a multi-line braced import
 * (get-docs.ts:3, resolve.ts:2, search.ts:5, registry.ts:2 all are) must be read across
 * its newlines -- a `[^;\n]` restriction is exactly the "single-line regex parser" this
 * suite is built to kill (see the get-docs -> fetcher positive control below).
 */
function extractFromMasked(masked: string, strings: string[]): Extracted[] {
  const out: Extracted[] = [];

  const importFromRe = /\bimport\s+(type\s+)?([^;]+?)\s+from\s*@@S(\d+)@@/g;
  for (const m of masked.matchAll(importFromRe)) {
    const wholeType = m[1] !== undefined;
    out.push({ specifier: strings[Number(m[3])], isType: wholeType || isTypeOnlyClause(m[2]) });
  }

  // bare side-effect import: `import "./g.js";` -- import DIRECTLY followed by a specifier,
  // no clause and no `from` -- always a runtime edge.
  const bareImportRe = /\bimport\s*@@S(\d+)@@/g;
  for (const m of masked.matchAll(bareImportRe)) {
    out.push({ specifier: strings[Number(m[1])], isType: false });
  }

  const exportFromRe = /\bexport\s+(type\s+)?(\*(?:\s+as\s+[A-Za-z_$][\w$]*)?|\{[^}]*\})\s+from\s*@@S(\d+)@@/g;
  for (const m of masked.matchAll(exportFromRe)) {
    const wholeType = m[1] !== undefined;
    out.push({ specifier: strings[Number(m[3])], isType: wholeType || isTypeOnlyClause(m[2]) });
  }

  // `import("./h.js")` / `await import("./h.js")`: always a runtime edge.
  const dynamicImportRe = /\bimport\s*\(\s*@@S(\d+)@@\s*\)/g;
  for (const m of masked.matchAll(dynamicImportRe)) {
    out.push({ specifier: strings[Number(m[1])], isType: false });
  }

  return out;
}

function extractEdges(source: string): Extracted[] {
  const { masked, strings } = maskStrings(tokenize(source));
  return extractFromMasked(masked, strings);
}

function specifierToNodeId(specifier: string): string | undefined {
  if (!specifier.startsWith(".")) return undefined; // external (node:*, zod, the MCP SDK, ...): not a src/ node
  const noExt = specifier.endsWith(".js") ? specifier.slice(0, -3) : specifier;
  return noExt.replace(/^\.\.?\//, ""); // this codebase's src/ is flat: "./x.js" -> "x"
}

interface Graph {
  nodes: Set<string>;
  edges: Map<string, Set<string>>;
  edgeList: Array<{ from: string; to: string }>;
  unresolvedSpecifiers: string[];
}

/**
 * Built by reading every src/*.ts file ON DISK (never dist/*.js -- see the module comment).
 * A relative specifier that fails to resolve to a real src/*.ts file is pushed to
 * `unresolvedSpecifiers` and the edge is DROPPED -- it is recorded, never silently
 * skipped, so `expect(unresolvedSpecifiers).toEqual([])` below is a real assertion and
 * not a `continue` a resolver bug could hide behind. A non-relative specifier (an npm
 * package, a `node:` builtin) is simply not a candidate for this graph at all -- it is
 * neither an edge nor an "unresolved" failure.
 */
function buildGraph(): Graph {
  const files = readdirSync(SRC_DIR).filter((f) => f.endsWith(".ts"));
  const nodes = new Set(files.map((f) => f.replace(/\.ts$/, "")));
  const edges = new Map<string, Set<string>>();
  const edgeList: Array<{ from: string; to: string }> = [];
  const unresolvedSpecifiers: string[] = [];

  for (const file of files) {
    const id = file.replace(/\.ts$/, "");
    const source = readFileSync(join(SRC_DIR, file), "utf8");
    const imports = extractEdges(source);
    const set = edges.get(id) ?? new Set<string>();
    edges.set(id, set);
    for (const imp of imports) {
      if (imp.isType) continue; // no runtime edge
      if (!imp.specifier.startsWith(".")) continue; // external package: not a graph node
      const targetId = specifierToNodeId(imp.specifier);
      if (targetId === undefined) continue;
      const targetPath = join(SRC_DIR, `${targetId}.ts`);
      if (!existsSync(targetPath)) {
        unresolvedSpecifiers.push(`${id} -> ${imp.specifier}`);
        continue;
      }
      if (!set.has(targetId)) {
        set.add(targetId);
        edgeList.push({ from: id, to: targetId });
      }
    }
  }
  return { nodes, edges, edgeList, unresolvedSpecifiers };
}

/** Iterative DFS -- no recursion, so a cycle (there is at least one real risk of this in any
 *  hand-maintained graph) cannot blow the stack, and a `seen` set makes revisiting a node
 *  a no-op rather than an infinite loop. Self-checked below over a hand-built fixture. */
function reaches(graph: Pick<Graph, "edges">, from: string, to: string): boolean {
  const seen = new Set<string>();
  const stack = [from];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    if (cur === to) return true;
    if (seen.has(cur)) continue;
    seen.add(cur);
    for (const next of graph.edges.get(cur) ?? []) stack.push(next);
  }
  return false;
}

// MEASURED, and self-verifying rather than cited (D-67: the earlier draft of this comment
// pointed at an external "build report" that does not exist as a file in this repository --
// found by test-auditor's round-2 re-audit; corrected by making the number an assertion in
// this same file instead of a claim about it). `graph.edgeList.length` is pinned EXACTLY, not
// just floored, in the "exact measured edge count" test directly below this constant -- so
// `npx vitest run test/import-graph.test.ts` IS the command that reproduces this figure, run
// against this exact file, every time. 34 src/*.ts files on disk, 34 graph nodes, 114 unique
// runtime edges, zero unresolved specifiers, at this branch's tree as of this commit.
// Two independent deltas land on this merge, from a shared prior base of 33 nodes / 110
// edges: (D-71, PAR-749) `src/cache-meta.ts` is a new 34th file, and both `src/cache.ts` and
// `src/cache-evict.ts` gained one new value-import edge into it (+1 node, +2 edges);
// (D-48, A7/PAR-720) `src/debug.ts` and `src/resolved-store.ts` each gained one new
// value-import edge to `src/text.ts`, switching their inline control/bidi regex to the shared
// `stripControlBidi` (+0 nodes, +2 edges). 110 + 2 + 2 = 114, matching the re-measured figure
// -- re-measured on the merged tree, not summed by hand, because two deltas landing on the
// same file is exactly the case a by-hand sum gets wrong.
// Cross-checked by a second, independent route: counting every relative `from "./…"`
// specifier site by hand across src/ (127), minus whole-statement `import type`/`export type`
// relative imports (9 by inspection -- warm.ts's `export type { WarmRow, WarmStatus } from
// "./project-store.js"` is one of these, so it is NOT a second edge on top of warm.ts's
// runtime import from the same file), before de-duplicating a handful of files that import
// the same module twice (resolve->limits, autowarm->autowarm-status, doctor->source-kind,
// fetcher->link-policy) -- lands on the same figure. EDGE_COUNT_FLOOR exists SEPARATELY from
// the exact-count assertion: it is what the two `reaches()`-based done-when tests further down
// implicitly rely on staying well above zero, set with real margin under the exact count so an
// unrelated future file addition cannot trip it, while staying close enough to still catch a
// real regression -- 0 edges with 34 nodes is the vacuous "resolver silently drops everything"
// failure mode this whole non-vacuity block exists to catch, and a floor of merely "greater
// than zero" would not.
const MEASURED_EDGE_COUNT = 114;
const EDGE_COUNT_FLOOR = 100;

describe("import graph: non-vacuity (a resolver that silently drops edges must be caught)", () => {
  const graph = buildGraph();

  it("every relative specifier resolves to a real src/*.ts file -- never a silent continue", () => {
    expect(graph.unresolvedSpecifiers).toEqual([]);
  });

  it("the graph has exactly one node per src/*.ts file on disk", () => {
    const onDisk = readdirSync(SRC_DIR).filter((f) => f.endsWith(".ts")).length;
    expect(graph.nodes.size).toBe(onDisk);
  });

  it(`total runtime edges clear a floor well under the measured count (${MEASURED_EDGE_COUNT})`, () => {
    expect(graph.edgeList.length).toBeGreaterThanOrEqual(EDGE_COUNT_FLOOR);
  });

  it("exact measured edge count: this is the assertion that makes MEASURED_EDGE_COUNT above self-verifying, not merely a claim about a number recorded elsewhere", () => {
    expect(graph.edgeList.length).toBe(MEASURED_EDGE_COUNT);
  });

  it("every endpoint named in an assertion below actually exists in the graph", () => {
    for (const id of ["list-libraries", "fetcher", "retrieval", "config", "project-deps", "autowarm-status"]) {
      expect(graph.nodes.has(id)).toBe(true);
    }
  });
});

describe("import graph: positive controls (must stay TRUE after the refactor)", () => {
  const graph = buildGraph();

  it('get-docs reaches fetcher -- spans a MULTI-LINE braced import (get-docs.ts:3 onward); ' +
     "kills a single-line-only regex parser outright", () => {
    expect(reaches(graph, "get-docs", "fetcher")).toBe(true);
  });

  it("retrieval reaches tokenize -- proves retrieval.ts was actually read, not skipped", () => {
    expect(reaches(graph, "retrieval", "tokenize")).toBe(true);
  });

  it("list-libraries reaches cache -- the same read-a-real-file guard, for assertion (a)", () => {
    expect(reaches(graph, "list-libraries", "cache")).toBe(true);
  });

  it("a genuine 3-hop transitive control: doctor -> get-docs -> retrieval -> tokenize, no direct edge", () => {
    expect(graph.edges.get("doctor")?.has("tokenize")).toBe(false); // not a direct edge
    expect(reaches(graph, "doctor", "tokenize")).toBe(true); // only reachable transitively
  });
});

describe("import graph: direct edges proving the moves happened, not that files vanished", () => {
  const graph = buildGraph();

  it("Move 2: list-libraries -> source-kind", () => {
    expect(graph.edges.get("list-libraries")?.has("source-kind")).toBe(true);
  });

  it("Move 5: list-libraries -> autowarm-status, and NOT -> autowarm", () => {
    expect(graph.edges.get("list-libraries")?.has("autowarm-status")).toBe(true);
    expect(graph.edges.get("list-libraries")?.has("autowarm")).toBe(false);
  });

  it("Move 3: retrieval -> text", () => {
    expect(graph.edges.get("retrieval")?.has("text")).toBe(true);
  });

  it("Move 1: autowarm -> concurrency AND warm -> concurrency (the only check on this move)", () => {
    expect(graph.edges.get("autowarm")?.has("concurrency")).toBe(true);
    expect(graph.edges.get("warm")?.has("concurrency")).toBe(true);
  });
});

describe("import graph: THE DONE-WHEN", () => {
  const graph = buildGraph();

  it("(a) list-libraries.ts does NOT transitively reach fetcher.ts", () => {
    expect(reaches(graph, "list-libraries", "fetcher")).toBe(false);
  });

  it("(b) retrieval.ts does NOT reach config.ts or project-deps.ts", () => {
    expect(reaches(graph, "retrieval", "config")).toBe(false);
    expect(reaches(graph, "retrieval", "project-deps")).toBe(false);
  });
});

/**
 * The two done-when tests above prove the CURRENT graph passes; on their own they do not
 * prove the assertion would actually go red if a future change reintroduced the edge --
 * `list-libraries` has six out-edges (autowarm-status, cache, config, project-store,
 * source-kind, text) and only three are pinned as direct edges elsewhere in this file, so a
 * regression landing in `config` or `project-store`'s own subtree would be invisible until it
 * happened to be caught here. These two tests inject a hypothetical edge deep in each
 * closure, on a FRESH graph instance (buildGraph() is called again so the injection never
 * leaks into the done-when tests above), and confirm reaches() actually flips to true --
 * proving the assertion is sensitive to the regression it exists to catch, not merely
 * currently true by accident.
 */
describe("import graph: falsifiability of the done-when itself (mutation controls)", () => {
  it("(a) is falsifiable: an edge injected into list-libraries' closure flips it to true", () => {
    const g = buildGraph();
    const projectStoreEdges = g.edges.get("project-store");
    expect(projectStoreEdges).toBeDefined(); // the node must exist before mutating its edge set
    expect(reaches(g, "list-libraries", "fetcher")).toBe(false); // false before the injection
    // list-libraries -> project-store is already a direct edge; this adds project-store ->
    // fetcher, so the injected path is list-libraries -> project-store -> fetcher (2 hops) --
    // exactly the kind of regression landing one level into an otherwise-unpinned subtree.
    projectStoreEdges!.add("fetcher"); // hypothetical future regression
    expect(reaches(g, "list-libraries", "fetcher")).toBe(true);
  });

  it("(b) is falsifiable: an edge injected into retrieval's closure flips it to true", () => {
    const g = buildGraph();
    const tokenizeEdges = g.edges.get("tokenize");
    expect(tokenizeEdges).toBeDefined();
    expect(reaches(g, "retrieval", "config")).toBe(false); // false before the injection
    // retrieval -> tokenize is a direct edge; this adds tokenize -> config, so the injected
    // path is retrieval -> tokenize -> config (2 hops).
    tokenizeEdges!.add("config"); // hypothetical future regression
    expect(reaches(g, "retrieval", "config")).toBe(true);
  });
});

describe("parser unit tests over fixture strings -- never over src/, the type-only exclusion is load-bearing", () => {
  it("import type { T } from \"./d.js\" -- no runtime edge", () => {
    const es = extractEdges('import type { T } from "./d.js";');
    expect(es.length).toBeGreaterThan(0);
    expect(es.every((e) => e.isType)).toBe(true);
  });

  it("import { type T } from \"./d.js\" -- no runtime edge", () => {
    const es = extractEdges('import { type T } from "./d.js";');
    expect(es.length).toBeGreaterThan(0);
    expect(es.every((e) => e.isType)).toBe(true);
  });

  it("import { type T, value } from \"./d.js\" -- a MIXED clause counts as an edge", () => {
    const es = extractEdges('import { type T, value } from "./d.js";');
    expect(es.some((e) => e.specifier === "./d.js" && !e.isType)).toBe(true);
  });

  it(
    "import { T } from \"./d.js\" with no `type` keyword: this syntactic parser reports an " +
      "edge, even where tsc would elide it if T is used only as a type -- a documented, " +
      "accepted imprecision (module comment), never a hidden false negative",
    () => {
      const es = extractEdges('import { T } from "./d.js";');
      expect(es.some((e) => e.specifier === "./d.js" && !e.isType)).toBe(true);
    },
  );

  it("export { value } from \"./d.js\" -- an edge", () => {
    const es = extractEdges('export { value } from "./d.js";');
    expect(es.some((e) => e.specifier === "./d.js" && !e.isType)).toBe(true);
  });

  it("export { type T, value } from \"./d.js\" -- a mixed export clause is an edge (doctor.ts:17 is one today)", () => {
    const es = extractEdges('export { type T, value } from "./d.js";');
    expect(es.some((e) => e.specifier === "./d.js" && !e.isType)).toBe(true);
  });

  it("export { type T } from \"./d.js\" -- all-type export clause: no edge", () => {
    const es = extractEdges('export { type T } from "./d.js";');
    expect(es.length).toBeGreaterThan(0);
    expect(es.every((e) => e.isType)).toBe(true);
  });

  it("export * from \"./d.js\" -- an edge", () => {
    const es = extractEdges('export * from "./d.js";');
    expect(es.some((e) => e.specifier === "./d.js" && !e.isType)).toBe(true);
  });

  it("bare side-effect import \"./g.js\" -- an edge", () => {
    const es = extractEdges('import "./g.js";');
    expect(es.some((e) => e.specifier === "./g.js" && !e.isType)).toBe(true);
  });

  it('import {} from "./d.js" -- an EMPTY named clause is still a runtime side-effect import, not type-only', () => {
    const es = extractEdges('import {} from "./d.js";');
    expect(es.some((e) => e.specifier === "./d.js" && !e.isType)).toBe(true);
  });

  it("await import(\"./h.js\") -- an edge (dynamic import)", () => {
    const es = extractEdges('async function f() { const m = await import("./h.js"); return m; }');
    expect(es.some((e) => e.specifier === "./h.js" && !e.isType)).toBe(true);
  });

  it("a module name inside a // comment is never an edge", () => {
    const es = extractEdges('// import { x } from "./sneaky.js";\nconst y = 1;');
    expect(es).toEqual([]);
  });

  it("a module name inside a /* */ comment is never an edge", () => {
    const es = extractEdges('/* import { x } from "./sneaky.js"; */\nconst y = 1;');
    expect(es).toEqual([]);
  });

  it("a module name inside a string literal is never an edge", () => {
    const es = extractEdges(`const s = "import { x } from './sneaky.js'";`);
    expect(es).toEqual([]);
  });

  it(
    "the two-line shape at list-libraries.ts:1-2 -- a value import from a non-relative " +
      'specifier ("node:os"), then a type-only relative import -- fooled two reviewers\' first parsers',
    () => {
      const es = extractEdges('import { homedir } from "node:os";\nimport type { Registry } from "./registry.js";');
      const registryEdge = es.find((e) => e.specifier === "./registry.js");
      expect(registryEdge?.isType).toBe(true); // type-only: no runtime edge
      const osEdge = es.find((e) => e.specifier === "node:os");
      expect(osEdge?.isType).toBe(false); // a real value import in principle; buildGraph ignores it (not "./")
    },
  );

  it("a multi-line braced import clause is read across its own newlines", () => {
    const es = extractEdges('import {\n  a,\n  b,\n  type C,\n} from "./many.js";');
    expect(es.some((e) => e.specifier === "./many.js" && !e.isType)).toBe(true);
  });
});

describe("reaches(): traversal self-check over a hand-built fixture graph", () => {
  function fixtureGraph(adj: Record<string, string[]>): Pick<Graph, "edges"> {
    const edges = new Map<string, Set<string>>();
    for (const [k, vs] of Object.entries(adj)) edges.set(k, new Set(vs));
    return { edges };
  }

  it("a straight chain a -> b -> c: reaches(a,c) true, reaches(c,a) false", () => {
    const g = fixtureGraph({ a: ["b"], b: ["c"], c: [] });
    expect(reaches(g, "a", "c")).toBe(true);
    expect(reaches(g, "c", "a")).toBe(false);
  });

  it("a cycle does not infinite-loop, and an unreachable node stays unreachable", () => {
    const g = fixtureGraph({ a: ["b"], b: ["a"], c: [] });
    expect(reaches(g, "a", "c")).toBe(false);
    expect(reaches(g, "a", "b")).toBe(true);
    expect(reaches(g, "b", "a")).toBe(true);
  });

  it("a 3-hop-only path: no direct edge exists, yet reaches() still finds it (a depth-1 walk could not)", () => {
    const g = fixtureGraph({ a: ["b"], b: ["c"], c: ["d"], d: [] });
    expect(g.edges.get("a")?.has("d")).toBe(false);
    expect(reaches(g, "a", "d")).toBe(true);
  });

  it("an isolated node reaches nothing", () => {
    const g = fixtureGraph({ a: [], b: [] });
    expect(reaches(g, "a", "b")).toBe(false);
  });
});

describe("behavioural control: the graph claim is a proxy -- prove it once at runtime too", () => {
  // CLAIM DISCIPLINE (binding on this comment too): this does not show list_libraries
  // "prevents an SSRF" or "closes a network path" in general -- there is exactly one fetch
  // call site in the whole codebase (fetcher.ts:144), and what keeps list_libraries off it
  // is its CALL graph, which this IMPORT-graph suite only proxies for. This one behavioural
  // test is the actual call-graph check: with global fetch stubbed to throw, listLibrariesText
  // must still return normally, because it was never going to call fetch at all.
  let cacheDir: string;
  beforeEach(() => {
    // A declared, disposable cache directory -- not the developer's real ~/.vibectx -- matching
    // this repo's own convention (test/list-libraries.test.ts) for anything that calls into
    // cache.ts, so the test's inputs are all visible in the test itself.
    cacheDir = mkdtempSync(join(tmpdir(), "vibectx-import-graph-"));
    process.env.VIBECTX_CACHE_DIR = cacheDir;
  });
  afterEach(() => {
    delete process.env.VIBECTX_CACHE_DIR;
    rmSync(cacheDir, { recursive: true, force: true });
  });

  it("listLibrariesText returns normally even with global fetch stubbed to throw", () => {
    const throwingFetch = vi.fn(() => {
      throw new Error("fetch should never be reached from listLibrariesText");
    });
    vi.stubGlobal("fetch", throwingFetch);
    try {
      const registry: Registry = {
        entries: new Map([["react", { name: "react", urls: ["https://react.dev/llms.txt"] }]]),
      };
      const text = listLibrariesText(registry);
      expect(typeof text).toBe("string");
      // Proves the row-rendering path actually ran, not just that SOME non-empty header came
      // back (an empty registry also renders a non-empty header).
      expect(text).toContain("react");
      expect(throwingFetch).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

