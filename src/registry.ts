import { readFileSync } from "node:fs";

export interface LibraryEntry {
  /** Canonical name agents use to request docs. */
  name: string;
  /** Ordered candidate URLs. First reachable one wins. Prefer llms-full.txt, then llms.txt, then curated pages. */
  urls: string[];
  /** Cache time-to-live in hours. Default 168 (7 days). */
  ttlHours?: number;
  /** One-line description shown by list_libraries. */
  description?: string;
}

/**
 * Default registry. URLs follow the llms.txt convention ({docs-base}/llms-full.txt
 * then {docs-base}/llms.txt); the fetcher probes candidates in order and falls
 * back gracefully, so an entry whose site drops or gains llms.txt keeps working.
 */
export const DEFAULT_REGISTRY: LibraryEntry[] = [
  {
    name: "fastify",
    urls: [
      "https://fastify.dev/llms-full.txt",
      "https://fastify.dev/llms.txt",
      "https://raw.githubusercontent.com/fastify/fastify/main/docs/Reference/Index.md",
    ],
    description: "Fastify web framework reference",
  },
  {
    name: "prisma",
    urls: [
      "https://www.prisma.io/docs/llms-full.txt",
      "https://www.prisma.io/docs/llms.txt",
    ],
    description: "Prisma ORM documentation",
  },
  {
    name: "timescaledb",
    urls: [
      "https://docs.timescale.com/llms-full.txt",
      "https://docs.timescale.com/llms.txt",
      "https://raw.githubusercontent.com/timescale/timescaledb/main/README.md",
    ],
    description: "TimescaleDB time-series Postgres extension",
  },
  {
    name: "pgvector",
    urls: ["https://raw.githubusercontent.com/pgvector/pgvector/master/README.md"],
    description: "pgvector Postgres vector-similarity extension",
  },
  {
    name: "anthropic-sdk",
    urls: [
      "https://platform.claude.com/llms.txt",
      "https://docs.anthropic.com/llms-full.txt",
      "https://docs.anthropic.com/llms.txt",
    ],
    description: "Anthropic API / Claude SDK documentation",
  },
  {
    name: "aws-cdk",
    urls: [
      "https://docs.aws.amazon.com/cdk/v2/guide/llms.txt",
      "https://raw.githubusercontent.com/aws/aws-cdk/main/README.md",
    ],
    description: "AWS CDK v2 (incl. Kinesis/Firehose constructs)",
  },
  {
    name: "playwright",
    urls: [
      "https://playwright.dev/llms-full.txt",
      "https://playwright.dev/llms.txt",
      "https://raw.githubusercontent.com/microsoft/playwright/main/README.md",
    ],
    description: "Playwright browser automation",
  },
  {
    name: "react",
    urls: ["https://react.dev/llms-full.txt", "https://react.dev/llms.txt"],
    description: "React 19 documentation",
  },
  {
    name: "fastify-type-provider-zod",
    urls: [
      "https://raw.githubusercontent.com/turkerdev/fastify-type-provider-zod/main/README.md",
    ],
    description: "Zod type provider for Fastify",
  },
];

export interface Registry {
  entries: Map<string, LibraryEntry>;
}

/** Build the registry: defaults, optionally merged/overridden by a JSON config file
 *  of shape { "libraries": LibraryEntry[] }. Config entries win on name collision. */
export function loadRegistry(configPath?: string): Registry {
  const entries = new Map<string, LibraryEntry>();
  for (const e of DEFAULT_REGISTRY) entries.set(e.name, e);
  if (configPath) {
    const raw = JSON.parse(readFileSync(configPath, "utf8")) as {
      libraries?: LibraryEntry[];
    };
    for (const e of raw.libraries ?? []) {
      if (!e.name || !Array.isArray(e.urls) || e.urls.length === 0) {
        throw new Error(`config entry missing name/urls: ${JSON.stringify(e)}`);
      }
      entries.set(e.name, e);
    }
  }
  return { entries };
}
