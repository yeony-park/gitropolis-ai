export type RepositoryRadarStatus =
  | "candidate"
  | "active"
  | "cooling"
  | "inactive";

export type RepositoryAvailabilityStatus =
  | "available"
  | "unavailable"
  | "unknown";

export type RepositoryBreakoutStatus =
  | "pending"
  | "confirmed"
  | "unconfirmed";

export type IntegrityVerificationStatus =
  | "verified"
  | "partial"
  | "unavailable";

export type LifecycleDecisionCoverage =
  | "complete"
  | "record-warning"
  | "temporal-incomplete";

export interface RepositoryLifecycleRules {
  methodology_version: "repository-lifecycle-rules-v1";
  main_daily_watch_events: number;
  scout_weekly_watch_events: number;
  fast_breakout_weekly_watch_events: number;
  active_after_qualified_weeks: 2;
  inactive_after_below_scout_weeks: 2;
}

export interface RepositoryLifecycleInput {
  file_name: string;
  from: string;
  to: string;
  days: number;
  archive_coverage_complete: boolean;
  integrity_verification: IntegrityVerificationStatus;
}

export interface RepositoryLifecycleWeekSummary {
  from: string;
  to: string;
  calendar_complete: boolean;
  hour_coverage_complete: boolean;
  record_coverage_complete: boolean;
  decision_coverage: LifecycleDecisionCoverage;
  integrity_verification: IntegrityVerificationStatus;
  repositories_observed: number;
  main_radar_repositories: number;
  emerging_scout_repositories: number;
  fast_breakout_repositories: number;
}

export interface RepositoryLifecycleWeek {
  from: string;
  to: string;
  calendar_complete: boolean;
  hour_coverage_complete: boolean;
  record_coverage_complete: boolean;
  decision_coverage: LifecycleDecisionCoverage;
  integrity_verification: IntegrityVerificationStatus;
  weekly_watch_events: number;
  max_daily_watch_events: number;
  active_days: number;
  main_radar: boolean | null;
  emerging_scout: boolean | null;
  fast_breakout: boolean | null;
  radar_status: RepositoryRadarStatus | null;
  breakout_status: RepositoryBreakoutStatus | null;
  consecutive_qualified_weeks: number;
  consecutive_below_scout_weeks: number;
}

export interface RepositoryLifecycleRepository {
  repository_id: number | null;
  full_name: string;
  aliases: string[];
  availability_status: RepositoryAvailabilityStatus;
  radar_status: RepositoryRadarStatus | null;
  first_observed_at: string;
  last_observed_at: string;
  first_detected_at: string | null;
  state_changed_at: string | null;
  last_qualified_week: string | null;
  consecutive_qualified_weeks: number;
  consecutive_below_scout_weeks: number;
  fast_breakout: boolean;
  breakout_status: RepositoryBreakoutStatus | null;
  breakout_detected_at: string | null;
  weeks: RepositoryLifecycleWeek[];
}

export type RepositoryLifecycleEventType =
  | "candidate_detected"
  | "activated"
  | "cooling_started"
  | "inactivated"
  | "revived"
  | "breakout_detected"
  | "breakout_confirmed"
  | "breakout_unconfirmed"
  | "data_incomplete";

export interface RepositoryLifecycleEvent {
  repository_id: number | null;
  full_name: string;
  type: RepositoryLifecycleEventType;
  effective_week: string;
  previous_status: RepositoryRadarStatus | null;
  next_status: RepositoryRadarStatus | null;
  reason: string;
}

export interface RepositoryLifecycleSnapshot {
  schema_version: "repository-lifecycle-v1";
  generated_at: string;
  window: {
    from: string;
    to: string;
  };
  methodology: RepositoryLifecycleRules;
  source: {
    input_schema_version: "activity-series-v1";
    input_snapshots: RepositoryLifecycleInput[];
    coverage_complete: boolean;
    integrity_verification: IntegrityVerificationStatus;
  };
  weeks: RepositoryLifecycleWeekSummary[];
  repositories: RepositoryLifecycleRepository[];
  events: RepositoryLifecycleEvent[];
}
