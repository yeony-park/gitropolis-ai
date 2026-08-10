#!/usr/bin/env node

import { dirname, resolve } from "node:path";

import {
  buildActivitySeries,
  enrichActivitySeries,
} from "./activity-series.js";
import {
  defaultActivitySeriesPath,
  defaultEnrichedActivitySeriesPath,
  readActivitySeries,
  writeActivitySeries,
} from "./activity-series-file.js";
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
import { buildCitySnapshot } from "./city-builder.js";
import { defaultCityPath, writeCitySnapshot } from "./city-file.js";
import { GHArchiveClient } from "./gh-archive/client.js";
import { GitHubClient } from "./github/client.js";
import { redactSecrets } from "./security/redact.js";
import {
  defaultRepositoryLifecyclePath,
  readRepositoryLifecycle,
  writeRepositoryLifecycle,
} from "./repository-lifecycle-file.js";
import { deriveRepositoryLifecycle } from "./repository-lifecycle.js";
import { defaultSnapshotPath, writeSnapshot } from "./snapshot-file.js";
import type {
  ActivityMetadataProfile,
  ActivityMetadataSelectionRule,
} from "./types/activity-series.js";
import {
  analyzeCandidates,
  githubReadmeSource,
} from "./topic-analysis.js";
import {
  defaultTopicAnalysisPath,
  readAnalysisInput,
  readTopicAnalysisSnapshot,
  writeTopicAnalysisSnapshot,
} from "./topic-analysis-file.js";

const HELP = `Usage: gitropolis <command> [options]

Commands:
  init      Initialize local Gitropolis project files
  collect   Collect public GitHub repository metadata
  discover  Discover fast-growing repositories from GH Archive
  backfill  Build a complete daily GH Archive activity series
  enrich-activity  Add current GitHub metadata using an activity floor
  lifecycle Derive repository lifecycle from consecutive activity series
  analyze   Classify candidate AI relevance and observe keywords
  build-city Join activity, analysis, and lifecycle into city-v1

Options:
  --from ISO_TIME             UTC hour at which discovery starts
  --hours NUMBER              Number of hours to process (1-24, default: 24)
  --days NUMBER               Complete UTC days to backfill (1-7, default: 7)
  --top NUMBER                Number of candidates to enrich (default: 10)
  --min-daily-watch-events N  Daily activity floor for metadata (default: 5)
  --min-window-watch-events N Full-window activity floor for scout metadata
  --metadata-profile PROFILE  full, classification, or screening (default: full)
  --main-daily-watch-events N Main Radar daily floor (default: 5)
  --scout-weekly-watch-events N Emerging Scout weekly floor (default: 3)
  --fast-breakout-weekly-watch-events N Fast breakout floor (default: 10)
  --request-delay-ms NUMBER   Delay between hourly files (default: 1000)
  --request-timeout-ms NUMBER Timeout for each hourly file (default: 60000)
  --input PATH                Read a candidate or activity-series snapshot
  --activity PATH             Read an enriched activity-series-v1 snapshot
  --analysis PATH             Read a topic-analysis-v1 snapshot
  --lifecycle PATH            Read a repository-lifecycle-v1 snapshot
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
    writeEventIntegritySummary(snapshot.source.event_integrity);
    process.stdout.write(`Candidate snapshot: ${writtenPath}\n`);
    return 0;
  }

  if (command === "backfill") {
    const options = parseBackfillArguments(commandArguments);
    const archive = new GHArchiveClient({
      requestTimeoutMs: options.requestTimeoutMs,
    });
    const snapshot = await buildActivitySeries(
      {
        from: options.from,
        days: options.days,
        requestDelayMs: options.requestDelayMs,
        onDayComplete(day, completedDays, totalDays) {
          process.stdout.write(
            `GH Archive day ${completedDays}/${totalDays}: ${day.date}, ${day.hours_collected}/24 hours, ${day.watch_events_observed} WatchEvents\n`,
          );
        },
      },
      archive,
    );
    const outputPath =
      options.output ??
      defaultActivitySeriesPath(options.directory ?? process.cwd(), snapshot);
    const writtenPath = await writeActivitySeries(snapshot, outputPath);

    process.stdout.write(
      `GH Archive hours: ${snapshot.source.hours_collected}/${snapshot.source.hours_requested}\n`,
    );
    process.stdout.write(
      `Repositories observed: ${snapshot.source.repositories_seen}\n`,
    );
    writeEventIntegritySummary(snapshot.source.event_integrity);
    process.stdout.write(
      `Coverage errors: ${snapshot.source.coverage_errors.length}\n`,
    );
    process.stdout.write(`Activity series: ${writtenPath}\n`);
    return 0;
  }

  if (command === "enrich-activity") {
    const options = parseActivityEnrichmentArguments(commandArguments);
    const input = await readActivitySeries(options.input);
    const githubClient = new GitHubClient({ token: process.env.GITHUB_TOKEN });
    const snapshot = await enrichActivitySeries(
      input,
      options.selection,
      githubCollectorEnricher(githubClient, (processed, total) => {
        if (processed % 10 === 0 || processed === total) {
          process.stdout.write(
            `GitHub metadata progress: ${processed}/${total}\n`,
          );
        }
      }, options.metadataProfile),
      new Date(),
      options.metadataProfile,
    );
    const outputPath =
      options.output ?? defaultEnrichedActivitySeriesPath(options.input);
    const writtenPath = await writeActivitySeries(snapshot, outputPath);
    const selection = snapshot.source.metadata_selection;
    if (!selection) {
      throw new Error("Activity metadata selection was not created.");
    }

    process.stdout.write(
      `GitHub authentication: ${githubClient.authenticated ? "token" : "anonymous"}\n`,
    );
    process.stdout.write(
      `Current metadata: ${selection.collected}/${selection.selected} collected with ${formatActivitySelection(selection)} (${selection.metadata_profile})\n`,
    );
    process.stdout.write(
      `Coverage errors: ${snapshot.source.coverage_errors.length}\n`,
    );
    process.stdout.write(`Enriched activity series: ${writtenPath}\n`);
    return 0;
  }

  if (command === "lifecycle") {
    const options = parseLifecycleArguments(commandArguments);
    const inputs = [];
    for (const inputPath of options.inputs) {
      inputs.push({
        path: resolve(inputPath),
        snapshot: await readActivitySeries(inputPath),
      });
    }
    const snapshot = deriveRepositoryLifecycle(inputs, {
      mainDailyWatchEvents: options.mainDailyWatchEvents,
      scoutWeeklyWatchEvents: options.scoutWeeklyWatchEvents,
      fastBreakoutWeeklyWatchEvents: options.fastBreakoutWeeklyWatchEvents,
    });
    const outputPath =
      options.output ??
      defaultRepositoryLifecyclePath(
        options.directory ?? process.cwd(),
        snapshot,
      );
    const writtenPath = await writeRepositoryLifecycle(snapshot, outputPath);
    const states = countLifecycleStates(snapshot.repositories);

    process.stdout.write(
      `Lifecycle weeks: ${snapshot.weeks.length}; inputs: ${snapshot.source.input_snapshots.length}\n`,
    );
    process.stdout.write(
      `Repository states: ${states.candidate} candidate, ${states.active} active, ${states.cooling} cooling, ${states.inactive} inactive, ${states.untracked} below lifecycle entry\n`,
    );
    process.stdout.write(`Lifecycle events: ${snapshot.events.length}\n`);
    process.stdout.write(`Repository lifecycle: ${writtenPath}\n`);
    return 0;
  }

  if (command === "analyze") {
    const options = parseAnalysisArguments(commandArguments);
    const input = await readAnalysisInput(options.input);
    const githubClient = new GitHubClient({ token: process.env.GITHUB_TOKEN });
    const snapshot = await analyzeCandidates(
      input.candidate,
      githubReadmeSource(githubClient),
      {
        inputSchemaVersion: input.inputSchemaVersion,
        maxReadmeCharacters: options.maxReadmeCharacters,
      },
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
    process.stdout.write(
      `Keyword census: ${snapshot.keyword_census.unique_keywords} unique keywords, ${snapshot.keyword_census.observation_records} source observations across ${snapshot.keyword_census.repositories_with_observations}/${snapshot.keyword_census.repositories_analyzed} repositories\n`,
    );
    process.stdout.write(`Topic analysis: ${writtenPath}\n`);
    return 0;
  }

  if (command === "build-city") {
    const options = parseCityArguments(commandArguments);
    const [activity, analysis, lifecycle] = await Promise.all([
      readActivitySeries(options.activity),
      readTopicAnalysisSnapshot(options.analysis),
      readRepositoryLifecycle(options.lifecycle),
    ]);
    const snapshot = buildCitySnapshot({ activity, analysis, lifecycle });
    const outputPath =
      options.output ?? defaultCityPath(options.directory ?? process.cwd());
    const writtenPath = await writeCitySnapshot(snapshot, outputPath);

    process.stdout.write(
      `City repositories: ${snapshot.repositories.length}/${snapshot.source.ai_related_repositories} AI-related included\n`,
    );
    process.stdout.write(`City communities: ${snapshot.communities.length}\n`);
    process.stdout.write(
      `Coverage: ${snapshot.source.coverage_complete ? "complete" : "incomplete"}\n`,
    );
    process.stdout.write(`City snapshot: ${writtenPath}\n`);
    return 0;
  }

  process.stderr.write(`Unknown command: ${command}\n\n${HELP}`);
  return 1;
}

export interface BackfillCliOptions {
  directory?: string;
  output?: string;
  from: Date;
  days: number;
  requestDelayMs: number;
  requestTimeoutMs: number;
}

export function parseBackfillArguments(
  arguments_: readonly string[],
): BackfillCliOptions {
  const values: Record<string, string> = {};
  const supported = new Set([
    "--directory",
    "--output",
    "--from",
    "--days",
    "--request-delay-ms",
    "--request-timeout-ms",
  ]);

  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (!argument?.startsWith("--") || !supported.has(argument)) {
      throw new Error(`Unknown backfill argument: ${argument ?? ""}`);
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
    throw new Error("backfill requires --from.");
  }
  if (!fromValue.endsWith("Z")) {
    throw new Error("--from must be an explicit UTC timestamp ending in Z.");
  }
  const from = new Date(fromValue);
  if (
    !Number.isFinite(from.getTime()) ||
    from.getUTCHours() !== 0 ||
    from.getUTCMinutes() !== 0 ||
    from.getUTCSeconds() !== 0 ||
    from.getUTCMilliseconds() !== 0
  ) {
    throw new Error("--from must be a valid UTC timestamp at 00:00:00Z.");
  }

  const days = integerOption(values["--days"], "--days", 7);
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
  if (days < 1 || days > 7) {
    throw new Error("--days must be between 1 and 7.");
  }
  if (requestDelayMs < 0 || requestDelayMs > 60_000) {
    throw new Error("--request-delay-ms must be between 0 and 60000.");
  }
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
    days,
    requestDelayMs,
    requestTimeoutMs,
  };
}

export interface ActivityEnrichmentCliOptions {
  input: string;
  output?: string;
  selection: ActivityMetadataSelectionRule;
  metadataProfile: ActivityMetadataProfile;
}

export function parseActivityEnrichmentArguments(
  arguments_: readonly string[],
): ActivityEnrichmentCliOptions {
  const values: Record<string, string> = {};
  const supported = new Set([
    "--input",
    "--output",
    "--min-daily-watch-events",
    "--min-window-watch-events",
    "--metadata-profile",
  ]);

  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (!argument?.startsWith("--") || !supported.has(argument)) {
      throw new Error(
        `Unknown enrich-activity argument: ${argument ?? ""}`,
      );
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
    throw new Error("enrich-activity requires --input.");
  }
  if (
    values["--min-daily-watch-events"] &&
    values["--min-window-watch-events"]
  ) {
    throw new Error(
      "Use only one of --min-daily-watch-events or --min-window-watch-events.",
    );
  }
  const selection: ActivityMetadataSelectionRule = values[
    "--min-window-watch-events"
  ]
    ? {
        method: "minimum-window-watch-events",
        minimum_window_watch_events: positiveIntegerOption(
          values["--min-window-watch-events"],
          "--min-window-watch-events",
          3,
        ),
      }
    : {
        method: "minimum-daily-watch-events",
        minimum_daily_watch_events: positiveIntegerOption(
          values["--min-daily-watch-events"],
          "--min-daily-watch-events",
          5,
        ),
      };
  const metadataProfileValue = values["--metadata-profile"] ?? "full";
  if (
    metadataProfileValue !== "full" &&
    metadataProfileValue !== "classification" &&
    metadataProfileValue !== "screening"
  ) {
    throw new Error(
      "--metadata-profile must be full, classification, or screening.",
    );
  }

  return {
    input,
    ...(values["--output"] ? { output: values["--output"] } : {}),
    selection,
    metadataProfile: metadataProfileValue,
  };
}

export interface AnalysisCliOptions {
  directory?: string;
  input: string;
  output?: string;
  maxReadmeCharacters: number;
}

export interface CityCliOptions {
  directory?: string;
  output?: string;
  activity: string;
  analysis: string;
  lifecycle: string;
}

export function parseCityArguments(
  arguments_: readonly string[],
): CityCliOptions {
  const values: Record<string, string> = {};
  const supported = new Set([
    "--directory",
    "--output",
    "--activity",
    "--analysis",
    "--lifecycle",
  ]);

  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (!argument?.startsWith("--") || !supported.has(argument)) {
      throw new Error(`Unknown build-city argument: ${argument ?? ""}`);
    }
    const value = arguments_[index + 1];
    if (!value) {
      throw new Error(`${argument} requires a value.`);
    }
    values[argument] = value;
    index += 1;
  }

  const activity = values["--activity"];
  const analysis = values["--analysis"];
  const lifecycle = values["--lifecycle"];
  if (!activity || !analysis || !lifecycle) {
    throw new Error(
      "build-city requires --activity, --analysis, and --lifecycle.",
    );
  }

  return {
    ...(values["--directory"]
      ? { directory: values["--directory"] }
      : {}),
    ...(values["--output"] ? { output: values["--output"] } : {}),
    activity,
    analysis,
    lifecycle,
  };
}

export interface LifecycleCliOptions {
  directory?: string;
  output?: string;
  inputs: string[];
  mainDailyWatchEvents: number;
  scoutWeeklyWatchEvents: number;
  fastBreakoutWeeklyWatchEvents: number;
}

export function parseLifecycleArguments(
  arguments_: readonly string[],
): LifecycleCliOptions {
  const inputs: string[] = [];
  const values: Record<string, string> = {};
  const supported = new Set([
    "--directory",
    "--output",
    "--input",
    "--main-daily-watch-events",
    "--scout-weekly-watch-events",
    "--fast-breakout-weekly-watch-events",
  ]);

  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (!argument?.startsWith("--") || !supported.has(argument)) {
      throw new Error(`Unknown lifecycle argument: ${argument ?? ""}`);
    }
    const value = arguments_[index + 1];
    if (!value) {
      throw new Error(`${argument} requires a value.`);
    }
    if (argument === "--input") {
      inputs.push(value);
    } else {
      values[argument] = value;
    }
    index += 1;
  }
  if (inputs.length === 0) {
    throw new Error("lifecycle requires at least one --input.");
  }

  return {
    ...(values["--directory"]
      ? { directory: values["--directory"] }
      : {}),
    ...(values["--output"] ? { output: values["--output"] } : {}),
    inputs,
    mainDailyWatchEvents: positiveIntegerOption(
      values["--main-daily-watch-events"],
      "--main-daily-watch-events",
      5,
    ),
    scoutWeeklyWatchEvents: positiveIntegerOption(
      values["--scout-weekly-watch-events"],
      "--scout-weekly-watch-events",
      3,
    ),
    fastBreakoutWeeklyWatchEvents: positiveIntegerOption(
      values["--fast-breakout-weekly-watch-events"],
      "--fast-breakout-weekly-watch-events",
      10,
    ),
  };
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

function countLifecycleStates(
  repositories: readonly { radar_status: string | null }[],
): {
  candidate: number;
  active: number;
  cooling: number;
  inactive: number;
  untracked: number;
} {
  return {
    candidate: repositories.filter(
      ({ radar_status: status }) => status === "candidate",
    ).length,
    active: repositories.filter(
      ({ radar_status: status }) => status === "active",
    ).length,
    cooling: repositories.filter(
      ({ radar_status: status }) => status === "cooling",
    ).length,
    inactive: repositories.filter(
      ({ radar_status: status }) => status === "inactive",
    ).length,
    untracked: repositories.filter(
      ({ radar_status: status }) => status === null,
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

function positiveIntegerOption(
  value: string | undefined,
  name: string,
  defaultValue: number,
): number {
  const parsed = integerOption(value, name, defaultValue);
  if (parsed < 1) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return parsed;
}

function formatActivitySelection(
  selection: ActivityMetadataSelectionRule,
): string {
  if (selection.method === "minimum-window-watch-events") {
    return `${selection.minimum_window_watch_events} WatchEvents in the window`;
  }
  return `${selection.minimum_daily_watch_events} WatchEvents in one day`;
}

function writeEventIntegritySummary(
  integrity:
    | {
        raw_watch_events_seen: number;
        unique_watch_events: number;
        duplicate_event_ids: number;
        missing_event_ids: number;
        invalid_event_ids: number;
        recovered_records?: number;
        malformed_records: number;
      }
    | undefined,
): void {
  if (!integrity) {
    return;
  }
  process.stdout.write(
    `Event integrity: ${integrity.unique_watch_events}/${integrity.raw_watch_events_seen} unique, ${integrity.duplicate_event_ids} duplicates, ${integrity.missing_event_ids} missing IDs, ${integrity.invalid_event_ids} invalid IDs, ${integrity.recovered_records ?? 0} recovered records, ${integrity.malformed_records} malformed records\n`,
  );
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
