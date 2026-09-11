import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { cleanText, clipText } from "../src/text.js";

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
        "[\\u0000-\\u001f\\u007f-\\u009f\\u200b-\\u200f\\u202a-\\u202e\\u2066-\\u2069\\ufeff]", // the one control/bidi class, /g -- D-48's single shared contract
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
    const dirty = "a" + String.fromCharCode(0x00, 0x00, 0x00) + "b"; // clean length 2, well under max
    expect(clipText(dirty, 5)).toBe("ab");
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

