// Platform Adapters — Kalshi & Polymarket implementations of PlatformAdapter
// Wraps existing kalshi.ts / polymarket.ts / polymarket-clob.ts functions

import {
  PlatformAdapter,
  NormalizedMarket,
  NormalizedOrderbook,
  NormalizedOutcome,
  OrderbookLevel,
} from '@/lib/multi-platform-arb';

import {
  KalshiMarket,
  fetchKalshiEventMarkets,
  fetchKalshiMarket,
} from '@/lib/kalshi';

import {
  PMMarket,
  PMEvent,
  fetchPolymarketEvent,
  fetchPolymarketMarketAsEvent,
  parseOutcomes,
} from '@/lib/polymarket';

import {
  ClobMarket,
  ClobBook,
  fetchClobMarket,
  fetchClobBook,
  getClobPrices,
} from '@/lib/polymarket-clob';

// ─── Kalshi Adapter ──────────────────────────────────────────────

export class KalshiAdapter implements PlatformAdapter {
  readonly name: string = 'kalshi';

  normalizeMarket(raw: KalshiMarket): NormalizedMarket {
    const yesPrice = parseFloat(raw.yes_ask_dollars ?? '0') / 100;
    const noPrice = 1 - yesPrice;
    const yesDepth = parseFloat(raw.yes_ask_size_fp ?? '0');
    const noDepth = parseFloat(raw.no_ask_size_fp ?? '0');
    const bestBid = parseFloat(raw.yes_bid_dollars ?? '0') / 100;
    const bestAsk = yesPrice;

    return {
      id: raw.ticker,
      platform: 'kalshi',
      title: raw.title ?? raw.ticker,
      question: raw.title,
      outcomes: [
        {
          name: 'yes',
          yesPrice,
          noPrice,
          yesDepth,
          noDepth,
          bestBid,
          bestAsk,
        },
      ],
      endDate: raw.close_time,
      active: raw.status === 'open',
      closed: raw.status === 'closed',
      slug: raw.event_ticker,
    };
  }

  normalizeOrderbook(raw: {
    bids?: { price: string; size: string }[];
    asks?: { price: string; size: string }[];
    marketId?: string;
  }): NormalizedOrderbook {
    return {
      marketId: raw.marketId ?? '',
      platform: 'kalshi',
      bids: (raw.bids ?? []).map(b => ({
        price: parseFloat(b.price),
        size: parseFloat(b.size),
      })),
      asks: (raw.asks ?? []).map(a => ({
        price: parseFloat(a.price),
        size: parseFloat(a.size),
      })),
    };
  }

  async fetchMarkets(_query?: string): Promise<NormalizedMarket[]> {
    // Kalshi fetchMarkets requires an event_ticker;
    // if a query is provided, treat it as event_ticker.
    if (_query) {
      const markets = await fetchKalshiEventMarkets(_query);
      return markets.map(m => this.normalizeMarket(m));
    }
    return [];
  }

  async fetchOrderbook(marketId: string): Promise<NormalizedOrderbook | null> {
    const market = await fetchKalshiMarket(marketId);
    if (!market) return null;

    const bids: OrderbookLevel[] = [];
    const asks: OrderbookLevel[] = [];

    // Reconstruct a minimal orderbook from bid/ask fields
    if (market.yes_bid_dollars && market.yes_bid_size_fp) {
      bids.push({
        price: parseFloat(market.yes_bid_dollars) / 100,
        size: parseFloat(market.yes_bid_size_fp),
      });
    }
    if (market.yes_ask_dollars && market.yes_ask_size_fp) {
      asks.push({
        price: parseFloat(market.yes_ask_dollars) / 100,
        size: parseFloat(market.yes_ask_size_fp),
      });
    }

    return {
      marketId,
      platform: 'kalshi',
      bids,
      asks,
    };
  }

  async fetchPrice(marketId: string): Promise<{ yesPrice: number; noPrice: number } | null> {
    const market = await fetchKalshiMarket(marketId);
    if (!market) return null;
    const yesPrice = parseFloat(market.yes_ask_dollars ?? '0') / 100;
    return { yesPrice, noPrice: 1 - yesPrice };
  }
}

// ─── Polymarket Adapter ──────────────────────────────────────────

export class PolymarketAdapter implements PlatformAdapter {
  readonly name: string = 'polymarket';

  normalizeMarket(raw: PMMarket): NormalizedMarket {
    const { outcomes, prices } = parseOutcomes(raw);
    const yesIdx = outcomes.findIndex(o => o.toLowerCase() === 'yes');
    const noIdx = outcomes.findIndex(o => o.toLowerCase() === 'no');
    const yesPrice = yesIdx >= 0 ? prices[yesIdx] ?? 0 : 0;
    const noPrice = noIdx >= 0 ? prices[noIdx] ?? 0 : 0;

    const normalizedOutcomes: NormalizedOutcome[] = outcomes.map((name, i) => ({
      name,
      yesPrice: name.toLowerCase() === 'yes' ? prices[i] ?? 0 : 0,
      noPrice: name.toLowerCase() === 'no' ? prices[i] ?? 0 : 0,
      yesDepth: raw.liquidityNum ?? raw.volumeClob ?? 0,
      noDepth: raw.liquidityNum ?? raw.volumeClob ?? 0,
      bestBid: raw.bestBid ?? 0,
      bestAsk: raw.bestAsk ?? 0,
    }));

    return {
      id: raw.id,
      platform: 'polymarket',
      title: raw.groupItemTitle ?? raw.question ?? raw.slug,
      question: raw.question,
      outcomes: normalizedOutcomes,
      endDate: raw.endDate,
      active: raw.active,
      closed: raw.closed,
      slug: raw.slug,
    };
  }

  normalizeOrderbook(raw: ClobBook & { marketId?: string; conditionId?: string }): NormalizedOrderbook {
    return {
      marketId: raw.marketId ?? raw.conditionId ?? '',
      platform: 'polymarket',
      bids: raw.bids.map(b => ({
        price: parseFloat(b.price),
        size: parseFloat(b.size),
      })),
      asks: raw.asks.map(a => ({
        price: parseFloat(a.price),
        size: parseFloat(a.size),
      })),
    };
  }

  async fetchMarkets(_query?: string): Promise<NormalizedMarket[]> {
    if (_query) {
      const event = await fetchPolymarketEvent(_query);
      if (event && event.markets) {
        return event.markets.map(m => this.normalizeMarket(m));
      }
    }
    return [];
  }

  async fetchOrderbook(marketId: string): Promise<NormalizedOrderbook | null> {
    // marketId for Polymarket is the conditionId
    const clob = await fetchClobMarket(marketId);
    if (!clob) return null;

    // For standard binary markets, use the CLOB market-level prices
    // For neg-risk, we need to fetch per-token books
    if (!clob.neg_risk) {
      const book: ClobBook & { marketId: string } = {
        marketId,
        bids: [],
        asks: [],
        min_order_size: '0',
        tick_size: '0',
        last_trade_price: String(clob.last_trade_price ?? ''),
      };
      // Approximate orderbook from best bid/ask
      if (clob.best_bid !== undefined && clob.best_bid !== null) {
        book.bids.push({ price: String(clob.best_bid), size: '1' });
      }
      if (clob.best_ask !== undefined && clob.best_ask !== null) {
        book.asks.push({ price: String(clob.best_ask), size: '1' });
      }
      return this.normalizeOrderbook(book);
    }

    // Neg-risk: fetch per-token orderbooks
    const yesToken = clob.tokens?.find(t => t.outcome === 'Yes');
    const noToken = clob.tokens?.find(t => t.outcome === 'No');

    const bids: { price: string; size: string }[] = [];
    const asks: { price: string; size: string }[] = [];

    if (yesToken) {
      const yesBook = await fetchClobBook(yesToken.token_id);
      if (yesBook) {
        bids.push(...yesBook.bids);
        asks.push(...yesBook.asks);
      }
    }
    if (noToken) {
      const noBook = await fetchClobBook(noToken.token_id);
      if (noBook) {
        bids.push(...noBook.bids);
        asks.push(...noBook.asks);
      }
    }

    return {
      marketId,
      platform: 'polymarket',
      bids: bids.map(b => ({ price: parseFloat(b.price), size: parseFloat(b.size) })),
      asks: asks.map(a => ({ price: parseFloat(a.price), size: parseFloat(a.size) })),
    };
  }

  async fetchPrice(marketId: string): Promise<{ yesPrice: number; noPrice: number } | null> {
    const clob = await fetchClobMarket(marketId);
    if (!clob) return null;
    const prices = await getClobPrices(clob);
    if (!prices) return null;
    return { yesPrice: prices.yesPrice, noPrice: prices.noPrice };
  }
}
