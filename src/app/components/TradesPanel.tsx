'use client';

/* TRADES-001: Trades page — durable history of all manual executions
 * (dry-run and real), backed by the executions table via /api/executions.
 *
 * Columns per spec: market, platform, side, size, price, status, P&L.
 * Also: trade history with timestamps + ability to manually cancel pending trades.
 */

import React, { useEffect, useState, useCallback } from 'react';
import { Loader2, RefreshCw, Receipt, X, CheckCircle2, XCircle, Clock, Ban } from 'lucide-react';

interface ExecutionRecord {
  id: number;
  timestamp: string;
  arbId: string;
  marketTitle: string;
  dryRun: boolean;
  success: boolean;
  strategy?: string | null;
  kalshiOrder?: { ticker?: string; outcome?: string; side?: string; size?: number; price?: number; platform?: string } | null;
  polymarketOrder?: { outcome?: string; side?: string; size?: number; price?: number; platform?: string; conditionId?: string } | null;
  result?: { error?: string; kalshiResult?: { status?: string; orderId?: string }; polymarketResult?: { status?: string; orderId?: string } } | null;
  estimatedProfit: number;
}

const fmtUsd = (n: number) => `$${n.toFixed(2)}`;

/** Derive a human-readable trade status from the execution record. */
function tradeStatus(t: ExecutionRecord): 'filled' | 'pending' | 'cancelled' | 'failed' {
  if (!t.success && t.dryRun) return 'failed';
  if (!t.success) return 'failed';
  // Dry-run successful = simulated fill
  if (t.dryRun) return 'filled';
  // Real orders: check result sub-statuses
  const k = t.result?.kalshiResult?.status;
  const p = t.result?.polymarketResult?.status;
  if (k === 'pending' || p === 'pending') return 'pending';
  if (k === 'cancelled' || p === 'cancelled') return 'cancelled';
  if (k === 'filled' || p === 'filled') return 'filled';
  // Default for successful real orders without explicit fill confirmation
  return 'filled';
}

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, { cls: string; icon: React.ReactNode }> = {
    filled:    { cls: 'bg-[#5DBE81]/15 text-[#5DBE81]', icon: <CheckCircle2 className="w-3 h-3" /> },
    pending:  { cls: 'bg-amber-500/15 text-amber-400', icon: <Clock className="w-3 h-3" /> },
    cancelled:{ cls: 'bg-[#8A9BA8]/15 text-[#8A9BA8]', icon: <Ban className="w-3 h-3" /> },
    failed:   { cls: 'bg-[#ef4444]/15 text-[#ef4444]', icon: <XCircle className="w-3 h-3" /> },
  };
  const s = map[status] ?? map.failed;
  return (
    <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-bold uppercase ${s.cls}`}>
      {s.icon} {status}
    </span>
  );
}

export default function TradesPanel() {
  const [trades, setTrades] = useState<ExecutionRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<'all' | 'real' | 'dry' | 'pending'>('all');
  const [cancelling, setCancelling] = useState<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/executions?limit=500', { cache: 'no-store' });
      const data = await res.json();
      if (!data.success) throw new Error(data.error || 'Failed to load trades');
      setTrades(data.executions || []);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const cancelTrade = async (t: ExecutionRecord) => {
    if (!confirm(`Cancel pending trade for "${t.marketTitle}"?`)) return;
    setCancelling(t.id);
    try {
      // Cancel both legs if they have order IDs
      const results: string[] = [];
      const kOrder = t.result?.kalshiResult;
      const pOrder = t.result?.polymarketResult;

      if (kOrder?.orderId) {
        const res = await fetch('/api/execute', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'cancel-order', platform: 'kalshi', orderId: kOrder.orderId }),
        });
        results.push(`Kalshi: ${res.ok ? 'cancelled' : 'failed'}`);
      }
      if (pOrder?.orderId) {
        const res = await fetch('/api/execute', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'cancel-order', platform: 'polymarket', orderId: pOrder.orderId }),
        });
        results.push(`Polymarket: ${res.ok ? 'cancelled' : 'failed'}`);
      }
      if (results.length === 0) {
        setError('No cancelable order IDs found for this trade (may be a dry-run or already settled).');
      } else {
        await load(); // refresh
      }
    } catch (e: any) {
      setError(e.message);
    } finally {
      setCancelling(null);
    }
  };

  const visible = trades.filter(t => {
    if (filter === 'all') return true;
    if (filter === 'pending') return tradeStatus(t) === 'pending';
    if (filter === 'real') return !t.dryRun;
    if (filter === 'dry') return t.dryRun;
    return true;
  });

  const realTrades = trades.filter(t => !t.dryRun && t.success);
  const totalEstProfit = realTrades.reduce((s, t) => s + (t.estimatedProfit || 0), 0);
  const pendingCount = trades.filter(t => tradeStatus(t) === 'pending').length;

  return (
    <div className="p-4 sm:p-6">
      <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
        <h2 className="text-lg font-semibold text-[#FFFFFF] flex items-center gap-2">
          <Receipt className="w-5 h-5 text-[#5DBE81]" /> Trades
        </h2>
        <div className="flex items-center gap-2">
          <div className="flex rounded-lg bg-[#0E1621] border border-[#182533] p-0.5">
            {(['all', 'real', 'dry', 'pending'] as const).map(f => (
              <button
                key={f}
                onClick={() => setFilter(f)}
                className={`px-3 py-1 rounded-md text-xs font-medium transition-colors flex items-center gap-1 ${
                  filter === f ? 'bg-[#5DBE81] text-black' : 'text-[#8A9BA8] hover:text-[#FFFFFF]'
                }`}
              >
                {f === 'all' ? 'All' : f === 'real' ? 'Real' : f === 'dry' ? 'Dry-run' : 'Pending'}
                {f === 'pending' && pendingCount > 0 && (
                  <span className="px-1 rounded-full bg-amber-500/20 text-amber-400 text-[9px]">{pendingCount}</span>
                )}
              </button>
            ))}
          </div>
          <button
            onClick={load}
            className="p-1.5 rounded-lg border border-[#232E3C] text-[#8A9BA8] hover:text-[#FFFFFF] transition-colors"
            title="Refresh"
          >
            <RefreshCw className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Summary */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
        <div className="rounded-lg border border-[#182533] bg-[#17212B] p-3">
          <div className="text-[10px] uppercase text-[#8A9BA8]">Total trades</div>
          <div className="text-lg font-bold text-[#FFFFFF]">{trades.length}</div>
        </div>
        <div className="rounded-lg border border-[#182533] bg-[#17212B] p-3">
          <div className="text-[10px] uppercase text-[#8A9BA8]">Real (successful)</div>
          <div className="text-lg font-bold text-[#5DBE81]">{realTrades.length}</div>
        </div>
        <div className="rounded-lg border border-[#182533] bg-[#17212B] p-3">
          <div className="text-[10px] uppercase text-[#8A9BA8]">Pending</div>
          <div className="text-lg font-bold text-amber-400">{pendingCount}</div>
        </div>
        <div className="rounded-lg border border-[#182533] bg-[#17212B] p-3">
          <div className="text-[10px] uppercase text-[#8A9BA8]">Est. net P&L (real)</div>
          <div className={`text-lg font-bold ${totalEstProfit >= 0 ? 'text-[#5DBE81]' : 'text-[#ef4444]'}`}>{fmtUsd(totalEstProfit)}</div>
        </div>
      </div>

      {error && (
        <div className="text-sm text-[#ef4444] mb-3 flex items-center gap-2">
          <XCircle className="w-4 h-4" /> {error}
          <button onClick={() => setError(null)} className="ml-auto text-xs text-[#8A9BA8] hover:text-white">dismiss</button>
        </div>
      )}

      {loading ? (
        <div className="flex items-center gap-2 text-sm text-[#8A9BA8] py-8 justify-center">
          <Loader2 className="w-4 h-4 animate-spin" /> Loading trades…
        </div>
      ) : visible.length === 0 ? (
        <div className="text-sm text-[#8A9BA8] py-8 text-center">
          No trades recorded yet. Executions (dry-run or real) will appear here.
        </div>
      ) : (
        <div className="rounded-xl border border-[#182533] bg-[#17212B] overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-[10px] uppercase text-[#8A9BA8] border-b border-[#182533]">
                <th className="text-left px-4 py-3 font-medium">Time</th>
                <th className="text-left px-4 py-3 font-medium">Market</th>
                <th className="text-left px-4 py-3 font-medium">Platform</th>
                <th className="text-left px-4 py-3 font-medium">Side</th>
                <th className="text-right px-4 py-3 font-medium">Size</th>
                <th className="text-right px-4 py-3 font-medium">Price</th>
                <th className="text-center px-4 py-3 font-medium">Status</th>
                <th className="text-right px-4 py-3 font-medium">Est. P&L</th>
                <th className="text-center px-4 py-3 font-medium">Mode</th>
                <th className="text-center px-4 py-3 font-medium">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#182533]">
              {visible.map(t => {
                const status = tradeStatus(t);
                // Render both legs as sub-rows when both exist
                const legs = [
                  t.kalshiOrder ? { ...t.kalshiOrder, platform: 'Kalshi' } : null,
                  t.polymarketOrder ? { ...t.polymarketOrder, platform: 'Polymarket' } : null,
                ].filter(Boolean) as { platform: string; outcome?: string; side?: string; size?: number; price?: number }[];

                return legs.map((leg, i) => (
                  <tr key={`${t.id}-${i}`} className="hover:bg-[#182533]/50 transition-colors">
                    {i === 0 && (
                      <>
                        <td rowSpan={legs.length} className="px-4 py-3 text-xs text-[#8A9BA8] whitespace-nowrap align-top">
                          {new Date(t.timestamp).toLocaleString()}
                        </td>
                        <td rowSpan={legs.length} className="px-4 py-3 text-xs text-[#FFFFFF] max-w-[200px] truncate align-top" title={t.marketTitle}>
                          {t.marketTitle}
                        </td>
                      </>
                    )}
                    <td className="px-4 py-3 text-xs text-[#8A9BA8] whitespace-nowrap">
                      <span className={leg.platform === 'Kalshi' ? 'text-[#5DBE81]' : 'text-[#a78bfa]'}>{leg.platform}</span>
                    </td>
                    <td className="px-4 py-3 text-xs text-[#FFFFFF] uppercase">
                      {leg.outcome || leg.side || '—'}
                    </td>
                    <td className="px-4 py-3 text-xs text-right text-[#8A9BA8] whitespace-nowrap tabular-nums">
                      {leg.size != null ? fmtUsd(leg.size) : '—'}
                    </td>
                    <td className="px-4 py-3 text-xs text-right text-[#8A9BA8] whitespace-nowrap tabular-nums">
                      {leg.price != null ? leg.price.toFixed(3) : '—'}
                    </td>
                    {i === 0 && (
                      <>
                        <td rowSpan={legs.length} className="px-4 py-3 text-center align-top">
                          <StatusBadge status={status} />
                        </td>
                        <td rowSpan={legs.length} className={`px-4 py-3 text-xs text-right font-medium align-top ${t.estimatedProfit >= 0 ? 'text-[#5DBE81]' : 'text-[#ef4444]'}`}>
                          {fmtUsd(t.estimatedProfit)}
                        </td>
                        <td rowSpan={legs.length} className="px-4 py-3 text-center align-top">
                          <span className={`px-1.5 py-0.5 rounded text-[9px] font-bold uppercase ${t.dryRun ? 'bg-[#8A9BA8]/15 text-[#8A9BA8]' : 'bg-[#facc15]/20 text-[#facc15]'}`}>
                            {t.dryRun ? 'Dry' : 'Real'}
                          </span>
                        </td>
                        <td rowSpan={legs.length} className="px-4 py-3 text-center align-top">
                          {status === 'pending' && !t.dryRun && (
                            <button
                              onClick={() => cancelTrade(t)}
                              disabled={cancelling === t.id}
                              className="inline-flex items-center gap-1 px-2 py-1 rounded-lg bg-[#ef4444]/10 border border-[#ef4444]/30 text-[#ef4444] text-[10px] font-medium hover:bg-[#ef4444]/20 transition-colors disabled:opacity-50"
                              title="Cancel pending order"
                            >
                              {cancelling === t.id ? <Loader2 className="w-3 h-3 animate-spin" /> : <X className="w-3 h-3" />}
                              {cancelling === t.id ? '...' : 'Cancel'}
                            </button>
                          )}
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
    </div>
  );
}