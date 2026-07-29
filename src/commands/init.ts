import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const DATA_DIRECTORY = ".gitropolis";
const CONFIG_FILENAME = "config.json";

export async function initializeProject(
  projectDirectory: string,
): Promise<string> {
  const dataDirectory = join(projectDirectory, DATA_DIRECTORY);
  const snapshotsDirectory = join(dataDirectory, "snapshots");
  const configPath = join(dataDirectory, CONFIG_FILENAME);

  await mkdir(snapshotsDirectory, { recursive: true });

  try {
    await readFile(configPath, "utf8");
  } catch (error) {
    if (!isMissingFile(error)) {
      throw error;
    }

    const config = {
      schema_version: "config-v1",
      snapshot_directory: "snapshots",
    };
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  }

  return configPath;
}

function isMissingFile(error: unknown): error is NodeJS.ErrnoException {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
