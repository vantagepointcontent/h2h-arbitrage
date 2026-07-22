/**
 * Platform Adapter Interface.
 *
 * Every platform implements this interface so the rest of the system
 * can interact with platforms generically. The interface covers:
 * - Market data fetching (events, markets, prices)
 * - URL parsing (extract identifiers from platform URLs)
 * - Order execution (place, cancel)
 * - Position tracking
 *
 * Existing Polymarket and Kalshi code is wrapped in adapter shims that
 * delegate to the existing implementation files (polymarket.ts, kalshi.ts,
 * polymarket-clob.ts, kalshi-orders.ts, etc.) — no behavior changes.
 *
 * New platforms (such as IBKR) implement this interface directly with
 * stub implementations for now; actual API calls come in follow-up tickets.
 */

import type { PlatformId } from './registry';
import type { PlatformMarket, PlatformEvent, PlatformOutcome } from './types';

// ── Adapter Interface ─────────────────────────────────────────────────

export interface PlatformAdapter {
  /** Platform id from the registry */
  readonly platformId: PlatformId;

  // ── URL Parsing ──

  /** Extract the platform-native event/group identifier from a URL */
  extractEventId(url: string): string | null;

  /** Extract the platform-native market identifier from a URL */
  extractMarketId(url: string): string | null;

  /** Check if a URL belongs to this platform */
  isPlatformUrl(url: string): boolean;

  // ── Market Data Fetching ──

  /** Fetch all markets for an event (by event id/slug) */
  fetchEventMarkets(eventId: string): Promise<PlatformMarket[]>;

  /** Fetch a single market by its native id */
  fetchMarket(marketId: string): Promise<PlatformMarket | null>;

  /** Fetch current prices/orderbook for a set of market ids */
  fetchPrices(marketIds: string[]): Promise<Map<string, PlatformOutcome[]>>;

  // ── Order Execution (stubs for now — manual execution only) ──

  /** Place an order on a market */
  placeOrder(params: OrderParams): Promise<OrderResult>;

  /** Cancel an existing order */
  cancelOrder(orderId: string): Promise<boolean>;

  /** Get current open positions */
  getPositions(): Promise<Position[]>;

  // ── Capabilities ──

  /** Whether this adapter has a working implementation (vs stub) */
  isReady(): boolean;

  /** Whether this platform supports WebSocket orderbook streaming */
  supportsWebSocket(): boolean;
}

// ── Order Types ───────────────────────────────────────────────────────

export interface OrderParams {
  marketId: string;
  outcomeId: string;
  side: 'yes' | 'no';
  orderType: 'market' | 'limit';
  price?: number; // required for limit orders
  size: number; // number of contracts / shares
}

export interface OrderResult {
  orderId: string;
  status: 'filled' | 'partial' | 'pending' | 'rejected';
  filledSize: number;
  avgFillPrice: number;
  timestamp: string;
}

export interface Position {
  marketId: string;
  outcomeId: string;
  side: 'yes' | 'no';
  size: number;
  avgEntryPrice: number;
  currentPrice: number;
  unrealizedPnl: number;
}

// ── Adapter Registry ──────────────────────────────────────────────────

/**
 * Registry of platform adapter instances.
 * Adapters are lazily instantiated and cached.
 */

import { getPlatformOrNull } from './registry';

const _adapters = new Map<PlatformId, PlatformAdapter>();
let _polymarketAdapter: PlatformAdapter | null = null;
let _kalshiAdapter: PlatformAdapter | null = null;

/**
 * Get the adapter for a platform.
 * Returns null if the platform doesn't have an adapter yet.
 */
export async function getAdapter(platformId: PlatformId): Promise<PlatformAdapter | null> {
  // Check cache first
  if (_adapters.has(platformId)) {
    return _adapters.get(platformId) ?? null;
  }

  // Check platform exists in registry
  const config = getPlatformOrNull(platformId);
  if (!config) return null;

  // Lazy-load adapter implementation
  let adapter: PlatformAdapter | null = null;

  if (platformId === 'polymarket') {
    if (!_polymarketAdapter) {
      const { PolymarketAdapter } = await import('./adapters/polymarket-adapter');
      _polymarketAdapter = new PolymarketAdapter();
    }
    adapter = _polymarketAdapter;
  } else if (platformId === 'kalshi') {
    if (!_kalshiAdapter) {
      const { KalshiAdapter } = await import('./adapters/kalshi-adapter');
      _kalshiAdapter = new KalshiAdapter();
    }
    adapter = _kalshiAdapter;
  } else if (platformId === 'ibkr') {
    const { IbkrAdapter } = await import('./adapters/ibkr-adapter');
    adapter = new IbkrAdapter();
  }

  if (adapter) {
    _adapters.set(platformId, adapter);
  }
  return adapter;
}

/**
 * Get adapters for all enabled, adapter-ready platforms.
 */
export async function getReadyAdapters(): Promise<PlatformAdapter[]> {
  const { getAdapterReadyPlatforms } = await import('./registry');
  const platforms = getAdapterReadyPlatforms();
  const adapters: PlatformAdapter[] = [];
  for (const p of platforms) {
    const adapter = await getAdapter(p.id);
    if (adapter) adapters.push(adapter);
  }
  return adapters;
}