import { describe, expect, it } from 'vitest';
import { parseMarketDepthRequest } from './market-depth-request';

describe('parseMarketDepthRequest', () => {
  const validConditionId = `0x${'a'.repeat(64)}`;

  it('normalizes valid Kalshi and Polymarket identifiers', () => {
    expect(parseMarketDepthRequest(' KXWCGAME-26JUN26NORFRA-NOR ', ` ${validConditionId} `)).toEqual({
      kalshiTicker: 'KXWCGAME-26JUN26NORFRA-NOR',
      pmConditionId: validConditionId,
    });
  });

  it.each([
    [null, validConditionId, 'kalshiTicker and pmConditionId are required'],
    ['', validConditionId, 'kalshiTicker and pmConditionId are required'],
    ['KXTEST/../../bad', validConditionId, 'Invalid kalshiTicker'],
    ['KXTEST', 'not-a-condition-id', 'Invalid conditionId'],
    ['KXTEST', `0x${'z'.repeat(64)}`, 'Invalid conditionId'],
  ])('rejects invalid identifiers', (kalshiTicker, pmConditionId, error) => {
    expect(parseMarketDepthRequest(kalshiTicker, pmConditionId)).toEqual({ error });
  });
});
