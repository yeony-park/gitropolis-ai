import assert from "node:assert/strict";
import test from "node:test";

import { citySnapshotSchema } from "./city-schema";

function legacyCitySnapshot(): unknown {
  return {
    schema_version: "city-v1",
    generated_at: "2026-08-10T00:00:00.000Z",
    period: "weekly",
    window: {
      from: "2026-08-03T00:00:00.000Z",
      to: "2026-08-10T00:00:00.000Z",
    },
    methodology: {
      builder: "city-builder-v1",
      district_assignment: "city-district-rules-v1",
      community_assignment: "primary-keyword-v1",
      ai_relevance: "ai-relevance-rules-v1",
      repository_lifecycle: "repository-lifecycle-rules-v1",
    },
    source: {
      activity_schema_version: "activity-series-v1",
      analysis_schema_version: "topic-analysis-v1",
      lifecycle_schema_version: "repository-lifecycle-v1",
      activity_coverage_complete: true,
      analysis_coverage_complete: true,
      lifecycle_coverage_complete: true,
      coverage_complete: true,
      repositories_considered: 1,
      ai_related_repositories: 1,
      included_repositories: 1,
      excluded_missing_metadata: 0,
    },
    districts: [
      { id: "agents", label: "AGENTS", ko: "에이전트", color: "#7c5cff" },
    ],
    communities: [
      {
        id: "mcp",
        label: "MCP",
        district_id: "agents",
        status: "unknown",
        repository_count: 1,
        natural_building_count: 1,
      },
    ],
    repositories: [
      {
        repository_id: 1,
        full_name: "owner/repository",
        url: "https://github.com/owner/repository",
        district_id: "agents",
        community_id: "mcp",
        ai_relevance: 0.9,
        radar_status: null,
        availability_status: "available",
        breakout_status: null,
        watch_events_window: 8,
        weekly_watch_events: null,
        max_daily_watch_events: null,
        stars: 10,
        forks: 1,
        commits_30d: null,
        contributors_count: null,
        keywords: ["mcp"],
        flags: [],
        global_rank: 1,
        community_rank: 1,
      },
    ],
    edges: [],
    community_edges: [],
    display: {
      top_n_options: [5, 10, 25, 50, 100],
      mvp_visible_budget: 100,
    },
  };
}

test("accepts city-v1 snapshots created before additive explanation fields", () => {
  const parsed = citySnapshotSchema.parse(legacyCitySnapshot());

  assert.equal(parsed.repositories[0]?.description, undefined);
  assert.equal(parsed.repositories[0]?.detection_explanation, undefined);
  assert.equal(parsed.source.archive_coverage_complete, undefined);
});

test("distinguishes null descriptions and accepts observed detection signals", () => {
  const input = legacyCitySnapshot() as Record<string, unknown>;
  const repositories = input.repositories as Array<Record<string, unknown>>;
  repositories[0] = {
    ...repositories[0],
    description: null,
    detection_explanation: {
      methodology_version: "repository-detection-explanation-v1",
      label: "Why Gitropolis noticed it",
      summary: "Observed detection signals only.",
      signals: {
        window_watch_events: 8,
        max_daily_watch_events: 8,
        active_days: 2,
        selection_rule: "at least 8 WatchEvents in one UTC day",
        archive_coverage_complete: true,
      },
    },
  };

  const parsed = citySnapshotSchema.parse(input);
  assert.equal(parsed.repositories[0]?.description, null);
  assert.equal(
    parsed.repositories[0]?.detection_explanation?.signals.active_days,
    2,
  );
});
