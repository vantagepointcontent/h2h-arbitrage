const FIXED_SCALE = 1_000_000n;
const POLYMARKET_FEE_DECIMALS = 5n;
const MICROUSD_PER_FEE_UNIT = 10n;

export interface PolymarketEconomicFeeSchedule {
  rateBps: number;
  exponent: number;
  takerOnly: boolean;
}

export interface PolymarketEconomicFeeAuthority {
  feesEnabled?: boolean;
  feeSchedule?: {
    rate: number;
    exponent: number;
    takerOnly: boolean;
    rebateRate: number;
  } | null;
}

function fixedPoint(value: number, label: string): bigint {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new Error(`Malformed ${label}`);
  const scaled = Math.round(value * Number(FIXED_SCALE));
  if (!Number.isSafeInteger(scaled)) throw new Error(`Malformed ${label}`);
  return BigInt(scaled);
}

function roundRatio(numerator: bigint, denominator: bigint): bigint {
  return (numerator + denominator / 2n) / denominator;
}

export function getPolymarketCategoryFeeRateBps(category?: string): number {
  const normalized = category?.trim().toLowerCase() ?? '';
  if (normalized.includes('geopolit')) return 0;
  if (normalized.includes('crypto')) return 700;
  if (normalized.includes('sport')) return 500;
  if (normalized.includes('politic') || normalized.includes('finance')) return 400;
  return 0;
}

/** Resolve an authoritative rate for executable economic calculations.
 * Category rates remain available separately for non-authoritative estimates;
 * missing or malformed Gamma authority always fails closed here. */
export function resolvePolymarketFeeRateBps(
  authority: PolymarketEconomicFeeAuthority,
  category?: string,
): number | null {
  void category; // retained for callers that also use the non-authoritative display fallback matrix
  if (authority.feesEnabled === false) return authority.feeSchedule == null ? 0 : null;
  if (authority.feesEnabled === true) {
    const schedule = authority.feeSchedule;
    if (!schedule || schedule.exponent !== 1 || schedule.takerOnly !== true
      || typeof schedule.rate !== 'number' || !Number.isFinite(schedule.rate)
      || schedule.rate < 0 || schedule.rate > 1
      || typeof schedule.rebateRate !== 'number' || !Number.isFinite(schedule.rebateRate)
      || schedule.rebateRate < 0 || schedule.rebateRate > 1) return null;
    const rateBps = Math.round(schedule.rate * 10_000);
    return Number.isSafeInteger(rateBps) && rateBps / 10_000 === schedule.rate ? rateBps : null;
  }
  return null;
}

/**
 * Calculate a Polymarket taker fee as integer millionths of USDC.
 *
 * The venue rounds the economic fee to five decimal USDC precision, so every
 * result is a multiple of 10 micro-USDC. Integer fixed-point arithmetic avoids
 * a floating-point rounding boundary becoming an accounting decision.
 */
export function calculatePolymarketFeeMicrousd(
  fills: Array<{ priceCents: number; size: number }>,
  schedule: PolymarketEconomicFeeSchedule,
): number {
  if (!Number.isSafeInteger(schedule.rateBps) || schedule.rateBps < 0 || schedule.rateBps > 10_000
    || schedule.exponent !== 1 || schedule.takerOnly !== true) {
    throw new Error('Malformed or unsupported Polymarket fee schedule');
  }

  let numerator = 0n;
  for (const fill of fills) {
    if (typeof fill?.priceCents !== 'number' || !Number.isFinite(fill.priceCents)) {
      throw new Error('Malformed Polymarket fill price');
    }
    const quantity = fixedPoint(fill.size, 'Polymarket fill size');
    const price = fixedPoint(fill.priceCents / 100, 'Polymarket fill price');
    if (price > FIXED_SCALE) throw new Error('Malformed Polymarket fill price');
    numerator += quantity * price * (FIXED_SCALE - price) * BigInt(schedule.rateBps);
  }

  // quantity, price and (1-price) each contribute a 1e6 denominator; rateBps
  // contributes 1e4. Multiplying by 1e5 yields venue fee units of 0.00001 USDC.
  const feeUnits = roundRatio(
    numerator * (10n ** POLYMARKET_FEE_DECIMALS),
    FIXED_SCALE ** 3n * 10_000n,
  );
  const microusd = feeUnits * MICROUSD_PER_FEE_UNIT;
  const result = Number(microusd);
  if (!Number.isSafeInteger(result)) throw new Error('Polymarket fee exceeds safe accounting range');
  return result;
}
