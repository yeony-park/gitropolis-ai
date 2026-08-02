import type {
  RateLimitResource,
  RepositorySnapshot,
} from "./snapshot.js";

export interface ActivitySeriesCoverageError {
  source: "gh-archive" | "github";
  target: string;
  status: number | null;
  message: string;
}

export interface ActivitySeriesDay {
  date: string;
  hours_requested: 24;
  hours_collected: number;
  coverage_complete: boolean;
  watch_events_observed: number;
}

export interface RepositoryDailyActivity {
  date: string;
  watch_events_observed: number;
  coverage_complete: boolean;
}

export interface ActivitySeriesRepository {
  full_name: string;
  watch_events_observed_total: number;
  observed_watch_velocity_per_day: number | null;
  first_seen_at: string;
  last_seen_at: string;
  daily: RepositoryDailyActivity[];
  metadata_selected: boolean;
  current: RepositorySnapshot | null;
}

export type ActivityMetadataSelectionRule =
  | {
      method: "minimum-daily-watch-events";
      minimum_daily_watch_events: number;
    }
  | {
      method: "minimum-window-watch-events";
      minimum_window_watch_events: number;
    };

export type ActivityMetadataProfile =
  | "full"
  | "classification"
  | "screening";

export interface ActivitySeriesSnapshot {
  schema_version: "activity-series-v1";
  window: {
    from: string;
    to: string;
    days: number;
  };
  source: {
    type: "gh-archive" | "gh-archive+github";
    archive_coverage_complete: boolean;
    metadata_coverage_complete: boolean;
    coverage_complete: boolean;
    hours_requested: number;
    hours_collected: number;
    watch_events_observed: number;
    repositories_seen: number;
    github_authenticated: boolean | null;
    github_rate_limit: Partial<
      Record<"core" | "search" | "graphql", RateLimitResource>
    > | null;
    metadata_selection: (ActivityMetadataSelectionRule & {
      metadata_profile: ActivityMetadataProfile;
      selected: number;
      collected: number;
      collected_at: string | null;
    }) | null;
    coverage_errors: ActivitySeriesCoverageError[];
  };
  days: ActivitySeriesDay[];
  repositories: ActivitySeriesRepository[];
}
