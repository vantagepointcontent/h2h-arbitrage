// LifecycleStatsPanel.tsx — arb episode lifecycle stats (durable vs phantom).
// Self-contained: fetches /api/arb-lifecycle. Dropped into the Dashboard.
'use client';

import React, { useEffect, useState } from 'react';
import { Clock, Zap } from 'lucide-react';

interface Totals {
  episodes: number;
  open_now: number | null;
  avg_duration_sec: number | null;
  avg_peak_roi: number | null;
  max_peak_roi: number | null;
  durable_5min: number | null;
  phantom_1min: number | null;
}

interface CategoryRow {
  category: string;
  episodes: number;
  avg_duration_sec: number | null;
  avg_peak_roi: number | null;
  avg_peak_stake: number | null;
  durable_5min: number | null;
}

interface DurableRow {
  market_title: string | null;
  market_id: string;
  outcome: string;
  category: string | null;
  duration_sec: number | null;
  peak_roi_pct: number;
  peak_profit: number;
  scan_count: number;
}

interface LifecycleData {
  days: number;
  totals: Totals;
  byCategory: CategoryRow[];
  topDurable: DurableRow[];
}

function fmtDuration(sec: number | null | undefined): string {
  if (sec == null) return '—';
  if (sec < 60) return `${Math.round(sec)}s`;
  if (sec < 3600) return `${Math.round(sec / 60)}m`;
  return `${(sec / 3600).toFixed(1)}h`;
}

const fmtUsd = (n: number | null | undefined) =>
  n == null ? '—' : n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });

function Stat({ label, value, sub, color }: { label: string; value: string; sub?: string; color?: string }) {
  return (
    <div className="bg-[#0E1621] rounded-lg p-3">
      <div className="text-[10px] uppercase tracking-wide text-[#8A9BA8]">{label}</div>
      <div className="text-lg font-bold" style={{ color: color ?? 'var(--text-primary)' }}>{value}</div>
      {sub && <div className="text-[10px] text-[#8A9BA8]">{sub}</div>}
    </div>
  );
}

function LifecycleStatsPanelInner({ days = 30 }: { days?: number }) {
  const [data, setData] = useState<LifecycleData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    fetch(`/api/arb-lifecycle?days=${days}`)
      .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then(d => { if (alive) { setData(d); setError(null); } })
      .catch(e => { if (alive) setError(e.message || 'Failed to load'); });
    return () => { alive = false; };
  }, [days]);

  if (error) {
    return <div className="text-xs text-[#ef4444] py-4 text-center">Lifecycle stats unavailable: {error}</div>;
  }
  if (!data) {
    return <div className="text-xs text-[#8A9BA8] py-4 text-center">Loading lifecycle stats…</div>;
  }

  const t = data.totals;
  const episodes = Number(t.episodes ?? 0);
  const durable = Number(t.durable_5min ?? 0);
  const phantom = Number(t.phantom_1min ?? 0);
  const closed = durable + phantom; // note: mid-band (1–5min) episodes exist too
  const durablePct = closed > 0 ? Math.round((durable / closed) * 100) : null;

  return (
    <div className="space-y-4">
      {/* KPI row */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <Stat label="Episodes" value={episodes.toLocaleString()} sub={`last ${data.days}d`} />
        <Stat label="Open now" value={String(t.open_now ?? 0)} color="var(--status-warning)" />
        <Stat label="Avg lifetime" value={fmtDuration(t.avg_duration_sec)} sub="closed episodes" />
        <Stat
          label="Durable ≥5m"
          value={String(durable)}
          sub={durablePct != null ? `${durablePct}% of classified` : undefined}
          color="var(--status-positive)"
        />
        <Stat label="Phantom <1m" value={String(phantom)} color="var(--status-negative)" />
      </div>

      {/* Per-category table */}
      {data.byCategory.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-[#182533] bg-[#0E1621]">
                <th className="px-3 py-2 text-left text-[10px] font-semibold text-[#8A9BA8] uppercase tracking-wide">Category</th>
                <th className="px-3 py-2 text-right text-[10px] font-semibold text-[#8A9BA8] uppercase tracking-wide">Episodes</th>
                <th className="px-3 py-2 text-right text-[10px] font-semibold text-[#8A9BA8] uppercase tracking-wide">Avg lifetime</th>
                <th className="px-3 py-2 text-right text-[10px] font-semibold text-[#8A9BA8] uppercase tracking-wide">Durable ≥5m</th>
                <th className="px-3 py-2 text-right text-[10px] font-semibold text-[#8A9BA8] uppercase tracking-wide">Avg peak ROI</th>
                <th className="px-3 py-2 text-right text-[10px] font-semibold text-[#8A9BA8] uppercase tracking-wide">Avg peak stake</th>
              </tr>
            </thead>
            <tbody>
              {data.byCategory.map((c) => (
                <tr key={c.category} className="border-b border-[#182533]/50 hover:bg-[#182533]/30">
                  <td className="px-3 py-2 text-[#FFFFFF] font-medium">{c.category || 'uncategorized'}</td>
                  <td className="px-3 py-2 text-right font-mono text-[#8A9BA8]">{c.episodes}</td>
                  <td className="px-3 py-2 text-right font-mono text-[#8A9BA8]">{fmtDuration(c.avg_duration_sec)}</td>
                  <td className="px-3 py-2 text-right font-mono text-[#5DBE81]">{c.durable_5min ?? 0}</td>
                  <td className="px-3 py-2 text-right font-mono text-[#facc15]">
                    {c.avg_peak_roi != null ? `${Number(c.avg_peak_roi).toFixed(2)}%` : '—'}
                  </td>
                  <td className="px-3 py-2 text-right font-mono text-[#8A9BA8]">{fmtUsd(c.avg_peak_stake)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Top durable arbs */}
      {data.topDurable.length > 0 && (
        <div>
          <div className="flex items-center gap-1.5 mb-2 text-[11px] font-bold uppercase tracking-wide text-[#8A9BA8]">
            <Clock className="w-3.5 h-3.5" /> Most durable closed arbs
          </div>
          <div className="space-y-1">
            {data.topDurable.slice(0, 8).map((d, i) => (
              <div key={`${d.market_id}-${d.outcome}-${i}`} className="flex items-center gap-2 text-xs bg-[#0E1621] rounded px-3 py-1.5">
                <span className="font-mono text-[#5DBE81] w-14 shrink-0">{fmtDuration(d.duration_sec)}</span>
                <span className="text-[#FFFFFF] truncate flex-1">{d.market_title || d.market_id}</span>
                <span className="text-[#8A9BA8] truncate max-w-[160px]">{d.outcome}</span>
                <span className="font-mono text-[#facc15] w-16 text-right shrink-0">+{Number(d.peak_roi_pct).toFixed(2)}%</span>
                <span className="font-mono text-[#8A9BA8] w-14 text-right shrink-0">{d.scan_count}×</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {episodes === 0 && (
        <div className="text-xs text-[#8A9BA8] py-2 text-center flex items-center justify-center gap-1.5">
          <Zap className="w-3.5 h-3.5" /> No arb episodes recorded yet — data accumulates as the poller scans.
        </div>
      )}
    </div>
  );
}

export const LifecycleStatsPanel = React.memo(LifecycleStatsPanelInner);
