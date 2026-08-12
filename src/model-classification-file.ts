import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

import {
  MODEL_CLASSIFICATION_CACHE_SCHEMA,
  emptyModelClassificationCache,
  isModelDecision,
  isSha256,
  modelClassificationCacheKeyFromParts,
  normalizeModelEvidence,
  type ModelClassificationCache,
  type ModelClassificationCacheEntry,
  type ModelClassificationCacheStore,
} from "./model-classification.js";

export function defaultModelClassificationCachePath(
  projectDirectory: string,
): string {
  return join(
    resolve(projectDirectory),
    ".gitropolis",
    "cache",
    "ai-relevance-v1.json",
  );
}

export class FileModelClassificationCache
  implements ModelClassificationCacheStore
{
  private readonly path: string;

  constructor(path: string) {
    this.path = resolve(path);
  }

  async load(): Promise<ModelClassificationCache> {
    let text: string;
    try {
      text = await readFile(this.path, "utf8");
    } catch (error) {
      if (isMissingFile(error)) {
        return emptyModelClassificationCache();
      }
      throw error;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      throw invalidCacheError(this.path);
    }
    if (
      !isExactRecord(parsed, ["schema_version", "entries"]) ||
      parsed.schema_version !== MODEL_CLASSIFICATION_CACHE_SCHEMA ||
      !isRecord(parsed.entries)
    ) {
      throw invalidCacheError(this.path);
    }

    const entries: Record<string, ModelClassificationCacheEntry> = {};
    for (const [key, value] of Object.entries(parsed.entries)) {
      const entry = parseEntry(value);
      if (!entry || expectedEntryKey(entry) !== key) {
        throw invalidCacheError(this.path);
      }
      entries[key] = entry;
    }
    return {
      schema_version: MODEL_CLASSIFICATION_CACHE_SCHEMA,
      entries,
    };
  }

  async save(cache: ModelClassificationCache): Promise<void> {
    if (cache.schema_version !== MODEL_CLASSIFICATION_CACHE_SCHEMA) {
      throw new Error("Cannot write an unsupported AI relevance cache schema.");
    }
    const sortedEntries = Object.fromEntries(
      Object.entries(cache.entries).sort(([left], [right]) =>
        left < right ? -1 : left > right ? 1 : 0,
      ),
    );
    for (const [key, entry] of Object.entries(sortedEntries)) {
      if (expectedEntryKey(entry) !== key) {
        throw new Error("Cannot write an invalid AI relevance cache entry.");
      }
    }

    const directory = dirname(this.path);
    await mkdir(directory, { recursive: true });
    const temporaryPath = join(
      directory,
      `.${basename(this.path)}.${process.pid}.${randomUUID()}.tmp`,
    );
    await writeFile(
      temporaryPath,
      `${JSON.stringify(
        {
          schema_version: MODEL_CLASSIFICATION_CACHE_SCHEMA,
          entries: sortedEntries,
        },
        null,
        2,
      )}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    await rename(temporaryPath, this.path);
  }
}

function parseEntry(value: unknown): ModelClassificationCacheEntry | null {
  if (
    !isExactRecord(value, [
      "repository_id",
      "metadata_hash",
      "provider",
      "model",
      "prompt_version",
      "methodology_version",
      "decision",
      "evidence",
    ]) ||
    !Number.isSafeInteger(value.repository_id) ||
    (value.repository_id as number) < 1 ||
    !isSha256(value.metadata_hash) ||
    !validIdentityPart(value.provider) ||
    !validIdentityPart(value.model) ||
    !validIdentityPart(value.prompt_version) ||
    !validIdentityPart(value.methodology_version) ||
    !isModelDecision(value.decision) ||
    typeof value.evidence !== "string"
  ) {
    return null;
  }
  const evidence = normalizeModelEvidence(value.evidence);
  if (!evidence || evidence !== value.evidence || evidence.length > 500) {
    return null;
  }
  return {
    repository_id: value.repository_id as number,
    metadata_hash: value.metadata_hash,
    provider: value.provider,
    model: value.model,
    prompt_version: value.prompt_version,
    methodology_version: value.methodology_version,
    decision: value.decision,
    evidence,
  };
}

function expectedEntryKey(entry: ModelClassificationCacheEntry): string {
  return modelClassificationCacheKeyFromParts(
    entry.repository_id,
    entry.metadata_hash,
    {
      provider: entry.provider,
      model: entry.model,
      promptVersion: entry.prompt_version,
      methodologyVersion: entry.methodology_version,
    },
  );
}

function validIdentityPart(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= 200 &&
    value.trim() === value
  );
}

function invalidCacheError(path: string): Error {
  return new Error(`Invalid AI relevance cache: ${path}`);
}

function isMissingFile(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
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
