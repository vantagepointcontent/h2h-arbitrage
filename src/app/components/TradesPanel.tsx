'use client';

/* TRADES-001: Trades page — durable history of all manual executions
 * (dry-run and real), backed by the executions table via /api/executions.
 *
 * Columns per spec: market, platform, side, size, price, status, P&L.
 * Also: trade history with timestamps + ability to manually cancel pending trades.
 *
 * FEAT: Open Positions sub-tab — live positions management with Exit button.
 * FEAT: Expandable rows with step-by-step execution timeline (UI-11).
 */

import React, { useEffect, useState, useCallback } from 'react';
import dynamic from 'next/dynamic';
import {
  Loader2,
  RefreshCw,
  Receipt,
  X,
  CheckCircle2,
  XCircle,
  Clock,
  Ban,
  ShieldAlert,
  Wallet,
  ChevronRight,
  AlertTriangle,
  Info,
  Minus,
} from 'lucide-react';

const OpenPositionsPanel = dynamic(() => import('./OpenPositionsPanel'), { ssr: false });

interface ExecutionStep {
  timestamp: string;
  status: 'success' | 'pending' | 'failed' | 'partial' | 'timeout' | 'skipped';
  description: string;
  metadata?: Record<string, unknown>;
}

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
  result?: {
    error?: string;
    kalshiResult?: { status?: string; orderId?: string; filledSize?: number; filledPrice?: number; error?: string };
    polymarketResult?: { status?: string; orderId?: string; filledSize?: number; filledPrice?: number; error?: string };
    rollbackExecuted?: boolean;
    unhedged?: boolean;
    netExposure?: number;
    actualProfit?: number;
    executionTimeMs?: number;
    steps?: ExecutionStep[];
    alerts?: { level: 'warning' | 'error' | 'info'; message: string; leg?: string; action?: string }[];
  } | null;
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

/** Format a timestamp for the timeline: HH:MM:SS.mmm */
function formatTimelineTimestamp(iso: string): string {
  const d = new Date(iso);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  const ms = String(d.getMilliseconds()).padStart(3, '0');
  return `${hh}:${mm}:${ss}.${ms}`;
}

/** Status icon for timeline steps */
function renderTimelineStatusIcon(status: string): React.ReactElement {
  switch (status) {
    case 'success':
      return <CheckCircle2 className="w-3.5 h-3.5 text-[#5DBE81]" aria-hidden="true" />;
    case 'pending':
      return <Loader2 className="w-3.5 h-3.5 text-amber-400 animate-spin" aria-hidden="true" />;
    case 'failed':
      return <XCircle className="w-3.5 h-3.5 text-[#ef4444]" aria-hidden="true" />;
    case 'partial':
      return <AlertTriangle className="w-3.5 h-3.5 text-amber-400" aria-hidden="true" />;
    case 'timeout':
      return <Clock className="w-3.5 h-3.5 text-amber-400" aria-hidden="true" />;
    case 'skipped':
      return <Minus className="w-3.5 h-3.5 text-[#5E6875]" aria-hidden="true" />;
    default:
      return <Minus className="w-3.5 h-3.5 text-[#5E6875]" aria-hidden="true" />;
  }
}

/** Build merged step list from result.steps + result.alerts */
function buildStepList(t: ExecutionRecord): ExecutionStep[] {
  const baseSteps = (t.result?.steps ?? []) as ExecutionStep[];
  const alerts = t.result?.alerts ?? [];
  const alertSteps: ExecutionStep[] = alerts.map((a) => ({
    timestamp: t.timestamp,
    status: (a.level === 'error' ? 'failed' : a.level === 'warning' ? 'pending' : 'success') as ExecutionStep['status'],
    description: a.message,
    metadata: { isAlert: true, alertLevel: a.level, alertAction: a.action },
  }));
  const merged = [...baseSteps, ...alertSteps];
  // Sort oldest first
  merged.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
  return merged;
}

/** Single expanded timeline panel */
function ExecutionTimeline({
  trade,
  steps,
  loading,
}: {
  trade: ExecutionRecord;
  steps: ExecutionStep[] | undefined;
  loading: boolean;
}) {
  const displaySteps = steps ?? [];
  const stepCount = displaySteps.length;
  const executionTimeMs = trade.result?.executionTimeMs ?? 0;
  const isUnhedged = Boolean(trade.result?.unhedged);
  const rollbackExecuted = Boolean(trade.result?.rollbackExecuted);
  const actualProfit = trade.result?.actualProfit;
  const netExposure = trade.result?.netExposure;

  return (
    <div className="overflow-hidden timeline-expand" role="region" aria-label={`Execution timeline for trade #${trade.id}`}>
      {/* Header row */}
      <div className="flex items-center justify-between mb-3">
        <span className="text-[10px] uppercase text-[#5E6875] font-medium tracking-wide">
          Execution Timeline
        </span>
        <span className="text-[10px] text-[#5E6875]">
          {stepCount} steps · {(executionTimeMs / 1000).toFixed(2)}s
        </span>
      </div>

      {/* Loading state */}
      {loading && (
        <div className="flex items-center gap-2 py-4 text-sm text-[#8A9BA8]">
          <Loader2 className="w-4 h-4 animate-spin" />
          <span>Loading execution timeline…</span>
        </div>
      )}

      {/* No data state */}
      {!loading && stepCount === 0 && (
        <div className="flex items-center gap-3 py-4 text-sm text-[#5E6875]">
          <Minus className="w-4 h-4" />
          <span>No execution timeline data available for this trade.</span>
        </div>
      )}

      {/* Steps timeline */}
      {!loading && stepCount > 0 && (
        <ol className="relative border-l border-[#232E3C] ml-[154px] md:ml-[144px] sm:ml-[124px]">
          {displaySteps.map((step, i) => (
            <li key={i} className="relative pl-7 pb-3 last:pb-0">
              {/* Icon circle overlapping the border line */}
              <span
                className="absolute left-0 top-0 -translate-x-[13px] flex items-center justify-center w-6 h-6 rounded-full bg-[#0E1621] border border-[#182533] z-10"
                aria-hidden="true"
              >
                {renderTimelineStatusIcon(step.status)}
              </span>
              {/* Timestamp + Description */}
              <div className="flex items-start gap-3">
                <span className="text-[11px] text-[#8A9BA8] font-mono tabular-nums whitespace-nowrap w-[130px] shrink-0 -translate-x-[154px] -ml-[130px]">
                  {formatTimelineTimestamp(step.timestamp)}
                </span>
                <span className="text-xs text-[#FFFFFF] flex-1 min-w-0">
                  {step.description}
                </span>
              </div>
              {/* Optional metadata detail line */}
              {step.metadata && (step.metadata as Record<string, unknown>).filledSize != null && (step.metadata as Record<string, unknown>).requestedSize != null && (
                <div className="text-[10px] text-[#5E6875] mt-0.5 ml-[168px]">
                  Fill ratio: {(((Number((step.metadata as Record<string, unknown>).filledSize) / Number((step.metadata as Record<string, unknown>).requestedSize))) * 100).toFixed(1)}%
                </div>
              )}
              {/* Alert label prefix */}
              {step.metadata && (step.metadata as Record<string, unknown>).isAlert && (
                <div className="flex items-start gap-1.5 mt-0.5">
                  <span className="text-[10px] uppercase text-[#5E6875] mr-1">Alert</span>
                  <span className="text-xs text-[#FFFFFF]">{step.description}</span>
                </div>
              )}
            </li>
          ))}
        </ol>
      )}

      {/* Summary footer */}
      {!loading && stepCount > 0 && (
        <div className="mt-3 pt-3 border-t border-[#182533] flex items-center gap-4 flex-wrap text-[11px]">
          <span className="flex items-center gap-1.5">
            <span className="text-[#5E6875] uppercase">Result:</span>
            <span
              className={`font-bold uppercase ${
                trade.success ? 'text-[#5DBE81]' : 'text-[#ef4444]'
              }`}
            >
              {trade.success ? 'Success' : 'Failed'}
            </span>
          </span>
          {isUnhedged && (
            <span className="flex items-center gap-1 text-[#ef4444]">
              <ShieldAlert className="w-3 h-3" /> Unhedged: {fmtUsd(netExposure ?? 0)}
            </span>
          )}
          {rollbackExecuted && (
            <span className="flex items-center gap-1 text-amber-400">
              <RefreshCw className="w-3 h-3" /> Rolled back
            </span>
          )}
          <span className="flex items-center gap-1.5">
            <span className="text-[#5E6875] uppercase">Duration:</span>
            <span className="text-[#8A9BA8] font-mono tabular-nums">
              {(executionTimeMs / 1000).toFixed(2)}s
            </span>
          </span>
          {actualProfit != null && (
            <span className="flex items-center gap-1.5">
              <span className="text-[#5E6875] uppercase">Actual P&L:</span>
              <span
                className={`font-mono tabular-nums font-medium ${
                  actualProfit >= 0 ? 'text-[#5DBE81]' : 'text-[#ef4444]'
                }`}
              >
                {fmtUsd(actualProfit)}
              </span>
            </span>
          )}
        </div>
      )}
    </div>
  );
}

export default function TradesPanel() {
  const [trades, setTrades] = useState<ExecutionRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<'all' | 'real' | 'dry' | 'pending'>('all');
  const [cancelling, setCancelling] = useState<number | null>(null);
  const [subTab, setSubTab] = useState<'positions' | 'history'>('positions');

  // Expand/collapse state
  const [expandedIds, setExpandedIds] = useState<Set<number>>(new Set());
  // Lazy-loaded timeline cache: trade id -> steps
  const [timelineCache, setTimelineCache] = useState<Record<number, ExecutionStep[]>>({});
  const [loadingTimelines, setLoadingTimelines] = useState<Set<number>>(new Set());

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

  /** Fetch timeline for a trade from the separate endpoint (fallback if steps not inline). */
  const loadTimeline = useCallback(async (tradeId: number, arbId: string) => {
    if (timelineCache[tradeId]) return; // already loaded
    setLoadingTimelines((prev) => {
      const n = new Set(prev);
      n.add(tradeId);
      return n;
    });
    try {
      const res = await fetch(`/api/trades/${encodeURIComponent(arbId)}/execution`, { cache: 'no-store' });
      const data = await res.json();
      if (data.success && data.data?.steps) {
        setTimelineCache((prev) => ({ ...prev, [tradeId]: data.data.steps as ExecutionStep[] }));
      } else {
        setTimelineCache((prev) => ({ ...prev, [tradeId]: [] }));
      }
    } catch {
      setTimelineCache((prev) => ({ ...prev, [tradeId]: [] }));
    } finally {
      setLoadingTimelines((prev) => {
        const n = new Set(prev);
        n.delete(tradeId);
        return n;
      });
    }
  }, [timelineCache]);

  const toggleExpand = useCallback((id: number, arbId: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
        void loadTimeline(id, arbId);
      }
      return next;
    });
  }, [loadTimeline]);

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

  const visible = trades.filter((t) => {
    if (filter === 'all') return true;
    if (filter === 'pending') return tradeStatus(t) === 'pending';
    if (filter === 'real') return !t.dryRun;
    if (filter === 'dry') return t.dryRun;
    return true;
  });

  const realTrades = trades.filter((t) => !t.dryRun && t.success);
  const totalEstProfit = realTrades.reduce((s, t) => s + (t.estimatedProfit || 0), 0);
  const pendingCount = trades.filter((t) => tradeStatus(t) === 'pending').length;
  const unhedgedCount = trades.filter((t) => t.result?.unhedged).length;
  const unhedgedExposure = trades
    .filter((t) => t.result?.unhedged)
    .reduce((s, t) => s + (t.result?.netExposure ?? 0), 0);

  return (
    <div className="p-4 sm:p-6">
      <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
        <h2 className="text-lg font-semibold text-[#FFFFFF] flex items-center gap-2">
          <Receipt className="w-5 h-5 text-[#5DBE81]" /> Trades
        </h2>
        <div className="flex items-center gap-2">
          {/* Sub-tab toggle: Open Positions vs History */}
          <div className="flex rounded-lg bg-[#0E1621] border border-[#182533] p-0.5">
            <button
              onClick={() => setSubTab('positions')}
              className={`px-3 py-1 rounded-md text-xs font-medium transition-colors flex items-center gap-1 ${
                subTab === 'positions' ? 'bg-[#5DBE81] text-black' : 'text-[#8A9BA8] hover:text-[#FFFFFF]'
              }`}
            >
              <Wallet className="w-3 h-3" /> Open Positions
            </button>
            <button
              onClick={() => setSubTab('history')}
              className={`px-3 py-1 rounded-md text-xs font-medium transition-colors flex items-center gap-1 ${
                subTab === 'history' ? 'bg-[#5DBE81] text-black' : 'text-[#8A9BA8] hover:text-[#FFFFFF]'
              }`}
            >
              <Receipt className="w-3 h-3" /> History
            </button>
          </div>
          {subTab === 'history' && (
            <>
              <div className="flex rounded-lg bg-[#0E1621] border border-[#182533] p-0.5">
                {(['all', 'real', 'dry', 'pending'] as const).map((f) => (
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
            </>
          )}
        </div>
      </div>

      {/* Open Positions sub-tab */}
      {subTab === 'positions' && <OpenPositionsPanel />}

      {/* Trade History sub-tab */}
      {subTab === 'history' && (
        <>
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

          {/* Unhedged exposure warning */}
          {unhedgedCount > 0 && (
            <div className="mb-4 p-3 rounded-lg border border-red-800 bg-red-950/40 text-red-400 text-sm flex items-center gap-2">
              <ShieldAlert className="w-4 h-4 shrink-0" />
              <span>
                <b>{unhedgedCount} unhedged trade{unhedgedCount > 1 ? 's' : ''}</b> — {fmtUsd(unhedgedExposure)} total exposure from failed auto-closes. Close manually on the platform.
              </span>
            </div>
          )}

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
                    <th className="text-center px-2 py-3 font-medium w-8">{/* expand toggle */}</th>
                    <th className="text-left px-4 py-3 font-medium">Time</th>
                    <th className="text-left px-4 py-3 font-medium">Market</th>
                    <th className="text-left px-4 py-3 font-medium">Platform</th>
                    <th className="text-left px-4 py-3 font-medium">Side</th>
                    <th className="text-right px-4 py-3 font-medium">Size</th>
                    <th className="text-right px-4 py-3 font-medium">Price</th>
                    <th className="text-center px-4 py-3 font-medium">Fill</th>
                    <th className="text-center px-4 py-3 font-medium">Status</th>
                    <th className="text-right px-4 py-3 font-medium">Est. P&L</th>
                    <th className="text-center px-4 py-3 font-medium">Mode</th>
                    <th className="text-center px-4 py-3 font-medium">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#182533]">
                  {visible.map((t) => {
                    const status = tradeStatus(t);
                    const isUnhedged = Boolean(t.result?.unhedged);
                    const expanded = expandedIds.has(t.id);

                    // Per-leg fill status from result
                    const legResults = [
                      t.result?.kalshiResult,
                      t.result?.polymarketResult,
                    ];

                    // Render both legs as sub-rows when both exist
                    const legs = [
                      t.kalshiOrder ? { ...t.kalshiOrder, platform: 'Kalshi' } : null,
                      t.polymarketOrder ? { ...t.polymarketOrder, platform: 'Polymarket' } : null,
                    ].filter(Boolean) as {
                      platform: string;
                      outcome?: string;
                      side?: string;
                      size?: number;
                      price?: number;
                    }[];

                    // Steps: prefer inline result.steps, else cache from lazy load
                    const inlineSteps = t.result?.steps as ExecutionStep[] | undefined;
                    const cachedSteps = timelineCache[t.id];
                    const steps = inlineSteps && inlineSteps.length > 0 ? buildStepList(t) : cachedSteps;
                    const isLoadingTimeline = loadingTimelines.has(t.id);

                    return (
                      <React.Fragment key={t.id}>
                        {legs.map((leg, i) => {
                          const legResult = legResults[i];
                          const legFill = legResult?.status ?? '—';
                          const legFilledSize = legResult?.filledSize;
                          return (
                            <tr key={`${t.id}-${i}`} className="hover:bg-[#182533]/50 transition-colors">
                              {/* Expand toggle — only on first sub-row, spans all legs */}
                              {i === 0 && (
                                <td rowSpan={legs.length} className="px-2 py-3 text-center align-top">
                                  <button
                                    onClick={() => toggleExpand(t.id, t.arbId)}
                                    className="p-1 rounded hover:bg-[#232E3C] transition-colors"
                                    aria-label={expanded ? 'Collapse trade details' : 'Expand trade details'}
                                    aria-expanded={expanded}
                                  >
                                    <ChevronRight
                                      className={`w-3.5 h-3.5 text-[#8A9BA8] transition-transform duration-200 ${
                                        expanded ? 'rotate-90' : ''
                                      }`}
                                    />
                                  </button>
                                </td>
                              )}
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
                              <td className="px-4 py-3 text-xs text-center whitespace-nowrap">
                                <span
                                  className={`text-[9px] font-medium uppercase ${
                                    legFill === 'filled'
                                      ? 'text-[#5DBE81]'
                                      : legFill === 'partial'
                                        ? 'text-amber-400'
                                        : legFill === 'pending'
                                          ? 'text-amber-400'
                                          : legFill === 'rejected' || legFill === 'cancelled'
                                            ? 'text-[#ef4444]'
                                            : 'text-[#8A9BA8]'
                                  }`}
                                >
                                  {legFill}
                                  {legFilledSize ? ` · $${legFilledSize.toFixed(0)}` : ''}
                                </span>
                              </td>
                              {i === 0 && (
                                <>
                                  <td rowSpan={legs.length} className="px-4 py-3 text-center align-top">
                                    <div className="flex flex-col items-center gap-1">
                                      <StatusBadge status={status} />
                                      {isUnhedged && (
                                        <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[9px] font-bold uppercase bg-red-500/20 text-red-400">
                                          <ShieldAlert className="w-2.5 h-2.5" /> Unhedged
                                        </span>
                                      )}
                                      {t.result?.rollbackExecuted && !isUnhedged && (
                                        <span className="px-1.5 py-0.5 rounded text-[9px] font-bold uppercase bg-amber-500/15 text-amber-400">
                                          Rolled back
                                        </span>
                                      )}
                                    </div>
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
                          );
                        })}
                        {/* Expanded execution timeline row */}
                        {expanded && (
                          <tr key={`${t.id}-expanded`} className="bg-[#0E1621]">
                            <td colSpan={13} className="px-4 py-3 min-w-0">
                              <ExecutionTimeline
                                trade={t}
                                steps={steps}
                                loading={isLoadingTimeline}
                              />
                            </td>
                          </tr>
                        )}
                      </React.Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}
