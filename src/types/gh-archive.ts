export interface GHArchiveEventIntegrity {
  deduplication_applied: true;
  raw_watch_events_seen: number;
  unique_watch_events: number;
  duplicate_event_ids: number;
  missing_event_ids: number;
  invalid_event_ids: number;
  invalid_watch_events: number;
  malformed_records: number;
}
