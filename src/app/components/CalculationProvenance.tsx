import type { CalculationEnvelope, CalculationLeg } from '@/lib/calculation-envelope';

const INTEGER = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
const TIMESTAMP = new Intl.DateTimeFormat('en-US', {
  dateStyle: 'medium',
  timeStyle: 'medium',
  timeZone: 'UTC',
});

const STATUS_LABELS: Record<CalculationEnvelope['status'], string> = {
  executable: 'Executable',
  non_executable: 'Non-executable',
  unavailable: 'Unavailable',
  legacy_unverifiable: 'Legacy / unverifiable',
};

function formatMicros(value: number | null, kind: 'money' | 'price' | 'quantity'): string {
  if (value == null) return 'Unavailable';
  if (!Number.isSafeInteger(value)) return 'Unavailable';
  const sign = value < 0 ? '-' : '';
  const absolute = BigInt(value < 0 ? -value : value);
  const whole = absolute / 1_000_000n;
  const rawFraction = (absolute % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '');
  const fraction = kind === 'money' ? rawFraction.padEnd(2, '0') : rawFraction;
  const formatted = `${INTEGER.format(whole)}${fraction ? `.${fraction}` : ''}`;
  if (kind === 'money') return `${sign}$${formatted}`;
  if (kind === 'price') return `${sign}${formatted}`;
  return `${sign}${formatted} share${absolute === 1_000_000n ? '' : 's'}`;
}

function formatTimestamp(value: string | null): string {
  if (!value) return 'Unavailable';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Unavailable' : `${TIMESTAMP.format(date)} UTC`;
}

function feeLabel(leg: CalculationLeg): string {
  if (leg.fee.basis === 'unavailable' || leg.fee.amountMicros == null) return 'Fee unavailable';
  const basis = leg.fee.basis === 'charged' ? 'Charged' : 'Calculated';
  const phase = leg.action === 'sell' ? 'exit' : 'entry';
  return `${basis} ${phase} fee ${formatMicros(leg.fee.amountMicros, 'money')}`;
}

function tone(status: CalculationEnvelope['status']): string {
  if (status === 'executable') return 'border-[#55B7FF]/35 bg-[#55B7FF]/5 text-[#55B7FF]';
  if (status === 'non_executable') return 'border-[var(--status-warning)]/35 bg-[var(--status-warning)]/5 text-[var(--status-warning)]';
  return 'border-[var(--border-strong)] bg-[var(--surface-workspace)] text-[var(--text-secondary)]';
}

export function CalculationProvenance({
  envelope,
  compact = false,
}: {
  envelope: CalculationEnvelope;
  compact?: boolean;
}) {
  const quantities = [
    `Requested ${formatMicros(envelope.requestedQuantityMicros, 'quantity')}`,
    `Executable ${formatMicros(envelope.executableQuantityMicros, 'quantity')}`,
  ];

  return (
    <section
      data-testid="calculation-provenance"
      aria-label="Canonical calculation provenance"
      className={`overflow-x-auto rounded-lg border px-3 py-2 text-[10px] ${tone(envelope.status)}`}
    >
      <div className="flex min-w-max flex-wrap items-center gap-x-3 gap-y-1">
        <span className="font-semibold uppercase tracking-wide">Calculation v{envelope.version}</span>
        <span className="rounded-full border border-current/30 px-2 py-0.5 font-semibold">{STATUS_LABELS[envelope.status]}</span>
        {quantities.map((quantity) => <span key={quantity} className="tabular-nums">{quantity}</span>)}
        <span>Calculated at {formatTimestamp(envelope.calculatedAt)}</span>
      </div>

      {envelope.blocker && (
        <div role="status" className="mt-2 rounded border border-current/20 px-2 py-1 font-medium">
          {envelope.blocker.message} <span className="font-mono opacity-75">({envelope.blocker.code})</span>
        </div>
      )}

      <div className="mt-2 grid min-w-[36rem] grid-cols-5 gap-2 border-t border-current/15 pt-2 tabular-nums">
        <div><span className="block opacity-70">Gross cost</span>{formatMicros(envelope.totals.grossCostMicros, 'money')}</div>
        <div><span className="block opacity-70">Gross payout</span>{formatMicros(envelope.totals.grossPayoutMicros, 'money')}</div>
        <div><span className="block opacity-70">Gross profit</span>{formatMicros(envelope.totals.grossProfitMicros, 'money')}</div>
        <div><span className="block opacity-70">Fees</span>{formatMicros(envelope.totals.totalFeesMicros, 'money')}</div>
        <div><span className="block opacity-70">Net P&amp;L</span>{formatMicros(envelope.totals.netPnlMicros, 'money')}</div>
      </div>

      {envelope.legs.length > 0 && (
        <div data-testid="calculation-provenance-legs" className="mt-2 grid min-w-[36rem] gap-2 border-t border-current/15 pt-2 sm:grid-cols-2">
          {envelope.legs.map((leg, index) => (
            <div key={`${leg.venue}-${leg.instrumentId}-${leg.side}-${index}`} className="rounded border border-current/15 px-2 py-1.5">
              <div className="flex items-center justify-between gap-3 font-semibold">
                <span>{leg.venue} · {leg.side.toUpperCase()} · {leg.action.toUpperCase()}</span>
                <span>{feeLabel(leg)}</span>
              </div>
              <div className="mt-1 tabular-nums opacity-80">
                Requested {formatMicros(leg.requestedQuantityMicros, 'quantity')} · Executable {formatMicros(leg.executableQuantityMicros, 'quantity')}
                {leg.vwapPriceMicros != null ? ` · VWAP ${formatMicros(leg.vwapPriceMicros, 'price')}` : ''}
              </div>
              <div className="mt-1 opacity-75">Book observed {formatTimestamp(leg.bookObservedAt)}</div>
              {leg.fee.schedule ? (
                <div className="opacity-75">
                  {leg.fee.schedule.source} · {leg.fee.schedule.version} · authority observed {formatTimestamp(leg.fee.schedule.observedAt)}
                </div>
              ) : (
                <div className="font-medium opacity-90">Fee authority unavailable</div>
              )}
              {!compact && leg.fillLevels.length > 0 && (
                <div className="mt-1 font-mono opacity-70">
                  Fills: {leg.fillLevels.map((level) => `${formatMicros(level.quantityMicros, 'quantity')} @ ${formatMicros(level.priceMicros, 'price')}`).join(' · ')}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
