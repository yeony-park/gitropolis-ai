import type { GHArchiveSource } from "./gh-archive/client.js";
import {
  createEventIntegrityAccumulator,
  eventIntegritySnapshot,
  inspectWatchEvent,
  recordInspection,
  recordMalformedRecord,
  recordRecoveredRecord,
  type EventIntegrityAccumulator,
} from "./gh-archive/event-integrity.js";
import type {
  ActivitySeriesCoverageError,
  ActivitySeriesDay,
  ActivityMetadataProfile,
  ActivityMetadataSelectionRule,
  ActivitySeriesSnapshot,
} from "./types/activity-series.js";
import type { CandidateSnapshot } from "./types/candidate.js";
import type { RepositorySnapshot, Snapshot } from "./types/snapshot.js";

const HOUR_MS = 60 * 60 * 1_000;
const DAY_MS = 24 * HOUR_MS;

interface ActivityAccumulator {
  fullName: string;
  daily: number[];
  total: number;
  firstSeenAt: string;
  firstSeenTime: number;
  lastSeenAt: string;
  lastSeenTime: number;
}

interface DayAccumulator {
  date: string;
  hoursCollected: number;
  watchEvents: number;
  errorCount: number;
  integrity: EventIntegrityAccumulator;
}

export interface ActivitySeriesOptions {
  from: Date;
  days: number;
  requestDelayMs: number;
  sleep?: (milliseconds: number) => Promise<void>;
  onDayComplete?: (
    day: ActivitySeriesDay,
    completedDays: number,
    totalDays: number,
  ) => void;
}

export async function buildActivitySeries(
  options: ActivitySeriesOptions,
  archive: GHArchiveSource,
): Promise<ActivitySeriesSnapshot> {
  validateOptions(options);
  const from = new Date(options.from.getTime());
  const to = new Date(from.getTime() + options.days * DAY_MS);
  const sleep = options.sleep ?? delay;
  const repositories = new Map<string, ActivityAccumulator>();
  const coverageErrors: ActivitySeriesCoverageError[] = [];
  const days = createDayAccumulators(from, options.days);
  const hoursRequested = options.days * 24;
  const acceptedEventIds = new Set<string>();
  const integrity = createEventIntegrityAccumulator();

  for (let offset = 0; offset < hoursRequested; offset += 1) {
    const hour = new Date(from.getTime() + offset * HOUR_MS);
    const dayIndex = Math.floor(offset / 24);
    const day = days[dayIndex];
    if (!day) {
      throw new Error("Activity-series day index is out of bounds.");
    }
    try {
      for await (const record of archive.recordsForHour(hour)) {
        if (record.kind === "parse-error") {
          recordMalformedRecord(integrity);
          recordMalformedRecord(day.integrity);
          recordArchiveError(
            coverageErrors,
            day,
            `${hour.toISOString()}#line-${record.line}`,
            `GH Archive record could not be parsed: ${record.message}`,
          );
          continue;
        }
        if (record.recovered_lines !== undefined) {
          recordRecoveredRecord(integrity);
          recordRecoveredRecord(day.integrity);
        }
        const inspected = inspectWatchEvent(
          record.event,
          hour,
          acceptedEventIds,
        );
        recordInspection(integrity, inspected);
        recordInspection(day.integrity, inspected);
        if (inspected.kind === "invalid") {
          recordArchiveError(
            coverageErrors,
            day,
            `${hour.toISOString()}#line-${record.line}`,
            inspected.message,
          );
          continue;
        }
        if (
          inspected.kind === "ignored" ||
          inspected.kind === "duplicate"
        ) {
          continue;
        }
        recordActivity(repositories, inspected, dayIndex, options.days);
        day.watchEvents += 1;
      }
      day.hoursCollected += 1;
    } catch (error) {
      day.errorCount += 1;
      coverageErrors.push({
        source: "gh-archive",
        target: hour.toISOString(),
        status: statusFromError(error),
        message: error instanceof Error ? error.message : "unknown error",
      });
    }

    if (offset < hoursRequested - 1 && options.requestDelayMs > 0) {
      await sleep(options.requestDelayMs);
    }
    if ((offset + 1) % 24 === 0) {
      const completedDay = daySnapshot([day])[0];
      if (completedDay) {
        options.onDayComplete?.(
          completedDay,
          dayIndex + 1,
          options.days,
        );
      }
    }
  }

  const ranked = [...repositories.values()].sort(
    (left, right) =>
      right.total - left.total || compareNames(left.fullName, right.fullName),
  );
  const daySnapshots = daySnapshot(days);
  const archiveCoverageComplete = daySnapshots.every(
    ({ coverage_complete: complete }) => complete,
  );
  const repositorySnapshots = ranked.map((repository) => {
    return {
      full_name: repository.fullName,
      watch_events_observed_total: repository.total,
      observed_watch_velocity_per_day: archiveCoverageComplete
        ? Number((repository.total / options.days).toFixed(4))
        : null,
      first_seen_at: repository.firstSeenAt,
      last_seen_at: repository.lastSeenAt,
      daily: repository.daily.map((watchEvents, index) => ({
        date: days[index]?.date ?? "",
        watch_events_observed: watchEvents,
        coverage_complete:
          daySnapshots[index]?.coverage_complete ?? false,
      })),
      metadata_selected: false,
      current: null,
    };
  });

  return {
    schema_version: "activity-series-v1",
    window: {
      from: from.toISOString(),
      to: to.toISOString(),
      days: options.days,
    },
    source: {
      type: "gh-archive",
      archive_coverage_complete: archiveCoverageComplete,
      metadata_coverage_complete: true,
      coverage_complete: archiveCoverageComplete,
      hours_requested: hoursRequested,
      hours_collected: days.reduce(
        (total, day) => total + day.hoursCollected,
        0,
      ),
      watch_events_observed: days.reduce(
        (total, day) => total + day.watchEvents,
        0,
      ),
      repositories_seen: repositories.size,
      event_integrity: eventIntegritySnapshot(integrity),
      github_authenticated: null,
      github_rate_limit: null,
      metadata_selection: null,
      coverage_errors: coverageErrors,
    },
    days: daySnapshots,
    repositories: repositorySnapshots,
  };
}

export async function enrichActivitySeries(
  snapshot: ActivitySeriesSnapshot,
  selection: ActivityMetadataSelectionRule,
  enrich: (
    repositories: readonly string[],
    collectedAt: Date,
  ) => Promise<Snapshot>,
  collectedAt = new Date(),
  metadataProfile: ActivityMetadataProfile = "full",
): Promise<ActivitySeriesSnapshot> {
  validateSelection(selection);
  const selectedNames = snapshot.repositories
    .filter((repository) => selectionMatches(repository, selection))
    .map(({ full_name: fullName }) => fullName);
  const canReuseCurrent =
    snapshot.source.metadata_selection?.metadata_profile === metadataProfile;
  const existingByName = new Map<string, RepositorySnapshot>();
  if (canReuseCurrent) {
    for (const repository of snapshot.repositories) {
      if (repository.current) {
        existingByName.set(
          repository.full_name.toLowerCase(),
          repository.current,
        );
      }
    }
  }
  const namesToCollect = selectedNames.filter(
    (name) => !existingByName.has(name.toLowerCase()),
  );
  const githubSnapshot =
    namesToCollect.length === 0
      ? null
      : await enrich(namesToCollect, collectedAt);
  const githubByName = new Map(existingByName);
  for (const repository of githubSnapshot?.repositories ?? []) {
    githubByName.set(repository.full_name.toLowerCase(), repository);
  }
  const coverageErrors = snapshot.source.coverage_errors
    .filter(({ source }) => source !== "github")
    .map((error) => ({ ...error }));

  for (const error of githubSnapshot?.source.coverage_errors ?? []) {
    coverageErrors.push({
      source: "github",
      target: error.endpoint,
      status: error.status,
      message: error.message,
    });
  }

  const selectedSet = new Set(selectedNames.map((name) => name.toLowerCase()));
  for (const name of selectedNames) {
    if (!githubByName.has(name.toLowerCase())) {
      coverageErrors.push({
        source: "github",
        target: name,
        status: null,
        message: `GitHub metadata was not collected for ${name}`,
      });
    }
  }

  const repositories = snapshot.repositories.map((repository) => {
    const selected = selectedSet.has(repository.full_name.toLowerCase());
    return {
      ...repository,
      metadata_selected: selected,
      current: selected
        ? githubByName.get(repository.full_name.toLowerCase()) ?? null
        : null,
    };
  });
  const metadataCollected = repositories.filter(
    ({ metadata_selected: selected, current }) => selected && current !== null,
  ).length;
  const metadataCoverageComplete = metadataCollected === selectedNames.length;

  return {
    ...snapshot,
    source: {
      ...snapshot.source,
      type: "gh-archive+github",
      metadata_coverage_complete: metadataCoverageComplete,
      coverage_complete:
        snapshot.source.archive_coverage_complete &&
        metadataCoverageComplete,
      github_authenticated:
        githubSnapshot?.source.authenticated ??
        (canReuseCurrent ? snapshot.source.github_authenticated : null),
      github_rate_limit:
        githubSnapshot?.source.rate_limit ??
        (canReuseCurrent ? snapshot.source.github_rate_limit : null),
      metadata_selection: {
        ...selection,
        metadata_profile: metadataProfile,
        selected: selectedNames.length,
        collected: metadataCollected,
        collected_at:
          githubSnapshot?.collected_at ??
          (canReuseCurrent
            ? snapshot.source.metadata_selection?.collected_at ?? null
            : null),
      },
      coverage_errors: coverageErrors,
    },
    repositories,
  };
}

function validateSelection(selection: ActivityMetadataSelectionRule): void {
  const minimum =
    selection.method === "minimum-daily-watch-events"
      ? selection.minimum_daily_watch_events
      : selection.minimum_window_watch_events;
  if (!Number.isInteger(minimum) || minimum < 1) {
    throw new Error("WatchEvent selection minimum must be a positive integer.");
  }
}

function selectionMatches(
  repository: ActivitySeriesSnapshot["repositories"][number],
  selection: ActivityMetadataSelectionRule,
): boolean {
  if (selection.method === "minimum-window-watch-events") {
    return (
      repository.watch_events_observed_total >=
      selection.minimum_window_watch_events
    );
  }
  return repository.daily.some(
    ({ watch_events_observed: total }) =>
      total >= selection.minimum_daily_watch_events,
  );
}

export function activitySeriesToCandidate(
  snapshot: ActivitySeriesSnapshot,
): CandidateSnapshot {
  return {
    schema_version: "candidate-v1",
    window: {
      from: snapshot.window.from,
      to: snapshot.window.to,
    },
    source: {
      type: "gh-archive",
      coverage_complete: snapshot.source.coverage_complete,
      hours_requested: snapshot.source.hours_requested,
      hours_collected: snapshot.source.hours_collected,
      watch_events_seen: snapshot.source.watch_events_observed,
      repositories_seen: snapshot.source.repositories_seen,
      ...(snapshot.source.event_integrity
        ? { event_integrity: snapshot.source.event_integrity }
        : {}),
      github_authenticated: snapshot.source.github_authenticated,
      github_rate_limit: snapshot.source.github_rate_limit,
      coverage_errors: snapshot.source.coverage_errors,
    },
    repositories: snapshot.repositories
      .filter(({ metadata_selected: selected }) => selected)
      .map((repository) => ({
        full_name: repository.full_name,
        watch_events: repository.watch_events_observed_total,
        first_seen_at: repository.first_seen_at,
        last_seen_at: repository.last_seen_at,
        github: repository.current,
      })),
  };
}

function createDayAccumulators(
  from: Date,
  count: number,
): DayAccumulator[] {
  return Array.from({ length: count }, (_, index) => ({
    date: new Date(from.getTime() + index * DAY_MS)
      .toISOString()
      .slice(0, 10),
    hoursCollected: 0,
    watchEvents: 0,
    errorCount: 0,
    integrity: createEventIntegrityAccumulator(),
  }));
}

function daySnapshot(days: readonly DayAccumulator[]): ActivitySeriesDay[] {
  return days.map((day) => ({
    date: day.date,
    hours_requested: 24,
    hours_collected: day.hoursCollected,
    coverage_complete: day.hoursCollected === 24 && day.errorCount === 0,
    watch_events_observed: day.watchEvents,
    event_integrity: eventIntegritySnapshot(day.integrity),
  }));
}

function recordArchiveError(
  errors: ActivitySeriesCoverageError[],
  day: DayAccumulator,
  target: string,
  message: string,
): void {
  day.errorCount += 1;
  errors.push({
    source: "gh-archive",
    target,
    status: null,
    message,
  });
}

function recordActivity(
  repositories: Map<string, ActivityAccumulator>,
  event: {
    fullName: string;
    createdAt: string;
    timestamp: number;
  },
  dayIndex: number,
  dayCount: number,
): void {
  const key = event.fullName.toLowerCase();
  const existing = repositories.get(key);
  if (!existing) {
    const daily = Array.from({ length: dayCount }, () => 0);
    daily[dayIndex] = 1;
    repositories.set(key, {
      fullName: event.fullName,
      daily,
      total: 1,
      firstSeenAt: event.createdAt,
      firstSeenTime: event.timestamp,
      lastSeenAt: event.createdAt,
      lastSeenTime: event.timestamp,
    });
    return;
  }

  existing.daily[dayIndex] = (existing.daily[dayIndex] ?? 0) + 1;
  existing.total += 1;
  if (event.timestamp < existing.firstSeenTime) {
    existing.firstSeenAt = event.createdAt;
    existing.firstSeenTime = event.timestamp;
  }
  if (event.timestamp > existing.lastSeenTime) {
    existing.lastSeenAt = event.createdAt;
    existing.lastSeenTime = event.timestamp;
  }
}

function validateOptions(options: ActivitySeriesOptions): void {
  if (
    !Number.isFinite(options.from.getTime()) ||
    options.from.getUTCHours() !== 0 ||
    options.from.getUTCMinutes() !== 0 ||
    options.from.getUTCSeconds() !== 0 ||
    options.from.getUTCMilliseconds() !== 0
  ) {
    throw new Error("--from must be a valid UTC timestamp at 00:00:00Z.");
  }
  if (!Number.isInteger(options.days) || options.days < 1 || options.days > 7) {
    throw new Error("--days must be an integer between 1 and 7.");
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
