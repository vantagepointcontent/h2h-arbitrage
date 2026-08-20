export interface OpenPositionPnlProjectionInput {
  currentValueCents: number | null;
  buyCostCents: number | null;
  indicativePnlMicrocents?: number | null;
  realizedPnlCents?: number | null;
}

function roundMicrocentsToCents(value: number): number | null {
  if (!Number.isSafeInteger(value)) return null;
  const numerator = BigInt(value);
  const absolute = numerator < 0n ? -numerator : numerator;
  const rounded = (absolute + 500_000n) / 1_000_000n;
  return Number(numerator < 0n ? -rounded : rounded);
}

/**
 * Canonical integer-cent P&L shown for one persisted open-position row.
 * Portfolio summaries must sum this row projection rather than rounding an
 * exact portfolio aggregate, so the meter reconciles to the visible rows.
 */
export function projectOpenPositionPnlCents({
  currentValueCents,
  buyCostCents,
  indicativePnlMicrocents,
  realizedPnlCents,
}: OpenPositionPnlProjectionInput): number | null {
  if (!Number.isSafeInteger(currentValueCents) || currentValueCents! < 0
    || !Number.isSafeInteger(buyCostCents) || buyCostCents! < 0) return null;
  if (indicativePnlMicrocents != null) return roundMicrocentsToCents(indicativePnlMicrocents);
  if (realizedPnlCents != null && !Number.isSafeInteger(realizedPnlCents)) return null;
  const pnlCents = (realizedPnlCents ?? 0) + currentValueCents! - buyCostCents!;
  return Number.isSafeInteger(pnlCents) ? pnlCents : null;
}
