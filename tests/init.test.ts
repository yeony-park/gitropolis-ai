import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

import { initializeProject } from "../src/commands/init.js";

test("init creates the configuration and snapshot directory", async () => {
  const projectDirectory = await mkdtemp(join(tmpdir(), "gitropolis-init-"));

  const configPath = await initializeProject(projectDirectory);

  const config = JSON.parse(await readFile(configPath, "utf8"));
  assert.deepEqual(config, {
    schema_version: "config-v1",
    snapshot_directory: "snapshots",
  });
  const snapshots = await stat(join(dirname(configPath), "snapshots"));
  assert.equal(snapshots.isDirectory(), true);
});

test("init preserves an existing configuration", async () => {
  const projectDirectory = await mkdtemp(join(tmpdir(), "gitropolis-init-"));
  const configPath = join(projectDirectory, ".gitropolis", "config.json");
  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(configPath, '{"custom":true}\n', "utf8");

  await initializeProject(projectDirectory);

  assert.equal(await readFile(configPath, "utf8"), '{"custom":true}\n');
});
