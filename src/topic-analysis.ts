import { GitHubApiError, type GitHubApiClient } from "./github/client.js";
import type { CandidateSnapshot } from "./types/candidate.js";
import type {
  AIRelevanceAssessment,
  AIRelevanceEvidence,
  KeywordObservation,
  KeywordSource,
  TopicAnalysisCoverageError,
  TopicAnalysisRepository,
  TopicAnalysisSnapshot,
} from "./types/topic-analysis.js";

const DEFAULT_MAX_README_CHARACTERS = 12_000;
const MIN_PROVISIONAL_EMERGING_REPOSITORIES = 5;

const TEXT_CONFIDENCE: Readonly<Record<KeywordSource, number>> = {
  topics: 0.95,
  description: 0.8,
  readme: 0.65,
};

const AI_SIGNAL_CONTRIBUTION: Readonly<Record<KeywordSource, number>> = {
  topics: 0.65,
  description: 0.45,
  readme: 0.3,
};

const AI_SIGNAL_SOURCE_CAP: Readonly<Record<KeywordSource, number>> = {
  topics: 0.8,
  description: 0.6,
  readme: 0.45,
};

const COMPOUND_ANCHORS = new Set([
  "agent",
  "agents",
  "embedding",
  "embeddings",
  "inference",
  "llm",
  "llms",
  "multimodal",
  "rag",
  "transformer",
  "transformers",
  "vision",
]);

const FLEXIBLE_SUFFIX_ANCHORS = new Set([
  "embedding",
  "embeddings",
  "inference",
  "llm",
  "llms",
  "multimodal",
  "rag",
  "transformer",
  "transformers",
  "vision",
]);

const AI_SIGNAL_KEYWORDS = new Set([
  "ai",
  "ai-agent",
  "ai-agents",
  "artificial-intelligence",
  "computer-vision",
  "deep-learning",
  "diffusion-model",
  "embedding",
  "embeddings",
  "generative-ai",
  "large-language-model",
  "large-language-models",
  "llm",
  "llms",
  "machine-learning",
  "model-inference",
  "multimodal",
  "natural-language-processing",
  "neural-network",
  "neural-networks",
  "rag",
  "retrieval-augmented-generation",
  "transformer",
  "transformers",
]);

const GENERIC_TOPICS = new Set([
  "api",
  "app",
  "application",
  "cli",
  "framework",
  "github",
  "javascript",
  "library",
  "open-source",
  "python",
  "rust",
  "sdk",
  "typescript",
]);

const PHRASE_STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "for",
  "from",
  "in",
  "is",
  "it",
  "of",
  "on",
  "or",
  "that",
  "the",
  "this",
  "to",
  "with",
  "your",
]);

const BROAD_KEYWORDS = new Set([
  "ai",
  "artificial-intelligence",
  "deep-learning",
  "large-language-model",
  "large-language-models",
  "llm",
  "llms",
  "machine-learning",
]);

const ALIASES: Readonly<Record<string, string>> = {
  "agentic-rag": "agentic-rag",
  "artificial-intelligence": "ai",
  "graph-rag": "graph-rag",
  graphrag: "graph-rag",
  "retrieval-augmented-generation": "rag",
};

interface ReadmeResponse {
  content?: unknown;
  encoding?: unknown;
}

export interface RepositoryReadmeSource {
  readonly authenticated: boolean;
  getReadme(repository: string): Promise<string | null>;
}

export interface TopicAnalysisOptions {
  maxReadmeCharacters?: number;
  observedAt?: Date;
}

export function githubReadmeSource(
  client: GitHubApiClient,
): RepositoryReadmeSource {
  return {
    authenticated: client.authenticated,
    async getReadme(repository: string): Promise<string | null> {
      const path = repository
        .split("/")
        .map(encodeURIComponent)
        .join("/");
      try {
        const response = await client.get<ReadmeResponse>(
          `/repos/${path}/readme`,
        );
        if (
          response.data.encoding !== "base64" ||
          typeof response.data.content !== "string"
        ) {
          return null;
        }
        return Buffer.from(
          response.data.content.replaceAll("\n", ""),
          "base64",
        ).toString("utf8");
      } catch (error) {
        if (error instanceof GitHubApiError && error.status === 404) {
          return null;
        }
        throw error;
      }
    },
  };
}

export async function analyzeCandidates(
  candidate: CandidateSnapshot,
  readmes: RepositoryReadmeSource,
  options: TopicAnalysisOptions = {},
): Promise<TopicAnalysisSnapshot> {
  const observedAt = options.observedAt ?? new Date();
  const maxReadmeCharacters =
    options.maxReadmeCharacters ?? DEFAULT_MAX_README_CHARACTERS;
  if (!Number.isInteger(maxReadmeCharacters) || maxReadmeCharacters < 1) {
    throw new Error("maxReadmeCharacters must be a positive integer.");
  }

  const coverageErrors: TopicAnalysisCoverageError[] = [];
  const repositories: TopicAnalysisRepository[] = [];
  let readmeRequestsStopped = false;
  let stoppedRateLimitStatus: number | null = null;

  for (const repository of candidate.repositories) {
    const github = repository.github;
    if (!github) {
      coverageErrors.push({
        source: "candidate",
        target: repository.full_name,
        status: null,
        message: "GitHub enrichment is unavailable for this candidate.",
      });
      repositories.push({
        repository_id: null,
        full_name: repository.full_name,
        ai_relevance: {
          score: 0,
          decision: "unavailable",
          evidence: [],
        },
        community_status: null,
        observations: [],
      });
      continue;
    }

    let readme: string | null = null;
    if (github.readme) {
      const readmeTarget = `/repos/${repository.full_name}/readme`;
      if (readmeRequestsStopped) {
        coverageErrors.push({
          source: "github",
          target: readmeTarget,
          status: stoppedRateLimitStatus,
          message: "README request skipped after a GitHub rate limit.",
        });
      } else {
        try {
          readme = (await readmes.getReadme(repository.full_name))?.slice(
            0,
            maxReadmeCharacters,
          ) ?? null;
        } catch (error) {
          const githubError = error instanceof GitHubApiError ? error : null;
          coverageErrors.push({
            source: "github",
            target: githubError?.endpoint ?? readmeTarget,
            status: githubError?.status ?? null,
            message:
              error instanceof Error
                ? error.message
                : "README request failed.",
          });
          if (githubError?.rateLimited) {
            readmeRequestsStopped = true;
            stoppedRateLimitStatus = githubError.status;
          }
        }
      }
    }

    const observations = collectObservations(
      github.id,
      observedAt.toISOString(),
      github.topics,
      github.description,
      readme,
    );
    repositories.push({
      repository_id: github.id,
      full_name: repository.full_name,
      ai_relevance: assessAIRelevance(observations),
      community_status: null,
      observations,
    });
  }

  assignCommunityStatuses(repositories);

  return {
    schema_version: "topic-analysis-v1",
    observed_at: observedAt.toISOString(),
    candidate_window: candidate.window,
    methodology_version: "ai-relevance-rules-v1",
    source: {
      candidate_schema_version: candidate.schema_version,
      candidate_coverage_complete: candidate.source.coverage_complete,
      candidate_coverage_errors: candidate.source.coverage_errors,
      github_authenticated: readmes.authenticated,
      coverage_complete:
        candidate.source.coverage_complete && coverageErrors.length === 0,
      coverage_errors: coverageErrors,
    },
    repositories,
  };
}

function collectObservations(
  repositoryId: number,
  observedAt: string,
  topics: readonly string[],
  description: string | null,
  readme: string | null,
): KeywordObservation[] {
  const counts = new Map<string, number>();

  for (const topic of topics) {
    const keyword = normalizeKeyword(topic);
    if (keyword && !GENERIC_TOPICS.has(keyword)) {
      increment(counts, observationKey("topics", keyword));
    }
  }
  for (const keyword of extractTextKeywords(description ?? "")) {
    increment(counts, observationKey("description", keyword));
  }
  for (const keyword of extractTextKeywords(readme ?? "")) {
    increment(counts, observationKey("readme", keyword));
  }

  return [...counts.entries()]
    .map(([key, occurrenceCount]) => {
      const [source, keywordId] = key.split("\u0000") as [
        KeywordSource,
        string,
      ];
      return {
        observed_at: observedAt,
        repository_id: repositoryId,
        keyword_id: keywordId,
        source,
        occurrence_count: occurrenceCount,
        confidence: TEXT_CONFIDENCE[source],
      };
    })
    .sort((left, right) =>
      left.source.localeCompare(right.source) ||
      left.keyword_id.localeCompare(right.keyword_id),
    );
}

function extractTextKeywords(text: string): string[] {
  const normalizedText = text
    .replaceAll(/([a-z0-9])([A-Z])/g, "$1-$2")
    .toLowerCase()
    .replaceAll(/https?:\/\/\S+/g, " ")
    .replaceAll(/[_/]+/g, "-");
  const keywords: string[] = [];

  for (const alias of [
    "ai agent",
    "ai agents",
    "artificial intelligence",
    "computer vision",
    "deep learning",
    "generative ai",
    "large language model",
    "large language models",
    "machine learning",
    "natural language processing",
    "neural network",
    "neural networks",
    "retrieval augmented generation",
  ]) {
    const expression = new RegExp(
      `\\b${alias.replaceAll(" ", "[ -]+")}\\b`,
      "g",
    );
    for (const _match of normalizedText.matchAll(expression)) {
      keywords.push(normalizeKeyword(alias));
    }
  }

  const words = normalizedText.match(/[a-z0-9]+(?:-[a-z0-9]+)*/g) ?? [];
  for (let index = 0; index < words.length; index += 1) {
    const rawWord = words[index] ?? "";
    const word = normalizeKeyword(rawWord);
    if (!word) {
      continue;
    }
    if (AI_SIGNAL_KEYWORDS.has(word) || isUsefulCompound(word)) {
      keywords.push(word);
    }

    const next = normalizeKeyword(words[index + 1] ?? "");
    if (
      next &&
      isUsefulModifier(word) &&
      FLEXIBLE_SUFFIX_ANCHORS.has(next)
    ) {
      keywords.push(normalizeKeyword(`${word}-${next}`));
    }
  }

  return keywords.filter(Boolean);
}

function assessAIRelevance(
  observations: readonly KeywordObservation[],
): AIRelevanceAssessment {
  const evidence: AIRelevanceEvidence[] = [];
  const seen = new Set<string>();
  const contributionBySource: Record<KeywordSource, number> = {
    topics: 0,
    description: 0,
    readme: 0,
  };
  let score = 0;

  for (const observation of observations) {
    if (!isAISignal(observation.keyword_id)) {
      continue;
    }
    const key = observationKey(observation.source, observation.keyword_id);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    const contribution = Number(
      Math.min(
        AI_SIGNAL_CONTRIBUTION[observation.source],
        AI_SIGNAL_SOURCE_CAP[observation.source] -
          contributionBySource[observation.source],
      ).toFixed(2),
    );
    if (contribution <= 0) {
      continue;
    }
    contributionBySource[observation.source] += contribution;
    score += contribution;
    evidence.push({
      keyword_id: observation.keyword_id,
      source: observation.source,
      contribution,
    });
  }

  score = Math.min(1, Number(score.toFixed(2)));
  return {
    score,
    decision:
      score >= 0.5 ? "ai-related" : score >= 0.25 ? "review" : "not-ai",
    evidence,
  };
}

function assignCommunityStatuses(
  repositories: TopicAnalysisRepository[],
): void {
  const repositoriesByKeyword = new Map<string, Set<number>>();
  for (const repository of repositories) {
    if (
      repository.ai_relevance.decision !== "ai-related" ||
      repository.repository_id === null
    ) {
      continue;
    }
    for (const observation of repository.observations) {
      if (BROAD_KEYWORDS.has(observation.keyword_id)) {
        continue;
      }
      const ids = repositoriesByKeyword.get(observation.keyword_id) ?? new Set();
      ids.add(repository.repository_id);
      repositoriesByKeyword.set(observation.keyword_id, ids);
    }
  }

  for (const repository of repositories) {
    if (repository.ai_relevance.decision !== "ai-related") {
      repository.community_status = null;
      continue;
    }
    repository.community_status = repository.observations.some(
      (observation) =>
        !BROAD_KEYWORDS.has(observation.keyword_id) &&
        (repositoriesByKeyword.get(observation.keyword_id)?.size ?? 0) >=
          MIN_PROVISIONAL_EMERGING_REPOSITORIES,
    )
      ? "emerging"
      : "unknown";
  }
}

function isAISignal(keyword: string): boolean {
  if (AI_SIGNAL_KEYWORDS.has(keyword)) {
    return true;
  }
  const parts = keyword.split("-");
  return (
    parts.includes("rag") ||
    parts.includes("llm") ||
    parts.includes("llms") ||
    keyword.startsWith("ai-")
  );
}

function isUsefulCompound(keyword: string): boolean {
  const parts = keyword.split("-");
  if (
    parts.length < 2 ||
    parts.length > 3 ||
    parts.some(
      (part) =>
        part.length < 2 ||
        /\d/.test(part) ||
        PHRASE_STOPWORDS.has(part),
    )
  ) {
    return false;
  }
  return (
    parts[0] === "ai" ||
    parts.some((part) => COMPOUND_ANCHORS.has(part))
  );
}

function isUsefulModifier(keyword: string): boolean {
  return (
    keyword.length >= 3 &&
    /^[a-z]+$/.test(keyword) &&
    !PHRASE_STOPWORDS.has(keyword) &&
    !GENERIC_TOPICS.has(keyword) &&
    !COMPOUND_ANCHORS.has(keyword)
  );
}

function normalizeKeyword(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replaceAll(/[_/\s]+/g, "-")
    .replaceAll(/[^a-z0-9-]/g, "")
    .replaceAll(/-+/g, "-")
    .replaceAll(/^-|-$/g, "");
  return ALIASES[normalized] ?? normalized;
}

function observationKey(source: KeywordSource, keyword: string): string {
  return `${source}\u0000${keyword}`;
}

function increment(counts: Map<string, number>, key: string): void {
  counts.set(key, (counts.get(key) ?? 0) + 1);
}
