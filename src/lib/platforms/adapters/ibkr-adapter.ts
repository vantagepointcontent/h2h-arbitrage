/**
 * Interactive Brokers (IBKR) Platform Adapter — STUB implementation.
 *
 * This is a placeholder adapter for the IBKR platform. All methods
 * return empty results or throw "not implemented" errors. Actual API
 * integration (likely via TWS API or Client Portal API) will be done
 * in a follow-up ticket.
 *
 * The stub exists so the platform registry, UI, and coupling system can
 * already recognize IBKR URLs, display the platform in selectors, and
 * prepare coupling pairs — even though market data can't be fetched yet.
 */

import type { PlatformAdapter, OrderParams, OrderResult, Position } from '../adapter';
import type { PlatformMarket, PlatformOutcome } from '../types';

export class IbkrAdapter implements PlatformAdapter {
  readonly platformId = 'ibkr' as const;

  // ── URL Parsing ──

  extractEventId(url: string): string | null {
    // IBKR URL format TBD — likely deep links to research/contract pages
    const match = url.match(/(?:interactivebrokers|ibkr)\.com\/(?:[^/]+\/)*([^/?#]+)/i);
    return match ? match[1] : null;
  }

  extractMarketId(url: string): string | null {
    // IBKR contract IDs are numeric — extract from URL if present
    const match = url.match(/(?:interactivebrokers|ibkr)\.com\/.*?(\d{6,})/i);
    return match ? match[1] : null;
  }

  isPlatformUrl(url: string): boolean {
    return /(?:interactivebrokers|ibkr)\.com/i.test(url);
  }

  // ── Market Data Fetching (stubs) ──

  async fetchEventMarkets(_eventId: string): Promise<PlatformMarket[]> {
    // STUB: Not implemented yet
    // IBKR uses contract-based system, not event/market model
    // Will be adapted in the IBKR API integration follow-up ticket
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
    throw new Error('IbkrAdapter: API not yet implemented');
  }

  async cancelOrder(_orderId: string): Promise<boolean> {
    throw new Error('IbkrAdapter: API not yet implemented');
  }

  async getPositions(): Promise<Position[]> {
    throw new Error('IbkrAdapter: API not yet implemented');
  }

  // ── Capabilities ──

  isReady(): boolean {
    return false; // Stub — not ready for production use
  }

  supportsWebSocket(): boolean {
    return false;
  }
}