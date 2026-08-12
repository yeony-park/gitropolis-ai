import type { ActivitySeriesSnapshot } from "./types/activity-series.js";
import type {
  CityCommunity,
  CityDistrict,
  CityDistrictId,
  CityDetectionExplanation,
  CityRepository,
  CityRepositoryFlag,
  CitySnapshot,
} from "./types/city.js";
import type {
  RepositoryLifecycleRepository,
  RepositoryLifecycleSnapshot,
  RepositoryLifecycleWeek,
} from "./types/repository-lifecycle.js";
import type {
  KeywordObservation,
  TopicAnalysisRepository,
  TopicAnalysisSnapshot,
} from "./types/topic-analysis.js";

export const CITY_DISTRICTS: readonly CityDistrict[] = [
  { id: "models", label: "MODELS", ko: "모델", color: "#ff5c8a" },
  { id: "agents", label: "AGENTS", ko: "에이전트", color: "#7c5cff" },
  {
    id: "knowledge-data",
    label: "KNOWLEDGE & DATA",
    ko: "지식·데이터",
    color: "#3d9bff",
  },
  {
    id: "ai-development",
    label: "AI DEVELOPMENT",
    ko: "AI 개발",
    color: "#22d3a7",
  },
  {
    id: "multimodal",
    label: "MULTIMODAL",
    ko: "멀티모달",
    color: "#f59e42",
  },
  {
    id: "infrastructure",
    label: "INFRASTRUCTURE",
    ko: "인프라",
    color: "#19c8ff",
  },
  {
    id: "embodied-ai",
    label: "EMBODIED AI",
    ko: "피지컬 AI",
    color: "#a3e635",
  },
  {
    id: "frontier",
    label: "FRONTIER",
    ko: "프론티어",
    color: "#94a3b8",
  },
] as const;

const DISTRICT_ORDER = new Map(
  CITY_DISTRICTS.map((district, index) => [district.id, index]),
);

const BROAD_COMMUNITY_KEYWORDS = new Set([
  "ai",
  "artificial-intelligence",
  "deep-learning",
  "generative-ai",
  "large-language-model",
  "large-language-models",
  "llm",
  "llms",
  "machine-learning",
]);

const DISTRICT_KEYWORDS: readonly [
  CityDistrictId,
  readonly string[],
][] = [
  ["embodied-ai", ["robot", "robotic", "robotics", "embodied", "autonomous-driving"]],
  ["multimodal", ["multimodal", "vision", "image", "video", "audio", "speech", "diffusion"]],
  ["knowledge-data", ["rag", "retrieval", "knowledge", "graph", "vector", "embedding", "database"]],
  ["agents", ["agent", "agents", "agentic", "mcp", "tool-use", "browser-use", "automation"]],
  ["ai-development", ["code", "coding", "codex", "developer", "copilot", "code-generation"]],
  ["infrastructure", ["inference", "serving", "mlops", "gpu", "cuda", "distributed", "runtime", "deployment"]],
  ["models", ["model", "models", "transformer", "transformers", "llm", "llms", "fine-tuning", "training"]],
];

interface CityBuilderInputs {
  activity: ActivitySeriesSnapshot;
  analysis: TopicAnalysisSnapshot;
  lifecycle: RepositoryLifecycleSnapshot;
}

interface PendingRepository {
  value: Omit<CityRepository, "global_rank" | "community_rank">;
}

export function buildCitySnapshot(inputs: CityBuilderInputs): CitySnapshot {
  validateInputs(inputs);
  const activityById = new Map<number, ActivitySeriesSnapshot["repositories"][number]>();
  const activityByName = new Map<string, ActivitySeriesSnapshot["repositories"][number]>();
  for (const repository of inputs.activity.repositories) {
    activityByName.set(repository.full_name.toLowerCase(), repository);
    if (repository.current) {
      if (activityById.has(repository.current.id)) {
        throw new Error(`Duplicate activity repository ID: ${repository.current.id}`);
      }
      activityById.set(repository.current.id, repository);
    }
  }

  const lifecycleById = new Map<number, RepositoryLifecycleRepository>();
  const lifecycleByName = new Map<string, RepositoryLifecycleRepository>();
  for (const repository of inputs.lifecycle.repositories) {
    if (repository.repository_id !== null) {
      if (lifecycleById.has(repository.repository_id)) {
        throw new Error(`Duplicate lifecycle repository ID: ${repository.repository_id}`);
      }
      lifecycleById.set(repository.repository_id, repository);
    } else {
      lifecycleByName.set(repository.full_name.toLowerCase(), repository);
    }
  }

  const related = inputs.analysis.repositories.filter(
    (repository) => repository.ai_relevance.decision === "ai-related",
  );
  const relatedKeywordCounts = countRelatedKeywordRepositories(related);
  const pending: PendingRepository[] = [];
  let excludedMissingMetadata = 0;

  for (const analyzed of related) {
    const activity = findActivityRepository(
      analyzed,
      activityById,
      activityByName,
    );
    if (!activity?.current) {
      excludedMissingMetadata += 1;
      continue;
    }
    const current = activity.current;
    const lifecycle =
      lifecycleById.get(current.id) ??
      lifecycleByName.get(activity.full_name.toLowerCase()) ??
      lifecycleByName.get(analyzed.full_name.toLowerCase()) ??
      null;
    const keywords = uniqueKeywords(analyzed.observations);
    const communityId = selectPrimaryCommunity(
      analyzed.observations,
      relatedKeywordCounts,
    );
    const districtId = assignDistrict([communityId]);
    const latestWeek = lifecycle
      ? latestWeekInWindow(lifecycle.weeks, inputs.activity.window.to)
      : null;
    const flags = buildFlags(districtId, lifecycle);

    pending.push({
      value: {
        repository_id: current.id,
        full_name: current.full_name,
        url: current.html_url,
        description: current.description,
        detection_explanation: buildDetectionExplanation(
          activity,
          inputs.activity,
        ),
        district_id: districtId,
        community_id: communityId,
        ai_relevance: analyzed.ai_relevance.score,
        radar_status: lifecycle?.radar_status ?? null,
        availability_status: lifecycle?.availability_status ?? "available",
        breakout_status: lifecycle?.breakout_status ?? null,
        watch_events_window: activity.watch_events_observed_total,
        weekly_watch_events: latestWeek?.weekly_watch_events ?? null,
        max_daily_watch_events: latestWeek?.max_daily_watch_events ?? null,
        stars: current.stars,
        forks: current.forks,
        commits_30d: current.commits_30d,
        contributors_count: current.contributors_count,
        keywords,
        flags,
      },
    });
  }

  pending.sort(compareRepositories);
  const communityRanks = new Map<string, number>();
  const repositories = pending.map(({ value }, index): CityRepository => {
    const communityRank = (communityRanks.get(value.community_id) ?? 0) + 1;
    communityRanks.set(value.community_id, communityRank);
    return {
      ...value,
      global_rank: index + 1,
      community_rank: communityRank,
    };
  });

  return {
    schema_version: "city-v1",
    generated_at: latestTimestamp([
      inputs.activity.window.to,
      inputs.analysis.observed_at,
      inputs.lifecycle.generated_at,
      inputs.activity.source.metadata_selection?.collected_at ?? null,
    ]),
    period: "weekly",
    window: {
      from: inputs.activity.window.from,
      to: inputs.activity.window.to,
    },
    methodology: {
      builder: "city-builder-v1",
      district_assignment: "city-district-rules-v1",
      community_assignment: "primary-keyword-v1",
      ai_relevance: inputs.analysis.methodology_version,
      repository_lifecycle: inputs.lifecycle.methodology.methodology_version,
    },
    source: {
      activity_schema_version: inputs.activity.schema_version,
      analysis_schema_version: inputs.analysis.schema_version,
      lifecycle_schema_version: inputs.lifecycle.schema_version,
      activity_coverage_complete: inputs.activity.source.coverage_complete,
      analysis_coverage_complete: inputs.analysis.source.coverage_complete,
      lifecycle_coverage_complete: inputs.lifecycle.source.coverage_complete,
      coverage_complete:
        inputs.activity.source.coverage_complete &&
        inputs.analysis.source.coverage_complete &&
        inputs.lifecycle.source.coverage_complete,
      archive_coverage_complete:
        inputs.activity.source.archive_coverage_complete,
      metadata_coverage_complete:
        inputs.activity.source.metadata_coverage_complete,
      repositories_considered: inputs.analysis.repositories.length,
      ai_related_repositories: related.length,
      included_repositories: repositories.length,
      excluded_missing_metadata: excludedMissingMetadata,
      metadata_collected_at:
        inputs.activity.source.metadata_selection?.collected_at ?? null,
      metadata_selection_rule: inputs.activity.source.metadata_selection
        ? formatMetadataSelectionRule(inputs.activity.source.metadata_selection)
        : null,
    },
    districts: CITY_DISTRICTS.map((district) => ({ ...district })),
    communities: buildCommunities(repositories, relatedKeywordCounts),
    repositories,
    edges: [],
    community_edges: [],
    display: {
      top_n_options: [5, 10, 25, 50, 100],
      mvp_visible_budget: 100,
    },
  };
}

function buildDetectionExplanation(
  repository: ActivitySeriesSnapshot["repositories"][number],
  snapshot: ActivitySeriesSnapshot,
): CityDetectionExplanation {
  const maxDailyWatchEvents = Math.max(
    0,
    ...repository.daily.map(({ watch_events_observed: value }) => value),
  );
  const activeDays = repository.daily.filter(
    ({ watch_events_observed: value }) => value > 0,
  ).length;
  const selectionRule = formatMetadataSelectionRule(
    snapshot.source.metadata_selection,
  );
  return {
    methodology_version: "repository-detection-explanation-v1",
    label: "Why Gitropolis noticed it",
    summary:
      `Gitropolis noticed this repository after observing ` +
      `${repository.watch_events_observed_total} WatchEvents from ${snapshot.window.from} inclusive ` +
      `to ${snapshot.window.to} exclusive, ` +
      `with a daily peak of ${maxDailyWatchEvents} across ${activeDays} active days. ` +
      `It met the metadata selection rule: ${selectionRule}.`,
    signals: {
      window_watch_events: repository.watch_events_observed_total,
      max_daily_watch_events: maxDailyWatchEvents,
      active_days: activeDays,
      selection_rule: selectionRule,
      archive_coverage_complete: snapshot.source.archive_coverage_complete,
    },
  };
}

function formatMetadataSelectionRule(
  selection: ActivitySeriesSnapshot["source"]["metadata_selection"],
): string {
  if (!selection) {
    return "no metadata selection rule was recorded";
  }
  if (selection.method === "minimum-daily-watch-events") {
    return `at least ${selection.minimum_daily_watch_events} WatchEvents in one UTC day`;
  }
  return `at least ${selection.minimum_window_watch_events} WatchEvents across the full window`;
}

function validateInputs(inputs: CityBuilderInputs): void {
  if (inputs.analysis.source.input_schema_version !== "activity-series-v1") {
    throw new Error("city-v1 requires topic analysis derived from activity-series-v1.");
  }
  if (
    inputs.analysis.candidate_window.from !== inputs.activity.window.from ||
    inputs.analysis.candidate_window.to !== inputs.activity.window.to
  ) {
    throw new Error("Activity and topic-analysis windows must match exactly.");
  }
  if (
    inputs.lifecycle.window.from > inputs.activity.window.from ||
    inputs.lifecycle.window.to < inputs.activity.window.to
  ) {
    throw new Error("Repository lifecycle must cover the activity window.");
  }
}

function findActivityRepository(
  analyzed: TopicAnalysisRepository,
  byId: ReadonlyMap<number, ActivitySeriesSnapshot["repositories"][number]>,
  byName: ReadonlyMap<string, ActivitySeriesSnapshot["repositories"][number]>,
): ActivitySeriesSnapshot["repositories"][number] | undefined {
  if (analyzed.repository_id !== null) {
    return byId.get(analyzed.repository_id);
  }
  return byName.get(analyzed.full_name.toLowerCase());
}

function uniqueKeywords(observations: readonly KeywordObservation[]): string[] {
  return [...new Set(observations.map(({ keyword_id: keyword }) => keyword))]
    .sort();
}

function countRelatedKeywordRepositories(
  repositories: readonly TopicAnalysisRepository[],
): Map<string, number> {
  const repositoriesByKeyword = new Map<string, Set<number>>();
  for (const repository of repositories) {
    if (repository.repository_id === null) {
      continue;
    }
    for (const keyword of uniqueKeywords(repository.observations)) {
      const repositoryIds =
        repositoriesByKeyword.get(keyword) ?? new Set<number>();
      repositoryIds.add(repository.repository_id);
      repositoriesByKeyword.set(keyword, repositoryIds);
    }
  }
  return new Map(
    [...repositoriesByKeyword.entries()].map(([keyword, repositoryIds]) => [
      keyword,
      repositoryIds.size,
    ]),
  );
}

function selectPrimaryCommunity(
  observations: readonly KeywordObservation[],
  censusCounts: ReadonlyMap<string, number>,
): string {
  const candidates = new Map<
    string,
    { confidence: number; occurrences: number }
  >();
  for (const observation of observations) {
    if (BROAD_COMMUNITY_KEYWORDS.has(observation.keyword_id)) {
      continue;
    }
    const existing = candidates.get(observation.keyword_id) ?? {
      confidence: 0,
      occurrences: 0,
    };
    existing.confidence = Math.max(existing.confidence, observation.confidence);
    existing.occurrences += observation.occurrence_count;
    candidates.set(observation.keyword_id, existing);
  }
  return [...candidates.entries()]
    .sort(
      ([leftKeyword, left], [rightKeyword, right]) =>
        (censusCounts.get(rightKeyword) ?? 0) -
          (censusCounts.get(leftKeyword) ?? 0) ||
        right.confidence - left.confidence ||
        right.occurrences - left.occurrences ||
        leftKeyword.localeCompare(rightKeyword),
    )[0]?.[0] ?? "frontier";
}

function assignDistrict(keywords: readonly string[]): CityDistrictId {
  for (const [district, signals] of DISTRICT_KEYWORDS) {
    if (
      keywords.some((keyword) => {
        const parts = keyword.split("-");
        return signals.some(
          (signal) => keyword === signal || parts.includes(signal),
        );
      })
    ) {
      return district;
    }
  }
  return "frontier";
}

function latestWeekInWindow(
  weeks: readonly RepositoryLifecycleWeek[],
  windowTo: string,
): RepositoryLifecycleWeek | null {
  return [...weeks]
    .filter((week) => week.from < windowTo)
    .sort((left, right) => right.from.localeCompare(left.from))[0] ?? null;
}

function buildFlags(
  district: CityDistrictId,
  lifecycle: RepositoryLifecycleRepository | null,
): CityRepositoryFlag[] {
  const flags: CityRepositoryFlag[] = [];
  if (lifecycle?.fast_breakout) {
    flags.push("breakout");
  }
  if (lifecycle?.radar_status === "cooling") {
    flags.push("cooling");
  }
  if (lifecycle?.radar_status === "inactive") {
    flags.push("inactive");
  }
  if (district === "frontier") {
    flags.push("frontier");
  }
  return flags;
}

function compareRepositories(
  left: PendingRepository,
  right: PendingRepository,
): number {
  return (
    right.value.watch_events_window - left.value.watch_events_window ||
    right.value.stars - left.value.stars ||
    left.value.full_name.localeCompare(right.value.full_name)
  );
}

function buildCommunities(
  repositories: readonly CityRepository[],
  relatedKeywordCounts: ReadonlyMap<string, number>,
): CityCommunity[] {
  const groups = new Map<
    string,
    { district: CityDistrictId; repositoryCount: number }
  >();
  for (const repository of repositories) {
    const group = groups.get(repository.community_id) ?? {
      district: repository.district_id,
      repositoryCount: 0,
    };
    group.repositoryCount += 1;
    groups.set(repository.community_id, group);
  }
  return [...groups.entries()]
    .map(([id, group]) => ({
      id,
      label: formatCommunityLabel(id),
      district_id: group.district,
      status:
        id !== "frontier" && (relatedKeywordCounts.get(id) ?? 0) >= 5
          ? "emerging" as const
          : "unknown" as const,
      repository_count: group.repositoryCount,
      natural_building_count: group.repositoryCount,
    }))
    .sort(
      (left, right) =>
        (DISTRICT_ORDER.get(left.district_id) ?? 99) -
          (DISTRICT_ORDER.get(right.district_id) ?? 99) ||
        right.repository_count - left.repository_count ||
        left.id.localeCompare(right.id),
    );
}

function formatCommunityLabel(id: string): string {
  if (id === "frontier") {
    return "Frontier";
  }
  const acronyms = new Set(["ai", "llm", "mcp", "rag"]);
  return id
    .split("-")
    .map((part) =>
      acronyms.has(part)
        ? part.toUpperCase()
        : `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`,
    )
    .join(" ");
}

function latestTimestamp(values: readonly (string | null)[]): string {
  const timestamps = values.filter((value): value is string => value !== null);
  timestamps.sort((left, right) => left.localeCompare(right));
  const latest = timestamps.at(-1);
  if (!latest) {
    throw new Error("city-v1 requires at least one source timestamp.");
  }
  return latest;
}
