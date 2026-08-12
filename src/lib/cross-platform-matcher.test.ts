import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  refreshMarketCatalog,
  matchCrossPlatformMarkets,
  calculateConfidence,
  normalizeTitle,
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
    conditionId: `condition-${slug}`,
    question: title,
    slug,
    outcomes: '["Yes","No"]',
    outcomePrices: '["0.50","0.50"]',
    active: true,
    closed: false,
    groupItemTitle: category,
    endDate: expiry ?? new Date(Date.now() + 2 * 86400000).toISOString(),
  };
}

function binaryKalshi(ticker: string, status = 'open', title = 'Will Trump win the 2026 election?') {
  return {
    ticker,
    status,
    title,
    yes_sub_title: 'YES',
    no_sub_title: 'NO',
  };
}

function binaryPmEvent(slug: string, active = true, closed = false, question = 'Trump wins 2026 presidential election?') {
  return {
    id: slug,
    slug,
    title: question,
    active,
    closed,
    markets: [{
      id: slug,
      slug,
      question,
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
    const polymarketRows = (persistence.bulkUpsertMarketCatalog as any).mock.calls[1][0];
    expect(polymarketRows[0]).toMatchObject({
      marketId: 'condition-trump-wins-2026',
      eventId: 'trump-wins-2026',
      sourceUrl: 'https://polymarket.com/event/trump-wins-2026',
    });
  });
});

describe('matchCrossPlatformMarkets', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    upsertMarketCatalog.mockResolvedValue(undefined);
    upsertMatchedPair.mockResolvedValue(1);
  });

  it('normalizes punctuation and repeated whitespace for deterministic matching', () => {
    expect(normalizeTitle('  Will Trump win the 2026 election?  ')).toBe('will trump win the 2026 election');
  });

  it('does not award entity points when neither title has a verifiable entity', () => {
    const result = calculateConfidence(
      'Will it happen?',
      'Will it happen?',
      'politics',
      'politics',
      '2026-08-09T00:00:00.000Z',
      '2026-08-09T00:00:00.000Z',
    );

    expect(result.breakdown.entityMatch).toBe(0);
  });

  it('scores shared numeric entities as explicit evidence', () => {
    const result = calculateConfidence(
      'Will rainfall exceed 100 millimeters?',
      'Rainfall above 100 millimeters?',
      'weather',
      'weather',
      '2026-08-09T00:00:00.000Z',
      '2026-08-09T00:00:00.000Z',
    );

    expect(result.breakdown.entityMatch).toBe(30);
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

    (fetchKalshiMarket as any).mockResolvedValue(binaryKalshi('KXTRUMP-26', 'open', 'Trump election outcome 2026'));
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

  it('rejects titles with different named entities even when wording is otherwise identical', async () => {
    queryMarketCatalog.mockImplementation((opts?: any) => {
      const kRow = catalogRow('kalshi', 'Will Alice win the 2026 election?', 'KXALICE-26', 'https://kalshi.com/markets/KXALICE-26');
      const pRow = catalogRow('polymarket', 'Will Bob win the 2026 election?', '0xbob', 'https://polymarket.com/event/bob-wins-2026');
      pRow.eventId = 'bob-wins-2026';
      if (opts?.platform === 'kalshi') return Promise.resolve({ rows: [kRow], total: 1, nextCursor: null });
      if (opts?.platform === 'polymarket') return Promise.resolve({ rows: [pRow], total: 1, nextCursor: null });
      return Promise.resolve({ rows: [], total: 0, nextCursor: null });
    });

    const result = await matchCrossPlatformMarkets();

    expect(result.candidatesChecked).toBe(0);
    expect(fetchKalshiMarket).not.toHaveBeenCalled();
  });

  it('rejects negated propositions before live verification', async () => {
    queryMarketCatalog.mockImplementation((opts?: any) => {
      const kRow = catalogRow('kalshi', 'Will Trump win the 2026 election?', 'KXTRUMP-26', 'https://kalshi.com/markets/KXTRUMP-26');
      const pRow = catalogRow('polymarket', 'Will Trump not win the 2026 election?', '0xcondition', 'https://polymarket.com/event/trump-not-win-2026');
      pRow.eventId = 'trump-not-win-2026';
      if (opts?.platform === 'kalshi') return Promise.resolve({ rows: [kRow], total: 1, nextCursor: null });
      if (opts?.platform === 'polymarket') return Promise.resolve({ rows: [pRow], total: 1, nextCursor: null });
      return Promise.resolve({ rows: [], total: 0, nextCursor: null });
    });

    const result = await matchCrossPlatformMarkets();

    expect(result.candidatesChecked).toBe(0);
    expect(fetchKalshiMarket).not.toHaveBeenCalled();
  });

  it('rejects opposite comparator directions before live verification', async () => {
    queryMarketCatalog.mockImplementation((opts?: any) => {
      const kRow = catalogRow('kalshi', 'Will rainfall exceed 100 millimeters?', 'KXRAIN-100', 'https://kalshi.com/markets/KXRAIN-100', 'weather');
      const pRow = catalogRow('polymarket', 'Will rainfall stay below 100 millimeters?', '0xrain', 'https://polymarket.com/event/rain-below-100', 'weather');
      pRow.eventId = 'rain-below-100';
      if (opts?.platform === 'kalshi') return Promise.resolve({ rows: [kRow], total: 1, nextCursor: null });
      if (opts?.platform === 'polymarket') return Promise.resolve({ rows: [pRow], total: 1, nextCursor: null });
      return Promise.resolve({ rows: [], total: 0, nextCursor: null });
    });

    const result = await matchCrossPlatformMarkets();

    expect(result.candidatesChecked).toBe(0);
    expect(fetchKalshiMarket).not.toHaveBeenCalled();
  });

  it('discards candidates below the configured review threshold', async () => {
    queryMarketCatalog.mockImplementation((opts?: any) => {
      const kRow = catalogRow('kalshi', 'Will Trump win the 2026 election?', 'KXTRUMP-26', 'https://kalshi.com/markets/KXTRUMP-26');
      const pRow = catalogRow('polymarket', 'Trump wins 2026 presidential election?', '0xcondition', 'https://polymarket.com/event/trump-wins-2026');
      pRow.eventId = 'trump-wins-2026';
      if (opts?.platform === 'kalshi') return Promise.resolve({ rows: [kRow], total: 1, nextCursor: null });
      if (opts?.platform === 'polymarket') return Promise.resolve({ rows: [pRow], total: 1, nextCursor: null });
      return Promise.resolve({ rows: [], total: 0, nextCursor: null });
    });

    const result = await matchCrossPlatformMarkets({ candidateThreshold: 0, reviewThreshold: 80 });

    expect(result.candidatesChecked).toBe(0);
    expect(fetchKalshiMarket).not.toHaveBeenCalled();
  });

  it('rejects an exact URL whose live market semantics no longer match the catalog', async () => {
    queryMarketCatalog.mockImplementation((opts?: any) => {
      const kRow = catalogRow('kalshi', 'Will Trump win the 2026 election?', 'KXTRUMP-26', 'https://kalshi.com/markets/KXTRUMP-26');
      const pRow = catalogRow('polymarket', 'Trump wins 2026 presidential election?', '0xcondition', 'https://polymarket.com/event/trump-wins-2026');
      pRow.eventId = 'trump-wins-2026';
      if (opts?.platform === 'kalshi') return Promise.resolve({ rows: [kRow], total: 1, nextCursor: null });
      if (opts?.platform === 'polymarket') return Promise.resolve({ rows: [pRow], total: 1, nextCursor: null });
      return Promise.resolve({ rows: [], total: 0, nextCursor: null });
    });
    (fetchKalshiMarket as any).mockResolvedValue(binaryKalshi('KXTRUMP-26'));
    const changed = binaryPmEvent('trump-wins-2026');
    changed.markets[0].question = 'Will rainfall exceed 100 millimeters?';
    (fetchPolymarketMarketAsEvent as any).mockResolvedValue(changed);

    const result = await matchCrossPlatformMarkets();

    expect(result.verifiedPairs).toBe(0);
    expect(upsertMatchedPair).not.toHaveBeenCalled();
  });

  it('uses defaults when API options are explicitly undefined', async () => {
    queryMarketCatalog.mockImplementation((opts?: any) => {
      const kRow = catalogRow('kalshi', 'Will Trump win the 2026 election?', 'KXTRUMP-26', 'https://kalshi.com/markets/KXTRUMP-26');
      const pRow = catalogRow('polymarket', 'Trump wins 2026 presidential election?', '0xcondition', 'https://polymarket.com/event/trump-wins-2026');
      pRow.eventId = 'trump-wins-2026';
      if (opts?.platform === 'kalshi') return Promise.resolve({ rows: [kRow], total: 1, nextCursor: null });
      if (opts?.platform === 'polymarket') return Promise.resolve({ rows: [pRow], total: 1, nextCursor: null });
      return Promise.resolve({ rows: [], total: 0, nextCursor: null });
    });
    (fetchKalshiMarket as any).mockResolvedValue(binaryKalshi('KXTRUMP-26'));
    (fetchPolymarketMarketAsEvent as any).mockResolvedValue(binaryPmEvent('trump-wins-2026'));

    const result = await matchCrossPlatformMarkets({
      candidateThreshold: undefined,
      maxVerifications: undefined,
      maxExpiryDays: undefined,
      autoQueueThreshold: undefined,
      reviewThreshold: undefined,
    });

    expect(result.verifiedPairs).toBe(1);
  });

  it('never auto-queues ambiguous one-to-many title matches', async () => {
    queryMarketCatalog.mockImplementation((opts?: any) => {
      const kRow = catalogRow('kalshi', 'Will Trump win the 2026 election?', 'KXTRUMP-26', 'https://kalshi.com/markets/KXTRUMP-26');
      const p1 = catalogRow('polymarket', 'Trump wins 2026 presidential election?', '0xone', 'https://polymarket.com/event/trump-wins-2026-a');
      const p2 = catalogRow('polymarket', 'Trump wins 2026 presidential election?', '0xtwo', 'https://polymarket.com/event/trump-wins-2026-b');
      p1.eventId = 'trump-wins-2026-a';
      p2.eventId = 'trump-wins-2026-b';
      if (opts?.platform === 'kalshi') return Promise.resolve({ rows: [kRow], total: 1, nextCursor: null });
      if (opts?.platform === 'polymarket') return Promise.resolve({ rows: [p1, p2], total: 2, nextCursor: null });
      return Promise.resolve({ rows: [], total: 0, nextCursor: null });
    });
    (fetchKalshiMarket as any).mockResolvedValue(binaryKalshi('KXTRUMP-26'));
    (fetchPolymarketMarketAsEvent as any).mockImplementation((slug: string) => Promise.resolve(binaryPmEvent(slug)));

    const result = await matchCrossPlatformMarkets({ maxVerifications: 10 });

    expect(result.autoQueued).toBe(0);
    expect(result.pendingReview).toBe(2);
    expect(upsertMatchedPair.mock.calls.every((call: any[]) => call[0].status === 'pending_review')).toBe(true);
  });

  it('reads every catalog page before matching', async () => {
    queryMarketCatalog.mockImplementation((opts?: any) => {
      if (!opts?.cursor) return Promise.resolve({ rows: [], total: 1001, nextCursor: 1000 });
      const row = opts.platform === 'kalshi'
        ? catalogRow('kalshi', 'Will Trump win the 2026 election?', 'KXTRUMP-26', 'https://kalshi.com/markets/KXTRUMP-26')
        : catalogRow('polymarket', 'Trump wins 2026 presidential election?', '0xcondition', 'https://polymarket.com/event/trump-wins-2026');
      if (opts.platform === 'polymarket') row.eventId = 'trump-wins-2026';
      return Promise.resolve({ rows: [row], total: 1001, nextCursor: null });
    });
    (fetchKalshiMarket as any).mockResolvedValue(binaryKalshi('KXTRUMP-26'));
    (fetchPolymarketMarketAsEvent as any).mockResolvedValue(binaryPmEvent('trump-wins-2026'));

    const result = await matchCrossPlatformMarkets({ maxVerifications: 10 });

    expect(result.verifiedPairs).toBe(1);
    expect(queryMarketCatalog).toHaveBeenCalledWith(expect.objectContaining({ platform: 'kalshi', cursor: 1000 }));
    expect(queryMarketCatalog).toHaveBeenCalledWith(expect.objectContaining({ platform: 'polymarket', cursor: 1000 }));
  });

  it('stores canonical URLs and the catalog market id after exact live verification', async () => {
    queryMarketCatalog.mockImplementation((opts?: any) => {
      const kRow = catalogRow('kalshi', 'Will Trump win the 2026 election?', 'KXTRUMP-26', 'https://example.invalid/kalshi');
      const pRow = catalogRow('polymarket', 'Trump wins 2026 presidential election?', '0xcondition', 'https://example.invalid/polymarket');
      pRow.eventId = 'trump-wins-2026';
      if (opts?.platform === 'kalshi') return Promise.resolve({ rows: [kRow], total: 1, nextCursor: null });
      if (opts?.platform === 'polymarket') return Promise.resolve({ rows: [pRow], total: 1, nextCursor: null });
      return Promise.resolve({ rows: [], total: 0, nextCursor: null });
    });
    (fetchKalshiMarket as any).mockResolvedValue(binaryKalshi('KXTRUMP-26'));
    (fetchPolymarketMarketAsEvent as any).mockResolvedValue(binaryPmEvent('trump-wins-2026'));

    const result = await matchCrossPlatformMarkets({ maxVerifications: 10 });

    expect(result.verifiedPairs).toBe(1);
    expect(fetchPolymarketMarketAsEvent).toHaveBeenCalledWith('trump-wins-2026');
    expect(upsertMatchedPair).toHaveBeenCalledWith(expect.objectContaining({
      kalshiMarketId: 'KXTRUMP-26',
      polymarketMarketId: '0xcondition',
      kalshiUrl: 'https://kalshi.com/markets/KXTRUMP-26',
      polymarketUrl: 'https://polymarket.com/event/trump-wins-2026',
    }));
  });

  it('rejects otherwise similar titles when numeric entities conflict', async () => {
    queryMarketCatalog.mockImplementation((opts?: any) => {
      const kRow = catalogRow('kalshi', 'Will Trump win the 2026 presidential election?', 'KXTRUMP-26', 'https://kalshi.com/markets/KXTRUMP-26');
      const pRow = catalogRow('polymarket', 'Will Trump win the 2028 presidential election?', 'pm-condition-id', 'https://polymarket.com/event/trump-wins-2028');
      pRow.eventId = 'trump-wins-2028';
      if (opts?.platform === 'kalshi') return Promise.resolve({ rows: [kRow], total: 1, nextCursor: null });
      if (opts?.platform === 'polymarket') return Promise.resolve({ rows: [pRow], total: 1, nextCursor: null });
      return Promise.resolve({ rows: [], total: 0, nextCursor: null });
    });

    const result = await matchCrossPlatformMarkets({ maxVerifications: 10 });

    expect(result.candidatesChecked).toBe(0);
    expect(fetchKalshiMarket).not.toHaveBeenCalled();
    expect(fetchPolymarketMarketAsEvent).not.toHaveBeenCalled();
  });

  it('filters non-binary catalog rows before scoring or live verification', async () => {
    queryMarketCatalog.mockImplementation((opts?: any) => {
      const kRow = catalogRow('kalshi', 'Will Trump win the 2026 election?', 'KXTRUMP-26', 'https://kalshi.com/markets/KXTRUMP-26');
      const pRow = catalogRow('polymarket', 'Trump wins 2026 presidential election?', 'pm-condition-id', 'https://polymarket.com/event/trump-wins-2026');
      pRow.eventId = 'trump-wins-2026';
      pRow.isBinary = false;
      pRow.outcomeCount = 3;
      if (opts?.platform === 'kalshi') return Promise.resolve({ rows: [kRow], total: 1, nextCursor: null });
      if (opts?.platform === 'polymarket') return Promise.resolve({ rows: [pRow], total: 1, nextCursor: null });
      return Promise.resolve({ rows: [], total: 0, nextCursor: null });
    });

    const result = await matchCrossPlatformMarkets({ maxVerifications: 10 });

    expect(result.candidatesChecked).toBe(0);
    expect(fetchKalshiMarket).not.toHaveBeenCalled();
    expect(fetchPolymarketMarketAsEvent).not.toHaveBeenCalled();
  });

  it('fails closed before verification when either expiry is missing', async () => {
    queryMarketCatalog.mockImplementation((opts?: any) => {
      const kRow = catalogRow('kalshi', 'Will Trump win the 2026 election?', 'KXTRUMP-26', 'https://kalshi.com/markets/KXTRUMP-26', 'politics', undefined);
      const pRow = catalogRow('polymarket', 'Trump wins 2026 presidential election?', 'pm-condition-id', 'https://polymarket.com/event/trump-wins-2026', 'politics');
      kRow.expiryDate = null;
      pRow.eventId = 'trump-wins-2026';
      if (opts?.platform === 'kalshi') return Promise.resolve({ rows: [kRow], total: 1, nextCursor: null });
      if (opts?.platform === 'polymarket') return Promise.resolve({ rows: [pRow], total: 1, nextCursor: null });
      return Promise.resolve({ rows: [], total: 0, nextCursor: null });
    });

    const result = await matchCrossPlatformMarkets({ maxVerifications: 10 });

    expect(result.candidatesChecked).toBe(0);
    expect(fetchKalshiMarket).not.toHaveBeenCalled();
    expect(fetchPolymarketMarketAsEvent).not.toHaveBeenCalled();
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
});
