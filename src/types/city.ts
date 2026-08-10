import type {
  RepositoryAvailabilityStatus,
  RepositoryBreakoutStatus,
  RepositoryRadarStatus,
} from "./repository-lifecycle.js";

export type CityDistrictId =
  | "models"
  | "agents"
  | "knowledge-data"
  | "ai-development"
  | "multimodal"
  | "infrastructure"
  | "embodied-ai"
  | "frontier";

export interface CityDistrict {
  id: CityDistrictId;
  label: string;
  ko: string;
  color: string;
}

export interface CityCommunity {
  id: string;
  label: string;
  district_id: CityDistrictId;
  status: "unknown" | "emerging";
  repository_count: number;
  natural_building_count: number;
}

export type CityRepositoryFlag =
  | "breakout"
  | "cooling"
  | "inactive"
  | "frontier";

export interface CityRepository {
  repository_id: number;
  full_name: string;
  url: string;
  district_id: CityDistrictId;
  community_id: string;
  global_rank: number;
  community_rank: number;
  ai_relevance: number;
  radar_status: RepositoryRadarStatus | null;
  availability_status: RepositoryAvailabilityStatus;
  breakout_status: RepositoryBreakoutStatus | null;
  watch_events_window: number;
  weekly_watch_events: number | null;
  max_daily_watch_events: number | null;
  stars: number;
  forks: number;
  commits_30d: number | null;
  contributors_count: number | null;
  keywords: string[];
  flags: CityRepositoryFlag[];
}

export interface CitySnapshot {
  schema_version: "city-v1";
  generated_at: string;
  period: "weekly";
  window: {
    from: string;
    to: string;
  };
  methodology: {
    builder: "city-builder-v1";
    district_assignment: "city-district-rules-v1";
    community_assignment: "primary-keyword-v1";
    ai_relevance: string;
    repository_lifecycle: string;
  };
  source: {
    activity_schema_version: "activity-series-v1";
    analysis_schema_version: "topic-analysis-v1";
    lifecycle_schema_version: "repository-lifecycle-v1";
    activity_coverage_complete: boolean;
    analysis_coverage_complete: boolean;
    lifecycle_coverage_complete: boolean;
    coverage_complete: boolean;
    repositories_considered: number;
    ai_related_repositories: number;
    included_repositories: number;
    excluded_missing_metadata: number;
  };
  districts: CityDistrict[];
  communities: CityCommunity[];
  repositories: CityRepository[];
  edges: [];
  community_edges: [];
  display: {
    top_n_options: [5, 10, 25, 50, 100];
    mvp_visible_budget: 100;
  };
}
