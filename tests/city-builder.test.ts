import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { buildCitySnapshot } from "../src/city-builder.js";
import {
  defaultCityPath,
  readCitySnapshot,
  writeCitySnapshot,
} from "../src/city-file.js";
import { parseCityArguments } from "../src/cli.js";
import type { ActivitySeriesSnapshot } from "../src/types/activity-series.js";
import type { RepositoryLifecycleSnapshot } from "../src/types/repository-lifecycle.js";
import type { RepositorySnapshot } from "../src/types/snapshot.js";
import type { TopicAnalysisSnapshot } from "../src/types/topic-analysis.js";

const FROM = "2026-07-27T00:00:00.000Z";
const TO = "2026-08-03T00:00:00.000Z";

function currentRepository(
  id: number,
  fullName: string,
  description: string | null = null,
): RepositorySnapshot {
  return {
    id,
    node_id: `node-${id}`,
    full_name: fullName,
    html_url: `https://github.com/${fullName}`,
    description,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: TO,
    pushed_at: TO,
    stars: id * 100,
    forks: id * 10,
    subscribers: 0,
    open_issues_and_pull_requests: 0,
    primary_language: "TypeScript",
    language_bytes: null,
    language_share: null,
    topics: [],
    default_branch: "main",
    archived: false,
    visibility: "public",
    license_spdx: "MIT",
    readme: null,
    commits_30d: id,
    contributors_count: id + 1,
    delta_stars_1d: null,
    delta_stars_7d: null,
    delta_stars_30d: null,
    star_velocity_7d: null,
    star_acceleration: null,
  };
}

function activityRepository(
  id: number,
  fullName: string,
  watchEvents: number,
  hasMetadata = true,
): ActivitySeriesSnapshot["repositories"][number] {
  return {
    full_name: fullName,
    watch_events_observed_total: watchEvents,
    observed_watch_velocity_per_day: watchEvents / 7,
    first_seen_at: FROM,
    last_seen_at: "2026-08-02T00:00:00Z",
    daily: Array.from({ length: 7 }, (_, day) => ({
      date: new Date(Date.UTC(2026, 6, 27 + day)).toISOString().slice(0, 10),
      watch_events_observed: day < Math.min(watchEvents, 7) ? Math.max(1, watchEvents - day) : 0,
      coverage_complete: true,
    })),
    metadata_selected: true,
    current: hasMetadata ? currentRepository(id, fullName) : null,
  };
}

function activitySnapshot(
  repositories: ActivitySeriesSnapshot["repositories"],
): ActivitySeriesSnapshot {
  return {
    schema_version: "activity-series-v1",
    window: { from: FROM, to: TO, days: 7 },
    source: {
      type: "gh-archive+github",
      archive_coverage_complete: true,
      metadata_coverage_complete: true,
      coverage_complete: true,
      hours_requested: 168,
      hours_collected: 168,
      watch_events_observed: repositories.reduce(
        (total, repository) => total + repository.watch_events_observed_total,
        0,
      ),
      repositories_seen: repositories.length,
      github_authenticated: true,
      github_rate_limit: null,
      metadata_selection: {
        method: "minimum-window-watch-events",
        minimum_window_watch_events: 3,
        metadata_profile: "full",
        selected: repositories.length,
        collected: repositories.filter(({ current }) => current !== null).length,
        collected_at: "2026-08-03T01:00:00.000Z",
      },
      coverage_errors: [],
    },
    days: [],
    repositories,
  };
}

function analysisRepository(
  id: number,
  fullName: string,
  keyword: string,
  decision: "ai-related" | "not-ai" = "ai-related",
): TopicAnalysisSnapshot["repositories"][number] {
  return {
    repository_id: id,
    full_name: fullName,
    ai_relevance: {
      score: decision === "ai-related" ? 0.8 : 0.1,
      decision,
      evidence: [],
    },
    community_status: decision === "ai-related" ? "unknown" : null,
    observations: [
      {
        observed_at: "2026-08-03T02:00:00.000Z",
        repository_id: id,
        keyword_id: keyword,
        source: "topics",
        occurrence_count: 1,
        confidence: 0.95,
      },
    ],
  };
}

function analysisSnapshot(
  repositories: TopicAnalysisSnapshot["repositories"],
  censusCounts: Readonly<Record<string, number>>,
): TopicAnalysisSnapshot {
  return {
    schema_version: "topic-analysis-v1",
    observed_at: "2026-08-03T02:00:00.000Z",
    candidate_window: { from: FROM, to: TO },
    methodology_version: "ai-relevance-rules-v1",
    source: {
      input_schema_version: "activity-series-v1",
      candidate_schema_version: "candidate-v1",
      classifier_kind: "rules",
      candidate_coverage_complete: true,
      candidate_coverage_errors: [],
      github_authenticated: true,
      coverage_complete: true,
      coverage_errors: [],
    },
    keyword_census: {
      repositories_analyzed: repositories.length,
      repositories_with_observations: repositories.length,
      observation_records: repositories.length,
      unique_keywords: Object.keys(censusCounts).length,
      unique_classifier_evidence_keywords: 0,
      keywords: Object.entries(censusCounts).map(
        ([keyword, repositoryCount]) => ({
          keyword_id: keyword,
          repository_count: repositoryCount,
          occurrence_count: repositoryCount,
          sources: ["topics"],
        }),
      ),
    },
    repositories,
  };
}

function lifecycleSnapshot(
  repositories: RepositoryLifecycleSnapshot["repositories"],
): RepositoryLifecycleSnapshot {
  return {
    schema_version: "repository-lifecycle-v1",
    generated_at: "2026-08-03T03:00:00.000Z",
    window: { from: "2026-07-20T00:00:00.000Z", to: TO },
    methodology: {
      methodology_version: "repository-lifecycle-rules-v1",
      main_daily_watch_events: 5,
      scout_weekly_watch_events: 3,
      fast_breakout_weekly_watch_events: 10,
      active_after_qualified_weeks: 2,
      inactive_after_below_scout_weeks: 2,
    },
    source: {
      input_schema_version: "activity-series-v1",
      input_snapshots: [],
      coverage_complete: true,
      integrity_verification: "verified",
    },
    weeks: [],
    repositories,
    events: [],
  };
}

function lifecycleRepository(
  id: number,
  fullName: string,
): RepositoryLifecycleSnapshot["repositories"][number] {
  return {
    repository_id: id,
    full_name: fullName,
    aliases: [],
    availability_status: "available",
    radar_status: "active",
    first_observed_at: FROM,
    last_observed_at: TO,
    first_detected_at: FROM,
    state_changed_at: FROM,
    last_qualified_week: FROM,
    consecutive_qualified_weeks: 2,
    consecutive_below_scout_weeks: 0,
    fast_breakout: true,
    breakout_status: "confirmed",
    breakout_detected_at: FROM,
    weeks: [
      {
        from: FROM,
        to: TO,
        calendar_complete: true,
        hour_coverage_complete: true,
        record_coverage_complete: true,
        decision_coverage: "complete",
        integrity_verification: "verified",
        weekly_watch_events: 12,
        max_daily_watch_events: 6,
        active_days: 4,
        main_radar: true,
        emerging_scout: true,
        fast_breakout: true,
        radar_status: "active",
        breakout_status: "confirmed",
        consecutive_qualified_weeks: 2,
        consecutive_below_scout_weeks: 0,
      },
    ],
  };
}

test("builds renderer data with stable-ID rename joins and frontier fallback", () => {
  const activity = activitySnapshot([
    activityRepository(1, "new-owner/graph-repo", 12),
    activityRepository(2, "owner/unknown-repo", 5),
    activityRepository(3, "owner/not-ai", 20),
    activityRepository(4, "owner/missing", 7, false),
  ]);
  const analysis = analysisSnapshot(
    [
      analysisRepository(1, "old-owner/graph-repo", "graph-rag"),
      analysisRepository(2, "owner/unknown-repo", "quantum-workbench"),
      analysisRepository(3, "owner/not-ai", "agent-tools", "not-ai"),
      analysisRepository(4, "owner/missing", "ai-agent"),
    ],
    { "graph-rag": 5, "quantum-workbench": 1, "agent-tools": 1, "ai-agent": 1 },
  );
  const lifecycle = lifecycleSnapshot([
    lifecycleRepository(1, "old-owner/graph-repo"),
  ]);

  const city = buildCitySnapshot({ activity, analysis, lifecycle });
  assert.deepEqual(
    buildCitySnapshot({ activity, analysis, lifecycle }),
    city,
  );

  assert.equal(city.generated_at, "2026-08-03T03:00:00.000Z");
  assert.equal(city.districts.length, 8);
  assert.equal(city.repositories.length, 2);
  assert.equal(city.source.ai_related_repositories, 3);
  assert.equal(city.source.excluded_missing_metadata, 1);
  assert.equal(city.source.archive_coverage_complete, true);
  assert.equal(city.source.metadata_coverage_complete, true);
  assert.equal(city.source.metadata_collected_at, "2026-08-03T01:00:00.000Z");
  assert.equal(
    city.source.metadata_selection_rule,
    "at least 3 WatchEvents across the full window",
  );
  assert.deepEqual(city.display.top_n_options, [5, 10, 25, 50, 100]);

  const renamed = city.repositories[0];
  assert.equal(renamed?.full_name, "new-owner/graph-repo");
  assert.equal(renamed?.district_id, "knowledge-data");
  assert.equal(renamed?.community_id, "graph-rag");
  assert.equal(renamed?.radar_status, "active");
  assert.equal(renamed?.weekly_watch_events, 12);
  assert.deepEqual(renamed?.flags, ["breakout"]);
  assert.equal(
    renamed?.detection_explanation?.label,
    "Why Gitropolis noticed it",
  );
  assert.equal(renamed?.detection_explanation?.signals.window_watch_events, 12);
  assert.equal(renamed?.detection_explanation?.signals.max_daily_watch_events, 12);
  assert.equal(renamed?.detection_explanation?.signals.active_days, 7);
  assert.doesNotMatch(renamed?.detection_explanation?.summary ?? "", /became popular/i);

  const frontier = city.repositories[1];
  assert.equal(frontier?.district_id, "frontier");
  assert.equal(frontier?.community_id, "quantum-workbench");
  assert.deepEqual(frontier?.flags, ["frontier"]);
  assert.equal(
    city.communities.find(({ id }) => id === "graph-rag")?.status,
    "unknown",
  );
});

test("copies current GitHub descriptions without inventing a fallback value", () => {
  const withDescription = activityRepository(1, "owner/described", 8);
  withDescription.current = currentRepository(
    1,
    "owner/described",
    "A current GitHub repository description.",
  );
  const withoutDescription = activityRepository(2, "owner/undescribed", 7);

  const city = buildCitySnapshot({
    activity: activitySnapshot([withDescription, withoutDescription]),
    analysis: analysisSnapshot(
      [
        analysisRepository(1, "owner/described", "agent-tools"),
        analysisRepository(2, "owner/undescribed", "agent-tools"),
      ],
      { "agent-tools": 2 },
    ),
    lifecycle: lifecycleSnapshot([]),
  });

  assert.equal(
    city.repositories.find(({ repository_id }) => repository_id === 1)?.description,
    "A current GitHub repository description.",
  );
  assert.equal(
    city.repositories.find(({ repository_id }) => repository_id === 2)?.description,
    null,
  );
});

test("does not use a mutable name fallback when stable IDs disagree", () => {
  const activity = activitySnapshot([
    activityRepository(2, "owner/reused-name", 5),
  ]);
  const analysis = analysisSnapshot(
    [analysisRepository(1, "owner/reused-name", "agent-tools")],
    { "agent-tools": 1 },
  );

  const city = buildCitySnapshot({
    activity,
    analysis,
    lifecycle: lifecycleSnapshot([]),
  });

  assert.equal(city.repositories.length, 0);
  assert.equal(city.source.excluded_missing_metadata, 1);
});

test("primary community takes precedence over secondary district signals", () => {
  const activity = activitySnapshot([
    activityRepository(1, "owner/mcp-repository", 5),
  ]);
  const analyzed = analysisRepository(1, "owner/mcp-repository", "mcp");
  analyzed.observations.push({
    observed_at: "2026-08-03T02:00:00.000Z",
    repository_id: 1,
    keyword_id: "multimodal",
    source: "readme",
    occurrence_count: 1,
    confidence: 0.65,
  });

  const city = buildCitySnapshot({
    activity,
    analysis: analysisSnapshot([analyzed], { mcp: 1, multimodal: 1 }),
    lifecycle: lifecycleSnapshot([]),
  });

  assert.equal(city.repositories[0]?.community_id, "mcp");
  assert.equal(city.repositories[0]?.district_id, "agents");
});

test("does not truncate eligible repositories to the renderer display budget", () => {
  const activityRepositories = [];
  const analysisRepositories = [];
  for (let id = 1; id <= 101; id += 1) {
    const fullName = `owner/repository-${id}`;
    activityRepositories.push(activityRepository(id, fullName, id));
    analysisRepositories.push(analysisRepository(id, fullName, "agent-tools"));
  }
  const city = buildCitySnapshot({
    activity: activitySnapshot(activityRepositories),
    analysis: analysisSnapshot(analysisRepositories, { "agent-tools": 101 }),
    lifecycle: lifecycleSnapshot([]),
  });

  assert.equal(city.repositories.length, 101);
  assert.equal(city.display.mvp_visible_budget, 100);
  assert.equal(city.repositories[0]?.full_name, "owner/repository-101");
  assert.equal(city.repositories.at(-1)?.global_rank, 101);
  assert.equal(city.communities[0]?.status, "emerging");
});

test("rejects unrelated source windows and candidate-only analysis", () => {
  const activity = activitySnapshot([activityRepository(1, "owner/repo", 5)]);
  const analysis = analysisSnapshot(
    [analysisRepository(1, "owner/repo", "agent-tools")],
    { "agent-tools": 1 },
  );
  const lifecycle = lifecycleSnapshot([]);

  const mismatched = structuredClone(analysis);
  mismatched.candidate_window.to = "2026-08-04T00:00:00.000Z";
  assert.throws(
    () => buildCitySnapshot({ activity, analysis: mismatched, lifecycle }),
    /windows must match/i,
  );

  const candidateOnly = structuredClone(analysis);
  candidateOnly.source.input_schema_version = "candidate-v1";
  assert.throws(
    () => buildCitySnapshot({ activity, analysis: candidateOnly, lifecycle }),
    /derived from activity-series-v1/i,
  );
});

test("city-v1 file round-trips and uses the default project path", async () => {
  const city = buildCitySnapshot({
    activity: activitySnapshot([activityRepository(1, "owner/repo", 5)]),
    analysis: analysisSnapshot(
      [analysisRepository(1, "owner/repo", "agent-tools")],
      { "agent-tools": 1 },
    ),
    lifecycle: lifecycleSnapshot([]),
  });
  const directory = await mkdtemp(join(tmpdir(), "gitropolis-city-"));
  const output = defaultCityPath(directory);

  assert.equal(
    await writeCitySnapshot(city, output),
    join(directory, ".gitropolis", "city", "city.json"),
  );
  assert.deepEqual(await readCitySnapshot(output), city);
});

test("build-city CLI requires all three input snapshots", () => {
  assert.deepEqual(
    parseCityArguments([
      "--activity",
      "activity.json",
      "--analysis",
      "analysis.json",
      "--lifecycle",
      "lifecycle.json",
      "--output",
      "city.json",
    ]),
    {
      activity: "activity.json",
      analysis: "analysis.json",
      lifecycle: "lifecycle.json",
      output: "city.json",
    },
  );
  assert.throws(
    () => parseCityArguments(["--activity", "activity.json"]),
    /requires --activity, --analysis, and --lifecycle/i,
  );
});
