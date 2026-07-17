'use client';

/* Open Positions panel — live positions management with Exit button.
 *
 * Fetches from /api/positions, pairs arb legs, shows current ROI,
 * and allows closing both legs simultaneously via SELL orders.
 */

import React, { useEffect, useState, useCallback, useRef } from 'react';
import {
  Loader2, RefreshCw, TrendingUp, TrendingDown, X, AlertTriangle,
  LogOut, ArrowUpDown, ArrowUp, ArrowDown, Wallet,
} from 'lucide-react';

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
}

interface PositionsResponse {
  success: boolean;
  positions: PairedPosition[];
  errors: { kalshi?: string | null; polymarket?: string | null };
}

const fmtUsd = (n: number) => `$${n.toFixed(2)}`;
const fmtPct = (n: number) => `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`;
const fmtPrice = (n: number) => `${(n * 100).toFixed(1)}¢`;

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
      const body: any = { action: 'exit' };
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
        };
      }
      if (pair.polymarket) {
        body.polymarket = {
          asset: pair.polymarket.asset,
          conditionId: pair.polymarket.conditionId,
          outcome: pair.polymarket.outcome,
          size: pair.polymarket.size,
          // Sell at current price
          price: pair.polymarket.currentPrice,
          cashPnl: pair.polymarket.cashPnl,
          title: pair.polymarket.title,
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

      {/* Exit result toast */}
      {exitResult && (
        <div className={`p-3 rounded-lg border text-sm flex items-center gap-2 ${
          exitResult.success
            ? 'border-[#5DBE81]/30 bg-[#5DBE81]/10 text-[#5DBE81]'
            : 'border-[#ef4444]/30 bg-[#ef4444]/10 text-[#ef4444]'
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
        <div className="rounded-lg border border-[#182533] bg-[#17212B] p-3">
          <div className="text-[10px] uppercase text-[#8A9BA8]">Open positions</div>
          <div className="text-lg font-bold text-[#FFFFFF]">{positions.length}</div>
          {pairedCount > 0 && (
            <div className="text-[10px] text-[#8A9BA8]">{pairedCount} arb pairs</div>
          )}
        </div>
        <div className="rounded-lg border border-[#182533] bg-[#17212B] p-3">
          <div className="text-[10px] uppercase text-[#8A9BA8]">Total value</div>
          <div className="text-lg font-bold text-[#FFFFFF]">{fmtUsd(totalValue)}</div>
        </div>
        <div className="rounded-lg border border-[#182533] bg-[#17212B] p-3">
          <div className="text-[10px] uppercase text-[#8A9BA8]">Total cost</div>
          <div className="text-lg font-bold text-[#8A9BA8]">{fmtUsd(totalCost)}</div>
        </div>
        <div className="rounded-lg border border-[#182533] bg-[#17212B] p-3">
          <div className="text-[10px] uppercase text-[#8A9BA8]">Unrealized P&L</div>
          <div className={`text-lg font-bold ${totalPnl >= 0 ? 'text-[#5DBE81]' : 'text-[#ef4444]'}`}>
            {fmtUsd(totalPnl)}
          </div>
          <div className={`text-[10px] ${totalRoi >= 0 ? 'text-[#5DBE81]' : 'text-[#ef4444]'}`}>
            {fmtPct(totalRoi)}
          </div>
        </div>
      </div>

      {/* Positions table */}
      {loading ? (
        <div className="flex items-center gap-2 text-sm text-[#8A9BA8] py-8 justify-center">
          <Loader2 className="w-4 h-4 animate-spin" /> Loading positions…
        </div>
      ) : sorted.length === 0 ? (
        <div className="text-sm text-[#8A9BA8] py-8 text-center flex flex-col items-center gap-2">
          <Wallet className="w-8 h-8 opacity-30" />
          No open positions. Live positions from connected platform accounts will appear here.
        </div>
      ) : (
        <div className="rounded-xl border border-[#182533] bg-[#17212B] overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-[10px] uppercase text-[#8A9BA8] border-b border-[#182533]">
                <th className="text-left px-4 py-3 font-medium cursor-pointer hover:text-[#FFFFFF]" onClick={() => toggleSort('market')}>
                  Market <SortIcon field="market" />
                </th>
                <th className="text-left px-4 py-3 font-medium">Platform</th>
                <th className="text-left px-4 py-3 font-medium">Side</th>
                <th className="text-right px-4 py-3 font-medium">Size</th>
                <th className="text-right px-4 py-3 font-medium">Entry</th>
                <th className="text-right px-4 py-3 font-medium">Current</th>
                <th className="text-right px-4 py-3 font-medium cursor-pointer hover:text-[#FFFFFF]" onClick={() => toggleSort('value')}>
                  Value <SortIcon field="value" />
                </th>
                <th className="text-right px-4 py-3 font-medium cursor-pointer hover:text-[#FFFFFF]" onClick={() => toggleSort('roi')}>
                  ROI <SortIcon field="roi" />
                </th>
                <th className="text-center px-4 py-3 font-medium">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#182533]">
              {sorted.map(pair => {
                const legs = [
                  pair.kalshi ? { platform: 'Kalshi' as const, side: pair.kalshi.side, size: pair.kalshi.size, entry: pair.kalshi.entryPrice, current: pair.kalshi.currentPrice, value: pair.kalshi.currentValue, pnl: pair.kalshi.unrealizedPnl, roi: pair.kalshi.roiPct } : null,
                  pair.polymarket ? { platform: 'Polymarket' as const, side: pair.polymarket.side, size: pair.polymarket.size, entry: pair.polymarket.entryPrice, current: pair.polymarket.currentPrice, value: pair.polymarket.currentValue, pnl: pair.polymarket.cashPnl, roi: pair.polymarket.percentPnl } : null,
                ].filter(Boolean) as { platform: string; side: string; size: number; entry: number; current: number; value: number; pnl: number; roi: number }[];

                const isPaired = pair.kalshi && pair.polymarket;
                const rowSpan = legs.length;

                return legs.map((leg, i) => (
                  <tr key={`${pair.id}-${i}`} className="hover:bg-[#182533]/50 transition-colors">
                    {i === 0 && (
                      <td rowSpan={rowSpan} className="px-4 py-3 text-xs text-[#FFFFFF] max-w-[200px] truncate align-top" title={pair.marketTitle}>
                        {pair.marketTitle}
                      </td>
                    )}
                    <td className="px-4 py-3 text-xs whitespace-nowrap">
                      <span className={leg.platform === 'Kalshi' ? 'text-[#5DBE81]' : 'text-[#a78bfa]'}>
                        {leg.platform}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-xs uppercase">
                      <span className={leg.side === 'YES' ? 'text-[#5DBE81]' : 'text-[#ef4444]'}>
                        {leg.side}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-xs text-right text-[#8A9BA8] whitespace-nowrap tabular-nums">
                      {leg.size.toFixed(2)}
                    </td>
                    <td className="px-4 py-3 text-xs text-right text-[#8A9BA8] whitespace-nowrap tabular-nums">
                      {fmtPrice(leg.entry)}
                    </td>
                    <td className="px-4 py-3 text-xs text-right text-[#FFFFFF] whitespace-nowrap tabular-nums">
                      {fmtPrice(leg.current)}
                    </td>
                    <td className="px-4 py-3 text-xs text-right text-[#8A9BA8] whitespace-nowrap tabular-nums">
                      {fmtUsd(leg.value)}
                    </td>
                    {i === 0 && (
                      <>
                        <td rowSpan={rowSpan} className={`px-4 py-3 text-xs text-right font-bold align-top whitespace-nowrap tabular-nums ${
                          pair.totalUnrealizedPnl >= 0 ? 'text-[#5DBE81]' : 'text-[#ef4444]'
                        }`}>
                          <div className="flex flex-col items-end">
                            <span>{fmtUsd(pair.totalUnrealizedPnl)}</span>
                            <span className="text-[10px] font-normal opacity-80">{fmtPct(pair.totalRoiPct)}</span>
                          </div>
                        </td>
                        <td rowSpan={rowSpan} className="px-4 py-3 text-center align-top">
                          <button
                            onClick={() => setConfirmExit(pair)}
                            disabled={exiting === pair.id}
                            className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-[#ef4444]/10 border border-[#ef4444]/30 text-[#ef4444] text-[10px] font-medium hover:bg-[#ef4444]/20 transition-colors disabled:opacity-50"
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
                ));
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Exit confirmation dialog */}
      {confirmExit && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={() => setConfirmExit(null)}>
          <div
            className="rounded-xl border border-[#182533] bg-[#17212B] p-6 max-w-md w-full mx-4 space-y-4"
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-center gap-2">
              <LogOut className="w-5 h-5 text-[#ef4444]" />
              <h3 className="text-sm font-bold text-[#FFFFFF]">Close positions?</h3>
            </div>
            <div className="text-xs text-[#8A9BA8] space-y-1">
              <div>Market: <span className="text-[#FFFFFF]">{confirmExit.marketTitle}</span></div>
              {confirmExit.kalshi && (
                <div>Kalshi: Sell {confirmExit.kalshi.size} {confirmExit.kalshi.side} @ {fmtPrice(confirmExit.kalshi.side === 'YES' ? confirmExit.kalshi.currentPrice : confirmExit.kalshi.currentPrice)}</div>
              )}
              {confirmExit.polymarket && (
                <div>Polymarket: Sell {confirmExit.polymarket.size} {confirmExit.polymarket.outcome} @ {fmtPrice(confirmExit.polymarket.currentPrice)}</div>
              )}
              <div className="pt-2 border-t border-[#182533]">
                Current ROI: <span className={confirmExit.totalRoiPct >= 0 ? 'text-[#5DBE81]' : 'text-[#ef4444]'}>
                  {fmtPct(confirmExit.totalRoiPct)}
                </span>
              </div>
              <div>
                Unrealized P&L: <span className={confirmExit.totalUnrealizedPnl >= 0 ? 'text-[#5DBE81]' : 'text-[#ef4444]'}>
                  {fmtUsd(confirmExit.totalUnrealizedPnl)}
                </span>
              </div>
            </div>
            <div className="text-[10px] text-amber-400 flex items-center gap-1">
              <AlertTriangle className="w-3 h-3" />
              This will place SELL orders on both platforms. Execution is irreversible.
            </div>
            <div className="flex gap-2 justify-end">
              <button
                onClick={() => setConfirmExit(null)}
                className="px-3 py-1.5 rounded-lg text-xs text-[#8A9BA8] hover:text-[#FFFFFF] border border-[#232E3C]"
              >
                Cancel
              </button>
              <button
                onClick={() => handleExit(confirmExit)}
                className="px-3 py-1.5 rounded-lg text-xs font-medium bg-[#ef4444]/20 border border-[#ef4444]/40 text-[#ef4444] hover:bg-[#ef4444]/30"
              >
                Close both positions
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}