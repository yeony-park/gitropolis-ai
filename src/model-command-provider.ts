import { spawn } from "node:child_process";

import {
  ModelClassificationResponseError,
  type ModelClassificationBatchRequest,
  type ModelClassificationProvider,
} from "./model-classification.js";

const DEFAULT_TIMEOUT_MS = 300_000;
const DEFAULT_MAX_OUTPUT_BYTES = 1_048_576;
const TERMINATION_GRACE_MS = 1_000;

export interface CommandModelProviderOptions {
  command: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  environment?: NodeJS.ProcessEnv;
}

export class CommandModelProvider implements ModelClassificationProvider {
  private readonly command: string;
  private readonly timeoutMs: number;
  private readonly maxOutputBytes: number;
  private readonly environment: NodeJS.ProcessEnv;

  constructor(options: CommandModelProviderOptions) {
    this.command = options.command.trim();
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxOutputBytes =
      options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    this.environment = modelCommandEnvironment(
      options.environment ?? process.env,
    );
    if (!this.command) {
      throw new Error("Model command must not be empty.");
    }
    if (
      !Number.isInteger(this.timeoutMs) ||
      this.timeoutMs < 1_000 ||
      this.timeoutMs > 1_800_000
    ) {
      throw new Error("Model command timeout must be between 1000 and 1800000.");
    }
    if (
      !Number.isInteger(this.maxOutputBytes) ||
      this.maxOutputBytes < 1_024 ||
      this.maxOutputBytes > 10_485_760
    ) {
      throw new Error(
        "Model command output limit must be between 1024 and 10485760.",
      );
    }
  }

  async invoke(request: ModelClassificationBatchRequest): Promise<unknown> {
    const output = await runCommand(
      this.command,
      `${JSON.stringify(request)}\n`,
      this.timeoutMs,
      this.maxOutputBytes,
      this.environment,
    );
    try {
      return JSON.parse(output) as unknown;
    } catch {
      throw new ModelClassificationResponseError();
    }
  }
}

async function runCommand(
  command: string,
  input: string,
  timeoutMs: number,
  maxOutputBytes: number,
  environment: NodeJS.ProcessEnv,
): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const child = spawn(command, [], {
      shell: false,
      stdio: ["pipe", "pipe", "ignore"],
      env: environment,
    });
    const chunks: Buffer[] = [];
    let outputBytes = 0;
    let settled = false;
    let terminationError: Error | null = null;
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
    let forceKillTimer: ReturnType<typeof setTimeout> | undefined;
    let forceSettleTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (error: Error | null, output?: string): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeoutTimer);
      clearTimeout(forceKillTimer);
      clearTimeout(forceSettleTimer);
      if (error) {
        reject(error);
      } else {
        resolve(output ?? "");
      }
    };
    const terminate = (error: Error): void => {
      if (settled || terminationError) {
        return;
      }
      terminationError = error;
      child.stdout.pause();
      child.stdin.destroy();
      child.kill("SIGTERM");
      forceKillTimer = setTimeout(() => {
        if (settled) {
          return;
        }
        child.kill("SIGKILL");
        forceSettleTimer = setTimeout(() => {
          finish(error);
        }, TERMINATION_GRACE_MS);
      }, TERMINATION_GRACE_MS);
    };
    timeoutTimer = setTimeout(() => {
      terminate(new Error("Model command timed out."));
    }, timeoutMs);

    child.on("error", () => {
      if (!terminationError) {
        finish(new Error("Model command could not be started."));
      }
    });
    child.stdout.on("data", (chunk: Buffer | string) => {
      if (settled || terminationError) {
        return;
      }
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      outputBytes += buffer.length;
      if (outputBytes > maxOutputBytes) {
        terminate(new Error("Model command output exceeded the byte limit."));
        return;
      }
      chunks.push(buffer);
    });
    child.on("close", (code, signal) => {
      if (terminationError) {
        finish(terminationError);
        return;
      }
      if (code !== 0) {
        finish(
          new Error(
            signal
              ? "Model command was terminated."
              : `Model command exited with status ${code ?? "unknown"}.`,
          ),
        );
        return;
      }
      finish(null, Buffer.concat(chunks).toString("utf8"));
    });
    child.stdin.on("error", () => {
      terminate(new Error("Model command input could not be written."));
    });
    child.stdin.end(input);
  });
}

function modelCommandEnvironment(
  environment: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(environment).filter(
      ([name]) =>
        name !== "GITHUB_TOKEN" &&
        name !== "GH_TOKEN" &&
        name !== "GITHUB_PAT",
    ),
  );
}
