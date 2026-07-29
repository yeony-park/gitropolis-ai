#!/usr/bin/env node

import { dirname, resolve } from "node:path";

import { initializeProject } from "./commands/init.js";

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
  const [command, ...options] = arguments_;

  if (!command || command === "--help" || command === "-h") {
    process.stdout.write(HELP);
    return 0;
  }

  if (command === "init") {
    const directory = readOption(options, "--directory") ?? process.cwd();
    const configPath = await initializeProject(resolve(directory));
    process.stdout.write(`Initialized Gitropolis at ${dirname(configPath)}\n`);
    return 0;
  }

  if (command === "collect") {
    process.stderr.write("The collect command is not implemented yet.\n");
    return 1;
  }

  process.stderr.write(`Unknown command: ${command}\n\n${HELP}`);
  return 1;
}

function readOption(
  arguments_: readonly string[],
  option: string,
): string | undefined {
  const index = arguments_.indexOf(option);
  if (index === -1) {
    return undefined;
  }

  const value = arguments_[index + 1];
  if (!value) {
    throw new Error(`${option} requires a value.`);
  }
  return value;
}

const isEntryPoint =
  process.argv[1] !== undefined &&
  import.meta.url === new URL(process.argv[1], "file:").href;

if (isEntryPoint) {
  process.exitCode = await run();
}
