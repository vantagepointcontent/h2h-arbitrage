import { describe, expect, it } from 'vitest';
import { selectMatchedClobConditionIds } from './scan-clob-selection';

describe('selectMatchedClobConditionIds', () => {
  it('only selects Polymarket conditions that preliminary matching paired to Kalshi', () => {
    const outcomes = [
      { artist: 'Ben Shelton', kalshi: { ticker: 'K-SHE' }, polymarket: { conditionId: 'pm-she' } },
      { artist: 'Alexander Zverev', kalshi: { ticker: 'K-ZVE' }, polymarket: { conditionId: 'pm-zve' } },
      { artist: 'Unmatched PM player', kalshi: null, polymarket: { conditionId: 'pm-unmatched' } },
      { artist: 'Unmatched Kalshi player', kalshi: { ticker: 'K-ONLY' }, polymarket: null },
    ];

    expect(selectMatchedClobConditionIds(outcomes)).toEqual(['pm-she', 'pm-zve']);
  });

  it('deduplicates condition IDs and rejects empty values', () => {
    const outcomes = [
      { kalshi: {}, polymarket: { conditionId: 'pm-1' } },
      { kalshi: {}, polymarket: { conditionId: 'pm-1' } },
      { kalshi: {}, polymarket: { conditionId: '' } },
    ];

    expect(selectMatchedClobConditionIds(outcomes)).toEqual(['pm-1']);
  });
});
