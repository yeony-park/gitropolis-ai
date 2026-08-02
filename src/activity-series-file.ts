import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import type { ActivitySeriesSnapshot } from "./types/activity-series.js";

export function defaultActivitySeriesPath(
  projectDirectory: string,
  snapshot: ActivitySeriesSnapshot,
): string {
  const from = snapshot.window.from.replaceAll(":", "-");
  const to = snapshot.window.to.replaceAll(":", "-");
  return join(
    resolve(projectDirectory),
    ".gitropolis",
    "activity",
    `${from}_${to}.json`,
  );
}

export function defaultEnrichedActivitySeriesPath(
  inputPath: string,
): string {
  const resolvedPath = resolve(inputPath);
  return resolvedPath.endsWith(".json")
    ? `${resolvedPath.slice(0, -5)}-enriched.json`
    : `${resolvedPath}-enriched.json`;
}

export async function readActivitySeries(
  inputPath: string,
): Promise<ActivitySeriesSnapshot> {
  const resolvedPath = resolve(inputPath);
  const parsed = JSON.parse(await readFile(resolvedPath, "utf8")) as unknown;
  if (
    !isRecord(parsed) ||
    parsed.schema_version !== "activity-series-v1" ||
    !Array.isArray(parsed.repositories)
  ) {
    throw new Error(
      `Input is not an activity-series-v1 snapshot: ${resolvedPath}`,
    );
  }
  return parsed as unknown as ActivitySeriesSnapshot;
}

export async function writeActivitySeries(
  snapshot: ActivitySeriesSnapshot,
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
