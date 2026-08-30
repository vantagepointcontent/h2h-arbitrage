'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, Clock3, RefreshCw } from 'lucide-react';

type LogStatus = 'passed' | 'failed' | 'pending';
type SelectionMethod = 'roi' | 'apy' | 'hybrid';

interface ActionStep {
  id: number;
  timestamp: string;
  step: string;
  action: string;
  responseStatus: LogStatus;
  errorReason: string | null;
  durationMs: number | null;
  requestPayload: unknown;
  responsePayload: unknown;
  alertMetadata: unknown;
  qualificationOutcome?: 'qualified' | 'dead' | null;
}

interface TradeChain {
  tradeId: string;
  trigger: string;
  marketId: string;
  marketTitle: string;
  startedAt: string;
  status: LogStatus;
  qualified: boolean | null;
  steps: ActionStep[];
}

interface ScanDecision {
  scanId: number;
  logUuid: string | null;
  marketId: string | null;
  marketName: string | null;
  source?: string;
  state: string;
  reasonCode: string;
  reason: string;
  receivedAt?: string;
  updatedAt: string;
  attempts?: number;
  placementCount?: number;
  details?: unknown;
}

interface LogsResponse {
  success: boolean;
  error?: string;
  trades?: TradeChain[];
  decisions?: ScanDecision[];
  nextCursor?: number | null;
}

const statusStyle: Record<LogStatus, string> = {
  passed: 'border-[var(--status-info)]/35 bg-[var(--status-info)]/10 text-[var(--status-info)]',
  failed: 'border-[var(--border-strong)] bg-[var(--surface-workspace)] text-[var(--text-primary)]',
  pending: 'border-[var(--status-warning)]/35 bg-[var(--status-warning)]/10 text-[var(--status-warning)]',
};

const statusIcon: Record<LogStatus, string> = { passed: '✓', failed: '✕', pending: '◷' };
const statusLabel: Record<LogStatus, string> = { passed: 'Completed', failed: 'Failed', pending: 'In progress' };

function pretty(value: unknown): string {
  return value == null ? '—' : JSON.stringify(value, null, 2);
}

function formatDateTime(value?: string): string {
  if (!value) return 'Unknown time';
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString();
}

function formatTime(value: string): string {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleTimeString();
}

function formatDuration(durationMs: number | null | undefined): string {
  if (durationMs == null || !Number.isFinite(durationMs)) return '—';
  if (durationMs < 1_000) return `${durationMs} ms`;
  return `${(durationMs / 1_000).toFixed(durationMs < 10_000 ? 2 : 1)} s`;
}

function elapsed(start?: string, end?: string): string | null {
  if (!start || !end) return null;
  const duration = Date.parse(end) - Date.parse(start);
  return Number.isFinite(duration) && duration >= 0 ? formatDuration(duration) : null;
}

function titleCase(value: string): string {
  return value.replaceAll('_', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function decisionStatus(decision: ScanDecision): LogStatus {
  if (decision.state === 'reset_cleared') return 'failed';
  if (decision.state === 'placed') return 'passed';
  if (decision.state === 'received' || decision.state === 'placement_attempted') return 'pending';
  return 'failed';
}

function mergeTradePages(current: TradeChain[], incoming: TradeChain[]): TradeChain[] {
  const merged = new Map(current.map((trade) => [trade.tradeId, trade]));
  for (const trade of incoming) {
    const existing = merged.get(trade.tradeId);
    if (!existing) {
      merged.set(trade.tradeId, trade);
      continue;
    }
    // Incoming cursor pages are older. Start with their evidence and let the
    // newer on-screen snapshot win when a page boundary overlaps an event.
    const steps = new Map(trade.steps.map((step) => [step.id, step]));
    for (const step of existing.steps) steps.set(step.id, step);
    merged.set(trade.tradeId, {
      ...trade,
      ...existing,
      startedAt: existing.startedAt < trade.startedAt ? existing.startedAt : trade.startedAt,
      status: existing.status === 'failed' || trade.status === 'failed'
        ? 'failed'
        : existing.status === 'pending' || trade.status === 'pending' ? 'pending' : 'passed',
      qualified: existing.qualified === true || trade.qualified === true
        ? true
        : existing.qualified === false || trade.qualified === false ? false : null,
      steps: [...steps.values()].sort((a, b) => a.id - b.id),
    });
  }
  return [...merged.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

function StatusBadge({ status, label = statusLabel[status] }: { status: LogStatus; label?: string }) {
  return (
    <span className={`inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${statusStyle[status]}`}>
      <span aria-hidden="true">{statusIcon[status]}</span>{label}
    </span>
  );
}

export default function BotActionLogs({ selectionMethod }: { selectionMethod?: SelectionMethod }) {
  const [trades, setTrades] = useState<TradeChain[]>([]);
  const [decisions, setDecisions] = useState<ScanDecision[]>([]);
  const [status, setStatus] = useState<'all' | LogStatus>('all');
  const [market, setMarket] = useState('');
  const [since, setSince] = useState('');
  const [expandedTrades, setExpandedTrades] = useState<Set<string>>(new Set());
  const [expandedScans, setExpandedScans] = useState<Set<number>>(new Set());
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [qualifiedOnly, setQualifiedOnly] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [nextCursor, setNextCursor] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const requestGeneration = useRef(0);
  const initialRequest = useRef<AbortController | null>(null);
  const pageRequest = useRef<AbortController | null>(null);
  const refreshInFlight = useRef(false);

  const buildQuery = useCallback((cursor?: number) => {
    const query = new URLSearchParams();
    if (status !== 'all') query.set('status', status);
    if (market.trim()) query.set('marketId', market.trim());
    if (since) query.set('since', new Date(`${since}T00:00:00`).toISOString());
    if (qualifiedOnly) query.set('qualified', 'true');
    if (cursor != null) query.set('cursor', String(cursor));
    return query;
  }, [market, qualifiedOnly, since, status]);

  const load = useCallback(async () => {
    const generation = ++requestGeneration.current;
    initialRequest.current?.abort();
    pageRequest.current?.abort();
    const controller = new AbortController();
    initialRequest.current = controller;
    pageRequest.current = null;
    refreshInFlight.current = true;
    setLoading(true);
    setLoadingMore(false);
    try {
      const response = await fetch(`/api/bot-trader/logs?${buildQuery()}`, { cache: 'no-store', signal: controller.signal });
      const data = await response.json() as LogsResponse;
      if (!response.ok || !data.success) throw new Error(data.error || 'Failed to load action logs');
      if (generation !== requestGeneration.current) return;
      setTrades(data.trades || []);
      setDecisions(data.decisions || []);
      setNextCursor(data.nextCursor ?? null);
      setError(null);
    } catch (cause) {
      if (controller.signal.aborted) return;
      if (generation === requestGeneration.current) {
        setError(cause instanceof Error ? cause.message : 'Failed to load action logs');
      }
    } finally {
      if (generation === requestGeneration.current) {
        setLoading(false);
        refreshInFlight.current = false;
      }
      if (initialRequest.current === controller) initialRequest.current = null;
    }
  }, [buildQuery]);

  const loadMore = useCallback(async () => {
    if (nextCursor == null || loading || loadingMore || refreshInFlight.current || pageRequest.current) return;
    const generation = requestGeneration.current;
    const controller = new AbortController();
    pageRequest.current = controller;
    setLoadingMore(true);
    try {
      const response = await fetch(`/api/bot-trader/logs?${buildQuery(nextCursor)}`, { cache: 'no-store', signal: controller.signal });
      const data = await response.json() as LogsResponse;
      if (!response.ok || !data.success) throw new Error(data.error || 'Failed to load older action logs');
      if (generation !== requestGeneration.current || pageRequest.current !== controller) return;
      setTrades((current) => mergeTradePages(current, data.trades || []));
      setNextCursor(data.nextCursor ?? null);
      setError(null);
    } catch (cause) {
      if (controller.signal.aborted) return;
      if (generation === requestGeneration.current && pageRequest.current === controller) {
        setError(cause instanceof Error ? cause.message : 'Failed to load older action logs');
      }
    } finally {
      if (generation === requestGeneration.current && pageRequest.current === controller) setLoadingMore(false);
      if (pageRequest.current === controller) pageRequest.current = null;
    }
  }, [buildQuery, loading, loadingMore, nextCursor]);

  useEffect(() => {
    const initialId = window.setTimeout(() => void load(), 0);
    const intervalId = autoRefresh ? window.setInterval(() => void load(), 30_000) : null;
    return () => {
      window.clearTimeout(initialId);
      if (intervalId != null) window.clearInterval(intervalId);
      requestGeneration.current += 1;
      initialRequest.current?.abort();
      pageRequest.current?.abort();
    };
  }, [autoRefresh, load]);

  const invalidateQuery = () => {
    requestGeneration.current += 1;
    refreshInFlight.current = true;
    initialRequest.current?.abort();
    pageRequest.current?.abort();
    initialRequest.current = null;
    pageRequest.current = null;
    setNextCursor(null);
    setLoadingMore(false);
  };

  const toggleTrade = (tradeId: string) => setExpandedTrades((current) => {
    const next = new Set(current);
    if (next.has(tradeId)) next.delete(tradeId); else next.add(tradeId);
    return next;
  });

  const toggleScan = (scanId: number) => setExpandedScans((current) => {
    const next = new Set(current);
    if (next.has(scanId)) next.delete(scanId); else next.add(scanId);
    return next;
  });

  return (
    <section className="space-y-4" aria-label="BotTrader action logs">
      <header className="rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-panel)] px-4 py-3">
        <div className="text-sm font-semibold text-[var(--text-primary)]">Placement attempts</div>
        <p className="mt-0.5 text-[11px] leading-relaxed text-[var(--text-secondary)]">
          Scan decisions and order-placement history. Completed attempts become positions only after both legs are verified.
        </p>
      </header>

      <div className="grid gap-2 rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-panel)] p-3 sm:grid-cols-2 lg:flex lg:flex-wrap lg:items-end">
        <label className="grid gap-1 text-[10px] font-bold uppercase tracking-wide text-[var(--text-secondary)]">
          Status
          <select value={status} onChange={(event) => { invalidateQuery(); setStatus(event.target.value as typeof status); }} className="min-h-11 rounded-lg border border-[var(--border-strong)] bg-[var(--surface-workspace)] px-3 text-xs font-medium normal-case text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--status-info)]">
            <option value="all">All statuses</option><option value="passed">Passed</option><option value="failed">Failed</option><option value="pending">Pending</option>
          </select>
        </label>
        <label className="grid gap-1 text-[10px] font-bold uppercase tracking-wide text-[var(--text-secondary)]">
          Since
          <input type="date" value={since} onChange={(event) => { invalidateQuery(); setSince(event.target.value); }} className="min-h-11 rounded-lg border border-[var(--border-strong)] bg-[var(--surface-workspace)] px-3 text-xs font-medium normal-case text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--status-info)]" />
        </label>
        <label className="grid gap-1 text-[10px] font-bold uppercase tracking-wide text-[var(--text-secondary)] sm:col-span-2 lg:col-span-1">
          Market ID
          <input value={market} onChange={(event) => { invalidateQuery(); setMarket(event.target.value); }} placeholder="All markets" className="min-h-11 min-w-52 rounded-lg border border-[var(--border-strong)] bg-[var(--surface-workspace)] px-3 text-xs font-medium normal-case text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--status-info)]" />
        </label>
        <label className="flex min-h-11 items-center gap-2 rounded-lg px-2 text-xs text-[var(--text-secondary)]"><input type="checkbox" checked={autoRefresh} onChange={(event) => setAutoRefresh(event.target.checked)} /> Auto-refresh 30s</label>
        <label className={`flex min-h-11 cursor-pointer items-center gap-2 rounded-lg border px-3 text-xs font-semibold ${qualifiedOnly ? 'border-[var(--status-info)]/40 bg-[var(--status-info)]/10 text-[var(--status-info)]' : 'border-[var(--border-strong)] text-[var(--text-secondary)]'}`}><input aria-label="Qualified only" type="checkbox" checked={qualifiedOnly} onChange={(event) => { invalidateQuery(); setQualifiedOnly(event.target.checked); }} /> Qualified only</label>
        <span title="Backend-ranked selection method used for new BotTrader evaluations" className="flex min-h-11 items-center justify-center rounded-lg border border-[var(--border-strong)] px-3 text-[10px] font-bold uppercase text-[var(--text-primary)]">Method: {selectionMethod ?? 'unknown'}</span>
        <button type="button" onClick={() => void load()} aria-label="Refresh action logs" className="min-h-11 min-w-11 rounded-lg border border-[var(--border-strong)] text-[var(--text-secondary)] hover:bg-[var(--surface-workspace)] hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--status-info)]">
          <RefreshCw className={`mx-auto h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
        </button>
      </div>

      {error && <div role="alert" className="rounded-lg border border-[var(--status-warning)]/40 bg-[var(--status-warning)]/10 p-3 text-sm font-medium text-[var(--status-warning)]">{error}</div>}
      {loading && <div role="status" className="text-center text-xs text-[var(--text-secondary)]">{trades.length || decisions.length ? 'Refreshing logs…' : 'Loading action logs…'}</div>}

      {decisions.length > 0 && (
        <section aria-labelledby="scan-runs-heading" className="space-y-2">
          <div className="flex items-end justify-between gap-3 px-1">
            <div><h3 id="scan-runs-heading" className="text-xs font-bold uppercase tracking-wider text-[var(--text-primary)]">Scan runs</h3><p className="text-[10px] text-[var(--text-secondary)]">Persisted scan reconciliation and final decision</p></div>
            <span className="text-[10px] tabular-nums text-[var(--text-secondary)]">{decisions.length} runs</span>
          </div>
          <div className="space-y-2 border-l border-[var(--border-strong)] pl-2 sm:pl-3">
            {decisions.map((decision) => {
              const open = expandedScans.has(decision.scanId);
              const visualStatus = decisionStatus(decision);
              const decisionElapsed = elapsed(decision.receivedAt, decision.updatedAt);
              return (
                <article key={decision.scanId} className="overflow-hidden rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-panel)] shadow-sm">
                  <button type="button" aria-expanded={open} aria-controls={`scan-details-${decision.scanId}`} aria-label={`${open ? 'Collapse' : 'Expand'} scan ${decision.scanId}, Logs UUID ${decision.logUuid ?? 'unavailable'}, market ${decision.marketName ?? 'unavailable'}, reason code ${decision.reasonCode}, ${titleCase(decision.state)}, ${decision.reason}`} onClick={() => toggleScan(decision.scanId)} className="grid min-h-14 w-full grid-cols-[auto_minmax(0,1fr)] items-center gap-2 px-3 py-2 text-left hover:bg-[var(--surface-workspace)]/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--status-info)] sm:grid-cols-[auto_minmax(0,1fr)_auto]">
                    {open ? <ChevronDown className="h-4 w-4 text-[var(--text-secondary)]" /> : <ChevronRight className="h-4 w-4 text-[var(--text-secondary)]" />}
                    <span className="min-w-0">
                      <span className="flex min-w-0 items-center gap-1.5 text-xs text-[var(--text-primary)]">
                        <strong className="shrink-0">Scan #{decision.scanId}</strong>
                        <span aria-hidden="true" className="text-[var(--text-secondary)]">·</span>
                        <span className="shrink-0 font-mono font-semibold tracking-wider">{decision.logUuid ?? '—'}</span>
                        <span aria-hidden="true" className="hidden text-[var(--text-secondary)] sm:inline">·</span>
                        <span className="hidden min-w-0 truncate sm:inline" title={decision.marketName ?? undefined}>{decision.marketName ?? decision.marketId ?? 'Unknown market'}</span>
                        <span aria-hidden="true" className="hidden shrink-0 text-[var(--text-secondary)] sm:inline">·</span>
                        <span className="hidden shrink-0 font-mono text-[10px] text-[var(--text-secondary)] sm:inline">{decision.reasonCode}</span>
                      </span>
                      <span className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[11px] sm:hidden">
                        <span className="min-w-0 truncate font-medium text-[var(--text-primary)]" title={decision.marketName ?? undefined}>{decision.marketName ?? decision.marketId ?? 'Unknown market'}</span>
                        <span aria-hidden="true" className="shrink-0 text-[var(--text-secondary)]">·</span>
                        <span className="shrink-0 font-mono text-[10px] text-[var(--text-secondary)]">{decision.reasonCode}</span>
                      </span>
                      <span className="mt-0.5 block truncate text-[11px] text-[var(--text-secondary)]">{decision.reason}</span>
                      <span className="mt-1 flex flex-wrap items-center gap-2 sm:hidden"><StatusBadge status={visualStatus} label={titleCase(decision.state)} /><span className="whitespace-nowrap text-[10px] tabular-nums text-[var(--text-secondary)]">{formatDateTime(decision.updatedAt)}{decisionElapsed ? ` · ${decisionElapsed}` : ''}</span></span>
                    </span>
                    <span className="hidden items-center gap-2 sm:col-start-3 sm:row-start-1 sm:flex sm:justify-end"><StatusBadge status={visualStatus} label={titleCase(decision.state)} /><span className="whitespace-nowrap text-[10px] tabular-nums text-[var(--text-secondary)]">{formatDateTime(decision.updatedAt)}{decisionElapsed ? ` · ${decisionElapsed}` : ''}</span></span>
                  </button>
                  {open && (
                    <div id={`scan-details-${decision.scanId}`} data-testid={`scan-details-${decision.scanId}`} className="border-t border-[var(--border-subtle)] bg-[var(--surface-workspace)]/35 p-3 sm:ml-8 sm:p-4">
                      <div className="grid gap-3 text-xs sm:grid-cols-2 lg:grid-cols-4">
                        <div><div className="text-[9px] font-bold uppercase tracking-wide text-[var(--text-secondary)]">Logs UUID</div><div className="mt-1 font-mono font-semibold tracking-wider text-[var(--text-primary)]">{decision.logUuid ?? '—'}</div></div>
                        <div><div className="text-[9px] font-bold uppercase tracking-wide text-[var(--text-secondary)]">Market</div><div className="mt-1 text-[var(--text-primary)]">{decision.marketName ?? decision.marketId ?? '—'}</div></div>
                        <div><div className="text-[9px] font-bold uppercase tracking-wide text-[var(--text-secondary)]">Source</div><div className="mt-1 font-mono text-[var(--text-primary)]">{decision.source ?? '—'}</div></div>
                        <div><div className="text-[9px] font-bold uppercase tracking-wide text-[var(--text-secondary)]">Received</div><div className="mt-1 tabular-nums text-[var(--text-primary)]">{formatDateTime(decision.receivedAt)}</div></div>
                        <div><div className="text-[9px] font-bold uppercase tracking-wide text-[var(--text-secondary)]">Attempts</div><div className="mt-1 text-[var(--text-primary)]">{decision.attempts ?? 0} {(decision.attempts ?? 0) === 1 ? 'attempt' : 'attempts'}</div></div>
                        <div><div className="text-[9px] font-bold uppercase tracking-wide text-[var(--text-secondary)]">Outcome</div><div className="mt-1 text-[var(--text-primary)]">{decision.placementCount ?? 0} placements</div></div>
                      </div>
                      <div className="mt-3 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-panel)] p-3"><div className="text-[9px] font-bold uppercase tracking-wide text-[var(--text-secondary)]">Decision reason</div><p className={`mt-1 text-xs leading-relaxed ${visualStatus === 'failed' ? 'font-medium text-[var(--status-warning)]' : 'text-[var(--text-primary)]'}`}>{decision.reason}</p></div>
                      {decision.details != null && <details className="mt-3"><summary className="cursor-pointer text-[11px] font-semibold text-[var(--text-secondary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--status-info)]">Decision audit details</summary><pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-panel)] p-3 text-[10px] leading-relaxed text-[var(--text-primary)]">{pretty(decision.details)}</pre></details>}
                    </div>
                  )}
                </article>
              );
            })}
          </div>
        </section>
      )}

      <section aria-labelledby="market-opportunities-heading" className="space-y-2">
        <div className="flex items-end justify-between gap-3 px-1">
          <div><h3 id="market-opportunities-heading" className="text-xs font-bold uppercase tracking-wider text-[var(--text-primary)]">Market opportunities</h3><p className="text-[10px] text-[var(--text-secondary)]">Evaluation, safety gates, placement, and final outcome</p></div>
          <span className="text-[10px] tabular-nums text-[var(--text-secondary)]">{trades.length} attempts</span>
        </div>
        <div className="space-y-3">
          {trades.map((trade) => {
            const open = expandedTrades.has(trade.tradeId);
            const totalDuration = trade.steps.reduce((sum, step) => sum + (step.durationMs ?? 0), 0);
            const failure = trade.steps.find((step) => step.errorReason)?.errorReason;
            return (
              <article key={trade.tradeId} className="overflow-hidden rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-panel)] shadow-sm">
                <button type="button" aria-expanded={open} aria-controls={`attempt-details-${trade.tradeId}`} aria-label={`${open ? 'Collapse' : 'Expand'} attempt for ${trade.marketTitle}, ${trade.status}, ${trade.steps.length} ${trade.steps.length === 1 ? 'stage' : 'stages'}${failure ? `, ${failure}` : ''}`} onClick={() => toggleTrade(trade.tradeId)} className="grid min-h-16 w-full grid-cols-[auto_minmax(0,1fr)] items-center gap-2 px-3 py-2.5 text-left hover:bg-[var(--surface-workspace)]/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--status-info)] sm:grid-cols-[auto_minmax(0,1fr)_auto] sm:px-4">
                  {open ? <ChevronDown className="h-4 w-4 text-[var(--text-secondary)]" /> : <ChevronRight className="h-4 w-4 text-[var(--text-secondary)]" />}
                  <span className="min-w-0">
                    <strong className="block truncate text-sm text-[var(--text-primary)]">{trade.marketTitle}</strong>
                    <span className="mt-0.5 block truncate text-[10px] text-[var(--text-secondary)]">{trade.marketId} · {trade.trigger}</span>
                    {failure && <span className="mt-1 block truncate text-[10px] font-medium text-[var(--status-warning)]">{failure}</span>}
                  </span>
                  <span className="col-start-2 flex flex-wrap items-center gap-2 sm:col-start-3 sm:row-start-1 sm:justify-end">
                    {trade.qualified != null && <span className="rounded-full border border-[var(--border-strong)] px-2 py-0.5 text-[9px] font-bold uppercase text-[var(--text-secondary)]">{trade.qualified ? 'Qualified' : 'Not qualified'}</span>}
                    <StatusBadge status={trade.status} />
                    <span className="whitespace-nowrap text-[10px] tabular-nums text-[var(--text-secondary)]">{formatDateTime(trade.startedAt)} · {trade.steps.length} {trade.steps.length === 1 ? 'stage' : 'stages'}{totalDuration > 0 ? ` · ${formatDuration(totalDuration)}` : ''}</span>
                  </span>
                </button>
                {open && (
                  <div id={`attempt-details-${trade.tradeId}`} data-testid={`attempt-details-${trade.tradeId}`} className="border-t border-[var(--border-subtle)] bg-[var(--surface-workspace)]/30 px-3 py-4 sm:px-5">
                    <div className="relative space-y-3 before:absolute before:bottom-4 before:left-[7px] before:top-4 before:w-px before:bg-[var(--border-strong)]">
                      {trade.steps.map((step, index) => (
                        <section key={step.id} className="relative grid grid-cols-[15px_minmax(0,1fr)] gap-3">
                          <span className={`relative z-10 mt-3 h-[15px] w-[15px] rounded-full border-2 bg-[var(--surface-panel)] ${step.responseStatus === 'passed' ? 'border-[var(--status-info)]' : step.responseStatus === 'failed' ? 'border-[var(--text-secondary)]' : 'border-[var(--status-warning)]'}`} />
                          <div className="min-w-0 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-panel)] p-3 sm:p-4">
                            <div className="flex flex-wrap items-start justify-between gap-2 border-b border-[var(--border-subtle)] pb-2">
                              <div><div className="text-[9px] font-bold uppercase tracking-widest text-[var(--text-secondary)]">Stage {index + 1} of {trade.steps.length}</div><h4 className="mt-0.5 text-xs font-semibold text-[var(--text-primary)]">{titleCase(step.step)}</h4></div>
                              <div className="flex flex-wrap items-center justify-end gap-2"><StatusBadge status={step.responseStatus} label={step.responseStatus} /><span className="inline-flex items-center gap-1 whitespace-nowrap text-[10px] tabular-nums text-[var(--text-secondary)]"><Clock3 className="h-3 w-3" />{formatTime(step.timestamp)} · {formatDuration(step.durationMs)}</span></div>
                            </div>
                            <p className="mt-3 text-xs leading-relaxed text-[var(--text-primary)]">{step.action}</p>
                            {step.errorReason && <div className="mt-2 rounded-md border-l-2 border-[var(--status-warning)] bg-[var(--status-warning)]/10 px-3 py-2 text-xs font-medium text-[var(--status-warning)]"><span className="mr-1 text-[9px] font-bold uppercase tracking-wide">Failure reason</span>{step.errorReason}</div>}
                            {step.qualificationOutcome && <span className="mt-2 inline-flex rounded-full border border-[var(--border-strong)] px-2 py-0.5 text-[9px] font-bold uppercase text-[var(--text-secondary)]">{step.qualificationOutcome === 'qualified' ? 'Qualified' : 'Not qualified'}</span>}
                            {(step.requestPayload != null || step.responsePayload != null || step.alertMetadata != null) && (
                              <details className="mt-3"><summary className="cursor-pointer text-[11px] font-semibold text-[var(--text-secondary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--status-info)]">Request / response / alert</summary><div className="mt-2 grid gap-2 lg:grid-cols-3"><div className="min-w-0"><div className="mb-1 text-[9px] font-bold uppercase tracking-wide text-[var(--text-secondary)]">Request</div><pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md bg-[var(--surface-workspace)] p-2 text-[10px] leading-relaxed text-[var(--text-primary)]">{pretty(step.requestPayload)}</pre></div><div className="min-w-0"><div className="mb-1 text-[9px] font-bold uppercase tracking-wide text-[var(--text-secondary)]">Response</div><pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md bg-[var(--surface-workspace)] p-2 text-[10px] leading-relaxed text-[var(--text-primary)]">{pretty(step.responsePayload)}</pre></div><div className="min-w-0"><div className="mb-1 text-[9px] font-bold uppercase tracking-wide text-[var(--text-secondary)]">Alert</div><pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md bg-[var(--surface-workspace)] p-2 text-[10px] leading-relaxed text-[var(--text-primary)]">{pretty(step.alertMetadata)}</pre></div></div></details>
                            )}
                          </div>
                        </section>
                      ))}
                    </div>
                  </div>
                )}
              </article>
            );
          })}
          {!loading && trades.length === 0 && <div className="rounded-xl border border-dashed border-[var(--border-strong)] py-12 text-center text-sm text-[var(--text-secondary)]">{qualifiedOnly ? 'No qualifying evaluations in the selected period.' : 'No BotTrader actions match these filters.'}</div>}
        </div>
        {nextCursor != null && <button type="button" onClick={() => void loadMore()} disabled={loading || loadingMore} className="min-h-11 w-full rounded-lg border border-[var(--border-strong)] bg-[var(--surface-panel)] px-4 text-xs font-semibold text-[var(--text-secondary)] hover:bg-[var(--surface-workspace)] hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--status-info)] disabled:cursor-wait disabled:opacity-60">{loadingMore ? 'Loading older action logs…' : 'Load older action logs'}</button>}
      </section>
    </section>
  );
}