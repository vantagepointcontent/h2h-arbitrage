import { describe, expect, it } from 'vitest';
import { parseDecoupledPairCreateRequest, parseDecoupledPairId } from './decoupled-pairs-request';

describe('decoupled pair request parsing', () => {
  it('accepts and trims a valid create payload', () => {
    expect(parseDecoupledPairCreateRequest({ kalshiTicker: ' KXTEST ', pmConditionId: ' 0xabc ', kalshiTitle: ' K ', pmTitle: ' P ' }))
      .toEqual({ kalshiTicker: 'KXTEST', pmConditionId: '0xabc', kalshiTitle: 'K', pmTitle: 'P' });
  });

  it.each([{}, { kalshiTicker: 'KXTEST' }, { pmConditionId: '0xabc' }, { kalshiTicker: {}, pmConditionId: [] }])('rejects malformed create input', (body) => {
    expect(parseDecoupledPairCreateRequest(body)).toEqual(expect.objectContaining({ error: expect.any(String) }));
  });

  it.each([
    { kalshiTicker: 'K'.repeat(201), pmConditionId: '0xabc' },
    { kalshiTicker: 'KXTEST', pmConditionId: '0'.repeat(201) },
    { kalshiTicker: 'KXTEST', pmConditionId: '0xabc', kalshiTitle: 'K'.repeat(501) },
    { kalshiTicker: 'KXTEST', pmConditionId: '0xabc', pmTitle: 'P'.repeat(501) },
  ])('rejects oversized persisted fields', (body) => {
    expect(parseDecoupledPairCreateRequest(body)).toEqual(expect.objectContaining({ error: expect.any(String) }));
  });

  it('accepts only UUID ids', () => {
    expect(parseDecoupledPairId('d9428888-122b-11e1-b85c-61cd3cbb3210')).toBe('d9428888-122b-11e1-b85c-61cd3cbb3210');
    expect(parseDecoupledPairId('not-an-id')).toEqual(expect.objectContaining({ error: expect.any(String) }));
  });
});
