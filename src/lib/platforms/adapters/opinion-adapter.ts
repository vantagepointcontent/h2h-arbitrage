/**
 * Opinion Platform Adapter — STUB implementation.
 *
 * This is a placeholder adapter for the Opinion platform. All methods
 * return empty results or throw "not implemented" errors. Actual API
 * integration will be done in a follow-up ticket.
 *
 * The stub exists so the platform registry, UI, and coupling system can
 * already recognize Opinion URLs, display the platform in selectors, and
 * prepare coupling pairs — even though market data can't be fetched yet.
 */

import type { PlatformAdapter, OrderParams, OrderResult, Position } from '../adapter';
import type { PlatformMarket, PlatformOutcome } from '../types';

export class OpinionAdapter implements PlatformAdapter {
  readonly platformId = 'opinion' as const;

  // ── URL Parsing ──

  extractEventId(url: string): string | null {
    // Opinion URL format TBD — placeholder pattern
    const match = url.match(/opinion\.(?:com|finance)\/(?:event|market)\/([^/?#]+)/i);
    return match ? match[1] : null;
  }

  extractMarketId(url: string): string | null {
    const match = url.match(/opinion\.(?:com|finance)\/market\/([^/?#]+)/i);
    return match ? match[1] : null;
  }

  isPlatformUrl(url: string): boolean {
    return /opinion\.(?:com|finance)/i.test(url);
  }

  // ── Market Data Fetching (stubs) ──

  async fetchEventMarkets(_eventId: string): Promise<PlatformMarket[]> {
    // STUB: Not implemented yet
    // Will be implemented in the Opinion API integration follow-up ticket
    return [];
  }

  async fetchMarket(_marketId: string): Promise<PlatformMarket | null> {
    return null;
  }

  async fetchPrices(_marketIds: string[]): Promise<Map<string, PlatformOutcome[]>> {
    return new Map();
  }

  // ── Order Execution (stubs) ──

  async placeOrder(_params: OrderParams): Promise<OrderResult> {
    throw new Error('OpinionAdapter: API not yet implemented');
  }

  async cancelOrder(_orderId: string): Promise<boolean> {
    throw new Error('OpinionAdapter: API not yet implemented');
  }

  async getPositions(): Promise<Position[]> {
    throw new Error('OpinionAdapter: API not yet implemented');
  }

  // ── Capabilities ──

  isReady(): boolean {
    return false; // Stub — not ready for production use
  }

  supportsWebSocket(): boolean {
    return false;
  }
}