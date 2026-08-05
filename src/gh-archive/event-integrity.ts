import type { GHArchiveEvent } from "./client.js";
import {
  parseWatchEvent,
  type ParsedWatchEvent,
  type WatchEventValidationError,
} from "./watch-event.js";
import type { GHArchiveEventIntegrity } from "../types/gh-archive.js";

export interface EventIntegrityAccumulator {
  rawWatchEventsSeen: number;
  uniqueWatchEvents: number;
  duplicateEventIds: number;
  missingEventIds: number;
  invalidEventIds: number;
  invalidWatchEvents: number;
  malformedRecords: number;
}

export type InspectedWatchEvent =
  | { kind: "ignored" }
  | { kind: "duplicate"; eventId: string }
  | Extract<ParsedWatchEvent, { kind: "invalid" | "watch" }>;

export function createEventIntegrityAccumulator(): EventIntegrityAccumulator {
  return {
    rawWatchEventsSeen: 0,
    uniqueWatchEvents: 0,
    duplicateEventIds: 0,
    missingEventIds: 0,
    invalidEventIds: 0,
    invalidWatchEvents: 0,
    malformedRecords: 0,
  };
}

export function inspectWatchEvent(
  event: GHArchiveEvent,
  hour: Date,
  acceptedEventIds: Set<string>,
): InspectedWatchEvent {
  const parsed = parseWatchEvent(event, hour);
  if (parsed.kind === "ignored") {
    return parsed;
  }

  const eventId = parsed.eventId;
  if (eventId && acceptedEventIds.has(eventId)) {
    return { kind: "duplicate", eventId };
  }
  if (parsed.kind === "invalid") {
    return parsed;
  }

  acceptedEventIds.add(parsed.eventId);
  return parsed;
}

export function recordInspection(
  accumulator: EventIntegrityAccumulator,
  inspection: InspectedWatchEvent,
): void {
  if (inspection.kind === "ignored") {
    return;
  }

  accumulator.rawWatchEventsSeen += 1;
  if (inspection.kind === "watch") {
    accumulator.uniqueWatchEvents += 1;
    return;
  }
  if (inspection.kind === "duplicate") {
    accumulator.duplicateEventIds += 1;
    return;
  }

  accumulator.invalidWatchEvents += 1;
  recordIdentityError(accumulator, inspection.reason);
}

export function recordMalformedRecord(
  accumulator: EventIntegrityAccumulator,
): void {
  accumulator.malformedRecords += 1;
}

export function eventIntegritySnapshot(
  accumulator: EventIntegrityAccumulator,
): GHArchiveEventIntegrity {
  return {
    deduplication_applied: true,
    raw_watch_events_seen: accumulator.rawWatchEventsSeen,
    unique_watch_events: accumulator.uniqueWatchEvents,
    duplicate_event_ids: accumulator.duplicateEventIds,
    missing_event_ids: accumulator.missingEventIds,
    invalid_event_ids: accumulator.invalidEventIds,
    invalid_watch_events: accumulator.invalidWatchEvents,
    malformed_records: accumulator.malformedRecords,
  };
}

function recordIdentityError(
  accumulator: EventIntegrityAccumulator,
  reason: WatchEventValidationError,
): void {
  if (reason === "missing-event-id") {
    accumulator.missingEventIds += 1;
  } else if (reason === "invalid-event-id") {
    accumulator.invalidEventIds += 1;
  }
}
