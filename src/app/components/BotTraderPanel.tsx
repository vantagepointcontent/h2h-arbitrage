'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  Bot,
  ChevronDown,
  ChevronRight,
  Loader2,
  RefreshCw,
} from 'lucide-react';
import BotActionLogs from './BotActionLogs';
import BotTraderMessages from './BotTraderMessages';

type PositionStatus = 'open' | 'settled' | 'closed';
type PositionFilter = 'all' | 'open' | 'settled';
type SortKey = 'openedAt' | 'pnl' | 'roi';
type SortDirection = 'asc' | 'desc';

interface BotPosition {
  id: number;
  executionId: number;
  marketId: string | null;
  marketTitle: string;
  kalshiTicker: string | null;
  pmConditionId: string | null;
  strategy: string | null;
  kalshiSide: 'yes' | 'no';
  pmSide: 'yes' | 'no';
  buyPriceKalshiCents: number;
  buyPricePmCents: number;
  sharesKalshi: number;
  sharesPm: number;
  totalCostCents: number;
  expectedPayoutCents: number;
  expectedProfitCents: number;
  feesCents: number;
  status: PositionStatus;
  openedAt: string;
  expiryDate: string | null;
  settledAt: string | null;
  currentPriceKalshiCents: number | null;
  currentPricePmCents: number | null;
  currentValueCents: number | null;
  unrealizedPnlCents: number | null;
  unrealizedRoiBps: number | null;
  lastValuationAt: string | null;
  realizedPnlCents: number | null;
  settlementSide: 'kalshi' | 'pm' | null;
  dryRun: boolean;
}

export function positionRoiBps(position: Pick<BotPosition, 'status' | 'totalCostCents' | 'realizedPnlCents' | 'unrealizedRoiBps'>): number {
  if (position.status === 'open') return position.unrealizedRoiBps ?? 0;
  if (position.totalCostCents <= 0) return 0;
  return Math.round(((position.realizedPnlCents ?? 0) * 10_000) / position.totalCostCents);
}

interface Analytics {
  totalBotTrades: { paper: number; production: number; total: number };
  openPositions: { count: number; unrealizedPnlCents: number };
  settledPositions: { count: number; realizedPnlCents: number; winRateBps: number };
  dailyPnl: Array<{ date: string; realizedPnlCents: number; unrealizedPnlCents: number; trades: number }>;
}

interface BotStatus {
  enabled: boolean;
  mode: 'paper' | 'production';
  todayCount: number;
  todayStakeUsd: number;
}

const EMPTY_ANALYTICS: Analytics = {
  totalBotTrades: { paper: 0, production: 0, total: 0 },
  openPositions: { count: 0, unrealizedPnlCents: 0 },
  settledPositions: { count: 0, realizedPnlCents: 0, winRateBps: 0 },
  dailyPnl: [],
};

const USD = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const INTEGER = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
const ONE_DECIMAL = new Intl.NumberFormat('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 });

function formatCents(cents: number, signed = false): string {
  const value = cents / 100;
  const formatted = USD.format(Math.abs(value));
  if (value < 0) return `-${formatted}`;
  return signed && value > 0 ? `+${formatted}` : formatted;
}

function formatUsd(value: number): string {
  return USD.format(value);
}

function formatBps(bps: number, signed = false): string {
  const value = bps / 100;
  const prefix = signed && value > 0 ? '+' : '';
  return `${prefix}${ONE_DECIMAL.format(value)}%`;
}

function pnlClass(value: number): string {
  if (value > 0) return 'text-[var(--status-positive)]';
  if (value < 0) return 'text-[var(--status-negative)]';
  return 'text-[var(--text-primary)]';
}

function timeAgo(iso: string): string {
  const elapsed = Math.max(0, Date.now() - Date.parse(iso));
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function apiHeaders(): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const token = typeof window === 'undefined' ? null : window.localStorage.getItem('h2h-api-token');
  if (token) headers['x-h2h-token'] = token;
  return headers;
}

function MetricCard({ label, value, valueClass = '' }: { label: string; value: string; valueClass?: string }) {
  return (
    <div className="rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-panel)] px-3 py-3 min-w-0">
      <div className="text-[10px] uppercase tracking-wide text-[var(--text-secondary)]">{label}</div>
      <div className={`mt-1 text-xl font-semibold tabular-nums ${valueClass || 'text-[var(--text-primary)]'}`}>{value}</div>
    </div>
  );
}

function StatusBadge({ status }: { status: PositionStatus }) {
  const styles: Record<PositionStatus, string> = {
    open: 'bg-[var(--status-positive)]/15 text-[var(--status-positive)]',
    settled: 'bg-[var(--platform-polymarket)]/15 text-[var(--platform-polymarket)]',
    closed: 'bg-[var(--status-negative)]/15 text-[var(--status-negative)]',
  };
  return <span className={`inline-flex rounded px-1.5 py-0.5 text-[9px] font-bold uppercase ${styles[status]}`}>{status}</span>;
}

export default function BotTraderPanel() {
  const [view, setView] = useState<'analytics' | 'logs' | 'messages'>('analytics');
  const [analytics, setAnalytics] = useState<Analytics>(EMPTY_ANALYTICS);
  const [positions, setPositions] = useState<BotPosition[]>([]);
  const [status, setStatus] = useState<BotStatus | null>(null);
  const [filter, setFilter] = useState<PositionFilter>('all');
  const [sortKey, setSortKey] = useState<SortKey>('openedAt');
  const [sortDirection, setSortDirection] = useState<SortDirection>('desc');
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [productionConfirmOpen, setProductionConfirmOpen] = useState(false);
  const [productionConfirmation, setProductionConfirmation] = useState('');
  const requestIdRef = useRef(0);

  const load = useCallback(async (initial = false) => {
    const requestId = ++requestIdRef.current;
    if (initial) setLoading(true);
    else setRefreshing(true);
    setError(null);
    try {
      const [analyticsRes, positionsRes, statusRes] = await Promise.all([
        fetch('/api/bot-trader/analytics', { cache: 'no-store' }),
        fetch(`/api/bot-trader/positions?status=${filter}`, { cache: 'no-store' }),
        fetch('/api/bot-trader/status', { cache: 'no-store' }),
      ]);
      const [analyticsData, positionsData, statusData] = await Promise.all([
        analyticsRes.json(), positionsRes.json(), statusRes.json(),
      ]);
      if (!analyticsRes.ok || !analyticsData.success) throw new Error(analyticsData.error || 'Failed to load analytics');
      if (!positionsRes.ok || !positionsData.success) throw new Error(positionsData.error || 'Failed to load positions');
      if (!statusRes.ok) throw new Error(statusData.error || 'Failed to load bot status');
      if (requestId !== requestIdRef.current) return;
      setAnalytics(analyticsData.analytics ?? EMPTY_ANALYTICS);
      setPositions(positionsData.positions ?? []);
      setStatus(statusData);
    } catch (cause) {
      if (requestId === requestIdRef.current) {
        setError(cause instanceof Error ? cause.message : 'Failed to load BotTrader analytics');
      }
    } finally {
      if (requestId === requestIdRef.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, [filter]);

  useEffect(() => {
    const initialId = window.setTimeout(() => void load(true), 0);
    const intervalId = window.setInterval(() => void load(false), 30_000);
    return () => {
      window.clearTimeout(initialId);
      window.clearInterval(intervalId);
    };
  }, [load]);

  const sortedPositions = useMemo(() => [...positions].sort((a, b) => {
    const values: Record<SortKey, [number, number]> = {
      openedAt: [Date.parse(a.openedAt), Date.parse(b.openedAt)],
      pnl: [a.status === 'open' ? (a.unrealizedPnlCents ?? 0) : (a.realizedPnlCents ?? 0), b.status === 'open' ? (b.unrealizedPnlCents ?? 0) : (b.realizedPnlCents ?? 0)],
      roi: [positionRoiBps(a), positionRoiBps(b)],
    };
    const [left, right] = values[sortKey];
    return sortDirection === 'asc' ? left - right : right - left;
  }), [positions, sortDirection, sortKey]);

  const changeSort = (next: SortKey) => {
    if (next === sortKey) setSortDirection((current) => current === 'asc' ? 'desc' : 'asc');
    else {
      setSortKey(next);
      setSortDirection('desc');
    }
  };

  const saveSetting = async (key: 'bot.enabled' | 'bot.mode', value: boolean | 'paper' | 'production', confirmation?: 'PRODUCTION') => {
    if (!status) return;
    const previous = status;
    setSaving(true);
    setError(null);
    setStatus({ ...status, ...(key === 'bot.enabled' ? { enabled: value as boolean } : { mode: value as 'paper' | 'production' }) });
    try {
      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: apiHeaders(),
        body: JSON.stringify({ values: { [key]: value }, ...(confirmation ? { confirmation } : {}) }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || data.details?.join('; ') || 'Setting update failed');
      await load(false);
    } catch (cause) {
      setStatus(previous);
      setError(cause instanceof Error ? cause.message : 'Setting update failed');
    } finally {
      setSaving(false);
    }
  };

  const toggleEnabled = () => {
    if (!status) return;
    if (!status.enabled && !window.confirm(`Enable BotTrader in ${status.mode} mode?`)) return;
    void saveSetting('bot.enabled', !status.enabled);
  };

  const toggleMode = () => {
    if (!status) return;
    if (status.mode === 'production') {
      void saveSetting('bot.mode', 'paper');
      return;
    }
    setProductionConfirmation('');
    setProductionConfirmOpen(true);
  };

  const unrealized = analytics.openPositions.unrealizedPnlCents;
  const realized = analytics.settledPositions.realizedPnlCents;
  const totalPnl = unrealized + realized;

  if (loading) {
    return <div className="flex min-h-64 items-center justify-center gap-2 text-sm text-[var(--text-secondary)]"><Loader2 className="h-4 w-4 animate-spin" /> Loading BotTrader analytics…</div>;
  }

  return (
    <section className="space-y-3" aria-label="BotTrader Analytics">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 text-lg font-semibold text-[var(--text-primary)]"><Bot className="h-5 w-5 text-[var(--status-positive)]" /> BotTrader Analytics</h2>
        <button onClick={() => void load(false)} disabled={refreshing} className="min-h-11 min-w-11 rounded-lg border border-[var(--border-strong)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] disabled:opacity-50" aria-label="Refresh BotTrader analytics"><RefreshCw className={`mx-auto h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} /></button>
      </div>

      {error && <div role="alert" className="rounded-lg border border-[var(--status-negative)]/40 bg-[var(--status-negative)]/10 px-3 py-2 text-xs text-[var(--status-negative)]">{error}</div>}

      <div className="flex rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-panel)] p-1" role="tablist" aria-label="BotTrader views">
        {(['analytics', 'logs', 'messages'] as const).map((tab) => <button key={tab} role="tab" aria-selected={view === tab} onClick={() => setView(tab)} className={`min-h-11 rounded-md px-4 text-xs font-semibold capitalize ${view === tab ? 'bg-[var(--status-positive)] text-black' : 'text-[var(--text-secondary)]'}`}>{tab}</button>)}
      </div>

      {view === 'logs' ? <BotActionLogs /> : view === 'messages' ? <BotTraderMessages /> : <div className="space-y-3">

      {status && (
        <div className={`rounded-lg border px-3 py-3 ${status.enabled ? 'border-[var(--status-positive)]/40 bg-[var(--status-positive)]/10' : 'border-[var(--border-subtle)] bg-[var(--surface-panel)]'}`}>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <Bot className={`h-4 w-4 ${status.enabled ? 'text-[var(--status-positive)]' : 'text-[var(--text-secondary)]'}`} />
              <span className="font-semibold">BotTrader: {status.enabled ? 'ON' : 'OFF'}</span>
              <span className="text-[var(--text-secondary)]">· {status.mode === 'production' ? 'Production' : 'Paper'} mode · {INTEGER.format(status.todayCount)} trades today · {formatUsd(status.todayStakeUsd)} staked</span>
            </div>
            <div className="flex flex-wrap gap-2">
              <button onClick={toggleEnabled} disabled={saving} className={`min-h-11 rounded-lg px-3 text-xs font-semibold transition-colors disabled:opacity-50 ${status.enabled ? 'border border-[var(--status-negative)]/40 text-[var(--status-negative)]' : 'bg-[var(--status-positive)] text-black'}`}>{status.enabled ? 'Disable Bot' : 'Enable Bot'}</button>
              <button onClick={toggleMode} disabled={saving} className={`min-h-11 rounded-lg border px-3 text-xs font-semibold disabled:opacity-50 ${status.mode === 'production' ? 'border-[var(--status-warning)]/50 text-[var(--status-warning)]' : 'border-[var(--border-strong)] text-[var(--text-primary)]'}`}>{status.mode === 'production' ? 'Switch to Paper' : 'Switch to Production'}</button>
            </div>
          </div>
        </div>
      )}

      <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
        <MetricCard label="Paper Trades" value={INTEGER.format(analytics.totalBotTrades.paper)} />
        <MetricCard label="Prod Trades" value={INTEGER.format(analytics.totalBotTrades.production)} />
        <MetricCard label="Open Positions" value={INTEGER.format(analytics.openPositions.count)} />
        <MetricCard label="Win Rate" value={formatBps(analytics.settledPositions.winRateBps)} />
      </div>

      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
        <MetricCard label="Unrealized" value={formatCents(unrealized, true)} valueClass={pnlClass(unrealized)} />
        <MetricCard label="Realized" value={formatCents(realized, true)} valueClass={pnlClass(realized)} />
        <MetricCard label="Total P&L" value={formatCents(totalPnl, true)} valueClass={pnlClass(totalPnl)} />
      </div>

      <div className="overflow-hidden rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-panel)]">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--border-subtle)] px-3 py-2">
          <div><div className="text-sm font-semibold text-[var(--text-primary)]">Positions</div><div className="text-[10px] text-[var(--text-secondary)]">Live valuation and P&amp;L · click a row for leg details</div></div>
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-workspace)] p-0.5" aria-label="Position status filter">
              {(['all', 'open', 'settled'] as const).map((value) => <button key={value} onClick={() => setFilter(value)} className={`min-h-11 rounded-md px-3 text-xs capitalize ${filter === value ? 'bg-[var(--status-positive)] text-black' : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'}`}>{value}</button>)}
            </div>
            <label className="text-xs text-[var(--text-secondary)]">Sort <select aria-label="Sort positions" value={sortKey} onChange={(event) => changeSort(event.target.value as SortKey)} className="ml-1 min-h-11 rounded-lg border border-[var(--border-strong)] bg-[var(--surface-workspace)] px-2 text-[var(--text-primary)]"><option value="openedAt">Opened</option><option value="pnl">P&amp;L</option><option value="roi">ROI</option></select></label>
            <button onClick={() => setSortDirection((current) => current === 'asc' ? 'desc' : 'asc')} className="min-h-11 rounded-lg border border-[var(--border-strong)] px-2 text-xs text-[var(--text-secondary)]" aria-label={`Sort ${sortDirection === 'asc' ? 'descending' : 'ascending'}`}>{sortDirection === 'asc' ? '↑ Asc' : '↓ Desc'}</button>
          </div>
        </div>

        <div className="overflow-x-auto" data-testid="bot-positions-scroll">
          <table className="w-full min-w-[900px] text-xs">
            <thead><tr className="border-b border-[var(--border-subtle)] text-[10px] uppercase tracking-wide text-[var(--text-secondary)]"><th className="w-8 px-2 py-2" /><th className="px-2 py-2 text-left font-medium">Market</th><th className="px-2 py-2 text-left font-medium">Strategy</th><th className="px-2 py-2 text-right font-medium">Buy Cost</th><th className="px-2 py-2 text-right font-medium">Current Value</th><th className="px-2 py-2 text-right font-medium">P&amp;L</th><th className="px-2 py-2 text-right font-medium">ROI</th><th className="px-2 py-2 text-center font-medium">Status</th><th className="px-2 py-2 text-right font-medium">Opened</th></tr></thead>
            <tbody className="divide-y divide-[var(--border-subtle)]">
              {sortedPositions.map((position) => {
                const isExpanded = expanded.has(position.id);
                const pnl = position.status === 'open' ? (position.unrealizedPnlCents ?? 0) : (position.realizedPnlCents ?? 0);
                const roiBps = positionRoiBps(position);
                return [
                  <tr key={`row-${position.id}`} onClick={() => setExpanded((current) => { const next = new Set(current); if (next.has(position.id)) next.delete(position.id); else next.add(position.id); return next; })} className="cursor-pointer hover:bg-[var(--border-subtle)]/50" aria-expanded={isExpanded}>
                    <td className="px-2 py-2 text-[var(--text-secondary)]"><button type="button" onClick={(event) => { event.stopPropagation(); setExpanded((current) => { const next = new Set(current); if (next.has(position.id)) next.delete(position.id); else next.add(position.id); return next; }); }} className="flex min-h-11 min-w-11 items-center justify-center rounded hover:bg-[var(--border-strong)]" aria-label={`${isExpanded ? 'Collapse' : 'Expand'} ${position.marketTitle}`}>{isExpanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}</button></td>
                    <td className="max-w-56 truncate px-2 py-2 font-medium text-[var(--text-primary)]" title={position.marketTitle}>{position.marketTitle}<div className="text-[9px] font-normal text-[var(--text-secondary)]">{position.dryRun ? 'PAPER' : 'PROD'}</div></td>
                    <td className="max-w-52 truncate px-2 py-2 text-[var(--text-secondary)]">{position.strategy || '—'}</td>
                    <td className="px-2 py-2 text-right tabular-nums">{formatCents(position.totalCostCents)}</td>
                    <td className="px-2 py-2 text-right tabular-nums">{position.currentValueCents == null ? '—' : formatCents(position.currentValueCents)}</td>
                    <td className={`px-2 py-2 text-right font-semibold tabular-nums ${pnlClass(pnl)}`}>{formatCents(pnl, true)}</td>
                    <td className={`px-2 py-2 text-right tabular-nums ${pnlClass(roiBps)}`}>{formatBps(roiBps, true)}</td>
                    <td className="px-2 py-2 text-center"><StatusBadge status={position.status} /></td>
                    <td className="px-2 py-2 text-right text-[var(--text-secondary)]" title={new Date(position.openedAt).toLocaleString()}>{timeAgo(position.openedAt)}</td>
                  </tr>,
                  isExpanded && <tr key={`detail-${position.id}`}><td colSpan={9} className="bg-[var(--surface-workspace)] px-10 py-3"><div className="grid grid-cols-2 gap-x-6 gap-y-2 text-[10px] sm:grid-cols-3 lg:grid-cols-6"><div><span className="text-[var(--text-secondary)]">Kalshi ticker</span><div className="break-all font-mono text-[var(--text-primary)]">{position.kalshiTicker || '—'}</div></div><div><span className="text-[var(--text-secondary)]">PM conditionId</span><div className="break-all font-mono text-[var(--text-primary)]">{position.pmConditionId || '—'}</div></div><div><span className="text-[var(--text-secondary)]">Buy prices</span><div>{position.kalshiSide.toUpperCase()} {formatCents(position.buyPriceKalshiCents)} K · {position.pmSide.toUpperCase()} {formatCents(position.buyPricePmCents)} PM</div></div><div><span className="text-[var(--text-secondary)]">Current prices</span><div>{position.currentPriceKalshiCents == null ? '—' : formatCents(position.currentPriceKalshiCents)} K · {position.currentPricePmCents == null ? '—' : formatCents(position.currentPricePmCents)} PM</div></div><div><span className="text-[var(--text-secondary)]">Shares</span><div>{INTEGER.format(position.sharesKalshi)} K · {INTEGER.format(position.sharesPm)} PM</div></div><div><span className="text-[var(--text-secondary)]">Expiry</span><div>{position.expiryDate ? new Date(position.expiryDate).toLocaleDateString() : '—'}</div></div></div></td></tr>,
                ];
              })}
            </tbody>
          </table>
          {sortedPositions.length === 0 && <div className="py-10 text-center text-sm text-[var(--text-secondary)]">No {filter === 'all' ? '' : `${filter} `}BotTrader positions.</div>}
        </div>
      </div>

      {productionConfirmOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" role="dialog" aria-modal="true" aria-labelledby="production-confirm-title" onClick={() => setProductionConfirmOpen(false)}>
          <div className="w-full max-w-md rounded-xl border border-[var(--status-negative)]/60 bg-[var(--surface-workspace)] p-5" onClick={(event) => event.stopPropagation()}>
            <h3 id="production-confirm-title" className="flex items-center gap-2 font-semibold text-[var(--status-negative)]"><AlertTriangle className="h-5 w-5" /> Switch to production?</h3>
            <p className="mt-2 text-sm text-[var(--text-secondary)]">Production can place real-money orders only when the server-side execution mode, readiness gates, and authorization checks permit it. Type <strong className="text-[var(--text-primary)]">PRODUCTION</strong> to continue.</p>
            <input autoFocus value={productionConfirmation} onChange={(event) => setProductionConfirmation(event.target.value)} aria-label="Production confirmation" placeholder="PRODUCTION" className="mt-4 min-h-11 w-full rounded-lg border border-[var(--status-negative)]/50 bg-[var(--surface-panel)] px-3 font-mono text-sm outline-none" />
            <div className="mt-4 flex justify-end gap-2"><button onClick={() => setProductionConfirmOpen(false)} className="min-h-11 rounded-lg border border-[var(--border-strong)] px-4 text-sm">Cancel</button><button disabled={productionConfirmation !== 'PRODUCTION' || saving} onClick={() => { setProductionConfirmOpen(false); void saveSetting('bot.mode', 'production', 'PRODUCTION'); }} className="min-h-11 rounded-lg bg-[var(--status-negative)] px-4 text-sm font-semibold text-white disabled:opacity-40">Confirm production</button></div>
          </div>
        </div>
      )}
      </div>}
    </section>
  );
}
