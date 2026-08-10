import type { ActivitySeriesSnapshot } from "./types/activity-series.js";
import type {
  IntegrityVerificationStatus,
  LifecycleDecisionCoverage,
  RepositoryAvailabilityStatus,
  RepositoryBreakoutStatus,
  RepositoryLifecycleEvent,
  RepositoryLifecycleEventType,
  RepositoryLifecycleRepository,
  RepositoryLifecycleRules,
  RepositoryLifecycleSnapshot,
  RepositoryLifecycleWeek,
  RepositoryRadarStatus,
} from "./types/repository-lifecycle.js";

const DAY_MS = 24 * 60 * 60 * 1_000;

export const DEFAULT_REPOSITORY_LIFECYCLE_RULES: RepositoryLifecycleRules = {
  methodology_version: "repository-lifecycle-rules-v1",
  main_daily_watch_events: 5,
  scout_weekly_watch_events: 3,
  fast_breakout_weekly_watch_events: 10,
  active_after_qualified_weeks: 2,
  inactive_after_below_scout_weeks: 2,
};

export interface RepositoryLifecycleInputSnapshot {
  path: string;
  snapshot: ActivitySeriesSnapshot;
}

export interface RepositoryLifecycleThresholds {
  mainDailyWatchEvents?: number;
  scoutWeeklyWatchEvents?: number;
  fastBreakoutWeeklyWatchEvents?: number;
}

interface InputDay {
  date: string;
  hoursCollected: number;
  recordCoverageComplete: boolean;
  integrity: IntegrityVerificationStatus;
}

interface WeekContext {
  from: string;
  to: string;
  dates: string[];
  calendarComplete: boolean;
  hourCoverageComplete: boolean;
  recordCoverageComplete: boolean;
  decisionCoverage: LifecycleDecisionCoverage;
  integrity: IntegrityVerificationStatus;
}

interface RepositoryAggregate {
  repositoryId: number | null;
  fullName: string;
  aliases: Set<string>;
  availability: RepositoryAvailabilityStatus;
  firstObservedAt: string;
  lastObservedAt: string;
  daily: Map<string, number>;
}

interface RepositoryTracker {
  aggregate: RepositoryAggregate;
  status: RepositoryRadarStatus | null;
  coolingFrom: "candidate" | "active" | null;
  consecutiveQualifiedWeeks: number;
  consecutiveBelowScoutWeeks: number;
  firstDetectedAt: string | null;
  stateChangedAt: string | null;
  lastQualifiedWeek: string | null;
  fastBreakout: boolean;
  breakoutStatus: RepositoryBreakoutStatus | null;
  breakoutDetectedAt: string | null;
  lastFastBreakout: boolean;
  weeks: RepositoryLifecycleWeek[];
}

export function deriveRepositoryLifecycle(
  inputs: readonly RepositoryLifecycleInputSnapshot[],
  thresholds: RepositoryLifecycleThresholds = {},
): RepositoryLifecycleSnapshot {
  if (inputs.length === 0) {
    throw new Error("Lifecycle derivation requires at least one input snapshot.");
  }
  const rules = lifecycleRules(thresholds);
  const days = collectInputDays(inputs);
  const weeks = buildWeekContexts(days);
  const aggregates = collectRepositories(inputs);
  const trackers = [...aggregates.values()]
    .sort((left, right) => compareNames(left.fullName, right.fullName))
    .map((aggregate) => createTracker(aggregate));
  const events: RepositoryLifecycleEvent[] = [];

  for (const week of weeks) {
    for (const tracker of trackers) {
      if (Date.parse(tracker.aggregate.firstObservedAt) >= Date.parse(week.to)) {
        continue;
      }
      processRepositoryWeek(tracker, week, rules, events);
    }
  }

  const weekSummaries = weeks.map((week) => {
    const metrics = trackers.map(({ aggregate }) =>
      repositoryWeekMetrics(aggregate, week, rules),
    );
    return {
      from: week.from,
      to: week.to,
      calendar_complete: week.calendarComplete,
      hour_coverage_complete: week.hourCoverageComplete,
      record_coverage_complete: week.recordCoverageComplete,
      decision_coverage: week.decisionCoverage,
      integrity_verification: week.integrity,
      repositories_observed: metrics.filter(
        ({ weeklyWatchEvents }) => weeklyWatchEvents > 0,
      ).length,
      main_radar_repositories: metrics.filter(
        ({ mainRadar }) => mainRadar === true,
      ).length,
      emerging_scout_repositories: metrics.filter(
        ({ emergingScout }) => emergingScout === true,
      ).length,
      fast_breakout_repositories: metrics.filter(
        ({ fastBreakout }) => fastBreakout === true,
      ).length,
    };
  });

  const firstDay = days[0];
  const lastDay = days.at(-1);
  if (!firstDay || !lastDay) {
    throw new Error("Lifecycle input did not contain any days.");
  }

  return {
    schema_version: "repository-lifecycle-v1",
    generated_at: dateAtMidnight(addDays(lastDay.date, 1)),
    window: {
      from: dateAtMidnight(firstDay.date),
      to: dateAtMidnight(addDays(lastDay.date, 1)),
    },
    methodology: rules,
    source: {
      input_schema_version: "activity-series-v1",
      input_snapshots: inputs.map(({ path, snapshot }) => ({
        file_name: inputFileName(path),
        from: snapshot.window.from,
        to: snapshot.window.to,
        days: snapshot.window.days,
        archive_coverage_complete:
          snapshot.source.archive_coverage_complete,
        integrity_verification: snapshotIntegrity(snapshot),
      })),
      coverage_complete: weeks.every(
        ({ recordCoverageComplete }) => recordCoverageComplete,
      ),
      integrity_verification: combineIntegrity(
        inputs.map(({ snapshot }) => snapshotIntegrity(snapshot)),
      ),
    },
    weeks: weekSummaries,
    repositories: trackers.map(repositorySnapshot),
    events,
  };
}

function lifecycleRules(
  thresholds: RepositoryLifecycleThresholds,
): RepositoryLifecycleRules {
  const rules = {
    ...DEFAULT_REPOSITORY_LIFECYCLE_RULES,
    ...(thresholds.mainDailyWatchEvents === undefined
      ? {}
      : { main_daily_watch_events: thresholds.mainDailyWatchEvents }),
    ...(thresholds.scoutWeeklyWatchEvents === undefined
      ? {}
      : { scout_weekly_watch_events: thresholds.scoutWeeklyWatchEvents }),
    ...(thresholds.fastBreakoutWeeklyWatchEvents === undefined
      ? {}
      : {
          fast_breakout_weekly_watch_events:
            thresholds.fastBreakoutWeeklyWatchEvents,
        }),
  };
  for (const [name, value] of [
    ["main daily", rules.main_daily_watch_events],
    ["Scout weekly", rules.scout_weekly_watch_events],
    ["fast breakout weekly", rules.fast_breakout_weekly_watch_events],
  ] as const) {
    if (!Number.isInteger(value) || value < 1) {
      throw new Error(`${name} WatchEvent threshold must be a positive integer.`);
    }
  }
  if (
    rules.fast_breakout_weekly_watch_events <
    rules.scout_weekly_watch_events
  ) {
    throw new Error(
      "Fast breakout threshold must be at least the Scout threshold.",
    );
  }
  return rules;
}

function collectInputDays(
  inputs: readonly RepositoryLifecycleInputSnapshot[],
): InputDay[] {
  const days: InputDay[] = [];
  let expectedDate: string | null = null;
  let previousFrom = -Infinity;

  for (const { snapshot } of inputs) {
    const from = Date.parse(snapshot.window.from);
    if (!Number.isFinite(from) || from <= previousFrom) {
      throw new Error("Lifecycle inputs must be ordered by ascending window.from.");
    }
    previousFrom = from;
    if (snapshot.days.length !== snapshot.window.days) {
      throw new Error("Activity-series day count does not match window.days.");
    }
    for (const day of snapshot.days) {
      if (expectedDate && day.date !== expectedDate) {
        throw new Error(
          `Lifecycle input days must be consecutive; expected ${expectedDate} but found ${day.date}.`,
        );
      }
      days.push({
        date: day.date,
        hoursCollected: day.hours_collected,
        recordCoverageComplete: day.coverage_complete,
        integrity: day.event_integrity?.deduplication_applied
          ? "verified"
          : "unavailable",
      });
      expectedDate = addDays(day.date, 1);
    }
  }
  if (days.length === 0) {
    throw new Error("Lifecycle input snapshots must contain at least one day.");
  }
  return days;
}

function buildWeekContexts(days: readonly InputDay[]): WeekContext[] {
  const byDate = new Map(days.map((day) => [day.date, day]));
  const lastDate = days.at(-1)?.date;
  if (!lastDate) {
    return [];
  }
  const weeks: WeekContext[] = [];
  for (
    let weekFrom = isoWeekStart(days[0]?.date ?? "");
    weekFrom <= lastDate;
    weekFrom = addDays(weekFrom, 7)
  ) {
    const dates = Array.from({ length: 7 }, (_, index) =>
      addDays(weekFrom, index),
    );
    const present = dates
      .map((date) => byDate.get(date))
      .filter((day): day is InputDay => day !== undefined);
    const calendarComplete = present.length === 7;
    const hourCoverageComplete =
      calendarComplete && present.every(({ hoursCollected }) => hoursCollected === 24);
    const recordCoverageComplete =
      hourCoverageComplete &&
      present.every(({ recordCoverageComplete: complete }) => complete);
    weeks.push({
      from: dateAtMidnight(weekFrom),
      to: dateAtMidnight(addDays(weekFrom, 7)),
      dates,
      calendarComplete,
      hourCoverageComplete,
      recordCoverageComplete,
      decisionCoverage: !hourCoverageComplete
        ? "temporal-incomplete"
        : recordCoverageComplete
          ? "complete"
          : "record-warning",
      integrity: combineIntegrity(present.map(({ integrity }) => integrity)),
    });
  }
  return weeks;
}

function collectRepositories(
  inputs: readonly RepositoryLifecycleInputSnapshot[],
): Map<string, RepositoryAggregate> {
  const idByName = new Map<string, number>();
  for (const { snapshot } of inputs) {
    for (const repository of snapshot.repositories) {
      if (repository.current) {
        idByName.set(repository.full_name.toLowerCase(), repository.current.id);
        idByName.set(
          repository.current.full_name.toLowerCase(),
          repository.current.id,
        );
      }
    }
  }

  const aggregates = new Map<string, RepositoryAggregate>();
  for (const { snapshot } of inputs) {
    for (const repository of snapshot.repositories) {
      const repositoryId =
        repository.current?.id ??
        idByName.get(repository.full_name.toLowerCase()) ??
        null;
      const key = repositoryId === null
        ? `name:${repository.full_name.toLowerCase()}`
        : `id:${repositoryId}`;
      const aggregate = aggregates.get(key) ?? {
        repositoryId,
        fullName: repository.current?.full_name ?? repository.full_name,
        aliases: new Set<string>(),
        availability: "unknown" as const,
        firstObservedAt: repository.first_seen_at,
        lastObservedAt: repository.last_seen_at,
        daily: new Map<string, number>(),
      };
      aggregate.aliases.add(repository.full_name);
      if (repository.current) {
        aggregate.aliases.add(repository.current.full_name);
        aggregate.fullName = repository.current.full_name;
        aggregate.availability = "available";
      } else {
        aggregate.fullName = repository.full_name;
        if (repository.metadata_selected) {
          aggregate.availability = "unavailable";
        }
      }
      if (Date.parse(repository.first_seen_at) < Date.parse(aggregate.firstObservedAt)) {
        aggregate.firstObservedAt = repository.first_seen_at;
      }
      if (Date.parse(repository.last_seen_at) > Date.parse(aggregate.lastObservedAt)) {
        aggregate.lastObservedAt = repository.last_seen_at;
      }
      for (const day of repository.daily) {
        aggregate.daily.set(
          day.date,
          (aggregate.daily.get(day.date) ?? 0) + day.watch_events_observed,
        );
      }
      aggregates.set(key, aggregate);
    }
  }
  return aggregates;
}

function createTracker(aggregate: RepositoryAggregate): RepositoryTracker {
  return {
    aggregate,
    status: null,
    coolingFrom: null,
    consecutiveQualifiedWeeks: 0,
    consecutiveBelowScoutWeeks: 0,
    firstDetectedAt: null,
    stateChangedAt: null,
    lastQualifiedWeek: null,
    fastBreakout: false,
    breakoutStatus: null,
    breakoutDetectedAt: null,
    lastFastBreakout: false,
    weeks: [],
  };
}

function processRepositoryWeek(
  tracker: RepositoryTracker,
  week: WeekContext,
  rules: RepositoryLifecycleRules,
  events: RepositoryLifecycleEvent[],
): void {
  const metrics = repositoryWeekMetrics(tracker.aggregate, week, rules);
  const qualifies = metrics.emergingScout === true;
  const confirmedBelow = metrics.emergingScout === false;
  const fastBreakout = metrics.fastBreakout === true;
  const incompleteAffectsDecision =
    week.decisionCoverage === "temporal-incomplete"
      ? tracker.status !== null || tracker.breakoutStatus === "pending"
      : week.decisionCoverage === "record-warning" &&
        !qualifies &&
        (tracker.status !== null || tracker.breakoutStatus === "pending");

  if (incompleteAffectsDecision) {
    recordEvent(
      tracker,
      events,
      "data_incomplete",
      week.from,
      tracker.status,
      tracker.status,
      week.decisionCoverage === "temporal-incomplete"
        ? "The calendar week or hourly archive coverage is incomplete; lifecycle state was preserved."
        : "Record-level coverage warnings were present; negative lifecycle transitions were blocked.",
    );
  }

  if (week.decisionCoverage === "temporal-incomplete") {
    tracker.consecutiveQualifiedWeeks = 0;
    appendRepositoryWeek(tracker, week, metrics);
    return;
  }

  const pendingFromPriorWeek =
    tracker.breakoutStatus === "pending" &&
    tracker.breakoutDetectedAt !== week.from;
  let breakoutConfirmed = false;
  if (pendingFromPriorWeek && qualifies) {
    tracker.breakoutStatus = "confirmed";
    breakoutConfirmed = true;
    recordEvent(
      tracker,
      events,
      "breakout_confirmed",
      week.from,
      tracker.status,
      tracker.status,
      "A pending fast breakout retained at least the Scout threshold in the following observed week.",
    );
  } else if (pendingFromPriorWeek && confirmedBelow) {
    tracker.breakoutStatus = "unconfirmed";
    recordEvent(
      tracker,
      events,
      "breakout_unconfirmed",
      week.from,
      tracker.status,
      tracker.status,
      "A pending fast breakout fell below the Scout threshold in the following complete week.",
    );
  }

  const newFastBreakout = fastBreakout && !tracker.lastFastBreakout;
  const requiresBreakoutConfirmation =
    newFastBreakout && (tracker.status === null || tracker.status === "inactive");
  if (newFastBreakout) {
    tracker.fastBreakout = true;
    tracker.breakoutDetectedAt = week.from;
    tracker.breakoutStatus = requiresBreakoutConfirmation
      ? "pending"
      : "confirmed";
    recordEvent(
      tracker,
      events,
      "breakout_detected",
      week.from,
      tracker.status,
      tracker.status,
      requiresBreakoutConfirmation
        ? "A new or revived repository reached the fast-breakout threshold and requires next-week confirmation."
        : "An already tracked repository reached the fast-breakout threshold.",
    );
  }

  if (qualifies) {
    handleQualifiedWeek(
      tracker,
      week,
      metrics.weeklyWatchEvents,
      events,
      requiresBreakoutConfirmation,
      breakoutConfirmed,
    );
    tracker.lastFastBreakout = fastBreakout;
  } else if (confirmedBelow) {
    handleBelowScoutWeek(tracker, week, events);
    tracker.lastFastBreakout = false;
  } else {
    tracker.consecutiveQualifiedWeeks = 0;
  }
  appendRepositoryWeek(tracker, week, metrics);
}

function handleQualifiedWeek(
  tracker: RepositoryTracker,
  week: WeekContext,
  weeklyWatchEvents: number,
  events: RepositoryLifecycleEvent[],
  requiresBreakoutConfirmation: boolean,
  breakoutConfirmed: boolean,
): void {
  tracker.lastQualifiedWeek = week.from;
  tracker.consecutiveBelowScoutWeeks = 0;

  if (tracker.status === null) {
    tracker.consecutiveQualifiedWeeks = 1;
    if (
      !requiresBreakoutConfirmation &&
      hasGradualGrowth(tracker, weeklyWatchEvents)
    ) {
      changeStatus(
        tracker,
        events,
        "active",
        "activated",
        week.from,
        "Three consecutive complete weeks increased and the current week reached the Scout threshold.",
      );
    } else {
      changeStatus(
        tracker,
        events,
        "candidate",
        "candidate_detected",
        week.from,
        requiresBreakoutConfirmation
          ? "A first-week fast breakout entered as a candidate pending confirmation."
          : "The repository reached the Scout threshold for the first time.",
      );
    }
    return;
  }

  if (tracker.status === "inactive") {
    tracker.consecutiveQualifiedWeeks = 1;
    changeStatus(
      tracker,
      events,
      "candidate",
      "revived",
      week.from,
      requiresBreakoutConfirmation
        ? "An inactive repository returned above Scout with a fast breakout pending confirmation."
        : "An inactive repository returned above the Scout threshold.",
    );
    return;
  }

  if (tracker.status === "cooling") {
    const restored = tracker.coolingFrom ?? "candidate";
    tracker.consecutiveQualifiedWeeks = 1;
    changeStatus(
      tracker,
      events,
      restored,
      restored === "active" ? "activated" : "candidate_detected",
      week.from,
      `The repository recovered above Scout after one cooling week and returned to ${restored}.`,
    );
    tracker.coolingFrom = null;
    return;
  }

  tracker.consecutiveQualifiedWeeks += 1;
  if (
    tracker.status === "candidate" &&
    (breakoutConfirmed || tracker.consecutiveQualifiedWeeks >= 2)
  ) {
    changeStatus(
      tracker,
      events,
      "active",
      "activated",
      week.from,
      breakoutConfirmed
        ? "The prior fast breakout was confirmed by continued Scout activity."
        : "The repository met the Scout threshold for two consecutive observed weeks.",
    );
  }
}

function handleBelowScoutWeek(
  tracker: RepositoryTracker,
  week: WeekContext,
  events: RepositoryLifecycleEvent[],
): void {
  tracker.consecutiveQualifiedWeeks = 0;
  if (tracker.status === null) {
    return;
  }
  if (tracker.status === "inactive") {
    tracker.consecutiveBelowScoutWeeks += 1;
    return;
  }
  if (tracker.status === "cooling") {
    tracker.consecutiveBelowScoutWeeks += 1;
    if (tracker.consecutiveBelowScoutWeeks >= 2) {
      changeStatus(
        tracker,
        events,
        "inactive",
        "inactivated",
        week.from,
        "The repository remained below Scout for two consecutive complete weeks.",
      );
      tracker.coolingFrom = null;
    }
    return;
  }

  tracker.coolingFrom = tracker.status;
  tracker.consecutiveBelowScoutWeeks = 1;
  changeStatus(
    tracker,
    events,
    "cooling",
    "cooling_started",
    week.from,
    "The repository fell below Scout for the first complete week.",
  );
}

function hasGradualGrowth(
  tracker: RepositoryTracker,
  weeklyWatchEvents: number,
): boolean {
  const previous = tracker.weeks.slice(-2);
  if (
    previous.length !== 2 ||
    previous.some(({ decision_coverage: coverage }) => coverage !== "complete")
  ) {
    return false;
  }
  const [first, second] = previous;
  return Boolean(
    first &&
    second &&
    first.weekly_watch_events < second.weekly_watch_events &&
    second.weekly_watch_events < weeklyWatchEvents,
  );
}

function changeStatus(
  tracker: RepositoryTracker,
  events: RepositoryLifecycleEvent[],
  nextStatus: RepositoryRadarStatus,
  eventType: RepositoryLifecycleEventType,
  week: string,
  reason: string,
): void {
  const previous = tracker.status;
  tracker.status = nextStatus;
  tracker.stateChangedAt = week;
  tracker.firstDetectedAt ??= week;
  recordEvent(
    tracker,
    events,
    eventType,
    week,
    previous,
    nextStatus,
    reason,
  );
}

function recordEvent(
  tracker: RepositoryTracker,
  events: RepositoryLifecycleEvent[],
  type: RepositoryLifecycleEventType,
  week: string,
  previousStatus: RepositoryRadarStatus | null,
  nextStatus: RepositoryRadarStatus | null,
  reason: string,
): void {
  events.push({
    repository_id: tracker.aggregate.repositoryId,
    full_name: tracker.aggregate.fullName,
    type,
    effective_week: week,
    previous_status: previousStatus,
    next_status: nextStatus,
    reason,
  });
}

function repositoryWeekMetrics(
  aggregate: RepositoryAggregate,
  week: WeekContext,
  rules: RepositoryLifecycleRules,
): {
  weeklyWatchEvents: number;
  maxDailyWatchEvents: number;
  activeDays: number;
  mainRadar: boolean | null;
  emergingScout: boolean | null;
  fastBreakout: boolean | null;
} {
  const daily = week.dates.map((date) => aggregate.daily.get(date) ?? 0);
  const weeklyWatchEvents = daily.reduce((total, count) => total + count, 0);
  const maxDailyWatchEvents = Math.max(0, ...daily);
  const activeDays = daily.filter((count) => count > 0).length;
  return {
    weeklyWatchEvents,
    maxDailyWatchEvents,
    activeDays,
    mainRadar: thresholdMembership(
      maxDailyWatchEvents,
      rules.main_daily_watch_events,
      week.recordCoverageComplete,
    ),
    emergingScout: thresholdMembership(
      weeklyWatchEvents,
      rules.scout_weekly_watch_events,
      week.recordCoverageComplete,
    ),
    fastBreakout: thresholdMembership(
      weeklyWatchEvents,
      rules.fast_breakout_weekly_watch_events,
      week.recordCoverageComplete,
    ),
  };
}

function thresholdMembership(
  observed: number,
  threshold: number,
  complete: boolean,
): boolean | null {
  if (observed >= threshold) {
    return true;
  }
  return complete ? false : null;
}

function appendRepositoryWeek(
  tracker: RepositoryTracker,
  week: WeekContext,
  metrics: ReturnType<typeof repositoryWeekMetrics>,
): void {
  tracker.weeks.push({
    from: week.from,
    to: week.to,
    calendar_complete: week.calendarComplete,
    hour_coverage_complete: week.hourCoverageComplete,
    record_coverage_complete: week.recordCoverageComplete,
    decision_coverage: week.decisionCoverage,
    integrity_verification: week.integrity,
    weekly_watch_events: metrics.weeklyWatchEvents,
    max_daily_watch_events: metrics.maxDailyWatchEvents,
    active_days: metrics.activeDays,
    main_radar: metrics.mainRadar,
    emerging_scout: metrics.emergingScout,
    fast_breakout: metrics.fastBreakout,
    radar_status: tracker.status,
    breakout_status: tracker.breakoutStatus,
    consecutive_qualified_weeks: tracker.consecutiveQualifiedWeeks,
    consecutive_below_scout_weeks: tracker.consecutiveBelowScoutWeeks,
  });
}

function repositorySnapshot(
  tracker: RepositoryTracker,
): RepositoryLifecycleRepository {
  return {
    repository_id: tracker.aggregate.repositoryId,
    full_name: tracker.aggregate.fullName,
    aliases: [...tracker.aggregate.aliases].sort(compareNames),
    availability_status: tracker.aggregate.availability,
    radar_status: tracker.status,
    first_observed_at: tracker.aggregate.firstObservedAt,
    last_observed_at: tracker.aggregate.lastObservedAt,
    first_detected_at: tracker.firstDetectedAt,
    state_changed_at: tracker.stateChangedAt,
    last_qualified_week: tracker.lastQualifiedWeek,
    consecutive_qualified_weeks: tracker.consecutiveQualifiedWeeks,
    consecutive_below_scout_weeks: tracker.consecutiveBelowScoutWeeks,
    fast_breakout: tracker.fastBreakout,
    breakout_status: tracker.breakoutStatus,
    breakout_detected_at: tracker.breakoutDetectedAt,
    weeks: tracker.weeks.filter(
      (week) =>
        week.weekly_watch_events > 0 ||
        week.radar_status !== null ||
        week.breakout_status === "pending",
    ),
  };
}

function snapshotIntegrity(
  snapshot: ActivitySeriesSnapshot,
): IntegrityVerificationStatus {
  const statuses = snapshot.days.map((day) =>
    day.event_integrity?.deduplication_applied
      ? "verified" as const
      : "unavailable" as const,
  );
  return combineIntegrity(statuses);
}

function combineIntegrity(
  statuses: readonly IntegrityVerificationStatus[],
): IntegrityVerificationStatus {
  if (statuses.length > 0 && statuses.every((status) => status === "verified")) {
    return "verified";
  }
  if (statuses.every((status) => status === "unavailable")) {
    return "unavailable";
  }
  return "partial";
}

function isoWeekStart(date: string): string {
  const parsed = parseDate(date);
  const daysSinceMonday = (parsed.getUTCDay() + 6) % 7;
  return new Date(parsed.getTime() - daysSinceMonday * DAY_MS)
    .toISOString()
    .slice(0, 10);
}

function addDays(date: string, count: number): string {
  return new Date(parseDate(date).getTime() + count * DAY_MS)
    .toISOString()
    .slice(0, 10);
}

function dateAtMidnight(date: string): string {
  return `${date}T00:00:00.000Z`;
}

function parseDate(date: string): Date {
  const parsed = new Date(`${date}T00:00:00.000Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(parsed.getTime())) {
    throw new Error(`Invalid activity date: ${date}`);
  }
  return parsed;
}

function compareNames(left: string, right: string): number {
  return left.localeCompare(right, "en", { sensitivity: "base" });
}

function inputFileName(path: string): string {
  return path.split(/[\\/]/).at(-1) ?? path;
}
