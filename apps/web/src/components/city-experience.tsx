"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";

import {
  CityCanvas,
  type CityHover,
  type CityPerformanceMetrics,
} from "@/components/city-canvas";
import {
  fetchCitySnapshot,
  type CityRepository,
  type CitySnapshot,
} from "@/lib/city-schema";

function compactNumber(value: number): string {
  return new Intl.NumberFormat("en", {
    notation: value >= 10_000 ? "compact" : "standard",
    maximumFractionDigits: 1,
  }).format(value);
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("en", {
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(new Date(value));
}

export function CityExperience() {
  const [snapshot, setSnapshot] = useState<CitySnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [enabledDistricts, setEnabledDistricts] = useState<Set<string>>(new Set());
  const [topN, setTopN] = useState(100);
  const [hover, setHover] = useState<CityHover | null>(null);
  const [selected, setSelected] = useState<CityRepository | null>(null);
  const [focusRepositoryId, setFocusRepositoryId] = useState<number | null>(null);
  const [performanceMetrics, setPerformanceMetrics] = useState<CityPerformanceMetrics | null>(null);

  useEffect(() => {
    let active = true;
    fetchCitySnapshot()
      .then((result) => {
        if (!active) {
          return;
        }
        setSnapshot(result);
        setEnabledDistricts(new Set(result.districts.map((district) => district.id)));
        setTopN(Math.max(...result.display.top_n_options));
      })
      .catch((reason: unknown) => {
        if (active) {
          setError(reason instanceof Error ? reason.message : "City data could not be loaded.");
        }
      });

    return () => {
      active = false;
    };
  }, []);

  const rankedRepositories = useMemo(
    () =>
      snapshot?.repositories.toSorted(
        (left, right) => left.global_rank - right.global_rank,
      ) ?? [],
    [snapshot],
  );

  const toggleDistrict = useCallback((districtId: string) => {
    setEnabledDistricts((current) => {
      const next = new Set(current);
      if (next.has(districtId)) {
        next.delete(districtId);
      } else {
        next.add(districtId);
      }
      return next;
    });
  }, []);

  const selectRepository = useCallback((repository: CityRepository) => {
    setSelected(repository);
    setFocusRepositoryId(repository.repository_id);
  }, []);

  if (error) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-[#030610] px-6 text-slate-100">
        <section className="glass-panel max-w-lg p-7 text-center">
          <p className="eyebrow text-rose-300">CITY DATA ERROR</p>
          <h1 className="mt-3 text-2xl font-semibold">Gitropolis could not be constructed.</h1>
          <p className="mt-3 text-sm leading-6 text-slate-400">{error}</p>
        </section>
      </main>
    );
  }

  if (!snapshot) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-[#030610] text-slate-100">
        <div className="text-center">
          <div className="mx-auto size-12 animate-spin rounded-full border border-cyan-300/20 border-t-cyan-300" />
          <p className="mt-5 text-sm font-semibold tracking-[0.32em]">CONSTRUCTING GITROPOLIS</p>
          <p className="mt-2 text-xs text-slate-500">Validating city-v1 data…</p>
        </div>
      </main>
    );
  }

  const totalStars = snapshot.repositories.reduce((sum, repository) => sum + repository.stars, 0);
  const totalWatchEvents = snapshot.repositories.reduce(
    (sum, repository) => sum + repository.watch_events_window,
    0,
  );
  const visibleRepositories = snapshot.repositories.filter((repository) =>
    enabledDistricts.has(repository.district_id),
  ).length;
  const selectedDistrict = selected
    ? snapshot.districts.find((district) => district.id === selected.district_id)
    : null;
  const archiveCoverageComplete =
    snapshot.source.archive_coverage_complete ??
    snapshot.source.activity_coverage_complete;
  const metadataCoverageComplete =
    snapshot.source.metadata_coverage_complete ??
    snapshot.source.activity_coverage_complete;

  return (
    <main
      className="relative h-dvh min-h-[680px] overflow-hidden bg-[#030610] text-slate-100"
      data-performance-metrics={
        performanceMetrics ? JSON.stringify(performanceMetrics) : undefined
      }
    >
      <CityCanvas
        snapshot={snapshot}
        enabledDistricts={enabledDistricts}
        topN={topN}
        focusRepositoryId={focusRepositoryId}
        onHover={setHover}
        onSelect={selectRepository}
        onMetrics={setPerformanceMetrics}
      />

      <header className="glass-panel absolute left-4 top-4 z-10 w-[min(350px,calc(100vw-32px))] p-4 md:left-6 md:top-6">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="eyebrow text-cyan-300">LIVE ECOSYSTEM RADAR</p>
            <h1 className="mt-1 text-xl font-black tracking-[0.16em] md:text-2xl">
              GITR<span className="text-cyan-300">O</span>POLIS
            </h1>
          </div>
          <Link className="ghost-link" href="/list">
            LIST ↗
          </Link>
        </div>
        <p className="mt-2 max-w-[30rem] text-xs leading-5 text-slate-400">
          Momentum across the GitHub AI ecosystem, rendered as a city.
        </p>
        <dl className="mt-4 grid grid-cols-4 gap-3 border-t border-white/8 pt-3">
          <Stat value={visibleRepositories} label="buildings" />
          <Stat value={compactNumber(totalStars)} label="stars" />
          <Stat value={totalWatchEvents} label="watches" />
          <Stat value={snapshot.communities.length} label="communities" />
        </dl>
      </header>

      <section className="glass-panel absolute left-6 top-[240px] z-10 hidden max-w-[calc(100vw-48px)] flex-wrap gap-1.5 p-2 lg:flex 2xl:left-1/2 2xl:top-6 2xl:-translate-x-1/2 2xl:flex-nowrap">
        {snapshot.districts.map((district) => {
          const enabled = enabledDistricts.has(district.id);
          return (
            <button
              className={`district-button ${enabled ? "" : "is-off"}`}
              key={district.id}
              onClick={() => toggleDistrict(district.id)}
              type="button"
              aria-pressed={enabled}
            >
              <span className="size-2 rounded-full" style={{ backgroundColor: district.color }} />
              {district.label}
            </button>
          );
        })}
      </section>

      <aside className="glass-panel absolute right-4 top-4 z-10 hidden w-72 overflow-hidden md:block md:right-6 md:top-6">
        <div className="flex items-center justify-between border-b border-white/8 px-4 py-3">
          <div>
            <p className="eyebrow text-violet-300">MOMENTUM RANK</p>
            <p className="mt-1 text-[11px] text-slate-500">WatchEvents in this window</p>
          </div>
          <span className="rounded-full bg-white/5 px-2 py-1 text-[10px] text-slate-400">
            {formatDate(snapshot.window.from)}
          </span>
        </div>
        <div className="max-h-[calc(100dvh-250px)] overflow-y-auto p-2">
          {rankedRepositories.map((repository) => {
            const district = snapshot.districts.find(
              (item) => item.id === repository.district_id,
            );
            return (
              <button
                className="rank-row"
                key={repository.repository_id}
                onClick={() => selectRepository(repository)}
                type="button"
              >
                <span className="w-5 text-[10px] tabular-nums text-slate-600">
                  {repository.global_rank.toString().padStart(2, "0")}
                </span>
                <span
                  className="size-1.5 shrink-0 rounded-full shadow-[0_0_8px_currentColor]"
                  style={{ color: district?.color, backgroundColor: district?.color }}
                />
                <span className="min-w-0 flex-1 truncate text-left text-xs">
                  {repository.full_name}
                </span>
                <span className="text-[11px] font-semibold tabular-nums text-emerald-300">
                  +{repository.watch_events_window}
                </span>
              </button>
            );
          })}
        </div>
      </aside>

      <section className="glass-panel absolute bottom-4 left-4 z-10 hidden w-72 p-4 md:block md:bottom-6 md:left-6">
        <p className="eyebrow text-slate-400">VISUAL LANGUAGE</p>
        <ul className="mt-3 space-y-2 text-[11px] text-slate-400">
          <li><LegendMark color="#5ee0ff" />Height — observed WatchEvents</li>
          <li><LegendMark color="#a78bfa" />Footprint — stars and forks</li>
          <li><LegendMark color="#e8fbff" />Windows — commits in latest 30d</li>
          <li><LegendMark color="#39465c" />Neutral windows — data unavailable</li>
          <li><LegendMark color="#334155" />Platform — broad AI district</li>
        </ul>
        <p className="mt-3 border-t border-white/8 pt-3 text-[10px] leading-4 text-slate-500">
          Drag to orbit · wheel to zoom · right-drag to pan
        </p>
      </section>

      <section className="glass-panel absolute bottom-4 left-1/2 z-10 flex -translate-x-1/2 items-center gap-3 px-4 py-3 md:bottom-6">
        <label className="eyebrow whitespace-nowrap text-slate-400" htmlFor="top-n">
          HIGHLIGHT
        </label>
        <select
          className="rounded-lg border border-cyan-300/20 bg-[#09101f] px-3 py-1.5 text-xs text-cyan-100 outline-none"
          id="top-n"
          value={topN}
          onChange={(event) => setTopN(Number(event.target.value))}
        >
          {snapshot.display.top_n_options.map((option) => (
            <option key={option} value={option}>TOP {option}</option>
          ))}
        </select>
        <span className="hidden text-[10px] text-slate-500 sm:inline">All buildings stay loaded</span>
      </section>

      <section className="glass-panel absolute bottom-4 right-4 z-10 hidden w-72 p-4 md:block md:bottom-6 md:right-6">
        <div className="flex items-center justify-between gap-3">
          <p className="eyebrow text-slate-400">DATA COVERAGE</p>
          <span className={archiveCoverageComplete ? "coverage-good" : "coverage-partial"}>
            {archiveCoverageComplete ? "ARCHIVE COMPLETE" : "ARCHIVE PARTIAL"}
          </span>
        </div>
        <p className="mt-3 text-[11px] leading-5 text-slate-400">
          {formatDate(snapshot.window.from)} → {formatDate(snapshot.window.to)} · {snapshot.methodology.builder}
        </p>
        <p className="mt-2 text-[10px] leading-4 text-slate-500">
          GitHub metadata: {metadataCoverageComplete ? "complete" : "partial"}
          {snapshot.source.metadata_collected_at
            ? ` · current as collected ${formatDate(snapshot.source.metadata_collected_at)}`
            : ""}
        </p>
        {performanceMetrics && (
          <dl className="mt-3 grid grid-cols-4 gap-2 border-t border-white/8 pt-3">
            <Stat value={performanceMetrics.loadedBuildings} label="loaded" />
            <Stat value={performanceMetrics.visibleBuildings} label="visible" />
            <Stat value={performanceMetrics.framesPerSecond} label="fps" />
            <Stat value={performanceMetrics.drawCalls} label="draws" />
          </dl>
        )}
      </section>

      {hover && (
        <div
          className="glass-panel pointer-events-none fixed z-30 w-[340px] max-w-[calc(100vw-24px)] p-4"
          style={{
            left: Math.max(12, Math.min(hover.clientX + 18, window.innerWidth - 352)),
            top: Math.max(12, Math.min(hover.clientY + 18, window.innerHeight - 390)),
          }}
        >
          <p className="eyebrow" style={{ color: snapshot.districts.find((district) => district.id === hover.repository.district_id)?.color }}>
            {hover.repository.district_id} / {hover.repository.community_id}
          </p>
          <p className="mt-2 truncate text-sm font-semibold">{hover.repository.full_name}</p>
          <p className="mt-2 line-clamp-3 text-[11px] leading-5 text-slate-300">
            {hover.repository.description ?? "No GitHub description available."}
          </p>
          <div className="mt-3 grid grid-cols-3 gap-3 border-t border-white/8 pt-3">
            <Stat value={`+${hover.repository.watch_events_window}`} label="watches" />
            <Stat value={compactNumber(hover.repository.stars)} label="stars" />
            <Stat value={compactNumber(hover.repository.forks)} label="forks" />
          </div>
          <p className="mt-3 line-clamp-2 text-[10px] leading-4 text-slate-500">
            {hover.repository.keywords.slice(0, 7).join(" · ")}
          </p>
          <div className="mt-3 border-t border-white/8 pt-3">
            <p className="eyebrow text-cyan-200">
              {hover.repository.detection_explanation?.label ?? "Why Gitropolis noticed it"}
            </p>
            <p className="mt-1 line-clamp-3 text-[10px] leading-4 text-slate-400">
              {hover.repository.detection_explanation?.summary ??
                `Observed ${hover.repository.watch_events_window} WatchEvents in this UTC window.`}
            </p>
            <p className="mt-2 text-[10px] text-slate-500">
              {hover.repository.commits_30d === null
                ? "Activity data unavailable"
                : `${compactNumber(hover.repository.commits_30d)} commits in latest 30d`}
            </p>
          </div>
        </div>
      )}

      {selected && (
        <section className="glass-panel absolute bottom-24 left-4 z-20 w-[min(380px,calc(100vw-32px))] p-4 md:bottom-6 md:left-auto md:right-[318px] md:w-80">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="eyebrow" style={{ color: selectedDistrict?.color }}>
                SELECTED BUILDING
              </p>
              <p className="mt-2 break-all text-sm font-semibold">{selected.full_name}</p>
            </div>
            <button
              className="text-lg leading-none text-slate-500 hover:text-white"
              onClick={() => setSelected(null)}
              type="button"
              aria-label="Close repository details"
            >
              ×
            </button>
          </div>
          <p className="mt-3 text-[11px] leading-5 text-slate-300">
            {selected.description ?? "No GitHub description available."}
          </p>
          <div className="mt-3 border-t border-white/8 pt-3">
            <p className="eyebrow text-cyan-200">
              {selected.detection_explanation?.label ?? "Why Gitropolis noticed it"}
            </p>
            <p className="mt-1 text-[10px] leading-4 text-slate-400">
              {selected.detection_explanation?.summary ??
                `Observed ${selected.watch_events_window} WatchEvents in this UTC window.`}
            </p>
          </div>
          <a className="ghost-link mt-3 inline-flex" href={selected.url} target="_blank" rel="noreferrer">
            OPEN ON GITHUB ↗
          </a>
        </section>
      )}

      <div className="pointer-events-none absolute inset-x-0 top-0 h-40 bg-gradient-to-b from-[#030610]/50 to-transparent" />
    </main>
  );
}

function Stat({ value, label }: { value: number | string; label: string }) {
  return (
    <div>
      <dt className="text-sm font-semibold tabular-nums text-slate-100">{value}</dt>
      <dd className="mt-0.5 text-[9px] uppercase tracking-[0.08em] text-slate-500">{label}</dd>
    </div>
  );
}

function LegendMark({ color }: { color: string }) {
  return (
    <span
      className="mr-2 inline-block size-2 rounded-sm shadow-[0_0_8px_currentColor]"
      style={{ color, backgroundColor: color }}
    />
  );
}
