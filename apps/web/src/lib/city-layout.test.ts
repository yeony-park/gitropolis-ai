import assert from "node:assert/strict";
import test from "node:test";

import type { CityRepository, CitySnapshot } from "./city-schema";
import {
  buildCityLayout,
  calculateBuildingDimensions,
  calculateFacadeActivity,
} from "./city-layout";

const repository = (overrides: Partial<CityRepository> = {}): CityRepository => ({
  repository_id: 10,
  full_name: "owner/repository",
  url: "https://github.com/owner/repository",
  district_id: "agents",
  community_id: "mcp",
  ai_relevance: 0.9,
  radar_status: "candidate",
  availability_status: "available",
  breakout_status: null,
  watch_events_window: 5,
  weekly_watch_events: 5,
  max_daily_watch_events: 5,
  stars: 100,
  forks: 10,
  commits_30d: 4,
  contributors_count: 3,
  keywords: ["mcp"],
  flags: [],
  global_rank: 1,
  community_rank: 1,
  ...overrides,
});

const snapshot = (repositories: CityRepository[]): CitySnapshot => ({
  schema_version: "city-v1",
  generated_at: "2026-08-10T00:00:00.000Z",
  period: "weekly",
  window: {
    from: "2026-07-27T00:00:00.000Z",
    to: "2026-08-03T00:00:00.000Z",
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
    repositories_considered: repositories.length,
    ai_related_repositories: repositories.length,
    included_repositories: repositories.length,
    excluded_missing_metadata: 0,
  },
  districts: [{ id: "agents", label: "AGENTS", ko: "에이전트", color: "#7c5cff" }],
  communities: [
    {
      id: "mcp",
      label: "MCP",
      district_id: "agents",
      status: "unknown",
      repository_count: repositories.length,
      natural_building_count: repositories.length,
    },
  ],
  repositories,
  edges: [],
  community_edges: [],
  display: { top_n_options: [5, 10, 25, 50, 100], mvp_visible_budget: 100 },
});

test("layout remains deterministic when repository input order changes", () => {
  const first = repository({ repository_id: 10, global_rank: 2 });
  const second = repository({
    repository_id: 20,
    full_name: "owner/second",
    url: "https://github.com/owner/second",
    global_rank: 1,
  });

  assert.deepEqual(
    buildCityLayout(snapshot([first, second])),
    buildCityLayout(snapshot([second, first])),
  );
});

test("building dimensions grow with activity and repository scale", () => {
  const small = calculateBuildingDimensions(repository());
  const large = calculateBuildingDimensions(
    repository({ watch_events_window: 100, stars: 100_000, forks: 10_000 }),
  );

  assert.ok(large.height > small.height);
  assert.ok(large.width > small.width);
  assert.ok(large.depth > small.depth);
});

test("places 100 buildings inside their district without collisions", () => {
  const repositories = Array.from({ length: 100 }, (_, index) => repository({
    repository_id: index + 1,
    full_name: `owner/repository-${index + 1}`,
    url: `https://github.com/owner/repository-${index + 1}`,
    global_rank: index + 1,
    community_rank: index + 1,
    stars: 10 ** (index % 6),
    forks: 10 ** (index % 5),
  }));
  const layout = buildCityLayout(snapshot(repositories));
  const district = layout.districts[0];

  assert.equal(layout.repositories.length, 100);
  assert.ok(district);
  for (const building of layout.repositories) {
    assert.ok(Number.isFinite(building.x));
    assert.ok(Number.isFinite(building.y));
    assert.ok(Number.isFinite(building.z));
    assert.ok(
      Math.abs(building.x - district.x) + building.width / 2 <= district.width / 2,
    );
    assert.ok(
      Math.abs(building.z - district.z) + building.depth / 2 <= district.depth / 2,
    );
  }

  for (let left = 0; left < layout.repositories.length; left += 1) {
    for (let right = left + 1; right < layout.repositories.length; right += 1) {
      const first = layout.repositories[left];
      const second = layout.repositories[right];
      assert.ok(first && second);
      const overlapsX = Math.abs(first.x - second.x) < (first.width + second.width) / 2;
      const overlapsZ = Math.abs(first.z - second.z) < (first.depth + second.depth) / 2;
      assert.equal(overlapsX && overlapsZ, false);
    }
  }
});

test("keeps 100 buildings inside non-overlapping dynamic districts", () => {
  const districtIds = [
    "models",
    "agents",
    "knowledge-data",
    "ai-development",
    "multimodal",
    "infrastructure",
    "embodied-ai",
    "frontier",
  ];
  const repositories = Array.from({ length: 100 }, (_, index) => {
    const districtId = districtIds[index % districtIds.length] ?? "frontier";
    return repository({
      repository_id: index + 1,
      full_name: `owner/multi-${index + 1}`,
      url: `https://github.com/owner/multi-${index + 1}`,
      district_id: districtId,
      community_id: `${districtId}-community`,
      global_rank: index + 1,
      community_rank: Math.floor(index / districtIds.length) + 1,
    });
  });
  const input = snapshot(repositories);
  input.districts = districtIds.map((id) => ({
    id,
    label: id.toUpperCase(),
    ko: id,
    color: "#7c5cff",
  }));
  input.communities = districtIds.map((id) => ({
    id: `${id}-community`,
    label: id,
    district_id: id,
    status: "unknown",
    repository_count: repositories.filter(({ district_id: value }) => value === id).length,
    natural_building_count: repositories.filter(({ district_id: value }) => value === id).length,
  }));

  const layout = buildCityLayout(input);
  assert.equal(layout.repositories.length, 100);
  for (const building of layout.repositories) {
    const district = layout.districts.find(
      ({ districtId }) => districtId === building.repository.district_id,
    );
    assert.ok(district);
    assert.ok(
      Math.abs(building.x - district.x) + building.width / 2 <= district.width / 2,
    );
    assert.ok(
      Math.abs(building.z - district.z) + building.depth / 2 <= district.depth / 2,
    );
  }
  for (let left = 0; left < layout.districts.length; left += 1) {
    for (let right = left + 1; right < layout.districts.length; right += 1) {
      const first = layout.districts[left];
      const second = layout.districts[right];
      assert.ok(first && second);
      const overlapsX = Math.abs(first.x - second.x) < (first.width + second.width) / 2;
      const overlapsZ = Math.abs(first.z - second.z) < (first.depth + second.depth) / 2;
      assert.equal(overlapsX && overlapsZ, false);
    }
  }
});

test("distinguishes unavailable, zero, and active commit facades", () => {
  const unavailable = calculateFacadeActivity(null, 100);
  const zero = calculateFacadeActivity(0, 100);
  const active = calculateFacadeActivity(100, 100);

  assert.equal(unavailable.available, false);
  assert.equal(unavailable.label, "Activity data unavailable");
  assert.equal(zero.available, true);
  assert.equal(zero.label, "0 commits in latest 30d");
  assert.ok(active.densityLevel > zero.densityLevel);
  assert.ok(active.emissiveIntensity > zero.emissiveIntensity);
});
