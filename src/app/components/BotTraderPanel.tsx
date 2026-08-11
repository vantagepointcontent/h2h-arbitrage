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
type PositionModeFilter = 'all' | 'paper' | 'production';
type SortKey = 'openedAt' | 'pnl' | 'roi';
type SortDirection = 'asc' | 'desc';

interface BotPosition {
  id: number;
  executionId: number;
  marketId: string | null;
  marketTitle: string;
  kalshiTicker: string | null;
  pmConditionId: string | null;
  kalshiUrl: string | null;
  polymarketUrl: string | null;
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
  selectionMethod: 'roi' | 'apy' | 'hybrid' | null;
}

export function positionRoiBps(position: Pick<BotPosition, 'status' | 'totalCostCents' | 'realizedPnlCents' | 'unrealizedRoiBps'>): number | null {
  if (position.totalCostCents <= 0) return null;
  if (position.status === 'open') return position.unrealizedRoiBps;
  if (position.realizedPnlCents == null) return null;
  return Math.round((position.realizedPnlCents * 10_000) / position.totalCostCents);
}

const VALUATION_STALE_MS = 15 * 60_000;

type OpenMark =
  | { available: true; currentValueCents: number; pnlCents: number; roiBps: number | null }
  | { available: false; label: 'Unavailable' | 'Stale' };

function openPositionMark(position: BotPosition, now = Date.now()): OpenMark {
  if (position.currentValueCents == null || !position.lastValuationAt) {
    return { available: false, label: 'Unavailable' };
  }
  const observedAt = Date.parse(position.lastValuationAt);
  if (!Number.isFinite(observedAt)) return { available: false, label: 'Unavailable' };
  if (now - observedAt > VALUATION_STALE_MS) return { available: false, label: 'Stale' };
  const pnlCents = position.currentValueCents - position.totalCostCents;
  return {
    available: true,
    currentValueCents: position.currentValueCents,
    pnlCents,
    roiBps: position.totalCostCents > 0 ? Math.round((pnlCents * 10_000) / position.totalCostCents) : null,
  };
}


interface BotStatus {
  enabled: boolean;
  mode: 'paper' | 'production';
  selectionMethod: 'roi' | 'apy' | 'hybrid';
  todayCount: number;
  todayStakeUsd: number;
}


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

async function fetchAllPositions(): Promise<{ success: boolean; positions: BotPosition[]; error?: string }> {
  const pageSize = 1000;
  const positions: BotPosition[] = [];
  for (let offset = 0; ; offset += pageSize) {
    const response = await fetch(`/api/bot-trader/positions?status=all&limit=${pageSize}&offset=${offset}`, { cache: 'no-store' });
    if (!response.ok) throw new Error('Failed to load positions');
    const page = await response.json() as { success: boolean; positions: BotPosition[]; error?: string };
    if (!page.success) return page;
    positions.push(...page.positions);
    if (page.positions.length < pageSize) return { success: true, positions };
  }
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

  const [positions, setPositions] = useState<BotPosition[]>([]);
  const [status, setStatus] = useState<BotStatus | null>(null);
  const [filter, setFilter] = useState<PositionFilter>('all');
  const [modeFilter, setModeFilter] = useState<PositionModeFilter>('all');
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
      const [positionsData, statusRes] = await Promise.all([
        fetchAllPositions(),
        fetch('/api/bot-trader/status', { cache: 'no-store' }),
      ]);
      const statusData = await statusRes.json();
      if (!positionsData.success) throw new Error(positionsData.error || 'Failed to load positions');
      if (!statusRes.ok) throw new Error(statusData.error || 'Failed to load bot status');
      if (requestId !== requestIdRef.current) return;
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
  }, []);

  useEffect(() => {
    const initialId = window.setTimeout(() => void load(true), 0);
    const intervalId = window.setInterval(() => void load(false), 30_000);
    return () => {
      window.clearTimeout(initialId);
      window.clearInterval(intervalId);
    };
  }, [load]);

  const modePositions = useMemo(
    () => positions.filter((position) => modeFilter === 'all' || (modeFilter === 'paper') === position.dryRun),
    [modeFilter, positions],
  );

  const sortedPositions = useMemo(() => modePositions.filter((position) => filter === 'all' || position.status === filter).sort((a, b) => {
    const sortablePnl = (position: BotPosition) => {
      if (position.status !== 'open') return position.realizedPnlCents ?? Number.NEGATIVE_INFINITY;
      const mark = openPositionMark(position);
      return mark.available ? mark.pnlCents : Number.NEGATIVE_INFINITY;
    };
    const sortableRoi = (position: BotPosition) => {
      if (position.status === 'open' && !openPositionMark(position).available) return Number.NEGATIVE_INFINITY;
      return positionRoiBps(position) ?? Number.NEGATIVE_INFINITY;
    };
    const values: Record<SortKey, [number, number]> = {
      openedAt: [Date.parse(a.openedAt), Date.parse(b.openedAt)],
      pnl: [sortablePnl(a), sortablePnl(b)],
      roi: [sortableRoi(a), sortableRoi(b)],
    };
    const [left, right] = values[sortKey];
    return sortDirection === 'asc' ? left - right : right - left;
  }), [filter, modePositions, sortDirection, sortKey]);

  const changeSort = (next: SortKey) => {
    if (next === sortKey) setSortDirection((current) => current === 'asc' ? 'desc' : 'asc');
    else {
      setSortKey(next);
      setSortDirection('desc');
    }
  };

  const saveSetting = async (key: 'bot.enabled' | 'bot.mode' | 'bot.selectionMethod', value: boolean | 'paper' | 'production' | 'roi' | 'apy' | 'hybrid', confirmation?: 'PRODUCTION') => {
    if (!status) return;
    const previous = status;
    setSaving(true);
    setError(null);
    setStatus({ ...status, ...(key === 'bot.enabled'
      ? { enabled: value as boolean }
      : key === 'bot.mode'
        ? { mode: value as 'paper' | 'production' }
        : { selectionMethod: value as 'roi' | 'apy' | 'hybrid' }) });
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

  const setRankSource = (source: 'roi' | 'apy', enabled: boolean) => {
    if (!status) return;
    const roiEnabled = status.selectionMethod !== 'apy';
    const apyEnabled = status.selectionMethod !== 'roi';
    const nextRoi = source === 'roi' ? enabled : roiEnabled;
    const nextApy = source === 'apy' ? enabled : apyEnabled;
    if (!nextRoi && !nextApy) return;
    const method = nextRoi && nextApy ? 'hybrid' : nextRoi ? 'roi' : 'apy';
    void saveSetting('bot.selectionMethod', method);
  };

  const openModePositions = modePositions.filter((position) => position.status === 'open');
  const openMarks = openModePositions.map((position) => openPositionMark(position));
  const hasUnavailableUnrealized = openMarks.some((mark) => !mark.available);
  const unrealized = openMarks.reduce((total, mark) => total + (mark.available ? mark.pnlCents : 0), 0);
  const realized = modePositions.reduce(
    (total, position) => total + (position.status === 'open' ? 0 : position.realizedPnlCents ?? 0),
    0,
  );
  const totalPnl = hasUnavailableUnrealized ? null : unrealized + realized;
  const paperTrades = modePositions.filter((position) => position.dryRun).length;
  const productionTrades = modePositions.filter((position) => !position.dryRun).length;
  const settledModePositions = modePositions.filter((position) => position.status !== 'open');
  const winRateBps = settledModePositions.length === 0
    ? 0
    : Math.round((settledModePositions.filter((position) => (position.realizedPnlCents ?? 0) > 0).length * 10_000) / settledModePositions.length);

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

      {status && <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-panel)] px-3 py-2">
        <div><div className="text-xs font-semibold text-[var(--text-primary)]">Ranked candidate sources</div><div className="text-[10px] text-[var(--text-secondary)]">All ROI and profit values are net of trading fees. This does not enable live trading.</div></div>
        <div className="flex items-center gap-2" role="group" aria-label="BotTrader ranked candidate sources">
          <label title="ROI ranks eligible markets by highest fee-net return on invested capital." className={`flex min-h-11 cursor-pointer items-center gap-2 rounded-lg border px-3 text-xs font-semibold ${status.selectionMethod !== 'apy' ? 'border-[var(--status-positive)] bg-[var(--status-positive)]/10 text-[var(--status-positive)]' : 'border-[var(--border-strong)] text-[var(--text-secondary)]'}`}><input type="checkbox" checked={status.selectionMethod !== 'apy'} disabled={saving} onChange={(event) => setRankSource('roi', event.target.checked)} /> ROI</label>
          <label title="APY ranks eligible markets by annualized yield while still requiring positive fee-net ROI." className={`flex min-h-11 cursor-pointer items-center gap-2 rounded-lg border px-3 text-xs font-semibold ${status.selectionMethod !== 'roi' ? 'border-[var(--status-positive)] bg-[var(--status-positive)]/10 text-[var(--status-positive)]' : 'border-[var(--border-strong)] text-[var(--text-secondary)]'}`}><input type="checkbox" checked={status.selectionMethod !== 'roi'} disabled={saving} onChange={(event) => setRankSource('apy', event.target.checked)} /> APY</label>
          <span title="Hybrid requires both configured ROI and APY thresholds and ranks deterministically by ROI, then APY." className="rounded-md bg-[var(--surface-workspace)] px-2 py-1 text-[10px] font-bold uppercase text-[var(--text-primary)]">{status.selectionMethod}</span>
        </div>
      </div>}

      {view === 'logs' ? <BotActionLogs selectionMethod={status?.selectionMethod} /> : view === 'messages' ? <BotTraderMessages /> : <div className="space-y-3">

      {status && (
        <div className={`rounded-lg border px-3 py-3 ${status.enabled ? 'border-[var(--status-positive)]/40 bg-[var(--status-positive)]/10' : 'border-[var(--border-subtle)] bg-[var(--surface-panel)]'}`}>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <Bot className={`h-4 w-4 ${status.enabled ? 'text-[var(--status-positive)]' : 'text-[var(--text-secondary)]'}`} />
              <span className="font-semibold">BotTrader: {status.enabled ? 'ON' : 'OFF'}</span>
              <span className="text-[var(--text-secondary)]">· {status.mode === 'production' ? 'Production' : 'Paper'} mode · {status.selectionMethod.toUpperCase()} selection · {INTEGER.format(status.todayCount)} trades today · {formatUsd(status.todayStakeUsd)} staked</span>
            </div>
            <div className="flex flex-wrap gap-2">
              <button onClick={toggleEnabled} disabled={saving} className={`min-h-11 rounded-lg px-3 text-xs font-semibold transition-colors disabled:opacity-50 ${status.enabled ? 'border border-[var(--status-negative)]/40 text-[var(--status-negative)]' : 'bg-[var(--status-positive)] text-black'}`}>{status.enabled ? 'Disable Bot' : 'Enable Bot'}</button>
              <button onClick={toggleMode} disabled={saving} className={`min-h-11 rounded-lg border px-3 text-xs font-semibold disabled:opacity-50 ${status.mode === 'production' ? 'border-[var(--status-warning)]/50 text-[var(--status-warning)]' : 'border-[var(--border-strong)] text-[var(--text-primary)]'}`}>{status.mode === 'production' ? 'Switch to Paper' : 'Switch to Production'}</button>
            </div>
          </div>
        </div>
      )}

      <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
        <MetricCard label="Paper Trades" value={INTEGER.format(paperTrades)} />
        <MetricCard label="Prod Trades" value={INTEGER.format(productionTrades)} />
        <MetricCard label="Open Positions" value={INTEGER.format(openModePositions.length)} />
        <MetricCard label="Win Rate" value={formatBps(winRateBps)} />
      </div>

      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
        <MetricCard label="Unrealized" value={hasUnavailableUnrealized ? 'Unavailable' : formatCents(unrealized, true)} valueClass={hasUnavailableUnrealized ? 'text-[var(--status-warning)]' : pnlClass(unrealized)} />
        <MetricCard label="Realized" value={formatCents(realized, true)} valueClass={pnlClass(realized)} />
        <MetricCard label="Total P&L" value={totalPnl == null ? 'Unavailable' : formatCents(totalPnl, true)} valueClass={totalPnl == null ? 'text-[var(--status-warning)]' : pnlClass(totalPnl)} />
      </div>

      <div className="overflow-hidden rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-panel)]">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--border-subtle)] px-3 py-2">
          <div><div className="text-sm font-semibold text-[var(--text-primary)]">Positions</div><div className="text-[10px] text-[var(--text-secondary)]">Live valuation and P&amp;L · click a row for leg details</div></div>
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-workspace)] p-0.5" aria-label="Position status filter">
              {(['all', 'open', 'settled'] as const).map((value) => <button key={value} onClick={() => setFilter(value)} className={`min-h-11 rounded-md px-3 text-xs capitalize ${filter === value ? 'bg-[var(--status-positive)] text-black' : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'}`}>{value}</button>)}
            </div>
            <label className="text-xs text-[var(--text-secondary)]">Mode <select aria-label="Filter position mode" value={modeFilter} onChange={(event) => setModeFilter(event.target.value as PositionModeFilter)} className="ml-1 min-h-11 rounded-lg border border-[var(--border-strong)] bg-[var(--surface-workspace)] px-2 text-[var(--text-primary)]"><option value="all">All</option><option value="paper">Paper</option><option value="production">Production</option></select></label>
            <label className="text-xs text-[var(--text-secondary)]">Sort <select aria-label="Sort positions" value={sortKey} onChange={(event) => changeSort(event.target.value as SortKey)} className="ml-1 min-h-11 rounded-lg border border-[var(--border-strong)] bg-[var(--surface-workspace)] px-2 text-[var(--text-primary)]"><option value="openedAt">Opened</option><option value="pnl">P&amp;L</option><option value="roi">ROI</option></select></label>
            <button onClick={() => setSortDirection((current) => current === 'asc' ? 'desc' : 'asc')} className="min-h-11 rounded-lg border border-[var(--border-strong)] px-2 text-xs text-[var(--text-secondary)]" aria-label={`Sort ${sortDirection === 'asc' ? 'descending' : 'ascending'}`}>{sortDirection === 'asc' ? '↑ Asc' : '↓ Desc'}</button>
          </div>
        </div>

        <div className="overflow-x-auto" data-testid="bot-positions-scroll">
          <table className="w-full min-w-[900px] text-xs">
            <thead><tr className="border-b border-[var(--border-subtle)] text-[10px] uppercase tracking-wide text-[var(--text-secondary)]"><th title="Expand position details" className="w-8 px-2 py-2" /><th title="Market event name" className="px-2 py-2 text-left font-medium">Market</th><th title="Immutable selection method captured when BotTrader chose this trade" className="px-2 py-2 text-center font-medium">Method</th><th title="Which legs the bot bought" className="px-2 py-2 text-left font-medium">Strategy</th><th title="Total dollars spent on both legs" className="px-2 py-2 text-right font-medium">Buy Cost</th><th title="Current market value of both legs" className="px-2 py-2 text-right font-medium">Current Value</th><th title="Profit or loss at current prices" className="px-2 py-2 text-right font-medium">P&amp;L</th><th title="Unrealized return as a percentage" className="px-2 py-2 text-right font-medium">ROI</th><th title="Position state: open, settled, or closed" className="px-2 py-2 text-center font-medium">Status</th><th title="When the bot placed this trade" className="px-2 py-2 text-right font-medium">Opened</th></tr></thead>
            <tbody className="divide-y divide-[var(--border-subtle)]">
              {sortedPositions.map((position) => {
                const isExpanded = expanded.has(position.id);
                const openMark = position.status === 'open' ? openPositionMark(position) : null;
                const pnl = position.status === 'open' ? (openMark?.available ? openMark.pnlCents : null) : position.realizedPnlCents;
                const roiBps = position.status === 'open'
                  ? (openMark?.available ? openMark.roiBps : null)
                  : positionRoiBps(position);
                const openUnavailableLabel = openMark && !openMark.available ? openMark.label : null;
                return [
                  <tr key={`row-${position.id}`} onClick={() => setExpanded((current) => { const next = new Set(current); if (next.has(position.id)) next.delete(position.id); else next.add(position.id); return next; })} className="cursor-pointer hover:bg-[var(--border-subtle)]/50" aria-expanded={isExpanded}>
                    <td className="px-2 py-2 text-[var(--text-secondary)]"><button type="button" onClick={(event) => { event.stopPropagation(); setExpanded((current) => { const next = new Set(current); if (next.has(position.id)) next.delete(position.id); else next.add(position.id); return next; }); }} className="flex min-h-11 min-w-11 items-center justify-center rounded hover:bg-[var(--border-strong)]" aria-label={`${isExpanded ? 'Collapse' : 'Expand'} ${position.marketTitle}`}>{isExpanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}</button></td>
                    <td className="max-w-56 px-2 py-2 font-medium text-[var(--text-primary)]" title={position.marketTitle}>{position.marketId ? <a href={`/?view=scan&id=${encodeURIComponent(position.marketId)}`} aria-label={`Open ${position.marketTitle} market`} onClick={(event) => event.stopPropagation()} className="block truncate underline decoration-[var(--border-strong)] underline-offset-2 hover:text-[var(--status-positive)]">{position.marketTitle}</a> : <span className="block truncate">{position.marketTitle}</span>}<div className="mt-1 flex gap-2 text-[9px] font-normal">{position.kalshiUrl && <a href={position.kalshiUrl} target="_blank" rel="noopener noreferrer" aria-label={`Open exact Kalshi ${position.kalshiSide.toUpperCase()} market for ${position.marketTitle}`} onClick={(event) => event.stopPropagation()} className="text-[var(--status-positive)] underline">Kalshi {position.kalshiSide.toUpperCase()}</a>}{position.polymarketUrl && <a href={position.polymarketUrl} target="_blank" rel="noopener noreferrer" aria-label={`Open exact Polymarket ${position.pmSide.toUpperCase()} market for ${position.marketTitle}`} onClick={(event) => event.stopPropagation()} className="text-[var(--status-info)] underline">PM {position.pmSide.toUpperCase()}</a>}{!position.kalshiUrl && !position.polymarketUrl && <span className="text-[var(--text-muted)]">Link unavailable</span>}<span className="text-[var(--text-muted)]">#{position.executionId}</span></div></td>
                    <td className="px-2 py-2 text-center"><span className="rounded bg-[var(--border-strong)] px-1.5 py-0.5 text-[9px] font-bold uppercase text-[var(--text-secondary)]">{position.selectionMethod?.toUpperCase() ?? 'Legacy/Unknown'}</span></td>
                    <td className="max-w-52 truncate px-2 py-2 text-[var(--text-secondary)]">{position.strategy || '—'}</td>
                    <td className="px-2 py-2 text-right tabular-nums">{formatCents(position.totalCostCents)}</td>
                    <td className={`px-2 py-2 text-right tabular-nums ${openUnavailableLabel ? 'text-[var(--status-warning)]' : ''}`}>{openUnavailableLabel ?? (position.status === 'open' && openMark?.available ? formatCents(openMark.currentValueCents) : position.currentValueCents == null ? 'Unavailable' : formatCents(position.currentValueCents))}</td>
                    <td className={`px-2 py-2 text-right font-semibold tabular-nums ${pnl == null ? 'text-[var(--status-warning)]' : pnlClass(pnl)}`}>{openUnavailableLabel ?? (pnl == null ? 'Unavailable' : formatCents(pnl, true))}</td>
                    <td className={`px-2 py-2 text-right tabular-nums ${roiBps == null || openUnavailableLabel ? 'text-[var(--status-warning)]' : pnlClass(roiBps)}`}>{openUnavailableLabel ?? (roiBps == null ? 'Unavailable' : formatBps(roiBps, true))}</td>
                    <td className="px-2 py-2 text-center"><StatusBadge status={position.status} /></td>
                    <td className="px-2 py-2 text-right text-[var(--text-secondary)]" title={new Date(position.openedAt).toLocaleString()}>{timeAgo(position.openedAt)}</td>
                  </tr>,
                  isExpanded && <tr key={`detail-${position.id}`}><td colSpan={10} className="bg-[var(--surface-workspace)] px-10 py-3"><div className="grid grid-cols-2 gap-x-6 gap-y-2 text-[10px] sm:grid-cols-3 lg:grid-cols-6"><div><span className="text-[var(--text-secondary)]">Kalshi ticker</span><div className="break-all font-mono text-[var(--text-primary)]">{position.kalshiTicker || '—'}</div></div><div><span className="text-[var(--text-secondary)]">PM conditionId</span><div className="break-all font-mono text-[var(--text-primary)]">{position.pmConditionId || '—'}</div></div><div><span className="text-[var(--text-secondary)]">Buy prices</span><div>{position.kalshiSide.toUpperCase()} {formatCents(position.buyPriceKalshiCents)} K · {position.pmSide.toUpperCase()} {formatCents(position.buyPricePmCents)} PM</div></div><div><span className="text-[var(--text-secondary)]">Current prices</span><div>{openUnavailableLabel ?? `${position.currentPriceKalshiCents == null ? '—' : formatCents(position.currentPriceKalshiCents)} K · ${position.currentPricePmCents == null ? '—' : formatCents(position.currentPricePmCents)} PM`}</div></div><div><span className="text-[var(--text-secondary)]">Shares</span><div>{INTEGER.format(position.sharesKalshi)} K · {INTEGER.format(position.sharesPm)} PM</div></div><div><span className="text-[var(--text-secondary)]">Expiry</span><div>{position.expiryDate ? new Date(position.expiryDate).toLocaleDateString() : '—'}</div></div></div></td></tr>,
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
