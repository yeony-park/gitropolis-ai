import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp } from "node:fs/promises";
import { test } from "node:test";

import {
  MODEL_CLASSIFICATION_METHODOLOGY_VERSION,
  MODEL_CLASSIFICATION_PROMPT_VERSION,
  MODEL_CLASSIFICATION_RESPONSE_SCHEMA,
  ModelClassificationResponseError,
  createCachedModelAIClassifier,
  modelClassificationCacheKey,
  modelClassificationMetadataHash,
  normalizeModelClassificationInput,
  parseModelBatchResponse,
  type ModelClassificationBatchRequest,
  type ModelClassificationIdentity,
  type ModelClassificationInput,
  type ModelClassificationProvider,
} from "../src/model-classification.js";
import { FileModelClassificationCache } from "../src/model-classification-file.js";

const identity: ModelClassificationIdentity = {
  provider: "test-provider",
  model: "test-model",
  promptVersion: MODEL_CLASSIFICATION_PROMPT_VERSION,
  methodologyVersion: MODEL_CLASSIFICATION_METHODOLOGY_VERSION,
};

class StubProvider implements ModelClassificationProvider {
  readonly requests: ModelClassificationBatchRequest[] = [];

  constructor(
    private readonly handler: (
      request: ModelClassificationBatchRequest,
      invocation: number,
    ) => Promise<unknown> | unknown,
  ) {}

  async invoke(request: ModelClassificationBatchRequest): Promise<unknown> {
    this.requests.push(request);
    return await this.handler(request, this.requests.length);
  }
}

function input(
  repositoryId: number,
  description = `Repository ${repositoryId}`,
  topics: string[] = ["ai"],
): ModelClassificationInput {
  return { repositoryId, description, topics };
}

function response(
  repositories: Array<{
    repository_id: number;
    decision: "ai-related" | "review" | "not-ai";
    evidence: string;
  }>,
): unknown {
  return {
    schema_version: MODEL_CLASSIFICATION_RESPONSE_SCHEMA,
    repositories,
  };
}

function successResponse(
  request: ModelClassificationBatchRequest,
): unknown {
  return response(
    request.repositories.map(({ repository_id: repositoryId }) => ({
      repository_id: repositoryId,
      decision: repositoryId % 3 === 0 ? "not-ai" : "ai-related",
      evidence: `Decision for repository ${repositoryId}.`,
    })),
  );
}

async function cachePath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "gitropolis-model-cache-"));
  return join(directory, "cache.json");
}

test("normalizes exactly the metadata used for deterministic cache keys", () => {
  const first = input(1, "  A\r\n calendar   agent  ", [
    "Machine-Learning",
    " ai ",
    "AI",
  ]);
  const equivalent = input(1, "A calendar agent", [
    "ai",
    "machine-learning",
  ]);
  const changed = input(1, "A calendar AI agent", [
    "ai",
    "machine-learning",
  ]);

  assert.deepEqual(normalizeModelClassificationInput(first), {
    repositoryId: 1,
    description: "A calendar agent",
    topics: ["ai", "machine-learning"],
  });
  assert.equal(
    modelClassificationMetadataHash(first),
    modelClassificationMetadataHash(equivalent),
  );
  assert.equal(
    modelClassificationCacheKey(first, identity),
    modelClassificationCacheKey(equivalent, identity),
  );
  assert.notEqual(
    modelClassificationCacheKey(first, identity),
    modelClassificationCacheKey(changed, identity),
  );

  for (const changedIdentity of [
    { ...identity, provider: "another-provider" },
    { ...identity, model: "another-model" },
    { ...identity, promptVersion: "another-prompt" },
    { ...identity, methodologyVersion: "another-methodology" },
  ]) {
    assert.notEqual(
      modelClassificationCacheKey(first, identity),
      modelClassificationCacheKey(first, changedIdentity),
    );
  }
  assert.notEqual(
    modelClassificationCacheKey(first, identity),
    modelClassificationCacheKey({ ...first, repositoryId: 2 }, identity),
  );
});

test("strictly parses model decisions and isolates invalid requested items", () => {
  assert.deepEqual(
    parseModelBatchResponse(
      response([
        {
          repository_id: 1,
          decision: "ai-related",
          evidence: "  Uses an LLM.  ",
        },
        { repository_id: 2, decision: "review", evidence: "Uncertain." },
        { repository_id: 3, decision: "not-ai", evidence: "No AI use." },
      ]),
      [1, 2, 3],
    ),
    {
      successes: [
        { repositoryId: 1, decision: "ai-related", evidence: "Uses an LLM." },
        { repositoryId: 2, decision: "review", evidence: "Uncertain." },
        { repositoryId: 3, decision: "not-ai", evidence: "No AI use." },
      ],
      invalidRepositoryIds: [],
      rootValid: true,
    },
  );

  const partial = parseModelBatchResponse(
    {
      schema_version: MODEL_CLASSIFICATION_RESPONSE_SCHEMA,
      repositories: [
        { repository_id: 1, decision: "ai-related", evidence: "Valid." },
        { repository_id: 2, decision: "unavailable", evidence: "Invalid." },
      ],
    },
    [1, 2, 3],
  );
  assert.deepEqual(partial.successes, [
    { repositoryId: 1, decision: "ai-related", evidence: "Valid." },
  ]);
  assert.deepEqual(partial.invalidRepositoryIds, [2, 3]);
  assert.equal(partial.rootValid, true);

  for (const invalid of [
    "not json",
    { repositories: [] },
    {
      schema_version: MODEL_CLASSIFICATION_RESPONSE_SCHEMA,
      repositories: [
        { repository_id: 99, decision: "not-ai", evidence: "Unexpected." },
      ],
    },
  ]) {
    const parsed = parseModelBatchResponse(invalid, [1]);
    assert.deepEqual(parsed.successes, []);
    assert.deepEqual(parsed.invalidRepositoryIds, [1]);
    assert.equal(parsed.rootValid, false);
  }
});

test("batches all inputs and reuses cached decisions without model calls", async () => {
  const path = await cachePath();
  const provider = new StubProvider(successResponse);
  const firstClassifier = createCachedModelAIClassifier({
    provider,
    cache: new FileModelClassificationCache(path),
    identity,
    batchSize: 2,
    invocationBudget: 2,
    maxRetries: 0,
  });
  const inputs = [input(1), input(2), input(3)];
  const first = await firstClassifier.classifyAll(inputs);

  assert.deepEqual(
    provider.requests.map((request) => request.repositories.length),
    [2, 1],
  );
  assert.equal(first.stats.cacheHits, 0);
  assert.equal(first.stats.providerDecisions, 3);
  assert.equal(first.stats.complete, true);
  assert.deepEqual(
    provider.requests.flatMap((request) =>
      request.repositories.map(({ repository_id: id }) => id),
    ),
    [1, 2, 3],
  );
  assert.deepEqual(Object.keys(provider.requests[0]?.repositories[0] ?? {}), [
    "repository_id",
    "description",
    "topics",
  ]);

  const forbiddenProvider = new StubProvider(() => {
    throw new Error("cache hit unexpectedly invoked the provider");
  });
  const cached = await createCachedModelAIClassifier({
    provider: forbiddenProvider,
    cache: new FileModelClassificationCache(path),
    identity,
    invocationBudget: 0,
  }).classifyAll(inputs);

  assert.equal(forbiddenProvider.requests.length, 0);
  assert.equal(cached.stats.cacheHits, 3);
  assert.equal(cached.stats.providerDecisions, 0);
  assert.equal(cached.stats.complete, true);
  assert.deepEqual(
    cached.outcomes.map((outcome) =>
      outcome.kind === "success" ? outcome.source : outcome.code,
    ),
    ["cache", "cache", "cache"],
  );
});

test("invalidates only changed metadata", async () => {
  const path = await cachePath();
  const firstProvider = new StubProvider(successResponse);
  const original = [
    input(1, "First description", ["AI", "agents"]),
    input(2, "Second description", ["ML"]),
  ];
  await createCachedModelAIClassifier({
    provider: firstProvider,
    cache: new FileModelClassificationCache(path),
    identity,
  }).classifyAll(original);

  const secondProvider = new StubProvider(successResponse);
  const rerun = await createCachedModelAIClassifier({
    provider: secondProvider,
    cache: new FileModelClassificationCache(path),
    identity,
  }).classifyAll([
    input(1, " First\n description ", ["agents", "ai", "AI"]),
    input(2, "Second changed description", ["ml"]),
  ]);

  assert.equal(rerun.stats.cacheHits, 1);
  assert.equal(rerun.stats.providerDecisions, 1);
  assert.deepEqual(
    secondProvider.requests.flatMap((request) =>
      request.repositories.map(({ repository_id: id }) => id),
    ),
    [2],
  );
});

test("fails closed on a corrupt cache before invoking the provider", async () => {
  const path = await cachePath();
  const original = "{not-json";
  await writeFile(path, original, "utf8");
  const provider = new StubProvider(successResponse);
  const classifier = createCachedModelAIClassifier({
    provider,
    cache: new FileModelClassificationCache(path),
    identity,
  });

  await assert.rejects(
    classifier.classifyAll([input(1)]),
    /Invalid AI relevance cache/,
  );
  assert.equal(provider.requests.length, 0);
  assert.equal(await readFile(path, "utf8"), original);
});

test("persists valid siblings and resumes only an invalid item", async () => {
  const path = await cachePath();
  const firstProvider = new StubProvider(() =>
    response([
      { repository_id: 1, decision: "ai-related", evidence: "Valid one." },
      { repository_id: 2, decision: "review", evidence: "" },
      { repository_id: 3, decision: "not-ai", evidence: "Valid three." },
    ]),
  );
  const inputs = [input(1), input(2), input(3)];
  const first = await createCachedModelAIClassifier({
    provider: firstProvider,
    cache: new FileModelClassificationCache(path),
    identity,
    maxRetries: 0,
  }).classifyAll(inputs);

  assert.deepEqual(
    first.outcomes.map((outcome) =>
      outcome.kind === "success" ? outcome.decision : outcome.code,
    ),
    ["ai-related", "model-response-invalid", "not-ai"],
  );
  assert.equal(first.stats.failed, 1);

  const resumeProvider = new StubProvider((request) =>
    response(
      request.repositories.map(({ repository_id: repositoryId }) => ({
        repository_id: repositoryId,
        decision: "review",
        evidence: "Resolved on resume.",
      })),
    ),
  );
  const resumed = await createCachedModelAIClassifier({
    provider: resumeProvider,
    cache: new FileModelClassificationCache(path),
    identity,
    maxRetries: 0,
  }).classifyAll(inputs);

  assert.deepEqual(
    resumeProvider.requests.flatMap((request) =>
      request.repositories.map(({ repository_id: id }) => id),
    ),
    [2],
  );
  assert.equal(resumed.stats.cacheHits, 2);
  assert.equal(resumed.stats.providerDecisions, 1);
  assert.equal(resumed.stats.complete, true);
});

test("marks untouched misses as budget exhausted and resumes them", async () => {
  const path = await cachePath();
  const provider = new StubProvider(successResponse);
  const inputs = [input(1), input(2), input(3)];
  const first = await createCachedModelAIClassifier({
    provider,
    cache: new FileModelClassificationCache(path),
    identity,
    batchSize: 2,
    invocationBudget: 1,
    maxRetries: 1,
  }).classifyAll(inputs);

  assert.equal(provider.requests.length, 1);
  assert.deepEqual(
    first.outcomes.map((outcome) =>
      outcome.kind === "success" ? outcome.decision : outcome.code,
    ),
    ["ai-related", "ai-related", "model-budget-exhausted"],
  );
  assert.equal(first.stats.budgetExhausted, 1);

  const resumeProvider = new StubProvider(successResponse);
  const resumed = await createCachedModelAIClassifier({
    provider: resumeProvider,
    cache: new FileModelClassificationCache(path),
    identity,
    invocationBudget: 1,
  }).classifyAll(inputs);
  assert.equal(resumed.stats.cacheHits, 2);
  assert.deepEqual(
    resumeProvider.requests[0]?.repositories.map(
      ({ repository_id: id }) => id,
    ),
    [3],
  );
  assert.equal(resumed.stats.complete, true);
});

test("distinguishes invalid responses from transport failures", async () => {
  for (const [error, expectedCode] of [
    [
      new ModelClassificationResponseError(),
      "model-response-invalid",
    ],
    [new Error("transport unavailable"), "model-request-failed"],
  ] as const) {
    const provider = new StubProvider(() => {
      throw error;
    });
    const run = await createCachedModelAIClassifier({
      provider,
      cache: new FileModelClassificationCache(await cachePath()),
      identity,
      maxRetries: 0,
    }).classifyAll([input(1)]);

    assert.deepEqual(run.outcomes, [{
      kind: "failure",
      repositoryId: 1,
      code: expectedCode,
    }]);
  }
});

test("cache stores redacted decisions without raw classification metadata", async () => {
  const path = await cachePath();
  const description = "RAW_DESCRIPTION_CANARY_8142";
  const topic = "RAW_TOPIC_CANARY_8142";
  const secret = "MODEL_SECRET_CANARY_8142";
  const provider = new StubProvider((request) =>
    response(
      request.repositories.map(({ repository_id: repositoryId }) => ({
        repository_id: repositoryId,
        decision: "review",
        evidence: `Evidence is uncertain. Authorization: Bearer ${secret}`,
      })),
    ),
  );
  const run = await createCachedModelAIClassifier({
    provider,
    cache: new FileModelClassificationCache(path),
    identity,
    secrets: [secret],
  }).classifyAll([input(1, description, [topic])]);

  const cache = await readFile(path, "utf8");
  assert.equal(cache.includes(description), false);
  assert.equal(cache.includes(topic.toLowerCase()), false);
  assert.equal(cache.includes(secret), false);
  assert.equal(cache.includes("Bearer [REDACTED]"), true);
  assert.equal(
    run.outcomes[0]?.kind === "success" &&
      run.outcomes[0].evidence.includes(secret),
    false,
  );
  assert.equal(cache.includes("readme"), false);
});
