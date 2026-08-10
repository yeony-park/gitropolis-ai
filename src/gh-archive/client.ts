import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { createGunzip } from "node:zlib";

export const GH_ARCHIVE_DATA_URL = "https://data.gharchive.org";
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_RECORD_LINES = 16;
const DEFAULT_MAX_RECORD_BYTES = 1_048_576;

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
      recovered_lines?: number;
    }
  | {
      kind: "parse-error";
      line: number;
      line_end?: number;
      message: string;
    };

export interface GHArchiveSource {
  recordsForHour(hour: Date): AsyncIterable<GHArchiveRecord>;
}

export interface GHArchiveClientOptions {
  baseUrl?: string;
  fetchImplementation?: typeof fetch;
  requestTimeoutMs?: number;
  maxRecordLines?: number;
  maxRecordBytes?: number;
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
  private readonly maxRecordLines: number;
  private readonly maxRecordBytes: number;

  constructor(options: GHArchiveClientOptions = {}) {
    this.baseUrl = options.baseUrl ?? GH_ARCHIVE_DATA_URL;
    this.fetchImplementation = options.fetchImplementation ?? globalThis.fetch;
    this.requestTimeoutMs =
      options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.maxRecordLines =
      options.maxRecordLines ?? DEFAULT_MAX_RECORD_LINES;
    this.maxRecordBytes =
      options.maxRecordBytes ?? DEFAULT_MAX_RECORD_BYTES;
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
      let pending: PendingRecord | null = null;
      for await (const line of lines) {
        lineNumber += 1;
        if (line.trim() === "" && !pending) {
          continue;
        }

        const standalone = parseObject(line);
        if (pending && standalone.kind === "event") {
          yield {
            kind: "parse-error",
            line: pending.startLine,
            line_end: pending.endLine,
            message: pending.message,
          };
          pending = null;
        }

        if (!pending) {
          if (standalone.kind === "event") {
            yield {
              kind: "event",
              line: lineNumber,
              event: standalone.event,
            };
          } else if (isRecoverableMultilineStart(line)) {
            pending = {
              text: line,
              startLine: lineNumber,
              endLine: lineNumber,
              lines: 1,
              message: standalone.message,
            };
          } else {
            yield {
              kind: "parse-error",
              line: lineNumber,
              message: standalone.message,
            };
          }
          continue;
        }

        const recoveredText = `${pending.text}\\n${line}`;
        const recovered = parseObject(recoveredText);
        const recoveredLines = pending.lines + 1;
        const recoveredBytes = Buffer.byteLength(recoveredText);
        if (recovered.kind === "event") {
          yield {
            kind: "event",
            line: pending.startLine,
            event: recovered.event,
            recovered_lines: recoveredLines,
          };
          pending = null;
          continue;
        }

        if (
          recoveredLines < this.maxRecordLines &&
          recoveredBytes < this.maxRecordBytes &&
          isRecoverableMultilineStart(recoveredText)
        ) {
          pending = {
            text: recoveredText,
            startLine: pending.startLine,
            endLine: lineNumber,
            lines: recoveredLines,
            message: recovered.message,
          };
          continue;
        }

        yield {
          kind: "parse-error",
          line: pending.startLine,
          line_end: lineNumber,
          message: recovered.message,
        };
        pending = null;
      }

      if (pending) {
        yield {
          kind: "parse-error",
          line: pending.startLine,
          line_end: pending.endLine,
          message: pending.message,
        };
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

interface PendingRecord {
  text: string;
  startLine: number;
  endLine: number;
  lines: number;
  message: string;
}

type ParsedObject =
  | { kind: "event"; event: GHArchiveEvent }
  | { kind: "error"; message: string };

function parseObject(value: string): ParsedObject {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (typeof parsed === "object" && parsed !== null) {
      return { kind: "event", event: parsed as GHArchiveEvent };
    }
    return {
      kind: "error",
      message: "GH Archive record is not a JSON object",
    };
  } catch (error) {
    return {
      kind: "error",
      message: error instanceof Error ? error.message : "invalid JSON record",
    };
  }
}

function isRecoverableMultilineStart(value: string): boolean {
  const trimmed = value.trimStart();
  if (!trimmed.startsWith("{")) {
    return false;
  }

  let inString = false;
  let escaped = false;
  let objectDepth = 0;
  let arrayDepth = 0;
  for (const character of trimmed) {
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }

    if (character === '"') {
      inString = true;
    } else if (character === "{") {
      objectDepth += 1;
    } else if (character === "}") {
      objectDepth -= 1;
    } else if (character === "[") {
      arrayDepth += 1;
    } else if (character === "]") {
      arrayDepth -= 1;
    }

    if (objectDepth < 0 || arrayDepth < 0) {
      return false;
    }
  }

  return inString && objectDepth > 0;
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
