import assert from "node:assert/strict";
import { test } from "node:test";

import {
  analyzeCandidates,
  githubReadmeSource,
  type RepositoryReadmeSource,
} from "../src/topic-analysis.js";
import { GitHubApiError, GitHubClient } from "../src/github/client.js";
import type { BatchModelAIClassifier } from "../src/model-classification.js";
import type {
  CandidateRepository,
  CandidateSnapshot,
} from "../src/types/candidate.js";
import type { RepositorySnapshot } from "../src/types/snapshot.js";

const observedAt = new Date("2026-08-02T12:00:00Z");

function repositorySnapshot(
  fullName: string,
  id: number,
  options: {
    description?: string | null;
    topics?: string[];
    hasReadme?: boolean;
  } = {},
): RepositorySnapshot {
  return {
    id,
    node_id: `node-${id}`,
    full_name: fullName,
    html_url: `https://github.com/${fullName}`,
    description: options.description ?? null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-08-01T00:00:00Z",
    pushed_at: "2026-08-01T00:00:00Z",
    stars: 100,
    forks: 10,
    subscribers: 2,
    open_issues_and_pull_requests: 3,
    primary_language: "TypeScript",
    language_bytes: { TypeScript: 100 },
    language_share: { TypeScript: 1 },
    topics: options.topics ?? [],
    default_branch: "main",
    archived: false,
    visibility: "public",
    license_spdx: "MIT",
    readme:
      options.hasReadme === false
        ? null
        : {
            name: "README.md",
            path: "README.md",
            size: 100,
            sha: `sha-${id}`,
            html_url: `https://github.com/${fullName}#readme`,
          },
    commits_30d: 10,
    contributors_count: 4,
    delta_stars_1d: null,
    delta_stars_7d: null,
    delta_stars_30d: null,
    star_velocity_7d: null,
    star_acceleration: null,
  };
}

function candidateRepository(
  fullName: string,
  id: number,
  options?: Parameters<typeof repositorySnapshot>[2],
): CandidateRepository {
  return {
    full_name: fullName,
    watch_events: 10,
    first_seen_at: "2026-08-01T00:00:00Z",
    last_seen_at: "2026-08-01T23:00:00Z",
    github: repositorySnapshot(fullName, id, options),
  };
}

function candidateSnapshot(
  repositories: CandidateRepository[],
): CandidateSnapshot {
  return {
    schema_version: "candidate-v1",
    window: {
      from: "2026-08-01T00:00:00Z",
      to: "2026-08-02T00:00:00Z",
    },
    source: {
      type: "gh-archive",
      coverage_complete: true,
      hours_requested: 24,
      hours_collected: 24,
      watch_events_seen: 100,
      repositories_seen: repositories.length,
      github_authenticated: false,
      github_rate_limit: null,
      coverage_errors: [],
    },
    repositories,
  };
}

function stubReadmes(
  values: Readonly<Record<string, string | null | Error>>,
): RepositoryReadmeSource {
  return {
    authenticated: false,
    async getReadme(repository): Promise<string | null> {
      const value = values[repository] ?? null;
      if (value instanceof Error) {
        throw value;
      }
      return value;
    },
  };
}

test("observes dynamic graph-rag and agentic-rag keywords", async () => {
  const snapshot = await analyzeCandidates(
    candidateSnapshot([
      candidateRepository("owner/graph-one", 1, {
        topics: ["graph-rag", "knowledge-graph", "typescript"],
      }),
      candidateRepository("owner/graph-two", 2, {
        description: "A GraphRAG toolkit for AI agents.",
      }),
      candidateRepository("owner/graph-three", 3, {
        topics: ["graph-rag"],
      }),
      candidateRepository("owner/graph-four", 4, {
        topics: ["graph-rag"],
      }),
      candidateRepository("owner/graph-five", 5, {
        topics: ["graph-rag"],
      }),
      candidateRepository("owner/agentic", 6, {
        description: "Agentic RAG workflows for large language models.",
      }),
    ]),
    stubReadmes({}),
    { observedAt },
  );

  const first = snapshot.repositories[0];
  const second = snapshot.repositories[1];
  const third = snapshot.repositories[5];
  assert.equal(first?.ai_relevance.decision, "ai-related");
  assert.equal(second?.ai_relevance.decision, "ai-related");
  assert.equal(third?.ai_relevance.decision, "ai-related");
  assert.equal(first?.community_status, "emerging");
  assert.equal(second?.community_status, "emerging");
  assert.deepEqual(
    snapshot.repositories.slice(0, 5).map(({ community_status: status }) =>
      status,
    ),
    ["emerging", "emerging", "emerging", "emerging", "emerging"],
  );
  assert.equal(third?.community_status, "unknown");
  assert.equal(
    first?.observations.some(
      ({ keyword_id: keyword, source }) =>
        keyword === "graph-rag" && source === "topics",
    ),
    true,
  );
  assert.equal(
    second?.observations.some(
      ({ keyword_id: keyword, source }) =>
        keyword === "graph-rag" && source === "description",
    ),
    true,
  );
  assert.equal(
    third?.observations.some(
      ({ keyword_id: keyword }) => keyword === "agentic-rag",
    ),
    true,
  );
});

test("distinguishes positive, ambiguous, and negative evidence", async () => {
  const snapshot = await analyzeCandidates(
    candidateSnapshot([
      candidateRepository("owner/positive", 1, {
        topics: ["machine-learning"],
        hasReadme: false,
      }),
      candidateRepository("owner/ambiguous", 2),
      candidateRepository("owner/negative", 3, {
        description: "A calendar and task manager for small teams.",
        hasReadme: false,
      }),
    ]),
    stubReadmes({
      "owner/ambiguous": "An experimental transformer implementation.",
    }),
    { observedAt },
  );

  assert.deepEqual(
    snapshot.repositories.map(({ ai_relevance: relevance }) =>
      relevance.decision,
    ),
    ["ai-related", "review", "not-ai"],
  );
  assert.equal(snapshot.repositories[0]?.community_status, "unknown");
  assert.equal(snapshot.repositories[1]?.community_status, null);
  assert.equal(snapshot.repositories[2]?.community_status, null);
});

test("preserves repository analysis and records README failures", async () => {
  const snapshot = await analyzeCandidates(
    candidateSnapshot([
      candidateRepository("owner/repository", 1, {
        topics: ["artificial-intelligence"],
      }),
    ]),
    stubReadmes({
      "owner/repository": new Error("README connection failed"),
    }),
    { observedAt },
  );

  assert.equal(snapshot.repositories.length, 1);
  assert.equal(
    snapshot.repositories[0]?.ai_relevance.decision,
    "ai-related",
  );
  assert.equal(snapshot.source.coverage_complete, false);
  assert.deepEqual(snapshot.source.coverage_errors[0], {
    source: "github",
    target: "/repos/owner/repository/readme",
    status: null,
    message: "README connection failed",
  });
});

test("does not persist raw README content", async () => {
  const rawReadme = "PRIVATE_CANARY_7291 Graph RAG and AI agents";
  const snapshot = await analyzeCandidates(
    candidateSnapshot([candidateRepository("owner/repository", 1)]),
    stubReadmes({ "owner/repository": rawReadme }),
    { observedAt, maxReadmeCharacters: 24 },
  );

  const serialized = JSON.stringify(snapshot);
  assert.equal(serialized.includes("PRIVATE_CANARY_7291"), false);
  assert.equal(serialized.includes(rawReadme), false);
});

test("retains candidates whose GitHub enrichment is unavailable", async () => {
  const candidate = candidateSnapshot([]);
  candidate.repositories.push({
    full_name: "owner/unavailable",
    watch_events: 5,
    first_seen_at: "2026-08-01T00:00:00Z",
    last_seen_at: "2026-08-01T01:00:00Z",
    github: null,
  });

  const snapshot = await analyzeCandidates(candidate, stubReadmes({}), {
    observedAt,
  });

  assert.equal(snapshot.repositories[0]?.full_name, "owner/unavailable");
  assert.equal(snapshot.repositories[0]?.repository_id, null);
  assert.equal(
    snapshot.repositories[0]?.ai_relevance.decision,
    "unavailable",
  );
  assert.equal(snapshot.source.coverage_complete, false);
});

test("carries incomplete candidate coverage into analysis coverage", async () => {
  const candidate = candidateSnapshot([
    candidateRepository("owner/repository", 1, {
      topics: ["ai-agents"],
      hasReadme: false,
    }),
  ]);
  candidate.source.coverage_complete = false;
  candidate.source.coverage_errors.push({
    source: "gh-archive",
    target: "2026-08-01T01:00:00Z:42",
    status: null,
    message: "Malformed JSON record.",
  });

  const snapshot = await analyzeCandidates(candidate, stubReadmes({}), {
    observedAt,
  });

  assert.equal(snapshot.source.candidate_coverage_complete, false);
  assert.equal(snapshot.source.candidate_coverage_errors.length, 1);
  assert.equal(snapshot.source.coverage_errors.length, 0);
  assert.equal(snapshot.source.coverage_complete, false);
});

test("stops README requests after a rate limit but keeps topic analysis", async () => {
  let requestCount = 0;
  const readmes: RepositoryReadmeSource = {
    authenticated: false,
    async getReadme(): Promise<string | null> {
      requestCount += 1;
      throw new GitHubApiError(403, "rate limited", {
        endpoint: "/repos/owner/one/readme",
        rateLimited: true,
        retryAfterMs: 3_600_000,
      });
    },
  };
  const snapshot = await analyzeCandidates(
    candidateSnapshot([
      candidateRepository("owner/one", 1, { topics: ["ai-agents"] }),
      candidateRepository("owner/two", 2, { topics: ["machine-learning"] }),
    ]),
    readmes,
    { observedAt },
  );

  assert.equal(requestCount, 1);
  assert.equal(snapshot.repositories.length, 2);
  assert.deepEqual(
    snapshot.repositories.map(({ ai_relevance: relevance }) =>
      relevance.decision,
    ),
    ["ai-related", "ai-related"],
  );
  assert.equal(snapshot.source.coverage_errors.length, 2);
  assert.equal(
    snapshot.source.coverage_errors[1]?.message,
    "README request skipped after a GitHub rate limit.",
  );
});

test("GitHub README source decodes base64 content", async () => {
  const client = new GitHubClient({
    fetchImplementation: async () =>
      Response.json({
        encoding: "base64",
        content: Buffer.from("GraphRAG README").toString("base64"),
      }),
  });

  const readme = await githubReadmeSource(client).getReadme("owner/repository");

  assert.equal(readme, "GraphRAG README");
});

test("keyword census includes observations from repositories classified not AI", async () => {
  const snapshot = await analyzeCandidates(
    candidateSnapshot([
      candidateRepository("owner/security-tool", 1, {
        topics: ["security", "devsecops"],
        hasReadme: false,
      }),
    ]),
    stubReadmes({}),
    { observedAt },
  );

  assert.equal(snapshot.repositories[0]?.ai_relevance.decision, "not-ai");
  assert.equal(snapshot.keyword_census.repositories_analyzed, 1);
  assert.equal(snapshot.keyword_census.repositories_with_observations, 1);
  assert.equal(
    snapshot.keyword_census.keywords.some(
      ({ keyword_id: keyword }) => keyword === "security",
    ),
    true,
  );
});

test("keyword normalization treats object prototype names as strings", async () => {
  const snapshot = await analyzeCandidates(
    candidateSnapshot([
      candidateRepository("owner/constructor", 1, {
        topics: ["constructor"],
      }),
    ]),
    stubReadmes({}),
    { observedAt },
  );

  assert.equal(
    snapshot.repositories[0]?.observations[0]?.keyword_id,
    "constructor",
  );
});

test("analysis accepts a provider-neutral batch model classifier", async () => {
  const classifier: BatchModelAIClassifier = {
    kind: "model",
    version: "test-model-v1",
    identity: {
      provider: "test-provider",
      model: "test-model",
      promptVersion: "test-prompt-v1",
      methodologyVersion: "test-model-v1",
    },
    async classifyAll(inputs) {
      assert.deepEqual(inputs, [
        {
          repositoryId: 1,
          description: "A calendar automation tool.",
          topics: [],
        },
      ]);
      return {
        outcomes: [
          {
            kind: "success",
            source: "provider",
            repositoryId: 1,
            decision: "ai-related",
            evidence: "Uses AI to automate calendar workflows.",
          },
        ],
        stats: {
          identity: this.identity,
          transmittedFields: ["repository_id", "description", "topics"],
          eligible: 1,
          cacheHits: 0,
          providerDecisions: 1,
          invocations: 1,
          failed: 0,
          budgetExhausted: 0,
          complete: true,
        },
      };
    },
  };
  const snapshot = await analyzeCandidates(
    candidateSnapshot([
      candidateRepository("owner/repository", 1, {
        description: "A calendar automation tool.",
      }),
    ]),
    stubReadmes({
      "owner/repository": "Calendar automation README",
    }),
    { classifier, observedAt },
  );

  assert.equal(snapshot.source.classifier_kind, "model");
  assert.equal(snapshot.methodology_version, "test-model-v1");
  assert.equal(snapshot.repositories[0]?.ai_relevance.decision, "ai-related");
  assert.equal(
    snapshot.repositories[0]?.ai_relevance.model_evidence,
    "Uses AI to automate calendar workflows.",
  );
  assert.equal(
    JSON.stringify(snapshot).includes("Calendar automation README"),
    false,
  );
});

test("model analysis classifies every accessible rule bucket before selective README enrichment", async () => {
  const candidate = candidateSnapshot([
    candidateRepository("owner/rules-related", 1, {
      topics: ["machine-learning"],
    }),
    candidateRepository("owner/rules-review", 2, {
      description: "A transformer implementation.",
    }),
    candidateRepository("owner/rules-not-ai", 3, {
      description: "A calendar and task manager for small teams.",
    }),
  ]);
  candidate.repositories.push({
    full_name: "owner/unavailable",
    watch_events: 5,
    first_seen_at: "2026-08-01T00:00:00Z",
    last_seen_at: "2026-08-01T01:00:00Z",
    github: null,
  });
  const readmeValues = {
    "owner/rules-related": "RELATED_README_CANARY_7291 Graph RAG",
    "owner/rules-review": "REVIEW_README_CANARY_7291",
    "owner/rules-not-ai": "NOT_AI_README_CANARY_7291",
  };
  const rules = await analyzeCandidates(candidate, stubReadmes(readmeValues), {
    observedAt,
  });
  assert.deepEqual(
    rules.repositories.map(({ ai_relevance: relevance }) => relevance.decision),
    ["ai-related", "review", "not-ai", "unavailable"],
  );

  const classifiedInputs: unknown[] = [];
  const classifier: BatchModelAIClassifier = {
    kind: "model",
    version: "test-model-v1",
    identity: {
      provider: "test-provider",
      model: "test-model",
      promptVersion: "test-prompt-v1",
      methodologyVersion: "test-model-v1",
    },
    async classifyAll(inputs) {
      classifiedInputs.push(...inputs);
      return {
        outcomes: [
          {
            kind: "success",
            source: "provider",
            repositoryId: 1,
            decision: "ai-related",
            evidence: "The metadata describes a machine-learning project.",
          },
          {
            kind: "success",
            source: "provider",
            repositoryId: 2,
            decision: "review",
            evidence: "The transformer reference is insufficiently specific.",
          },
          {
            kind: "success",
            source: "provider",
            repositoryId: 3,
            decision: "not-ai",
            evidence: "The metadata describes ordinary productivity software.",
          },
        ],
        stats: {
          identity: this.identity,
          transmittedFields: ["repository_id", "description", "topics"],
          eligible: 3,
          cacheHits: 0,
          providerDecisions: 3,
          invocations: 1,
          failed: 0,
          budgetExhausted: 0,
          complete: true,
        },
      };
    },
  };
  const readmeRequests: string[] = [];
  const readmes: RepositoryReadmeSource = {
    authenticated: false,
    async getReadme(repository): Promise<string | null> {
      readmeRequests.push(repository);
      return readmeValues[repository as keyof typeof readmeValues] ?? null;
    },
  };

  const snapshot = await analyzeCandidates(candidate, readmes, {
    classifier,
    observedAt,
  });

  assert.deepEqual(classifiedInputs, [
    {
      repositoryId: 1,
      description: null,
      topics: ["machine-learning"],
    },
    {
      repositoryId: 2,
      description: "A transformer implementation.",
      topics: [],
    },
    {
      repositoryId: 3,
      description: "A calendar and task manager for small teams.",
      topics: [],
    },
  ]);
  assert.deepEqual(readmeRequests, [
    "owner/rules-related",
    "owner/rules-review",
  ]);
  assert.deepEqual(
    snapshot.repositories.map(({ ai_relevance: relevance }) =>
      relevance.decision,
    ),
    ["ai-related", "review", "not-ai", "unavailable"],
  );
  assert.deepEqual(snapshot.source.model_classification, {
    provider: "test-provider",
    model: "test-model",
    prompt_version: "test-prompt-v1",
    methodology_version: "test-model-v1",
    transmitted_fields: ["repository_id", "description", "topics"],
    eligible: 3,
    cache_hits: 0,
    provider_decisions: 3,
    invocations: 1,
    failed: 0,
    budget_exhausted: 0,
    complete: true,
  });
  assert.equal(
    snapshot.repositories[0]?.observations.some(
      ({ source }) => source === "readme",
    ),
    true,
  );
  assert.equal(
    snapshot.repositories[1]?.observations.some(
      ({ source }) => source === "readme",
    ),
    false,
  );
  assert.equal(
    snapshot.repositories[2]?.observations.some(
      ({ source }) => source === "readme",
    ),
    false,
  );
  const serialized = JSON.stringify(snapshot);
  assert.equal(serialized.includes("RELATED_README_CANARY_7291"), false);
  assert.equal(serialized.includes("REVIEW_README_CANARY_7291"), false);
  assert.equal(serialized.includes("NOT_AI_README_CANARY_7291"), false);
});

test("model analysis reuses one outcome for duplicate stable repository IDs", async () => {
  const candidate = candidateSnapshot([
    candidateRepository("owner/before-rename", 1, {
      description: "An AI project.",
    }),
    candidateRepository("owner/after-rename", 1, {
      description: "An AI project.",
    }),
  ]);
  let inputsSeen = 0;
  const classifier: BatchModelAIClassifier = {
    kind: "model",
    version: "test-model-v1",
    identity: {
      provider: "test-provider",
      model: "test-model",
      promptVersion: "test-prompt-v1",
      methodologyVersion: "test-model-v1",
    },
    async classifyAll(inputs) {
      inputsSeen = inputs.length;
      return {
        outcomes: [{
          kind: "success",
          source: "provider",
          repositoryId: 1,
          decision: "not-ai",
          evidence: "The metadata is not primarily AI-related.",
        }],
        stats: {
          identity: this.identity,
          transmittedFields: ["repository_id", "description", "topics"],
          eligible: 1,
          cacheHits: 0,
          providerDecisions: 1,
          invocations: 1,
          failed: 0,
          budgetExhausted: 0,
          complete: true,
        },
      };
    },
  };

  const snapshot = await analyzeCandidates(candidate, stubReadmes({}), {
    classifier,
    observedAt,
  });

  assert.equal(inputsSeen, 1);
  assert.deepEqual(
    snapshot.repositories.map(({ ai_relevance }) => ai_relevance.decision),
    ["not-ai", "not-ai"],
  );
});

test("model analysis rejects contradictory provider provenance", async () => {
  const candidate = candidateSnapshot([
    candidateRepository("owner/repository", 1),
  ]);
  const classifier: BatchModelAIClassifier = {
    kind: "model",
    version: "test-model-v1",
    identity: {
      provider: "test-provider",
      model: "test-model",
      promptVersion: "test-prompt-v1",
      methodologyVersion: "test-model-v1",
    },
    async classifyAll() {
      return {
        outcomes: [{
          kind: "success",
          source: "provider",
          repositoryId: 1,
          decision: "ai-related",
          evidence: "AI metadata.",
        }],
        stats: {
          identity: { ...this.identity, model: "different-model" },
          transmittedFields: ["repository_id", "description", "topics"],
          eligible: 1,
          cacheHits: 0,
          providerDecisions: 1,
          invocations: 1,
          failed: 0,
          budgetExhausted: 0,
          complete: true,
        },
      };
    },
  };

  await assert.rejects(
    analyzeCandidates(candidate, stubReadmes({}), {
      classifier,
      observedAt,
    }),
    /identity is inconsistent/,
  );
});

test("model failures remain unavailable with typed coverage and no README request", async () => {
  const candidate = candidateSnapshot([
    candidateRepository("owner/repository", 1, {
      description: "Unclassified repository.",
    }),
  ]);
  const classifier: BatchModelAIClassifier = {
    kind: "model",
    version: "test-model-v1",
    identity: {
      provider: "test-provider",
      model: "test-model",
      promptVersion: "test-prompt-v1",
      methodologyVersion: "test-model-v1",
    },
    async classifyAll() {
      return {
        outcomes: [{
          kind: "failure",
          repositoryId: 1,
          code: "model-budget-exhausted",
        }],
        stats: {
          identity: this.identity,
          transmittedFields: ["repository_id", "description", "topics"],
          eligible: 1,
          cacheHits: 0,
          providerDecisions: 0,
          invocations: 0,
          failed: 0,
          budgetExhausted: 1,
          complete: false,
        },
      };
    },
  };
  const readmeRequests: string[] = [];
  const snapshot = await analyzeCandidates(candidate, {
    authenticated: false,
    async getReadme(repository) {
      readmeRequests.push(repository);
      return "README";
    },
  }, { classifier, observedAt });

  assert.equal(
    snapshot.repositories[0]?.ai_relevance.decision,
    "unavailable",
  );
  assert.deepEqual(readmeRequests, []);
  assert.deepEqual(snapshot.source.coverage_errors, [{
    source: "model",
    target: "repository:1",
    status: null,
    code: "model-budget-exhausted",
    message: "Model classification invocation budget was exhausted.",
  }]);
  assert.equal(snapshot.source.coverage_complete, false);
});
