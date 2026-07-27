import { describe, expect, it } from 'vitest';
import { parseAllMarketsRequest } from './all-markets-request';

describe('all-markets request parsing', () => {
  it('accepts and trims valid platform URLs', () => {
    expect(parseAllMarketsRequest(
      ' https://www.kalshi.com/markets/KX-DEMO/demo/kx-demo-26jun01 ',
      ' https://www.polymarket.com/event/demo-event ',
    )).toEqual({
      kalshiUrl: 'https://www.kalshi.com/markets/KX-DEMO/demo/kx-demo-26jun01',
      pmUrl: 'https://www.polymarket.com/event/demo-event',
    });
  });

  it('allows an empty request without fetching global markets', () => {
    expect(parseAllMarketsRequest(null, null)).toEqual({ kalshiUrl: null, pmUrl: null });
  });

  it.each([
    ['kalshiUrl', 'https://kalshi.com.evil.example/markets/KX-DEMO'],
    ['kalshiUrl', 'https://kalshi.com/not-a-market'],
    ['pmUrl', 'https://polymarket.com.evil.example/event/demo'],
    ['pmUrl', 'https://polymarket.com/not-a-market'],
    ['pmUrl', 'ftp://polymarket.com/event/demo'],
  ])('rejects malformed or lookalike %s values', (field, value) => {
    const parsed = parseAllMarketsRequest(
      field === 'kalshiUrl' ? value : null,
      field === 'pmUrl' ? value : null,
    );
    expect(parsed).toEqual(expect.objectContaining({ error: expect.any(String) }));
  });
});
