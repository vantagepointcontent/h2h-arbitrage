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

import { POST } from './route';

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
  mocks.placeKalshiSellOrder.mockResolvedValue({ status: 'submitted', orderId: 'k-1', filledCount: 4 });
  mocks.placePmSellOrder.mockResolvedValue({ status: 'submitted', orderId: 'p-1' });
  mocks.persistExecution.mockResolvedValue(undefined);
  mocks.persistClosedPosition.mockResolvedValue(undefined);
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
