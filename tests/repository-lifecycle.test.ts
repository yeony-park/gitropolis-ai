import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { parseLifecycleArguments } from "../src/cli.js";
import {
  defaultRepositoryLifecyclePath,
  readRepositoryLifecycle,
  writeRepositoryLifecycle,
} from "../src/repository-lifecycle-file.js";
import {
  deriveRepositoryLifecycle,
  type RepositoryLifecycleInputSnapshot,
} from "../src/repository-lifecycle.js";
import type { ActivitySeriesSnapshot } from "../src/types/activity-series.js";
import type { GHArchiveEventIntegrity } from "../src/types/gh-archive.js";

const DAY_MS = 24 * 60 * 60 * 1_000;
const INTEGRITY: GHArchiveEventIntegrity = {
  deduplication_applied: true,
  raw_watch_events_seen: 0,
  unique_watch_events: 0,
  duplicate_event_ids: 0,
  missing_event_ids: 0,
  invalid_event_ids: 0,
  invalid_watch_events: 0,
  malformed_records: 0,
};

interface WeeklyInputOptions {
  integrity?: boolean;
  recordWarningDays?: number[];
  missingHourDays?: number[];
}

function weeklyInput(
  from: string,
  repositories: Readonly<Record<string, readonly number[]>>,
  options: WeeklyInputOptions = {},
): RepositoryLifecycleInputSnapshot {
  const integrity = options.integrity ?? true;
  const recordWarnings = new Set(options.recordWarningDays ?? []);
  const missingHours = new Set(options.missingHourDays ?? []);
  const dates = Array.from({ length: 7 }, (_, index) => addDays(from, index));
  const days = dates.map((date, index) => ({
    date,
    hours_requested: 24 as const,
    hours_collected: missingHours.has(index) ? 23 : 24,
    coverage_complete:
      !missingHours.has(index) && !recordWarnings.has(index),
    watch_events_observed: Object.values(repositories).reduce(
      (total, counts) => total + (counts[index] ?? 0),
      0,
    ),
    ...(integrity ? { event_integrity: INTEGRITY } : {}),
  }));
  const repositoryRecords = Object.entries(repositories).map(
    ([fullName, counts]) => {
      const firstIndex = counts.findIndex((count) => count > 0);
      const lastIndex = counts.findLastIndex((count) => count > 0);
      const total = counts.reduce((sum, count) => sum + count, 0);
      return {
        full_name: fullName,
        watch_events_observed_total: total,
        observed_watch_velocity_per_day:
          days.every(({ coverage_complete: complete }) => complete)
            ? Number((total / 7).toFixed(4))
            : null,
        first_seen_at: `${dates[Math.max(firstIndex, 0)]}T00:00:00.000Z`,
        last_seen_at: `${dates[Math.max(lastIndex, 0)]}T23:59:59.000Z`,
        daily: dates.map((date, index) => ({
          date,
          watch_events_observed: counts[index] ?? 0,
          coverage_complete: days[index]?.coverage_complete ?? false,
        })),
        metadata_selected: false,
        current: null,
      };
    },
  );
  const coverageComplete = days.every(
    ({ coverage_complete: complete }) => complete,
  );
  const snapshot: ActivitySeriesSnapshot = {
    schema_version: "activity-series-v1",
    window: {
      from: `${from}T00:00:00.000Z`,
      to: `${addDays(from, 7)}T00:00:00.000Z`,
      days: 7,
    },
    source: {
      type: "gh-archive",
      archive_coverage_complete: coverageComplete,
      metadata_coverage_complete: true,
      coverage_complete: coverageComplete,
      hours_requested: 168,
      hours_collected: days.reduce(
        (total, day) => total + day.hours_collected,
        0,
      ),
      watch_events_observed: repositoryRecords.reduce(
        (total, repository) =>
          total + repository.watch_events_observed_total,
        0,
      ),
      repositories_seen: repositoryRecords.length,
      ...(integrity ? { event_integrity: INTEGRITY } : {}),
      github_authenticated: null,
      github_rate_limit: null,
      metadata_selection: null,
      coverage_errors: [],
    },
    days,
    repositories: repositoryRecords,
  };
  return { path: `${from}.json`, snapshot };
}

function repositoryCounts(
  from: string,
  fullName: string,
  weeklyCounts: readonly number[],
  optionsForWeek: (index: number) => WeeklyInputOptions = () => ({}),
): RepositoryLifecycleInputSnapshot[] {
  return weeklyCounts.map((count, index) =>
    weeklyInput(
      addDays(from, index * 7),
      { [fullName]: [count, 0, 0, 0, 0, 0, 0] },
      optionsForWeek(index),
    ),
  );
}

test("moves candidate through cooling and inactive, then records revival", () => {
  const snapshot = deriveRepositoryLifecycle(
    repositoryCounts("2026-06-01", "owner/a", [3, 0, 0, 3]),
  );
  const repository = snapshot.repositories[0];

  assert.deepEqual(
    repository?.weeks.map(({ radar_status: status }) => status),
    ["candidate", "cooling", "inactive", "candidate"],
  );
  assert.deepEqual(
    snapshot.events
      .filter(({ type }) => type !== "breakout_detected")
      .map(({ type }) => type),
    ["candidate_detected", "cooling_started", "inactivated", "revived"],
  );
  assert.equal(repository?.radar_status, "candidate");
  assert.equal(repository?.consecutive_below_scout_weeks, 0);
});

test("promotes gradual 1 to 2 to 3 growth and tracks later breakout", () => {
  const snapshot = deriveRepositoryLifecycle(
    repositoryCounts("2026-06-01", "owner/b", [1, 2, 3, 10]),
  );
  const repository = snapshot.repositories[0];

  assert.deepEqual(
    repository?.weeks.map(({ radar_status: status }) => status),
    [null, null, "active", "active"],
  );
  assert.equal(repository?.fast_breakout, true);
  assert.equal(repository?.breakout_status, "confirmed");
  assert.equal(
    snapshot.events.some(
      ({ type, reason }) =>
        type === "activated" && reason.includes("Three consecutive"),
    ),
    true,
  );
});

test("keeps Main Radar, Scout, and lifecycle state independent", () => {
  const inputs = [
    weeklyInput("2026-06-01", {
      "owner/main": [5, 0, 0, 0, 0, 0, 0],
      "owner/scout": [1, 1, 1, 0, 0, 0, 0],
      "owner/long-tail": [1, 0, 0, 0, 0, 0, 0],
    }),
    weeklyInput("2026-06-08", {
      "owner/main": [3, 0, 0, 0, 0, 0, 0],
      "owner/scout": [1, 1, 1, 0, 0, 0, 0],
    }),
  ];
  inputs[0]!.path = "/Users/example/private/week-1.json";
  const selectedWithoutMetadata = inputs[0]!.snapshot.repositories.find(
    ({ full_name: name }) => name === "owner/main",
  );
  if (selectedWithoutMetadata) {
    selectedWithoutMetadata.metadata_selected = true;
  }
  const snapshot = deriveRepositoryLifecycle(inputs);
  const main = snapshot.repositories.find(
    ({ full_name: name }) => name === "owner/main",
  );
  const scout = snapshot.repositories.find(
    ({ full_name: name }) => name === "owner/scout",
  );
  const longTail = snapshot.repositories.find(
    ({ full_name: name }) => name === "owner/long-tail",
  );

  assert.equal(main?.weeks[0]?.main_radar, true);
  assert.equal(main?.weeks[0]?.emerging_scout, true);
  assert.equal(main?.radar_status, "active");
  assert.equal(main?.availability_status, "unavailable");
  assert.equal(scout?.weeks[0]?.main_radar, false);
  assert.equal(scout?.weeks[0]?.emerging_scout, true);
  assert.equal(scout?.radar_status, "active");
  assert.equal(longTail?.radar_status, null);
  assert.equal(snapshot.repositories.length, 3);
  assert.equal(snapshot.source.input_snapshots[0]?.file_name, "week-1.json");
});

test("requires a following week to confirm a new fast breakout", () => {
  const confirmed = deriveRepositoryLifecycle(
    repositoryCounts("2026-06-01", "owner/confirmed", [12, 4]),
  ).repositories[0];
  const unconfirmed = deriveRepositoryLifecycle(
    repositoryCounts("2026-06-01", "owner/unconfirmed", [12, 1]),
  );

  assert.deepEqual(
    confirmed?.weeks.map(({ radar_status: status }) => status),
    ["candidate", "active"],
  );
  assert.equal(confirmed?.breakout_status, "confirmed");
  assert.deepEqual(
    unconfirmed.repositories[0]?.weeks.map(
      ({ radar_status: status }) => status,
    ),
    ["candidate", "cooling"],
  );
  assert.equal(
    unconfirmed.repositories[0]?.breakout_status,
    "unconfirmed",
  );
});

test("incomplete time coverage preserves state and blocks false cooling", () => {
  const snapshot = deriveRepositoryLifecycle(
    repositoryCounts(
      "2026-06-01",
      "owner/repository",
      [3, 3, 0, 0],
      (index) => index === 2 ? { missingHourDays: [0] } : {},
    ),
  );
  const repository = snapshot.repositories[0];

  assert.deepEqual(
    repository?.weeks.map(({ radar_status: status }) => status),
    ["candidate", "active", "active", "cooling"],
  );
  assert.equal(repository?.weeks[2]?.emerging_scout, null);
  assert.equal(repository?.weeks[2]?.decision_coverage, "temporal-incomplete");
  assert.equal(
    snapshot.events.some(({ type }) => type === "data_incomplete"),
    true,
  );
});

test("record warnings allow observed growth but block negative transitions", () => {
  const snapshot = deriveRepositoryLifecycle(
    repositoryCounts(
      "2026-06-01",
      "owner/repository",
      [3, 3, 0, 0],
      (index) => index === 2 ? { recordWarningDays: [0] } : {},
    ),
  );
  const repository = snapshot.repositories[0];

  assert.deepEqual(
    repository?.weeks.map(({ radar_status: status }) => status),
    ["candidate", "active", "active", "cooling"],
  );
  assert.equal(repository?.weeks[2]?.decision_coverage, "record-warning");
  assert.equal(repository?.weeks[2]?.emerging_scout, null);
});

test("legacy snapshots remain usable and expose unavailable integrity", () => {
  const inputs = repositoryCounts(
    "2026-06-01",
    "owner/legacy",
    [3, 3],
    () => ({ integrity: false }),
  );
  const first = deriveRepositoryLifecycle(inputs);
  const second = deriveRepositoryLifecycle(inputs);

  assert.deepEqual(first, second);
  assert.equal(first.source.integrity_verification, "unavailable");
  assert.equal(first.weeks[0]?.integrity_verification, "unavailable");
  assert.equal(first.repositories[0]?.radar_status, "active");
});

test("rejects unordered, gapped, and invalid-threshold inputs", () => {
  const first = weeklyInput("2026-06-01", {
    "owner/repository": [1, 0, 0, 0, 0, 0, 0],
  });
  const second = weeklyInput("2026-06-08", {
    "owner/repository": [1, 0, 0, 0, 0, 0, 0],
  });
  const gap = weeklyInput("2026-06-15", {
    "owner/repository": [1, 0, 0, 0, 0, 0, 0],
  });

  assert.throws(
    () => deriveRepositoryLifecycle([second, first]),
    /ordered by ascending/,
  );
  assert.throws(
    () => deriveRepositoryLifecycle([first, gap]),
    /must be consecutive/,
  );
  assert.throws(
    () =>
      deriveRepositoryLifecycle([first], {
        scoutWeeklyWatchEvents: 3,
        fastBreakoutWeeklyWatchEvents: 2,
      }),
    /at least the Scout threshold/,
  );
});

test("repository lifecycle file round-trips as v1", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gitropolis-lifecycle-"));
  const snapshot = deriveRepositoryLifecycle(
    repositoryCounts("2026-06-01", "owner/repository", [3]),
  );
  const path = defaultRepositoryLifecyclePath(directory, snapshot);

  await writeRepositoryLifecycle(snapshot, path);
  assert.deepEqual(await readRepositoryLifecycle(path), snapshot);
});

test("lifecycle CLI accepts ordered repeated inputs and threshold overrides", () => {
  assert.deepEqual(
    parseLifecycleArguments([
      "--input",
      "week-1.json",
      "--input",
      "week-2.json",
      "--main-daily-watch-events",
      "6",
      "--scout-weekly-watch-events",
      "4",
      "--fast-breakout-weekly-watch-events",
      "12",
    ]),
    {
      inputs: ["week-1.json", "week-2.json"],
      mainDailyWatchEvents: 6,
      scoutWeeklyWatchEvents: 4,
      fastBreakoutWeeklyWatchEvents: 12,
    },
  );
  assert.throws(() => parseLifecycleArguments([]), /at least one --input/);
});

function addDays(date: string, count: number): string {
  return new Date(
    Date.parse(`${date}T00:00:00.000Z`) + count * DAY_MS,
  ).toISOString().slice(0, 10);
}
