export interface RateLimitResource {
  limit: number;
  remaining: number;
  used: number;
  reset: number;
}

export interface CoverageError {
  endpoint: string;
  status: number | null;
  message: string;
}

export interface ReadmeMetadata {
  name: string | null;
  path: string | null;
  size: number | null;
  sha: string | null;
  html_url: string | null;
}

export interface RepositorySnapshot {
  id: number;
  node_id: string;
  full_name: string;
  html_url: string;
  description: string | null;
  created_at: string;
  updated_at: string;
  pushed_at: string | null;
  stars: number;
  forks: number;
  subscribers: number;
  open_issues_and_pull_requests: number;
  primary_language: string | null;
  language_bytes: Record<string, number> | null;
  language_share: Record<string, number> | null;
  topics: string[];
  default_branch: string;
  archived: boolean;
  visibility: string;
  license_spdx: string | null;
  readme: ReadmeMetadata | null;
  commits_30d: number | null;
  contributors_count: number | null;
  delta_stars_1d: null;
  delta_stars_7d: null;
  delta_stars_30d: null;
  star_velocity_7d: null;
  star_acceleration: null;
}

export interface Snapshot {
  schema_version: "snapshot-v1";
  collected_at: string;
  source: {
    github_api_version: string;
    authenticated: boolean;
    coverage_complete: boolean;
    rate_limit: Partial<
      Record<"core" | "search" | "graphql", RateLimitResource>
    > | null;
    coverage_errors: CoverageError[];
  };
  repositories: RepositorySnapshot[];
}
