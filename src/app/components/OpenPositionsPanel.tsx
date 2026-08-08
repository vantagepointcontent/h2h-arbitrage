'use client';

/* Open Positions panel — live positions management with Exit button.
 *
 * Fetches from /api/positions, pairs arb legs, shows current ROI,
 * and allows closing both legs simultaneously via SELL orders.
 */

import React, { useEffect, useState, useCallback, useRef, useMemo } from 'react';
import {
  Loader2, RefreshCw, TrendingUp, TrendingDown, X, AlertTriangle,
  LogOut, ArrowUpDown, ArrowUp, ArrowDown, Wallet,
} from 'lucide-react';
import { PlatformIcon } from '@/lib/platforms/PlatformIcon';
import { DataTable, EmptyState, Metric } from '@/components/ui';

// ── Fee helpers (client-safe, mirrors matcher.ts server-side math) ──

/** Kalshi fee: round up to nearest cent. Default taker rate 0.07. */
function calcKalshiExitFee(contracts: number, price: number, rate = 0.07): number {
  if (contracts <= 0 || price <= 0 || price >= 1) return 0;
  const raw = rate * contracts * price * (1 - price);
  return Math.ceil(raw * 100) / 100;
}

/** Polymarket fee: theta * contracts * price * (1 - price). Rounded to 5 decimals. */
function calcPmExitFee(contracts: number, price: number, theta = 0.05): number {
  if (contracts <= 0 || price <= 0 || price >= 1) return 0;
  const raw = theta * contracts * price * (1 - price);
  return Math.round(raw * 100000) / 100000;
}

/** Compute exit fees for a pair. SELL orders pay fees on both legs. */
function computeExitFees(pair: PairedPosition): { kalshiFee: number; pmFee: number; totalFees: number } {
  let kalshiFee = 0;
  let pmFee = 0;

  if (pair.kalshi) {
    const contracts = Math.floor(pair.kalshi.size);
    const price = pair.kalshi.currentPrice;
    kalshiFee = calcKalshiExitFee(contracts, price);
  }

  if (pair.polymarket) {
    const contracts = Math.floor(pair.polymarket.size);
    const price = pair.polymarket.currentPrice;
    // Default theta 0.05 — same as matcher.ts default for 'other' category
    pmFee = calcPmExitFee(contracts, price, 0.05);
  }

  return { kalshiFee, pmFee, totalFees: kalshiFee + pmFee };
}

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
  feesPaid: number;
  netUnrealizedPnl: number;
  netRoiPct: number;
  exitFees: number;
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
  feesPaid: number;
  netCashPnl: number;
  netPercentPnl: number;
  exitFees: number;
}

interface LegBreakdown {
  platform: string;
  side: string;
  entryPrice: number;
  currentPrice: number;
  size: number;
  grossPnl: number;
  feesPaid: number;
  exitFees: number;
  netPnl: number;
  roiPct: number;
}

interface RoiBreakdown {
  legA: LegBreakdown | null;
  legB: LegBreakdown | null;
  totalGrossPnl: number;
  totalFees: number;
  totalNetPnl: number;
  totalRoiPct: number;
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
  netExitValue: number;
  oneLegExposure: number;
  exitLiquidityRisk: 'unverified';
  attentionReasons: string[];
  quoteTimestamps: { kalshi: string | null; polymarket: string | null };
}

interface PositionsResponse {
  success: boolean;
  positions: PairedPosition[];
  errors: { kalshi?: string | null; polymarket?: string | null };
}

const fmtUsd = (n: number) => `$${n.toFixed(2)}`;
const fmtPct = (n: number) => `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`;
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

export default function OpenPositionsPanel() {
  const [positions, setPositions] = useState<PairedPosition[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [platformErrors, setPlatformErrors] = useState<{ kalshi?: string; polymarket?: string }>({});
  const [sortField, setSortField] = useState<SortField>('market');
  const [sortDir, setSortDir] = useState<SortDir>('asc');
  const [exiting, setExiting] = useState<string | null>(null);
  const [exitResult, setExitResult] = useState<{ id: string; success: boolean; pnl?: number; error?: string } | null>(null);
  const [confirmExit, setConfirmExit] = useState<PairedPosition | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch('/api/positions', { cache: 'no-store' });
      const data: PositionsResponse = await res.json();
      if (!data.success) throw new Error('Failed to load positions');
      setPositions(data.positions || []);
      setPlatformErrors(data.errors || {});
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
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

  const SortIcon = ({ field }: { field: SortField }) => {
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
      const fees = computeExitFees(pair);
      const body: any = { action: 'exit', pairId: pair.id };
      if (pair.kalshi) {
        body.kalshi = {
          ticker: pair.kalshi.ticker,
          side: pair.kalshi.side,
          size: pair.kalshi.size,
          // Sell at current bid (price to sell immediately)
          priceCents: Math.round(
            (pair.kalshi.side === 'YES' ? pair.kalshi.currentPrice : pair.kalshi.currentPrice) * 100
          ),
          unrealizedPnl: pair.kalshi.unrealizedPnl,
          title: pair.kalshi.title,
          // Closed-position bookkeeping:
          entryPrice: pair.kalshi.entryPrice,
          exitPrice: pair.kalshi.currentPrice,
          totalCost: pair.kalshi.totalCost,
          feesPaid: pair.kalshi.feesPaid,
          exitFees: fees.kalshiFee,
        };
      }
      if (pair.polymarket) {
        body.polymarket = {
          asset: pair.polymarket.asset,
          conditionId: pair.polymarket.conditionId,
          outcome: pair.polymarket.outcome,
          side: pair.polymarket.side,
          size: pair.polymarket.size,
          // Sell at current price
          price: pair.polymarket.currentPrice,
          cashPnl: pair.polymarket.cashPnl,
          title: pair.polymarket.title,
          // Closed-position bookkeeping:
          entryPrice: pair.polymarket.entryPrice,
          exitPrice: pair.polymarket.currentPrice,
          totalCost: pair.polymarket.initialValue,
          feesPaid: pair.polymarket.feesPaid,
          exitFees: fees.pmFee,
        };
      }

      const res = await fetch('/api/positions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!data.success && !data.partialFill) {
        throw new Error(data.error || 'Exit failed');
      }
      setExitResult({
        id: pair.id,
        success: data.success,
        pnl: pair.totalUnrealizedPnl,
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
        <div className={`p-3 rounded-lg border text-sm flex items-center gap-2 ${
          exitResult.success
            ? 'border-[var(--status-positive)]/30 bg-[var(--status-positive)]/10 text-[var(--status-positive)]'
            : 'border-[var(--status-negative)]/30 bg-[var(--status-negative)]/10 text-[var(--status-negative)]'
        }`}>
          {exitResult.success ? (
            <>
              <TrendingUp className="w-4 h-4" />
              Position closed. Realized P&L: {fmtUsd(exitResult.pnl ?? 0)}
            </>
          ) : (
            <>
              <AlertTriangle className="w-4 h-4" />
              Exit failed: {exitResult.error}
            </>
          )}
          <button onClick={() => setExitResult(null)} className="ml-auto text-xs opacity-60 hover:opacity-100">
            dismiss
          </button>
        </div>
      )}

      {/* Summary cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Metric className="rounded-[var(--radius-panel)] border border-[var(--border-subtle)] bg-[var(--surface-panel)] p-3" label="Open positions" value={positions.length} hint={pairedCount > 0 ? `${pairedCount} arb pairs` : undefined} />
        <Metric className="rounded-[var(--radius-panel)] border border-[var(--border-subtle)] bg-[var(--surface-panel)] p-3" label="Total value" value={fmtUsd(totalValue)} />
        <Metric className="rounded-[var(--radius-panel)] border border-[var(--border-subtle)] bg-[var(--surface-panel)] p-3" label="Total cost" value={fmtUsd(totalCost)} />
        <Metric className="rounded-[var(--radius-panel)] border border-[var(--border-subtle)] bg-[var(--surface-panel)] p-3" label="Unrealized P&L" value={fmtUsd(totalPnl)} hint={fmtPct(totalRoi)} tone={totalPnl >= 0 ? 'positive' : 'negative'} />
      </div>

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
                <th className="text-left px-4 py-3 font-medium cursor-pointer hover:text-[var(--text-primary)]" onClick={() => toggleSort('market')}>
                  Market <SortIcon field="market" />
                </th>
                <th className="text-left px-4 py-3 font-medium">Pair state</th>
                <th className="text-left px-4 py-3 font-medium">Platform</th>
                <th className="text-left px-4 py-3 font-medium">Side</th>
                <th className="text-right px-4 py-3 font-medium cursor-pointer hover:text-[var(--text-primary)]" onClick={() => toggleSort('size')}>
                  Size <SortIcon field="size" />
                </th>
                <th className="text-right px-4 py-3 font-medium">Entry</th>
                <th className="text-right px-4 py-3 font-medium">Current</th>
                <th className="text-right px-4 py-3 font-medium cursor-pointer hover:text-[var(--text-primary)]" onClick={() => toggleSort('value')}>
                  Value <SortIcon field="value" />
                </th>
                <th className="text-right px-4 py-3 font-medium cursor-pointer hover:text-[var(--text-primary)]" onClick={() => toggleSort('roi')}>
                  Net P&amp;L <SortIcon field="roi" />
                </th>
                <th className="text-right px-4 py-3 font-medium">Expiry</th>
                <th className="text-right px-4 py-3 font-medium">Quote age</th>
                <th className="text-right px-4 py-3 font-medium">1-leg exposure</th>
                <th className="text-left px-4 py-3 font-medium">Exit depth</th>
                <th className="text-center px-4 py-3 font-medium">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--border-subtle)]">
              {sorted.map(pair => {
                const legs = [
                  pair.kalshi ? { platform: 'Kalshi' as const, side: pair.kalshi.side, size: pair.kalshi.size, entry: pair.kalshi.entryPrice, current: pair.kalshi.currentPrice, value: pair.kalshi.currentValue, pnl: pair.kalshi.unrealizedPnl, roi: pair.kalshi.roiPct } : null,
                  pair.polymarket ? { platform: 'Polymarket' as const, side: pair.polymarket.side, size: pair.polymarket.size, entry: pair.polymarket.entryPrice, current: pair.polymarket.currentPrice, value: pair.polymarket.currentValue, pnl: pair.polymarket.cashPnl, roi: pair.polymarket.percentPnl } : null,
                ].filter(Boolean) as { platform: string; side: string; size: number; entry: number; current: number; value: number; pnl: number; roi: number }[];

                const isPaired = pair.kalshi && pair.polymarket;
                const rowSpan = legs.length;

                return legs.map((leg, i) => {
                  // Per-leg net ROI from the breakdown object
                  const legBreakdown = i === 0 ? pair.breakdown.legA : pair.breakdown.legB;
                  const legRoiPct = legBreakdown?.roiPct ?? leg.roi;

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
                          pair.breakdown.totalNetPnl >= 0 ? 'text-[var(--status-positive)]' : 'text-[var(--status-negative)]'
                        }`}>
                          <div className="flex flex-col items-end group/roi relative cursor-help">
                            <span>{fmtUsd(pair.breakdown.totalNetPnl)}</span>
                            <span className="text-[10px] font-normal opacity-80">{fmtPct(pair.totalRoiPct)}</span>
                            {/* Tooltip: breakdown on hover */}
                            <div className="absolute right-full top-0 mr-2 z-20 hidden group-hover/roi:block w-64 rounded-lg border border-[var(--border-strong)] bg-[var(--surface-workspace)] p-3 shadow-xl text-left whitespace-normal">
                              <div className="text-[10px] uppercase text-[var(--text-secondary)] mb-2 font-semibold">ROI Breakdown (net of fees)</div>
                              {pair.breakdown.legA && (
                                <div className="space-y-0.5 mb-2">
                                  <div className="text-[10px] text-[var(--status-positive)] font-medium">Leg A — {pair.breakdown.legA.platform} {pair.breakdown.legA.side}</div>
                                  <div className="flex justify-between text-[10px] text-[var(--text-secondary)] pl-2">
                                    <span>Gross P&L</span>
                                    <span className={pair.breakdown.legA.grossPnl >= 0 ? 'text-[var(--status-positive)]' : 'text-[var(--status-negative)]'}>{fmtUsd(pair.breakdown.legA.grossPnl)}</span>
                                  </div>
                                  <div className="flex justify-between text-[10px] text-[var(--text-faint)] pl-2">
                                    <span>Entry fee</span>
                                    <span>−{fmtUsd(pair.breakdown.legA.feesPaid)}</span>
                                  </div>
                                  <div className="flex justify-between text-[10px] text-[var(--text-faint)] pl-2">
                                    <span>Exit fee</span>
                                    <span>−{fmtUsd(pair.breakdown.legA.exitFees)}</span>
                                  </div>
                                  <div className="flex justify-between text-[10px] pl-2 font-medium">
                                    <span className="text-[var(--text-secondary)]">Net P&L</span>
                                    <span className={pair.breakdown.legA.netPnl >= 0 ? 'text-[var(--status-positive)]' : 'text-[var(--status-negative)]'}>{fmtUsd(pair.breakdown.legA.netPnl)}</span>
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
                                    <span>−{fmtUsd(pair.breakdown.legB.feesPaid)}</span>
                                  </div>
                                  <div className="flex justify-between text-[10px] text-[var(--text-faint)] pl-2">
                                    <span>Exit fee</span>
                                    <span>−{fmtUsd(pair.breakdown.legB.exitFees)}</span>
                                  </div>
                                  <div className="flex justify-between text-[10px] pl-2 font-medium">
                                    <span className="text-[var(--text-secondary)]">Net P&L</span>
                                    <span className={pair.breakdown.legB.netPnl >= 0 ? 'text-[var(--status-positive)]' : 'text-[var(--status-negative)]'}>{fmtUsd(pair.breakdown.legB.netPnl)}</span>
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
                                  <span className="text-[var(--status-negative)]">−{fmtUsd(pair.breakdown.totalFees)}</span>
                                </div>
                                <div className="flex justify-between text-[10px] font-bold">
                                  <span className="text-[var(--text-primary)]">Total net P&L</span>
                                  <span className={pair.breakdown.totalNetPnl >= 0 ? 'text-[var(--status-positive)]' : 'text-[var(--status-negative)]'}>{fmtUsd(pair.breakdown.totalNetPnl)}</span>
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
        const fees = computeExitFees(confirmExit);
        const netPnl = confirmExit.totalUnrealizedPnl - fees.totalFees;
        const netRoi = confirmExit.totalCost > 0 ? (netPnl / confirmExit.totalCost) * 100 : 0;
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
                  <span className="text-[var(--text-faint)]"> — fee: {fmtUsd(fees.kalshiFee)}</span>
                </div>
              )}
              {confirmExit.polymarket && (
                <div>
                  Polymarket: Sell {confirmExit.polymarket.size} {confirmExit.polymarket.outcome} @ {fmtPrice(confirmExit.polymarket.currentPrice)}
                  <span className="text-[var(--text-faint)]"> — fee: {fmtUsd(fees.pmFee)}</span>
                </div>
              )}
            </div>
            {/* P&L + fees summary */}
            <div className="rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-workspace)] p-3 space-y-1.5 text-xs">
              <div className="flex justify-between">
                <span className="text-[var(--text-secondary)]">Unrealized P&L (gross)</span>
                <span className={confirmExit.totalUnrealizedPnl >= 0 ? 'text-[var(--status-positive)]' : 'text-[var(--status-negative)]'}>
                  {fmtUsd(confirmExit.totalUnrealizedPnl)}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-[var(--text-secondary)]">Exit fees</span>
                <span className="text-[var(--status-negative)]">−{fmtUsd(fees.totalFees)}</span>
              </div>
              {fees.kalshiFee > 0 && (
                <div className="flex justify-between pl-3 text-[10px] text-[var(--text-faint)]">
                  <span>Kalshi fee (7%)</span>
                  <span>{fmtUsd(fees.kalshiFee)}</span>
                </div>
              )}
              {fees.pmFee > 0 && (
                <div className="flex justify-between pl-3 text-[10px] text-[var(--text-faint)]">
                  <span>Polymarket fee (θ=0.05)</span>
                  <span>{fmtUsd(fees.pmFee)}</span>
                </div>
              )}
              <div className="border-t border-[var(--border-subtle)] pt-1.5 flex justify-between font-bold">
                <span className="text-[var(--text-primary)]">Expected net P&L</span>
                <span className={netPnl >= 0 ? 'text-[var(--status-positive)]' : 'text-[var(--status-negative)]'}>
                  {fmtUsd(netPnl)}
                  <span className="ml-1 text-[10px] font-normal opacity-80">({fmtPct(netRoi)})</span>
                </span>
              </div>
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