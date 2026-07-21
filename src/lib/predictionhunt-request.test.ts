import { describe, expect, it } from 'vitest';
import { parseSavePredictionHuntMarketRequest } from './predictionhunt-request';

describe('parseSavePredictionHuntMarketRequest', () => {
  it('accepts and normalizes a valid market', () => {
    expect(parseSavePredictionHuntMarketRequest({
      kalshiUrl: ' https://kalshi.com/markets/KXTEST ',
      polymarketUrl: ' https://polymarket.com/event/test ',
      title: ' Test ',
      category: ' sports ',
      expiryDate: ' 2026-12-01T00:00:00Z ',
    })).toEqual({
      kalshiUrl: 'https://kalshi.com/markets/KXTEST', polymarketUrl: 'https://polymarket.com/event/test',
      title: 'Test', category: 'sports', expiryDate: '2026-12-01T00:00:00Z',
    });
  });

  it.each([{}, { kalshiUrl: 'https://kalshi.com' }, { polymarketUrl: 'https://polymarket.com' }, { kalshiUrl: [], polymarketUrl: {} }])
  ('rejects missing or non-string URLs', (body) => {
    expect(parseSavePredictionHuntMarketRequest(body)).toEqual(expect.objectContaining({ error: expect.any(String) }));
  });
});
