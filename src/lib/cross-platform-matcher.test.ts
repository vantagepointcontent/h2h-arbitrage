import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  refreshMarketCatalog,
  matchCrossPlatformMarkets,
} from './cross-platform-matcher';

vi.mock('./predictionhunt', () => ({
  fetchAllPlatformMarkets: vi.fn(),
}));

vi.mock('./kalshi', () => ({
  extractKalshiMarketTicker: (url: string) => {
    const m = url.match(/kalshi\.com\/markets\/([^\/\?]+)/);
    return m ? m[1].toUpperCase() : null;
  },
  fetchAllKalshiMarkets: vi.fn(),
  fetchKalshiMarket: vi.fn(),
}));

vi.mock('./polymarket', () => ({
  extractPolymarketSlug: (url: string) => {
    const m = url.match(/polymarket\.com\/event\/([^\/\?]+)/);
    return m ? m[1] : null;
  },
  fetchAllPolymarketMarkets: vi.fn(),
  fetchPolymarketMarketAsEvent: vi.fn(),
  parseOutcomes: vi.fn((market: any) => {
    try {
      return {
        outcomes: JSON.parse(market.outcomes) as string[],
        prices: JSON.parse(market.outcomePrices) as number[],
      };
    } catch {
      return { outcomes: [], prices: [] };
    }
  }),
}));

vi.mock('./persistence', () => ({
  MarketCatalogRow: undefined,
  MatchedPair: undefined,
  upsertMarketCatalog: vi.fn(),
  bulkUpsertMarketCatalog: vi.fn(),
  markStaleMarketCatalog: vi.fn(),
  queryMarketCatalog: vi.fn(),
  upsertMatchedPair: vi.fn(),
  getMatchedPairs: vi.fn(),
  getMatchedPairById: vi.fn(),
  updateMatchedPairStatus: vi.fn(),
  approveMatchedPair: vi.fn(),
  rejectMatchedPair: vi.fn(),
}));

import { fetchAllPlatformMarkets } from './predictionhunt';
import { fetchAllKalshiMarkets, fetchKalshiMarket } from './kalshi';
import { fetchAllPolymarketMarkets, fetchPolymarketMarketAsEvent } from './polymarket';
import * as persistence from './persistence';

const upsertMarketCatalog = persistence.upsertMarketCatalog as any;
const queryMarketCatalog = persistence.queryMarketCatalog as any;
const upsertMatchedPair = persistence.upsertMatchedPair as any;

function kalshiMarket(title: string, ticker: string, category = 'politics', expiry?: string) {
  return {
    id: ticker,
    title,
    platform: 'kalshi',
    source_url: `https://kalshi.com/markets/${ticker}`,
    category,
    expiration_date: expiry ?? new Date(Date.now() + 2 * 86400000).toISOString(),
    price: {},
  };
}

function pmMarket(title: string, slug: string, category = 'politics', expiry?: string) {
  return {
    id: slug,
    title,
    platform: 'polymarket',
    source_url: `https://polymarket.com/event/${slug}`,
    category,
    expiration_date: expiry ?? new Date(Date.now() + 2 * 86400000).toISOString(),
    price: {},
  };
}

function binaryKalshi(ticker: string, status = 'active') {
  return {
    ticker,
    status,
    title: 'Will it happen?',
    yes_sub_title: 'YES',
    no_sub_title: 'NO',
  };
}

function binaryPmEvent(slug: string, active = true, closed = false) {
  return {
    id: slug,
    slug,
    title: 'Will it happen?',
    active,
    closed,
    markets: [{
      id: slug,
      slug,
      question: 'Will it happen?',
      active,
      closed,
      outcomes: '["Yes","No"]',
      outcomePrices: '["0.50","0.50"]',
    }],
  };
}

function catalogRow(platform: 'kalshi' | 'polymarket', title: string, marketId: string, sourceUrl: string, category = 'politics', expiry?: string): any {
  return {
    id: 1,
    platform,
    marketId,
    title,
    category,
    eventId: marketId,
    eventTitle: title,
    expiryDate: expiry ?? new Date(Date.now() + 2 * 86400000).toISOString(),
    isBinary: true,
    outcomeCount: 2,
    yesBid: null,
    yesAsk: null,
    noBid: null,
    noAsk: null,
    volume24h: null,
    sourceUrl,
    fetchedAt: new Date().toISOString(),
    stale: false,
  };
}

describe('refreshMarketCatalog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    upsertMarketCatalog.mockResolvedValue(undefined);
  });

  it('upserts Kalshi and Polymarket markets into the catalog', async () => {
    (fetchAllKalshiMarkets as any).mockResolvedValue([kalshiMarket('Trump wins 2026', 'KXTRUMP-26')]);
    (fetchAllPolymarketMarkets as any).mockResolvedValue([pmMarket('Trump wins 2026', 'trump-wins-2026')]);

    const result = await refreshMarketCatalog();

    expect(result.kalshi).toBe(1);
    expect(result.polymarket).toBe(1);
    expect(persistence.bulkUpsertMarketCatalog).toHaveBeenCalledTimes(2);
  });
});

describe('matchCrossPlatformMarkets', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    upsertMarketCatalog.mockResolvedValue(undefined);
    upsertMatchedPair.mockResolvedValue(1);
  });

  it('verifies and stores a high-confidence pair as auto_queued', async () => {
    (fetchAllPlatformMarkets as any).mockImplementation((platform: string) =>
      Promise.resolve(platform === 'kalshi'
        ? [kalshiMarket('Will Trump win the 2026 election?', 'KXTRUMP-26', 'politics')]
        : [pmMarket('Trump wins 2026 presidential election?', 'trump-wins-2026', 'politics')]),
    );

    queryMarketCatalog.mockImplementation((opts?: any) => {
      const kRow = catalogRow('kalshi', 'Will Trump win the 2026 election?', 'KXTRUMP-26', `https://kalshi.com/markets/KXTRUMP-26`, 'politics');
      const pRow = catalogRow('polymarket', 'Trump wins 2026 presidential election?', 'trump-wins-2026', `https://polymarket.com/event/trump-wins-2026`, 'politics');
      if (opts?.platform === 'kalshi') return Promise.resolve({ rows: [kRow], total: 1, nextCursor: null });
      if (opts?.platform === 'polymarket') return Promise.resolve({ rows: [pRow], total: 1, nextCursor: null });
      return Promise.resolve({ rows: [], total: 0, nextCursor: null });
    });

    (fetchKalshiMarket as any).mockResolvedValue(binaryKalshi('KXTRUMP-26'));
    (fetchPolymarketMarketAsEvent as any).mockResolvedValue(binaryPmEvent('trump-wins-2026'));

    const result = await matchCrossPlatformMarkets({ maxVerifications: 10 });

    expect(result.candidatesChecked).toBeGreaterThanOrEqual(1);
    expect(result.verifiedPairs).toBe(1);
    expect(result.autoQueued).toBe(1);
    expect(upsertMatchedPair).toHaveBeenCalledTimes(1);
    const stored = upsertMatchedPair.mock.calls[0][0];
    expect(stored.status).toBe('auto_queued');
    expect(stored.confidence).toBeGreaterThanOrEqual(70);
    expect(stored.confidenceBreakdown).toMatchObject({
      nameSimilarity: expect.any(Number),
      entityMatch: expect.any(Number),
      categoryMatch: expect.any(Number),
      expiryProximity: expect.any(Number),
    });
  });

  it('stores a medium-confidence pair as pending_review', async () => {
    (fetchAllPlatformMarkets as any).mockImplementation((platform: string) =>
      Promise.resolve(platform === 'kalshi'
        ? [kalshiMarket('Trump election outcome 2026', 'KXTRUMP-26', 'politics')]
        : [pmMarket('Trump wins 2026 presidential election?', 'trump-wins-2026', 'politics')]),
    );

    queryMarketCatalog.mockImplementation((opts?: any) => {
      const kRow = catalogRow('kalshi', 'Trump election outcome 2026', 'KXTRUMP-26', `https://kalshi.com/markets/KXTRUMP-26`, 'politics');
      const pRow = catalogRow('polymarket', 'Trump wins 2026 presidential election?', 'trump-wins-2026', `https://polymarket.com/event/trump-wins-2026`, 'politics');
      if (opts?.platform === 'kalshi') return Promise.resolve({ rows: [kRow], total: 1, nextCursor: null });
      if (opts?.platform === 'polymarket') return Promise.resolve({ rows: [pRow], total: 1, nextCursor: null });
      return Promise.resolve({ rows: [], total: 0, nextCursor: null });
    });

    (fetchKalshiMarket as any).mockResolvedValue(binaryKalshi('KXTRUMP-26'));
    (fetchPolymarketMarketAsEvent as any).mockResolvedValue(binaryPmEvent('trump-wins-2026'));

    const result = await matchCrossPlatformMarkets({ maxVerifications: 10, autoQueueThreshold: 95 });

    expect(result.verifiedPairs).toBe(1);
    expect(result.pendingReview).toBe(1);
    const stored = upsertMatchedPair.mock.calls[0][0];
    expect(stored.status).toBe('pending_review');
  });

  it('rejects a pair when platform verification shows a non-binary market', async () => {
    (fetchAllPlatformMarkets as any).mockImplementation((platform: string) =>
      Promise.resolve(platform === 'kalshi'
        ? [kalshiMarket('Will Trump win the 2026 election?', 'KXTRUMP-26', 'politics')]
        : [pmMarket('Trump wins 2026 presidential election?', 'trump-wins-2026', 'politics')]),
    );

    queryMarketCatalog.mockImplementation((opts?: any) => {
      const kRow = catalogRow('kalshi', 'Will Trump win the 2026 election?', 'KXTRUMP-26', `https://kalshi.com/markets/KXTRUMP-26`, 'politics');
      const pRow = catalogRow('polymarket', 'Trump wins 2026 presidential election?', 'trump-wins-2026', `https://polymarket.com/event/trump-wins-2026`, 'politics');
      if (opts?.platform === 'kalshi') return Promise.resolve({ rows: [kRow], total: 1, nextCursor: null });
      if (opts?.platform === 'polymarket') return Promise.resolve({ rows: [pRow], total: 1, nextCursor: null });
      return Promise.resolve({ rows: [], total: 0, nextCursor: null });
    });

    (fetchKalshiMarket as any).mockResolvedValue(binaryKalshi('KXTRUMP-26'));
    (fetchPolymarketMarketAsEvent as any).mockResolvedValue({
      id: 'trump-wins-2026',
      slug: 'trump-wins-2026',
      active: true,
      closed: false,
      markets: [{
        id: 'trump-wins-2026',
        slug: 'trump-wins-2026',
        active: true,
        closed: false,
        outcomes: '["Yes","No","Maybe"]',
        outcomePrices: '["0.33","0.33","0.34"]',
      }],
    });

    const result = await matchCrossPlatformMarkets({ maxVerifications: 10 });

    expect(result.verifiedPairs).toBe(0);
    expect(upsertMatchedPair).not.toHaveBeenCalled();
  });

  it('does not verify low-confidence candidates', async () => {
    (fetchAllPlatformMarkets as any).mockImplementation((platform: string) =>
      Promise.resolve(platform === 'kalshi'
        ? [kalshiMarket('Will the Fed raise rates?', 'KXFED-26', 'economics')]
        : [pmMarket('Trump wins 2026 presidential election?', 'trump-wins-2026', 'politics')]),
    );

    queryMarketCatalog.mockImplementation((opts?: any) => {
      const kRow = catalogRow('kalshi', 'Will the Fed raise rates?', 'KXTRUMP-26', `https://kalshi.com/markets/KXTRUMP-26`, 'politics');
      const pRow = catalogRow('polymarket', 'Trump wins 2026 presidential election?', 'trump-wins-2026', `https://polymarket.com/event/trump-wins-2026`, 'politics');
      if (opts?.platform === 'kalshi') return Promise.resolve({ rows: [kRow], total: 1, nextCursor: null });
      if (opts?.platform === 'polymarket') return Promise.resolve({ rows: [pRow], total: 1, nextCursor: null });
      return Promise.resolve({ rows: [], total: 0, nextCursor: null });
    });

    const result = await matchCrossPlatformMarkets({ maxVerifications: 10 });

    expect(result.candidatesChecked).toBe(0);
    expect(result.verifiedPairs).toBe(0);
    expect(fetchKalshiMarket).not.toHaveBeenCalled();
    expect(fetchPolymarketMarketAsEvent).not.toHaveBeenCalled();
  });

  it('bounds confidence comparisons and yields the event loop for oversized catalog buckets', async () => {
    const kalshiRows = Array.from({ length: 200 }, (_, index) => catalogRow(
      'kalshi',
      `Kalshi unrelated contract ${index}`,
      `KX-${index}`,
      `https://kalshi.com/markets/KX-${index}`,
      'world',
    ));
    const polymarketRows = Array.from({ length: 200 }, (_, index) => catalogRow(
      'polymarket',
      `Polymarket different question ${index}`,
      `pm-${index}`,
      `https://polymarket.com/event/pm-${index}`,
      'world',
    ));
    queryMarketCatalog.mockImplementation((opts?: { platform?: 'kalshi' | 'polymarket' }) => {
      const rows = opts?.platform === 'kalshi' ? kalshiRows : polymarketRows;
      return Promise.resolve({ rows, total: rows.length, nextCursor: null });
    });

    let eventLoopYielded = false;
    setTimeout(() => { eventLoopYielded = true; }, 0);

    const result = await matchCrossPlatformMarkets({
      candidateThreshold: 101,
      maxVerifications: 0,
      maxCatalogRowsPerPlatform: 100,
      maxCandidateComparisons: 250,
      yieldEveryComparisons: 50,
    });

    expect(result.kalshiCatalogCount).toBe(200);
    expect(result.polymarketCatalogCount).toBe(200);
    expect(result.kalshiRowsLoaded).toBe(100);
    expect(result.polymarketRowsLoaded).toBe(100);
    expect(queryMarketCatalog).toHaveBeenCalledWith(expect.objectContaining({ limit: 100 }));
    expect(result.candidateComparisons).toBe(250);
    expect(result.matchingTruncated).toBe(true);
    expect(eventLoopYielded).toBe(true);
    expect(fetchKalshiMarket).not.toHaveBeenCalled();
    expect(fetchPolymarketMarketAsEvent).not.toHaveBeenCalled();
  });

  it('reports truncation when the catalog row cap is reached without reaching the comparison cap', async () => {
    const kalshiRows = [catalogRow(
      'kalshi',
      'Kalshi contract',
      'KX-1',
      'https://kalshi.com/markets/KX-1',
      'politics',
    )];
    const polymarketRows = [catalogRow(
      'polymarket',
      'Polymarket question',
      'pm-1',
      'https://polymarket.com/event/pm-1',
      'sports',
    )];
    queryMarketCatalog.mockImplementation((opts?: { platform?: 'kalshi' | 'polymarket' }) => {
      const rows = opts?.platform === 'kalshi' ? kalshiRows : polymarketRows;
      return Promise.resolve({ rows, total: 590_820, nextCursor: null });
    });

    const result = await matchCrossPlatformMarkets({
      candidateThreshold: 101,
      maxVerifications: 0,
      maxCatalogRowsPerPlatform: 1,
      maxCandidateComparisons: 100_000,
    });

    expect(result.kalshiCatalogCount).toBe(590_820);
    expect(result.polymarketCatalogCount).toBe(590_820);
    expect(result.kalshiRowsLoaded).toBe(1);
    expect(result.polymarketRowsLoaded).toBe(1);
    expect(result.candidateComparisons).toBe(0);
    expect(result.matchingTruncated).toBe(true);
  });
});
