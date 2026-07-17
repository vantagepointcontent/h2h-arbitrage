/**
 * Polymarket Positions — fetch live open positions from Polymarket Data API.
 *
 * GET https://data-api.polymarket.com/positions?user={address}
 * Returns array of positions with size, avgPrice, currentValue, cashPnl, etc.
 *
 * The wallet address is derived from the POLYMARKET_PRIVATE_KEY env var
 * (same key used for CLOB order signing).
 */

import logger from './logger';

const DATA_API_BASE = 'https://data-api.polymarket.com';

export interface PolymarketPosition {
  /** Token ID (asset) */
  asset: string;
  /** Condition ID */
  conditionId: string;
  /** Position size (shares) */
  size: number;
  /** Average entry price (0-1) */
  avgPrice: number;
  /** Initial investment in USD */
  initialValue: number;
  /** Current market value in USD */
  currentValue: number;
  /** Cash P&L in USD */
  cashPnl: number;
  /** Percent P&L (0-100) */
  percentPnl: number;
  /** Current price (0-1) */
  curPrice: number;
  /** Market title */
  title: string;
  /** Market slug */
  slug: string;
  /** Event slug */
  eventSlug: string;
  /** Outcome name (Yes/No) */
  outcome: string;
  /** Outcome index (0=Yes, 1=No typically) */
  outcomeIndex: number;
  /** Opposite outcome name */
  oppositeOutcome: string;
  /** End date */
  endDate: string;
  /** Negative risk market */
  negativeRisk: boolean;
  /** Proxy wallet address */
  proxyWallet: string;
}

interface PmPositionRaw {
  proxyWallet: string;
  asset: string;
  conditionId: string;
  size: number;
  avgPrice: number;
  initialValue: number;
  currentValue: number;
  cashPnl: number;
  percentPnl: number;
  totalBought: number;
  realizedPnl: number;
  percentRealizedPnl: number;
  curPrice: number;
  redeemable: boolean;
  mergeable: boolean;
  title: string;
  slug: string;
  icon: string;
  eventSlug: string;
  outcome: string;
  outcomeIndex: number;
  oppositeOutcome: string;
  oppositeAsset: string;
  endDate: string;
  negativeRisk: boolean;
}

/**
 * Derive the EOA wallet address from the Polymarket private key.
 * Polymarket Data API expects the EOA address (not proxy).
 * However, positions are stored under the proxy wallet. We try both.
 */
async function getWalletAddress(): Promise<string | null> {
  const pk = process.env.POLYMARKET_PRIVATE_KEY;
  if (!pk) return null;

  try {
    const { privateKeyToAccount } = await import('viem/accounts');
    const account = privateKeyToAccount((pk.startsWith('0x') ? pk : `0x${pk}`) as `0x${string}`);
    return account.address;
  } catch {
    return null;
  }
}

export async function getPolymarketPositions(): Promise<PolymarketPosition[]> {
  const address = await getWalletAddress();
  if (!address) {
    throw new Error('Polymarket positions require POLYMARKET_PRIVATE_KEY env var');
  }

  // Try EOA address first, then try common proxy patterns
  // The Data API typically stores positions under the proxy wallet address.
  // Polymarket uses a deterministic proxy creation, but the Data API also
  // accepts the EOA address and resolves it internally.
  const url = `${DATA_API_BASE}/positions?user=${address}&sizeThreshold=0.01`;

  const res = await fetch(url, {
    method: 'GET',
    headers: {
      'Accept': 'application/json',
      'User-Agent': 'h2h-arbitrage/1.0',
    },
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    logger.error('[pm-positions] failed', { status: res.status });
    throw new Error(`Polymarket positions fetch failed: HTTP ${res.status}`);
  }

  const data = (await res.json()) as PmPositionRaw[];
  if (!Array.isArray(data)) return [];

  // Filter to positions with non-zero size
  const open = data.filter(p => Math.abs(p.size) > 0.01);

  return open.map(p => ({
    asset: p.asset,
    conditionId: p.conditionId,
    size: p.size,
    avgPrice: p.avgPrice,
    initialValue: p.initialValue,
    currentValue: p.currentValue,
    cashPnl: p.cashPnl,
    percentPnl: p.percentPnl,
    curPrice: p.curPrice,
    title: p.title,
    slug: p.slug,
    eventSlug: p.eventSlug,
    outcome: p.outcome,
    outcomeIndex: p.outcomeIndex,
    oppositeOutcome: p.oppositeOutcome,
    endDate: p.endDate,
    negativeRisk: p.negativeRisk,
    proxyWallet: p.proxyWallet,
  }));
}