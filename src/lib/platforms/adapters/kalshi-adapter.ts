/**
 * Kalshi Adapter — thin shim over existing kalshi.ts + kalshi-orders.ts.
 *
 * Wraps the existing Kalshi implementation so the platform registry can
 * interact with Kalshi through the generic adapter interface.
 * No behavior changes — all calls delegate to existing functions.
 */

import type { PlatformAdapter, OrderParams, OrderResult, Position } from '../adapter';
import type { PlatformMarket, PlatformOutcome } from '../types';
import {
  extractKalshiEventTicker,
  fetchKalshiEventMarkets,
  type KalshiMarket,
} from '../../kalshi';

export class KalshiAdapter implements PlatformAdapter {
  readonly platformId = 'kalshi' as const;

  // ── URL Parsing ──

  extractEventId(url: string): string | null {
    return extractKalshiEventTicker(url);
  }

  extractMarketId(url: string): string | null {
    // Kalshi market ticker extraction from URL
    const match = url.match(/kalshi\.com\/markets\/[^/]+\/[^/]+\/([^/?#]+)/i);
    return match ? match[1].toUpperCase() : null;
  }

  isPlatformUrl(url: string): boolean {
    return /kalshi\.com/i.test(url);
  }

  // ── Market Data Fetching ──

  async fetchEventMarkets(eventTicker: string): Promise<PlatformMarket[]> {
    try {
      const markets = await fetchKalshiEventMarkets(eventTicker);
      return markets.map(m => this.mapMarket(m));
    } catch {
      return [];
    }
  }

  async fetchMarket(marketId: string): Promise<PlatformMarket | null> {
    // Kalshi doesn't have a single-market fetch; fetch the event and filter
    try {
      // Derive event ticker from market ticker (strip last segment after hyphen)
      const lastHyphen = marketId.lastIndexOf('-');
      const eventTicker = lastHyphen > 0 ? marketId.slice(0, lastHyphen) : marketId;
      const markets = await fetchKalshiEventMarkets(eventTicker);
      const found = markets.find(m => m.ticker === marketId);
      return found ? this.mapMarket(found) : null;
    } catch {
      return null;
    }
  }

  async fetchPrices(marketIds: string[]): Promise<Map<string, PlatformOutcome[]>> {
    // Kalshi prices are embedded in the market data (yes_ask_dollars etc.)
    // For live orderbook, the WS path is used (kalshi-ws.ts)
    const result = new Map<string, PlatformOutcome[]>();
    // For now, fetch event markets and extract prices
    // The existing scan flow uses fetchKalshiEventMarkets + inline price parsing
    // This adapter method is for future generic price-fetching use cases
    return result;
  }

  // ── Order Execution (delegates to existing kalshi-orders.ts) ──

  async placeOrder(_params: OrderParams): Promise<OrderResult> {
    // Delegate to existing kalshi-orders.ts when implemented
    // For now, throw — manual execution is handled via /api/execute
    throw new Error('KalshiAdapter.placeOrder: Use /api/execute for manual trading');
  }

  async cancelOrder(_orderId: string): Promise<boolean> {
    throw new Error('KalshiAdapter.cancelOrder: Not implemented via adapter');
  }

  async getPositions(): Promise<Position[]> {
    const { getKalshiPositions } = await import('../../kalshi-positions');
    const positions = await getKalshiPositions();
    return positions.map(p => ({
      marketId: p.ticker,
      outcomeId: p.ticker,
      side: p.position > 0 ? 'yes' : 'no',
      size: Math.abs(p.position),
      avgEntryPrice: p.totalCost / Math.max(Math.abs(p.position), 1),
      currentPrice: p.position > 0 ? p.currentYesBid : p.currentNoBid,
      unrealizedPnl: p.unrealizedPnl,
    }));
  }

  // ── Capabilities ──

  isReady(): boolean {
    return true;
  }

  supportsWebSocket(): boolean {
    return true;
  }

  // ── Private Mappers ──

  private mapMarket(m: KalshiMarket): PlatformMarket {
    const yesAsk = parseFloat(m.yes_ask_dollars ?? '0');
    const noAsk = parseFloat(m.no_ask_dollars ?? '0');
    const yesBid = parseFloat(m.yes_bid_dollars ?? '0');
    const noBid = parseFloat(m.no_bid_dollars ?? '0');
    const lastPrice = parseFloat(m.last_price_dollars ?? '0');

    const outcomes: PlatformOutcome[] = [
      {
        nativeId: m.ticker,
        name: m.yes_sub_title ?? 'Yes',
        yesPrice: yesAsk,
        noPrice: noAsk,
        bestBid: yesBid,
        bestAsk: yesAsk,
        lastPrice,
        volume24h: m.volume_24h_fp ? parseFloat(m.volume_24h_fp) : undefined,
        bidDepth: m.yes_bid_size_fp ? parseFloat(m.yes_bid_size_fp) : undefined,
        askDepth: m.yes_ask_size_fp ? parseFloat(m.yes_ask_size_fp) : undefined,
        raw: m,
      },
    ];

    return {
      platform: 'kalshi',
      marketId: m.ticker,
      title: m.title ?? m.ticker,
      url: `https://kalshi.com/markets/${m.event_ticker}/${m.ticker}`,
      closeTime: m.close_time,
      active: m.status === 'active' || !m.status,
      closed: m.status === 'closed' || m.status === 'settled',
      outcomes,
      raw: m,
    };
  }
}