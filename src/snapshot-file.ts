import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import type { Snapshot } from "./types/snapshot.js";

export function defaultSnapshotPath(
  projectDirectory: string,
  collectedAt: string,
): string {
  const filename = `${collectedAt.replaceAll(":", "-")}.json`;
  return join(resolve(projectDirectory), ".gitropolis", "snapshots", filename);
}

export async function writeSnapshot(
  snapshot: Snapshot,
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
