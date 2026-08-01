import { redactSecrets } from "../security/redact.js";

export const GITHUB_API_URL = "https://api.github.com";
export const GITHUB_API_VERSION = "2026-03-10";
const DEFAULT_MAX_RATE_LIMIT_RETRIES = 2;
const DEFAULT_MAX_RATE_LIMIT_WAIT_MS = 60_000;

interface GitHubApiErrorOptions {
  endpoint?: string;
  rateLimited?: boolean;
  retryAfterMs?: number | null;
}

export class GitHubApiError extends Error {
  readonly endpoint: string | null;
  readonly rateLimited: boolean;
  readonly retryAfterMs: number | null;

  constructor(
    readonly status: number | null,
    message: string,
    options: GitHubApiErrorOptions = {},
  ) {
    super(message);
    this.name = "GitHubApiError";
    this.endpoint = options.endpoint ?? null;
    this.rateLimited = options.rateLimited ?? false;
    this.retryAfterMs = options.retryAfterMs ?? null;
  }
}

export interface GitHubResponse<T> {
  data: T;
  headers: Headers;
}

export interface GitHubApiClient {
  readonly authenticated: boolean;
  get<T>(
    path: string,
    parameters?: Readonly<Record<string, string | number>>,
  ): Promise<GitHubResponse<T>>;
}

export interface GitHubClientOptions {
  baseUrl?: string;
  fetchImplementation?: typeof fetch;
  maxRateLimitRetries?: number;
  maxRateLimitWaitMs?: number;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  token?: string | undefined;
}

export class GitHubClient implements GitHubApiClient {
  readonly authenticated: boolean;
  private readonly baseUrl: string;
  private readonly fetchImplementation: typeof fetch;
  private readonly maxRateLimitRetries: number;
  private readonly maxRateLimitWaitMs: number;
  private readonly now: () => number;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly token: string | undefined;

  constructor(options: GitHubClientOptions = {}) {
    this.baseUrl = options.baseUrl ?? GITHUB_API_URL;
    this.fetchImplementation = options.fetchImplementation ?? globalThis.fetch;
    this.maxRateLimitRetries =
      options.maxRateLimitRetries ?? DEFAULT_MAX_RATE_LIMIT_RETRIES;
    this.maxRateLimitWaitMs =
      options.maxRateLimitWaitMs ?? DEFAULT_MAX_RATE_LIMIT_WAIT_MS;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? delay;
    this.token = options.token?.trim() || undefined;
    this.authenticated = this.token !== undefined;
  }

  async get<T>(
    path: string,
    parameters?: Readonly<Record<string, string | number>>,
  ): Promise<GitHubResponse<T>> {
    const url = new URL(path, `${this.baseUrl.replace(/\/$/, "")}/`);
    for (const [name, value] of Object.entries(parameters ?? {})) {
      url.searchParams.set(name, String(value));
    }

    const headers: Record<string, string> = {
      Accept: "application/vnd.github+json",
      "User-Agent": "gitropolis",
      "X-GitHub-Api-Version": GITHUB_API_VERSION,
    };
    if (this.token) {
      headers.Authorization = `Bearer ${this.token}`;
    }

    for (let retryCount = 0; ; retryCount += 1) {
      let response: Response;
      try {
        response = await this.fetchImplementation(url, {
          headers,
          signal: AbortSignal.timeout(30_000),
        });
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "unknown error";
        throw new GitHubApiError(
          null,
          redactSecrets(`GitHub request failed: ${message}`, [this.token]),
          { endpoint: path },
        );
      }

      if (response.ok) {
        return {
          data: (await response.json()) as T,
          headers: response.headers,
        };
      }

      const retryAfterMs = rateLimitDelay(response.headers, this.now());
      const rateLimited =
        response.status === 429 ||
        (response.status === 403 && retryAfterMs !== null);
      const error = new GitHubApiError(
        response.status,
        redactSecrets(await readErrorMessage(response), [this.token]),
        { endpoint: path, rateLimited, retryAfterMs },
      );

      if (
        !rateLimited ||
        retryAfterMs === null ||
        retryAfterMs > this.maxRateLimitWaitMs ||
        retryCount >= this.maxRateLimitRetries
      ) {
        throw error;
      }

      await this.sleep(retryAfterMs);
    }
  }
}

function rateLimitDelay(headers: Headers, now: number): number | null {
  const retryAfter = headers.get("retry-after");
  if (retryAfter !== null) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.ceil(seconds * 1_000);
    }

    const date = Date.parse(retryAfter);
    if (Number.isFinite(date)) {
      return Math.max(0, date - now);
    }
  }

  const resetHeader = headers.get("x-ratelimit-reset");
  if (resetHeader !== null) {
    const reset = Number(resetHeader);
    if (Number.isFinite(reset) && reset >= 0) {
      return Math.max(0, reset * 1_000 - now);
    }
  }
  return null;
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function readErrorMessage(response: Response): Promise<string> {
  let message: string | undefined;
  try {
    const payload = (await response.json()) as { message?: unknown };
    if (typeof payload.message === "string") {
      message = payload.message;
    }
  } catch {
    // The status code remains useful when GitHub returns a non-JSON response.
  }

  return message
    ? `GitHub API returned ${response.status}: ${message}`
    : `GitHub API returned ${response.status}`;
}
