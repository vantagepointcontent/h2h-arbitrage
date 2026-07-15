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
  raw: unknown;
}

let _client: any = null;

async function getClobClient(): Promise<any> {
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

  return {
    orderId: resp?.orderID ?? resp?.orderId ?? '',
    status: resp?.status ?? 'unknown',
    success,
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
    const status = String(order.status ?? 'unknown');
    return {
      orderId: String(order.id ?? order.order_id ?? orderId),
      status,
      success: true,
      raw: order,
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

  return {
    orderId: resp?.orderID ?? resp?.orderId ?? '',
    status: resp?.status ?? 'unknown',
    success,
    raw: resp,
  };
}
