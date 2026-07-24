import { describe, expect, it } from 'vitest';
import { parseSavedMarketId, parseSavedMarketPatch } from './saved-market-request';

describe('saved market request parsing', () => {
  it('accepts a safe patch', () => {
    expect(parseSavedMarketPatch({ id: 'market-1', category: ' Politics ' })).toEqual({ id: 'market-1', category: 'Politics' });
  });

  it.each([{}, { id: '' }, { id: 'x' }, { id: 'x', favorite: true }, { id: 'x', category: 1 }, { id: 'x', eventTitle: '' }])('rejects invalid patches', (body) => {
    expect(parseSavedMarketPatch(body)).toEqual(expect.objectContaining({ error: expect.any(String) }));
  });

  it.each([null, '', '  ', 'x'.repeat(201), 'market-1'])('validates ids', (id) => {
    expect(Boolean(parseSavedMarketId(id))).toBe(id === 'market-1');
  });

  it('accepts kalshiUrl and polymarketUrl', () => {
    const patch = parseSavedMarketPatch({
      id: 'market-1',
      kalshiUrl: 'https://kalshi.com/markets/KX-DEMO/demo/kx-demo-26jun01',
      polymarketUrl: 'https://polymarket.com/event/demo-event',
    });
    expect(patch).toEqual(expect.objectContaining({
      id: 'market-1',
      kalshiUrl: 'https://kalshi.com/markets/KX-DEMO/demo/kx-demo-26jun01',
      polymarketUrl: 'https://polymarket.com/event/demo-event',
    }));
  });

  it('accepts platformLinks array', () => {
    const patch = parseSavedMarketPatch({
      id: 'market-1',
      platformLinks: [
        { platform: 'kalshi', url: 'https://kalshi.com/markets/KX-DEMO' },
        { platform: 'polymarket', url: 'https://polymarket.com/event/demo' },
      ],
    });
    expect(patch).toEqual(expect.objectContaining({
      id: 'market-1',
      platformLinks: [
        { platform: 'kalshi', url: 'https://kalshi.com/markets/KX-DEMO' },
        { platform: 'polymarket', url: 'https://polymarket.com/event/demo' },
      ],
    }));
  });

  it('rejects invalid kalshiUrl', () => {
    const patch = parseSavedMarketPatch({ id: 'market-1', kalshiUrl: 'not-a-url' });
    expect(patch).toEqual(expect.objectContaining({ error: expect.any(String) }));
  });

  it('rejects invalid polymarketUrl', () => {
    const patch = parseSavedMarketPatch({ id: 'market-1', polymarketUrl: 'not-a-url' });
    expect(patch).toEqual(expect.objectContaining({ error: expect.any(String) }));
  });

  it('rejects non-array platformLinks', () => {
    const patch = parseSavedMarketPatch({ id: 'market-1', platformLinks: 'not-an-array' });
    expect(patch).toEqual(expect.objectContaining({ error: expect.any(String) }));
  });

  it('rejects platformLinks with missing fields', () => {
    const patch = parseSavedMarketPatch({ id: 'market-1', platformLinks: [{ url: 'https://kalshi.com' }] });
    expect(patch).toEqual(expect.objectContaining({ error: expect.any(String) }));
  });

  it('rejects platformLinks with invalid url', () => {
    const patch = parseSavedMarketPatch({ id: 'market-1', platformLinks: [{ platform: 'kalshi', url: 'not-a-url' }] });
    expect(patch).toEqual(expect.objectContaining({ error: expect.any(String) }));
  });
});
