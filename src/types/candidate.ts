import type {
  RateLimitResource,
  RepositorySnapshot,
} from "./snapshot.js";

export interface CandidateCoverageError {
  source: "gh-archive" | "github";
  target: string;
  status: number | null;
  message: string;
}

export interface CandidateRepository {
  full_name: string;
  watch_events: number;
  first_seen_at: string;
  last_seen_at: string;
  github: RepositorySnapshot | null;
}

export interface CandidateSnapshot {
  schema_version: "candidate-v1";
  window: {
    from: string;
    to: string;
  };
  source: {
    type: "gh-archive";
    coverage_complete: boolean;
    hours_requested: number;
    hours_collected: number;
    watch_events_seen: number;
    repositories_seen: number;
    github_authenticated: boolean | null;
    github_rate_limit: Partial<
      Record<"core" | "search" | "graphql", RateLimitResource>
    > | null;
    coverage_errors: CandidateCoverageError[];
  };
  repositories: CandidateRepository[];
}
