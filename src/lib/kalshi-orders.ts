/**
 * HOOKUP-04 step 2 (FEAT-006): Kalshi order placement — REAL trading API.
 *
 * POST /trade-api/v2/portfolio/events/orders on api.elections.kalshi.com using the
 * existing RSA signing helpers (kalshi-auth.ts).
 *
 * SAFETY: This module is only reachable through executeArb(), which is only
 * reachable through /api/execute (manual-only, kill-switch + dry-run gated).
 * Never import this from the watcher/poller/scheduler.
 */
import { makeKalshiAuthHeaders } from './kalshi-auth';
import logger from './logger';
import type { VenueExecutionEvidence, VenueExecutionFill } from './execution-evidence';

// Trading (portfolio) endpoints live on the elections host — the
// external-api host used for market data does not accept authed
// portfolio calls (verified via WS work: same signing scheme, same host).
const KALSHI_TRADE_BASE = 'https://api.elections.kalshi.com/trade-api/v2';

export interface KalshiOrderParams {
  ticker: string;
  side: 'yes' | 'no';
  /** Number of contracts. */
  count: number;
  /** Exact selected-outcome limit in millionths of one cent. */
  priceMicroCents?: number;
  /** Authoritative market increment in millionths of one cent. */
  tickSizeMicroCents?: number;
  /** @deprecated Compatibility-only input; never used for placement. */
  priceCents?: number;
  clientOrderId: string;
}

const MICRO_CENTS_PER_DOLLAR = 100_000_000;
// Kalshi order requests accept prices to four decimal places.
const MICRO_CENTS_PER_ORDER_PRICE_QUANTUM = 10_000;

function fixedPointDollars(priceMicroCents: number): string {
  if (priceMicroCents % MICRO_CENTS_PER_ORDER_PRICE_QUANTUM !== 0) {
    throw new Error(`Kalshi price ${priceMicroCents} microcents exceeds the API's fixed-point precision`);
  }
  const tenThousandths = priceMicroCents / MICRO_CENTS_PER_ORDER_PRICE_QUANTUM;
  const whole = Math.floor(tenThousandths / 10_000);
  const fraction = String(tenThousandths % 10_000).padStart(4, '0').replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : String(whole);
}

function validateOrderParams(
  p: KalshiOrderParams,
  action: 'buy' | 'sell',
): asserts p is KalshiOrderParams & { priceMicroCents: number; tickSizeMicroCents: number } {
  if (typeof p.priceMicroCents !== 'number' || !Number.isSafeInteger(p.priceMicroCents)
      || p.priceMicroCents <= 0 || p.priceMicroCents >= MICRO_CENTS_PER_DOLLAR) {
    throw new Error(`Kalshi price is malformed or out of range: ${String(p.priceMicroCents)} microcents`);
  }
  if (typeof p.tickSizeMicroCents !== 'number'
      || !Number.isSafeInteger(p.tickSizeMicroCents) || p.tickSizeMicroCents <= 0) {
    throw new Error(`Kalshi tick metadata is missing or malformed: ${String(p.tickSizeMicroCents)}`);
  }
  if (p.tickSizeMicroCents % MICRO_CENTS_PER_ORDER_PRICE_QUANTUM !== 0
      || MICRO_CENTS_PER_DOLLAR % p.tickSizeMicroCents !== 0) {
    throw new Error(`Kalshi tick ${p.tickSizeMicroCents} microcents is unsupported by the fixed-point order API`);
  }
  if (p.priceMicroCents % p.tickSizeMicroCents !== 0) {
    throw new Error(`Kalshi price ${p.priceMicroCents} microcents is off tick ${p.tickSizeMicroCents}`);
  }
  if (!Number.isSafeInteger(p.count) || p.count < 1) {
    throw new Error(`Kalshi count must be a positive integer, got ${p.count}`);
  }
  if (action === 'buy' && p.count !== 1) {
    throw new Error(`Kalshi entry count must be exactly 1, got ${p.count}`);
  }
}

function exactOrderParams(p: KalshiOrderParams): KalshiOrderParams {
  // Whole-cent prices are valid in every Kalshi price-level structure. Keep
  // legacy manual closes working only when their integer-cent value is exact;
  // all sub-cent entry paths must carry authoritative tick metadata.
  if (p.priceMicroCents == null && p.tickSizeMicroCents == null
      && typeof p.priceCents === 'number' && Number.isSafeInteger(p.priceCents)
      && p.priceCents > 0 && p.priceCents < 100) {
    return {
      ...p,
      priceMicroCents: p.priceCents * 1_000_000,
      tickSizeMicroCents: 1_000_000,
    };
  }
  return p;
}

function createV2Body(p: KalshiOrderParams, action: 'buy' | 'sell') {
  validateOrderParams(p, action);
  const yesPriceMicroCents = p.side === 'yes'
    ? p.priceMicroCents
    : MICRO_CENTS_PER_DOLLAR - p.priceMicroCents;
  const bookSide = action === 'buy'
    ? (p.side === 'yes' ? 'bid' : 'ask')
    : (p.side === 'yes' ? 'ask' : 'bid');
  return {
    ticker: p.ticker,
    client_order_id: p.clientOrderId,
    side: bookSide,
    count: String(p.count),
    price: fixedPointDollars(yesPriceMicroCents),
    time_in_force: 'immediate_or_cancel',
    self_trade_prevention_type: 'taker_at_cross',
  };
}

function v2Status(filledCount: number | undefined, remainingCount: number | undefined, count: number): string {
  if (filledCount === count) return 'executed';
  if (filledCount != null && filledCount > 0) return 'partial';
  if (filledCount === 0 && remainingCount === 0) return 'canceled';
  return 'pending';
}

export interface KalshiOrderResponse {
  orderId: string;
  status: string;          // resting | executed | canceled | pending
  /** Undefined means Kalshi omitted the authoritative cumulative fill count. */
  filledCount: number | undefined;
  remainingCount: number | undefined;
  evidence?: KalshiFillEvidence;
  raw: unknown;
}

export interface KalshiFillEvidence extends VenueExecutionEvidence {
  venue: 'kalshi';
  orderId: string;
  chargedFeeCents: number;
}

export interface SubmittedKalshiOrder {
  orderId: string;
  ticker: string;
  outcomeSide: 'yes' | 'no';
}

export function parseKalshiCount(value: unknown): number | undefined {
  if (value === null || value === undefined || value === '') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function parseExactCents(value: unknown): number | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const text = String(value);
  if (!/^\d+(?:\.\d{1,2})?$/.test(text)) return null;
  const [whole, fraction = ''] = text.split('.');
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  return Number.isSafeInteger(cents) ? cents : null;
}

function parseFixedPointDollars(value: unknown): number | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const text = String(value).trim();
  if (!/^\d+(?:\.\d+)?$/.test(text)) return null;
  const dollars = Number(text);
  return Number.isFinite(dollars) ? dollars : null;
}

function isVenueTimestamp(value: unknown): value is string {
  return typeof value === 'string'
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
    && !Number.isNaN(Date.parse(value));
}

export function parseKalshiFillEvidence(
  response: unknown,
  submitted: SubmittedKalshiOrder,
): KalshiFillEvidence | null {
  if (!response || typeof response !== 'object') return null;
  const fills = (response as Record<string, unknown>).fills;
  if (!Array.isArray(fills) || fills.length === 0) return null;
  const parsed: VenueExecutionFill[] = [];
  const ids = new Set<string>();
  for (const raw of fills) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const fill = raw as Record<string, unknown>;
    const fillId = nonEmptyString(fill.fill_id);
    const tradeId = nonEmptyString(fill.trade_id);
    const orderId = nonEmptyString(fill.order_id);
    const ticker = nonEmptyString(fill.ticker);
    const marketTicker = nonEmptyString(fill.market_ticker);
    if (!fillId || !tradeId || fillId !== tradeId || ids.has(fillId)) return null;
    if (!orderId || orderId !== submitted.orderId) return null;
    if (!ticker || !marketTicker || ticker !== marketTicker || ticker !== submitted.ticker) return null;
    if (fill.outcome_side !== submitted.outcomeSide) return null;
    const quantity = parseKalshiCount(fill.count_fp);
    if (quantity == null || !Number.isSafeInteger(quantity) || quantity <= 0) return null;
    const price = parseFixedPointDollars(submitted.outcomeSide === 'yes' ? fill.yes_price_dollars : fill.no_price_dollars);
    const chargedFeeCents = parseExactCents(fill.fee_cost);
    if (price == null || price <= 0 || price >= 1 || chargedFeeCents == null
      || typeof fill.is_taker !== 'boolean' || !isVenueTimestamp(fill.created_time)) return null;
    ids.add(fillId);
    parsed.push({
      executionId: fillId, quantity, price, chargedFeeCents,
      venueTimestamp: fill.created_time,
      liquidityRole: fill.is_taker ? 'taker' as const : 'maker' as const,
    });
  }
  const filledQuantity = parsed.reduce((total, fill) => total + fill.quantity, 0);
  const chargedFeeCents = parsed.reduce((total, fill) => total + fill.chargedFeeCents, 0);
  const fillPrice = parsed.length === 1
    ? parsed[0].price
    : parsed.reduce((total, fill) => total + fill.quantity * fill.price, 0) / filledQuantity;
  const venueTimestamp = parsed.map((fill) => fill.venueTimestamp).sort().at(-1)!;
  const commonLiquidityRole = parsed.every((fill) => fill.liquidityRole === parsed[0].liquidityRole)
    ? parsed[0].liquidityRole
    : undefined;

  return {
    venue: 'kalshi',
    filledQuantity,
    fillPrice,
    chargedFeeCents,
    executionId: fills.length === 1 ? parsed[0].executionId : submitted.orderId,
    venueTimestamp,
    orderId: submitted.orderId,
    ...(commonLiquidityRole ? { liquidityRole: commonLiquidityRole } : {}),
    ...(fills.length > 1 ? { fills: parsed } : {}),
    raw: fills.length === 1 ? fills[0] : fills,
  };
}

export async function getKalshiFillEvidence(
  submitted: SubmittedKalshiOrder,
): Promise<KalshiFillEvidence | null> {
  const query = new URLSearchParams({ order_id: submitted.orderId }).toString();
  const path = '/trade-api/v2/portfolio/fills';
  const res = await fetch(`${KALSHI_TRADE_BASE}/portfolio/fills?${query}`, {
    method: 'GET',
    headers: makeKalshiAuthHeaders('GET', path),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) return null;
  const data = await res.json().catch(() => null);
  return parseKalshiFillEvidence(data, submitted);
}

async function attachFillEvidence(
  response: KalshiOrderResponse,
  submitted: Omit<SubmittedKalshiOrder, 'orderId'>,
): Promise<KalshiOrderResponse> {
  if (!response.orderId || response.filledCount == null || response.filledCount <= 0) return response;
  const evidence = await getKalshiFillEvidence({ ...submitted, orderId: response.orderId });
  return evidence && evidence.filledQuantity === response.filledCount
    ? { ...response, evidence }
    : response;
}

export async function placeKalshiOrder(p: KalshiOrderParams): Promise<KalshiOrderResponse> {
  p = exactOrderParams(p);
  const path = '/trade-api/v2/portfolio/events/orders';
  const body = createV2Body(p, 'buy');
  logger.info('[kalshi-orders] submitting exact order', {
    ticker: p.ticker, action: 'buy', outcome: p.side, bookSide: body.side,
    priceMicroCents: p.priceMicroCents, tickSizeMicroCents: p.tickSizeMicroCents, wirePrice: body.price,
  });

  const res = await fetch(`${KALSHI_TRADE_BASE}/portfolio/events/orders`, {
    method: 'POST',
    headers: { ...makeKalshiAuthHeaders('POST', path), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const payload = asRecord(data);
    const msg = nonEmptyString(asRecord(payload?.error)?.message)
      || nonEmptyString(payload?.message)
      || `HTTP ${res.status}`;
    logger.error('[kalshi-orders] order rejected', { ticker: p.ticker, status: res.status, msg });
    throw new Error(`Kalshi order failed: ${msg}`);
  }

  const payload = asRecord(data);
  const order = asRecord(payload?.order) ?? payload;
  const filledCount = parseKalshiCount(order?.immediate_fill_count ?? order?.fill_count_fp ?? order?.fill_count);
  const remainingCount = parseKalshiCount(order?.remaining_count_fp ?? order?.remaining_count);
  return attachFillEvidence({
    orderId: nonEmptyString(order?.order_id) ?? '',
    status: nonEmptyString(order?.status) ?? v2Status(filledCount, remainingCount, p.count),
    filledCount,
    remainingCount,
    raw: data,
  }, { ticker: p.ticker, outcomeSide: p.side });
}

export async function cancelKalshiOrder(orderId: string): Promise<boolean> {
  const path = `/trade-api/v2/portfolio/events/orders/${orderId}`;
  const res = await fetch(`${KALSHI_TRADE_BASE}/portfolio/events/orders/${orderId}`, {
    method: 'DELETE',
    headers: makeKalshiAuthHeaders('DELETE', path),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    logger.warn('[kalshi-orders] cancel failed', { orderId, status: res.status });
    return false;
  }
  return true;
}

/** Place a SELL order to close an existing position (auto-close on partial-fill failure). */
export async function placeKalshiSellOrder(p: KalshiOrderParams): Promise<KalshiOrderResponse> {
  p = exactOrderParams(p);
  const path = '/trade-api/v2/portfolio/events/orders';
  const body = createV2Body(p, 'sell');
  logger.info('[kalshi-orders] submitting exact order', {
    ticker: p.ticker, action: 'sell', outcome: p.side, bookSide: body.side,
    priceMicroCents: p.priceMicroCents, tickSizeMicroCents: p.tickSizeMicroCents, wirePrice: body.price,
  });

  const res = await fetch(`${KALSHI_TRADE_BASE}/portfolio/events/orders`, {
    method: 'POST',
    headers: { ...makeKalshiAuthHeaders('POST', path), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const payload = asRecord(data);
    const msg = nonEmptyString(asRecord(payload?.error)?.message)
      || nonEmptyString(payload?.message)
      || `HTTP ${res.status}`;
    logger.error('[kalshi-orders] sell order rejected', { ticker: p.ticker, status: res.status, msg });
    throw new Error(`Kalshi sell order failed: ${msg}`);
  }

  const payload = asRecord(data);
  const order = asRecord(payload?.order) ?? payload;
  const filledCount = parseKalshiCount(order?.immediate_fill_count ?? order?.fill_count_fp ?? order?.fill_count);
  const remainingCount = parseKalshiCount(order?.remaining_count_fp ?? order?.remaining_count);
  return attachFillEvidence({
    orderId: nonEmptyString(order?.order_id) ?? '',
    status: nonEmptyString(order?.status) ?? v2Status(filledCount, remainingCount, p.count),
    filledCount,
    remainingCount,
    raw: data,
  }, { ticker: p.ticker, outcomeSide: p.side });
}

/** Poll a single order's status (used to confirm fills after placement). */
export async function getKalshiOrder(orderId: string): Promise<KalshiOrderResponse | null> {
  const path = `/trade-api/v2/portfolio/orders/${orderId}`;
  const res = await fetch(`${KALSHI_TRADE_BASE}/portfolio/orders/${orderId}`, {
    method: 'GET',
    headers: makeKalshiAuthHeaders('GET', path),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) return null;
  const data = await res.json().catch(() => null);
  const order = asRecord(asRecord(data)?.order);
  if (!order) return null;
  const parsed: KalshiOrderResponse = {
    orderId: nonEmptyString(order.order_id) ?? '',
    status: nonEmptyString(order.status) ?? 'unknown',
    filledCount: parseKalshiCount(order.fill_count_fp ?? order.taker_fill_count ?? order.fill_count),
    remainingCount: parseKalshiCount(order.remaining_count_fp ?? order.remaining_count),
    raw: data,
  };
  const ticker = nonEmptyString(order.ticker);
  const outcomeSide = order.outcome_side === 'yes' || order.outcome_side === 'no'
    ? order.outcome_side
    : null;
  if (!ticker || !outcomeSide) return parsed;
  return attachFillEvidence(parsed, { ticker, outcomeSide });
}
