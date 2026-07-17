/**
 * Polymarket Adapter — thin shim over existing polymarket.ts + polymarket-clob.ts.
 *
 * This adapter wraps the existing Polymarket implementation so the platform
 * registry can interact with Polymarket through the generic adapter interface.
 * No behavior changes — all calls delegate directly to the existing functions.
 */

import type { PlatformAdapter, OrderParams, OrderResult, Position } from '../adapter';
import type { PlatformMarket, PlatformOutcome } from '../types';
import {
  extractPolymarketSlug,
  isPolymarketMarketUrl,
  fetchPolymarketEvent,
  fetchPolymarketMarketAsEvent,
  parseOutcomes,
  type PMMarket,
  type PMEvent,
} from '../../polymarket';
import { fetchClobMarkets, getClobPrices, type ClobMarket } from '../../polymarket-clob';

export class PolymarketAdapter implements PlatformAdapter {
  readonly platformId = 'polymarket' as const;

  // ── URL Parsing ──

  extractEventId(url: string): string | null {
    return extractPolymarketSlug(url);
  }

  extractMarketId(url: string): string | null {
    if (!isPolymarketMarketUrl(url)) return null;
    const slug = extractPolymarketSlug(url);
    return slug;
  }

  isPlatformUrl(url: string): boolean {
    return /polymarket\.com/i.test(url);
  }

  // ── Market Data Fetching ──

  async fetchEventMarkets(slug: string): Promise<PlatformMarket[]> {
    let event: PMEvent | null = null;
    try {
      event = await fetchPolymarketEvent(slug);
    } catch {
      // Fallback: try as single market URL
      try {
        event = await fetchPolymarketMarketAsEvent(`https://polymarket.com/market/${slug}`);
      } catch {
        return [];
      }
    }
    if (!event || !event.markets) return [];

    return event.markets.map(m => this.mapMarket(m, event!));
  }

  async fetchMarket(marketId: string): Promise<PlatformMarket | null> {
    try {
      const event = await fetchPolymarketMarketAsEvent(`https://polymarket.com/market/${marketId}`);
      if (!event || !event.markets || event.markets.length === 0) return null;
      return this.mapMarket(event.markets[0], event);
    } catch {
      return null;
    }
  }

  async fetchPrices(marketIds: string[]): Promise<Map<string, PlatformOutcome[]>> {
    // Use existing CLOB price fetcher
    const result = new Map<string, PlatformOutcome[]>();
    try {
      const clobMap = await fetchClobMarkets(marketIds);
      for (const [conditionId, clobMarket] of clobMap) {
        const prices = await getClobPrices(clobMarket);
        if (!prices) continue;
        const outcomes: PlatformOutcome[] = [{
          nativeId: conditionId,
          name: 'Yes',
          yesPrice: prices.yesPrice,
          noPrice: prices.noPrice,
          bestBid: prices.bestBid,
          bestAsk: prices.bestAsk,
          lastPrice: prices.lastTradePrice,
          raw: clobMarket,
        }];
        result.set(conditionId, outcomes);
      }
    } catch {
      // Return empty map on error — caller handles gracefully
    }
    return result;
  }

  // ── Order Execution (delegates to existing polymarket-orders.ts) ──

  async placeOrder(params: OrderParams): Promise<OrderResult> {
    // Delegate to existing polymarket-orders.ts when implemented
    // For now, throw — manual execution is handled via /api/execute
    throw new Error('PolymarketAdapter.placeOrder: Use /api/execute for manual trading');
  }

  async cancelOrder(_orderId: string): Promise<boolean> {
    throw new Error('PolymarketAdapter.cancelOrder: Not implemented via adapter');
  }

  async getPositions(): Promise<Position[]> {
    throw new Error('PolymarketAdapter.getPositions: Not implemented');
  }

  // ── Capabilities ──

  isReady(): boolean {
    return true;
  }

  supportsWebSocket(): boolean {
    return true;
  }

  // ── Private Mappers ──

  private mapMarket(m: PMMarket, event: PMEvent): PlatformMarket {
    const outcomeNames = parseOutcomes(m.outcomes);
    const prices = m.outcomePrices ? JSON.parse(m.outcomePrices) as string[] : [];

    const outcomes: PlatformOutcome[] = outcomeNames.map((name, i) => ({
      nativeId: m.conditionId,
      name,
      yesPrice: parseFloat(prices[i] ?? '0'),
      noPrice: 1 - parseFloat(prices[i] ?? '0'),
      bestBid: m.bestBid ?? 0,
      bestAsk: m.bestAsk ?? 0,
      lastPrice: m.lastTradePrice ?? 0,
      volume24h: m.volumeNum,
      negRisk: m.neg_risk,
      raw: m,
    }));

    return {
      platform: 'polymarket',
      marketId: m.id,
      title: m.question,
      url: `https://polymarket.com/market/${m.slug}`,
      closeTime: m.endDate,
      category: undefined, // PM doesn't provide category on market level
      outcomes,
      active: m.active,
      closed: m.closed,
      raw: m,
    };
  }

  private parsePriceOutcomes(priceData: unknown): PlatformOutcome[] {
    // The CLOB price format is handled by polymarket-clob.ts
    // This is a minimal mapper — full price parsing stays in the existing code
    if (!priceData || typeof priceData !== 'object') return [];
    const data = priceData as Record<string, unknown>;
    return [{
      nativeId: String(data.conditionId ?? ''),
      name: String(data.outcome ?? 'Yes'),
      yesPrice: Number(data.yesPrice ?? 0),
      noPrice: Number(data.noPrice ?? 0),
      bestBid: Number(data.bestBid ?? 0),
      bestAsk: Number(data.bestAsk ?? 0),
      lastPrice: Number(data.lastTradePrice ?? 0),
      raw: priceData,
    }];
  }
}