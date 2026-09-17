import { describe, it, expect } from "vitest";
import { urlSlug, libDirName, metaMatchesSlug, toCacheMeta } from "../src/cache-meta.js";

/**
 * D-71 (PAR-749, Root 1) — direct unit coverage of the injective transforms, independent of
 * any cache read/write behavior exercised elsewhere. The three pairs below are the exact
 * examples PAR-749's own "the two roots" table used to demonstrate the pre-fix collision: every
 * non-alphanumeric character folded to `_`, so these produced the identical slug.
 */
describe("D-71 (PAR-749, Root 1) — urlSlug is injective", () => {
  it.each([
    ["https://x.dev/a-b", "https://x.dev/a_b"],
    ["https://x.dev/api.v1", "https://x.dev/api-v1"],
    ["https://x.dev/docs/intro", "https://x.dev/docs-intro"],
  ])("%s and %s no longer share a slug", (a, b) => {
    expect(urlSlug(a)).not.toBe(urlSlug(b));
  });

  it("is a pure, deterministic function of the URL alone", () => {
    const url = "https://react.dev/llms.txt";
    expect(urlSlug(url)).toBe(urlSlug(url));
  });

  it("two URLs sharing a 120+ character common prefix (the truncation-collision case) still produce distinct slugs", () => {
    const prefix = "https://example.com/" + "a".repeat(200);
    expect(urlSlug(`${prefix}-one`)).not.toBe(urlSlug(`${prefix}-two`));
  });

  it("stays a bounded, filesystem-safe string — exactly 120 folded chars + 1 separator + 12 hash chars", () => {
    const slug = urlSlug("https://example.com/" + "x".repeat(5000));
    expect(slug.length).toBe(120 + 1 + 12);
    expect(slug).toMatch(/^[a-z0-9_]+$/i);
  });
});

describe("D-71 (PAR-749, Root 1) — libDirName is injective", () => {
  it("two npm names that fold to the same characters no longer share a directory name", () => {
    expect(libDirName("foo.bar")).not.toBe(libDirName("foo_bar"));
  });

  it("is a pure, deterministic function of the library name alone", () => {
    expect(libDirName("react")).toBe(libDirName("react"));
  });

  it("never collapses an empty library name to an empty or root-shaped path segment", () => {
    expect(libDirName("")).not.toBe("");
  });
});

describe("PAR-776 (D-74) — toCacheMeta's finalUrl", () => {
  const url = "https://react.dev/llms.txt";
  const fetchedAt = "2026-01-01T00:00:00.000Z";

  it("is absent when the raw record never had one", () => {
    expect(toCacheMeta({ url, fetchedAt })!.finalUrl).toBeUndefined();
  });

  it("round-trips a valid, parseable finalUrl", () => {
    const finalUrl = "https://docs.react.dev/llms.txt";
    expect(toCacheMeta({ url, fetchedAt, finalUrl })!.finalUrl).toBe(finalUrl);
  });

  it("is dropped alone — not the whole record — when unparseable, oversized, or the wrong type", () => {
    expect(toCacheMeta({ url, fetchedAt, finalUrl: "not a url" })!.finalUrl).toBeUndefined();
    expect(toCacheMeta({ url, fetchedAt, finalUrl: "https://x.dev/" + "a".repeat(2048) })!.finalUrl).toBeUndefined();
    expect(toCacheMeta({ url, fetchedAt, finalUrl: 12345 })!.finalUrl).toBeUndefined();
    // None of these malformed finalUrl values invalidate the record as a whole.
    expect(toCacheMeta({ url, fetchedAt, finalUrl: "not a url" })!.url).toBe(url);
  });

  /** Code-reviewer, PAR-776 round 1, B1 / security-architect, PAR-776 round 1, B-1: `finalUrl`
   *  is used as the same-origin base for `get-docs.ts`'s host-policy check — `link-policy.ts`'s
   *  `isAllowedLink` grants a document's own host unconditionally — so a value merely SHAPED
   *  like a URL is not enough, unlike `url` itself. These are the exact rejections that make it
   *  `sanitizeRemoteUrl`, not `validMetaUrl`: a hand-edited or corrupted `.meta.json` handing a
   *  caller a hostile "trusted" origin. */
  it("(code-reviewer/security-architect, PAR-776 round 1, B1/B-1) rejects http, userinfo, and forbidden-host finalUrl values a hostile or corrupted .meta.json could carry", () => {
    expect(toCacheMeta({ url, fetchedAt, finalUrl: "http://docs.react.dev/llms.txt" })!.finalUrl).toBeUndefined();
    expect(toCacheMeta({ url, fetchedAt, finalUrl: "https://user:pass@docs.react.dev/llms.txt" })!.finalUrl).toBeUndefined();
    expect(toCacheMeta({ url, fetchedAt, finalUrl: "https://127.0.0.1/llms.txt" })!.finalUrl).toBeUndefined();
    expect(toCacheMeta({ url, fetchedAt, finalUrl: "https://localhost/llms.txt" })!.finalUrl).toBeUndefined();
    expect(toCacheMeta({ url, fetchedAt, finalUrl: "file:///etc/passwd" })!.finalUrl).toBeUndefined();
    expect(toCacheMeta({ url, fetchedAt, finalUrl: "javascript:alert(1)" })!.finalUrl).toBeUndefined();
  });

  it("normalises finalUrl the same way sanitizeRemoteUrl does (e.g. strips a fragment) rather than storing the raw string verbatim", () => {
    const meta = toCacheMeta({ url, fetchedAt, finalUrl: "https://docs.react.dev/llms.txt#section" })!;
    expect(meta.finalUrl).toBe("https://docs.react.dev/llms.txt");
  });
});

describe("D-71 (PAR-749, Root 1) — metaMatchesSlug", () => {
  const url = "https://react.dev/llms.txt";
  const meta = toCacheMeta({ url, fetchedAt: "2026-01-01T00:00:00.000Z" })!;

  it("true when the meta's own url round-trips to the given slug via urlSlug", () => {
    expect(metaMatchesSlug(meta, urlSlug(url))).toBe(true);
  });

  it("false for any other slug, including one belonging to a different real URL", () => {
    expect(metaMatchesSlug(meta, urlSlug("https://react.dev/other-page.md"))).toBe(false);
    expect(metaMatchesSlug(meta, "not-a-real-slug")).toBe(false);
  });
});
