'use client';

/* Open Positions panel — live positions management with Exit button.
 *
 * Fetches from /api/positions, pairs arb legs, shows current ROI,
 * and allows closing both legs simultaneously via SELL orders.
 */

import React, { useEffect, useState, useCallback, useRef } from 'react';
import {
  Loader2, RefreshCw, TrendingUp, AlertTriangle,
  LogOut, ArrowUpDown, ArrowUp, ArrowDown, Wallet,
} from 'lucide-react';
import { PlatformIcon } from '@/lib/platforms/PlatformIcon';
import { DataTable, EmptyState, Metric } from '@/components/ui';
import { Cell, Legend, Pie, PieChart, ResponsiveContainer, Tooltip } from 'recharts';
import { CalculationProvenance } from './CalculationProvenance';
import { parseCalculationEnvelope, type CalculationEnvelope } from '@/lib/calculation-envelope';

// ── Types ──

interface KalshiPositionDto {
  platform: 'kalshi';
  ticker: string;
  title: string;
  eventTicker: string;
  side: 'YES' | 'NO';
  position: number;
  size: number;
  entryPrice: number;
  currentPrice: number;
  currentValue: number;
  totalCost: number;
  unrealizedPnl: number;
  roiPct: number;
  realizedPnl: number;
  lastPrice: number;
  feesPaid: number | null;
  netUnrealizedPnl: number | null;
  netRoiPct: number | null;
  exitFees: number | null;
}

interface PmPositionDto {
  platform: 'polymarket';
  asset: string;
  conditionId: string;
  title: string;
  slug: string;
  outcome: string;
  side: 'YES' | 'NO';
  size: number;
  entryPrice: number;
  currentPrice: number;
  currentValue: number;
  initialValue: number;
  cashPnl: number;
  percentPnl: number;
  endDate: string;
  negativeRisk: boolean;
  feesPaid: number | null;
  netCashPnl: number | null;
  netPercentPnl: number | null;
  exitFees: number | null;
}

interface LegBreakdown {
  platform: string;
  side: string;
  entryPrice: number;
  currentPrice: number;
  size: number;
  grossPnl: number;
  feesPaid: number | null;
  exitFees: number | null;
  netPnl: number | null;
  roiPct: number | null;
}

interface RoiBreakdown {
  legA: LegBreakdown | null;
  legB: LegBreakdown | null;
  totalGrossPnl: number;
  totalFees: number | null;
  totalNetPnl: number | null;
  totalRoiPct: number | null;
}

interface PairedPosition {
  id: string;
  marketTitle: string;
  kalshi: KalshiPositionDto | null;
  polymarket: PmPositionDto | null;
  totalValue: number;
  totalCost: number;
  totalUnrealizedPnl: number;
  totalRoiPct: number;
  breakdown: RoiBreakdown;
  pairedState: 'paired' | 'unpaired';
  expiry: string | null;
  netExitValue: number | null;
  oneLegExposure: number;
  exitLiquidityRisk: 'unverified';
  attentionReasons: string[];
  quoteTimestamps: { kalshi: string | null; polymarket: string | null };
  calculationEnvelope?: CalculationEnvelope;
}

interface PositionsResponse {
  success: boolean;
  positions: PairedPosition[];
  errors: { kalshi?: string | null; polymarket?: string | null };
  cash?: { kalshi: number | null; polymarket: number | null; total: number; complete: boolean };
}

const fmtUsd = (n: number | null) => n == null ? 'Unavailable' : `$${n.toFixed(2)}`;
const fmtPct = (n: number | null) => n == null ? 'Unavailable' : `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`;
const fmtFee = (n: number | null) => n == null ? 'Unavailable' : `−${fmtUsd(n)}`;
const fmtPrice = (n: number) => `${(n * 100).toFixed(1)}¢`;
const fmtExpiry = (value: string | null) => {
  if (!value) return 'Unknown';
  const ms = new Date(value).getTime() - Date.now();
  if (ms <= 0) return 'Expired';
  const hours = Math.floor(ms / 3_600_000);
  return hours < 48 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
};
const fmtAge = (value: string | null) => value ? `${Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 1000))}s` : '—';

type SortField = 'market' | 'roi' | 'value' | 'size';
type SortDir = 'asc' | 'desc';

export function buildPortfolioAllocation(
  positions: Array<Pick<PairedPosition, 'marketTitle' | 'totalValue'>>,
  cashUsd: number,
) {
  const values = [
    ...positions.filter(position => position.totalValue > 0).map(position => ({ name: position.marketTitle, value: position.totalValue, kind: 'position' as const })),
    { name: 'Cash', value: Math.max(0, cashUsd), kind: 'cash' as const },
  ];
  const total = values.reduce((sum, item) => sum + item.value, 0);
  return values.map(item => ({ ...item, percentage: total > 0 ? (item.value / total) * 100 : 0 }));
}

export default function OpenPositionsPanel() {
  const [positions, setPositions] = useState<PairedPosition[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [platformErrors, setPlatformErrors] = useState<{ kalshi?: string; polymarket?: string }>({});
  const [cash, setCash] = useState({ kalshi: null as number | null, polymarket: null as number | null, total: 0, complete: false });
  const [sortField, setSortField] = useState<SortField>('market');
  const [sortDir, setSortDir] = useState<SortDir>('asc');
  const [exiting, setExiting] = useState<string | null>(null);
  const [exitResult, setExitResult] = useState<{ id: string; success: boolean; envelope?: CalculationEnvelope; error?: string } | null>(null);
  const [confirmExit, setConfirmExit] = useState<PairedPosition | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/positions', { cache: 'no-store' });
      const data: PositionsResponse = await res.json();
      if (!data.success) throw new Error('Failed to load positions');
      const nextPositions = data.positions || [];
      const fetchErrors = Object.values(data.errors || {}).filter(Boolean);
      if (nextPositions.length === 0 && fetchErrors.length > 0) {
        throw new Error(fetchErrors.join('; '));
      }
      setPositions(nextPositions);
      setCash(data.cash ?? { kalshi: null, polymarket: null, total: 0, complete: false });
      setPlatformErrors({
        kalshi: data.errors?.kalshi || undefined,
        polymarket: data.errors?.polymarket || undefined,
      });
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- data-fetch effect guarded by poll interval
    load();
    // Poll every 30s
    pollRef.current = setInterval(load, 30_000);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [load]);

  const sorted = [...positions].sort((a, b) => {
    let cmp = 0;
    switch (sortField) {
      case 'market':
        cmp = a.marketTitle.localeCompare(b.marketTitle);
        break;
      case 'roi':
        cmp = a.totalRoiPct - b.totalRoiPct;
        break;
      case 'value':
        cmp = a.totalValue - b.totalValue;
        break;
      case 'size':
        cmp = (a.kalshi?.size ?? 0) + (a.polymarket?.size ?? 0) - ((b.kalshi?.size ?? 0) + (b.polymarket?.size ?? 0));
        break;
    }
    return sortDir === 'asc' ? cmp : -cmp;
  });

  const toggleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    } else {
      setSortField(field);
      setSortDir('asc');
    }
  };

  const renderSortIcon = (field: SortField) => {
    if (sortField !== field) return <ArrowUpDown className="w-3 h-3 inline opacity-30" />;
    return sortDir === 'asc'
      ? <ArrowUp className="w-3 h-3 inline" />
      : <ArrowDown className="w-3 h-3 inline" />;
  };

  const handleExit = async (pair: PairedPosition) => {
    setConfirmExit(null);
    setExiting(pair.id);
    setExitResult(null);
    try {
      const res = await fetch('/api/positions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'exit', pairId: pair.id }),
      });
      const data = await res.json();
      if (!data.success && !data.partialFill) {
        throw new Error(data.error || 'Exit failed');
      }
      setExitResult({
        id: pair.id,
        success: data.success,
        envelope: parseCalculationEnvelope(data.calculationEnvelope, `exit position ${pair.id}`),
        error: data.errors ? Object.values(data.errors).filter(Boolean).join('; ') : undefined,
      });
      // Refresh positions after exit
      await load();
    } catch (e: any) {
      setExitResult({ id: pair.id, success: false, error: e.message });
    } finally {
      setExiting(null);
    }
  };

  const totalValue = positions.reduce((s, p) => s + p.totalValue, 0);
  const totalCost = positions.reduce((s, p) => s + p.totalCost, 0);
  const totalPnl = positions.reduce((s, p) => s + p.totalUnrealizedPnl, 0);
  const totalRoi = totalCost > 0 ? (totalPnl / totalCost) * 100 : 0;
  const pairedCount = positions.filter(p => p.kalshi && p.polymarket).length;
  const allocationData = buildPortfolioAllocation(positions, cash.total);
  const totalPortfolioValue = totalValue + cash.total;
  const allocationColors = ['var(--status-positive)', 'var(--platform-polymarket)', 'var(--status-warning)', 'var(--accent-primary)', 'var(--status-negative)', 'var(--text-secondary)'];

  if (loading) {
    return <div role="status" className="flex items-center justify-center gap-2 py-12 text-sm text-[var(--text-secondary)]"><Loader2 className="h-4 w-4 animate-spin" /> Loading positions…</div>;
  }

  if (error) {
    return <div role="alert" className="rounded-xl border border-[var(--status-negative)]/30 bg-[var(--status-negative)]/5 p-6 text-center"><AlertTriangle className="mx-auto h-5 w-5 text-[var(--status-negative)]" /><p className="mt-2 text-sm font-semibold text-[var(--text-primary)]">Failed to load positions</p><p className="mt-1 text-xs text-[var(--text-secondary)]">{error}</p><button type="button" onClick={() => void load()} className="mt-4 inline-flex items-center gap-2 rounded-lg border border-[var(--border-subtle)] px-3 py-2 text-xs font-semibold text-[var(--text-primary)] hover:bg-[var(--surface-muted)]"><RefreshCw className="h-3.5 w-3.5" /> Retry</button></div>;
  }

  return (
    <div className="space-y-4">
      {/* Platform errors */}
      {(platformErrors.kalshi || platformErrors.polymarket) && (
        <div className="p-3 rounded-lg border border-amber-800 bg-amber-950/30 text-amber-400 text-xs flex items-center gap-2">
          <AlertTriangle className="w-4 h-4 shrink-0" />
          <div className="space-y-0.5">
            {platformErrors.kalshi && <div>Kalshi: {platformErrors.kalshi}</div>}
            {platformErrors.polymarket && <div>Polymarket: {platformErrors.polymarket}</div>}
          </div>
          <span className="ml-auto text-[10px] text-amber-600">Positions may be incomplete</span>
        </div>
      )}

      {!loading && (
        <section aria-label="Position attention queue" className="rounded-[var(--radius-panel)] border border-[var(--border-subtle)] bg-[var(--surface-panel)] p-4">
          <div className="mb-3 flex items-center justify-between gap-3">
            <h3 className="flex items-center gap-2 text-sm font-semibold"><AlertTriangle className="h-4 w-4 text-[var(--status-warning)]" /> Position attention</h3>
            <span className="text-xs text-[var(--text-secondary)]">{positions.filter(position => position.attentionReasons.some(reason => reason !== 'Exit depth unverified')).length} requiring action</span>
          </div>
          {positions.some(position => position.attentionReasons.some(reason => reason !== 'Exit depth unverified')) ? (
            <div className="space-y-2">
              {positions.filter(position => position.attentionReasons.some(reason => reason !== 'Exit depth unverified')).map(position => (
                <div key={position.id} className="flex flex-col gap-1 rounded-lg border border-[var(--status-warning)]/25 bg-[var(--status-warning)]/5 px-3 py-2 sm:flex-row sm:items-center sm:justify-between">
                  <span className="truncate text-xs font-medium text-[var(--text-primary)]">{position.marketTitle}</span>
                  <span className="text-xs text-[var(--status-warning)]">{position.attentionReasons.filter(reason => reason !== 'Exit depth unverified').join(' · ')}</span>
                </div>
              ))}
            </div>
          ) : <p className="text-xs text-[var(--text-secondary)]">No position risk requires action. Exit depth remains explicitly unverified until venue depth is available.</p>}
        </section>
      )}

      {/* Exit result toast */}
      {exitResult && (
        <div className={`space-y-2 rounded-lg border p-3 text-sm ${
          exitResult.success
            ? 'border-[var(--status-positive)]/30 bg-[var(--status-positive)]/10 text-[var(--status-positive)]'
            : 'border-[var(--status-negative)]/30 bg-[var(--status-negative)]/10 text-[var(--status-negative)]'
        }`}>
          {exitResult.success ? (
            <>
              <TrendingUp className="w-4 h-4" />
              <span>Position exit submitted. Canonical net P&amp;L: {fmtUsd(exitResult.envelope?.totals.netPnlMicros == null ? null : exitResult.envelope.totals.netPnlMicros / 1_000_000)}</span>
            </>
          ) : (
            <>
              <AlertTriangle className="w-4 h-4" />
              Exit failed: {exitResult.error}
            </>
          )}
          {exitResult.envelope && <CalculationProvenance envelope={exitResult.envelope} />}
          <button onClick={() => setExitResult(null)} className="text-xs opacity-60 hover:opacity-100">
            dismiss
          </button>
        </div>
      )}

      {/* Summary cards */}
      <section aria-label="Portfolio allocation" className="rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-panel)] p-4">
        <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
          <div><h3 className="text-sm font-semibold text-[var(--text-primary)]">Portfolio allocation</h3><p className="text-xs text-[var(--text-secondary)]">Open positions and available cash · total {fmtUsd(totalPortfolioValue)}</p></div>
          {!cash.complete && <span className="rounded bg-[var(--status-warning)]/10 px-2 py-1 text-[10px] text-[var(--status-warning)]">Cash is partial until both accounts connect</span>}
        </div>
        {totalPortfolioValue > 0 ? <div className="h-80 w-full" data-testid="portfolio-allocation-chart">
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <Pie data={allocationData} dataKey="value" nameKey="name" cx="50%" cy="46%" outerRadius="75%" labelLine={false} label={({ name, percentage }: any) => `${name === 'Cash' ? 'Cash' : String(name).slice(0, 18)} ${Number(percentage || 0).toFixed(1)}%`}>
                {allocationData.map((entry, index) => <Cell key={`${entry.name}-${index}`} fill={entry.kind === 'cash' ? 'var(--text-muted)' : allocationColors[index % allocationColors.length]} />)}
              </Pie>
              <Tooltip formatter={(value: any, name: any) => [fmtUsd(Number(value)), String(name)]} contentStyle={{ background: 'var(--surface-workspace)', border: '1px solid var(--border-strong)', borderRadius: 8 }} />
              <Legend formatter={(value) => String(value)} />
            </PieChart>
          </ResponsiveContainer>
        </div> : <div className="py-10 text-center text-sm text-[var(--text-secondary)]">No positions or cash balance available.</div>}
      </section>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Metric className="rounded-[var(--radius-panel)] border border-[var(--border-subtle)] bg-[var(--surface-panel)] p-3" label="Open positions" value={positions.length} hint={pairedCount > 0 ? `${pairedCount} arb pairs` : undefined} />
        <Metric className="rounded-[var(--radius-panel)] border border-[var(--border-subtle)] bg-[var(--surface-panel)] p-3" label="Total value" value={fmtUsd(totalValue)} />
        <Metric className="rounded-[var(--radius-panel)] border border-[var(--border-subtle)] bg-[var(--surface-panel)] p-3" label="Total cost" value={fmtUsd(totalCost)} />
        <Metric className="rounded-[var(--radius-panel)] border border-[var(--border-subtle)] bg-[var(--surface-panel)] p-3" label="Gross unrealized P&L" value={fmtUsd(totalPnl)} hint={fmtPct(totalRoi)} tone={totalPnl >= 0 ? 'positive' : 'negative'} />
      </div>

      {sorted.length > 0 && (
        <section aria-label="Position calculation provenance" className="space-y-2 rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-panel)] p-3">
          <h3 className="text-xs font-semibold text-[var(--text-primary)]">Canonical fee and P&amp;L provenance</h3>
          {sorted.map((position) => (
            <div key={position.id}>
              <div className="mb-1 truncate text-[10px] font-medium text-[var(--text-secondary)]">{position.marketTitle}</div>
              <CalculationProvenance envelope={parseCalculationEnvelope(position.calculationEnvelope, `account position ${position.id}`)} compact />
            </div>
          ))}
        </section>
      )}

      {/* Positions table */}
      {loading ? (
        <div className="flex items-center gap-2 text-sm text-[var(--text-secondary)] py-8 justify-center">
          <Loader2 className="w-4 h-4 animate-spin" /> Loading positions…
        </div>
      ) : sorted.length === 0 ? (
        <EmptyState icon={<Wallet className="h-8 w-8" />} title="No open positions" description="Live positions from connected platform accounts will appear here." />
      ) : (
        <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-panel)] overflow-x-auto">
          <DataTable aria-label="Open positions">
            <thead>
              <tr className="text-[10px] uppercase text-[var(--text-secondary)] border-b border-[var(--border-subtle)]">
                <th title="Market event name; click to sort" className="text-left px-4 py-3 font-medium cursor-pointer hover:text-[var(--text-primary)]" onClick={() => toggleSort('market')}>
                  Market {renderSortIcon('market')}
                </th>
                <th title="Whether both arb legs are paired and hedged" className="text-left px-4 py-3 font-medium">Pair state</th>
                <th title="Kalshi or Polymarket execution venue" className="text-left px-4 py-3 font-medium">Platform</th>
                <th title="YES or NO contract side" className="text-left px-4 py-3 font-medium">Side</th>
                <th title="Number of shares or contracts; click to sort" className="text-right px-4 py-3 font-medium cursor-pointer hover:text-[var(--text-primary)]" onClick={() => toggleSort('size')}>
                  Size {renderSortIcon('size')}
                </th>
                <th title="Average price paid when opening the position" className="text-right px-4 py-3 font-medium">Entry</th>
                <th title="Latest available market price" className="text-right px-4 py-3 font-medium">Current</th>
                <th title="Current dollar value; click to sort" className="text-right px-4 py-3 font-medium cursor-pointer hover:text-[var(--text-primary)]" onClick={() => toggleSort('value')}>
                  Value {renderSortIcon('value')}
                </th>
                <th title="Gross unrealized profit or loss; canonical net P&L remains unavailable until charged exit fees arrive" className="text-right px-4 py-3 font-medium cursor-pointer hover:text-[var(--text-primary)]" onClick={() => toggleSort('roi')}>
                  Gross P&amp;L {renderSortIcon('roi')}
                </th>
                <th title="Time remaining until the market resolves" className="text-right px-4 py-3 font-medium">Expiry</th>
                <th title="Age of the latest price used for valuation" className="text-right px-4 py-3 font-medium">Quote age</th>
                <th title="Unhedged dollar exposure if the matching leg is missing" className="text-right px-4 py-3 font-medium">1-leg exposure</th>
                <th title="Available orderbook liquidity for closing the position" className="text-left px-4 py-3 font-medium">Exit depth</th>
                <th title="Available position actions" className="text-center px-4 py-3 font-medium">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--border-subtle)]">
              {sorted.map(pair => {
                const legs = [
                  pair.kalshi ? { platform: 'Kalshi' as const, side: pair.kalshi.side, size: pair.kalshi.size, entry: pair.kalshi.entryPrice, current: pair.kalshi.currentPrice, value: pair.kalshi.currentValue, pnl: pair.kalshi.unrealizedPnl, roi: pair.kalshi.roiPct } : null,
                  pair.polymarket ? { platform: 'Polymarket' as const, side: pair.polymarket.side, size: pair.polymarket.size, entry: pair.polymarket.entryPrice, current: pair.polymarket.currentPrice, value: pair.polymarket.currentValue, pnl: pair.polymarket.cashPnl, roi: pair.polymarket.percentPnl } : null,
                ].filter(Boolean) as { platform: string; side: string; size: number; entry: number; current: number; value: number; pnl: number; roi: number }[];

                const rowSpan = legs.length;

                return legs.map((leg, i) => {
                  const legRoiPct = leg.roi;

                  return (
                  <tr key={`${pair.id}-${i}`} className="hover:bg-[var(--surface-hover)]/50 transition-colors">
                    {i === 0 && (
                      <td rowSpan={rowSpan} className="px-4 py-3 text-xs text-[var(--text-primary)] max-w-[200px] truncate align-top" title={pair.marketTitle}>
                        {pair.marketTitle}
                      </td>
                    )}
                    {i === 0 && <td rowSpan={rowSpan} className="px-4 py-3 align-top"><span className={`rounded-full px-2 py-1 text-[10px] font-semibold uppercase ${pair.pairedState === 'paired' ? 'bg-[var(--status-positive)]/10 text-[var(--status-positive)]' : 'bg-[var(--status-negative)]/10 text-[var(--status-negative)]'}`}>{pair.pairedState}</span></td>}
                    <td className="px-4 py-3 text-xs whitespace-nowrap">
                      <span className="inline-flex items-center gap-1.5">
                        <PlatformIcon platform={leg.platform} size="sm" />
                        <span className={leg.platform === 'Kalshi' ? 'text-[var(--status-positive)]' : 'text-[var(--platform-polymarket)]'}>
                          {leg.platform}
                        </span>
                      </span>
                    </td>
                    <td className="px-4 py-3 text-xs uppercase">
                      <span className={leg.side === 'YES' ? 'text-[var(--status-positive)]' : 'text-[var(--status-negative)]'}>
                        {leg.side}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-xs text-right text-[var(--text-secondary)] whitespace-nowrap tabular-nums">
                      {leg.size.toFixed(2)}
                    </td>
                    <td className="px-4 py-3 text-xs text-right text-[var(--text-secondary)] whitespace-nowrap tabular-nums">
                      {fmtPrice(leg.entry)}
                    </td>
                    <td className="px-4 py-3 text-xs text-right whitespace-nowrap tabular-nums">
                      <div className="flex flex-col items-end">
                        <span className="text-[var(--text-primary)]">{fmtPrice(leg.current)}</span>
                        <span className={`text-[10px] font-normal ${legRoiPct >= 0 ? 'text-[var(--status-positive)]' : 'text-[var(--status-negative)]'}`}>
                          {fmtPct(legRoiPct)}
                        </span>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-xs text-right text-[var(--text-secondary)] whitespace-nowrap tabular-nums">
                      {fmtUsd(leg.value)}
                    </td>
                    {i === 0 && (
                      <>
                        <td rowSpan={rowSpan} className={`px-4 py-3 text-xs text-right font-bold align-top whitespace-nowrap tabular-nums ${
                          pair.breakdown.totalGrossPnl >= 0 ? 'text-[var(--status-positive)]' : 'text-[var(--status-negative)]'
                        }`}>
                          <div className="flex flex-col items-end group/roi relative cursor-help">
                            <span>{fmtUsd(pair.breakdown.totalGrossPnl)}</span>
                            <span className="text-[10px] font-normal opacity-80">{fmtPct(pair.totalRoiPct)}</span>
                            {/* Tooltip: breakdown on hover */}
                            <div className="absolute right-full top-0 mr-2 z-20 hidden group-hover/roi:block w-64 rounded-lg border border-[var(--border-strong)] bg-[var(--surface-workspace)] p-3 shadow-xl text-left whitespace-normal">
                              <div className="text-[10px] uppercase text-[var(--text-secondary)] mb-2 font-semibold">P&amp;L breakdown · fees fail closed</div>
                              {pair.breakdown.legA && (
                                <div className="space-y-0.5 mb-2">
                                  <div className="text-[10px] text-[var(--status-positive)] font-medium">Leg A — {pair.breakdown.legA.platform} {pair.breakdown.legA.side}</div>
                                  <div className="flex justify-between text-[10px] text-[var(--text-secondary)] pl-2">
                                    <span>Gross P&L</span>
                                    <span className={pair.breakdown.legA.grossPnl >= 0 ? 'text-[var(--status-positive)]' : 'text-[var(--status-negative)]'}>{fmtUsd(pair.breakdown.legA.grossPnl)}</span>
                                  </div>
                                  <div className="flex justify-between text-[10px] text-[var(--text-faint)] pl-2">
                                    <span>Entry fee</span>
                                    <span>{fmtFee(pair.breakdown.legA.feesPaid)}</span>
                                  </div>
                                  <div className="flex justify-between text-[10px] text-[var(--text-faint)] pl-2">
                                    <span>Exit fee</span>
                                    <span>{fmtFee(pair.breakdown.legA.exitFees)}</span>
                                  </div>
                                  <div className="flex justify-between text-[10px] pl-2 font-medium">
                                    <span className="text-[var(--text-secondary)]">Net P&L</span>
                                    <span>{fmtUsd(pair.breakdown.legA.netPnl)}</span>
                                  </div>
                                </div>
                              )}
                              {pair.breakdown.legB && (
                                <div className="space-y-0.5 mb-2">
                                  <div className="text-[10px] text-[var(--platform-polymarket)] font-medium">Leg B — {pair.breakdown.legB.platform} {pair.breakdown.legB.side}</div>
                                  <div className="flex justify-between text-[10px] text-[var(--text-secondary)] pl-2">
                                    <span>Gross P&L</span>
                                    <span className={pair.breakdown.legB.grossPnl >= 0 ? 'text-[var(--status-positive)]' : 'text-[var(--status-negative)]'}>{fmtUsd(pair.breakdown.legB.grossPnl)}</span>
                                  </div>
                                  <div className="flex justify-between text-[10px] text-[var(--text-faint)] pl-2">
                                    <span>Entry fee</span>
                                    <span>{fmtFee(pair.breakdown.legB.feesPaid)}</span>
                                  </div>
                                  <div className="flex justify-between text-[10px] text-[var(--text-faint)] pl-2">
                                    <span>Exit fee</span>
                                    <span>{fmtFee(pair.breakdown.legB.exitFees)}</span>
                                  </div>
                                  <div className="flex justify-between text-[10px] pl-2 font-medium">
                                    <span className="text-[var(--text-secondary)]">Net P&L</span>
                                    <span>{fmtUsd(pair.breakdown.legB.netPnl)}</span>
                                  </div>
                                </div>
                              )}
                              <div className="border-t border-[var(--border-strong)] pt-1.5 space-y-0.5">
                                <div className="flex justify-between text-[10px] text-[var(--text-secondary)]">
                                  <span>Total gross P&L</span>
                                  <span className={pair.breakdown.totalGrossPnl >= 0 ? 'text-[var(--status-positive)]' : 'text-[var(--status-negative)]'}>{fmtUsd(pair.breakdown.totalGrossPnl)}</span>
                                </div>
                                <div className="flex justify-between text-[10px] text-[var(--text-faint)]">
                                  <span>Total fees</span>
                                  <span>{fmtFee(pair.breakdown.totalFees)}</span>
                                </div>
                                <div className="flex justify-between text-[10px] font-bold">
                                  <span className="text-[var(--text-primary)]">Total net P&L</span>
                                  <span>{fmtUsd(pair.breakdown.totalNetPnl)}</span>
                                </div>
                              </div>
                            </div>
                          </div>
                        </td>
                        <td rowSpan={rowSpan} className="px-4 py-3 text-right align-top text-xs text-[var(--text-secondary)]" title={pair.expiry ?? 'Expiry unavailable'}>{fmtExpiry(pair.expiry)}</td>
                        <td rowSpan={rowSpan} className="px-4 py-3 text-right align-top text-xs text-[var(--text-secondary)]">K {fmtAge(pair.quoteTimestamps.kalshi)} · PM {fmtAge(pair.quoteTimestamps.polymarket)}</td>
                        <td rowSpan={rowSpan} className="px-4 py-3 text-right align-top text-xs font-semibold text-[var(--status-warning)] tabular-nums">{fmtUsd(pair.oneLegExposure)}</td>
                        <td rowSpan={rowSpan} className="px-4 py-3 align-top text-xs text-[var(--status-warning)]">Unverified<div className="mt-1 text-[10px] font-normal text-[var(--text-faint)]">Partial exit possible</div></td>
                        <td rowSpan={rowSpan} className="px-4 py-3 text-center align-top">
                          <button
                            onClick={() => setConfirmExit(pair)}
                            disabled={exiting === pair.id}
                            className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-[var(--status-negative)]/10 border border-[var(--status-negative)]/30 text-[var(--status-negative)] text-[10px] font-medium hover:bg-[var(--status-negative)]/20 transition-colors disabled:opacity-50"
                            title="Close both legs"
                          >
                            {exiting === pair.id ? (
                              <><Loader2 className="w-3 h-3 animate-spin" /> Exiting…</>
                            ) : (
                              <><LogOut className="w-3 h-3" /> Exit</>
                            )}
                          </button>
                        </td>
                      </>
                    )}
                  </tr>
                  );
                });
              })}
            </tbody>
          </DataTable>
        </div>
      )}

      {/* Exit confirmation dialog */}
      {confirmExit && (() => {
        const isPaired = !!(confirmExit.kalshi && confirmExit.polymarket);
        const legCount = (confirmExit.kalshi ? 1 : 0) + (confirmExit.polymarket ? 1 : 0);

        return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={() => setConfirmExit(null)}>
          <div
            className="rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-panel)] p-6 max-w-md w-full mx-4 space-y-4"
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-center gap-2">
              <LogOut className="w-5 h-5 text-[var(--status-negative)]" />
              <h3 className="text-sm font-bold text-[var(--text-primary)]">
                Close {isPaired ? 'both positions' : legCount === 1 ? 'position' : 'positions'}?
                <span className={`ml-2 ${confirmExit.totalRoiPct >= 0 ? 'text-[var(--status-positive)]' : 'text-[var(--status-negative)]'}`}>
                  Current ROI: {fmtPct(confirmExit.totalRoiPct)}
                </span>
              </h3>
            </div>
            <div className="text-xs text-[var(--text-secondary)] space-y-1">
              <div>Market: <span className="text-[var(--text-primary)]">{confirmExit.marketTitle}</span></div>
              {confirmExit.kalshi && (
                <div>
                  Kalshi: Sell {confirmExit.kalshi.size} {confirmExit.kalshi.side} @ {fmtPrice(confirmExit.kalshi.currentPrice)}
                </div>
              )}
              {confirmExit.polymarket && (
                <div>
                  Polymarket: Sell {confirmExit.polymarket.size} {confirmExit.polymarket.outcome} @ {fmtPrice(confirmExit.polymarket.currentPrice)}
                </div>
              )}
            </div>
            <CalculationProvenance envelope={parseCalculationEnvelope(confirmExit.calculationEnvelope, `exit position ${confirmExit.id}`)} />
            <div className="rounded-lg border border-[var(--status-warning)]/30 bg-[var(--status-warning)]/5 p-3 text-xs text-[var(--status-warning)]">
              Exit fees and net P&amp;L are not estimated in the browser. The server must return a current charged calculation envelope before those values are authoritative.
            </div>
            <div className="text-[10px] text-amber-400 flex items-center gap-1">
              <AlertTriangle className="w-3 h-3" />
              This will place SELL orders on {isPaired ? 'both platforms' : 'the platform'}. Execution is irreversible.
            </div>
            <div className="flex gap-2 justify-end">
              <button
                onClick={() => setConfirmExit(null)}
                className="px-3 py-1.5 rounded-lg text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)] border border-[var(--border-strong)]"
              >
                Cancel
              </button>
              <button
                onClick={() => handleExit(confirmExit)}
                disabled={exiting === confirmExit.id}
                className="px-3 py-1.5 rounded-lg text-xs font-medium bg-[var(--status-negative)]/20 border border-[var(--status-negative)]/40 text-[var(--status-negative)] hover:bg-[var(--status-negative)]/30 disabled:opacity-50 flex items-center gap-1.5"
              >
                {exiting === confirmExit.id && <Loader2 className="w-3 h-3 animate-spin" />}
                {exiting === confirmExit.id
                  ? 'Executing…'
                  : isPaired
                    ? 'Close both positions'
                    : 'Close position'
                }
              </button>
            </div>
          </div>
        </div>
        );
      })()}
    </div>
  );
}