'use client';

import {
  formatPercent,
  formatRelativeTime,
  getCanonicalCurrentMarketMetrics,
  getMarketApySummary,
  getQuickApyProvenance,
  type SavedMarket,
  type ScanResult,
} from '@/app/lib/page-shared';

export function SelectedMarketApyProvenance({ market, result }: { market: SavedMarket; result: ScanResult }) {
  const persisted = getMarketApySummary(market);
  const current = getCanonicalCurrentMarketMetrics(market);
  const quick = getQuickApyProvenance(result);
  const quickStatus = quick.status === 'partial'
    ? 'partial refresh'
    : quick.status === 'failed'
      ? 'failed refresh'
      : quick.status === 'stale'
        ? 'stale refresh'
        : quick.status === 'unavailable'
          ? 'unavailable refresh'
          : null;

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-raised)] px-3 py-2 text-[11px] text-[var(--text-secondary)]" data-testid="selected-market-apy-provenance">
      <span title="This full-precision persisted value controls Saved Markets APY sorting.">
        Persisted scan ROI/APY: <strong className="text-[var(--text-primary)]">{current.valid ? `${formatPercent(current.roiPct!)} (${formatPercent(persisted.scalarApyPct!)})` : 'Unavailable'}</strong>
        {current.valid ? ` · ${current.strategy} · ${current.daysToExpiry!.toFixed(2)}d TTE` : ''}
        {persisted.observedAt ? ` · ${formatRelativeTime(persisted.observedAt)}` : ''}
        {persisted.revision != null ? ` · revision ${persisted.revision}` : ''}
      </span>
      {quick.observedAt && (
        <span title="Current quick APY is contextual and does not reorder Saved Markets.">
          Current quick APY: <strong className="text-[var(--text-primary)]">{quick.apyPct == null ? 'Unavailable' : formatPercent(quick.apyPct)}</strong>
          {quickStatus ? ` · ${quickStatus}` : ''}
          {quick.reason ? ` · ${quick.reason}` : ''}
          {` · ${formatRelativeTime(quick.observedAt)}`}
        </span>
      )}
      <span className="text-[var(--text-faint)]">Saved Markets sorts by persisted scan APY.</span>
    </div>
  );
}
