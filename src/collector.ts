import {
  GITHUB_API_VERSION,
  GitHubApiError,
  type GitHubApiClient,
  type GitHubResponse,
} from "./github/client.js";
import type {
  CoverageError,
  RateLimitResource,
  ReadmeMetadata,
  RepositorySnapshot,
  Snapshot,
} from "./types/snapshot.js";

const REPOSITORY_PATTERN =
  /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]+$/;

interface RepositoryResponse {
  id: number;
  node_id: string;
  full_name: string;
  html_url: string;
  description: string | null;
  created_at: string;
  updated_at: string;
  pushed_at: string | null;
  stargazers_count: number;
  forks_count: number;
  subscribers_count: number;
  open_issues_count: number;
  language: string | null;
  topics: string[];
  default_branch: string;
  archived: boolean;
  visibility: string;
  license: { spdx_id: string | null } | null;
}

interface ReadmeResponse {
  name?: unknown;
  path?: unknown;
  size?: unknown;
  sha?: unknown;
  html_url?: unknown;
}

interface RateLimitResponse {
  resources?: Partial<
    Record<"core" | "search" | "graphql", Partial<RateLimitResource>>
  >;
}

export function validateRepositoryName(repository: string): string {
  if (!REPOSITORY_PATTERN.test(repository)) {
    throw new Error(
      `Invalid repository '${repository}'. Expected OWNER/REPOSITORY.`,
    );
  }
  return repository;
}

export async function collectSnapshot(
  repositories: readonly string[],
  client: GitHubApiClient,
  collectedAt = new Date(),
): Promise<Snapshot> {
  const repositoryNames = repositories.map(validateRepositoryName);
  const coverageErrors: CoverageError[] = [];
  const collectedRepositories: RepositorySnapshot[] = [];
  let stoppedByRateLimit = false;
  for (const repository of repositoryNames) {
    try {
      collectedRepositories.push(
        await collectRepository(
          repository,
          client,
          collectedAt,
          coverageErrors,
        ),
      );
    } catch (error) {
      if (!(error instanceof GitHubApiError)) {
        throw error;
      }
      coverageErrors.push({
        endpoint:
          error.endpoint ?? `/repos/${repositoryPath(repository)}`,
        status: error.status,
        message: error.message,
      });
      if (error.rateLimited) {
        stoppedByRateLimit = true;
        break;
      }
    }
  }
  const rateLimit = stoppedByRateLimit ? null : await collectRateLimit(client);

  return {
    schema_version: "snapshot-v1",
    collected_at: collectedAt.toISOString(),
    source: {
      github_api_version: GITHUB_API_VERSION,
      authenticated: client.authenticated,
      coverage_complete: coverageErrors.length === 0,
      rate_limit: rateLimit,
      coverage_errors: coverageErrors,
    },
    repositories: collectedRepositories,
  };
}

async function collectRateLimit(
  client: GitHubApiClient,
): Promise<Snapshot["source"]["rate_limit"]> {
  let response: GitHubResponse<RateLimitResponse>;
  try {
    response = await client.get<RateLimitResponse>("/rate_limit");
  } catch (error) {
    if (error instanceof GitHubApiError) {
      return null;
    }
    throw error;
  }

  const rateLimit: NonNullable<Snapshot["source"]["rate_limit"]> = {};
  for (const name of ["core", "search", "graphql"] as const) {
    const resource = response.data.resources?.[name];
    if (
      resource &&
      typeof resource.limit === "number" &&
      typeof resource.remaining === "number" &&
      typeof resource.used === "number" &&
      typeof resource.reset === "number"
    ) {
      rateLimit[name] = {
        limit: resource.limit,
        remaining: resource.remaining,
        used: resource.used,
        reset: resource.reset,
      };
    }
  }
  return rateLimit;
}

async function collectRepository(
  repository: string,
  client: GitHubApiClient,
  collectedAt: Date,
  coverageErrors: CoverageError[],
): Promise<RepositorySnapshot> {
  const path = repositoryPath(repository);
  const detail = await client.get<RepositoryResponse>(`/repos/${path}`);
  const languages = await optionalRequest<Record<string, number>>(
    client,
    `/repos/${path}/languages`,
    coverageErrors,
  );
  const readme = await optionalRequest<ReadmeResponse>(
    client,
    `/repos/${path}/readme`,
    coverageErrors,
    undefined,
    true,
  );
  const commits = await optionalRequest<unknown[]>(
    client,
    `/repos/${path}/commits`,
    coverageErrors,
    {
      sha: detail.data.default_branch,
      since: new Date(
        collectedAt.getTime() - 30 * 24 * 60 * 60 * 1_000,
      ).toISOString(),
      until: collectedAt.toISOString(),
      per_page: 1,
    },
  );
  const contributors = await optionalRequest<unknown[]>(
    client,
    `/repos/${path}/contributors`,
    coverageErrors,
    { per_page: 1, anon: 1 },
  );

  return {
    id: detail.data.id,
    node_id: detail.data.node_id,
    full_name: detail.data.full_name,
    html_url: detail.data.html_url,
    description: detail.data.description,
    created_at: detail.data.created_at,
    updated_at: detail.data.updated_at,
    pushed_at: detail.data.pushed_at,
    stars: detail.data.stargazers_count,
    forks: detail.data.forks_count,
    subscribers: detail.data.subscribers_count,
    open_issues_and_pull_requests: detail.data.open_issues_count,
    primary_language: detail.data.language,
    language_bytes: languages?.data ?? null,
    language_share: languages ? languageShare(languages.data) : null,
    topics: detail.data.topics,
    default_branch: detail.data.default_branch,
    archived: detail.data.archived,
    visibility: detail.data.visibility,
    license_spdx: detail.data.license?.spdx_id ?? null,
    readme: readme ? readmeMetadata(readme.data) : null,
    commits_30d: commits ? pageCount(commits) : null,
    contributors_count: contributors ? pageCount(contributors) : null,
    delta_stars_1d: null,
    delta_stars_7d: null,
    delta_stars_30d: null,
    star_velocity_7d: null,
    star_acceleration: null,
  };
}

async function optionalRequest<T>(
  client: GitHubApiClient,
  path: string,
  coverageErrors: CoverageError[],
  parameters?: Readonly<Record<string, string | number>>,
  missingIsNormal = false,
): Promise<GitHubResponse<T> | null> {
  try {
    return await client.get<T>(path, parameters);
  } catch (error) {
    if (!(error instanceof GitHubApiError)) {
      throw error;
    }
    if (error.rateLimited) {
      throw error;
    }
    if (missingIsNormal && error.status === 404) {
      return null;
    }
    coverageErrors.push({
      endpoint: path,
      status: error.status,
      message: error.message,
    });
    return null;
  }
}

function repositoryPath(repository: string): string {
  return repository.split("/").map(encodeURIComponent).join("/");
}

function languageShare(
  languages: Readonly<Record<string, number>>,
): Record<string, number> {
  const total = Object.values(languages).reduce(
    (sum, byteCount) => sum + byteCount,
    0,
  );
  if (total === 0) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(languages).map(([language, byteCount]) => [
      language,
      Number((byteCount / total).toFixed(6)),
    ]),
  );
}

function readmeMetadata(readme: ReadmeResponse): ReadmeMetadata {
  return {
    name: stringOrNull(readme.name),
    path: stringOrNull(readme.path),
    size: numberOrNull(readme.size),
    sha: stringOrNull(readme.sha),
    html_url: stringOrNull(readme.html_url),
  };
}

function pageCount(response: GitHubResponse<unknown[]>): number {
  if (response.data.length === 0) {
    return 0;
  }

  const link = response.headers.get("link");
  const lastUrl = link?.match(/<([^>]+)>;\s*rel="last"/)?.[1];
  if (!lastUrl) {
    return response.data.length;
  }

  const page = Number(new URL(lastUrl).searchParams.get("page"));
  return Number.isSafeInteger(page) && page > 0 ? page : response.data.length;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" ? value : null;
}
