import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { createGunzip } from "node:zlib";

export const GH_ARCHIVE_DATA_URL = "https://data.gharchive.org";
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;

export interface GHArchiveEvent {
  id?: unknown;
  type?: unknown;
  repo?: {
    name?: unknown;
  };
  payload?: {
    action?: unknown;
  };
  created_at?: unknown;
}

export type GHArchiveRecord =
  | {
      kind: "event";
      line: number;
      event: GHArchiveEvent;
    }
  | {
      kind: "parse-error";
      line: number;
      message: string;
    };

export interface GHArchiveSource {
  recordsForHour(hour: Date): AsyncIterable<GHArchiveRecord>;
}

export interface GHArchiveClientOptions {
  baseUrl?: string;
  fetchImplementation?: typeof fetch;
  requestTimeoutMs?: number;
}

export class GHArchiveError extends Error {
  constructor(
    readonly hour: string,
    readonly url: string,
    readonly status: number | null,
    message: string,
  ) {
    super(message);
    this.name = "GHArchiveError";
  }
}

export class GHArchiveClient implements GHArchiveSource {
  private readonly baseUrl: string;
  private readonly fetchImplementation: typeof fetch;
  private readonly requestTimeoutMs: number;

  constructor(options: GHArchiveClientOptions = {}) {
    this.baseUrl = options.baseUrl ?? GH_ARCHIVE_DATA_URL;
    this.fetchImplementation = options.fetchImplementation ?? globalThis.fetch;
    this.requestTimeoutMs =
      options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  }

  async *recordsForHour(hour: Date): AsyncIterable<GHArchiveRecord> {
    const url = ghArchiveHourUrl(hour, this.baseUrl);
    const hourLabel = hour.toISOString();
    let response: Response;
    try {
      response = await this.fetchImplementation(url, {
        signal: AbortSignal.timeout(this.requestTimeoutMs),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown error";
      throw new GHArchiveError(
        hourLabel,
        url,
        null,
        `GH Archive request failed: ${message}`,
      );
    }

    if (!response.ok) {
      throw new GHArchiveError(
        hourLabel,
        url,
        response.status,
        `GH Archive returned ${response.status}`,
      );
    }
    if (!response.body) {
      throw new GHArchiveError(
        hourLabel,
        url,
        response.status,
        "GH Archive returned an empty response body",
      );
    }

    const compressed = Readable.fromWeb(
      response.body as unknown as NodeReadableStream<Uint8Array>,
    );
    const lines = createInterface({
      input: compressed.pipe(createGunzip()),
      crlfDelay: Infinity,
    });

    try {
      let lineNumber = 0;
      for await (const line of lines) {
        lineNumber += 1;
        if (line.trim() === "") {
          continue;
        }
        try {
          const parsed = JSON.parse(line) as unknown;
          if (typeof parsed === "object" && parsed !== null) {
            yield {
              kind: "event",
              line: lineNumber,
              event: parsed as GHArchiveEvent,
            };
          } else {
            yield {
              kind: "parse-error",
              line: lineNumber,
              message: "GH Archive record is not a JSON object",
            };
          }
        } catch (error) {
          yield {
            kind: "parse-error",
            line: lineNumber,
            message:
              error instanceof Error ? error.message : "invalid JSON record",
          };
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown error";
      throw new GHArchiveError(
        hourLabel,
        url,
        response.status,
        `GH Archive stream could not be processed: ${message}`,
      );
    } finally {
      lines.close();
    }
  }
}

export function ghArchiveHourUrl(
  hour: Date,
  baseUrl = GH_ARCHIVE_DATA_URL,
): string {
  const year = hour.getUTCFullYear();
  const month = String(hour.getUTCMonth() + 1).padStart(2, "0");
  const day = String(hour.getUTCDate()).padStart(2, "0");
  const hourNumber = hour.getUTCHours();
  const filename = `${year}-${month}-${day}-${hourNumber}.json.gz`;
  return `${baseUrl.replace(/\/$/, "")}/${filename}`;
}
