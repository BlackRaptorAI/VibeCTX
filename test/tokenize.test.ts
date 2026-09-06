import { describe, it, expect } from "vitest";
import { tokenize, STOPWORDS, MAX_TOKEN_CHARS } from "../src/tokenize.js";

/**
 * D-23 — one tokenizer for query, headings, bodies and code. The contract these
 * tests pin: lowercase, split on non-alphanumerics, split camelCase/PascalCase
 * with a linear scanner, keep the whole compound too, light suffix stemming,
 * stopwords with an all-stopword fallback, 1-char tokens dropped.
 */

describe("tokenize — camelCase and PascalCase splitting (D-23)", () => {
  it("splits camelCase and keeps the whole lowercased compound", () => {
    expect(tokenize("useEffect")).toEqual(["use", "effect", "useeffect"]);
  });

  it("splits PascalCase", () => {
    expect(tokenize("QueryClient")).toEqual(["query", "client", "queryclient"]);
  });

  it("splits an acronym run before the following word", () => {
    expect(tokenize("HTTPServer")).toEqual(["http", "server", "httpserver"]);
    expect(tokenize("parseJSONBody")).toEqual(["parse", "json", "body", "parsejsonbody"]);
  });

  it("keeps a bare acronym as one token", () => {
    expect(tokenize("HTTP")).toEqual(["http"]);
  });

  it("does not emit a compound when the run has a single subword", () => {
    expect(tokenize("router")).toEqual(["router"]);
  });

  it("keeps digits attached to the preceding subword and never splits on them", () => {
    expect(tokenize("utf8")).toEqual(["utf8"]);
    expect(tokenize("s3Client")).toEqual(["s3", "client", "s3client"]);
    expect(tokenize("h1")).toEqual(["h1"]);
  });

  it("splits on every non-alphanumeric run, including dots and underscores", () => {
    expect(tokenize("prisma.user.upsert(")).toEqual(["prisma", "user", "upsert"]);
    expect(tokenize("row_level__security")).toEqual(["row", "level", "security"]);
    expect(tokenize("---")).toEqual([]);
  });

  it("splits a mixed identifier path the way an agent would say it", () => {
    expect(tokenize("stripe.checkout.sessions.create")).toEqual([
      "stripe",
      "checkout",
      "session",
      "create",
    ]);
  });
});

describe("tokenize — token length rules (D-23)", () => {
  it("keeps 2-char tokens and drops 1-char tokens", () => {
    expect(tokenize("go a to b ok")).toEqual(["go", "ok"]); // "to" is a stopword, a/b are 1-char
    expect(tokenize("ui")).toEqual(["ui"]);
    expect(tokenize("x")).toEqual([]);
  });

  it("drops tokens longer than MAX_TOKEN_CHARS (hostile-input guard)", () => {
    expect(tokenize("z".repeat(MAX_TOKEN_CHARS))).toEqual(["z".repeat(MAX_TOKEN_CHARS)]);
    expect(tokenize("z".repeat(MAX_TOKEN_CHARS + 1))).toEqual([]);
  });
});

describe("tokenize — light suffix stemmer (D-23)", () => {
  it("ies → y", () => {
    expect(tokenize("policies")).toEqual(["policy"]);
    expect(tokenize("queries")).toEqual(["query"]);
  });

  it("sses → ss", () => {
    expect(tokenize("classes")).toEqual(["class"]);
  });

  it("drops a trailing s but never a trailing ss", () => {
    expect(tokenize("hooks")).toEqual(["hook"]);
    expect(tokenize("class")).toEqual(["class"]);
    expect(tokenize("press")).toEqual(["press"]);
  });

  it("drops ing and ed", () => {
    expect(tokenize("streaming")).toEqual(["stream"]);
    expect(tokenize("matched")).toEqual(["match"]);
  });

  it("applies the plural rule then the ing/ed rule, so plural gerunds converge", () => {
    expect(tokenize("settings")).toEqual(tokenize("setting"));
    expect(tokenize("settings")).toEqual(["sett"]);
  });

  it("never stems below three characters", () => {
    expect(tokenize("ring")).toEqual(["ring"]); // ing → "r" is too short
    expect(tokenize("used")).toEqual(["used"]); // ed → "us" is too short
  });

  it("falls through to the next plural rule when one would cut below three characters", () => {
    // ies → "ty" is too short, so the trailing-s rule applies instead — and that is
    // what makes "tie" and "ties" agree, which refusing to stem would not.
    expect(tokenize("ties")).toEqual(["tie"]);
    expect(tokenize("ties")).toEqual(tokenize("tie"));
  });

  it("never stems tokens shorter than four characters", () => {
    expect(tokenize("ads")).toEqual(["ads"]);
    expect(tokenize("bed")).toEqual(["bed"]);
  });

  it("never stems a token containing a digit", () => {
    expect(tokenize("utf8s")).toEqual(["utf8s"]);
    expect(tokenize("h264ing")).toEqual(["h264ing"]);
  });

  it("stems the compound as well as the subwords, so identifiers still match", () => {
    expect(tokenize("useQueries")).toEqual(["use", "query", "usequery"]);
  });

  it("makes a camelCase identifier and its spelled-out query agree", () => {
    expect(tokenize("invalidateQueries")).toEqual(
      expect.arrayContaining(tokenize("invalidate queries")),
    );
  });
});

describe("tokenize — stopwords (D-23)", () => {
  it("removes stopwords from a mixed query", () => {
    expect(tokenize("how do I use the router in my app")).toEqual(["use", "router", "app"]);
  });

  it("falls back to no stopword removal when every token is a stopword", () => {
    // The fallback restores the words; stemming still runs over them ("this" → "thi"),
    // exactly as it would for any other token, so the query is never left with no terms.
    expect(tokenize("how to do this")).toEqual(["how", "to", "do", "thi"]);
    expect(tokenize("with")).toEqual(["with"]);
    expect(tokenize("how to do this")).not.toHaveLength(0);
  });

  it("removes stopwords before stemming, so 'does' cannot survive as 'doe'", () => {
    expect(tokenize("does the router work")).toEqual(["router", "work"]);
    expect(STOPWORDS.has("does")).toBe(true);
  });

  it("returns nothing for input with no usable tokens", () => {
    expect(tokenize("")).toEqual([]);
    expect(tokenize("   ---   ")).toEqual([]);
  });
});

describe("tokenize — determinism and hostile input (D-23)", () => {
  it("is deterministic across repeated calls", () => {
    const text = "Use invalidateQueries after a mutation; see QueryClient.setQueryData().";
    expect(tokenize(text)).toEqual(tokenize(text));
  });

  it("tokenizes a 1 MB alternating-case string in under 500 ms", () => {
    const hostile = "aA".repeat(512 * 1024); // 1 MiB, a camelCase boundary every 2 chars
    const t0 = performance.now();
    const out = tokenize(hostile);
    const ms = performance.now() - t0;
    // Worst case for the scanner: one run, half a million subwords, the compound
    // dropped for being over the cap. The output must stay bounded and uniform.
    expect(new Set(out)).toEqual(new Set(["aa"]));
    // 524289 subwords, the leading "a" and trailing "A" dropped for being 1 char.
    expect(out.length).toBe(524_287);
    expect(ms).toBeLessThan(500);
  });

  it("tokenizes 1 MB of separators in under 500 ms", () => {
    const hostile = "-".repeat(1024 * 1024);
    const t0 = performance.now();
    const out = tokenize(hostile);
    const ms = performance.now() - t0;
    expect(out).toEqual([]);
    expect(ms).toBeLessThan(500);
  });

  it("tokenizes a 1 MB single-run string in under 500 ms", () => {
    const hostile = "x".repeat(1024 * 1024);
    const t0 = performance.now();
    const out = tokenize(hostile);
    const ms = performance.now() - t0;
    expect(out).toEqual([]); // one run, over MAX_TOKEN_CHARS
    expect(ms).toBeLessThan(500);
  });
});
