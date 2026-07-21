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
});
