#!/usr/bin/env node

import { dirname, resolve } from "node:path";

import { collectSnapshot } from "./collector.js";
import { initializeProject } from "./commands/init.js";
import { GitHubApiError, GitHubClient } from "./github/client.js";
import { defaultSnapshotPath, writeSnapshot } from "./snapshot-file.js";

const HELP = `Usage: gitropolis <command> [options]

Commands:
  init      Initialize local Gitropolis project files
  collect   Collect public GitHub repository metadata

Options:
  -h, --help  Show this help message
`;

export async function run(
  arguments_: readonly string[] = process.argv.slice(2),
): Promise<number> {
  try {
    return await runCommand(arguments_);
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown error";
    process.stderr.write(`Command failed: ${message}\n`);
    return 1;
  }
}

async function runCommand(arguments_: readonly string[]): Promise<number> {
  const [command, ...commandArguments] = arguments_;

  if (!command || command === "--help" || command === "-h") {
    process.stdout.write(HELP);
    return 0;
  }

  if (command === "init") {
    const { options } = parseArguments(commandArguments);
    const directory = options.directory ?? process.cwd();
    const configPath = await initializeProject(resolve(directory));
    process.stdout.write(`Initialized Gitropolis at ${dirname(configPath)}\n`);
    return 0;
  }

  if (command === "collect") {
    const { options, positionals } = parseArguments(commandArguments);
    if (positionals.length === 0) {
      throw new Error("collect requires at least one OWNER/REPOSITORY.");
    }

    const client = new GitHubClient();
    const snapshot = await collectSnapshot(positionals, client);
    const outputPath =
      options.output ??
      defaultSnapshotPath(
        options.directory ?? process.cwd(),
        snapshot.collected_at,
      );
    const writtenPath = await writeSnapshot(snapshot, outputPath);
    const core = snapshot.source.rate_limit?.core;

    process.stdout.write("Authentication: anonymous\n");
    if (core) {
      process.stdout.write(
        `GitHub API core limit: ${core.remaining}/${core.limit} remaining\n`,
      );
    }
    process.stdout.write(
      `Collected ${snapshot.repositories.length} repositories\n`,
    );
    process.stdout.write(`Snapshot: ${writtenPath}\n`);
    return 0;
  }

  process.stderr.write(`Unknown command: ${command}\n\n${HELP}`);
  return 1;
}

interface ParsedArguments {
  options: {
    directory?: string;
    output?: string;
  };
  positionals: string[];
}

function parseArguments(arguments_: readonly string[]): ParsedArguments {
  const options: ParsedArguments["options"] = {};
  const positionals: string[] = [];

  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--directory" || argument === "--output") {
      const value = arguments_[index + 1];
      if (!value) {
        throw new Error(`${argument} requires a value.`);
      }
      if (argument === "--directory") {
        options.directory = value;
      } else {
        options.output = value;
      }
      index += 1;
      continue;
    }
    if (argument?.startsWith("-")) {
      throw new Error(`Unknown option: ${argument}`);
    }
    if (argument) {
      positionals.push(argument);
    }
  }

  return { options, positionals };
}

const isEntryPoint =
  process.argv[1] !== undefined &&
  import.meta.url === new URL(process.argv[1], "file:").href;

if (isEntryPoint) {
  process.exitCode = await run();
}
