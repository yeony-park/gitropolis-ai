import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import type { CandidateSnapshot } from "./types/candidate.js";
import type { TopicAnalysisSnapshot } from "./types/topic-analysis.js";

export async function readCandidateSnapshot(
  inputPath: string,
): Promise<CandidateSnapshot> {
  const resolvedPath = resolve(inputPath);
  const parsed = JSON.parse(await readFile(resolvedPath, "utf8")) as unknown;
  if (
    !isRecord(parsed) ||
    parsed.schema_version !== "candidate-v1" ||
    !Array.isArray(parsed.repositories)
  ) {
    throw new Error(`Input is not a candidate-v1 snapshot: ${resolvedPath}`);
  }
  return parsed as unknown as CandidateSnapshot;
}

export function defaultTopicAnalysisPath(
  projectDirectory: string,
  snapshot: TopicAnalysisSnapshot,
): string {
  const from = snapshot.candidate_window.from.replaceAll(":", "-");
  const to = snapshot.candidate_window.to.replaceAll(":", "-");
  return join(
    resolve(projectDirectory),
    ".gitropolis",
    "observations",
    `${from}_${to}.json`,
  );
}

export async function writeTopicAnalysisSnapshot(
  snapshot: TopicAnalysisSnapshot,
  outputPath: string,
): Promise<string> {
  const resolvedPath = resolve(outputPath);
  await mkdir(dirname(resolvedPath), { recursive: true });
  await writeFile(
    resolvedPath,
    `${JSON.stringify(snapshot, null, 2)}\n`,
    "utf8",
  );
  return resolvedPath;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
