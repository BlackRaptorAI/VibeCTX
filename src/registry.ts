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
  /** Topics `vibectx doctor` runs through get_docs to prove retrieval works for this
   *  entry. Pick something the docs certainly cover; one is enough. When absent, doctor
   *  derives a query from the description and marks it "(derived)". */
  probeQueries?: string[];
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
    probeQueries: ["querystring parsing"],
  },
  {
    name: "prisma",
    urls: [
      "https://www.prisma.io/docs/llms-full.txt",
      "https://www.prisma.io/docs/llms.txt",
    ],
    description: "Prisma ORM documentation",
    probeQueries: ["upsert"],
  },
  {
    name: "timescaledb",
    urls: [
      "https://docs.timescale.com/llms-full.txt",
      "https://docs.timescale.com/llms.txt",
      "https://raw.githubusercontent.com/timescale/timescaledb/main/README.md",
    ],
    description: "TimescaleDB time-series Postgres extension",
    probeQueries: ["hypertable"],
  },
  {
    name: "pgvector",
    urls: ["https://raw.githubusercontent.com/pgvector/pgvector/master/README.md"],
    description: "pgvector Postgres vector-similarity extension",
    probeQueries: ["hnsw index"],
  },
  {
    name: "anthropic-sdk",
    urls: [
      "https://platform.claude.com/llms.txt",
      "https://docs.anthropic.com/llms-full.txt",
      "https://docs.anthropic.com/llms.txt",
    ],
    description: "Anthropic API / Claude SDK documentation",
    probeQueries: ["streaming messages"],
  },
  {
    name: "aws-cdk",
    urls: [
      "https://docs.aws.amazon.com/cdk/v2/guide/llms.txt",
      "https://raw.githubusercontent.com/aws/aws-cdk/main/README.md",
    ],
    description: "AWS CDK v2 (incl. Kinesis/Firehose constructs)",
    probeQueries: ["kinesis firehose delivery stream"],
  },
  {
    name: "playwright",
    urls: [
      "https://playwright.dev/llms-full.txt",
      "https://playwright.dev/llms.txt",
      "https://raw.githubusercontent.com/microsoft/playwright/main/README.md",
    ],
    description: "Playwright browser automation",
    probeQueries: ["locator click"],
  },
  {
    name: "react",
    urls: ["https://react.dev/llms-full.txt", "https://react.dev/llms.txt"],
    description: "React 19 documentation",
    probeQueries: ["useEffect cleanup"],
  },
  {
    name: "fastify-type-provider-zod",
    urls: [
      "https://raw.githubusercontent.com/turkerdev/fastify-type-provider-zod/main/README.md",
    ],
    description: "Zod type provider for Fastify",
    probeQueries: ["type provider setup"],
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
      if (
        e.probeQueries !== undefined &&
        (!Array.isArray(e.probeQueries) ||
          e.probeQueries.some((q) => typeof q !== "string" || q.trim().length === 0))
      ) {
        throw new Error(
          `config entry "${e.name}": probeQueries must be an array of non-empty strings, got ${JSON.stringify(e.probeQueries)}`,
        );
      }
      entries.set(e.name, e);
    }
  }
  return { entries };
}
