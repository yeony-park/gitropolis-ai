import { createHash } from "node:crypto";

import { redactSecrets } from "./security/redact.js";

export const MODEL_CLASSIFICATION_CACHE_SCHEMA =
  "ai-relevance-cache-v1" as const;
export const MODEL_CLASSIFICATION_REQUEST_SCHEMA =
  "ai-relevance-batch-request-v1" as const;
export const MODEL_CLASSIFICATION_RESPONSE_SCHEMA =
  "ai-relevance-batch-response-v1" as const;
export const MODEL_CLASSIFICATION_PROMPT_VERSION =
  "ai-relevance-prompt-v1" as const;
export const MODEL_CLASSIFICATION_METHODOLOGY_VERSION =
  "ai-relevance-model-v1" as const;

const MAX_EVIDENCE_CHARACTERS = 500;
const TRANSMITTED_FIELDS = [
  "repository_id",
  "description",
  "topics",
] as const;

const CLASSIFICATION_INSTRUCTIONS = `Classify whether each repository is primarily an AI or machine-learning project from its description and topics. Use "review" when the evidence is genuinely uncertain. Return only one JSON object with schema_version "${MODEL_CLASSIFICATION_RESPONSE_SCHEMA}" and a repositories array. Every item must contain exactly repository_id, decision, and evidence. decision must be "ai-related", "review", or "not-ai". evidence must be a concise non-empty explanation of at most ${MAX_EVIDENCE_CHARACTERS} characters. Return exactly one item for every requested repository ID and no other IDs.`;

export type ModelAIDecision = "ai-related" | "review" | "not-ai";

export interface ModelClassificationInput {
  repositoryId: number;
  description: string | null;
  topics: readonly string[];
}

export interface NormalizedModelClassificationInput {
  repositoryId: number;
  description: string | null;
  topics: string[];
}

export interface ModelClassificationIdentity {
  provider: string;
  model: string;
  promptVersion: string;
  methodologyVersion: string;
}

export interface ModelClassificationDecision {
  repositoryId: number;
  decision: ModelAIDecision;
  evidence: string;
}

export type ModelClassificationFailureCode =
  | "model-request-failed"
  | "model-response-invalid"
  | "model-budget-exhausted";

export type ModelClassificationOutcome =
  | ({ kind: "success"; source: "cache" | "provider" } &
      ModelClassificationDecision)
  | {
      kind: "failure";
      repositoryId: number;
      code: ModelClassificationFailureCode;
    };

export interface ModelClassificationRun {
  outcomes: ModelClassificationOutcome[];
  stats: {
    identity: ModelClassificationIdentity;
    transmittedFields: readonly [
      "repository_id",
      "description",
      "topics",
    ];
    eligible: number;
    cacheHits: number;
    providerDecisions: number;
    invocations: number;
    failed: number;
    budgetExhausted: number;
    complete: boolean;
  };
}

export interface BatchModelAIClassifier {
  readonly kind: "model";
  readonly version: string;
  readonly identity: ModelClassificationIdentity;
  classifyAll(
    inputs: readonly ModelClassificationInput[],
  ): Promise<ModelClassificationRun>;
}

export interface ModelClassificationBatchRequest {
  schema_version: typeof MODEL_CLASSIFICATION_REQUEST_SCHEMA;
  task: {
    prompt_version: string;
    instructions: string;
  };
  classifier: {
    provider: string;
    model: string;
    methodology_version: string;
  };
  repositories: Array<{
    repository_id: number;
    description: string | null;
    topics: string[];
  }>;
}

export interface ModelClassificationProvider {
  invoke(request: ModelClassificationBatchRequest): Promise<unknown>;
}

export class ModelClassificationResponseError extends Error {
  constructor() {
    super("Model classification response was invalid.");
    this.name = "ModelClassificationResponseError";
  }
}

export interface ModelClassificationCacheEntry {
  repository_id: number;
  metadata_hash: string;
  provider: string;
  model: string;
  prompt_version: string;
  methodology_version: string;
  decision: ModelAIDecision;
  evidence: string;
}

export interface ModelClassificationCache {
  schema_version: typeof MODEL_CLASSIFICATION_CACHE_SCHEMA;
  entries: Record<string, ModelClassificationCacheEntry>;
}

export interface ModelClassificationCacheStore {
  load(): Promise<ModelClassificationCache>;
  save(cache: ModelClassificationCache): Promise<void>;
}

export interface CachedModelClassifierOptions {
  provider: ModelClassificationProvider;
  cache: ModelClassificationCacheStore;
  identity: ModelClassificationIdentity;
  batchSize?: number;
  invocationBudget?: number;
  maxRetries?: number;
  secrets?: readonly (string | undefined)[];
}

export interface ParsedModelBatchResponse {
  successes: ModelClassificationDecision[];
  invalidRepositoryIds: number[];
  rootValid: boolean;
}

export function emptyModelClassificationCache(): ModelClassificationCache {
  return {
    schema_version: MODEL_CLASSIFICATION_CACHE_SCHEMA,
    entries: {},
  };
}

export function normalizeModelClassificationInput(
  input: ModelClassificationInput,
): NormalizedModelClassificationInput {
  if (!Number.isSafeInteger(input.repositoryId) || input.repositoryId < 1) {
    throw new Error("Model classification repository ID must be positive.");
  }
  const description = normalizeText(input.description ?? "");
  const topics = [
    ...new Set(
      input.topics
        .map((topic) => normalizeText(topic).toLowerCase())
        .filter(Boolean),
    ),
  ].sort(compareText);
  return {
    repositoryId: input.repositoryId,
    description: description || null,
    topics,
  };
}

export function modelClassificationMetadataHash(
  input: ModelClassificationInput,
): string {
  const normalized = normalizeModelClassificationInput(input);
  return digest(
    JSON.stringify({
      schema: "ai-relevance-metadata-v1",
      description: normalized.description,
      topics: normalized.topics,
    }),
  );
}

export function modelClassificationCacheKey(
  input: ModelClassificationInput,
  identity: ModelClassificationIdentity,
): string {
  return modelClassificationCacheKeyFromParts(
    input.repositoryId,
    modelClassificationMetadataHash(input),
    identity,
  );
}

export function modelClassificationCacheKeyFromParts(
  repositoryId: number,
  metadataHash: string,
  identity: ModelClassificationIdentity,
): string {
  if (!Number.isSafeInteger(repositoryId) || repositoryId < 1) {
    throw new Error("Model classification repository ID must be positive.");
  }
  if (!isSha256(metadataHash)) {
    throw new Error("Model classification metadata hash is invalid.");
  }
  const normalizedIdentity = normalizeIdentity(identity);
  return digest(
    JSON.stringify({
      schema: "ai-relevance-cache-key-v1",
      repository_id: String(repositoryId),
      metadata_hash: metadataHash,
      provider: normalizedIdentity.provider,
      model: normalizedIdentity.model,
      prompt_version: normalizedIdentity.promptVersion,
      methodology_version: normalizedIdentity.methodologyVersion,
    }),
  );
}

export function parseModelBatchResponse(
  value: unknown,
  requestedRepositoryIds: readonly number[],
): ParsedModelBatchResponse {
  const requested = new Set(requestedRepositoryIds);
  if (
    requested.size !== requestedRepositoryIds.length ||
    requestedRepositoryIds.some(
      (id) => !Number.isSafeInteger(id) || id < 1,
    )
  ) {
    throw new Error("Requested model repository IDs must be unique and positive.");
  }
  if (
    !isExactRecord(value, ["schema_version", "repositories"]) ||
    value.schema_version !== MODEL_CLASSIFICATION_RESPONSE_SCHEMA ||
    !Array.isArray(value.repositories)
  ) {
    return {
      successes: [],
      invalidRepositoryIds: [...requestedRepositoryIds],
      rootValid: false,
    };
  }

  const successesById = new Map<number, ModelClassificationDecision>();
  const invalid = new Set<number>();
  let unexpectedId = false;
  for (const item of value.repositories) {
    const repositoryId =
      isRecord(item) && Number.isSafeInteger(item.repository_id)
        ? (item.repository_id as number)
        : null;
    if (repositoryId !== null && !requested.has(repositoryId)) {
      unexpectedId = true;
      continue;
    }
    if (
      repositoryId === null ||
      !isExactRecord(item, ["repository_id", "decision", "evidence"]) ||
      !isModelDecision(item.decision) ||
      typeof item.evidence !== "string"
    ) {
      if (repositoryId !== null) {
        invalid.add(repositoryId);
      }
      continue;
    }
    const evidence = normalizeText(item.evidence);
    if (!evidence || evidence.length > MAX_EVIDENCE_CHARACTERS) {
      invalid.add(repositoryId);
      continue;
    }
    if (successesById.has(repositoryId)) {
      successesById.delete(repositoryId);
      invalid.add(repositoryId);
      continue;
    }
    successesById.set(repositoryId, {
      repositoryId,
      decision: item.decision,
      evidence,
    });
  }

  if (unexpectedId) {
    return {
      successes: [],
      invalidRepositoryIds: [...requestedRepositoryIds],
      rootValid: false,
    };
  }
  for (const repositoryId of requestedRepositoryIds) {
    if (!successesById.has(repositoryId)) {
      invalid.add(repositoryId);
    }
  }
  for (const repositoryId of invalid) {
    successesById.delete(repositoryId);
  }
  return {
    successes: requestedRepositoryIds.flatMap((repositoryId) => {
      const success = successesById.get(repositoryId);
      return success ? [success] : [];
    }),
    invalidRepositoryIds: requestedRepositoryIds.filter((repositoryId) =>
      invalid.has(repositoryId),
    ),
    rootValid: true,
  };
}

export function createCachedModelAIClassifier(
  options: CachedModelClassifierOptions,
): BatchModelAIClassifier {
  const identity = normalizeIdentity(options.identity);
  const batchSize = options.batchSize ?? 25;
  const invocationBudget = options.invocationBudget ?? 10;
  const maxRetries = options.maxRetries ?? 1;
  validateRunOptions(batchSize, invocationBudget, maxRetries);

  return {
    kind: "model",
    version: identity.methodologyVersion,
    identity,
    async classifyAll(inputs): Promise<ModelClassificationRun> {
      const normalizedInputs = inputs.map(normalizeModelClassificationInput);
      assertUniqueRepositoryIds(normalizedInputs);
      const cache = await options.cache.load();
      const outcomes = new Map<number, ModelClassificationOutcome>();
      const misses: NormalizedModelClassificationInput[] = [];
      let cacheHits = 0;
      let providerDecisions = 0;
      let invocations = 0;
      let cacheSanitized = false;

      for (const input of normalizedInputs) {
        const key = modelClassificationCacheKey(input, identity);
        const cached = cache.entries[key];
        if (cached) {
          const evidence = sanitizeModelEvidence(
            cached.evidence,
            options.secrets ?? [],
          );
          if (evidence !== cached.evidence) {
            cache.entries[key] = { ...cached, evidence };
            cacheSanitized = true;
          }
          cacheHits += 1;
          outcomes.set(input.repositoryId, {
            kind: "success",
            source: "cache",
            repositoryId: input.repositoryId,
            decision: cached.decision,
            evidence,
          });
        } else {
          misses.push(input);
        }
      }
      if (cacheSanitized) {
        await options.cache.save(cache);
      }

      for (let offset = 0; offset < misses.length; offset += batchSize) {
        const batch = misses.slice(offset, offset + batchSize);
        if (invocations >= invocationBudget) {
          recordFailures(batch, "model-budget-exhausted", outcomes);
          continue;
        }

        let unresolved = batch;
        let lastFailure: Exclude<
          ModelClassificationFailureCode,
          "model-budget-exhausted"
        > = "model-response-invalid";
        for (let attempt = 0; unresolved.length > 0; attempt += 1) {
          if (invocations >= invocationBudget) {
            recordFailures(unresolved, "model-budget-exhausted", outcomes);
            unresolved = [];
            break;
          }
          invocations += 1;
          let response: unknown;
          try {
            response = await options.provider.invoke(
              classificationRequest(unresolved, identity),
            );
          } catch (error) {
            lastFailure =
              error instanceof ModelClassificationResponseError
                ? "model-response-invalid"
                : "model-request-failed";
            if (attempt >= maxRetries) {
              recordFailures(unresolved, lastFailure, outcomes);
              unresolved = [];
            }
            continue;
          }

          const parsed = parseModelBatchResponse(
            response,
            unresolved.map(({ repositoryId }) => repositoryId),
          );
          const byId = new Map(
            unresolved.map((input) => [input.repositoryId, input]),
          );
          for (const parsedSuccess of parsed.successes) {
            const success = {
              ...parsedSuccess,
              evidence: sanitizeModelEvidence(
                parsedSuccess.evidence,
                options.secrets ?? [],
              ),
            };
            const input = byId.get(success.repositoryId);
            if (!input) {
              continue;
            }
            providerDecisions += 1;
            outcomes.set(success.repositoryId, {
              kind: "success",
              source: "provider",
              ...success,
            });
            const metadataHash = modelClassificationMetadataHash(input);
            const key = modelClassificationCacheKeyFromParts(
              input.repositoryId,
              metadataHash,
              identity,
            );
            cache.entries[key] = {
              repository_id: input.repositoryId,
              metadata_hash: metadataHash,
              provider: identity.provider,
              model: identity.model,
              prompt_version: identity.promptVersion,
              methodology_version: identity.methodologyVersion,
              decision: success.decision,
              evidence: success.evidence,
            };
          }
          if (parsed.successes.length > 0) {
            await options.cache.save(cache);
          }
          lastFailure = "model-response-invalid";
          unresolved = parsed.invalidRepositoryIds.flatMap((repositoryId) => {
            const input = byId.get(repositoryId);
            return input ? [input] : [];
          });
          if (unresolved.length > 0 && attempt >= maxRetries) {
            recordFailures(unresolved, lastFailure, outcomes);
            unresolved = [];
          }
        }
      }

      const orderedOutcomes = normalizedInputs.map((input) => {
        const outcome = outcomes.get(input.repositoryId);
        if (!outcome) {
          throw new Error("Model classification did not produce an outcome.");
        }
        return outcome;
      });
      const failed = orderedOutcomes.filter(
        (outcome) =>
          outcome.kind === "failure" &&
          outcome.code !== "model-budget-exhausted",
      ).length;
      const budgetExhausted = orderedOutcomes.filter(
        (outcome) =>
          outcome.kind === "failure" &&
          outcome.code === "model-budget-exhausted",
      ).length;
      return {
        outcomes: orderedOutcomes,
        stats: {
          identity,
          transmittedFields: TRANSMITTED_FIELDS,
          eligible: normalizedInputs.length,
          cacheHits,
          providerDecisions,
          invocations,
          failed,
          budgetExhausted,
          complete: failed === 0 && budgetExhausted === 0,
        },
      };
    },
  };
}

export function isModelDecision(value: unknown): value is ModelAIDecision {
  return value === "ai-related" || value === "review" || value === "not-ai";
}

export function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value);
}

export function normalizeModelEvidence(value: string): string {
  return normalizeText(value);
}

function classificationRequest(
  inputs: readonly NormalizedModelClassificationInput[],
  identity: ModelClassificationIdentity,
): ModelClassificationBatchRequest {
  return {
    schema_version: MODEL_CLASSIFICATION_REQUEST_SCHEMA,
    task: {
      prompt_version: identity.promptVersion,
      instructions: CLASSIFICATION_INSTRUCTIONS,
    },
    classifier: {
      provider: identity.provider,
      model: identity.model,
      methodology_version: identity.methodologyVersion,
    },
    repositories: inputs.map((input) => ({
      repository_id: input.repositoryId,
      description: input.description,
      topics: [...input.topics],
    })),
  };
}

function normalizeIdentity(
  identity: ModelClassificationIdentity,
): ModelClassificationIdentity {
  const normalized = {
    provider: identity.provider.trim(),
    model: identity.model.trim(),
    promptVersion: identity.promptVersion.trim(),
    methodologyVersion: identity.methodologyVersion.trim(),
  };
  if (Object.values(normalized).some((value) => !value || value.length > 200)) {
    throw new Error(
      "Model provider, model, prompt version, and methodology version must be 1-200 characters.",
    );
  }
  return normalized;
}

function validateRunOptions(
  batchSize: number,
  invocationBudget: number,
  maxRetries: number,
): void {
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 100) {
    throw new Error("Model batch size must be between 1 and 100.");
  }
  if (
    !Number.isInteger(invocationBudget) ||
    invocationBudget < 0 ||
    invocationBudget > 10_000
  ) {
    throw new Error("Model invocation budget must be between 0 and 10000.");
  }
  if (!Number.isInteger(maxRetries) || maxRetries < 0 || maxRetries > 2) {
    throw new Error("Model retries must be between 0 and 2.");
  }
}

function assertUniqueRepositoryIds(
  inputs: readonly NormalizedModelClassificationInput[],
): void {
  const ids = new Set<number>();
  for (const input of inputs) {
    if (ids.has(input.repositoryId)) {
      throw new Error(`Duplicate model repository ID: ${input.repositoryId}`);
    }
    ids.add(input.repositoryId);
  }
}

function recordFailures(
  inputs: readonly NormalizedModelClassificationInput[],
  code: ModelClassificationFailureCode,
  outcomes: Map<number, ModelClassificationOutcome>,
): void {
  for (const input of inputs) {
    outcomes.set(input.repositoryId, {
      kind: "failure",
      repositoryId: input.repositoryId,
      code,
    });
  }
}

function digest(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function normalizeText(value: string): string {
  return value.normalize("NFKC").replaceAll(/\s+/gu, " ").trim();
}

function sanitizeModelEvidence(
  value: string,
  secrets: readonly (string | undefined)[],
): string {
  return normalizeText(redactSecrets(value, secrets))
    .slice(0, MAX_EVIDENCE_CHARACTERS)
    .trim();
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isExactRecord(
  value: unknown,
  keys: readonly string[],
): value is Record<string, unknown> {
  return (
    isRecord(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}
