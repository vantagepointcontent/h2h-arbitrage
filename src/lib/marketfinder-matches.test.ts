import { describe, expect, it } from 'vitest';
import { buildUnsavedMarketMatches } from './marketfinder-matches';

const pair = (overrides: Record<string, unknown> = {}) => ({
  id: 7,
  kalshiMarketId: 'KX-ELECTION',
  polymarketMarketId: '0xpm',
  kalshiTitle: 'Will the candidate win?',
  polymarketTitle: 'Candidate to win?',
  kalshiUrl: 'https://kalshi.com/markets/KX-ELECTION',
  polymarketUrl: 'https://polymarket.com/event/candidate-win?ref=tracker',
  confidence: 84,
  confidenceBreakdown: {
    nameSimilarity: 80,
    entityMatch: 80,
    categoryMatch: 80,
    expiryProximity: 80,
  },
  status: 'auto_queued' as const,
  matchedAt: '2026-08-09T10:00:00.000Z',
  verifiedAt: '2026-08-09T10:00:00.000Z',
  ...overrides,
});

const catalog = [
  {
    platform: 'kalshi' as const,
    marketId: 'KX-ELECTION',
    category: 'politics',
    expiryDate: '2026-11-03T00:00:00.000Z',
  },
  {
    platform: 'polymarket' as const,
    marketId: '0xpm',
    category: 'elections',
    expiryDate: '2026-11-04T00:00:00.000Z',
  },
];

describe('buildUnsavedMarketMatches', () => {
  it('filters saved pairs using case-insensitive tracking-free URL identity', () => {
    const matches = buildUnsavedMarketMatches(
      [pair()],
      [{ kalshiUrl: '', polymarketUrl: 'HTTPS://POLYMARKET.COM/event/candidate-win/' }],
      catalog,
    );

    expect(matches).toEqual([]);
  });

  it('returns MarketFinder rows enriched with category and earliest expiry', () => {
    const matches = buildUnsavedMarketMatches([pair()], [], catalog);

    expect(matches).toEqual([
      expect.objectContaining({
        id: 'match-7',
        title: 'Will the candidate win?',
        eventType: 'politics',
        eventDate: '2026-11-03T00:00:00.000Z',
        confidence: 84,
        status: 'auto_queued',
      }),
    ]);
  });

  it('sorts highest confidence first by default', () => {
    const matches = buildUnsavedMarketMatches(
      [pair({ id: 1, confidence: 61 }), pair({ id: 2, confidence: 95 })],
      [],
      catalog,
    );

    expect(matches.map((match) => match.confidence)).toEqual([95, 61]);
  });
});
