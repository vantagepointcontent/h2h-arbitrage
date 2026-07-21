import { describe, expect, it } from 'vitest';
import { parseRefreshStartRequest } from './refresh-request';

describe('refresh start request parsing', () => {
  it('allows a full refresh', () => expect(parseRefreshStartRequest({})).toEqual({}));
  it('allows valid market IDs', () => expect(parseRefreshStartRequest({ ids: ['a', 'market-2'] })).toEqual({ ids: ['a', 'market-2'] }));
  it.each([{ ids: 'a' }, { ids: [' '] }, { ids: Array(501).fill('a') }, { ids: ['a'], extra: true }])('rejects invalid input', (body) => {
    expect(parseRefreshStartRequest(body)).toEqual(expect.objectContaining({ error: expect.any(String) }));
  });
});
