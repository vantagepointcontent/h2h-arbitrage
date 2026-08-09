'use client';

import { useEffect, useMemo, useState } from 'react';
import { Clock3, RefreshCw } from 'lucide-react';

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const HOURS = Array.from({ length: 24 }, (_, hour) => hour);

type Cell = { day: number; hour: number; count: number };
type TimingResponse = {
  cells: Cell[];
  totalEpisodes: number;
  peakCount: number;
  categories: string[];
  timeZone: 'America/New_York' | 'UTC';
  days: number;
  error?: string;
};

export default function ArbTimingPanel() {
  const [days, setDays] = useState(30);
  const [category, setCategory] = useState('');
  const [timeZone, setTimeZone] = useState<'America/New_York' | 'UTC'>('America/New_York');
  const [data, setData] = useState<TimingResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    const params = new URLSearchParams({ days: String(days), timeZone });
    if (category) params.set('category', category);
    setLoading(true);
    setError('');
    fetch(`/api/dashboard/arb-timing?${params}`, { signal: controller.signal })
      .then(async (response) => {
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || 'Failed to load timing data');
        return body as TimingResponse;
      })
      .then(setData)
      .catch((reason) => {
        if (reason?.name !== 'AbortError') setError(reason?.message || 'Failed to load timing data');
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [days, category, timeZone, reloadKey]);

  const cellMap = useMemo(() => new Map((data?.cells ?? []).map((cell) => [`${cell.day}-${cell.hour}`, cell.count])), [data]);
  const zoneLabel = timeZone === 'America/New_York' ? 'US Eastern' : 'UTC';

  return (
    <section className="space-y-5" aria-labelledby="timing-title">
      <header className="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
        <div>
          <div className="mb-2 flex items-center gap-2 text-[#5DBE81]">
            <Clock3 className="h-5 w-5" />
            <span className="text-xs font-semibold uppercase tracking-[0.16em]">Opportunity timing</span>
          </div>
          <h2 id="timing-title" className="text-2xl font-bold text-[var(--text-primary)]">When arbitrage appears</h2>
          <p className="mt-1 max-w-2xl text-sm text-[var(--text-muted)]">
            Distinct, persistent arb episodes by first-seen hour. One-scan and sub-30-second phantom opportunities are excluded.
          </p>
        </div>

        <div className="flex flex-wrap items-end gap-2">
          <label title="Time period to analyze for arbitrage patterns" className="grid gap-1 text-xs text-[var(--text-muted)]">
            Range
            <select value={days} onChange={(event) => setDays(Number(event.target.value))} className="h-9 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 text-sm text-[var(--text-primary)]">
              <option value={7}>7 days</option>
              <option value={30}>30 days</option>
              <option value={90}>90 days</option>
              <option value={365}>1 year</option>
            </select>
          </label>
          <label title="Filter by market category (politics, sports, etc.)" className="grid gap-1 text-xs text-[var(--text-muted)]">
            Category
            <select value={category} onChange={(event) => setCategory(event.target.value)} className="h-9 max-w-52 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 text-sm text-[var(--text-primary)]">
              <option value="">All categories</option>
              {(data?.categories ?? []).map((item) => <option key={item} value={item}>{item}</option>)}
            </select>
          </label>
          <label title="Display hours in US Eastern or UTC" className="grid gap-1 text-xs text-[var(--text-muted)]">
            Time zone
            <select value={timeZone} onChange={(event) => setTimeZone(event.target.value as typeof timeZone)} className="h-9 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 text-sm text-[var(--text-primary)]">
              <option value="America/New_York">US Eastern</option>
              <option value="UTC">UTC</option>
            </select>
          </label>
          <button type="button" onClick={() => setReloadKey((value) => value + 1)} className="flex h-9 items-center gap-2 rounded-lg border border-[var(--border)] px-3 text-sm text-[var(--text-secondary)] transition-colors hover:border-[#5DBE81]/60 hover:text-[#5DBE81]" aria-label="Refresh timing data">
            <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </button>
        </div>
      </header>

      {error ? (
        <div role="alert" className="rounded-xl border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-300">
          {error} <button className="ml-2 underline" onClick={() => setReloadKey((value) => value + 1)}>Try again</button>
        </div>
      ) : loading && !data ? (
        <div className="h-80 animate-pulse rounded-xl border border-[var(--border)] bg-[var(--surface)]" aria-label="Loading timing heatmap" />
      ) : (
        <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3 sm:p-5">
          <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
            <div>
              <span className="font-mono text-2xl font-semibold text-[var(--text-primary)]">{data?.totalEpisodes.toLocaleString() ?? 0}</span>
              <span title="Distinct arb opportunities that lasted more than 30 seconds and appeared in multiple scans" className="ml-2 text-sm text-[var(--text-muted)]">qualified episodes</span>
            </div>
            <div className="text-xs text-[var(--text-muted)]">Hours shown in {zoneLabel}</div>
          </div>

          <div className="overflow-x-auto pb-2">
            <div className="min-w-[620px]" role="grid" aria-label={`Arbitrage opportunities by weekday and hour in ${zoneLabel}`}>
              <div className="grid grid-cols-[34px_repeat(24,22px)] gap-1">
                <div />
                {HOURS.map((hour) => <div key={hour} className="pb-1 text-center font-mono text-[10px] text-[var(--text-muted)]">{String(hour).padStart(2, '0')}</div>)}
                {DAYS.map((dayName, day) => [
                  <div key={`${dayName}-label`} className="flex items-center text-xs font-medium text-[var(--text-secondary)]">{dayName}</div>,
                  ...HOURS.map((hour) => {
                    const count = cellMap.get(`${day}-${hour}`) ?? 0;
                    const strength = data?.peakCount ? count / data.peakCount : 0;
                    const alpha = count === 0 ? 0.04 : 0.14 + strength * 0.76;
                    const label = `${dayName} ${String(hour).padStart(2, '0')}:00 ${zoneLabel}: ${count} ${count === 1 ? 'episode' : 'episodes'}`;
                    return <div key={`${day}-${hour}`} role="gridcell" aria-label={label} title={label} className="aspect-square min-h-6 rounded-[4px] border border-[#5DBE81]/10" style={{ backgroundColor: `rgba(93, 190, 129, ${alpha})` }} />;
                  }),
                ])}
              </div>
            </div>
          </div>

          <div className="mt-3 flex items-center justify-end gap-2 text-[10px] text-[var(--text-muted)]">
            <span>Fewer</span>
            {[0.08, 0.25, 0.45, 0.7, 0.9].map((alpha) => <span key={alpha} className="h-3 w-3 rounded-[3px] border border-[#5DBE81]/10" style={{ backgroundColor: `rgba(93, 190, 129, ${alpha})` }} />)}
            <span>More</span>
          </div>
        </div>
      )}
    </section>
  );
}
