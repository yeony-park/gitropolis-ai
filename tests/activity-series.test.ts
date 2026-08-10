import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  activitySeriesToCandidate,
  buildActivitySeries,
  enrichActivitySeries,
} from "../src/activity-series.js";
import {
  defaultActivitySeriesPath,
  readActivitySeries,
  writeActivitySeries,
} from "../src/activity-series-file.js";
import {
  parseActivityEnrichmentArguments,
  parseBackfillArguments,
} from "../src/cli.js";
import type {
  GHArchiveEvent,
  GHArchiveRecord,
  GHArchiveSource,
} from "../src/gh-archive/client.js";
import { parseWatchEvent } from "../src/gh-archive/watch-event.js";
import type {
  RepositorySnapshot,
  Snapshot,
} from "../src/types/snapshot.js";

type HourResult = readonly GHArchiveRecord[] | Error;

class StubArchive implements GHArchiveSource {
  readonly requestedHours: string[] = [];

  constructor(private readonly results: Readonly<Record<string, HourResult>>) {}

  async *recordsForHour(hour: Date): AsyncIterable<GHArchiveRecord> {
    const key = hour.toISOString();
    this.requestedHours.push(key);
    const result = this.results[key] ?? [];
    if (result instanceof Error) {
      throw result;
    }
    yield* result;
  }
}

const from = new Date("2026-07-27T00:00:00Z");
const collectedAt = new Date("2026-08-03T00:00:00Z");
let nextWatchEventId = 1;

function eventRecord(
  fullName: string,
  createdAt: string,
  line = 1,
  eventId = String(nextWatchEventId++),
): GHArchiveRecord {
  const event: GHArchiveEvent = {
    id: eventId,
    type: "WatchEvent",
    repo: { name: fullName },
    payload: { action: "started" },
    created_at: createdAt,
  };
  return { kind: "event", line, event };
}

function repositorySnapshot(
  fullName: string,
  id: number,
): RepositorySnapshot {
  return {
    id,
    node_id: `node-${id}`,
    full_name: fullName,
    html_url: `https://github.com/${fullName}`,
    description: `Description for ${fullName}`,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-08-03T00:00:00Z",
    pushed_at: "2026-08-02T00:00:00Z",
    stars: 100,
    forks: 10,
    subscribers: 2,
    open_issues_and_pull_requests: 3,
    primary_language: "TypeScript",
    language_bytes: { TypeScript: 100 },
    language_share: { TypeScript: 1 },
    topics: ["example"],
    default_branch: "main",
    archived: false,
    visibility: "public",
    license_spdx: "MIT",
    readme: {
      name: "README.md",
      path: "README.md",
      size: 100,
      sha: `sha-${id}`,
      html_url: `https://github.com/${fullName}#readme`,
    },
    commits_30d: 10,
    contributors_count: 4,
    delta_stars_1d: null,
    delta_stars_7d: null,
    delta_stars_30d: null,
    star_velocity_7d: null,
    star_acceleration: null,
  };
}

function enrichmentSnapshot(
  repositoryNames: readonly string[],
  collectedNames: readonly string[] = repositoryNames,
): Snapshot {
  const collected = new Set(collectedNames);
  const repositories = repositoryNames
    .filter((name) => collected.has(name))
    .map((name, index) => repositorySnapshot(name, index + 1));
  return {
    schema_version: "snapshot-v1",
    collected_at: collectedAt.toISOString(),
    source: {
      github_api_version: "2026-03-10",
      authenticated: true,
      coverage_complete: repositories.length === repositoryNames.length,
      rate_limit: {
        core: { limit: 5_000, remaining: 4_000, used: 1_000, reset: 1 },
      },
      coverage_errors: repositoryNames
        .filter((name) => !collected.has(name))
        .map((name) => ({
          endpoint: `/repos/${name}`,
          status: 404,
          message: "GitHub API returned 404: Not Found",
        })),
    },
    repositories,
  };
}

test("backfill requests 168 hours and preserves every observed repository", async () => {
  const archive = new StubArchive({
    "2026-07-27T00:00:00.000Z": [
      eventRecord("owner/steady", "2026-07-27T00:05:00Z", 1),
      eventRecord("owner/one-off", "2026-07-27T00:10:00Z", 2),
      eventRecord("owner/steady", "2026-07-27T00:15:00Z", 3),
    ],
    "2026-07-28T00:00:00.000Z": [
      eventRecord("Owner/Steady", "2026-07-28T00:05:00Z"),
    ],
    "2026-08-02T23:00:00.000Z": [
      eventRecord("owner/steady", "2026-08-02T23:59:00Z"),
    ],
  });
  let enrichedNames: readonly string[] = [];
  const completedDays: string[] = [];

  const raw = await buildActivitySeries(
    {
      from,
      days: 7,
      requestDelayMs: 0,
      onDayComplete(day) {
        completedDays.push(day.date);
      },
    },
    archive,
  );
  const snapshot = await enrichActivitySeries(
    raw,
    {
      method: "minimum-daily-watch-events",
      minimum_daily_watch_events: 2,
    },
    async (names) => {
      enrichedNames = names;
      return enrichmentSnapshot(names);
    },
    collectedAt,
  );

  assert.equal(archive.requestedHours.length, 168);
  assert.deepEqual(completedDays, [
    "2026-07-27",
    "2026-07-28",
    "2026-07-29",
    "2026-07-30",
    "2026-07-31",
    "2026-08-01",
    "2026-08-02",
  ]);
  assert.equal(archive.requestedHours[0], "2026-07-27T00:00:00.000Z");
  assert.equal(archive.requestedHours[167], "2026-08-02T23:00:00.000Z");
  assert.equal(snapshot.window.to, "2026-08-03T00:00:00.000Z");
  assert.equal(snapshot.source.hours_collected, 168);
  assert.equal(snapshot.source.repositories_seen, 2);
  assert.deepEqual(enrichedNames, ["owner/steady"]);
  assert.equal(snapshot.repositories.length, 2);

  const steady = snapshot.repositories[0];
  const oneOff = snapshot.repositories[1];
  assert.equal(steady?.full_name, "owner/steady");
  assert.equal(steady?.watch_events_observed_total, 4);
  assert.deepEqual(
    steady?.daily.map(({ watch_events_observed: count }) => count),
    [2, 1, 0, 0, 0, 0, 1],
  );
  assert.equal(steady?.metadata_selected, true);
  assert.equal(steady?.current?.readme?.sha, "sha-1");
  assert.equal(oneOff?.metadata_selected, false);
  assert.equal(oneOff?.current, null);
  assert.equal(snapshot.source.archive_coverage_complete, true);
  assert.equal(snapshot.source.metadata_coverage_complete, true);
  assert.equal(
    snapshot.source.metadata_selection?.method,
    "minimum-daily-watch-events",
  );
  assert.equal(
    snapshot.source.metadata_selection?.minimum_daily_watch_events,
    2,
  );
});

test("incomplete hours mark daily values as partial and disable velocity", async () => {
  const archive = new StubArchive({
    "2026-07-27T00:00:00.000Z": [
      eventRecord("owner/repository", "2026-07-27T00:05:00Z", 1),
      {
        kind: "parse-error",
        line: 2,
        message: "invalid JSON",
      },
    ],
    "2026-07-28T03:00:00.000Z": new Error("hour unavailable"),
  });

  const snapshot = await buildActivitySeries(
    {
      from,
      days: 2,
      requestDelayMs: 0,
    },
    archive,
  );

  assert.equal(snapshot.days[0]?.hours_collected, 24);
  assert.equal(snapshot.days[0]?.coverage_complete, false);
  assert.equal(snapshot.days[1]?.hours_collected, 23);
  assert.equal(snapshot.days[1]?.coverage_complete, false);
  assert.equal(
    snapshot.repositories[0]?.daily[1]?.watch_events_observed,
    0,
  );
  assert.equal(snapshot.repositories[0]?.daily[1]?.coverage_complete, false);
  assert.equal(
    snapshot.repositories[0]?.observed_watch_velocity_per_day,
    null,
  );
  assert.equal(snapshot.source.coverage_errors.length, 2);
  assert.equal(snapshot.source.event_integrity?.malformed_records, 1);
});

test("recovered archive records are counted without reducing coverage", async () => {
  const archive = new StubArchive({
    "2026-07-27T00:00:00.000Z": [
      {
        kind: "event",
        line: 1,
        recovered_lines: 2,
        event: {
          id: "issue-comment-1",
          type: "IssueCommentEvent",
        },
      },
      eventRecord("owner/repository", "2026-07-27T00:05:00Z", 3),
    ],
  });

  const snapshot = await buildActivitySeries(
    {
      from,
      days: 1,
      requestDelayMs: 0,
    },
    archive,
  );

  assert.equal(snapshot.source.archive_coverage_complete, true);
  assert.equal(snapshot.source.coverage_errors.length, 0);
  assert.equal(snapshot.source.event_integrity?.recovered_records, 1);
  assert.equal(snapshot.source.event_integrity?.malformed_records, 0);
  assert.equal(snapshot.days[0]?.event_integrity?.recovered_records, 1);
  assert.equal(snapshot.source.watch_events_observed, 1);
});

test("deduplicates WatchEvent ids across hours and preserves count invariants", async () => {
  const archive = new StubArchive({
    "2026-07-27T00:00:00.000Z": [
      eventRecord("owner/alpha", "2026-07-27T00:05:00Z", 1, "9001"),
      eventRecord("owner/alpha", "2026-07-27T00:06:00Z", 2, "9001"),
      eventRecord("owner/alpha", "2026-07-27T00:07:00Z", 3, "9002"),
    ],
    "2026-07-27T01:00:00.000Z": [
      eventRecord("OWNER/CHANGED", "2026-07-27T00:05:00Z", 1, "9001"),
      eventRecord("owner/beta", "2026-07-27T01:10:00Z", 2, "9003"),
    ],
  });

  const snapshot = await buildActivitySeries({
    from,
    days: 1,
    requestDelayMs: 0,
  }, archive);
  const integrity = snapshot.source.event_integrity;

  assert.equal(snapshot.source.archive_coverage_complete, true);
  assert.equal(snapshot.source.watch_events_observed, 3);
  assert.equal(snapshot.source.repositories_seen, 2);
  assert.deepEqual(integrity, {
    deduplication_applied: true,
    raw_watch_events_seen: 5,
    unique_watch_events: 3,
    duplicate_event_ids: 2,
    missing_event_ids: 0,
    invalid_event_ids: 0,
    invalid_watch_events: 0,
    recovered_records: 0,
    malformed_records: 0,
  });
  assert.equal(snapshot.days[0]?.watch_events_observed, 3);
  assert.equal(snapshot.days[0]?.event_integrity?.duplicate_event_ids, 2);
  assert.equal(
    snapshot.repositories.reduce(
      (total, repository) =>
        total + repository.watch_events_observed_total,
      0,
    ),
    integrity?.unique_watch_events,
  );
  assert.equal(snapshot.repositories[0]?.full_name, "owner/alpha");
  assert.equal(snapshot.repositories[0]?.watch_events_observed_total, 2);
  assert.equal(snapshot.repositories[0]?.first_seen_at, "2026-07-27T00:05:00Z");
  assert.equal(snapshot.repositories[0]?.last_seen_at, "2026-07-27T00:07:00Z");
});

test("reports invalid identities while allowing a later valid record", async () => {
  const invalidBeforeValid: GHArchiveEvent = {
    id: "9100",
    type: "WatchEvent",
    repo: { name: "owner/repository" },
    payload: { action: "stopped" },
    created_at: "2026-07-27T00:01:00Z",
  };
  const missingId: GHArchiveEvent = {
    type: "WatchEvent",
    repo: { name: "owner/missing" },
    payload: { action: "started" },
    created_at: "2026-07-27T00:02:00Z",
  };
  const invalidId: GHArchiveEvent = {
    id: 9_101,
    type: "WatchEvent",
    repo: { name: "owner/invalid" },
    payload: { action: "started" },
    created_at: "2026-07-27T00:03:00Z",
  };
  const archive = new StubArchive({
    "2026-07-27T00:00:00.000Z": [
      { kind: "event", line: 1, event: invalidBeforeValid },
      { kind: "event", line: 2, event: missingId },
      { kind: "event", line: 3, event: invalidId },
      eventRecord(
        "owner/repository",
        "2026-07-27T00:04:00Z",
        4,
        "9100",
      ),
      eventRecord(
        "owner/repository",
        "2026-07-27T00:05:00Z",
        5,
        "9100",
      ),
      eventRecord(
        "owner/large-id",
        "2026-07-27T00:06:00Z",
        6,
        "999999999999999999999999999999",
      ),
      { kind: "parse-error", line: 7, message: "invalid JSON" },
      {
        kind: "event",
        line: 8,
        event: { type: "PushEvent" },
      },
    ],
  });

  const snapshot = await buildActivitySeries({
    from,
    days: 1,
    requestDelayMs: 0,
  }, archive);

  assert.equal(snapshot.source.watch_events_observed, 2);
  assert.equal(snapshot.source.repositories_seen, 2);
  assert.equal(snapshot.source.archive_coverage_complete, false);
  assert.equal(snapshot.source.coverage_errors.length, 4);
  assert.deepEqual(snapshot.source.event_integrity, {
    deduplication_applied: true,
    raw_watch_events_seen: 6,
    unique_watch_events: 2,
    duplicate_event_ids: 1,
    missing_event_ids: 1,
    invalid_event_ids: 1,
    invalid_watch_events: 3,
    recovered_records: 0,
    malformed_records: 1,
  });
});

test("validates the complete WatchEvent id format without numeric conversion", () => {
  const hour = new Date("2026-07-27T00:00:00Z");
  const base: GHArchiveEvent = {
    type: "WatchEvent",
    repo: { name: "owner/repository" },
    payload: { action: "started" },
    created_at: "2026-07-27T00:05:00Z",
  };

  for (const id of [undefined, null]) {
    const parsed = parseWatchEvent({ ...base, id }, hour);
    assert.equal(parsed.kind, "invalid");
    assert.equal(
      parsed.kind === "invalid" ? parsed.reason : null,
      "missing-event-id",
    );
  }
  for (const id of ["", " ", 1, "-1", "1.5", "1e3", {}, []]) {
    const parsed = parseWatchEvent({ ...base, id }, hour);
    assert.equal(parsed.kind, "invalid");
    assert.equal(
      parsed.kind === "invalid" ? parsed.reason : null,
      "invalid-event-id",
    );
  }

  const largeId = "999999999999999999999999999999999999";
  const parsed = parseWatchEvent({ ...base, id: largeId }, hour);
  assert.equal(parsed.kind, "watch");
  assert.equal(parsed.kind === "watch" ? parsed.eventId : null, largeId);
});

test("preserves deduplication across a partial stream failure", async () => {
  const archive: GHArchiveSource = {
    async *recordsForHour(hour): AsyncIterable<GHArchiveRecord> {
      if (hour.toISOString() === "2026-07-27T00:00:00.000Z") {
        yield eventRecord(
          "owner/first",
          "2026-07-27T00:05:00Z",
          1,
          "9300",
        );
        throw new Error("stream interrupted");
      }
      if (hour.toISOString() === "2026-07-27T01:00:00.000Z") {
        yield eventRecord(
          "owner/changed",
          "2026-07-27T00:05:00Z",
          1,
          "9300",
        );
        yield eventRecord(
          "owner/second",
          "2026-07-27T01:05:00Z",
          2,
          "9301",
        );
      }
    },
  };

  const snapshot = await buildActivitySeries(
    { from, days: 1, requestDelayMs: 0 },
    archive,
  );

  assert.equal(snapshot.source.hours_collected, 23);
  assert.equal(snapshot.source.archive_coverage_complete, false);
  assert.equal(snapshot.source.watch_events_observed, 2);
  assert.equal(snapshot.source.event_integrity?.duplicate_event_ids, 1);
  assert.equal(snapshot.source.event_integrity?.unique_watch_events, 2);
  assert.equal(
    snapshot.repositories.reduce(
      (total, repository) =>
        total + repository.watch_events_observed_total,
      0,
    ),
    2,
  );
  assert.equal(
    snapshot.repositories.every(
      ({ observed_watch_velocity_per_day: velocity }) => velocity === null,
    ),
    true,
  );
});

test("duplicate ids cannot inflate metadata selection thresholds", async () => {
  const duplicateRecords = Array.from({ length: 5 }, (_, index) =>
    eventRecord(
      "owner/repository",
      `2026-07-27T00:0${index}:00Z`,
      index + 1,
      "9200",
    ),
  );
  const raw = await buildActivitySeries(
    { from, days: 1, requestDelayMs: 0 },
    new StubArchive({
      "2026-07-27T00:00:00.000Z": duplicateRecords,
    }),
  );
  let selected: readonly string[] = [];
  const enriched = await enrichActivitySeries(
    raw,
    {
      method: "minimum-daily-watch-events",
      minimum_daily_watch_events: 5,
    },
    async (names) => {
      selected = names;
      return enrichmentSnapshot(names);
    },
    collectedAt,
  );

  assert.deepEqual(selected, []);
  assert.equal(enriched.source.metadata_selection?.selected, 0);
  assert.equal(enriched.repositories[0]?.watch_events_observed_total, 1);
});

test("cross-day duplicates cannot inflate the Scout window threshold", async () => {
  const raw = await buildActivitySeries(
    { from, days: 3, requestDelayMs: 0 },
    new StubArchive({
      "2026-07-27T00:00:00.000Z": [
        eventRecord(
          "owner/repository",
          "2026-07-27T00:05:00Z",
          1,
          "9400",
        ),
      ],
      "2026-07-28T00:00:00.000Z": [
        eventRecord(
          "owner/repository",
          "2026-07-28T00:05:00Z",
          1,
          "9400",
        ),
      ],
      "2026-07-29T00:00:00.000Z": [
        eventRecord(
          "owner/repository",
          "2026-07-29T00:05:00Z",
          1,
          "9400",
        ),
      ],
    }),
  );
  let selected: readonly string[] = [];
  const enriched = await enrichActivitySeries(
    raw,
    {
      method: "minimum-window-watch-events",
      minimum_window_watch_events: 3,
    },
    async (names) => {
      selected = names;
      return enrichmentSnapshot(names);
    },
    collectedAt,
  );

  assert.deepEqual(selected, []);
  assert.equal(enriched.source.metadata_selection?.selected, 0);
  assert.equal(enriched.source.event_integrity?.duplicate_event_ids, 2);
});

test("legacy activity-series-v1 without integrity fields remains readable", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gitropolis-legacy-"));
  const snapshot = await buildActivitySeries(
    { from, days: 1, requestDelayMs: 0 },
    new StubArchive({}),
  );
  const legacy = structuredClone(snapshot);
  delete legacy.source.event_integrity;
  for (const day of legacy.days) {
    delete day.event_integrity;
  }
  const path = join(directory, "legacy.json");
  await writeFile(path, `${JSON.stringify(legacy, null, 2)}\n`, "utf8");

  const read = await readActivitySeries(path);
  const enriched = await enrichActivitySeries(
    read,
    {
      method: "minimum-daily-watch-events",
      minimum_daily_watch_events: 1,
    },
    async (names) => enrichmentSnapshot(names),
    collectedAt,
  );

  assert.equal(read.source.event_integrity, undefined);
  assert.equal(enriched.source.event_integrity, undefined);
  assert.equal(activitySeriesToCandidate(enriched).source.event_integrity, undefined);
});

test("window scout selects activity spread across different days", async () => {
  const archive = new StubArchive({
    "2026-07-27T00:00:00.000Z": [
      eventRecord("owner/scout", "2026-07-27T00:05:00Z", 1),
    ],
    "2026-07-28T00:00:00.000Z": [
      eventRecord("owner/scout", "2026-07-28T00:05:00Z", 2),
    ],
    "2026-07-29T00:00:00.000Z": [
      eventRecord("owner/scout", "2026-07-29T00:05:00Z", 3),
    ],
  });
  const raw = await buildActivitySeries(
    { from, days: 3, requestDelayMs: 0 },
    archive,
  );
  const snapshot = await enrichActivitySeries(
    raw,
    {
      method: "minimum-window-watch-events",
      minimum_window_watch_events: 3,
    },
    async (names) => enrichmentSnapshot(names),
    collectedAt,
    "classification",
  );

  assert.equal(snapshot.repositories[0]?.metadata_selected, true);
  assert.equal(
    snapshot.source.metadata_selection?.method,
    "minimum-window-watch-events",
  );
  assert.equal(
    snapshot.source.metadata_selection?.metadata_profile,
    "classification",
  );
});

test("partial metadata failures preserve activity and selected repositories", async () => {
  const archive = new StubArchive({
    "2026-07-27T00:00:00.000Z": [
      eventRecord("owner/alpha", "2026-07-27T00:05:00Z", 1),
      eventRecord("owner/beta", "2026-07-27T00:10:00Z", 2),
    ],
  });

  const raw = await buildActivitySeries(
    {
      from,
      days: 1,
      requestDelayMs: 0,
    },
    archive,
  );
  const snapshot = await enrichActivitySeries(
    raw,
    {
      method: "minimum-daily-watch-events",
      minimum_daily_watch_events: 1,
    },
    async (names) => enrichmentSnapshot(names, ["owner/alpha"]),
    collectedAt,
  );

  assert.equal(snapshot.repositories.length, 2);
  assert.ok(snapshot.repositories[0]?.current);
  assert.equal(snapshot.repositories[1]?.current, null);
  assert.equal(snapshot.source.metadata_selection?.selected, 2);
  assert.equal(snapshot.source.metadata_selection?.collected, 1);
  assert.equal(snapshot.source.metadata_coverage_complete, false);
  assert.equal(snapshot.source.coverage_complete, false);
  assert.equal(
    snapshot.source.coverage_errors.some(
      ({ source, target }) =>
        source === "github" && target.includes("owner/beta"),
    ),
    true,
  );
});

test("activity enrichment resumes without recollecting successful metadata", async () => {
  const archive = new StubArchive({
    "2026-07-27T00:00:00.000Z": [
      eventRecord("owner/alpha", "2026-07-27T00:05:00Z", 1),
      eventRecord("owner/beta", "2026-07-27T00:10:00Z", 2),
    ],
  });
  const raw = await buildActivitySeries(
    { from, days: 1, requestDelayMs: 0 },
    archive,
  );
  const selection = {
    method: "minimum-daily-watch-events" as const,
    minimum_daily_watch_events: 1,
  };
  const partial = await enrichActivitySeries(
    raw,
    selection,
    async (names) => enrichmentSnapshot(names, ["owner/alpha"]),
    collectedAt,
    "screening",
  );
  let resumedNames: readonly string[] = [];
  const resumed = await enrichActivitySeries(
    partial,
    selection,
    async (names) => {
      resumedNames = names;
      return enrichmentSnapshot(names);
    },
    collectedAt,
    "screening",
  );

  assert.deepEqual(resumedNames, ["owner/beta"]);
  assert.equal(resumed.source.metadata_selection?.collected, 2);
  assert.equal(resumed.source.metadata_coverage_complete, true);
  assert.equal(resumed.repositories.every(({ current }) => current !== null), true);
});

test("activity series converts only metadata-selected repositories for analysis", async () => {
  const archive = new StubArchive({
    "2026-07-27T00:00:00.000Z": [
      eventRecord("owner/selected", "2026-07-27T00:05:00Z", 1),
      eventRecord("owner/selected", "2026-07-27T00:06:00Z", 2),
      eventRecord("owner/long-tail", "2026-07-27T00:07:00Z", 3),
    ],
  });
  const raw = await buildActivitySeries(
    {
      from,
      days: 1,
      requestDelayMs: 0,
    },
    archive,
  );
  const series = await enrichActivitySeries(
    raw,
    {
      method: "minimum-daily-watch-events",
      minimum_daily_watch_events: 2,
    },
    async (names) => enrichmentSnapshot(names),
    collectedAt,
  );

  const candidate = activitySeriesToCandidate(series);

  assert.equal(series.repositories.length, 2);
  assert.equal(candidate.repositories.length, 1);
  assert.equal(candidate.repositories[0]?.full_name, "owner/selected");
  assert.equal(candidate.repositories[0]?.watch_events, 2);
});

test("activity series file round-trips as activity-series-v1", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gitropolis-activity-"));
  const archive = new StubArchive({});
  const snapshot = await buildActivitySeries(
    {
      from,
      days: 1,
      requestDelayMs: 0,
    },
    archive,
  );
  const path = defaultActivitySeriesPath(directory, snapshot);

  await writeActivitySeries(snapshot, path);
  const read = await readActivitySeries(path);
  const raw = JSON.parse(await readFile(path, "utf8")) as {
    schema_version: string;
  };

  assert.equal(raw.schema_version, "activity-series-v1");
  assert.deepEqual(read, snapshot);
});

test("backfill CLI defaults to seven full UTC days", () => {
  const options = parseBackfillArguments([
    "--from",
    "2026-07-27T00:00:00Z",
  ]);

  assert.equal(options.days, 7);
  assert.equal(options.requestDelayMs, 1_000);
  assert.equal(options.requestTimeoutMs, 60_000);
  assert.throws(
    () =>
      parseBackfillArguments([
        "--from",
        "2026-07-27T01:00:00Z",
      ]),
    /00:00:00Z/,
  );
  assert.throws(
    () =>
      parseBackfillArguments([
        "--from",
        "2026-07-27T00:00:00Z",
        "--days",
        "8",
      ]),
    /between 1 and 7/,
  );
});

test("activity enrichment CLI defaults to a five-event daily floor", () => {
  assert.deepEqual(
    parseActivityEnrichmentArguments(["--input", "activity.json"]),
    {
      input: "activity.json",
      selection: {
        method: "minimum-daily-watch-events",
        minimum_daily_watch_events: 5,
      },
      metadataProfile: "full",
    },
  );
  assert.throws(
    () => parseActivityEnrichmentArguments([]),
    /requires --input/,
  );
});

test("activity enrichment CLI supports a classification scout window", () => {
  assert.deepEqual(
    parseActivityEnrichmentArguments([
      "--input",
      "activity.json",
      "--min-window-watch-events",
      "3",
      "--metadata-profile",
      "classification",
    ]),
    {
      input: "activity.json",
      selection: {
        method: "minimum-window-watch-events",
        minimum_window_watch_events: 3,
      },
      metadataProfile: "classification",
    },
  );
  assert.throws(
    () =>
      parseActivityEnrichmentArguments([
        "--input",
        "activity.json",
        "--min-daily-watch-events",
        "3",
        "--min-window-watch-events",
        "3",
      ]),
    /Use only one/,
  );
});

test("activity enrichment CLI supports a screening profile", () => {
  assert.deepEqual(
    parseActivityEnrichmentArguments([
      "--input",
      "activity.json",
      "--min-window-watch-events",
      "3",
      "--metadata-profile",
      "screening",
    ]),
    {
      input: "activity.json",
      selection: {
        method: "minimum-window-watch-events",
        minimum_window_watch_events: 3,
      },
      metadataProfile: "screening",
    },
  );
});
