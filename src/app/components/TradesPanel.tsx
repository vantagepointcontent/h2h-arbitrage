'use client';

/* TRADES-001: Trades page — durable history of all manual executions
 * (dry-run and real), backed by the executions table via /api/executions. */

import React, { useEffect, useState } from 'react';
import { Loader2, RefreshCw, Receipt } from 'lucide-react';

interface ExecutionRecord {
  id: number;
  timestamp: string;
  arbId: string;
  marketTitle: string;
  dryRun: boolean;
  success: boolean;
  strategy?: string | null;
  kalshiOrder?: { ticker?: string; outcome?: string; size?: number; price?: number } | null;
  polymarketOrder?: { outcome?: string; size?: number; price?: number } | null;
  result?: { error?: string } | null;
  estimatedProfit: number;
}

const fmtUsd = (n: number) => `$${n.toFixed(2)}`;

export default function TradesPanel() {
  const [trades, setTrades] = useState<ExecutionRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<'all' | 'real' | 'dry'>('all');

  const load = async () => {
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
  };

  useEffect(() => { load(); }, []);

  const visible = trades.filter(t =>
    filter === 'all' ? true : filter === 'real' ? !t.dryRun : t.dryRun
  );
  const realTrades = trades.filter(t => !t.dryRun && t.success);
  const totalEstProfit = realTrades.reduce((s, t) => s + (t.estimatedProfit || 0), 0);

  return (
    <div className="p-4 sm:p-6">
      <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
        <h2 className="text-lg font-semibold text-[#FFFFFF] flex items-center gap-2">
          <Receipt className="w-5 h-5 text-[#5DBE81]" /> Trades
        </h2>
        <div className="flex items-center gap-2">
          <div className="flex rounded-lg bg-[#0E1621] border border-[#182533] p-0.5">
            {(['all', 'real', 'dry'] as const).map(f => (
              <button
                key={f}
                onClick={() => setFilter(f)}
                className={`px-3 py-1 rounded-md text-xs font-medium transition-colors ${
                  filter === f ? 'bg-[#5DBE81] text-black' : 'text-[#5E6875] hover:text-[#FFFFFF]'
                }`}
              >
                {f === 'all' ? 'All' : f === 'real' ? 'Real' : 'Dry-run'}
              </button>
            ))}
          </div>
          <button
            onClick={load}
            className="p-1.5 rounded-lg border border-[#232E3C] text-[#5E6875] hover:text-[#FFFFFF] transition-colors"
            title="Refresh"
          >
            <RefreshCw className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Summary */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
        <div className="rounded-lg border border-[#182533] bg-[#17212B] p-3">
          <div className="text-[10px] uppercase text-[#5E6875]">Total trades</div>
          <div className="text-lg font-bold text-[#FFFFFF]">{trades.length}</div>
        </div>
        <div className="rounded-lg border border-[#182533] bg-[#17212B] p-3">
          <div className="text-[10px] uppercase text-[#5E6875]">Real (successful)</div>
          <div className="text-lg font-bold text-[#5DBE81]">{realTrades.length}</div>
        </div>
        <div className="rounded-lg border border-[#182533] bg-[#17212B] p-3">
          <div className="text-[10px] uppercase text-[#5E6875]">Dry-run</div>
          <div className="text-lg font-bold text-[#8A9BA8]">{trades.filter(t => t.dryRun).length}</div>
        </div>
        <div className="rounded-lg border border-[#182533] bg-[#17212B] p-3">
          <div className="text-[10px] uppercase text-[#5E6875]">Est. net profit (real)</div>
          <div className={`text-lg font-bold ${totalEstProfit >= 0 ? 'text-[#5DBE81]' : 'text-[#ef4444]'}`}>{fmtUsd(totalEstProfit)}</div>
        </div>
      </div>

      {error && <div className="text-sm text-[#ef4444] mb-3">{error}</div>}

      {loading ? (
        <div className="flex items-center gap-2 text-sm text-[#5E6875] py-8 justify-center">
          <Loader2 className="w-4 h-4 animate-spin" /> Loading trades…
        </div>
      ) : visible.length === 0 ? (
        <div className="text-sm text-[#5E6875] py-8 text-center">
          No trades recorded yet. Executions (dry-run or real) will appear here.
        </div>
      ) : (
        <div className="rounded-xl border border-[#182533] bg-[#17212B] overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-[10px] uppercase text-[#5E6875] border-b border-[#182533]">
                <th className="text-left px-4 py-3 font-medium">Time</th>
                <th className="text-left px-4 py-3 font-medium">Market</th>
                <th className="text-left px-4 py-3 font-medium">Strategy</th>
                <th className="text-right px-4 py-3 font-medium">Kalshi leg</th>
                <th className="text-right px-4 py-3 font-medium">PM leg</th>
                <th className="text-right px-4 py-3 font-medium">Est. profit</th>
                <th className="text-center px-4 py-3 font-medium">Mode</th>
                <th className="text-center px-4 py-3 font-medium">Result</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#182533]">
              {visible.map(t => (
                <tr key={t.id} className="hover:bg-[#182533]/50 transition-colors">
                  <td className="px-4 py-3 text-xs text-[#8A9BA8] whitespace-nowrap">{new Date(t.timestamp).toLocaleString()}</td>
                  <td className="px-4 py-3 text-xs text-[#FFFFFF] max-w-[240px] truncate" title={t.marketTitle}>{t.marketTitle}</td>
                  <td className="px-4 py-3 text-xs text-[#8A9BA8]">{t.strategy || '—'}</td>
                  <td className="px-4 py-3 text-xs text-right text-[#8A9BA8] whitespace-nowrap">
                    {t.kalshiOrder ? `${(t.kalshiOrder.outcome || '').toUpperCase()} ${t.kalshiOrder.size ?? '—'} @ ${t.kalshiOrder.price?.toFixed(2) ?? '—'}` : '—'}
                  </td>
                  <td className="px-4 py-3 text-xs text-right text-[#8A9BA8] whitespace-nowrap">
                    {t.polymarketOrder ? `${(t.polymarketOrder.outcome || '').toUpperCase()} ${t.polymarketOrder.size ?? '—'} @ ${t.polymarketOrder.price?.toFixed(2) ?? '—'}` : '—'}
                  </td>
                  <td className={`px-4 py-3 text-xs text-right font-medium ${t.estimatedProfit >= 0 ? 'text-[#5DBE81]' : 'text-[#ef4444]'}`}>{fmtUsd(t.estimatedProfit)}</td>
                  <td className="px-4 py-3 text-center">
                    <span className={`px-1.5 py-0.5 rounded text-[9px] font-bold uppercase ${t.dryRun ? 'bg-[#8A9BA8]/15 text-[#8A9BA8]' : 'bg-[#facc15]/20 text-[#facc15]'}`}>
                      {t.dryRun ? 'Dry' : 'Real'}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-center">
                    <span
                      className={`px-1.5 py-0.5 rounded text-[9px] font-bold uppercase ${t.success ? 'bg-[#5DBE81]/15 text-[#5DBE81]' : 'bg-[#ef4444]/15 text-[#ef4444]'}`}
                      title={t.result?.error || undefined}
                    >
                      {t.success ? 'OK' : 'Fail'}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
