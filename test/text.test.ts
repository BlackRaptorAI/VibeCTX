import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { cleanText, clipText, stripControlBidi } from "../src/text.js";

/**
 * Relocated regex allow-list tripwire (A8 / PAR-721, Move 3). cleanText's control/bidi
 * character class used to live in project-deps.ts, guarded there by a text-scan tripwire
 * (a ReDoS allow-list guard: the project shipped a 0.1.3 hotfix for a ReDoS link regex,
 * and this is the guard against a repeat). The move relocates the pattern to this file,
 * so the guard moves with it -- never trimmed, never left behind on an unguarded module.
 */
describe("text.ts regex allow-list tripwire", () => {
  it("the module's regex literals are exactly the allow-listed control/bidi class", () => {
    const src = readFileSync(new URL("../src/text.ts", import.meta.url), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "") // block comments
      .replace(/\/\/.*$/gm, ""); // line comments
    const literals = [...src.matchAll(/(?:^|[=(,:\s])\/((?:\\.|\[(?:\\.|[^\]\n])*\]|[^/\n\\[])+)\/[gimsuy]*/g)].map((m) => m[1]);
    expect(new Set(literals)).toEqual(
      new Set([
        "[\\u0000-\\u001f\\u007f-\\u009f\\u200b-\\u200f\\u2028\\u2029\\u202a-\\u202e\\u2066-\\u2069\\ufeff]", // the one control/bidi class, /g -- D-48's single shared contract (A7/PAR-720: now includes U+2028/U+2029)
      ]),
    );
  });
});

describe("cleanText (A8 / PAR-721, Move 3 -- moved from project-deps.ts; behaviour unchanged)", () => {
  const chars = (...codes: number[]): string => codes.map((c) => String.fromCharCode(c)).join("");

  it("strips the C0 control range (U+0000-U+001F)", () => {
    expect(cleanText("a" + chars(0x00, 0x1f) + "b")).toBe("ab");
  });
  it("strips the C1 / DEL range (U+007F-U+009F)", () => {
    expect(cleanText("a" + chars(0x7f, 0x9f) + "b")).toBe("ab");
  });
  it("strips zero-width and bidi-mark code points (U+200B-U+200F)", () => {
    expect(cleanText("a" + chars(0x200b, 0x200f) + "b")).toBe("ab");
  });
  it("strips bidi embedding/override controls (U+202A-U+202E)", () => {
    expect(cleanText("a" + chars(0x202a, 0x202e) + "b")).toBe("ab");
  });
  it("strips bidi isolate controls (U+2066-U+2069)", () => {
    expect(cleanText("a" + chars(0x2066, 0x2069) + "b")).toBe("ab");
  });
  it("strips a BOM / zero-width no-break space (U+FEFF)", () => {
    expect(cleanText(chars(0xfeff) + "hello")).toBe("hello");
  });
  it("strips the line/paragraph separators (U+2028/U+2029) -- A7/PAR-720: previously caught only by debug.ts's own copy", () => {
    expect(cleanText("a" + chars(0x2028, 0x2029) + "b")).toBe("ab");
  });
  it("leaves ordinary text, including punctuation, untouched", () => {
    expect(cleanText("hello, world! 123 -- OK?")).toBe("hello, world! 123 -- OK?");
  });
  it("empty string", () => {
    expect(cleanText("")).toBe("");
  });
});

describe("clipText -- first direct tests (A8 / PAR-721): zero existed before this move", () => {
  it("returns short text unchanged, no ellipsis", () => {
    expect(clipText("hello", 10)).toBe("hello");
  });
  it("boundary: clean length === max -- no clip, no ellipsis", () => {
    expect(clipText("hello", 5)).toBe("hello");
  });
  it("boundary: clean length === max + 1 -- clips exactly one character for the ellipsis", () => {
    expect(clipText("hello!", 5)).toBe("hell\u2026");
    expect(clipText("hello!", 5)).toHaveLength(5);
  });
  it("cleans control/bidi characters BEFORE measuring length against max", () => {
    // dirty.length is 5, clean.length is 2. max=3 is chosen to DISCRIMINATE the two orderings:
    // clean-then-measure (correct) sees length 2 <= 3 and returns "ab" unclipped; a
    // measure-then-clean bug would see the DIRTY length 5 > 3, slice(0, max-1=2) of the dirty
    // string to "a\x00" (2 chars: "a" then one NUL) then clean IT, giving "a" + the ellipsis --
    // a different, wrong, and shorter result. A max of 5 (both lengths equal) cannot tell the
    // two apart.
    const dirty = "a" + String.fromCharCode(0x00, 0x00, 0x00) + "b";
    expect(clipText(dirty, 3)).toBe("ab");
  });
  it("max of 1: the whole budget is spent on the ellipsis", () => {
    expect(clipText("hello", 1)).toBe("\u2026");
  });
  it("max smaller than the ellipsis needs (0): slice(0, -1) still drops only the last character", () => {
    // max - 1 === -1, and String.prototype.slice(0, -1) means \"all but the last character\",
    // not \"nothing\" -- so clipText(s, 0) is NOT just the ellipsis for a 5-character s.
    expect(clipText("hello", 0)).toBe("hell\u2026");
  });
  it("empty string input, any max", () => {
    expect(clipText("", 10)).toBe("");
    expect(clipText("", 0)).toBe("");
  });
});

describe("stripControlBidi -- the one exported binding onto the D-48 class (A7 / PAR-720)", () => {
  const chars = (...codes: number[]): string => codes.map((c) => String.fromCharCode(c)).join("");

  it("defaults to delete, identically to cleanText", () => {
    const dirty = "a" + chars(0x00, 0x9b, 0x200b, 0xfeff) + "b";
    expect(stripControlBidi(dirty)).toBe(cleanText(dirty));
    expect(stripControlBidi(dirty)).toBe("ab");
  });
  it("substitutes the given replacement for every matched character, not just the first", () => {
    expect(stripControlBidi("a" + chars(0x00, 0x9b) + "b", " ")).toBe("a  b");
  });
  it("U+009B (control sequence introducer) is matched -- the character this issue exists for", () => {
    expect(stripControlBidi("fast" + chars(0x9b) + "web", " ")).toBe("fast web");
  });
  it("leaves ordinary text untouched with any replacement", () => {
    expect(stripControlBidi("hello, world!", "X")).toBe("hello, world!");
  });
});

