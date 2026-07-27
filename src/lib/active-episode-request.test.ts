import { describe, expect, it } from 'vitest';
import { parseActiveEpisodeRequest } from './active-episode-request';

describe('parseActiveEpisodeRequest', () => {
  it.each([
    [{ marketId: 'market-1' }, { marketId: 'market-1', outcome: null }],
    [{ marketId: ' market-1 ', outcome: ' Yes ' }, { marketId: 'market-1', outcome: 'Yes' }],
  ])('normalizes valid query values', (input, expected) => {
    expect(parseActiveEpisodeRequest(input)).toEqual(expected);
  });

  it.each([
    [{}, 'marketId is required'],
    [{ marketId: '   ' }, 'marketId is required'],
    [{ marketId: 'x'.repeat(201) }, 'marketId is invalid'],
    [{ marketId: 'market-1', outcome: '   ' }, 'outcome is invalid'],
    [{ marketId: 'market-1', outcome: 'x'.repeat(201) }, 'outcome is invalid'],
  ])('rejects invalid query values', (input, error) => {
    expect(parseActiveEpisodeRequest(input)).toEqual({ error });
  });
});
