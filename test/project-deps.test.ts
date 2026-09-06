import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEPENDENCY_DENYLIST,
  isDeniedDependency,
  parsePackageJsonDeps,
  parsePyprojectDeps,
  parseRequirementsTxt,
  parsePackageLockDeps,
  parsePnpmLockDeps,
  requirementName,
  discoverProjectDependencies,
} from "../src/project-deps.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "vibectx-deps-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function write(name: string, content: string): void {
  writeFileSync(join(dir, name), content, "utf8");
}

describe("DEPENDENCY_DENYLIST / isDeniedDependency (PAR-656)", () => {
  it("is an exported, documented constant with an npm and a pypi list", () => {
    expect(Object.keys(DEPENDENCY_DENYLIST).sort()).toEqual(["npm", "pypi"]);
    expect(DEPENDENCY_DENYLIST.npm).toContain("@types/*");
    expect(DEPENDENCY_DENYLIST.pypi).toContain("pip");
  });

  it.each([
    ["@types/node", "npm"],
    ["@types/react", "npm"],
    ["eslint", "npm"],
    ["eslint-config-next", "npm"],
    ["@eslint/eslintrc", "npm"],
    ["prettier", "npm"],
    ["prettier-plugin-tailwindcss", "npm"],
    ["@typescript-eslint/parser", "npm"],
    ["tslib", "npm"],
    ["@babel/core", "npm"],
    ["postcss", "npm"],
    ["autoprefixer", "npm"],
    ["husky", "npm"],
    ["lint-staged", "npm"],
    ["setuptools", "pypi"],
    ["setuptools-scm", "pypi"],
    ["wheel", "pypi"],
    ["pip", "pypi"],
    ["build", "pypi"],
    ["twine", "pypi"],
    ["black", "pypi"],
  ] as const)("denies %s (%s)", (name, eco) => {
    expect(isDeniedDependency(name, eco)).toBe(true);
  });

  it.each([
    ["typescript", "npm"],
    ["pytest", "pypi"],
    ["pytest-asyncio", "pypi"],
    ["ruff", "pypi"],
    ["next", "npm"],
    ["build", "npm"], // `build` is denied on PyPI only
    ["postcss-nesting", "npm"], // only the bare `postcss` is denied
    ["types", "npm"], // `@types/*` is a scope rule, not a substring rule
  ] as const)("keeps %s (%s)", (name, eco) => {
    expect(isDeniedDependency(name, eco)).toBe(false);
  });

  it("a trailing `*` is a prefix rule (eslint* covers eslint-plugin-x); a bare name is exact", () => {
    expect(isDeniedDependency("eslint-plugin-react", "npm")).toBe(true);
    expect(isDeniedDependency("husky-hooks", "npm")).toBe(false);
  });

  it("matches PyPI names in their PEP 503 form", () => {
    expect(isDeniedDependency("Setuptools_SCM", "pypi")).toBe(true);
    expect(isDeniedDependency("BLACK", "pypi")).toBe(true);
  });
});

describe("parsePackageJsonDeps", () => {
  it("reads dependencies then devDependencies in file order; peer / optional / bundled are not read", () => {
    const names = parsePackageJsonDeps(
      JSON.stringify({
        name: "app",
        dependencies: { next: "15.0.0", react: "^19", "@supabase/supabase-js": "^2" },
        devDependencies: { typescript: "^5", vitest: "^3" },
        peerDependencies: { "peer-only": "*" },
        optionalDependencies: { "optional-only": "*" },
      }),
    );
    expect(names).toEqual(["next", "react", "@supabase/supabase-js", "typescript", "vitest"]);
  });

  it("unwraps npm: alias specs to the real package and skips file:/link:/workspace:/portal: specs", () => {
    expect(
      parsePackageJsonDeps(
        JSON.stringify({
          dependencies: {
            "my-react": "npm:react@^19",
            "my-scoped": "npm:@tanstack/react-query@5",
            local: "file:../local",
            linked: "link:../linked",
            sibling: "workspace:*",
            portal: "portal:../p",
            git: "github:honojs/hono",
          },
        }),
      ),
    ).toEqual(["react", "@tanstack/react-query", "git"]);
  });

  it("de-duplicates and tolerates a malformed or dependency-less manifest", () => {
    expect(parsePackageJsonDeps(JSON.stringify({ dependencies: { a: "1" }, devDependencies: { a: "1" } }))).toEqual(["a"]);
    expect(parsePackageJsonDeps("{}")).toEqual([]);
    expect(parsePackageJsonDeps(JSON.stringify({ dependencies: ["not", "an", "object"] }))).toEqual([]);
    expect(() => parsePackageJsonDeps("{ not json")).toThrow();
  });
});

describe("requirementName (PEP 508 → project name)", () => {
  it.each([
    ["requests", "requests"],
    ["requests>=2.31,<3", "requests"],
    ["Django==5.0", "django"],
    ["httpx[http2]>=0.27", "httpx"],
    ['uvicorn[standard] ; python_version >= "3.10"', "uvicorn"],
    ["typing_extensions", "typing-extensions"],
    ["Typing.Extensions~=4.0", "typing-extensions"],
    ["pytest (>=7.0)", "pytest"],
    ["pydantic @ https://example.com/pydantic.whl", "pydantic"],
    ["  numpy  # trailing comment", "numpy"],
  ])("%s → %s", (spec, name) => {
    expect(requirementName(spec)).toBe(name);
  });

  it.each(["", "   ", "# comment only", "-r other.txt", "-e .", "-e git+https://x/y.git#egg=z", "./local/path", "../up", "/abs/path", "https://example.com/x.whl", "git+https://github.com/o/r.git", "--index-url https://x", "-c constraints.txt"])(
    "skips %j",
    (spec) => {
      expect(requirementName(spec)).toBeUndefined();
    },
  );
});

describe("parseRequirementsTxt", () => {
  it("strips versions, extras, markers, comments and continuation lines; reports -r includes", () => {
    const { names, includes } = parseRequirementsTxt(
      [
        "# web",
        "fastapi>=0.110  # api",
        "uvicorn[standard]; sys_platform != 'win32'",
        "SQLAlchemy \\",
        "  >=2.0",
        "",
        "-r requirements-base.txt",
        "--requirement requirements-extra.txt",
        "-c constraints.txt",
        "-e .",
        "--index-url https://pypi.example",
        "typing_extensions",
        "fastapi==0.111  # duplicate",
      ].join("\n"),
    );
    expect(names).toEqual(["fastapi", "uvicorn", "sqlalchemy", "typing-extensions"]);
    expect(includes).toEqual(["requirements-base.txt", "requirements-extra.txt"]);
  });
});

describe("parsePyprojectDeps (minimal TOML reader)", () => {
  it("reads [project].dependencies, optional-dependencies, dependency-groups and poetry tables", () => {
    const names = parsePyprojectDeps(`
[build-system]
requires = ["setuptools>=68", "wheel"]  # NOT a dependency table

[project]
name = "svc"
dependencies = [
  "fastapi>=0.110",   # api
  "httpx[http2]",
  'pydantic>=2',
]
readme = "README.md"

[project.optional-dependencies]
dev = ["pytest>=8", "ruff"]
docs = [
  "mkdocs",
]

[dependency-groups]
test = ["pytest-cov", { include-group = "dev" }]

[tool.poetry]
name = "svc"

[tool.poetry.dependencies]
python = "^3.11"
requests = "^2.31"
"Typing_Extensions" = { version = "*", optional = true }
boto3 = { version = "1.0", extras = ["s3"] }

[tool.poetry.group.dev.dependencies]
mypy = "*"

[tool.poetry.dev-dependencies]
black = "*"

[tool.ruff]
line-length = 120
`);
    expect(names).toEqual([
      "fastapi",
      "httpx",
      "pydantic",
      "pytest",
      "ruff",
      "mkdocs",
      "pytest-cov",
      "requests",
      "typing-extensions",
      "boto3",
      "mypy",
      "black",
    ]);
  });

  it("ignores strings that merely contain '#' or brackets, and arrays in unrelated tables", () => {
    const names = parsePyprojectDeps(`
[project]
description = "uses [brackets] and # hashes"
dependencies = ["a # not a comment inside a string", "b"]
[tool.other]
dependencies = ["nope"]
`);
    expect(names).toEqual(["a", "b"]);
  });

  it("returns [] for a file with none of the tables", () => {
    expect(parsePyprojectDeps('[tool.black]\nline-length = 88\n')).toEqual([]);
  });
});

describe("lockfile fallbacks (names only, used when the manifest is absent)", () => {
  it("package-lock v2/v3: root package's dependencies + devDependencies; v1 has no root list → []", () => {
    const v3 = JSON.stringify({
      lockfileVersion: 3,
      packages: {
        "": { dependencies: { next: "15", react: "19" }, devDependencies: { typescript: "5" } },
        "node_modules/next": { version: "15.0.0" },
        "node_modules/transitive": { version: "1.0.0" },
      },
    });
    expect(parsePackageLockDeps(v3)).toEqual(["next", "react", "typescript"]);
    const v1 = JSON.stringify({ lockfileVersion: 1, dependencies: { next: { version: "15" }, transitive: { version: "1" } } });
    expect(parsePackageLockDeps(v1)).toEqual([]);
  });

  it("pnpm-lock: importers['.'] (v6+/v9) or the top-level dependencies blocks (v5); keys may be quoted", () => {
    const v9 = `lockfileVersion: '9.0'
settings:
  autoInstallPeers: true
importers:
  .:
    dependencies:
      next:
        specifier: 15.0.0
        version: 15.0.0
      '@supabase/supabase-js':
        specifier: ^2
        version: 2.45.0
    devDependencies:
      typescript:
        specifier: ^5
        version: 5.6.0
  packages/other:
    dependencies:
      lodash:
        specifier: ^4
        version: 4.17.21
packages:
  next@15.0.0:
    resolution: {integrity: sha512-x}
`;
    expect(parsePnpmLockDeps(v9)).toEqual(["next", "@supabase/supabase-js", "typescript"]);
    const v5 = `lockfileVersion: 5.4
specifiers:
  react: ^18
dependencies:
  react: 18.3.1
devDependencies:
  vitest: 1.0.0
packages:
  /react/18.3.1:
    resolution: {integrity: x}
`;
    expect(parsePnpmLockDeps(v5)).toEqual(["react", "vitest"]);
  });
});

describe("discoverProjectDependencies", () => {
  it("reads every manifest present, in a fixed order, de-duplicated per ecosystem, with the source file per name", () => {
    write("package.json", JSON.stringify({ dependencies: { next: "15", stripe: "^16" }, devDependencies: { typescript: "5", "@types/node": "22" } }));
    write("pyproject.toml", '[project]\ndependencies = ["httpx", "Typing_Extensions"]\n');
    write("requirements.txt", "httpx==0.27\nfastapi\n-r requirements-dev.txt\n");
    write("requirements-dev.txt", "pytest\ntyping-extensions\n");
    write("package-lock.json", JSON.stringify({ lockfileVersion: 3, packages: { "": { dependencies: { "from-lock": "1" } } } })); // ignored: manifest present
    const out = discoverProjectDependencies(dir);
    expect(out.dir).toBe(dir);
    expect(out.manifests).toEqual(["package.json", "pyproject.toml", "requirements.txt", "requirements-dev.txt"]);
    expect(out.dependencies).toEqual([
      { name: "next", ecosystem: "npm", source: "package.json" },
      { name: "stripe", ecosystem: "npm", source: "package.json" },
      { name: "typescript", ecosystem: "npm", source: "package.json" },
      { name: "@types/node", ecosystem: "npm", source: "package.json" }, // discovery keeps it; warm marks it denied
      { name: "httpx", ecosystem: "pypi", source: "pyproject.toml" },
      { name: "typing-extensions", ecosystem: "pypi", source: "pyproject.toml" },
      { name: "fastapi", ecosystem: "pypi", source: "requirements.txt" },
      { name: "pytest", ecosystem: "pypi", source: "requirements-dev.txt" },
    ]);
    expect(out.notes).toEqual([]);
  });

  it("-r includes are followed one level only, relative to the including file, and never outside the project directory", () => {
    mkdirSync(join(dir, "reqs"));
    write("requirements.txt", "-r reqs/base.txt\n-r ../outside.txt\n-r missing.txt\n");
    writeFileSync(join(dir, "reqs", "base.txt"), "a\n-r deeper.txt\n", "utf8");
    writeFileSync(join(dir, "reqs", "deeper.txt"), "too-deep\n", "utf8");
    const out = discoverProjectDependencies(dir);
    expect(out.manifests).toEqual(["requirements.txt", "reqs/base.txt"]);
    expect(out.dependencies.map((d) => d.name)).toEqual(["a"]);
    expect(out.notes).toEqual([
      "reqs/base.txt: -r deeper.txt is nested more than one level; skipped", // emitted while reading the first include
      "requirements.txt: -r ../outside.txt is outside the project directory; skipped",
      "requirements.txt: -r missing.txt not found; skipped",
    ]);
  });

  it("falls back to lockfiles only when the matching manifest is absent, and says which lockfiles it will not read", () => {
    write("package-lock.json", JSON.stringify({ lockfileVersion: 3, packages: { "": { dependencies: { hono: "4" } } } }));
    write("pnpm-lock.yaml", "lockfileVersion: '9.0'\nimporters:\n  .:\n    dependencies:\n      hono:\n        specifier: 4\n        version: 4.0.0\n      zod:\n        specifier: 3\n        version: 3.0.0\n");
    write("yarn.lock", '# yarn lockfile v1\n"hono@^4":\n  version "4.0.0"\n');
    write("uv.lock", "version = 1\n");
    write("poetry.lock", "[[package]]\nname = \"httpx\"\n");
    const out = discoverProjectDependencies(dir);
    expect(out.manifests).toEqual(["package-lock.json", "pnpm-lock.yaml"]);
    expect(out.dependencies).toEqual([
      { name: "hono", ecosystem: "npm", source: "package-lock.json" },
      { name: "zod", ecosystem: "npm", source: "pnpm-lock.yaml" },
    ]);
    expect(out.notes).toEqual([
      "yarn.lock: not read (it lists every package with no root marker); add a package.json",
      "uv.lock, poetry.lock: not read (Python lockfiles list every package); add a pyproject.toml or requirements.txt",
    ]);
  });

  it("a package-lock v1 beside no package.json is reported, not silently empty", () => {
    write("package-lock.json", JSON.stringify({ lockfileVersion: 1, dependencies: { next: { version: "15" } } }));
    const out = discoverProjectDependencies(dir);
    expect(out.manifests).toEqual([]);
    expect(out.dependencies).toEqual([]);
    expect(out.notes).toEqual(["package-lock.json: lockfileVersion 1 has no root dependency list; skipped"]);
  });

  it("an unparseable manifest is a note, not a crash; the other manifests still count", () => {
    write("package.json", "{ not json");
    write("requirements.txt", "flask\n");
    const out = discoverProjectDependencies(dir);
    expect(out.manifests).toEqual(["requirements.txt"]);
    expect(out.dependencies).toEqual([{ name: "flask", ecosystem: "pypi", source: "requirements.txt" }]);
    expect(out.notes).toHaveLength(1);
    expect(out.notes[0]).toMatch(/^package\.json: could not parse/);
  });

  it("no manifest at all → empty manifests and dependencies, no notes", () => {
    expect(discoverProjectDependencies(dir)).toEqual({ dir, manifests: [], dependencies: [], notes: [] });
  });

  it("throws when the directory does not exist or is a file", () => {
    expect(() => discoverProjectDependencies(join(dir, "nope"))).toThrow(/not a directory/);
    write("f.txt", "x");
    expect(() => discoverProjectDependencies(join(dir, "f.txt"))).toThrow(/not a directory/);
  });
});
