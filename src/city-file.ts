import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import type { CitySnapshot } from "./types/city.js";

export function defaultCityPath(projectDirectory: string): string {
  return join(resolve(projectDirectory), ".gitropolis", "city", "city.json");
}

export async function readCitySnapshot(inputPath: string): Promise<CitySnapshot> {
  const resolvedPath = resolve(inputPath);
  const parsed = JSON.parse(await readFile(resolvedPath, "utf8")) as unknown;
  if (
    !isRecord(parsed) ||
    parsed.schema_version !== "city-v1" ||
    !Array.isArray(parsed.districts) ||
    !Array.isArray(parsed.communities) ||
    !Array.isArray(parsed.repositories)
  ) {
    throw new Error(`Input is not a city-v1 snapshot: ${resolvedPath}`);
  }
  return parsed as unknown as CitySnapshot;
}

export async function writeCitySnapshot(
  snapshot: CitySnapshot,
  outputPath: string,
): Promise<string> {
  const resolvedPath = resolve(outputPath);
  await mkdir(dirname(resolvedPath), { recursive: true });
  await writeFile(resolvedPath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
  return resolvedPath;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
