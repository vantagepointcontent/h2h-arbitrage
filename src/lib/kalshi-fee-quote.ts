const KALSHI_API_BASE = 'https://external-api.kalshi.com/trade-api/v2';
const FIXED_SCALE = 1_000_000n;
export const KALSHI_FEE_AUTHORITY_MAX_AGE_MS = 60_000;

export type KalshiFeeType = 'quadratic' | 'quadratic_with_maker_fees' | 'flat';
export type KalshiLiquidityRole = 'maker' | 'taker';

export interface KalshiFeeAuthority {
  marketTicker: string;
  eventTicker: string;
  seriesTicker: string;
  feeType: KalshiFeeType;
  feeMultiplierPpm: number;
  source: string;
  observedAt: string;
  version: string;
}

export interface KalshiFeeFill {
  priceCents: number;
  contracts: number;
  liquidityRole?: KalshiLiquidityRole;
}

export interface KalshiFeeOrder {
  fills: KalshiFeeFill[];
  chargedFeeCents?: number | null;
}

export interface KalshiFeeQuote extends KalshiFeeAuthority {
  liquidity: KalshiLiquidityRole | 'mixed';
  calculatedFeeCents: number;
  chargedFeeCents: number | null;
  effectiveFeeCents: number;
  orderCount: number;
  fillCount: number;
}

/** Compatibility-only authority for legacy pure calculations. Production
 * surfaces must replace this with resolveKalshiFeeAuthority() output. Keeping
 * the schedule constant here prevents divergent hard-coded 7% implementations. */
export const STANDARD_KALSHI_FEE_AUTHORITY: KalshiFeeAuthority = {
  marketTicker: 'legacy-unresolved',
  eventTicker: 'legacy-unresolved',
  seriesTicker: 'legacy-unresolved',
  feeType: 'quadratic',
  feeMultiplierPpm: 1_000_000,
  source: 'legacy-unresolved',
  observedAt: '1970-01-01T00:00:00.000Z',
  version: 'legacy-unresolved',
};

export function calculateKalshiFeeUsd(
  contracts: number,
  price: number,
  authority: KalshiFeeAuthority = STANDARD_KALSHI_FEE_AUTHORITY,
  liquidity: KalshiLiquidityRole = 'taker',
): number {
  if (contracts <= 0 || price <= 0 || price >= 1) return 0;
  return calculateKalshiFeeQuote(authority, liquidity, [{
    fills: [{ contracts, priceCents: price * 100 }],
  }]).calculatedFeeCents / 100;
}

export function calculateKalshiFeeCentsFromMultiplier(
  fills: KalshiFeeFill[],
  feeMultiplierPpm: number,
  feeType: KalshiFeeType = 'quadratic',
  liquidity: KalshiLiquidityRole = 'taker',
): number {
  return calculateKalshiFeeQuote({
    ...STANDARD_KALSHI_FEE_AUTHORITY,
    feeType,
    feeMultiplierPpm,
  }, liquidity, [{ fills }]).calculatedFeeCents;
}

interface ResolveDependencies {
  fetchJson?: (url: string) => Promise<Record<string, unknown>>;
  observedAt?: string;
}

function record(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(message);
  return value as Record<string, unknown>;
}

async function fetchFeeJson(url: string): Promise<Record<string, unknown>> {
  const response = await fetch(url, {
    headers: { Accept: 'application/json', 'User-Agent': 'h2h-arbitrage/1.0' },
    cache: 'no-store',
    signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok) throw new Error(`Authoritative Kalshi fee endpoint returned HTTP ${response.status}`);
  return record(await response.json(), 'Malformed authoritative Kalshi fee response');
}

function fixed(value: number, label: string): bigint {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${label} must be finite and non-negative`);
  const scaled = Math.round(value * Number(FIXED_SCALE));
  if (!Number.isSafeInteger(scaled)) throw new Error(`${label} exceeds fixed-point limits`);
  return BigInt(scaled);
}

function ceilRatio(numerator: bigint, denominator: bigint): number {
  const result = Number((numerator + denominator - 1n) / denominator);
  if (!Number.isSafeInteger(result)) throw new Error('Kalshi fee exceeds safe integer cents');
  return result;
}

function feeRatePpm(feeType: KalshiFeeType, liquidity: KalshiLiquidityRole): bigint {
  if (feeType === 'flat') return 0n;
  if (liquidity === 'maker') {
    if (feeType !== 'quadratic_with_maker_fees') return 0n;
    // Kalshi's maker schedule is 0.0175 * C * p * (1-p), or 1.75 cents at unit scale.
    return 1_750_000n;
  }
  // Kalshi's taker schedule is 0.07 * C * p * (1-p), or 7 cents at unit scale.
  return 7_000_000n;
}

function calculatedOrderFeeCents(
  authority: KalshiFeeAuthority,
  liquidity: KalshiLiquidityRole,
  order: KalshiFeeOrder,
): number {
  if (!Array.isArray(order.fills) || order.fills.length === 0) {
    throw new Error('Authoritative Kalshi order fills are required');
  }
  const multiplier = BigInt(authority.feeMultiplierPpm);
  let numerator = 0n;
  for (const fill of order.fills) {
    if (!fill || typeof fill !== 'object') throw new Error('Malformed authoritative Kalshi fill');
    const contracts = fixed(fill.contracts, 'Kalshi fill contracts');
    const probability = fixed(fill.priceCents / 100, 'Kalshi fill price');
    if (contracts <= 0n || probability > FIXED_SCALE) throw new Error('Malformed authoritative Kalshi fill');
    const fillLiquidity = fill.liquidityRole ?? liquidity;
    if (fillLiquidity !== 'maker' && fillLiquidity !== 'taker') throw new Error('Malformed Kalshi fill liquidity role');
    if (authority.feeType === 'flat') {
      // Kalshi's Specific Trading Fees schedule is two cents per contract,
      // scaled by the authoritative series/event fee multiplier.
      numerator += 2n * contracts * multiplier * FIXED_SCALE ** 3n;
    } else {
      const fillRate = feeRatePpm(authority.feeType, fillLiquidity);
      numerator += fillRate * contracts * probability * (FIXED_SCALE - probability) * multiplier;
    }
  }
  // Venue cent ceiling applies to each actual order after aggregating that order's fills.
  return ceilRatio(numerator, FIXED_SCALE ** 5n);
}

export function calculateKalshiFeeQuote(
  authority: KalshiFeeAuthority,
  liquidity: KalshiLiquidityRole,
  orders: KalshiFeeOrder[],
): KalshiFeeQuote {
  validateAuthority(authority);
  if (!Array.isArray(orders) || orders.length === 0) throw new Error('Authoritative Kalshi orders are required');
  let calculatedFeeCents = 0;
  let chargedFeeCents = 0;
  let hasCompleteChargedEvidence = true;
  let fillCount = 0;
  const liquidityRoles = new Set<KalshiLiquidityRole>();
  for (const order of orders) {
    calculatedFeeCents += calculatedOrderFeeCents(authority, liquidity, order);
    fillCount += order.fills.length;
    for (const fill of order.fills) liquidityRoles.add(fill.liquidityRole ?? liquidity);
    if (order.chargedFeeCents == null) {
      hasCompleteChargedEvidence = false;
    } else if (!Number.isSafeInteger(order.chargedFeeCents) || order.chargedFeeCents < 0) {
      throw new Error('Malformed authoritative Kalshi charged fee');
    } else {
      chargedFeeCents += order.chargedFeeCents;
    }
  }
  if (!Number.isSafeInteger(calculatedFeeCents) || !Number.isSafeInteger(chargedFeeCents)) {
    throw new Error('Kalshi fee exceeds safe integer cents');
  }
  return {
    ...authority,
    liquidity: liquidityRoles.size > 1 ? 'mixed' : (liquidityRoles.values().next().value ?? liquidity),
    calculatedFeeCents,
    chargedFeeCents: hasCompleteChargedEvidence ? chargedFeeCents : null,
    effectiveFeeCents: hasCompleteChargedEvidence ? chargedFeeCents : calculatedFeeCents,
    orderCount: orders.length,
    fillCount,
  };
}

function validateAuthority(authority: KalshiFeeAuthority): void {
  if (!authority.marketTicker?.trim() || !authority.eventTicker?.trim() || !authority.seriesTicker?.trim()
    || !authority.source?.trim() || !authority.version?.trim()
    || !['quadratic', 'quadratic_with_maker_fees', 'flat'].includes(authority.feeType)
    || !Number.isSafeInteger(authority.feeMultiplierPpm)
    || authority.feeMultiplierPpm < 0 || authority.feeMultiplierPpm > 10_000_000
    || !Number.isFinite(Date.parse(authority.observedAt))) {
    throw new Error('Missing, malformed, or unsupported authoritative Kalshi fee configuration');
  }
}

export function assertFreshKalshiFeeAuthority(
  authority: KalshiFeeAuthority,
  at: string,
  maxAgeMs = KALSHI_FEE_AUTHORITY_MAX_AGE_MS,
): void {
  validateAuthority(authority);
  const authorityMs = Date.parse(authority.observedAt);
  const atMs = Date.parse(at);
  if (!Number.isFinite(atMs) || !Number.isSafeInteger(maxAgeMs) || maxAgeMs < 0
    || authorityMs > atMs || atMs - authorityMs > maxAgeMs) {
    throw new Error('Stale authoritative Kalshi fee configuration');
  }
}

export async function resolveKalshiFeeAuthority(
  marketTicker: string,
  dependencies: ResolveDependencies = {},
): Promise<KalshiFeeAuthority> {
  if (typeof marketTicker !== 'string' || !marketTicker.trim()) throw new Error('Kalshi market ticker is required');
  const ticker = marketTicker.trim();
  const getJson = dependencies.fetchJson ?? fetchFeeJson;
  const market = record((await getJson(`${KALSHI_API_BASE}/markets/${encodeURIComponent(ticker)}`)).market,
    'Malformed Kalshi market fee metadata');
  const eventTicker = market.event_ticker;
  if (typeof eventTicker !== 'string' || !eventTicker.trim()) throw new Error('Kalshi market is missing authoritative event metadata');
  const event = record((await getJson(`${KALSHI_API_BASE}/events/${encodeURIComponent(eventTicker)}`)).event,
    'Malformed Kalshi event fee metadata');
  const seriesTicker = event.series_ticker;
  if (typeof seriesTicker !== 'string' || !seriesTicker.trim()) throw new Error('Kalshi event is missing authoritative series metadata');
  const series = record((await getJson(`${KALSHI_API_BASE}/series/${encodeURIComponent(seriesTicker)}`)).series,
    'Malformed Kalshi series fee metadata');

  const overrideType = event.fee_type_override;
  const overrideMultiplier = event.fee_multiplier_override;
  const hasOverride = overrideType != null || overrideMultiplier != null;
  if (hasOverride && (overrideType == null || overrideMultiplier == null)) {
    throw new Error('Conflicting Kalshi event fee override');
  }
  const feeType = (hasOverride ? overrideType : series.fee_type) as KalshiFeeType;
  const multiplier = hasOverride ? overrideMultiplier : series.fee_multiplier;
  if (!['quadratic', 'quadratic_with_maker_fees', 'flat'].includes(feeType)
    || typeof multiplier !== 'number' || !Number.isFinite(multiplier) || multiplier < 0 || multiplier > 10) {
    throw new Error('Missing, malformed, or unsupported authoritative Kalshi fee configuration');
  }
  const feeMultiplierPpm = Math.round(multiplier * 1_000_000);
  const observedAt = dependencies.observedAt ?? new Date().toISOString();
  if (!Number.isFinite(Date.parse(observedAt))) throw new Error('Malformed fee observation timestamp');
  const source = hasOverride
    ? `${KALSHI_API_BASE}/events/${encodeURIComponent(eventTicker)}`
    : `${KALSHI_API_BASE}/series/${encodeURIComponent(seriesTicker)}`;
  const upstreamVersion = hasOverride ? event.last_updated_ts : series.last_updated_ts;
  const authority: KalshiFeeAuthority = {
    marketTicker: ticker,
    eventTicker: eventTicker.trim(),
    seriesTicker: seriesTicker.trim(),
    feeType,
    feeMultiplierPpm,
    source,
    observedAt,
    version: `${feeType}:${feeMultiplierPpm}:${String(upstreamVersion ?? 'upstream-version-unavailable')}`,
  };
  validateAuthority(authority);
  return authority;
}
