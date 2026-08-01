#!/usr/bin/env node

import { dirname, resolve } from "node:path";

import {
  discoverCandidates,
  githubCollectorEnricher,
} from "./candidate-discovery.js";
import {
  defaultCandidatePath,
  writeCandidateSnapshot,
} from "./candidate-file.js";
import { collectSnapshot } from "./collector.js";
import { initializeProject } from "./commands/init.js";
import { GHArchiveClient } from "./gh-archive/client.js";
import { GitHubClient } from "./github/client.js";
import { redactSecrets } from "./security/redact.js";
import { defaultSnapshotPath, writeSnapshot } from "./snapshot-file.js";
import {
  analyzeCandidates,
  githubReadmeSource,
} from "./topic-analysis.js";
import {
  defaultTopicAnalysisPath,
  readCandidateSnapshot,
  writeTopicAnalysisSnapshot,
} from "./topic-analysis-file.js";

const HELP = `Usage: gitropolis <command> [options]

Commands:
  init      Initialize local Gitropolis project files
  collect   Collect public GitHub repository metadata
  discover  Discover fast-growing repositories from GH Archive
  analyze   Classify candidate AI relevance and observe keywords

Options:
  --from ISO_TIME             UTC hour at which discovery starts
  --hours NUMBER              Number of hours to process (1-24, default: 24)
  --top NUMBER                Number of candidates to enrich (default: 10)
  --request-delay-ms NUMBER   Delay between hourly files (default: 1000)
  --request-timeout-ms NUMBER Timeout for each hourly file (default: 60000)
  --input PATH                Read a candidate-v1 snapshot
  --max-readme-characters N   Maximum README prefix to analyze (default: 12000)
  --output PATH               Write output to a specific path
  -h, --help                  Show this help message
`;

export async function run(
  arguments_: readonly string[] = process.argv.slice(2),
): Promise<number> {
  try {
    return await runCommand(arguments_);
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown error";
    process.stderr.write(
      `Command failed: ${redactSecrets(message, [process.env.GITHUB_TOKEN])}\n`,
    );
    return 1;
  }
}

async function runCommand(arguments_: readonly string[]): Promise<number> {
  const [command, ...commandArguments] = arguments_;

  if (!command || command === "--help" || command === "-h") {
    process.stdout.write(HELP);
    return 0;
  }

  if (command === "init") {
    const { options } = parseArguments(commandArguments);
    const directory = options.directory ?? process.cwd();
    const configPath = await initializeProject(resolve(directory));
    process.stdout.write(`Initialized Gitropolis at ${dirname(configPath)}\n`);
    return 0;
  }

  if (command === "collect") {
    const { options, positionals } = parseArguments(commandArguments);
    if (positionals.length === 0) {
      throw new Error("collect requires at least one OWNER/REPOSITORY.");
    }

    const client = new GitHubClient({ token: process.env.GITHUB_TOKEN });
    const snapshot = await collectSnapshot(positionals, client);
    const outputPath =
      options.output ??
      defaultSnapshotPath(
        options.directory ?? process.cwd(),
        snapshot.collected_at,
      );
    const writtenPath = await writeSnapshot(snapshot, outputPath);
    const core = snapshot.source.rate_limit?.core;

    process.stdout.write(
      `Authentication: ${client.authenticated ? "token" : "anonymous"}\n`,
    );
    if (core) {
      process.stdout.write(
        `GitHub API core limit: ${core.remaining}/${core.limit} remaining\n`,
      );
    }
    process.stdout.write(
      formatCollectionSummary(snapshot.repositories.length, positionals.length),
    );
    process.stdout.write(`Snapshot: ${writtenPath}\n`);
    return 0;
  }

  if (command === "discover") {
    const options = parseDiscoveryArguments(commandArguments);
    const githubClient = new GitHubClient({ token: process.env.GITHUB_TOKEN });
    const archive = new GHArchiveClient({
      requestTimeoutMs: options.requestTimeoutMs,
    });
    const snapshot = await discoverCandidates(
      {
        from: options.from,
        hours: options.hours,
        top: options.top,
        requestDelayMs: options.requestDelayMs,
      },
      archive,
      githubCollectorEnricher(githubClient),
    );
    const outputPath =
      options.output ??
      defaultCandidatePath(options.directory ?? process.cwd(), snapshot);
    const writtenPath = await writeCandidateSnapshot(snapshot, outputPath);
    const enrichedCount = snapshot.repositories.filter(
      ({ github }) => github !== null,
    ).length;

    process.stdout.write(
      `GH Archive hours: ${snapshot.source.hours_collected}/${snapshot.source.hours_requested}\n`,
    );
    process.stdout.write(
      `GitHub authentication: ${githubClient.authenticated ? "token" : "anonymous"}\n`,
    );
    process.stdout.write(
      `Candidates: ${snapshot.repositories.length}; enriched: ${enrichedCount}\n`,
    );
    process.stdout.write(`Candidate snapshot: ${writtenPath}\n`);
    return 0;
  }

  if (command === "analyze") {
    const options = parseAnalysisArguments(commandArguments);
    const candidate = await readCandidateSnapshot(options.input);
    const githubClient = new GitHubClient({ token: process.env.GITHUB_TOKEN });
    const snapshot = await analyzeCandidates(
      candidate,
      githubReadmeSource(githubClient),
      { maxReadmeCharacters: options.maxReadmeCharacters },
    );
    const outputPath =
      options.output ??
      defaultTopicAnalysisPath(options.directory ?? process.cwd(), snapshot);
    const writtenPath = await writeTopicAnalysisSnapshot(snapshot, outputPath);
    const decisions = countDecisions(snapshot.repositories);
    const statuses = countCommunityStatuses(snapshot.repositories);

    process.stdout.write(
      `GitHub authentication: ${githubClient.authenticated ? "token" : "anonymous"}\n`,
    );
    process.stdout.write(
      `AI relevance: ${decisions.aiRelated} related, ${decisions.review} review, ${decisions.notAI} not AI, ${decisions.unavailable} unavailable\n`,
    );
    process.stdout.write(
      `Community pools: ${statuses.emerging} emerging, ${statuses.unknown} unknown\n`,
    );
    process.stdout.write(
      `Analysis coverage errors: ${snapshot.source.coverage_errors.length}\n`,
    );
    process.stdout.write(`Topic analysis: ${writtenPath}\n`);
    return 0;
  }

  process.stderr.write(`Unknown command: ${command}\n\n${HELP}`);
  return 1;
}

export interface AnalysisCliOptions {
  directory?: string;
  input: string;
  output?: string;
  maxReadmeCharacters: number;
}

export function parseAnalysisArguments(
  arguments_: readonly string[],
): AnalysisCliOptions {
  const values: Record<string, string> = {};
  const supported = new Set([
    "--directory",
    "--input",
    "--output",
    "--max-readme-characters",
  ]);

  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (!argument?.startsWith("--") || !supported.has(argument)) {
      throw new Error(`Unknown analyze argument: ${argument ?? ""}`);
    }
    const value = arguments_[index + 1];
    if (!value) {
      throw new Error(`${argument} requires a value.`);
    }
    values[argument] = value;
    index += 1;
  }

  const input = values["--input"];
  if (!input) {
    throw new Error("analyze requires --input.");
  }
  const maxReadmeCharacters = integerOption(
    values["--max-readme-characters"],
    "--max-readme-characters",
    12_000,
  );
  if (maxReadmeCharacters < 1 || maxReadmeCharacters > 100_000) {
    throw new Error(
      "--max-readme-characters must be between 1 and 100000.",
    );
  }

  return {
    ...(values["--directory"]
      ? { directory: values["--directory"] }
      : {}),
    input,
    ...(values["--output"] ? { output: values["--output"] } : {}),
    maxReadmeCharacters,
  };
}

function countDecisions(
  repositories: readonly {
    ai_relevance: { decision: string };
  }[],
): {
  aiRelated: number;
  review: number;
  notAI: number;
  unavailable: number;
} {
  return {
    aiRelated: repositories.filter(
      ({ ai_relevance: relevance }) => relevance.decision === "ai-related",
    ).length,
    review: repositories.filter(
      ({ ai_relevance: relevance }) => relevance.decision === "review",
    ).length,
    notAI: repositories.filter(
      ({ ai_relevance: relevance }) => relevance.decision === "not-ai",
    ).length,
    unavailable: repositories.filter(
      ({ ai_relevance: relevance }) => relevance.decision === "unavailable",
    ).length,
  };
}

function countCommunityStatuses(
  repositories: readonly { community_status: string | null }[],
): { emerging: number; unknown: number } {
  return {
    emerging: repositories.filter(
      ({ community_status: status }) => status === "emerging",
    ).length,
    unknown: repositories.filter(
      ({ community_status: status }) => status === "unknown",
    ).length,
  };
}

export interface DiscoveryCliOptions {
  directory?: string;
  output?: string;
  from: Date;
  hours: number;
  top: number;
  requestDelayMs: number;
  requestTimeoutMs: number;
}

export function parseDiscoveryArguments(
  arguments_: readonly string[],
): DiscoveryCliOptions {
  const values: Record<string, string> = {};
  const supported = new Set([
    "--directory",
    "--output",
    "--from",
    "--hours",
    "--top",
    "--request-delay-ms",
    "--request-timeout-ms",
  ]);

  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (!argument?.startsWith("--") || !supported.has(argument)) {
      throw new Error(`Unknown discover argument: ${argument ?? ""}`);
    }
    const value = arguments_[index + 1];
    if (!value) {
      throw new Error(`${argument} requires a value.`);
    }
    values[argument] = value;
    index += 1;
  }

  const fromValue = values["--from"];
  if (!fromValue) {
    throw new Error("discover requires --from.");
  }
  if (!fromValue.endsWith("Z")) {
    throw new Error("--from must be an explicit UTC timestamp ending in Z.");
  }
  const from = new Date(fromValue);
  if (
    !Number.isFinite(from.getTime()) ||
    from.getUTCMinutes() !== 0 ||
    from.getUTCSeconds() !== 0 ||
    from.getUTCMilliseconds() !== 0
  ) {
    throw new Error("--from must be a valid UTC timestamp aligned to an hour.");
  }

  const hours = integerOption(values["--hours"], "--hours", 24);
  const top = integerOption(values["--top"], "--top", 10);
  const requestDelayMs = integerOption(
    values["--request-delay-ms"],
    "--request-delay-ms",
    1_000,
  );
  const requestTimeoutMs = integerOption(
    values["--request-timeout-ms"],
    "--request-timeout-ms",
    60_000,
  );
  if (requestTimeoutMs < 1_000 || requestTimeoutMs > 600_000) {
    throw new Error(
      "--request-timeout-ms must be between 1000 and 600000.",
    );
  }

  return {
    ...(values["--directory"]
      ? { directory: values["--directory"] }
      : {}),
    ...(values["--output"] ? { output: values["--output"] } : {}),
    from,
    hours,
    top,
    requestDelayMs,
    requestTimeoutMs,
  };
}

function integerOption(
  value: string | undefined,
  name: string,
  defaultValue: number,
): number {
  if (value === undefined) {
    return defaultValue;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) {
    throw new Error(`${name} must be an integer.`);
  }
  return parsed;
}

export function formatCollectionSummary(
  successfulCount: number,
  requestedCount: number,
): string {
  return `Repositories: ${successfulCount} succeeded, ${requestedCount - successfulCount} failed\n`;
}

interface ParsedArguments {
  options: {
    directory?: string;
    output?: string;
  };
  positionals: string[];
}

function parseArguments(arguments_: readonly string[]): ParsedArguments {
  const options: ParsedArguments["options"] = {};
  const positionals: string[] = [];

  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--directory" || argument === "--output") {
      const value = arguments_[index + 1];
      if (!value) {
        throw new Error(`${argument} requires a value.`);
      }
      if (argument === "--directory") {
        options.directory = value;
      } else {
        options.output = value;
      }
      index += 1;
      continue;
    }
    if (argument?.startsWith("-")) {
      throw new Error(`Unknown option: ${argument}`);
    }
    if (argument) {
      positionals.push(argument);
    }
  }

  return { options, positionals };
}

const isEntryPoint =
  process.argv[1] !== undefined &&
  import.meta.url === new URL(process.argv[1], "file:").href;

if (isEntryPoint) {
  process.exitCode = await run();
}
