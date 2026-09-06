import { describe, it, expect } from "vitest";
import { npmNameError, pypiNameError, normalisePyPiName, packageNameError } from "../src/package-names.js";

describe("npmNameError (npm naming rules; undefined = valid)", () => {
  it.each(["hono", "httpx", "stripe", "@tanstack/react-query", "@scope/pkg.js", "a", "lodash-es", "some_pkg", "pkg~1", "@types/node"])(
    "accepts %s",
    (name) => expect(npmNameError(name)).toBeUndefined(),
  );

  it.each([
    ["an empty string", ""],
    ["whitespace", "   "],
    ["uppercase", "Hono"],
    ["a leading dot", ".hidden"],
    ["a leading underscore", "_private"],
    ["a scope with a leading dot", "@.scope/pkg"],
    ["a missing scope name", "@/pkg"],
    ["a missing package after the scope", "@scope/"],
    ["two slashes", "@scope/a/b"],
    ["a slash without a scope", "a/b"],
    ["a space", "my pkg"],
    ["a URL", "https://registry.npmjs.org/hono"],
    ["path traversal", "../etc/passwd"],
    ["a query string", "hono?x=1"],
    ["a percent sign", "ho%6eo"],
    ["a colon", "hono:latest"],
    ["a newline", "hono\n"],
    ["215 characters", "a".repeat(215)],
    ["unicode", "héllo"],
  ])("rejects %s", (_label, name) => {
    expect(npmNameError(name)).toMatch(/npm/);
  });

  it("accepts exactly 214 characters", () => {
    expect(npmNameError("a".repeat(214))).toBeUndefined();
  });
});

describe("normalisePyPiName / pypiNameError (PEP 503)", () => {
  it("folds runs of -, _ and . to a single hyphen and lowercases", () => {
    expect(normalisePyPiName("Django_REST.framework")).toBe("django-rest-framework");
    expect(normalisePyPiName("httpx")).toBe("httpx");
    expect(normalisePyPiName("a--b__c..d")).toBe("a-b-c-d");
  });

  it.each(["httpx", "Django", "typing_extensions", "zope.interface", "a", "A1", "py-3"])("accepts %s", (name) => {
    expect(pypiNameError(name)).toBeUndefined();
  });

  it.each([
    ["an empty string", ""],
    ["a leading hyphen", "-httpx"],
    ["a trailing dot", "httpx."],
    ["a slash", "encode/httpx"],
    ["a space", "http x"],
    ["an @", "@httpx"],
    ["a URL", "https://pypi.org/project/httpx"],
    ["unicode", "httpx™"],
    ["a newline", "httpx\n"],
    ["215 characters", "a".repeat(215)],
  ])("rejects %s", (_label, name) => {
    expect(pypiNameError(name)).toMatch(/PyPI/);
  });
});

describe("packageNameError (either ecosystem)", () => {
  it("is undefined when at least one ecosystem accepts the name, else names both rules", () => {
    expect(packageNameError("hono")).toBeUndefined();
    expect(packageNameError("@tanstack/react-query")).toBeUndefined(); // npm-only shape
    expect(packageNameError("zope.interface")).toBeUndefined(); // valid in both
    expect(packageNameError("Django")).toBeUndefined(); // PyPI accepts mixed case; npm does not
    expect(packageNameError("https://evil.example/x")).toMatch(/not a valid npm or PyPI package name/);
    expect(packageNameError("../x")).toMatch(/not a valid npm or PyPI package name/);
    expect(packageNameError("")).toMatch(/not a valid npm or PyPI package name/);
  });
});
