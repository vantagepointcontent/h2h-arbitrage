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
  raw: unknown;
}

export function parseKalshiCount(value: unknown): number | undefined {
  if (value === null || value === undefined || value === '') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
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
    const msg = (data as any)?.error?.message || (data as any)?.message || `HTTP ${res.status}`;
    logger.error('[kalshi-orders] order rejected', { ticker: p.ticker, status: res.status, msg });
    throw new Error(`Kalshi order failed: ${msg}`);
  }

  const order = (data as any)?.order ?? data;
  return {
    orderId: order?.order_id ?? '',
    status: order?.status ?? 'unknown',
    filledCount: parseKalshiCount(order?.taker_fill_count ?? order?.fill_count),
    remainingCount: parseKalshiCount(order?.remaining_count),
    raw: data,
  };
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
    const msg = (data as any)?.error?.message || (data as any)?.message || `HTTP ${res.status}`;
    logger.error('[kalshi-orders] sell order rejected', { ticker: p.ticker, status: res.status, msg });
    throw new Error(`Kalshi sell order failed: ${msg}`);
  }

  const order = (data as any)?.order ?? data;
  return {
    orderId: order?.order_id ?? '',
    status: order?.status ?? 'unknown',
    filledCount: parseKalshiCount(order?.taker_fill_count ?? order?.fill_count),
    remainingCount: parseKalshiCount(order?.remaining_count),
    raw: data,
  };
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
  const order = (data as any)?.order;
  if (!order) return null;
  return {
    orderId: order.order_id,
    status: order.status,
    filledCount: parseKalshiCount(order.taker_fill_count ?? order.fill_count),
    remainingCount: parseKalshiCount(order.remaining_count),
    raw: data,
  };
}
