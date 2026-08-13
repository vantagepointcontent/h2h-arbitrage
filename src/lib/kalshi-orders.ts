/**
 * HOOKUP-04 step 2 (FEAT-006): Kalshi order placement — REAL trading API.
 *
 * POST /trade-api/v2/portfolio/orders on api.elections.kalshi.com using the
 * existing RSA signing helpers (kalshi-auth.ts).
 *
 * SAFETY: This module is only reachable through executeArb(), which is only
 * reachable through /api/execute (manual-only, kill-switch + dry-run gated).
 * Never import this from the watcher/poller/scheduler.
 */
import { makeKalshiAuthHeaders } from './kalshi-auth';
import logger from './logger';
import type { VenueExecutionEvidence } from './execution-evidence';

// Trading (portfolio) endpoints live on the elections host — the
// external-api host used for market data does not accept authed
// portfolio calls (verified via WS work: same signing scheme, same host).
const KALSHI_TRADE_BASE = 'https://api.elections.kalshi.com/trade-api/v2';

export interface KalshiOrderParams {
  ticker: string;
  side: 'yes' | 'no';
  /** Number of contracts. */
  count: number;
  /** Limit price in CENTS (1-99). */
  priceCents: number;
  clientOrderId: string;
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
  if (!Array.isArray(fills) || fills.length !== 1) return null;
  const raw = fills[0];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const fill = raw as Record<string, unknown>;

  const fillId = nonEmptyString(fill.fill_id);
  const tradeId = nonEmptyString(fill.trade_id);
  const orderId = nonEmptyString(fill.order_id);
  const ticker = nonEmptyString(fill.ticker);
  const marketTicker = nonEmptyString(fill.market_ticker);
  if (!fillId || !tradeId || fillId !== tradeId) return null;
  if (!orderId || orderId !== submitted.orderId) return null;
  if (!ticker || !marketTicker || ticker !== marketTicker || ticker !== submitted.ticker) return null;
  if (fill.outcome_side !== submitted.outcomeSide) return null;

  const filledQuantity = parseKalshiCount(fill.count_fp);
  if (filledQuantity == null || filledQuantity <= 0) return null;
  const priceCents = parseExactCents(
    submitted.outcomeSide === 'yes' ? fill.yes_price_dollars : fill.no_price_dollars,
  );
  if (priceCents == null || priceCents <= 0 || priceCents >= 100) return null;
  const chargedFeeCents = parseExactCents(fill.fee_cost);
  if (chargedFeeCents == null) return null;
  if (!isVenueTimestamp(fill.created_time)) return null;

  return {
    venue: 'kalshi',
    filledQuantity,
    fillPrice: priceCents / 100,
    chargedFeeCents,
    executionId: fillId,
    venueTimestamp: fill.created_time,
    orderId,
    raw,
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
  if (p.priceCents < 1 || p.priceCents > 99) throw new Error(`Kalshi price out of range: ${p.priceCents}¢`);
  if (p.count < 1) throw new Error(`Kalshi count must be >= 1, got ${p.count}`);

  const path = '/trade-api/v2/portfolio/orders';
  const body = {
    ticker: p.ticker,
    client_order_id: p.clientOrderId,
    action: 'buy',
    side: p.side,
    count: Math.floor(p.count),
    type: 'limit',
    ...(p.side === 'yes' ? { yes_price: Math.round(p.priceCents) } : { no_price: Math.round(p.priceCents) }),
  };

  const res = await fetch(`${KALSHI_TRADE_BASE}/portfolio/orders`, {
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
  return attachFillEvidence({
    orderId: nonEmptyString(order?.order_id) ?? '',
    status: nonEmptyString(order?.status) ?? 'unknown',
    filledCount: parseKalshiCount(order?.fill_count_fp ?? order?.taker_fill_count ?? order?.fill_count),
    remainingCount: parseKalshiCount(order?.remaining_count_fp ?? order?.remaining_count),
    raw: data,
  }, { ticker: p.ticker, outcomeSide: p.side });
}

export async function cancelKalshiOrder(orderId: string): Promise<boolean> {
  const path = `/trade-api/v2/portfolio/orders/${orderId}`;
  const res = await fetch(`${KALSHI_TRADE_BASE}/portfolio/orders/${orderId}`, {
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
  if (p.priceCents < 1 || p.priceCents > 99) throw new Error(`Kalshi price out of range: ${p.priceCents}¢`);
  if (p.count < 1) throw new Error(`Kalshi count must be >= 1, got ${p.count}`);

  const path = '/trade-api/v2/portfolio/orders';
  const body = {
    ticker: p.ticker,
    client_order_id: p.clientOrderId,
    action: 'sell',
    side: p.side,
    count: Math.floor(p.count),
    type: 'limit',
    ...(p.side === 'yes' ? { yes_price: Math.round(p.priceCents) } : { no_price: Math.round(p.priceCents) }),
  };

  const res = await fetch(`${KALSHI_TRADE_BASE}/portfolio/orders`, {
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
  return attachFillEvidence({
    orderId: nonEmptyString(order?.order_id) ?? '',
    status: nonEmptyString(order?.status) ?? 'unknown',
    filledCount: parseKalshiCount(order?.fill_count_fp ?? order?.taker_fill_count ?? order?.fill_count),
    remainingCount: parseKalshiCount(order?.remaining_count_fp ?? order?.remaining_count),
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
