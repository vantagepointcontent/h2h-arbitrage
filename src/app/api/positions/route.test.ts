import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getExecutionMode: vi.fn(),
  getKalshiPositions: vi.fn(),
  getPolymarketPositions: vi.fn(),
  placeKalshiSellOrder: vi.fn(),
  placePmSellOrder: vi.fn(),
  persistExecution: vi.fn(),
  persistClosedPosition: vi.fn(),
  resolveKalshiFeeAuthority: vi.fn(),
  fetchAuthoritativeBotFeeConfig: vi.fn(),
}));

vi.mock('@/lib/settings', () => ({ getExecutionMode: mocks.getExecutionMode }));
vi.mock('@/lib/kalshi-positions', () => ({
  getKalshiPositions: mocks.getKalshiPositions,
  getKalshiCashBalance: vi.fn(),
}));
vi.mock('@/lib/polymarket-positions', () => ({ getPolymarketPositions: mocks.getPolymarketPositions }));
vi.mock('@/lib/kalshi-orders', () => ({ placeKalshiSellOrder: mocks.placeKalshiSellOrder }));
vi.mock('@/lib/polymarket-orders', () => ({ placePmSellOrder: mocks.placePmSellOrder }));
vi.mock('@/lib/persistence', () => ({
  persistExecution: mocks.persistExecution,
  persistClosedPosition: mocks.persistClosedPosition,
}));
vi.mock('@/lib/kalshi-fee-quote', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/kalshi-fee-quote')>()),
  resolveKalshiFeeAuthority: mocks.resolveKalshiFeeAuthority,
}));
vi.mock('@/lib/bot-positions', () => ({
  fetchAuthoritativeBotFeeConfig: mocks.fetchAuthoritativeBotFeeConfig,
}));

import { GET, POST } from './route';

function request(body: unknown): Request {
  return new Request('http://localhost/api/positions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const kalshiPosition = {
  ticker: 'KXTEST-YES',
  position: 4,
  totalCost: 2,
  realizedPnl: 0,
  currentYesBid: 0.61,
  currentYesAsk: 0.63,
  currentNoBid: 0.37,
  currentNoAsk: 0.39,
  lastPrice: 0.62,
  title: 'Will the test happen?',
  eventTicker: 'KXTEST',
  unrealizedPnl: 0.44,
  currentValue: 2.44,
  roiPct: 22,
  reportedFeesPaidCents: 3,
};

const pmPosition = {
  asset: 'pm-token-no',
  conditionId: 'pm-condition',
  size: 4,
  avgPrice: 0.34,
  initialValue: 1.36,
  currentValue: 1.4,
  cashPnl: 0.04,
  percentPnl: 2.94,
  curPrice: 0.35,
  title: 'Will the test happen?',
  slug: 'will-the-test-happen',
  eventSlug: 'test-event',
  outcome: 'No',
  outcomeIndex: 1,
  oppositeOutcome: 'Yes',
  endDate: '2026-12-31T00:00:00Z',
  negativeRisk: false,
  proxyWallet: '0xwallet',
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getExecutionMode.mockResolvedValue('live');
  mocks.getKalshiPositions.mockResolvedValue([kalshiPosition]);
  mocks.getPolymarketPositions.mockResolvedValue([pmPosition]);
  mocks.resolveKalshiFeeAuthority.mockResolvedValue({
    marketTicker: 'KXTEST-YES', eventTicker: 'KXTEST', seriesTicker: 'KX',
    feeType: 'quadratic', feeMultiplierPpm: 1_000_000,
    source: 'kalshi-series:KX', observedAt: '2026-08-14T11:00:00.000Z', version: 'v1',
  });
  mocks.placeKalshiSellOrder.mockResolvedValue({
    status: 'executed', orderId: 'k-1', filledCount: 4,
    evidence: {
      venue: 'kalshi', filledQuantity: 4, fillPrice: 0.61000175, chargedFeeCents: 2,
      executionId: 'k-fill-1', venueTimestamp: '2026-08-14T13:00:00.000Z',
      fills: [
        { executionId: 'k-fill-1a', quantity: 1, price: 0.610001, chargedFeeCents: 1, venueTimestamp: '2026-08-14T13:00:00.000Z' },
        { executionId: 'k-fill-1b', quantity: 3, price: 0.610002, chargedFeeCents: 1, venueTimestamp: '2026-08-14T13:00:00.000Z' },
      ],
    },
  });
  mocks.placePmSellOrder.mockResolvedValue({
    status: 'pending', orderId: 'p-1', filledContracts: null, raw: {},
  });
  mocks.persistExecution.mockResolvedValue(undefined);
  mocks.persistClosedPosition.mockResolvedValue(undefined);
  mocks.fetchAuthoritativeBotFeeConfig.mockResolvedValue({
    kalshi: {
      feeMultiplierPpm: 1_000_000,
      source: 'kalshi-series:KXTEST',
      observedAt: '2026-08-14T12:59:58.000Z',
      version: 'quadratic:1000000',
    },
    polymarket: {
      feeRateBps: 400,
      source: 'polymarket-clob:/fee-rate',
      observedAt: '2026-08-14T12:59:59.000Z',
      version: 'token-fee-rate:400',
    },
  });
});

describe('POST /api/positions exit', () => {
  it('rejects a forged pair id before placing orders', async () => {
    const response = await POST(request({
      action: 'exit',
      pairId: 'pair-forged',
      kalshi: { ticker: 'ATTACKER-TICKER', side: 'NO', size: 999, priceCents: 1 },
      polymarket: { asset: 'attacker-token', size: 999, price: 0.01 },
    }) as never);

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'Open position pair not found' });
    expect(mocks.placeKalshiSellOrder).not.toHaveBeenCalled();
    expect(mocks.placePmSellOrder).not.toHaveBeenCalled();
  });

  it('derives executable identifiers, sides, sizes, and prices from server positions', async () => {
    const pairId = 'pair-KXTEST-YES-pm-token';
    const response = await POST(request({
      action: 'exit',
      pairId,
      kalshi: { ticker: 'ATTACKER-TICKER', side: 'NO', size: 999, priceCents: 1 },
      polymarket: { asset: 'attacker-token', size: 999, price: 0.01 },
    }) as never);

    expect(response.status).toBe(200);
    expect(mocks.placeKalshiSellOrder).toHaveBeenCalledWith(expect.objectContaining({
      ticker: 'KXTEST-YES',
      side: 'yes',
      count: 4,
      priceCents: 61,
    }));
    expect(mocks.placePmSellOrder).toHaveBeenCalledWith({
      tokenId: 'pm-token-no',
      size: 4,
      price: 0.35,
    });
  });

  it('keeps pair accounting unavailable when the production PM adapter cannot supply charged-fee evidence', async () => {
    const response = await POST(request({ action: 'exit', pairId: 'pair-KXTEST-YES-pm-token' }) as never);
    const body = await response.json();

    expect(body.calculationEnvelope).toMatchObject({
      version: 1,
      scope: 'position',
      status: 'unavailable',
      requestedQuantityMicros: 4_000_000,
      executableQuantityMicros: null,
      legs: [
        { venue: 'kalshi', action: 'sell', fee: { basis: 'charged', amountMicros: 20_000 } },
        { venue: 'polymarket', action: 'sell', executableQuantityMicros: null, fee: { basis: 'unavailable', amountMicros: null } },
      ],
      totals: {
        grossCostMicros: null,
        grossPayoutMicros: null,
        grossProfitMicros: null,
        totalFeesMicros: null,
        netPnlMicros: null,
      },
    });
    expect(mocks.persistClosedPosition).toHaveBeenCalledTimes(2);
    expect(mocks.persistClosedPosition).toHaveBeenCalledWith(expect.objectContaining({
      size: 4, exitPrice: null, realizedPnl: null, roiPct: null,
      calculationEnvelope: expect.objectContaining({ status: 'unavailable' }),
    }));
    expect(mocks.persistExecution).toHaveBeenCalledWith(expect.objectContaining({
      calculationEnvelope: expect.objectContaining({ status: 'unavailable' }),
      estimatedProfit: 0,
      result: expect.objectContaining({ actualProfit: null }),
    }));
  });

  it('fails the exact one-leg rejection probe closed without pair actuals', async () => {
    mocks.placePmSellOrder.mockRejectedValue(new Error('venue rejected order'));

    const response = await POST(request({ action: 'exit', pairId: 'pair-KXTEST-YES-pm-token' }) as never);
    const body = await response.json();

    expect(body.calculationEnvelope).toMatchObject({
      scope: 'position',
      status: 'unavailable',
      blocker: { code: 'missing_charged_exit_authority' },
      executableQuantityMicros: null,
      totals: {
        grossCostMicros: null, grossPayoutMicros: null, grossProfitMicros: null,
        totalFeesMicros: null, netPnlMicros: null,
      },
    });
    expect(body.errors).toEqual({ polymarket: 'venue rejected order' });
    expect(body.calculationEnvelope.legs).toHaveLength(2);
    expect(body.calculationEnvelope.legs[0]).toMatchObject({
      venue: 'kalshi', executableQuantityMicros: 4_000_000,
    });
    expect(body.calculationEnvelope.legs[1]).toMatchObject({
      venue: 'polymarket', requestedQuantityMicros: 4_000_000, executableQuantityMicros: null,
      fillLevels: [], fee: { basis: 'unavailable', amountMicros: null, schedule: null },
    });
    expect(mocks.persistClosedPosition).toHaveBeenCalledTimes(1);
    expect(mocks.persistClosedPosition).toHaveBeenCalledWith(expect.objectContaining({
      platform: 'kalshi', size: 4, exitPrice: null, realizedPnl: null, roiPct: null, feesPaid: null,
      calculationEnvelope: expect.objectContaining({ status: 'unavailable' }),
    }));
    expect(mocks.persistExecution).toHaveBeenCalledWith(expect.objectContaining({
      calculationEnvelope: expect.objectContaining({ status: 'unavailable' }),
      estimatedProfit: 0,
      result: expect.objectContaining({ actualProfit: null }),
    }));
  });

  it('records the authoritative partial quantity but leaves full-position accounting unavailable', async () => {
    mocks.placeKalshiSellOrder.mockResolvedValue({
      status: 'partial', orderId: 'k-partial', filledCount: 2,
      evidence: {
        venue: 'kalshi', filledQuantity: 2, fillPrice: 0.61, chargedFeeCents: 1,
        executionId: 'k-partial', venueTimestamp: '2026-08-14T12:01:00.000Z', source: 'kalshi-api/order-fills',
        fills: [{
          executionId: 'k-partial-fill', quantity: 2, price: 0.61, chargedFeeCents: 1,
          venueTimestamp: '2026-08-14T12:01:00.000Z', source: 'kalshi-api/order-fills',
        }],
      },
    });

    const response = await POST(request({ action: 'exit', pairId: 'pair-KXTEST-YES-pm-token' }) as never);
    const body = await response.json();

    expect(body.calculationEnvelope.status).toBe('unavailable');
    expect(mocks.persistClosedPosition).toHaveBeenCalledWith(expect.objectContaining({
      platform: 'kalshi', size: 2, exitPrice: null, realizedPnl: null, roiPct: null,
    }));
    expect(mocks.persistClosedPosition).toHaveBeenCalledWith(expect.objectContaining({
      platform: 'polymarket', size: null, exitPrice: null, realizedPnl: null, roiPct: null,
    }));
  });

  it('keeps unequal requested quantities unavailable without pair totals', async () => {
    mocks.getPolymarketPositions.mockResolvedValue([{ ...pmPosition, size: 3 }]);

    const response = await POST(request({ action: 'exit', pairId: 'pair-KXTEST-YES-pm-token' }) as never);
    const body = await response.json();

    expect(body.calculationEnvelope).toMatchObject({
      status: 'unavailable',
      requestedQuantityMicros: null,
      executableQuantityMicros: null,
      totals: { grossCostMicros: null, grossPayoutMicros: null, netPnlMicros: null },
    });
    expect(body.calculationEnvelope.legs.map((leg: { requestedQuantityMicros: number }) => leg.requestedQuantityMicros))
      .toEqual([4_000_000, 3_000_000]);
    expect(mocks.persistExecution).toHaveBeenCalledWith(expect.objectContaining({
      estimatedProfit: 0,
      result: expect.objectContaining({ actualProfit: null }),
    }));
  });

  it('fails closed when current positions cannot be verified', async () => {
    mocks.getKalshiPositions.mockRejectedValue(new Error('Kalshi unavailable'));

    const response = await POST(request({
      action: 'exit',
      pairId: 'pair-KXTEST-YES-pm-token',
    }) as never);

    expect(response.status).toBe(500);
    expect(mocks.placeKalshiSellOrder).not.toHaveBeenCalled();
    expect(mocks.placePmSellOrder).not.toHaveBeenCalled();
  });

  it('rejects a pair with no executable server quote', async () => {
    mocks.getKalshiPositions.mockResolvedValue([{ ...kalshiPosition, currentYesBid: 0 }]);

    const response = await POST(request({
      action: 'exit',
      pairId: 'pair-KXTEST-YES-pm-token',
    }) as never);

    expect(response.status).toBe(409);
    expect(mocks.placeKalshiSellOrder).not.toHaveBeenCalled();
    expect(mocks.placePmSellOrder).not.toHaveBeenCalled();
  });
});

describe('GET /api/positions accounting provenance', () => {
  it('marks current account-feed fees as unavailable instead of recomputing or publishing zero', async () => {
    const response = await GET();
    const body = await response.json();

    expect(body.positions[0].calculationEnvelope).toMatchObject({
      version: 1,
      scope: 'position',
      status: 'unavailable',
      blocker: { code: 'account_feed_missing_fee_authority' },
      totals: { totalFeesMicros: null, netPnlMicros: null },
      legs: [
        { venue: 'kalshi', action: 'sell', fee: { basis: 'unavailable', amountMicros: null, schedule: null } },
        { venue: 'polymarket', action: 'sell', fee: { basis: 'unavailable', amountMicros: null, schedule: null } },
      ],
    });
  });
});
