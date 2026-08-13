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
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, XAxis, YAxis } from 'recharts';
import BotActionLogs from './BotActionLogs';
import BotTraderMessages from './BotTraderMessages';

type PositionStatus = 'open' | 'settled' | 'closed';
type PositionFilter = 'all' | 'open' | 'settled';
type PositionModeFilter = 'paper' | 'production';
type PerformanceMethod = 'all' | 'roi' | 'apy' | 'hybrid' | 'legacy';
type PerformanceRange = 'today' | '7d' | '30d' | '90d' | 'all';
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
  kalshiGrossProceedsMicrocents: number | null;
  pmGrossProceedsMicrocents: number | null;
  kalshiNetProceedsCents: number | null;
  pmNetProceedsCents: number | null;
  kalshiExitFeeCents: number | null;
  pmExitFeeCents: number | null;
  kalshiExitFeeType: 'quadratic' | null;
  kalshiExitFeeMultiplierPpm: number | null;
  pmExitFeeRateBps: number | null;
  unrealizedPnlCents: number | null;
  unrealizedRoiBps: number | null;
  lastValuationAt: string | null;
  realizedPnlCents: number | null;
  settlementSide: 'kalshi' | 'pm' | null;
  resolutionPayoutCents?: number | null;
  resolutionValidationStatus?: 'pending' | 'verified' | 'invalid';
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

function hasVerifiedTerminalAccounting(position: BotPosition): boolean {
  return position.status !== 'open'
    && position.resolutionValidationStatus === 'verified'
    && Number.isSafeInteger(position.resolutionPayoutCents)
    && Number.isSafeInteger(position.realizedPnlCents)
    && position.resolutionPayoutCents! - position.totalCostCents === position.realizedPnlCents;
}


interface BotStatus {
  enabled: boolean;
  mode: 'paper' | 'production';
  selectionMethod: 'roi' | 'apy' | 'hybrid';
  todayCount: number;
  todayStakeUsd: number;
}

interface PerformanceAnalytics {
  positions: BotPosition[];
  totalBotTrades: { paper: number; production: number; total: number };
  openPositions: { count: number };
  settledPositions: { count: number; winRateBps: number };
  performance: {
    positionIds: number[];
    capital: { deployedCents: number; currentCents: number | null; heldToResolutionCents: number };
    pnl: { realizedCents: number; unrealizedCents: number | null; totalCents: number | null; roiBps: number | null };
    valuation: { fresh: number; stale: number; unavailable: number; pendingSettlement: number; asOf: string | null };
    entryCohorts: Array<{ date: string; deployedCents: number; currentCents: number | null; heldToResolutionCents: number; realizedCents: number; unrealizedCents: number | null; trades: number }>;
  };
}

const RANGE_OPTIONS: Array<{ key: PerformanceRange; label: string }> = [
  { key: 'today', label: 'Today' },
  { key: '7d', label: '7 Days' },
  { key: '30d', label: '30 Days' },
  { key: '90d', label: '90 Days' },
  { key: 'all', label: 'All' },
];


const USD = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const PRECISE_USD = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 6 });
const INTEGER = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
const ONE_DECIMAL = new Intl.NumberFormat('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const THREE_DECIMAL = new Intl.NumberFormat('en-US', { minimumFractionDigits: 3, maximumFractionDigits: 3 });

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

function formatMicrocents(microcents: number): string {
  return PRECISE_USD.format(microcents / 100_000_000);
}

function formatVwapCents(grossProceedsMicrocents: number, quantity: number): string {
  return `${THREE_DECIMAL.format(grossProceedsMicrocents / 1_000_000 / quantity)}¢`;
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

  const [positions, setPositions] = useState<BotPosition[]>([]);
  const [status, setStatus] = useState<BotStatus | null>(null);
  const [analytics, setAnalytics] = useState<PerformanceAnalytics | null>(null);
  const [filter, setFilter] = useState<PositionFilter>('all');
  const [modeFilter, setModeFilter] = useState<PositionModeFilter>('paper');
  const [methodFilter, setMethodFilter] = useState<PerformanceMethod>('all');
  const [range, setRange] = useState<PerformanceRange>('30d');
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
  const latestLoadRef = useRef<(initial?: boolean) => Promise<void>>(async () => {});

  const load = useCallback(async (initial = false) => {
    const requestId = ++requestIdRef.current;
    if (initial) setLoading(true);
    else setRefreshing(true);
    setError(null);
    try {
      const [statusRes, analyticsRes] = await Promise.all([
        fetch('/api/bot-trader/status', { cache: 'no-store' }),
        fetch(`/api/bot-trader/analytics?method=${methodFilter}&mode=${modeFilter}&range=${range}`, { cache: 'no-store' }),
      ]);
      const [statusData, analyticsData] = await Promise.all([statusRes.json(), analyticsRes.json()]);
      if (!statusRes.ok) throw new Error(statusData.error || 'Failed to load bot status');
      if (!analyticsRes.ok || !analyticsData.success) throw new Error(analyticsData.error || 'Failed to load performance analytics');
      if (requestId !== requestIdRef.current) return;
      setPositions(analyticsData.analytics.positions ?? []);
      setStatus(statusData);
      setAnalytics(analyticsData.analytics);
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
  }, [methodFilter, modeFilter, range]);

  useEffect(() => {
    latestLoadRef.current = load;
  }, [load]);

  useEffect(() => {
    const initialId = window.setTimeout(() => void load(true), 0);
    const intervalId = window.setInterval(() => void load(false), 30_000);
    return () => {
      window.clearTimeout(initialId);
      window.clearInterval(intervalId);
    };
  }, [load]);

  const filteredPositions = useMemo(
    () => {
      const included = new Set(analytics?.performance.positionIds ?? []);
      return positions.filter((position) =>
        included.has(position.id)
        && (filter === 'all'
          || (filter === 'open' ? position.status === 'open' : position.status !== 'open')));
    },
    [analytics, filter, positions],
  );

  const sortedPositions = useMemo(() => filteredPositions.slice().sort((a, b) => {
    const sortablePnl = (position: BotPosition) => {
      if (position.status !== 'open') {
        return hasVerifiedTerminalAccounting(position) ? position.realizedPnlCents : null;
      }
      const mark = openPositionMark(position);
      return mark.available ? mark.pnlCents : null;
    };
    const sortableRoi = (position: BotPosition) => {
      if (position.status !== 'open' && !hasVerifiedTerminalAccounting(position)) return null;
      if (position.status === 'open' && !openPositionMark(position).available) return null;
      return positionRoiBps(position);
    };
    const values: Record<SortKey, [number | null, number | null]> = {
      openedAt: [Date.parse(a.openedAt), Date.parse(b.openedAt)],
      pnl: [sortablePnl(a), sortablePnl(b)],
      roi: [sortableRoi(a), sortableRoi(b)],
    };
    const [left, right] = values[sortKey];
    if (left == null || right == null) {
      if (left == null && right == null) return 0;
      return left == null ? 1 : -1;
    }
    return sortDirection === 'asc' ? left - right : right - left;
  }), [filteredPositions, sortDirection, sortKey]);

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
      await latestLoadRef.current(false);
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

  const changePerformanceFilter = <T,>(current: T, next: T, change: (value: T) => void) => {
    if (current === next) return;
    requestIdRef.current += 1;
    setAnalytics(null);
    setLoading(true);
    change(next);
  };

  if (loading) {
    return <div className="flex min-h-64 items-center justify-center gap-2 text-sm text-[var(--text-secondary)]"><Loader2 className="h-4 w-4 animate-spin" /> Loading BotTrader analytics…</div>;
  }

  if (!analytics) {
    return <div role="alert" className="flex min-h-64 flex-col items-center justify-center gap-2 text-sm text-[var(--status-negative)]"><AlertTriangle className="h-5 w-5" />{error || 'BotTrader performance is unavailable.'}<button onClick={() => void load(true)} className="min-h-11 rounded-lg border border-[var(--border-strong)] px-3 text-xs">Retry</button></div>;
  }

  const performance = analytics.performance;
  const rangeLabel = RANGE_OPTIONS.find((option) => option.key === range)?.label ?? '30 Days';
  const quoteIssueCount = performance.valuation.stale + performance.valuation.unavailable + performance.valuation.pendingSettlement;
  const chartData = performance.entryCohorts.map((point) => ({
    ...point,
    label: new Date(`${point.date}T00:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
  }));

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

      <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-panel)] px-3 py-2">
        <div className="flex flex-wrap items-center gap-2">
          <label className="text-xs text-[var(--text-secondary)]">Mode <select aria-label="Filter position mode" value={modeFilter} onChange={(event) => changePerformanceFilter(modeFilter, event.target.value as PositionModeFilter, setModeFilter)} className="ml-1 min-h-11 rounded-lg border border-[var(--border-strong)] bg-[var(--surface-workspace)] px-2 text-[var(--text-primary)]"><option value="paper">Paper</option><option value="production">Live</option></select></label>
          <label className="text-xs text-[var(--text-secondary)]">Method <select aria-label="Performance method" value={methodFilter} onChange={(event) => changePerformanceFilter(methodFilter, event.target.value as PerformanceMethod, setMethodFilter)} className="ml-1 min-h-11 rounded-lg border border-[var(--border-strong)] bg-[var(--surface-workspace)] px-2 text-[var(--text-primary)]"><option value="all">All Bot methods</option><option value="roi">ROI</option><option value="apy">APY</option><option value="hybrid">Hybrid</option><option value="legacy">Legacy / unknown</option></select></label>
        </div>
        <div className="flex flex-wrap rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-workspace)] p-0.5" aria-label="Performance date range">
          {RANGE_OPTIONS.map((option) => <button key={option.key} aria-label={option.label} disabled={range === option.key} onClick={() => changePerformanceFilter(range, option.key, setRange)} className={`min-h-11 rounded-md px-2.5 text-[10px] font-semibold disabled:cursor-default ${range === option.key ? 'bg-[var(--status-positive)]/20 text-[var(--status-positive)]' : 'text-[var(--text-secondary)]'}`}>{option.label}</button>)}
        </div>
        <div className="w-full text-[10px] text-[var(--text-secondary)]">{range === 'today' ? 'Today uses the server-local calendar boundary.' : range === 'all' ? 'All verified BotTrader executions.' : `${rangeLabel} uses the same rolling boundary as Dashboard.`} All amounts include entry and executable exit fees.</div>
      </div>

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
        <MetricCard label="Verified trades" value={INTEGER.format(analytics.totalBotTrades.total)} />
        <MetricCard label="Open positions" value={INTEGER.format(analytics.openPositions.count)} />
        <MetricCard label="Settled positions" value={INTEGER.format(analytics.settledPositions.count)} />
        <MetricCard label="Win rate" value={formatBps(analytics.settledPositions.winRateBps)} />
      </div>

      <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
        <div title="Cumulative fee-inclusive cost of open exposure"><MetricCard label="Deployed" value={formatCents(performance.capital.deployedCents)} /></div>
        <MetricCard label="Executable value" value={performance.capital.currentCents == null ? 'Unavailable' : formatCents(performance.capital.currentCents)} valueClass={performance.capital.currentCents == null ? 'text-[var(--status-warning)]' : ''} />
        <MetricCard label="Held to resolution" value={formatCents(performance.capital.heldToResolutionCents)} />
        <div title="Unrealized return on remaining open cost"><MetricCard label="Portfolio ROI" value={performance.pnl.roiBps == null ? 'Unavailable' : formatBps(performance.pnl.roiBps, true)} valueClass={performance.pnl.roiBps == null ? 'text-[var(--status-warning)]' : pnlClass(performance.pnl.roiBps)} /></div>
      </div>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
        <MetricCard label="Unrealized" value={performance.pnl.unrealizedCents == null ? 'Unavailable' : formatCents(performance.pnl.unrealizedCents, true)} valueClass={performance.pnl.unrealizedCents == null ? 'text-[var(--status-warning)]' : pnlClass(performance.pnl.unrealizedCents)} />
        <MetricCard label="Realized" value={formatCents(performance.pnl.realizedCents, true)} valueClass={pnlClass(performance.pnl.realizedCents)} />
        <MetricCard label="Total P&L" value={performance.pnl.totalCents == null ? 'Unavailable' : formatCents(performance.pnl.totalCents, true)} valueClass={performance.pnl.totalCents == null ? 'text-[var(--status-warning)]' : pnlClass(performance.pnl.totalCents)} />
      </div>

      <div className={`rounded-lg border px-3 py-2 text-xs ${quoteIssueCount > 0 ? 'border-[var(--status-warning)]/40 bg-[var(--status-warning)]/10 text-[var(--status-warning)]' : 'border-[var(--status-positive)]/30 bg-[var(--status-positive)]/10 text-[var(--text-secondary)]'}`}>
        {quoteIssueCount > 0
          ? `${performance.valuation.stale} stale executable quote${performance.valuation.stale === 1 ? '' : 's'} · ${performance.valuation.unavailable} unavailable · ${performance.valuation.pendingSettlement} pending settlement verification. Executable value, total P&L, and ROI are suppressed until every position has authoritative valuation state; unrealized P&L also requires fresh executable-depth marks.`
          : `Executable quotes fresh for ${performance.valuation.fresh} open position${performance.valuation.fresh === 1 ? '' : 's'}${performance.valuation.asOf ? ` · oldest executable mark ${new Date(performance.valuation.asOf).toLocaleString()}` : ''}.`}
      </div>

      <div className="rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-panel)] p-3">
        <div className="mb-2 flex items-center justify-between"><div><div className="text-sm font-semibold">Current performance by entry date</div><div className="text-[10px] text-[var(--text-secondary)]">Cohorts use each position&apos;s latest authoritative value; this is not historical portfolio performance.</div></div><div className="text-[10px] text-[var(--text-secondary)]">{rangeLabel} · verified {modeFilter === 'paper' ? 'paper' : 'live'} executions</div></div>
        {chartData.length === 0 ? <div className="py-10 text-center text-sm text-[var(--text-secondary)]">No verified BotTrader executions in this range.</div> : <div role="img" aria-label="BotTrader current performance by entry date chart" className="h-56 w-full">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={chartData} margin={{ top: 8, right: 8, bottom: 0, left: 8 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border-subtle)" />
              <XAxis dataKey="label" tick={{ fontSize: 10, fill: 'var(--text-secondary)' }} />
              <YAxis tick={{ fontSize: 10, fill: 'var(--text-secondary)' }} tickFormatter={(value: number) => formatCents(value)} />
              <Legend wrapperStyle={{ fontSize: 10 }} />
              <Bar dataKey="deployedCents" name="Deployed" fill="var(--text-secondary)" />
              <Bar dataKey="currentCents" name="Executable value" fill="var(--status-info)" />
              <Bar dataKey="heldToResolutionCents" name="Held to resolution" fill="var(--platform-polymarket)" />
              <Bar dataKey="realizedCents" name="Realized P&L" fill="var(--status-positive)" />
              <Bar dataKey="unrealizedCents" name="Unrealized P&L" fill="var(--status-warning)" />
            </BarChart>
          </ResponsiveContainer>
        </div>}
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
            <thead><tr className="border-b border-[var(--border-subtle)] text-[10px] uppercase tracking-wide text-[var(--text-secondary)]"><th title="Expand position details" className="w-8 px-2 py-2" /><th title="Market event name" className="px-2 py-2 text-left font-medium">Market</th><th title="Immutable selection method captured when BotTrader chose this trade" className="px-2 py-2 text-center font-medium">Method</th><th title="Which legs the bot bought" className="px-2 py-2 text-left font-medium">Strategy</th><th title="Total dollars spent on both legs" className="px-2 py-2 text-right font-medium">Buy Cost</th><th title="Current market value of both legs" className="px-2 py-2 text-right font-medium">Current Value</th><th title="Profit or loss at current prices" className="px-2 py-2 text-right font-medium">P&amp;L</th><th title="Unrealized return as a percentage" className="px-2 py-2 text-right font-medium">ROI</th><th title="Position state: open, settled, or closed" className="px-2 py-2 text-center font-medium">Status</th><th title="When the bot placed this trade" className="px-2 py-2 text-right font-medium">Opened</th></tr></thead>
            <tbody className="divide-y divide-[var(--border-subtle)]">
              {sortedPositions.map((position) => {
                const isExpanded = expanded.has(position.id);
                const openMark = position.status === 'open' ? openPositionMark(position) : null;
                const pnl = position.status === 'open' ? (openMark?.available ? openMark.pnlCents : null) : position.realizedPnlCents;
                const roiBps = position.status === 'open'
                  ? (openMark?.available ? openMark.roiBps : null)
                  : hasVerifiedTerminalAccounting(position) ? positionRoiBps(position) : null;
                const openUnavailableLabel = openMark && !openMark.available ? openMark.label : null;
                const settlementUnavailableLabel = position.status !== 'open' && !hasVerifiedTerminalAccounting(position) ? 'Pending verification' : null;
                const valueUnavailableLabel = openUnavailableLabel ?? settlementUnavailableLabel;
                const hasLiquidationBreakdown = valueUnavailableLabel == null
                  && position.currentValueCents != null
                  && Number.isSafeInteger(position.kalshiGrossProceedsMicrocents)
                  && Number.isSafeInteger(position.pmGrossProceedsMicrocents)
                  && Number.isSafeInteger(position.kalshiNetProceedsCents)
                  && Number.isSafeInteger(position.pmNetProceedsCents)
                  && Number.isSafeInteger(position.kalshiExitFeeCents)
                  && Number.isSafeInteger(position.pmExitFeeCents)
                  && position.sharesKalshi > 0
                  && position.sharesPm > 0
                  && position.kalshiExitFeeType === 'quadratic'
                  && Number.isSafeInteger(position.kalshiExitFeeMultiplierPpm)
                  && Number.isSafeInteger(position.pmExitFeeRateBps)
                  && position.kalshiNetProceedsCents! + position.pmNetProceedsCents! === position.currentValueCents;
                const liquidationUnavailableLabel = position.status !== 'open'
                  ? 'Not applicable after resolution'
                  : valueUnavailableLabel ?? (hasLiquidationBreakdown ? null : 'Unavailable');
                const kalshiNetProceedsCents = hasLiquidationBreakdown
                  ? position.kalshiNetProceedsCents!
                  : null;
                const pmNetProceedsCents = hasLiquidationBreakdown
                  ? position.pmNetProceedsCents!
                  : null;
                return [
                  <tr key={`row-${position.id}`} onClick={() => setExpanded((current) => { const next = new Set(current); if (next.has(position.id)) next.delete(position.id); else next.add(position.id); return next; })} className="cursor-pointer hover:bg-[var(--border-subtle)]/50" aria-expanded={isExpanded}>
                    <td className="px-2 py-2 text-[var(--text-secondary)]"><button type="button" onClick={(event) => { event.stopPropagation(); setExpanded((current) => { const next = new Set(current); if (next.has(position.id)) next.delete(position.id); else next.add(position.id); return next; }); }} className="flex min-h-11 min-w-11 items-center justify-center rounded hover:bg-[var(--border-strong)]" aria-label={`${isExpanded ? 'Collapse' : 'Expand'} ${position.marketTitle}`}>{isExpanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}</button></td>
                    <td className="max-w-56 px-2 py-2 font-medium text-[var(--text-primary)]" title={position.marketTitle}>{position.marketId ? <a href={`/?view=scan&id=${encodeURIComponent(position.marketId)}`} aria-label={`Open ${position.marketTitle} market`} onClick={(event) => event.stopPropagation()} className="block truncate underline decoration-[var(--border-strong)] underline-offset-2 hover:text-[var(--status-positive)]">{position.marketTitle}</a> : <span className="block truncate">{position.marketTitle}</span>}<div className="mt-1 flex gap-2 text-[9px] font-normal">{position.kalshiUrl && <a href={position.kalshiUrl} target="_blank" rel="noopener noreferrer" aria-label={`Open exact Kalshi ${position.kalshiSide.toUpperCase()} market for ${position.marketTitle}`} onClick={(event) => event.stopPropagation()} className="text-[var(--status-positive)] underline">Kalshi {position.kalshiSide.toUpperCase()}</a>}{position.polymarketUrl && <a href={position.polymarketUrl} target="_blank" rel="noopener noreferrer" aria-label={`Open exact Polymarket ${position.pmSide.toUpperCase()} market for ${position.marketTitle}`} onClick={(event) => event.stopPropagation()} className="text-[var(--status-info)] underline">PM {position.pmSide.toUpperCase()}</a>}{!position.kalshiUrl && !position.polymarketUrl && <span className="text-[var(--text-muted)]">Link unavailable</span>}<span className="text-[var(--text-muted)]">#{position.executionId}</span></div></td>
                    <td className="px-2 py-2 text-center"><span className="rounded bg-[var(--border-strong)] px-1.5 py-0.5 text-[9px] font-bold uppercase text-[var(--text-secondary)]">{position.selectionMethod?.toUpperCase() ?? 'Legacy/Unknown'}</span></td>
                    <td className="max-w-52 truncate px-2 py-2 text-[var(--text-secondary)]">{position.strategy || '—'}</td>
                    <td className="px-2 py-2 text-right tabular-nums">{formatCents(position.totalCostCents)}</td>
                    <td className={`px-2 py-2 text-right tabular-nums ${valueUnavailableLabel ? 'text-[var(--status-warning)]' : ''}`}>{valueUnavailableLabel ?? (position.status === 'open' && openMark?.available ? formatCents(openMark.currentValueCents) : formatCents(position.resolutionPayoutCents!))}</td>
                    <td className={`px-2 py-2 text-right font-semibold tabular-nums ${pnl == null ? 'text-[var(--status-warning)]' : pnlClass(pnl)}`}>{valueUnavailableLabel ?? (pnl == null ? 'Unavailable' : formatCents(pnl, true))}</td>
                    <td className={`px-2 py-2 text-right tabular-nums ${roiBps == null || valueUnavailableLabel ? 'text-[var(--status-warning)]' : pnlClass(roiBps)}`}>{valueUnavailableLabel ?? (roiBps == null ? 'Unavailable' : formatBps(roiBps, true))}</td>
                    <td className="px-2 py-2 text-center"><StatusBadge status={position.status} /></td>
                    <td className="px-2 py-2 text-right text-[var(--text-secondary)]" title={new Date(position.openedAt).toLocaleString()}>{timeAgo(position.openedAt)}</td>
                  </tr>,
                  isExpanded && <tr key={`detail-${position.id}`}>
                    <td colSpan={10} className="bg-[var(--surface-workspace)] px-3 py-3 sm:px-10">
                      <div className="grid grid-cols-2 gap-x-6 gap-y-2 text-[10px] sm:grid-cols-3 lg:grid-cols-4">
                        <div><span className="text-[var(--text-secondary)]">Kalshi ticker</span><div className="break-all font-mono text-[var(--text-primary)]">{position.kalshiTicker || '—'}</div></div>
                        <div><span className="text-[var(--text-secondary)]">PM conditionId</span><div className="break-all font-mono text-[var(--text-primary)]">{position.pmConditionId || '—'}</div></div>
                        <div><span className="text-[var(--text-secondary)]">Buy prices</span><div>{position.kalshiSide.toUpperCase()} {formatCents(position.buyPriceKalshiCents)} K · {position.pmSide.toUpperCase()} {formatCents(position.buyPricePmCents)} PM</div></div>
                        <div><span className="text-[var(--text-secondary)]">Expiry</span><div>{position.expiryDate ? new Date(position.expiryDate).toLocaleDateString() : '—'}</div></div>
                      </div>
                      {liquidationUnavailableLabel ? (
                        <div className="mt-3 rounded border border-[var(--status-warning)]/40 bg-[var(--status-warning)]/10 px-3 py-2 text-xs font-semibold text-[var(--status-warning)]">Liquidation breakdown: {liquidationUnavailableLabel}</div>
                      ) : (
                        <div className="mt-3 grid gap-2 text-xs lg:grid-cols-2">
                          <div data-testid="kalshi-liquidation" className="rounded border border-[var(--border-subtle)] bg-[var(--surface-panel)] px-3 py-2">
                            <div className="font-semibold text-[var(--text-primary)]">Kalshi {position.kalshiSide.toUpperCase()}</div>
                            <div className="mt-1 tabular-nums text-[var(--text-secondary)]">{INTEGER.format(position.sharesKalshi)} held · {formatVwapCents(position.kalshiGrossProceedsMicrocents!, position.sharesKalshi)} VWAP · {formatMicrocents(position.kalshiGrossProceedsMicrocents!)} gross</div>
                            <div className="tabular-nums text-[var(--text-secondary)]">{formatCents(position.kalshiExitFeeCents!)} fee ({position.kalshiExitFeeType}, ×{(position.kalshiExitFeeMultiplierPpm! / 1_000_000).toFixed(6)}) · <strong className="text-[var(--text-primary)]">{formatCents(kalshiNetProceedsCents!)} net</strong></div>
                          </div>
                          <div data-testid="polymarket-liquidation" className="rounded border border-[var(--border-subtle)] bg-[var(--surface-panel)] px-3 py-2">
                            <div className="font-semibold text-[var(--text-primary)]">Polymarket {position.pmSide.toUpperCase()}</div>
                            <div className="mt-1 tabular-nums text-[var(--text-secondary)]">{INTEGER.format(position.sharesPm)} held · {formatVwapCents(position.pmGrossProceedsMicrocents!, position.sharesPm)} VWAP · {formatMicrocents(position.pmGrossProceedsMicrocents!)} gross</div>
                            <div className="tabular-nums text-[var(--text-secondary)]">{formatCents(position.pmExitFeeCents!)} fee ({(position.pmExitFeeRateBps! / 100).toFixed(2)}%) · <strong className="text-[var(--text-primary)]">{formatCents(pmNetProceedsCents!)} net</strong></div>
                          </div>
                          <div data-testid="combined-net-proceeds" className="flex items-center justify-between rounded border border-[var(--border-strong)] px-3 py-2 font-semibold lg:col-span-2"><span>Combined net proceeds</span><span className="tabular-nums">{formatCents(kalshiNetProceedsCents! + pmNetProceedsCents!)}</span></div>
                        </div>
                      )}
                    </td>
                  </tr>,
                ];
              })}
            </tbody>
          </table>
          {sortedPositions.length === 0 && <div className="py-10 text-center text-sm text-[var(--text-secondary)]">No {filter === 'all' ? '' : `${filter} `}verified BotTrader positions for these filters.</div>}
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
