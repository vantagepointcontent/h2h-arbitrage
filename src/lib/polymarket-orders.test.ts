import { describe, expect, it } from 'vitest';
import { parsePmFilledContracts } from './polymarket-orders';

describe('parsePmFilledContracts', () => {
  it('parses authoritative size_matched contract units from a polled order', () => {
    expect(parsePmFilledContracts({ size_matched: '31.000000' })).toBe(31);
  });

  it('does not infer a full fill when the venue omits matched size', () => {
    expect(parsePmFilledContracts({ status: 'matched', original_size: '31' })).toBeNull();
  });

  it('rejects malformed or negative matched sizes', () => {
    expect(parsePmFilledContracts({ size_matched: '-1' })).toBeNull();
    expect(parsePmFilledContracts({ size_matched: 'not-a-number' })).toBeNull();
  });
});
