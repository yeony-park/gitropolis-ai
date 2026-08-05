import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import type { RepositoryLifecycleSnapshot } from "./types/repository-lifecycle.js";

export function defaultRepositoryLifecyclePath(
  projectDirectory: string,
  snapshot: RepositoryLifecycleSnapshot,
): string {
  const from = snapshot.window.from.replaceAll(":", "-");
  const to = snapshot.window.to.replaceAll(":", "-");
  return join(
    resolve(projectDirectory),
    ".gitropolis",
    "lifecycle",
    `${from}_${to}.json`,
  );
}

export async function readRepositoryLifecycle(
  inputPath: string,
): Promise<RepositoryLifecycleSnapshot> {
  const resolvedPath = resolve(inputPath);
  const parsed = JSON.parse(await readFile(resolvedPath, "utf8")) as unknown;
  if (
    !isRecord(parsed) ||
    parsed.schema_version !== "repository-lifecycle-v1" ||
    !Array.isArray(parsed.repositories) ||
    !Array.isArray(parsed.events)
  ) {
    throw new Error(
      `Input is not a repository-lifecycle-v1 snapshot: ${resolvedPath}`,
    );
  }
  return parsed as unknown as RepositoryLifecycleSnapshot;
}

export async function writeRepositoryLifecycle(
  snapshot: RepositoryLifecycleSnapshot,
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
