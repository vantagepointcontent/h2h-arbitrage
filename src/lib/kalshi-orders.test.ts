import { describe, expect, it } from 'vitest';
import { parseKalshiCount, parseKalshiFillEvidence } from './kalshi-orders';

describe('parseKalshiCount', () => {
  it('preserves missing cumulative fills as unknown', () => {
    expect(parseKalshiCount(undefined)).toBeUndefined();
    expect(parseKalshiCount(null)).toBeUndefined();
    expect(parseKalshiCount('')).toBeUndefined();
  });

  it('distinguishes explicit zero from unknown', () => {
    expect(parseKalshiCount(0)).toBe(0);
    expect(parseKalshiCount('0')).toBe(0);
  });

  it('accepts positive venue-reported fills', () => {
    expect(parseKalshiCount(12)).toBe(12);
    expect(parseKalshiCount('7')).toBe(7);
  });

  it('fails closed for malformed or negative counts', () => {
    expect(parseKalshiCount('bad')).toBeUndefined();
    expect(parseKalshiCount(-1)).toBeUndefined();
  });
});

describe('parseKalshiFillEvidence', () => {
  const submittedOrder = {
    orderId: 'order-123',
    ticker: 'KXTEST-26',
    outcomeSide: 'yes' as const,
  };

  const completeFill = {
    fill_id: 'fill-456',
    trade_id: 'fill-456',
    order_id: 'order-123',
    ticker: 'KXTEST-26',
    market_ticker: 'KXTEST-26',
    outcome_side: 'yes',
    count_fp: '10.00',
    yes_price_dollars: '0.4301',
    no_price_dollars: '0.57',
    fee_cost: '0.07',
    is_taker: true,
    created_time: '2026-08-12T13:30:45.123Z',
  };

  it('maps exact venue values for an authoritative complete fill', () => {
    expect(parseKalshiFillEvidence({ fills: [completeFill], cursor: '' }, submittedOrder)).toEqual({
      venue: 'kalshi',
      filledQuantity: 10,
      fillPrice: 0.4301,
      chargedFeeCents: 7,
      liquidityRole: 'taker',
      executionId: 'fill-456',
      venueTimestamp: '2026-08-12T13:30:45.123Z',
      orderId: 'order-123',
      raw: completeFill,
    });
  });

  it('maps an authoritative partial fill without substituting requested values', () => {
    const partial = {
      ...completeFill,
      fill_id: 'fill-partial',
      trade_id: 'fill-partial',
      count_fp: '3.00',
      yes_price_dollars: '0.41',
      fee_cost: '0.02',
      created_time: '2026-08-12T13:31:00Z',
    };

    expect(parseKalshiFillEvidence({ fills: [partial], cursor: '' }, submittedOrder)).toMatchObject({
      filledQuantity: 3,
      fillPrice: 0.41,
      chargedFeeCents: 2,
      executionId: 'fill-partial',
      venueTimestamp: '2026-08-12T13:31:00Z',
    });
  });

  it.each([
    ['missing fills', { cursor: '' }],
    ['malformed fills', { fills: {}, cursor: '' }],
    ['missing fill ID', { fills: [{ ...completeFill, fill_id: undefined, trade_id: undefined }], cursor: '' }],
    ['missing quantity', { fills: [{ ...completeFill, count_fp: undefined }], cursor: '' }],
    ['malformed price', { fills: [{ ...completeFill, yes_price_dollars: 'not-a-price' }], cursor: '' }],
    ['out-of-range price', { fills: [{ ...completeFill, yes_price_dollars: '1.001' }], cursor: '' }],
    ['missing charged fee', { fills: [{ ...completeFill, fee_cost: undefined }], cursor: '' }],
    ['sub-cent charged fee', { fills: [{ ...completeFill, fee_cost: '0.001' }], cursor: '' }],
    ['local/zoneless timestamp', { fills: [{ ...completeFill, created_time: '2026-08-12T13:30:45' }], cursor: '' }],
  ])('fails closed for %s', (_label, response) => {
    expect(parseKalshiFillEvidence(response, submittedOrder)).toBeNull();
  });

  it('rejects evidence unrelated to the submitted order', () => {
    expect(parseKalshiFillEvidence({
      fills: [{ ...completeFill, order_id: 'other-order' }],
      cursor: '',
    }, submittedOrder)).toBeNull();
  });

  it.each([
    ['ticker', { ticker: 'OTHER', market_ticker: 'OTHER' }],
    ['outcome side', { outcome_side: 'no' }],
    ['execution identity', { fill_id: 'one-id', trade_id: 'another-id' }],
  ])('rejects contradictory %s evidence', (_label, changes) => {
    expect(parseKalshiFillEvidence({
      fills: [{ ...completeFill, ...changes }],
      cursor: '',
    }, submittedOrder)).toBeNull();
  });

  it('aggregates multiple authoritative fills while preserving each execution', () => {
    const secondFill = {
      ...completeFill,
      fill_id: 'fill-789',
      trade_id: 'fill-789',
      count_fp: '2.00',
      yes_price_dollars: '0.44',
      no_price_dollars: '0.56',
      fee_cost: '0.02',
      created_time: '2026-08-12T13:31:45.123Z',
    };
    expect(parseKalshiFillEvidence({ fills: [completeFill, secondFill], cursor: '' }, submittedOrder)).toEqual({
      venue: 'kalshi',
      filledQuantity: 12,
      fillPrice: (10 * 0.4301 + 2 * 0.44) / 12,
      chargedFeeCents: 9,
      executionId: 'order-123',
      venueTimestamp: '2026-08-12T13:31:45.123Z',
      orderId: 'order-123',
      liquidityRole: 'taker',
      fills: [
        { executionId: 'fill-456', quantity: 10, price: 0.4301, chargedFeeCents: 7, venueTimestamp: '2026-08-12T13:30:45.123Z', liquidityRole: 'taker' },
        { executionId: 'fill-789', quantity: 2, price: 0.44, chargedFeeCents: 2, venueTimestamp: '2026-08-12T13:31:45.123Z', liquidityRole: 'taker' },
      ],
      raw: [completeFill, secondFill],
    });
  });
});
