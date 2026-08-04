import type { GHArchiveEvent } from "./client.js";

const HOUR_MS = 60 * 60 * 1_000;

export type ParsedWatchEvent =
  | { kind: "ignored" }
  | {
      kind: "invalid";
      reason: WatchEventValidationError;
      message: string;
      eventId?: string;
    }
  | {
      kind: "watch";
      eventId: string;
      fullName: string;
      createdAt: string;
      timestamp: number;
    };

export type WatchEventValidationError =
  | "missing-event-id"
  | "invalid-event-id"
  | "invalid-action"
  | "invalid-repository"
  | "invalid-created-at"
  | "outside-hour";

export function parseWatchEvent(
  event: GHArchiveEvent,
  hour: Date,
): ParsedWatchEvent {
  if (event.type !== "WatchEvent") {
    return { kind: "ignored" };
  }
  if (event.id === undefined || event.id === null) {
    return {
      kind: "invalid",
      reason: "missing-event-id",
      message: "WatchEvent id is required",
    };
  }
  if (typeof event.id !== "string" || !/^[1-9]\d*$/.test(event.id)) {
    return {
      kind: "invalid",
      reason: "invalid-event-id",
      message: "WatchEvent id must be a positive decimal string",
    };
  }
  const eventId = event.id;
  if (event.payload?.action !== "started") {
    return {
      kind: "invalid",
      reason: "invalid-action",
      message: "WatchEvent payload.action must be 'started'",
      eventId,
    };
  }
  if (typeof event.repo?.name !== "string") {
    return {
      kind: "invalid",
      reason: "invalid-repository",
      message: "WatchEvent repo.name must be a repository name",
      eventId,
    };
  }
  if (typeof event.created_at !== "string") {
    return {
      kind: "invalid",
      reason: "invalid-created-at",
      message: "WatchEvent created_at must be an ISO timestamp",
      eventId,
    };
  }

  const timestamp = Date.parse(event.created_at);
  if (!Number.isFinite(timestamp)) {
    return {
      kind: "invalid",
      reason: "invalid-created-at",
      message: "WatchEvent created_at must be an ISO timestamp",
      eventId,
    };
  }
  if (!isRepositoryName(event.repo.name)) {
    return {
      kind: "invalid",
      reason: "invalid-repository",
      message: "WatchEvent repo.name must be a repository name",
      eventId,
    };
  }
  if (timestamp < hour.getTime() || timestamp >= hour.getTime() + HOUR_MS) {
    return {
      kind: "invalid",
      reason: "outside-hour",
      message: "WatchEvent created_at is outside its hourly archive window",
      eventId,
    };
  }

  return {
    kind: "watch",
    eventId,
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
