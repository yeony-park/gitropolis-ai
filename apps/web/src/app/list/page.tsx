import Link from "next/link";

import cityData from "../../../public/data/city.json";
import { citySnapshotSchema } from "@/lib/city-schema";

const snapshot = citySnapshotSchema.parse(cityData);

function compactNumber(value: number): string {
  return new Intl.NumberFormat("en", {
    notation: value >= 10_000 ? "compact" : "standard",
    maximumFractionDigits: 1,
  }).format(value);
}

export default function RepositoryListPage() {
  const repositories = snapshot.repositories.toSorted(
    (left, right) => left.global_rank - right.global_rank,
  );

  return (
    <main className="min-h-screen bg-[#030610] px-5 py-8 text-slate-100 md:px-10 md:py-12">
      <div className="mx-auto max-w-6xl">
        <header className="flex flex-col gap-5 border-b border-white/10 pb-8 md:flex-row md:items-end md:justify-between">
          <div>
            <p className="eyebrow text-cyan-300">ACCESSIBLE DATA VIEW</p>
            <h1 className="mt-3 text-3xl font-black tracking-[0.12em] md:text-5xl">
              GITR<span className="text-cyan-300">O</span>POLIS / LIST
            </h1>
            <p className="mt-3 max-w-2xl text-sm leading-6 text-slate-400">
              The same repositories shown in the 3D city, ordered by observed GitHub momentum.
            </p>
          </div>
          <Link className="ghost-link self-start md:self-auto" href="/">
            ← RETURN TO CITY
          </Link>
        </header>

        <section className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Summary value={snapshot.repositories.length} label="AI repositories" />
          <Summary value={snapshot.communities.length} label="communities" />
          <Summary value={snapshot.source.repositories_considered} label="screened repositories" />
          <Summary
            value={snapshot.source.coverage_complete ? "Complete" : "Partial"}
            label="source coverage"
            warning={!snapshot.source.coverage_complete}
          />
        </section>

        {!snapshot.source.lifecycle_coverage_complete && (
          <aside className="mt-6 rounded-xl border border-amber-300/15 bg-amber-300/5 px-4 py-3 text-xs leading-5 text-amber-100/70">
            Lifecycle transitions are not evaluated in this one-day canary. Activity and analysis coverage are complete; the weekly lifecycle window is intentionally partial.
          </aside>
        )}

        <section className="mt-8 overflow-hidden rounded-2xl border border-white/10 bg-white/[0.025]">
          <div className="hidden grid-cols-[52px_1fr_160px_100px_100px_120px] gap-4 border-b border-white/8 px-5 py-3 text-[9px] font-bold uppercase tracking-[0.16em] text-slate-500 md:grid">
            <span>Rank</span>
            <span>Repository</span>
            <span>Community</span>
            <span>Watches</span>
            <span>Stars</span>
            <span>AI relevance</span>
          </div>
          {repositories.map((repository) => {
            const district = snapshot.districts.find(
              (item) => item.id === repository.district_id,
            );
            const community = snapshot.communities.find(
              (item) => item.id === repository.community_id,
            );
            return (
              <article
                className="grid gap-4 border-b border-white/6 px-5 py-5 last:border-b-0 md:grid-cols-[52px_1fr_160px_100px_100px_120px] md:items-center"
                key={repository.repository_id}
              >
                <span className="text-xs tabular-nums text-slate-600">
                  #{repository.global_rank.toString().padStart(2, "0")}
                </span>
                <div className="min-w-0">
                  <a
                    className="break-all text-sm font-semibold text-slate-100 hover:text-cyan-200"
                    href={repository.url}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {repository.full_name} ↗
                  </a>
                  <p className="mt-2 line-clamp-1 text-[10px] text-slate-500">
                    {repository.keywords.slice(0, 8).join(" · ")}
                  </p>
                </div>
                <div className="flex items-center gap-2 text-xs text-slate-400">
                  <span
                    className="size-2 rounded-full shadow-[0_0_8px_currentColor]"
                    style={{ color: district?.color, backgroundColor: district?.color }}
                  />
                  {community?.label ?? repository.community_id}
                </div>
                <Metric value={`+${repository.watch_events_window}`} label="watches" />
                <Metric value={compactNumber(repository.stars)} label="stars" />
                <Metric value={`${Math.round(repository.ai_relevance * 100)}%`} label="rule score" />
              </article>
            );
          })}
        </section>

        <footer className="mt-8 text-[10px] leading-5 text-slate-600">
          Generated by {snapshot.methodology.builder}. Window: {snapshot.window.from} → {snapshot.window.to}.
        </footer>
      </div>
    </main>
  );
}

function Summary({
  value,
  label,
  warning = false,
}: {
  value: number | string;
  label: string;
  warning?: boolean;
}) {
  return (
    <div className="glass-panel px-4 py-3">
      <p className={`text-xl font-semibold ${warning ? "text-amber-200" : "text-slate-100"}`}>{value}</p>
      <p className="mt-1 text-[9px] uppercase tracking-[0.12em] text-slate-500">{label}</p>
    </div>
  );
}

function Metric({ value, label }: { value: string; label: string }) {
  return (
    <div>
      <p className="text-xs font-semibold tabular-nums text-slate-200">{value}</p>
      <p className="mt-0.5 text-[8px] uppercase tracking-[0.1em] text-slate-600 md:hidden">{label}</p>
    </div>
  );
}
