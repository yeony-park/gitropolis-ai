import assert from "node:assert/strict";
import { test } from "node:test";

import {
  collectSnapshot,
  validateRepositoryName,
} from "../src/collector.js";
import {
  GitHubApiError,
  type GitHubApiClient,
  type GitHubResponse,
} from "../src/github/client.js";

type StubValue =
  | GitHubResponse<unknown>
  | GitHubApiError;

class StubGitHubClient {
  readonly authenticated = false;

  constructor(private readonly responses: Readonly<Record<string, StubValue>>) {}

  async get<T>(
    path: string,
    _parameters?: Readonly<Record<string, string | number>>,
  ): Promise<GitHubResponse<T>> {
    const response = this.responses[path];
    if (!response) {
      throw new Error(`Missing stub response for ${path}`);
    }
    if (response instanceof GitHubApiError) {
      throw response;
    }
    return response as GitHubResponse<T>;
  }
}

const collectedAt = new Date("2026-07-30T03:00:00Z");
const repository = {
  id: 881458615,
  node_id: "R_kgDONIn9tw",
  full_name: "browser-use/browser-use",
  html_url: "https://github.com/browser-use/browser-use",
  description: "Make websites accessible for AI agents.",
  created_at: "2024-10-31T16:00:56Z",
  updated_at: "2026-07-29T16:12:12Z",
  pushed_at: "2026-07-29T16:12:09Z",
  stargazers_count: 107200,
  forks_count: 11788,
  subscribers_count: 451,
  open_issues_count: 340,
  language: "Python",
  topics: ["ai-agents", "browser-automation"],
  default_branch: "main",
  archived: false,
  visibility: "public",
  license: { spdx_id: "MIT" },
};

function response<T>(data: T, link?: string): GitHubResponse<T> {
  const headers = new Headers();
  if (link) {
    headers.set("link", link);
  }
  return { data, headers };
}

function clientWith(
  overrides: Readonly<Record<string, StubValue>> = {},
): GitHubApiClient {
  return new StubGitHubClient({
    "/rate_limit": response({
      resources: {
        core: { limit: 60, remaining: 54, used: 6, reset: 1785384000 },
        search: { limit: 10, remaining: 10, used: 0, reset: 1785380400 },
      },
    }),
    "/repos/browser-use/browser-use": response(repository),
    "/repos/browser-use/browser-use/languages": response({
      Python: 90,
      Shell: 10,
    }),
    "/repos/browser-use/browser-use/readme": response({
      name: "README.md",
      path: "README.md",
      size: 13002,
      sha: "readme-sha",
      html_url:
        "https://github.com/browser-use/browser-use/blob/main/README.md",
    }),
    "/repos/browser-use/browser-use/commits": response(
      [{ sha: "commit-sha" }],
      '<https://api.github.com/repositories/881458615/commits?page=153>; rel="last"',
    ),
    "/repos/browser-use/browser-use/contributors": response(
      [{ login: "not-stored" }],
      '<https://api.github.com/repositories/881458615/contributors?page=334>; rel="last"',
    ),
    ...overrides,
  });
}

test("repository validation accepts OWNER/REPOSITORY", () => {
  assert.equal(
    validateRepositoryName("browser-use/browser-use"),
    "browser-use/browser-use",
  );
});

test("repository validation rejects an invalid name", () => {
  assert.throws(
    () => validateRepositoryName("browser-use"),
    /Expected OWNER\/REPOSITORY/,
  );
});

test("collector creates an anonymous repository snapshot", async () => {
  const snapshot = await collectSnapshot(
    ["browser-use/browser-use"],
    clientWith(),
    collectedAt,
  );

  assert.equal(snapshot.source.authenticated, false);
  assert.equal(snapshot.source.coverage_complete, true);
  assert.equal(snapshot.source.rate_limit?.core?.limit, 60);
  const collectedRepository = snapshot.repositories[0];
  assert.ok(collectedRepository);
  assert.equal(collectedRepository.id, 881458615);
  assert.deepEqual(collectedRepository.language_share, {
    Python: 0.9,
    Shell: 0.1,
  });
  assert.equal(collectedRepository.readme?.sha, "readme-sha");
  assert.equal(collectedRepository.commits_30d, 153);
  assert.equal(collectedRepository.contributors_count, 334);
  assert.equal(collectedRepository.delta_stars_30d, null);
  assert.equal("login" in collectedRepository, false);
});

test("a missing README is not a coverage error", async () => {
  const snapshot = await collectSnapshot(
    ["browser-use/browser-use"],
    clientWith({
      "/repos/browser-use/browser-use/readme": new GitHubApiError(
        404,
        "GitHub API returned 404: Not Found",
      ),
    }),
    collectedAt,
  );

  assert.equal(snapshot.source.coverage_complete, true);
  assert.equal(snapshot.repositories[0]?.readme, null);
});

test("an optional endpoint failure marks coverage incomplete", async () => {
  const snapshot = await collectSnapshot(
    ["browser-use/browser-use"],
    clientWith({
      "/repos/browser-use/browser-use/languages": new GitHubApiError(
        403,
        "GitHub API returned 403: rate limit exceeded",
      ),
    }),
    collectedAt,
  );

  assert.equal(snapshot.source.coverage_complete, false);
  assert.equal(
    snapshot.source.coverage_errors[0]?.endpoint,
    "/repos/browser-use/browser-use/languages",
  );
  assert.equal(snapshot.repositories[0]?.language_bytes, null);
});
