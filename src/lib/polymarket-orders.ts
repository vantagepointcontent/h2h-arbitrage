/**
 * HOOKUP-04 step 2 (FEAT-006): Polymarket order placement — REAL trading API.
 *
 * Uses @polymarket/clob-client v5 (official) with a viem wallet signer (EOA)
 * and L2 API credentials. Credentials come from env (execution-creds.ts):
 *   POLYMARKET_PRIVATE_KEY    — EOA wallet key (EIP-712 order signing)
 *   POLYMARKET_API_KEY/SECRET/PASSPHRASE — CLOB L2 auth
 *
 * SAFETY: only reachable through executeArb() → /api/execute (manual-only).
 */
import logger from './logger';
import type { ClobClient } from '@polymarket/clob-client';
import type { VenueExecutionEvidence } from './execution-evidence';

const CLOB_HOST = 'https://clob.polymarket.com';
const POLYGON_CHAIN_ID = 137;

export interface PmOrderParams {
  tokenId: string;
  /** Limit price, decimal 0-1. */
  price: number;
  /** Number of shares (contracts). */
  size: number;
}

export interface PmOrderResponse {
  orderId: string;
  status: string;         // matched | live | delayed | unmatched
  success: boolean;
  filledContracts: number | null;
  /** Present only when every required fact came from correlated venue evidence. */
  venueEvidence?: VenueExecutionEvidence;
  raw: unknown;
}

export interface SubmittedPmOrder {
  orderId: string;
  tokenId: string;
  side: 'BUY' | 'SELL';
}

export function parsePmFilledContracts(raw: unknown): number | null {
  if (!raw || typeof raw !== 'object') return null;
  const order = raw as Record<string, unknown>;
  const value = order.size_matched ?? order.sizeMatched;
  const parsed = typeof value === 'number' || typeof value === 'string' ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function positiveNumber(value: unknown): number | null {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  if (value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function isVenueTimestamp(value: unknown): value is string {
  return typeof value === 'string'
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
    && !Number.isNaN(Date.parse(value));
}

/**
 * Validate the facts the installed CLOB Trade contract can prove.
 *
 * @polymarket/clob-client v5.8.1 exposes fee_rate_bps, not an authoritative
 * charged fee amount. Therefore even otherwise complete package-shaped trades
 * fail closed under the shared evidence contract. Untyped fee_* properties are
 * rejected because they are not part of the verified package response shape.
 */
export function parsePmFillEvidence(
  orderRaw: unknown,
  tradesRaw: unknown[],
  submitted: SubmittedPmOrder,
): VenueExecutionEvidence | null {
  if (!orderRaw || typeof orderRaw !== 'object' || Array.isArray(orderRaw) || !Array.isArray(tradesRaw)) return null;
  const order = orderRaw as Record<string, unknown>;
  const orderId = nonEmptyString(order.id ?? order.order_id);
  const matched = positiveNumber(order.size_matched ?? order.sizeMatched);
  if (orderId !== submitted.orderId || order.asset_id !== submitted.tokenId
    || order.side !== submitted.side || matched == null) return null;
  if (!Array.isArray(order.associate_trades) || order.associate_trades.length === 0) return null;
  const associatedIds = order.associate_trades;
  if (!associatedIds.every((id): id is string => Boolean(nonEmptyString(id)))) return null;
  if (new Set(associatedIds).size !== associatedIds.length || tradesRaw.length !== associatedIds.length) return null;

  let total = 0;
  for (const raw of tradesRaw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const trade = raw as Record<string, unknown>;
    const executionId = nonEmptyString(trade.id);
    const quantity = positiveNumber(trade.size);
    const price = positiveNumber(trade.price);
    if (!executionId || !associatedIds.includes(executionId)) return null;
    if (trade.taker_order_id !== submitted.orderId || trade.asset_id !== submitted.tokenId
      || trade.side !== submitted.side) return null;
    if (quantity == null || price == null || price >= 1 || !isVenueTimestamp(trade.match_time)) return null;
    total += quantity;
  }
  if (Math.abs(total - matched) > 1e-9) return null;

  return null;
}

export function mapPmOrderResponse(
  response: Pick<PmOrderResponse, 'orderId' | 'status' | 'raw'>,
  evidence: VenueExecutionEvidence | null,
): import('./auto-execute').OrderResult {
  const normalizedStatus = response.status.toLowerCase();
  const cancelled = normalizedStatus === 'canceled' || normalizedStatus === 'cancelled';
  if (!evidence || evidence.venue !== 'polymarket') {
    const filledContracts = parsePmFilledContracts(response.raw);
    const terminalZero = (cancelled || normalizedStatus === 'expired')
      && filledContracts === 0;
    return {
      platform: 'polymarket',
      status: terminalZero ? (normalizedStatus === 'expired' ? 'expired' : 'cancelled') : 'pending',
      ...(terminalZero ? { filledContracts: 0 } : {}),
      orderId: response.orderId,
      timestamp: '',
    };
  }
  return {
    platform: 'polymarket',
    status: normalizedStatus === 'matched' ? 'filled' : cancelled ? 'cancelled'
      : normalizedStatus === 'expired' ? 'expired' : 'partial',
    filledSize: evidence.filledQuantity * evidence.fillPrice,
    filledContracts: evidence.filledQuantity,
    filledPrice: evidence.fillPrice,
    chargedFeeCents: evidence.chargedFeeCents,
    venueEvidence: evidence,
    orderId: response.orderId,
    timestamp: evidence.venueTimestamp,
  };
}

interface PmClobEvidenceClient {
  getOrder(orderId: string): Promise<unknown>;
  getTrades(params: { id: string }, onlyFirstPage: boolean): Promise<unknown>;
}

async function getPmOrderWithEvidence(
  client: PmClobEvidenceClient,
  submitted: SubmittedPmOrder,
): Promise<{ order: Record<string, unknown>; evidence: VenueExecutionEvidence | null } | null> {
  const rawOrder = await client.getOrder(submitted.orderId);
  if (!rawOrder || typeof rawOrder !== 'object' || Array.isArray(rawOrder)) return null;
  const order = rawOrder as Record<string, unknown>;
  const ids = Array.isArray(order.associate_trades) ? order.associate_trades : [];
  const trades = await Promise.all(ids.map(async (id) => {
    if (typeof id !== 'string' || !id) return null;
    const matches = await client.getTrades({ id }, true);
    return Array.isArray(matches) && matches.length === 1 ? matches[0] : null;
  }));
  return {
    order,
    evidence: trades.some((trade) => trade == null) ? null : parsePmFillEvidence(order, trades, submitted),
  };
}

let _client: ClobClient | null = null;

async function getClobClient(): Promise<ClobClient> {
  if (_client) return _client;

  const pk = process.env.POLYMARKET_PRIVATE_KEY;
  const apiKey = process.env.POLYMARKET_API_KEY;
  const secret = process.env.POLYMARKET_API_SECRET;
  const passphrase = process.env.POLYMARKET_API_PASSPHRASE;
  if (!pk || !apiKey || !secret || !passphrase) {
    throw new Error('Polymarket credentials incomplete — set them in Settings → Trading Credentials');
  }

  const { ClobClient } = await import('@polymarket/clob-client');
  const { createWalletClient, http } = await import('viem');
  const { privateKeyToAccount } = await import('viem/accounts');
  const { polygon } = await import('viem/chains');

  const account = privateKeyToAccount((pk.startsWith('0x') ? pk : `0x${pk}`) as `0x${string}`);
  const wallet = createWalletClient({ account, chain: polygon, transport: http('https://polygon-rpc.com') });

  _client = new ClobClient(CLOB_HOST, POLYGON_CHAIN_ID, wallet, {
    key: apiKey,
    secret,
    passphrase,
  });
  return _client;
}

/** Reset cached client (call after credential changes). */
export function resetClobClient(): void {
  _client = null;
}

/** Available Polymarket collateral balance in USD (USDC has 6 decimals). */
export async function getPmCashBalance(): Promise<number> {
  const client = await getClobClient();
  const response = await client.getBalanceAllowance(
    { asset_type: 'COLLATERAL' } as Parameters<ClobClient['getBalanceAllowance']>[0],
  );
  const raw = Number(response?.balance ?? 0);
  return Number.isFinite(raw) && raw > 0 ? raw / 1_000_000 : 0;
}

export async function placePmOrder(p: PmOrderParams): Promise<PmOrderResponse> {
  if (p.price <= 0 || p.price >= 1) throw new Error(`PM price out of range: ${p.price}`);
  if (p.size <= 0) throw new Error(`PM size must be > 0, got ${p.size}`);

  const client = await getClobClient();
  const { Side, OrderType } = await import('@polymarket/clob-client');

  // createAndPostOrder resolves tick size + neg-risk automatically and signs
  // the order EIP-712. GTC limit; the caller cancels on timeout/rollback.
  const resp = await client.createAndPostOrder(
    {
      tokenID: p.tokenId,
      price: p.price,
      side: Side.BUY,
      size: p.size,
    },
    undefined,          // tick-size/neg-risk options: resolved by the client
    OrderType.GTC,
  );

  const success = Boolean(resp?.success);
  if (!success) {
    const msg = resp?.errorMsg || JSON.stringify(resp ?? {}).slice(0, 300);
    logger.error('[pm-orders] order rejected', { tokenId: p.tokenId, msg });
    throw new Error(`Polymarket order failed: ${msg}`);
  }

  const orderId = resp?.orderID ?? resp?.orderId ?? '';
  const authoritative = orderId
    ? await getPmOrderWithEvidence(client, { orderId, tokenId: p.tokenId, side: 'BUY' }).catch(() => null)
    : null;
  return {
    orderId,
    status: resp?.status ?? 'unknown',
    success,
    filledContracts: authoritative?.evidence?.filledQuantity ?? parsePmFilledContracts(resp),
    venueEvidence: authoritative?.evidence ?? undefined,
    raw: resp,
  };
}

export async function cancelPmOrder(orderId: string): Promise<boolean> {
  try {
    const client = await getClobClient();
    const resp = await client.cancelOrder({ orderID: orderId });
    return Boolean(resp?.canceled?.length || resp?.success !== false);
  } catch (err) {
    logger.warn('[pm-orders] cancel failed', { orderId, err });
    return false;
  }
}

/** Poll a single order's status (used to confirm fills after placement). */
export async function getPmOrder(orderId: string): Promise<PmOrderResponse | null> {
  try {
    const client = await getClobClient();
    const order = await client.getOrder(orderId);
    if (!order) return null;
    const rawOrder = order as unknown as Record<string, unknown>;
    const status = String(rawOrder.status ?? 'unknown');
    const tokenId = nonEmptyString(rawOrder.asset_id);
    const side = rawOrder.side === 'BUY' || rawOrder.side === 'SELL' ? rawOrder.side : null;
    const authoritative = tokenId && side
      ? await getPmOrderWithEvidence(client, { orderId, tokenId, side })
      : null;
    return {
      orderId: String(rawOrder.id ?? rawOrder.order_id ?? orderId),
      status,
      success: true,
      filledContracts: authoritative?.evidence?.filledQuantity ?? parsePmFilledContracts(rawOrder),
      venueEvidence: authoritative?.evidence ?? undefined,
      raw: rawOrder,
    };
  } catch (err) {
    logger.warn('[pm-orders] get order failed', { orderId, err });
    return null;
  }
}

/** Place a SELL order to close an existing position (auto-close on partial-fill failure). */
export async function placePmSellOrder(p: PmOrderParams): Promise<PmOrderResponse> {
  if (p.price <= 0 || p.price >= 1) throw new Error(`PM price out of range: ${p.price}`);
  if (p.size <= 0) throw new Error(`PM size must be > 0, got ${p.size}`);

  const client = await getClobClient();
  const { Side, OrderType } = await import('@polymarket/clob-client');

  const resp = await client.createAndPostOrder(
    {
      tokenID: p.tokenId,
      price: p.price,
      side: Side.SELL,
      size: p.size,
    },
    undefined,
    OrderType.GTC,
  );

  const success = Boolean(resp?.success);
  if (!success) {
    const msg = resp?.errorMsg || JSON.stringify(resp ?? {}).slice(0, 300);
    logger.error('[pm-orders] sell order rejected', { tokenId: p.tokenId, msg });
    throw new Error(`Polymarket sell order failed: ${msg}`);
  }

  const orderId = resp?.orderID ?? resp?.orderId ?? '';
  const authoritative = orderId
    ? await getPmOrderWithEvidence(client, { orderId, tokenId: p.tokenId, side: 'SELL' }).catch(() => null)
    : null;
  return {
    orderId,
    status: resp?.status ?? 'unknown',
    success,
    filledContracts: authoritative?.evidence?.filledQuantity ?? parsePmFilledContracts(resp),
    venueEvidence: authoritative?.evidence ?? undefined,
    raw: resp,
  };
}
