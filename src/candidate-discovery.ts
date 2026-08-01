import { collectSnapshot } from "./collector.js";
import type {
  GHArchiveEvent,
  GHArchiveSource,
} from "./gh-archive/client.js";
import type { GitHubApiClient } from "./github/client.js";
import type {
  CandidateCoverageError,
  CandidateRepository,
  CandidateSnapshot,
} from "./types/candidate.js";
import type { Snapshot } from "./types/snapshot.js";

const HOUR_MS = 60 * 60 * 1_000;

interface CandidateAccumulator {
  fullName: string;
  watchEvents: number;
  firstSeenAt: string;
  firstSeenTime: number;
  lastSeenAt: string;
  lastSeenTime: number;
}

export interface CandidateDiscoveryOptions {
  from: Date;
  hours: number;
  top: number;
  requestDelayMs: number;
  collectedAt?: Date;
  sleep?: (milliseconds: number) => Promise<void>;
}

export async function discoverCandidates(
  options: CandidateDiscoveryOptions,
  archive: GHArchiveSource,
  enrich: (
    repositories: readonly string[],
    collectedAt: Date,
  ) => Promise<Snapshot>,
): Promise<CandidateSnapshot> {
  validateOptions(options);
  const from = new Date(options.from.getTime());
  const to = new Date(from.getTime() + options.hours * HOUR_MS);
  const collectedAt = options.collectedAt ?? new Date();
  const sleep = options.sleep ?? delay;
  const accumulators = new Map<string, CandidateAccumulator>();
  const coverageErrors: CandidateCoverageError[] = [];
  let hoursCollected = 0;

  for (let offset = 0; offset < options.hours; offset += 1) {
    const hour = new Date(from.getTime() + offset * HOUR_MS);
    try {
      for await (const record of archive.recordsForHour(hour)) {
        if (record.kind === "parse-error") {
          coverageErrors.push({
            source: "gh-archive",
            target: `${hour.toISOString()}#line-${record.line}`,
            status: null,
            message: `GH Archive record could not be parsed: ${record.message}`,
          });
          continue;
        }
        const validationError = recordWatchEvent(
          accumulators,
          record.event,
          hour,
        );
        if (validationError) {
          coverageErrors.push({
            source: "gh-archive",
            target: `${hour.toISOString()}#line-${record.line}`,
            status: null,
            message: validationError,
          });
        }
      }
      hoursCollected += 1;
    } catch (error) {
      coverageErrors.push({
        source: "gh-archive",
        target: hour.toISOString(),
        status: statusFromError(error),
        message: error instanceof Error ? error.message : "unknown error",
      });
    }

    if (offset < options.hours - 1 && options.requestDelayMs > 0) {
      await sleep(options.requestDelayMs);
    }
  }

  const rankedCandidates = [...accumulators.values()]
    .sort(
      (left, right) =>
        right.watchEvents - left.watchEvents ||
        compareNames(left.fullName, right.fullName),
    )
    .slice(0, options.top);
  const repositoryNames = rankedCandidates.map(({ fullName }) => fullName);
  const githubSnapshot =
    repositoryNames.length === 0
      ? null
      : await enrich(repositoryNames, collectedAt);
  const githubByName = new Map(
    githubSnapshot?.repositories.map((repository) => [
      repository.full_name.toLowerCase(),
      repository,
    ]) ?? [],
  );

  for (const error of githubSnapshot?.source.coverage_errors ?? []) {
    coverageErrors.push({
      source: "github",
      target: error.endpoint,
      status: error.status,
      message: error.message,
    });
  }

  const repositories: CandidateRepository[] = rankedCandidates.map(
    (candidate) => {
      const github = githubByName.get(candidate.fullName.toLowerCase()) ?? null;
      if (!github) {
        coverageErrors.push({
          source: "github",
          target: candidate.fullName,
          status: null,
          message: `GitHub metadata was not collected for ${candidate.fullName}`,
        });
      }
      return {
        full_name: candidate.fullName,
        watch_events: candidate.watchEvents,
        first_seen_at: candidate.firstSeenAt,
        last_seen_at: candidate.lastSeenAt,
        github,
      };
    },
  );

  return {
    schema_version: "candidate-v1",
    window: {
      from: from.toISOString(),
      to: to.toISOString(),
    },
    source: {
      type: "gh-archive",
      coverage_complete: coverageErrors.length === 0,
      hours_requested: options.hours,
      hours_collected: hoursCollected,
      watch_events_seen: [...accumulators.values()].reduce(
        (total, candidate) => total + candidate.watchEvents,
        0,
      ),
      repositories_seen: accumulators.size,
      github_authenticated: githubSnapshot?.source.authenticated ?? null,
      github_rate_limit: githubSnapshot?.source.rate_limit ?? null,
      coverage_errors: coverageErrors,
    },
    repositories,
  };
}

export function githubCollectorEnricher(
  client: GitHubApiClient,
): (
  repositories: readonly string[],
  collectedAt: Date,
) => Promise<Snapshot> {
  return (repositories, collectedAt) =>
    collectSnapshot(repositories, client, collectedAt);
}

function recordWatchEvent(
  accumulators: Map<string, CandidateAccumulator>,
  event: GHArchiveEvent,
  hour: Date,
): string | null {
  if (event.type !== "WatchEvent") {
    return null;
  }
  if (event.payload?.action !== "started") {
    return "WatchEvent payload.action must be 'started'";
  }
  if (typeof event.repo?.name !== "string") {
    return "WatchEvent repo.name must be a repository name";
  }
  if (typeof event.created_at !== "string") {
    return "WatchEvent created_at must be an ISO timestamp";
  }

  const timestamp = Date.parse(event.created_at);
  if (!Number.isFinite(timestamp)) {
    return "WatchEvent created_at must be an ISO timestamp";
  }
  if (!isRepositoryName(event.repo.name)) {
    return "WatchEvent repo.name must be a repository name";
  }
  if (timestamp < hour.getTime() || timestamp >= hour.getTime() + HOUR_MS) {
    return "WatchEvent created_at is outside its hourly archive window";
  }

  const key = event.repo.name.toLowerCase();
  const existing = accumulators.get(key);
  if (!existing) {
    accumulators.set(key, {
      fullName: event.repo.name,
      watchEvents: 1,
      firstSeenAt: event.created_at,
      firstSeenTime: timestamp,
      lastSeenAt: event.created_at,
      lastSeenTime: timestamp,
    });
    return null;
  }

  existing.watchEvents += 1;
  if (timestamp < existing.firstSeenTime) {
    existing.firstSeenAt = event.created_at;
    existing.firstSeenTime = timestamp;
  }
  if (timestamp > existing.lastSeenTime) {
    existing.lastSeenAt = event.created_at;
    existing.lastSeenTime = timestamp;
  }
  return null;
}

function validateOptions(options: CandidateDiscoveryOptions): void {
  if (
    !Number.isFinite(options.from.getTime()) ||
    options.from.getUTCMinutes() !== 0 ||
    options.from.getUTCSeconds() !== 0 ||
    options.from.getUTCMilliseconds() !== 0
  ) {
    throw new Error("--from must be a valid UTC timestamp aligned to an hour.");
  }
  if (!Number.isInteger(options.hours) || options.hours < 1 || options.hours > 24) {
    throw new Error("--hours must be an integer between 1 and 24.");
  }
  if (!Number.isInteger(options.top) || options.top < 1 || options.top > 100) {
    throw new Error("--top must be an integer between 1 and 100.");
  }
  if (
    !Number.isInteger(options.requestDelayMs) ||
    options.requestDelayMs < 0 ||
    options.requestDelayMs > 60_000
  ) {
    throw new Error(
      "--request-delay-ms must be an integer between 0 and 60000.",
    );
  }
}

function compareNames(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

function isRepositoryName(value: string): boolean {
  return /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]+$/.test(
    value,
  );
}

function statusFromError(error: unknown): number | null {
  if (
    typeof error === "object" &&
    error !== null &&
    "status" in error &&
    (typeof error.status === "number" || error.status === null)
  ) {
    return error.status;
  }
  return null;
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}
