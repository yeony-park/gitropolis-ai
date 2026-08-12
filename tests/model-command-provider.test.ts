import assert from "node:assert/strict";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  MODEL_CLASSIFICATION_METHODOLOGY_VERSION,
  MODEL_CLASSIFICATION_PROMPT_VERSION,
  MODEL_CLASSIFICATION_REQUEST_SCHEMA,
  MODEL_CLASSIFICATION_RESPONSE_SCHEMA,
  ModelClassificationResponseError,
  type ModelClassificationBatchRequest,
} from "../src/model-classification.js";
import { CommandModelProvider } from "../src/model-command-provider.js";

const request: ModelClassificationBatchRequest = {
  schema_version: MODEL_CLASSIFICATION_REQUEST_SCHEMA,
  task: {
    prompt_version: MODEL_CLASSIFICATION_PROMPT_VERSION,
    instructions: "Return strict JSON.",
  },
  classifier: {
    provider: "test-provider",
    model: "test-model",
    methodology_version: MODEL_CLASSIFICATION_METHODOLOGY_VERSION,
  },
  repositories: [{
    repository_id: 1,
    description: "An AI repository.",
    topics: ["ai"],
  }],
};

test("command model provider uses JSON stdio without forwarding GitHub tokens", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gitropolis-model-command-"));
  const command = join(directory, "adapter.mjs");
  await writeFile(
    command,
    `#!/usr/bin/env node
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  const request = JSON.parse(input);
  process.stdout.write(JSON.stringify({
    schema_version: "${MODEL_CLASSIFICATION_RESPONSE_SCHEMA}",
    repositories: request.repositories.map((repository) => ({
      repository_id: repository.repository_id,
      decision: process.env.GITHUB_TOKEN ? "review" : "ai-related",
      evidence: process.env.GITHUB_TOKEN ? "token leaked" : "No token inherited.",
    })),
  }));
});
`,
    "utf8",
  );
  await chmod(command, 0o700);

  const provider = new CommandModelProvider({
    command,
    environment: {
      ...process.env,
      GITHUB_TOKEN: "GITHUB_TOKEN_CANARY_8142",
    },
  });

  assert.deepEqual(await provider.invoke(request), {
    schema_version: MODEL_CLASSIFICATION_RESPONSE_SCHEMA,
    repositories: [{
      repository_id: 1,
      decision: "ai-related",
      evidence: "No token inherited.",
    }],
  });
});

test("command model provider rejects oversized output", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gitropolis-model-command-"));
  const command = join(directory, "adapter.mjs");
  await writeFile(
    command,
    `#!/usr/bin/env node
process.stdin.resume();
process.stdin.on("end", () => process.stdout.write("x".repeat(2048)));
`,
    "utf8",
  );
  await chmod(command, 0o700);

  await assert.rejects(
    new CommandModelProvider({
      command,
      maxOutputBytes: 1024,
    }).invoke(request),
    /output exceeded the byte limit/,
  );
});

test("command model provider identifies invalid JSON as a response error", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gitropolis-model-command-"));
  const command = join(directory, "adapter.mjs");
  await writeFile(
    command,
    `#!/usr/bin/env node
process.stdin.resume();
process.stdin.on("end", () => process.stdout.write("not-json"));
`,
    "utf8",
  );
  await chmod(command, 0o700);

  await assert.rejects(
    new CommandModelProvider({ command }).invoke(request),
    ModelClassificationResponseError,
  );
});
