import type { CandidateCoverageError } from "./candidate.js";

export type KeywordSource = "topics" | "description" | "readme";

export interface KeywordObservation {
  observed_at: string;
  repository_id: number;
  keyword_id: string;
  source: KeywordSource;
  occurrence_count: number;
  confidence: number;
}

export interface AIRelevanceEvidence {
  keyword_id: string;
  source: KeywordSource;
  contribution: number;
}

export interface AIRelevanceAssessment {
  score: number;
  decision: "ai-related" | "review" | "not-ai" | "unavailable";
  evidence: AIRelevanceEvidence[];
}

export interface TopicAnalysisCoverageError {
  source: "candidate" | "github";
  target: string;
  status: number | null;
  message: string;
}

export interface TopicAnalysisRepository {
  repository_id: number | null;
  full_name: string;
  ai_relevance: AIRelevanceAssessment;
  community_status: "unknown" | "emerging" | null;
  observations: KeywordObservation[];
}

export interface TopicAnalysisSnapshot {
  schema_version: "topic-analysis-v1";
  observed_at: string;
  candidate_window: {
    from: string;
    to: string;
  };
  methodology_version: "ai-relevance-rules-v1";
  source: {
    candidate_schema_version: "candidate-v1";
    candidate_coverage_complete: boolean;
    candidate_coverage_errors: CandidateCoverageError[];
    github_authenticated: boolean;
    coverage_complete: boolean;
    coverage_errors: TopicAnalysisCoverageError[];
  };
  repositories: TopicAnalysisRepository[];
}
