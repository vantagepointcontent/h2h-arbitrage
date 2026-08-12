'use client';

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
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

type PositionStatus = 'open' | 'partially_closed' | 'settled' | 'closed';
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

interface ExecutionLeg {
  venue: 'kalshi' | 'polymarket';
  marketRef: string | null;
  side: 'yes' | 'no';
  executionPriceCents: number;
  originalQuantity: number;
  originalPrincipalCents: number;
  entryFeeCents: number;
  remainingOpenQuantity: number;
  remainingOpenPrincipalCents: number;
  remainingOpenFeeCents: number;
  currentExecutablePriceCents: number | null;
  currentLiquidationValueCents: number | null;
}

interface BotExecution {
  entryId: number;
  executionId: number;
  tradeId?: string;
  executedAt: string;
  mode: 'paper' | 'production';
  strategy: string | null;
  selectionMethod?: 'roi' | 'apy' | 'hybrid' | null;
  expectedRoiBps?: number | null;
  expectedApyBps?: number | null;
  unitId?: string | null;
  status: PositionStatus;
  legs: ExecutionLeg[];
  executionPrincipalCents: number;
  executionFeesCents: number;
  executionBuyCostCents: number;
  remainingOpenPrincipalCents: number;
  remainingOpenFeesCents: number;
  remainingOpenCostCents: number;
  currentValueCents: number;
  unrealizedPnlCents: number;
  realizedPnlCents: number;
  openedAt: string;
  closedAt: string | null;
  settledAt: string | null;
  lastValuationAt: string | null;
  kalshiUrl?: string | null;
  polymarketUrl?: string | null;
}

interface BotPositionMarket {
  marketKey: string;
  marketId: string | null;
  marketTitle: string;
  kalshiTicker: string | null;
  pmConditionId: string | null;
  kalshiUrl?: string | null;
  polymarketUrl?: string | null;
  currentLiveStakeCents: number;
  currentValueCents: number;
  unrealizedPnlCents: number;
  realizedPnlCents: number;
  status: PositionStatus;
  latestExecutionAt: string;
  executions: BotExecution[];
}

export function positionRoiBps(position: Pick<BotPosition, 'status' | 'totalCostCents' | 'realizedPnlCents' | 'unrealizedRoiBps'>): number {
  if (position.status === 'open') return position.unrealizedRoiBps ?? 0;
  if (position.totalCostCents <= 0) return 0;
  return Math.round(((position.realizedPnlCents ?? 0) * 10_000) / position.totalCostCents);
}

function legacyExecution(position: BotPosition): BotExecution {
  const buyCost = position.totalCostCents;
  const principalCost = Math.max(0, position.totalCostCents - position.feesCents);
  const isOpen = position.status === 'open';
  return {
    entryId: position.id,
    executionId: position.executionId,
    executedAt: position.openedAt,
    mode: position.dryRun ? 'paper' : 'production',
    strategy: position.strategy,
    selectionMethod: position.selectionMethod,
    status: position.status,
    legs: [
      {
        venue: 'kalshi', marketRef: position.kalshiTicker, side: position.kalshiSide,
        executionPriceCents: position.buyPriceKalshiCents, originalQuantity: position.sharesKalshi,
        originalPrincipalCents: position.buyPriceKalshiCents * position.sharesKalshi,
        entryFeeCents: 0, remainingOpenQuantity: isOpen ? position.sharesKalshi : 0,
        remainingOpenPrincipalCents: isOpen ? position.buyPriceKalshiCents * position.sharesKalshi : 0,
        remainingOpenFeeCents: 0, currentExecutablePriceCents: position.currentPriceKalshiCents,
        currentLiquidationValueCents: null,
      },
      {
        venue: 'polymarket', marketRef: position.pmConditionId, side: position.pmSide,
        executionPriceCents: position.buyPricePmCents, originalQuantity: position.sharesPm,
        originalPrincipalCents: position.buyPricePmCents * position.sharesPm,
        entryFeeCents: position.feesCents, remainingOpenQuantity: isOpen ? position.sharesPm : 0,
        remainingOpenPrincipalCents: isOpen ? position.buyPricePmCents * position.sharesPm : 0,
        remainingOpenFeeCents: isOpen ? position.feesCents : 0,
        currentExecutablePriceCents: position.currentPricePmCents, currentLiquidationValueCents: null,
      },
    ],
    executionPrincipalCents: principalCost,
    executionFeesCents: position.feesCents,
    executionBuyCostCents: buyCost,
    remainingOpenPrincipalCents: isOpen ? principalCost : 0,
    remainingOpenFeesCents: isOpen ? position.feesCents : 0,
    remainingOpenCostCents: isOpen ? buyCost : 0,
    currentValueCents: position.currentValueCents ?? 0,
    unrealizedPnlCents: position.unrealizedPnlCents ?? 0,
    realizedPnlCents: position.realizedPnlCents ?? 0,
    openedAt: position.openedAt,
    closedAt: position.status === 'closed' ? position.settledAt : null,
    settledAt: position.settledAt,
    lastValuationAt: position.lastValuationAt,
    kalshiUrl: position.kalshiUrl,
    polymarketUrl: position.polymarketUrl,
  };
}

type PositionPayload = {
  markets?: Array<BotPositionMarket & { liveStakeCents?: number; latestOpenedAt?: string; entries?: BotExecution[] }>;
  positions?: BotPosition[];
};

export function normalizePositionMarkets(payload: PositionPayload): BotPositionMarket[] {
  if (Array.isArray(payload.markets)) {
    return payload.markets.map((market) => ({
      ...market,
      currentLiveStakeCents: market.currentLiveStakeCents ?? market.liveStakeCents ?? 0,
      latestExecutionAt: market.latestExecutionAt ?? market.latestOpenedAt ?? '',
      executions: market.executions ?? market.entries ?? [],
    }));
  }
  return (payload.positions ?? []).map((position) => {
    const execution = legacyExecution(position);
    return {
      marketKey: `legacy-execution:${position.executionId}`,
      marketId: position.marketId,
      marketTitle: position.marketTitle,
      kalshiTicker: position.kalshiTicker,
      pmConditionId: position.pmConditionId,
      kalshiUrl: position.kalshiUrl,
      polymarketUrl: position.polymarketUrl,
      currentLiveStakeCents: execution.remainingOpenCostCents,
      currentValueCents: execution.currentValueCents,
      unrealizedPnlCents: execution.unrealizedPnlCents,
      realizedPnlCents: execution.realizedPnlCents,
      status: execution.status,
      latestExecutionAt: execution.executedAt,
      executions: [execution],
    };
  });
}

type AnalyticsMethod = 'all' | 'roi' | 'apy' | 'hybrid' | 'legacy';
type AnalyticsMode = 'all' | 'paper' | 'production';
interface MethodAnalytics {
  tradeCount: number; deployedCapitalCents: number; realizedPnlCents: number;
  unrealizedPnlCents: number; winRateBps: number; averageEntryRoiBps: number;
  currentRoiBps: number; averageApyPct: number | null;
}
interface Analytics {
  totalBotTrades: { paper: number; production: number; total: number };
  openPositions: { count: number; unrealizedPnlCents: number };
  settledPositions: { count: number; realizedPnlCents: number; winRateBps: number };
  dailyPnl: Array<{ date: string; realizedPnlCents: number; unrealizedPnlCents: number; trades: number }>;
  dailyPnlByMethod: Record<'roi' | 'apy' | 'hybrid', Array<{ date: string; realizedPnlCents: number; unrealizedPnlCents: number; trades: number }>>;
  filter: { method: AnalyticsMethod; mode: AnalyticsMode };
  perMethod: Record<'roi' | 'apy' | 'hybrid' | 'legacy', MethodAnalytics>;
}
const EMPTY_METHOD: MethodAnalytics = { tradeCount: 0, deployedCapitalCents: 0, realizedPnlCents: 0, unrealizedPnlCents: 0, winRateBps: 0, averageEntryRoiBps: 0, currentRoiBps: 0, averageApyPct: null };

interface BotStatus {
  enabled: boolean;
  mode: 'paper' | 'production';
  selectionMethod: 'roi' | 'apy' | 'hybrid';
  todayCount: number;
  todayStakeUsd: number;
  maxUnitsPerMarket?: number;
}

const EMPTY_ANALYTICS: Analytics = {
  totalBotTrades: { paper: 0, production: 0, total: 0 },
  openPositions: { count: 0, unrealizedPnlCents: 0 },
  settledPositions: { count: 0, realizedPnlCents: 0, winRateBps: 0 },
  dailyPnl: [],
  dailyPnlByMethod: { roi: [], apy: [], hybrid: [] },
  filter: { method: 'all', mode: 'all' },
  perMethod: { roi: EMPTY_METHOD, apy: EMPTY_METHOD, hybrid: EMPTY_METHOD, legacy: EMPTY_METHOD },
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
    partially_closed: 'bg-[var(--status-info)]/15 text-[var(--status-info)]',
    settled: 'bg-[var(--platform-polymarket)]/15 text-[var(--platform-polymarket)]',
    closed: 'bg-[var(--status-negative)]/15 text-[var(--status-negative)]',
  };
  return <span className={`inline-flex rounded px-1.5 py-0.5 text-[9px] font-bold uppercase ${styles[status]}`}>{status}</span>;
}

function ExecutionDetailRow({ execution }: { execution: BotExecution }) {
  return (
    <tr data-testid={`execution-${execution.executionId}`} className="bg-[#071a33] text-[var(--text-primary)]">
      <td colSpan={10} className="px-10 py-2">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[10px]">
          <strong className="font-mono text-[var(--status-info)]">Execution #{execution.executionId}{execution.tradeId ? ` · ${execution.tradeId}` : ''}</strong>
          <span title={new Date(execution.executedAt).toISOString()}>Executed {new Date(execution.executedAt).toLocaleString()}</span>
          <span className="uppercase text-[var(--text-secondary)]">{execution.mode}</span>
          <span>{execution.strategy || 'Strategy unavailable'}</span>
          <span>Unit <strong>{execution.unitId ?? `execution:${execution.executionId}`}</strong></span>
          <span>Exp ROI <strong className={execution.expectedRoiBps == null ? 'text-[var(--text-muted)]' : pnlClass(execution.expectedRoiBps)}>{execution.expectedRoiBps == null ? '—' : formatBps(execution.expectedRoiBps, true)}</strong></span>
          <span>Exp APY <strong className={execution.expectedApyBps == null ? 'text-[var(--text-muted)]' : pnlClass(execution.expectedApyBps)}>{execution.expectedApyBps == null ? '—' : formatBps(execution.expectedApyBps)}</strong></span>
          <span>Buy Cost <strong aria-label={`Execution ${execution.executionId} Buy Cost`} className="tabular-nums">{formatCents(execution.executionBuyCostCents)}</strong> <span className="text-[var(--text-muted)]">({formatCents(execution.executionPrincipalCents)} + {formatCents(execution.executionFeesCents)} fees)</span></span>
          <StatusBadge status={execution.status} />
          <span>Remaining exposure: <strong aria-label={`Execution ${execution.executionId} remaining exposure`} className="tabular-nums">{formatCents(execution.remainingOpenCostCents)}</strong></span>
        </div>
        <div className="mt-1 flex flex-wrap gap-x-5 gap-y-1 text-[10px] text-[var(--text-secondary)]">
          {execution.legs.map((leg) => (
            <span key={`${execution.executionId}-${leg.venue}`}>
              <strong className="uppercase text-[var(--text-primary)]">{leg.venue}</strong> {leg.side.toUpperCase()} · {INTEGER.format(leg.executionPriceCents)}¢ × {INTEGER.format(leg.originalQuantity)} · fees {formatCents(leg.entryFeeCents)} · open {INTEGER.format(leg.remainingOpenQuantity)} · <span className="font-mono">{leg.marketRef || 'unknown market'}</span>
            </span>
          ))}
        </div>
      </td>
    </tr>
  );
}

export default function BotTraderPanel() {
  const [view, setView] = useState<'analytics' | 'logs' | 'messages'>('analytics');
  const [analytics, setAnalytics] = useState<Analytics>(EMPTY_ANALYTICS);
  const [markets, setMarkets] = useState<BotPositionMarket[]>([]);
  const [status, setStatus] = useState<BotStatus | null>(null);
  const [filter, setFilter] = useState<PositionFilter>('all');
  const [analyticsMethod, setAnalyticsMethod] = useState<AnalyticsMethod>('all');
  const [analyticsMode, setAnalyticsMode] = useState<AnalyticsMode>('all');
  const [overlayMethods, setOverlayMethods] = useState<Record<'roi' | 'apy' | 'hybrid', boolean>>({ roi: true, apy: true, hybrid: true });
  const [sortKey, setSortKey] = useState<SortKey>('openedAt');
  const [sortDirection, setSortDirection] = useState<SortDirection>('desc');
  const [executionVisibility, setExecutionVisibility] = useState<Record<string, boolean>>({});
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
        fetch(`/api/bot-trader/analytics?method=${analyticsMethod}&mode=${analyticsMode}`, { cache: 'no-store' }),
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
      const nextAnalytics = analyticsData.analytics ?? EMPTY_ANALYTICS;
      setAnalytics({ ...EMPTY_ANALYTICS, ...nextAnalytics, perMethod: { ...EMPTY_ANALYTICS.perMethod, ...(nextAnalytics.perMethod ?? {}) } });
      setMarkets(normalizePositionMarkets(positionsData));
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
  }, [analyticsMethod, analyticsMode, filter]);

  useEffect(() => {
    const initialId = window.setTimeout(() => void load(true), 0);
    const intervalId = window.setInterval(() => void load(false), 30_000);
    return () => {
      window.clearTimeout(initialId);
      window.clearInterval(intervalId);
    };
  }, [load]);

  const sortedMarkets = useMemo(() => [...markets].sort((a, b) => {
    const values: Record<SortKey, [number, number]> = {
      openedAt: [Date.parse(a.latestExecutionAt), Date.parse(b.latestExecutionAt)],
      pnl: [a.status === 'open' || a.status === 'partially_closed' ? a.unrealizedPnlCents : a.realizedPnlCents, b.status === 'open' || b.status === 'partially_closed' ? b.unrealizedPnlCents : b.realizedPnlCents],
      roi: [a.currentLiveStakeCents > 0 ? Math.round(a.unrealizedPnlCents * 10_000 / a.currentLiveStakeCents) : 0, b.currentLiveStakeCents > 0 ? Math.round(b.unrealizedPnlCents * 10_000 / b.currentLiveStakeCents) : 0],
    };
    const [left, right] = values[sortKey];
    return sortDirection === 'asc' ? left - right : right - left;
  }), [markets, sortDirection, sortKey]);

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
        <MetricCard label="Paper Trades" value={INTEGER.format(analytics.totalBotTrades.paper)} />
        <MetricCard label="Prod Trades" value={INTEGER.format(analytics.totalBotTrades.production)} />
        <MetricCard label="Open Positions" value={INTEGER.format(analytics.openPositions.count)} />
        <MetricCard label="Win Rate" value={formatBps(analytics.settledPositions.winRateBps)} />
      </div>

      <div className="rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-panel)] p-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div><div className="text-sm font-semibold text-[var(--text-primary)]">Performance by selection method</div><div className="text-[10px] text-[var(--text-secondary)]">Fee-net values. Legacy attribution is kept separate.</div></div>
          <div className="flex flex-wrap gap-2"><div className="flex rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-workspace)] p-0.5" aria-label="Analytics method filter">{(['all', 'roi', 'apy', 'hybrid'] as const).map((value) => <button key={value} onClick={() => setAnalyticsMethod(value)} aria-pressed={analyticsMethod === value} className={`min-h-11 rounded-md px-3 text-xs uppercase ${analyticsMethod === value ? 'bg-[var(--status-positive)] text-black' : 'text-[var(--text-secondary)]'}`}>{value}</button>)}</div><label className="text-xs text-[var(--text-secondary)]">Mode <select aria-label="Analytics trading mode" value={analyticsMode} onChange={(event) => setAnalyticsMode(event.target.value as AnalyticsMode)} className="ml-1 min-h-11 rounded-lg border border-[var(--border-strong)] bg-[var(--surface-workspace)] px-2 text-[var(--text-primary)]"><option value="all">All</option><option value="paper">Paper</option><option value="production">Production</option></select></label></div>
        </div>
        <div className="mt-3 grid gap-2 md:grid-cols-2 xl:grid-cols-4" role="list" aria-label="Method comparison">
          {(['roi', 'apy', 'hybrid', 'legacy'] as const).map((method) => { const item = analytics.perMethod[method] ?? EMPTY_METHOD; const netPnl = item.realizedPnlCents + item.unrealizedPnlCents; return <button type="button" role="listitem" key={method} onClick={() => method !== 'legacy' && setAnalyticsMethod(method)} className={`rounded-lg border p-3 text-left ${analyticsMethod === method ? 'border-[var(--status-positive)]' : 'border-[var(--border-subtle)]'} bg-[var(--surface-workspace)]`} aria-label={`${method} method performance`}><div className="text-xs font-bold uppercase text-[var(--text-primary)]">{method === 'legacy' ? 'Legacy / Unknown' : method}</div><div className="mt-2 grid grid-cols-2 gap-1 text-[10px] text-[var(--text-secondary)]"><span>Trades</span><strong className="text-right text-[var(--text-primary)]">{item.tradeCount}</strong><span>Capital</span><strong className="text-right text-[var(--text-primary)]">{formatCents(item.deployedCapitalCents)}</strong><span>Net P&amp;L</span><strong className={`text-right ${pnlClass(netPnl)}`}>{formatCents(netPnl, true)}</strong><span>Win rate</span><strong className="text-right text-[var(--text-primary)]">{formatBps(item.winRateBps)}</strong><span>Entry ROI</span><strong className="text-right text-[var(--text-primary)]">{formatBps(item.averageEntryRoiBps)}</strong><span>Current ROI</span><strong className="text-right text-[var(--text-primary)]">{formatBps(item.currentRoiBps, true)}</strong><span>Selection APY</span><strong className="text-right text-[var(--text-primary)]">{item.averageApyPct == null ? 'No data' : `${ONE_DECIMAL.format(item.averageApyPct)}%`}</strong></div></button>; })}
        </div>
        <div className="mt-3" aria-label="Daily fee-net performance chart"><div className="mb-1 text-[10px] font-semibold uppercase text-[var(--text-secondary)]">Daily net P&amp;L · {analyticsMethod.toUpperCase()} · {analyticsMode}</div>{analytics.dailyPnl.length === 0 ? <div className="rounded border border-dashed border-[var(--border-strong)] py-5 text-center text-xs text-[var(--text-secondary)]">No performance data for this filter.</div> : <div className="flex h-28 items-end gap-1 overflow-x-auto">{analytics.dailyPnl.map((day) => { const pnl = day.realizedPnlCents + day.unrealizedPnlCents; const peak = Math.max(...analytics.dailyPnl.map((row) => Math.abs(row.realizedPnlCents + row.unrealizedPnlCents)), 1); const height = Math.max(8, Math.abs(pnl) / peak * 100); return <div key={day.date} className="flex min-w-8 flex-1 flex-col items-center justify-end" title={`${day.date}: ${formatCents(pnl, true)}`}><div className={`w-full rounded-t ${pnl >= 0 ? 'bg-[var(--status-positive)]' : 'bg-[var(--status-negative)]'}`} style={{ height: `${height}%` }} /><span className="mt-1 text-[8px] text-[var(--text-muted)]">{day.date.slice(5)}</span></div>; })}</div>}</div>
        <div className="mt-3" aria-label="Method overlay chart">
          <div className="mb-2 flex flex-wrap items-center gap-2" role="group" aria-label="Overlay method series">
            <span className="text-[10px] font-semibold uppercase text-[var(--text-secondary)]">Overlay</span>
            {(['roi', 'apy', 'hybrid'] as const).map((method) => <button type="button" key={method} aria-label={`${method} overlay series`} aria-pressed={overlayMethods[method]} onClick={() => setOverlayMethods((current) => ({ ...current, [method]: !current[method] }))} className={`min-h-9 rounded px-2 text-[10px] font-bold uppercase ${overlayMethods[method] ? 'bg-[var(--status-info)] text-black' : 'border border-[var(--border-strong)] text-[var(--text-secondary)]'}`}>{method}</button>)}
          </div>
          <div className="grid gap-2" aria-label="Daily P&L overlay series">
            {(['roi', 'apy', 'hybrid'] as const).filter((method) => overlayMethods[method]).map((method) => { const series = analytics.dailyPnlByMethod?.[method] ?? []; const peak = Math.max(...series.map((day) => Math.abs(day.realizedPnlCents + day.unrealizedPnlCents)), 1); return <div key={method} className="grid grid-cols-[4rem_1fr] items-center gap-2"><span className="text-[10px] font-bold uppercase text-[var(--text-secondary)]">{method}</span><div className="flex h-12 items-end gap-1" aria-label={`${method} daily net P&L series`}>{series.length === 0 ? <span className="self-center text-[10px] text-[var(--text-muted)]">No data</span> : series.map((day) => { const pnl = day.realizedPnlCents + day.unrealizedPnlCents; return <div key={day.date} className={`min-w-3 flex-1 rounded-t ${pnl >= 0 ? 'bg-[var(--status-positive)]' : 'bg-[var(--status-negative)]'}`} style={{ height: `${Math.max(6, Math.abs(pnl) / peak * 100)}%` }} title={`${method.toUpperCase()} ${day.date}: ${formatCents(pnl, true)}`} />; })}</div></div>; })}
          </div>
        </div>
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
            <thead><tr className="border-b border-[var(--border-subtle)] text-[10px] uppercase tracking-wide text-[var(--text-secondary)]"><th title="Expand execution history" className="w-8 px-2 py-2" /><th title="Market event name" className="px-2 py-2 text-left font-medium">Market</th><th title="Durable executions in this market" className="px-2 py-2 text-center font-medium">Executions</th><th title="Current open exposure only" className="px-2 py-2 text-left font-medium">Exposure</th><th title="Cumulative fee-inclusive cost of open exposure" className="px-2 py-2 text-right font-medium">Live Stake</th><th title="Current market value of remaining open exposure" className="px-2 py-2 text-right font-medium">Current Value</th><th title="Profit or loss at current prices" className="px-2 py-2 text-right font-medium">P&amp;L</th><th title="Unrealized return on remaining open cost" className="px-2 py-2 text-right font-medium">ROI</th><th title="Market state" className="px-2 py-2 text-center font-medium">Status</th><th title="Most recent execution" className="px-2 py-2 text-right font-medium">Latest</th></tr></thead>
            <tbody className="divide-y divide-[var(--border-subtle)]">
              {sortedMarkets.map((market) => {
                const showExecutions = executionVisibility[market.marketKey] ?? market.executions.length > 1;
                const pnl = market.status === 'open' || market.status === 'partially_closed' ? market.unrealizedPnlCents : market.realizedPnlCents;
                const roiBps = market.currentLiveStakeCents > 0 ? Math.round(market.unrealizedPnlCents * 10_000 / market.currentLiveStakeCents) : 0;
                const firstExecution = market.executions[0];
                const kalshiLeg = firstExecution?.legs.find((leg) => leg.venue === 'kalshi');
                const pmLeg = firstExecution?.legs.find((leg) => leg.venue === 'polymarket');
                const kalshiUrl = market.kalshiUrl ?? firstExecution?.kalshiUrl;
                const polymarketUrl = market.polymarketUrl ?? firstExecution?.polymarketUrl;
                const toggle = () => setExecutionVisibility((current) => ({ ...current, [market.marketKey]: !showExecutions }));
                return <Fragment key={market.marketKey}>
                  <tr data-testid={`market-${market.marketKey}`} onClick={toggle} className="cursor-pointer hover:bg-[var(--border-subtle)]/50" aria-expanded={showExecutions}>
                    <td className="px-2 py-2 text-[var(--text-secondary)]"><button type="button" onClick={(event) => { event.stopPropagation(); toggle(); }} className="flex min-h-11 min-w-11 items-center justify-center rounded hover:bg-[var(--border-strong)]" aria-label={`${showExecutions ? 'Collapse' : 'Expand'} ${market.marketTitle}`}>{showExecutions ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}</button></td>
                    <td className="max-w-56 px-2 py-2 font-medium text-[var(--text-primary)]" title={market.marketTitle}>{market.marketId ? <a href={`/?view=scan&id=${encodeURIComponent(market.marketId)}`} aria-label={`Open ${market.marketTitle} market`} onClick={(event) => event.stopPropagation()} className="block truncate underline decoration-[var(--border-strong)] underline-offset-2 hover:text-[var(--status-positive)]">{market.marketTitle}</a> : <span className="block truncate">{market.marketTitle}</span>}<div className="mt-1 flex gap-2 text-[9px] font-normal">{kalshiUrl && <a href={kalshiUrl} target="_blank" rel="noopener noreferrer" aria-label={`Open exact Kalshi ${(kalshiLeg?.side ?? 'yes').toUpperCase()} market for ${market.marketTitle}`} onClick={(event) => event.stopPropagation()} className="text-[var(--status-positive)] underline">Kalshi {(kalshiLeg?.side ?? 'yes').toUpperCase()}</a>}{polymarketUrl && <a href={polymarketUrl} target="_blank" rel="noopener noreferrer" aria-label={`Open exact Polymarket ${(pmLeg?.side ?? 'no').toUpperCase()} market for ${market.marketTitle}`} onClick={(event) => event.stopPropagation()} className="text-[var(--status-info)] underline">PM {(pmLeg?.side ?? 'no').toUpperCase()}</a>}{!kalshiUrl && !polymarketUrl && <span className="text-[var(--text-muted)]">Link unavailable</span>}</div></td>
                    <td className="px-2 py-2 text-center tabular-nums">{INTEGER.format(market.executions.length)}</td>
                    <td className="max-w-52 truncate px-2 py-2 text-[var(--text-secondary)]">Open execution cost</td>
                    <td aria-label={`${market.marketTitle} live stake`} className="px-2 py-2 text-right tabular-nums">{formatCents(market.currentLiveStakeCents)}</td>
                    <td className="px-2 py-2 text-right tabular-nums">{formatCents(market.currentValueCents)}</td>
                    <td className={`px-2 py-2 text-right font-semibold tabular-nums ${pnlClass(pnl)}`}>{formatCents(pnl, true)}</td>
                    <td className={`px-2 py-2 text-right tabular-nums ${pnlClass(roiBps)}`}>{formatBps(roiBps, true)}</td>
                    <td className="px-2 py-2 text-center"><StatusBadge status={market.status} /></td>
                    <td className="px-2 py-2 text-right text-[var(--text-secondary)]" title={new Date(market.latestExecutionAt).toLocaleString()}>{timeAgo(market.latestExecutionAt)}</td>
                  </tr>
                  {showExecutions && market.executions.map((execution) => <ExecutionDetailRow key={`execution-${execution.executionId}`} execution={execution} />)}
                </Fragment>;
              })}
            </tbody>
          </table>
          {sortedMarkets.length === 0 && <div className="py-10 text-center text-sm text-[var(--text-secondary)]">No {filter === 'all' ? '' : `${filter} `}BotTrader positions.</div>}
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
