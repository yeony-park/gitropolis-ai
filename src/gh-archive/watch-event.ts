import type { GHArchiveEvent } from "./client.js";

const HOUR_MS = 60 * 60 * 1_000;

export type ParsedWatchEvent =
  | { kind: "ignored" }
  | { kind: "invalid"; message: string }
  | {
      kind: "watch";
      fullName: string;
      createdAt: string;
      timestamp: number;
    };

export function parseWatchEvent(
  event: GHArchiveEvent,
  hour: Date,
): ParsedWatchEvent {
  if (event.type !== "WatchEvent") {
    return { kind: "ignored" };
  }
  if (event.payload?.action !== "started") {
    return {
      kind: "invalid",
      message: "WatchEvent payload.action must be 'started'",
    };
  }
  if (typeof event.repo?.name !== "string") {
    return {
      kind: "invalid",
      message: "WatchEvent repo.name must be a repository name",
    };
  }
  if (typeof event.created_at !== "string") {
    return {
      kind: "invalid",
      message: "WatchEvent created_at must be an ISO timestamp",
    };
  }

  const timestamp = Date.parse(event.created_at);
  if (!Number.isFinite(timestamp)) {
    return {
      kind: "invalid",
      message: "WatchEvent created_at must be an ISO timestamp",
    };
  }
  if (!isRepositoryName(event.repo.name)) {
    return {
      kind: "invalid",
      message: "WatchEvent repo.name must be a repository name",
    };
  }
  if (timestamp < hour.getTime() || timestamp >= hour.getTime() + HOUR_MS) {
    return {
      kind: "invalid",
      message: "WatchEvent created_at is outside its hourly archive window",
    };
  }

  return {
    kind: "watch",
    fullName: event.repo.name,
    createdAt: event.created_at,
    timestamp,
  };
}

function isRepositoryName(value: string): boolean {
  return /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]+$/.test(
    value,
  );
}
