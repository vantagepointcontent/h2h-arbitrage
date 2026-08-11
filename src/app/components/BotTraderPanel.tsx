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
  selectionMethod: 'roi' | 'apy' | 'hybrid';
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
  const label = status.charAt(0).toUpperCase() + status.slice(1);
  return <span className={`inline-flex rounded px-1.5 py-0.5 text-[9px] font-bold uppercase ${styles[status]}`}>Placed · {label}</span>;
}

const VALUATION_STALE_MS = 2 * 60_000;

function positionPnl(position: BotPosition): number | null {
  return position.status === 'open' ? position.unrealizedPnlCents : position.realizedPnlCents;
}

function valuationState(position: BotPosition): 'fresh' | 'stale' | 'unavailable' | 'settled' {
  if (position.status !== 'open') return 'settled';
  if (position.currentValueCents == null || position.unrealizedPnlCents == null || position.unrealizedRoiBps == null || !position.lastValuationAt) return 'unavailable';
  const age = Date.now() - Date.parse(position.lastValuationAt);
  return !Number.isFinite(age) || age > VALUATION_STALE_MS ? 'stale' : 'fresh';
}

function PositionTable({
  title,
  description,
  positions,
  kind,
  expanded,
  onToggle,
}: {
  title: string;
  description: string;
  positions: BotPosition[];
  kind: 'open' | 'completed';
  expanded: Set<number>;
  onToggle: (id: number) => void;
}) {
  const emptyText = kind === 'open' ? 'No open BotTrader positions.' : 'No completed BotTrader trades.';
  return <div className="overflow-hidden rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-panel)]">
    <div className="border-b border-[var(--border-subtle)] px-3 py-2">
      <div className="text-sm font-semibold text-[var(--text-primary)]">{title}</div>
      <div className="text-[10px] text-[var(--text-secondary)]">{description}</div>
    </div>
    <div className="overflow-x-auto" data-testid={`bot-${kind}-positions-scroll`}>
      <table className="w-full min-w-[1040px] text-xs">
        <thead><tr className="border-b border-[var(--border-subtle)] text-[10px] uppercase tracking-wide text-[var(--text-secondary)]">
          <th className="w-8 px-2 py-2" />
          <th className="px-2 py-2 text-left font-medium">Placed trade</th>
          <th className="px-2 py-2 text-left font-medium">Mode / execution</th>
          <th title="Capital spent to enter both legs; this is the P/L percentage denominator" className="px-2 py-2 text-right font-medium">Allocated capital</th>
          <th className="px-2 py-2 text-right font-medium">{kind === 'open' ? 'Current executable value' : 'Settlement value'}</th>
          <th className="px-2 py-2 text-right font-medium">{kind === 'open' ? 'Current P/L' : 'Realized P/L'}</th>
          <th title="Return divided by allocated capital" className="px-2 py-2 text-right font-medium">P/L %</th>
          <th className="px-2 py-2 text-right font-medium">Updated</th>
        </tr></thead>
        <tbody className="divide-y divide-[var(--border-subtle)]">
          {positions.map((position) => {
            const isExpanded = expanded.has(position.id);
            const quoteState = valuationState(position);
            const pnl = positionPnl(position);
            const roiBps = position.status === 'open' ? position.unrealizedRoiBps : positionRoiBps(position);
            const missingQuote = position.currentPriceKalshiCents == null
              ? 'Missing Kalshi executable bid'
              : position.currentPricePmCents == null ? 'Missing Polymarket executable bid' : null;
            const valueLabel = quoteState === 'fresh' ? 'Current executable value'
              : quoteState === 'stale' ? 'Last executable quote (stale)'
                : quoteState === 'unavailable' ? 'Valuation unavailable' : 'Settlement value';
            const updatedAt = position.status === 'open' ? position.lastValuationAt : (position.settledAt ?? position.lastValuationAt);
            const kalshiCapital = position.buyPriceKalshiCents * position.sharesKalshi;
            const pmCapital = position.buyPricePmCents * position.sharesPm;
            const balanced = position.sharesKalshi === position.sharesPm;
            return <Fragment key={position.id}>
              <tr className="hover:bg-[var(--border-subtle)]/50">
                <td className="px-2 py-2 text-[var(--text-secondary)]"><button type="button" onClick={() => onToggle(position.id)} className="flex min-h-11 min-w-11 items-center justify-center rounded hover:bg-[var(--border-strong)]" aria-label={`${isExpanded ? 'Collapse' : 'Expand'} ${position.marketTitle}`}>{isExpanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}</button></td>
                <td className="max-w-72 px-2 py-2"><div className="font-medium text-[var(--text-primary)]">{position.marketId ? <a href={`/?view=scan&id=${encodeURIComponent(position.marketId)}`} aria-label={`Open ${position.marketTitle} market`} onClick={(event) => event.stopPropagation()} className="block truncate underline decoration-[var(--border-strong)] underline-offset-2 hover:text-[var(--status-positive)]">{position.marketTitle}</a> : <span className="block truncate">{position.marketTitle}</span>}</div><div className="mt-1 text-[9px] text-[var(--text-muted)]">Execution #{position.executionId} · {new Date(position.openedAt).toLocaleString()}</div><div className="mt-1 flex gap-2 text-[9px]">{position.kalshiUrl && <a href={position.kalshiUrl} target="_blank" rel="noopener noreferrer" aria-label={`Open exact Kalshi ${position.kalshiSide.toUpperCase()} market for ${position.marketTitle}`} onClick={(event) => event.stopPropagation()} className="text-[var(--status-positive)] underline">Kalshi {position.kalshiSide.toUpperCase()}</a>}{position.polymarketUrl && <a href={position.polymarketUrl} target="_blank" rel="noopener noreferrer" aria-label={`Open exact Polymarket ${position.pmSide.toUpperCase()} market for ${position.marketTitle}`} onClick={(event) => event.stopPropagation()} className="text-[var(--status-info)] underline">PM {position.pmSide.toUpperCase()}</a>}</div></td>
                <td className="px-2 py-2"><div className="flex flex-wrap gap-1"><span className="rounded bg-[var(--surface-workspace)] px-1.5 py-0.5 text-[9px] font-bold uppercase">{position.dryRun ? 'Paper' : 'Live'}</span><StatusBadge status={position.status} /></div><div className="mt-1 max-w-52 truncate text-[10px] text-[var(--text-secondary)]">{position.strategy || 'Strategy unavailable'}</div></td>
                <td className="px-2 py-2 text-right tabular-nums"><div>{formatCents(position.totalCostCents)}</div><div className="text-[9px] text-[var(--text-secondary)]">+ {formatCents(position.feesCents)} fees</div></td>
                <td className="px-2 py-2 text-right tabular-nums"><div>{position.currentValueCents == null ? '—' : formatCents(position.currentValueCents)}</div><div className={`text-[9px] ${quoteState === 'stale' ? 'text-[var(--status-warning)]' : quoteState === 'unavailable' ? 'text-[var(--status-negative)]' : 'text-[var(--text-secondary)]'}`}>{valueLabel}</div>{quoteState === 'stale' && <div className="mt-1 text-[9px] font-bold uppercase text-[var(--status-warning)]">Stale valuation</div>}{missingQuote && <div className="mt-1 text-[9px] text-[var(--status-negative)]">{missingQuote}</div>}</td>
                <td className={`px-2 py-2 text-right font-semibold tabular-nums ${pnl == null ? 'text-[var(--text-muted)]' : pnlClass(pnl)}`}><div>{pnl == null ? '—' : formatCents(pnl, true)}</div>{quoteState === 'stale' && <div className="text-[9px] font-normal text-[var(--status-warning)]">Stale quote</div>}</td>
                <td className={`px-2 py-2 text-right tabular-nums ${roiBps == null ? 'text-[var(--text-muted)]' : pnlClass(roiBps)}`}><div>{roiBps == null ? '—' : `${formatBps(roiBps, true)} of allocated capital`}</div>{quoteState === 'stale' && <div className="text-[9px] text-[var(--status-warning)]">Stale quote</div>}</td>
                <td className="px-2 py-2 text-right text-[var(--text-secondary)]">{updatedAt ? <><div title={new Date(updatedAt).toLocaleString()}>{timeAgo(updatedAt)}</div><div className="text-[9px]">{new Date(updatedAt).toLocaleString()}</div></> : 'Never valued'}</td>
              </tr>
              {isExpanded && <tr><td colSpan={8} className="bg-[var(--surface-workspace)] px-4 py-3">
                <div className="grid gap-2 lg:grid-cols-2">
                  {([
                    { platform: 'Kalshi', side: position.kalshiSide, shares: position.sharesKalshi, entry: position.buyPriceKalshiCents, current: position.currentPriceKalshiCents, capital: kalshiCapital, id: position.kalshiTicker, url: position.kalshiUrl },
                    { platform: 'Polymarket', side: position.pmSide, shares: position.sharesPm, entry: position.buyPricePmCents, current: position.currentPricePmCents, capital: pmCapital, id: position.pmConditionId, url: position.polymarketUrl },
                  ] as const).map((leg) => <div key={leg.platform} className="rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-panel)] p-3">
                    <div className="flex items-center justify-between"><strong className="text-xs text-[var(--text-primary)]">{leg.platform} leg</strong><span className="text-[9px] font-bold uppercase text-[var(--text-secondary)]">{leg.side}</span></div>
                    <div className="mt-1 truncate text-[10px] text-[var(--text-secondary)]" title={position.marketTitle}>{position.marketTitle}</div>
                    <div className="mt-2 grid grid-cols-2 gap-2 text-[10px]"><div><span className="text-[var(--text-secondary)]">Fill / quantity</span><div>Filled {INTEGER.format(leg.shares)} contracts</div></div><div><span className="text-[var(--text-secondary)]">Entry price</span><div>{formatCents(leg.entry)} per contract</div></div><div><span className="text-[var(--text-secondary)]">Leg capital</span><div>{formatCents(leg.capital)}</div></div><div><span className="text-[var(--text-secondary)]">Executable bid</span><div>{leg.current == null ? 'Missing quote' : formatCents(leg.current)}</div></div><div><span className="text-[var(--text-secondary)]">Venue fee</span><div>Not itemized</div></div><div><span className="text-[var(--text-secondary)]">Venue market ID</span><div className="truncate font-mono" title={leg.id ?? ''}>{leg.id || 'Unavailable'}</div></div></div>
                    {leg.url && <a href={leg.url} target="_blank" rel="noopener noreferrer" onClick={(event) => event.stopPropagation()} className="mt-2 inline-block text-[10px] text-[var(--status-info)] underline">Open exact {leg.platform} market</a>}
                  </div>)}
                </div>
                <div className="mt-2 rounded-lg border border-[var(--border-subtle)] p-3 text-[10px]"><strong className="text-[var(--text-primary)]">Reconciliation</strong><div className="mt-1 text-[var(--text-secondary)]">Allocated capital = {formatCents(kalshiCapital)} Kalshi + {formatCents(pmCapital)} Polymarket = {formatCents(position.totalCostCents)}. Combined fees: {formatCents(position.feesCents)}.</div><div className="mt-1 text-[var(--text-secondary)]">{position.status === 'open' ? 'Current executable value = Kalshi bid × filled quantity + Polymarket bid × filled quantity. Current P/L = executable value − allocated capital − fees.' : 'Realized P/L = settlement value − allocated capital − fees.'} P/L % denominator: allocated capital ({formatCents(position.totalCostCents)}).</div><div className={`mt-1 ${balanced ? 'text-[var(--status-positive)]' : 'text-[var(--status-warning)]'}`}>{balanced ? `Balanced: ${INTEGER.format(position.sharesKalshi)} contract${position.sharesKalshi === 1 ? '' : 's'} on each leg.` : `Imbalance: ${INTEGER.format(position.sharesKalshi)} Kalshi vs ${INTEGER.format(position.sharesPm)} Polymarket contracts.`}</div>{missingQuote && <div className="mt-1 text-[var(--status-negative)]">Valuation unavailable: {missingQuote}.</div>}</div>
              </td></tr>}
            </Fragment>;
          })}
        </tbody>
      </table>
      {positions.length === 0 && <div className="py-10 text-center text-sm text-[var(--text-secondary)]">{emptyText}</div>}
    </div>
  </div>;
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

  const toggleExpanded = (id: number) => setExpanded((current) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  });

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
        {([['analytics', 'Positions & P/L'], ['logs', 'Placement attempts'], ['messages', 'Messages']] as const).map(([tab, label]) => <button key={tab} role="tab" aria-selected={view === tab} onClick={() => setView(tab)} className={`min-h-11 rounded-md px-4 text-xs font-semibold ${view === tab ? 'bg-[var(--status-positive)] text-black' : 'text-[var(--text-secondary)]'}`}>{label}</button>)}
      </div>

      {status && <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-panel)] px-3 py-2">
        <div><div className="text-xs font-semibold text-[var(--text-primary)]">Configured opportunities</div><div className="text-[10px] text-[var(--text-secondary)]">Selection rules only; not placement attempts or positions. ROI and profit values are net of trading fees. This does not enable live trading.</div></div>
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

      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
        <MetricCard label="Unrealized" value={formatCents(unrealized, true)} valueClass={pnlClass(unrealized)} />
        <MetricCard label="Realized" value={formatCents(realized, true)} valueClass={pnlClass(realized)} />
        <MetricCard label="Total P&L" value={formatCents(totalPnl, true)} valueClass={pnlClass(totalPnl)} />
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-panel)] px-3 py-2">
        <div><div className="text-sm font-semibold text-[var(--text-primary)]">Placed trades</div><div className="text-[10px] text-[var(--text-secondary)]">Only successful two-leg placements become positions. Attempts and failures are in Placement attempts.</div></div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-workspace)] p-0.5" aria-label="Position status filter">
            {(['all', 'open', 'settled'] as const).map((value) => <button key={value} onClick={() => setFilter(value)} className={`min-h-11 rounded-md px-3 text-xs capitalize ${filter === value ? 'bg-[var(--status-positive)] text-black' : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'}`}>{value}</button>)}
          </div>
          <label className="text-xs text-[var(--text-secondary)]">Sort <select aria-label="Sort positions" value={sortKey} onChange={(event) => changeSort(event.target.value as SortKey)} className="ml-1 min-h-11 rounded-lg border border-[var(--border-strong)] bg-[var(--surface-workspace)] px-2 text-[var(--text-primary)]"><option value="openedAt">Opened</option><option value="pnl">P&amp;L</option><option value="roi">P/L %</option></select></label>
          <button onClick={() => setSortDirection((current) => current === 'asc' ? 'desc' : 'asc')} className="min-h-11 rounded-lg border border-[var(--border-strong)] px-2 text-xs text-[var(--text-secondary)]" aria-label={`Sort ${sortDirection === 'asc' ? 'descending' : 'ascending'}`}>{sortDirection === 'asc' ? '↑ Asc' : '↓ Desc'}</button>
        </div>
      </div>

      {filter !== 'settled' && <PositionTable title="Open positions" description="Successfully placed trades valued at executable venue bids; expand to reconcile both legs." positions={sortedPositions.filter((position) => position.status === 'open')} kind="open" expanded={expanded} onToggle={toggleExpanded} />}
      {filter !== 'open' && <PositionTable title="Completed / settled trades" description="Final settlement value and realized P/L; these values are not presented as current executable quotes." positions={sortedPositions.filter((position) => position.status !== 'open')} kind="completed" expanded={expanded} onToggle={toggleExpanded} />}

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
