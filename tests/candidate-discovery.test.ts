import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { discoverCandidates } from "../src/candidate-discovery.js";
import {
  defaultCandidatePath,
  writeCandidateSnapshot,
} from "../src/candidate-file.js";
import {
  parseAnalysisArguments,
  parseDiscoveryArguments,
} from "../src/cli.js";
import type {
  GHArchiveEvent,
  GHArchiveRecord,
  GHArchiveSource,
} from "../src/gh-archive/client.js";
import type {
  RepositorySnapshot,
  Snapshot,
} from "../src/types/snapshot.js";

type HourResult = readonly GHArchiveEvent[] | Error;

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
    for (const [index, event] of result.entries()) {
      yield { kind: "event", line: index + 1, event };
    }
  }
}

const from = new Date("2026-07-30T00:00:00Z");
const collectedAt = new Date("2026-08-02T00:00:00Z");
let nextWatchEventId = 100_000;

function watchEvent(
  fullName: string,
  createdAt: string,
  action = "started",
  eventId = String(nextWatchEventId++),
): GHArchiveEvent {
  return {
    id: eventId,
    type: "WatchEvent",
    repo: { name: fullName },
    payload: { action },
    created_at: createdAt,
  };
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
    description: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-08-01T00:00:00Z",
    pushed_at: "2026-08-01T00:00:00Z",
    stars: 100,
    forks: 10,
    subscribers: 2,
    open_issues_and_pull_requests: 3,
    primary_language: "TypeScript",
    language_bytes: { TypeScript: 100 },
    language_share: { TypeScript: 1 },
    topics: [],
    default_branch: "main",
    archived: false,
    visibility: "public",
    license_spdx: "MIT",
    readme: null,
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
  coverageErrors: Snapshot["source"]["coverage_errors"] = [],
): Snapshot {
  return {
    schema_version: "snapshot-v1",
    collected_at: collectedAt.toISOString(),
    source: {
      github_api_version: "2026-03-10",
      authenticated: true,
      coverage_complete: coverageErrors.length === 0,
      rate_limit: {
        core: { limit: 5_000, remaining: 4_900, used: 100, reset: 1 },
      },
      coverage_errors: coverageErrors,
    },
    repositories: repositoryNames.map((name, index) =>
      repositorySnapshot(name, index + 1),
    ),
  };
}

test("discovery processes 24 hourly files with bounded request spacing", async () => {
  const archive = new StubArchive({
    "2026-07-30T00:00:00.000Z": [
      watchEvent("owner/alpha", "2026-07-30T00:40:00Z"),
      watchEvent("Owner/Alpha", "2026-07-30T00:10:00Z"),
      {
        type: "PushEvent",
        repo: { name: "owner/not-a-watch" },
        created_at: "2026-07-30T00:20:00Z",
      },
    ],
    "2026-07-30T01:00:00.000Z": [
      watchEvent("owner/beta", "2026-07-30T01:15:00Z"),
      watchEvent("owner/beta", "2026-07-30T01:45:00Z"),
      watchEvent("owner/alpha", "2026-07-30T01:30:00Z"),
    ],
  });
  const waits: number[] = [];
  let enrichedNames: readonly string[] = [];

  const snapshot = await discoverCandidates(
    {
      from,
      hours: 24,
      top: 2,
      requestDelayMs: 250,
      collectedAt,
      sleep: async (milliseconds) => {
        waits.push(milliseconds);
      },
    },
    archive,
    async (repositoryNames) => {
      enrichedNames = repositoryNames;
      return enrichmentSnapshot(repositoryNames);
    },
  );

  assert.equal(archive.requestedHours.length, 24);
  assert.equal(archive.requestedHours[0], "2026-07-30T00:00:00.000Z");
  assert.equal(archive.requestedHours[23], "2026-07-30T23:00:00.000Z");
  assert.deepEqual(waits, Array.from({ length: 23 }, () => 250));
  assert.deepEqual(enrichedNames, ["owner/alpha", "owner/beta"]);
  assert.equal(snapshot.window.to, "2026-07-31T00:00:00.000Z");
  assert.equal(snapshot.source.hours_collected, 24);
  assert.equal(snapshot.source.watch_events_seen, 5);
  assert.equal(snapshot.source.repositories_seen, 2);
  assert.equal(snapshot.source.coverage_complete, true);
  assert.deepEqual(
    snapshot.repositories.map((repository) => ({
      name: repository.full_name,
      watches: repository.watch_events,
      first: repository.first_seen_at,
      last: repository.last_seen_at,
      enriched: repository.github !== null,
    })),
    [
      {
        name: "owner/alpha",
        watches: 3,
        first: "2026-07-30T00:10:00Z",
        last: "2026-07-30T01:30:00Z",
        enriched: true,
      },
      {
        name: "owner/beta",
        watches: 2,
        first: "2026-07-30T01:15:00Z",
        last: "2026-07-30T01:45:00Z",
        enriched: true,
      },
    ],
  );
});

test("discovery preserves candidates when one hourly archive fails", async () => {
  const archive = new StubArchive({
    "2026-07-30T00:00:00.000Z": [
      watchEvent("owner/repository", "2026-07-30T00:10:00Z"),
    ],
    "2026-07-30T01:00:00.000Z": new Error("hour unavailable"),
  });

  const snapshot = await discoverCandidates(
    { from, hours: 2, top: 10, requestDelayMs: 0, collectedAt },
    archive,
    async (repositoryNames) => enrichmentSnapshot(repositoryNames),
  );

  assert.equal(snapshot.source.hours_requested, 2);
  assert.equal(snapshot.source.hours_collected, 1);
  assert.equal(snapshot.source.coverage_complete, false);
  assert.equal(snapshot.repositories[0]?.full_name, "owner/repository");
  assert.deepEqual(snapshot.source.coverage_errors[0], {
    source: "gh-archive",
    target: "2026-07-30T01:00:00.000Z",
    status: null,
    message: "hour unavailable",
  });
});

test("discovery preserves partial events when an hourly stream fails", async () => {
  const archive: GHArchiveSource = {
    async *recordsForHour(): AsyncIterable<GHArchiveRecord> {
      yield {
        kind: "event",
        line: 1,
        event: watchEvent(
          "owner/repository",
          "2026-07-30T00:10:00Z",
        ),
      };
      throw new Error("stream interrupted");
    },
  };

  const snapshot = await discoverCandidates(
    { from, hours: 1, top: 1, requestDelayMs: 0, collectedAt },
    archive,
    async (repositoryNames) => enrichmentSnapshot(repositoryNames),
  );

  assert.equal(snapshot.source.hours_collected, 0);
  assert.equal(snapshot.source.coverage_complete, false);
  assert.equal(snapshot.repositories[0]?.watch_events, 1);
  assert.equal(snapshot.source.coverage_errors[0]?.message, "stream interrupted");
});

test("discovery reports malformed and out-of-window WatchEvents", async () => {
  const archive = new StubArchive({
    "2026-07-30T00:00:00.000Z": [
      watchEvent("owner/valid", "2026-07-30T00:00:00Z"),
      watchEvent("owner/before", "2026-07-29T23:59:59Z"),
      watchEvent("owner/after", "2026-07-30T01:00:00Z"),
      watchEvent("owner/stopped", "2026-07-30T00:20:00Z", "stopped"),
      {
        id: String(nextWatchEventId++),
        type: "WatchEvent",
        repo: { name: "owner/missing-time" },
        payload: { action: "started" },
      },
      {
        type: "PushEvent",
        repo: { name: "owner/ignored" },
        created_at: "2026-07-29T23:00:00Z",
      },
    ],
  });

  const snapshot = await discoverCandidates(
    { from, hours: 1, top: 10, requestDelayMs: 0, collectedAt },
    archive,
    async (repositoryNames) => enrichmentSnapshot(repositoryNames),
  );

  assert.equal(snapshot.source.watch_events_seen, 1);
  assert.equal(snapshot.repositories[0]?.full_name, "owner/valid");
  assert.equal(snapshot.source.coverage_complete, false);
  assert.equal(snapshot.source.coverage_errors.length, 4);
  assert.equal(
    snapshot.source.coverage_errors.filter(({ message }) =>
      message.includes("outside its hourly archive window"),
    ).length,
    2,
  );
});

test("candidate discovery ranks repositories after cross-hour deduplication", async () => {
  const archive = new StubArchive({
    "2026-07-30T00:00:00.000Z": [
      watchEvent("owner/alpha", "2026-07-30T00:05:00Z", "started", "7001"),
      watchEvent("owner/alpha", "2026-07-30T00:06:00Z", "started", "7001"),
      watchEvent("owner/beta", "2026-07-30T00:07:00Z", "started", "7002"),
    ],
    "2026-07-30T01:00:00.000Z": [
      watchEvent("owner/changed", "2026-07-30T00:05:00Z", "started", "7001"),
      watchEvent("owner/beta", "2026-07-30T01:08:00Z", "started", "7003"),
    ],
  });
  let enrichedNames: readonly string[] = [];

  const snapshot = await discoverCandidates(
    { from, hours: 2, top: 2, requestDelayMs: 0, collectedAt },
    archive,
    async (names) => {
      enrichedNames = names;
      return enrichmentSnapshot(names);
    },
  );

  assert.deepEqual(enrichedNames, ["owner/beta", "owner/alpha"]);
  assert.deepEqual(
    snapshot.repositories.map(({ full_name: name, watch_events: count }) => ({
      name,
      count,
    })),
    [
      { name: "owner/beta", count: 2 },
      { name: "owner/alpha", count: 1 },
    ],
  );
  assert.deepEqual(snapshot.source.event_integrity, {
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
  assert.equal(snapshot.source.coverage_complete, true);
});

test("discovery ranks tied candidates by repository name", async () => {
  const archive = new StubArchive({
    "2026-07-30T00:00:00.000Z": [
      watchEvent("owner/zeta", "2026-07-30T00:05:00Z"),
      watchEvent("owner/alpha", "2026-07-30T00:10:00Z"),
    ],
  });
  let enrichedNames: readonly string[] = [];

  const snapshot = await discoverCandidates(
    { from, hours: 1, top: 2, requestDelayMs: 0, collectedAt },
    archive,
    async (repositoryNames) => {
      enrichedNames = repositoryNames;
      return enrichmentSnapshot(repositoryNames);
    },
  );

  assert.deepEqual(enrichedNames, ["owner/alpha", "owner/zeta"]);
  assert.deepEqual(
    snapshot.repositories.map(({ full_name: fullName }) => fullName),
    ["owner/alpha", "owner/zeta"],
  );
});

test("discovery retains a candidate when GitHub enrichment fails", async () => {
  const archive = new StubArchive({
    "2026-07-30T00:00:00.000Z": [
      watchEvent("owner/alpha", "2026-07-30T00:05:00Z"),
      watchEvent("owner/beta", "2026-07-30T00:10:00Z"),
    ],
  });

  const snapshot = await discoverCandidates(
    { from, hours: 1, top: 2, requestDelayMs: 0, collectedAt },
    archive,
    async () =>
      enrichmentSnapshot(["owner/alpha"], [
        {
          endpoint: "/repos/owner/beta",
          status: 404,
          message: "GitHub API returned 404: Not Found",
        },
      ]),
  );

  assert.equal(snapshot.repositories.length, 2);
  assert.ok(snapshot.repositories[0]?.github);
  assert.equal(snapshot.repositories[1]?.github, null);
  assert.equal(snapshot.source.coverage_complete, false);
  assert.equal(
    snapshot.source.coverage_errors.some(
      ({ source, target }) =>
        source === "github" && target === "/repos/owner/beta",
    ),
    true,
  );
});

test("analysis CLI requires a candidate input and bounds README length", () => {
  const defaults = parseAnalysisArguments(["--input", "candidate.json"]);
  assert.deepEqual(defaults, {
    input: "candidate.json",
    maxReadmeCharacters: 12_000,
  });
  assert.equal("modelClassification" in defaults, false);
  assert.throws(() => parseAnalysisArguments([]), /requires --input/);
  assert.throws(
    () =>
      parseAnalysisArguments([
        "--input",
        "candidate.json",
        "--max-readme-characters",
        "0",
      ]),
    /must be between 1 and 100000/,
  );
});

test("analysis CLI supports an explicit bounded model opt-in", () => {
  assert.deepEqual(
    parseAnalysisArguments([
      "--input",
      "candidate.json",
      "--model-command",
      "/usr/local/bin/model-adapter",
      "--model-provider",
      "codex-cli",
      "--model",
      "gpt-5.6-terra",
      "--model-cache",
      "model-cache.json",
      "--model-batch-size",
      "12",
      "--model-invocation-budget",
      "7",
      "--model-max-retries",
      "2",
    ]),
    {
      input: "candidate.json",
      maxReadmeCharacters: 12_000,
      modelClassification: {
        command: "/usr/local/bin/model-adapter",
        provider: "codex-cli",
        model: "gpt-5.6-terra",
        cachePath: "model-cache.json",
        batchSize: 12,
        invocationBudget: 7,
        maxRetries: 2,
      },
    },
  );
});

test("analysis CLI rejects incomplete or out-of-range model options", () => {
  for (const arguments_ of [
    ["--input", "candidate.json", "--model-command", "model-adapter"],
    [
      "--input",
      "candidate.json",
      "--model-provider",
      "codex-cli",
      "--model",
      "gpt-5.6-terra",
    ],
    ["--input", "candidate.json", "--model-cache", "cache.json"],
  ]) {
    assert.throws(
      () => parseAnalysisArguments(arguments_),
      /requires --model-command, --model-provider, and --model/,
    );
  }

  const required = [
    "--input",
    "candidate.json",
    "--model-command",
    "model-adapter",
    "--model-provider",
    "codex-cli",
    "--model",
    "gpt-5.6-terra",
  ];
  assert.throws(
    () =>
      parseAnalysisArguments([
        ...required,
        "--model-batch-size",
        "0",
      ]),
    /--model-batch-size must be between 1 and 100/,
  );
  assert.throws(
    () =>
      parseAnalysisArguments([
        ...required,
        "--model-invocation-budget",
        "-1",
      ]),
    /--model-invocation-budget must be between 0 and 10000/,
  );
  assert.throws(
    () =>
      parseAnalysisArguments([
        ...required,
        "--model-max-retries",
        "3",
      ]),
    /--model-max-retries must be between 0 and 2/,
  );
});

test("candidate snapshot is written as candidate-v1 JSON", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gitropolis-candidate-"));
  const archive = new StubArchive({
    "2026-07-30T00:00:00.000Z": [
      watchEvent("owner/repository", "2026-07-30T00:05:00Z"),
    ],
  });
  const snapshot = await discoverCandidates(
    { from, hours: 1, top: 1, requestDelayMs: 0, collectedAt },
    archive,
    async (repositoryNames) => enrichmentSnapshot(repositoryNames),
  );
  const path = defaultCandidatePath(directory, snapshot);

  await writeCandidateSnapshot(snapshot, path);

  const written = JSON.parse(await readFile(path, "utf8")) as {
    schema_version: string;
    repositories: unknown[];
  };
  assert.equal(written.schema_version, "candidate-v1");
  assert.equal(written.repositories.length, 1);
});

test("discovery CLI defaults to a bounded 24-hour window", () => {
  const options = parseDiscoveryArguments([
    "--from",
    "2026-07-30T00:00:00Z",
  ]);

  assert.equal(options.hours, 24);
  assert.equal(options.top, 10);
  assert.equal(options.requestDelayMs, 1_000);
  assert.equal(options.requestTimeoutMs, 60_000);
});

test("discovery CLI rejects a timezone-less timestamp", () => {
  assert.throws(
    () =>
      parseDiscoveryArguments([
        "--from",
        "2026-07-30T00:00:00",
      ]),
    /ending in Z/,
  );
});

test("discovery CLI rejects a timestamp not aligned to an hour", () => {
  assert.throws(
    () =>
      parseDiscoveryArguments([
        "--from",
        "2026-07-30T00:30:00Z",
      ]),
    /aligned to an hour/,
  );
});

test("discovery rejects a range longer than 24 hours", async () => {
  await assert.rejects(
    () =>
      discoverCandidates(
        { from, hours: 25, top: 1, requestDelayMs: 0, collectedAt },
        new StubArchive({}),
        async (repositoryNames) => enrichmentSnapshot(repositoryNames),
      ),
    /between 1 and 24/,
  );
});

test("discovery rejects an excessive request delay", async () => {
  await assert.rejects(
    () =>
      discoverCandidates(
        { from, hours: 1, top: 1, requestDelayMs: 60_001, collectedAt },
        new StubArchive({}),
        async (repositoryNames) => enrichmentSnapshot(repositoryNames),
      ),
    /between 0 and 60000/,
  );
});
