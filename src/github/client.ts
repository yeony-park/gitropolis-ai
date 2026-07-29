export const GITHUB_API_URL = "https://api.github.com";
export const GITHUB_API_VERSION = "2026-03-10";

export class GitHubApiError extends Error {
  constructor(
    readonly status: number | null,
    message: string,
  ) {
    super(message);
    this.name = "GitHubApiError";
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

export class GitHubClient implements GitHubApiClient {
  readonly authenticated = false;

  constructor(
    private readonly baseUrl = GITHUB_API_URL,
    private readonly fetchImplementation: typeof fetch = globalThis.fetch,
  ) {}

  async get<T>(
    path: string,
    parameters?: Readonly<Record<string, string | number>>,
  ): Promise<GitHubResponse<T>> {
    const url = new URL(path, `${this.baseUrl.replace(/\/$/, "")}/`);
    for (const [name, value] of Object.entries(parameters ?? {})) {
      url.searchParams.set(name, String(value));
    }

    let response: Response;
    try {
      response = await this.fetchImplementation(url, {
        headers: {
          Accept: "application/vnd.github+json",
          "User-Agent": "gitropolis",
          "X-GitHub-Api-Version": GITHUB_API_VERSION,
        },
        signal: AbortSignal.timeout(30_000),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown error";
      throw new GitHubApiError(null, `GitHub request failed: ${message}`);
    }

    if (!response.ok) {
      throw new GitHubApiError(
        response.status,
        await readErrorMessage(response),
      );
    }

    return {
      data: (await response.json()) as T,
      headers: response.headers,
    };
  }
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
