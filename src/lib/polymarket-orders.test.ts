import { describe, expect, it } from 'vitest';
import { mapPmOrderResponse, parsePmFilledContracts, parsePmFillEvidence } from './polymarket-orders';

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

describe('parsePmFillEvidence', () => {
  const order = {
    id: 'order-1',
    asset_id: 'token-yes',
    side: 'BUY',
    original_size: '10',
    size_matched: '10',
    associate_trades: ['trade-1'],
  };
  const trade = {
    id: 'trade-1',
    taker_order_id: 'order-1',
    asset_id: 'token-yes',
    side: 'BUY',
    size: '10',
    price: '0.47',
    fee_rate_bps: '0',
    match_time: '2026-08-12T20:00:00.000Z',
    maker_orders: [],
  };

  it('fails closed for a complete package-shaped CLOB fill because it has no charged-fee amount', () => {
    expect(parsePmFillEvidence(order, [trade], {
      orderId: 'order-1', tokenId: 'token-yes', side: 'BUY',
    })).toBeNull();
  });

  it('fails closed for a partial package-shaped CLOB fill rather than using submitted size or price', () => {
    expect(parsePmFillEvidence({ ...order, size_matched: '3' }, [{
      ...trade, size: '3', price: '0.43',
    }], {
      orderId: 'order-1', tokenId: 'token-yes', side: 'BUY',
    })).toBeNull();
  });

  it.each([
    ['missing trade ID', [{ ...trade, id: undefined }]],
    ['missing fill quantity', [{ ...trade, size: undefined }]],
    ['missing fill price', [{ ...trade, price: undefined }]],
    ['missing venue timestamp', [{ ...trade, match_time: undefined }]],
    ['unrelated execution ID', [{ ...trade, id: 'trade-2' }]],
    ['unrelated order ID', [{ ...trade, taker_order_id: 'order-2' }]],
    ['wrong token', [{ ...trade, asset_id: 'token-no' }]],
    ['wrong side', [{ ...trade, side: 'SELL' }]],
    ['contradictory cumulative quantity', [{ ...trade, size: '9' }]],
  ])('rejects %s', (_label, trades) => {
    expect(parsePmFillEvidence(order, trades, {
      orderId: 'order-1', tokenId: 'token-yes', side: 'BUY',
    })).toBeNull();
  });

  it('rejects inferred fee fields that are absent from the installed Trade contract', () => {
    expect(parsePmFillEvidence(order, [{
      ...trade,
      fee_amount: '0.01',
      fee_paid: '0.01',
      fee_cost: '0.01',
    }], {
      orderId: 'order-1', tokenId: 'token-yes', side: 'BUY',
    })).toBeNull();
  });
});

describe('mapPmOrderResponse', () => {
  it('preserves a terminal zero-fill cancellation for verification', () => {
    expect(mapPmOrderResponse({
      orderId: 'order-cancelled', status: 'canceled', raw: { size_matched: '0' },
    }, null)).toMatchObject({ status: 'cancelled', filledContracts: 0 });
  });

  const evidence = {
    venue: 'polymarket' as const,
    filledQuantity: 3,
    fillPrice: 0.43,
    chargedFeeCents: 2,
    executionId: 'trade-authoritative',
    venueTimestamp: '2026-08-12T20:00:00.000Z',
  };

  it('maps an authoritative partial fill without copying submitted values', () => {
    expect(mapPmOrderResponse({ orderId: 'order-1', status: 'live', raw: {} }, evidence)).toMatchObject({
      status: 'partial', filledContracts: 3, filledPrice: 0.43,
      chargedFeeCents: 2, timestamp: '2026-08-12T20:00:00.000Z', venueEvidence: evidence,
    });
  });

  it('preserves a cancelled Polymarket order with an authoritative partial fill as terminal', () => {
    expect(mapPmOrderResponse({ orderId: 'order-1', status: 'canceled', raw: {} }, evidence)).toMatchObject({
      status: 'cancelled', filledContracts: 3, filledPrice: 0.43,
      chargedFeeCents: 2, timestamp: '2026-08-12T20:00:00.000Z', venueEvidence: evidence,
    });
  });

  it('maps an authoritative complete fill only from the venue evidence', () => {
    expect(mapPmOrderResponse({ orderId: 'order-1', status: 'matched', raw: {} }, evidence)).toMatchObject({
      status: 'filled', filledContracts: 3, filledPrice: 0.43,
      timestamp: '2026-08-12T20:00:00.000Z',
    });
  });

  it('does not promote order-level matched size or local time without evidence', () => {
    expect(mapPmOrderResponse({
      orderId: 'order-1', status: 'matched', raw: { size_matched: '3' },
    }, null)).toEqual({
      platform: 'polymarket', status: 'pending', orderId: 'order-1', timestamp: '',
    });
  });
});
