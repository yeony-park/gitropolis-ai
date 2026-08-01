import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import type { CandidateSnapshot } from "./types/candidate.js";

export function defaultCandidatePath(
  projectDirectory: string,
  snapshot: CandidateSnapshot,
): string {
  const from = snapshot.window.from.replaceAll(":", "-");
  const to = snapshot.window.to.replaceAll(":", "-");
  return join(
    resolve(projectDirectory),
    ".gitropolis",
    "candidates",
    `${from}_${to}.json`,
  );
}

export async function writeCandidateSnapshot(
  snapshot: CandidateSnapshot,
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
