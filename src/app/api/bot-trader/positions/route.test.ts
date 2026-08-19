import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GET } from './route';
import { getBotPositionMarkets } from '@/lib/bot-positions';
import { getExecutionCalculationEnvelopes, getMarketUrlsById } from '@/lib/persistence';
import { executableEnvelopeFixture } from '@/lib/test-fixtures/calculation-envelope';

vi.mock('@/lib/bot-positions', () => ({ getBotPositionMarkets: vi.fn() }));
vi.mock('@/lib/persistence', () => ({
  getMarketUrlsById: vi.fn(),
  getExecutionCalculationEnvelopes: vi.fn(),
}));

describe('GET /api/bot-trader/positions', () => {
  beforeEach(() => {
    vi.mocked(getBotPositionMarkets).mockReset().mockResolvedValue({
      marketCount: 0, markets: [], nextCursor: null, positions: [],
    });
    vi.mocked(getMarketUrlsById).mockReset().mockResolvedValue(null);
    vi.mocked(getExecutionCalculationEnvelopes).mockReset().mockResolvedValue(new Map());

  });

  it('accepts status and bounded integer limit', async () => {
    const response = await GET(new Request('http://localhost/api/bot-trader/positions?status=open&limit=25') as never);
    expect(response.status).toBe(200);
    expect(getBotPositionMarkets).toHaveBeenCalledWith({ status: 'open', limit: 25, cursor: null });
    await expect(response.json()).resolves.toEqual({
      success: true, count: 0, marketCount: 0, markets: [], nextCursor: null, positions: [],
    });
  });

  it('uses defaults when no query params provided', async () => {
    const response = await GET(new Request('http://localhost/api/bot-trader/positions') as never);
    expect(response.status).toBe(200);
    expect(getBotPositionMarkets).toHaveBeenCalledWith({ status: 'all', limit: 100, cursor: null });
    await expect(response.json()).resolves.toEqual({
      success: true, count: 0, marketCount: 0, markets: [], nextCursor: null, positions: [],
    });
  });

  it('accepts status=settled', async () => {
    const response = await GET(new Request('http://localhost/api/bot-trader/positions?status=settled') as never);
    expect(response.status).toBe(200);
    expect(getBotPositionMarkets).toHaveBeenCalledWith({ status: 'settled', limit: 100, cursor: null });
  });

  it('exports separated Polymarket economic and order-signing fee authority unchanged', async () => {
    const feeAuthority = {
      pmEntryFeesEnabled: true,
      pmEntryFeeSchedule: { rate: 0.04, exponent: 1, takerOnly: true, rebateRate: 0.25 },
      pmEntryOrderBaseFeeBps: 1000,
      pmEntryOrderFeeSource: 'https://clob.polymarket.com/fee-rate?token_id=pm-no-token',
      pmEntryOrderFeeVersion: 'token-order-base-fee:1000',
    };
    vi.mocked(getBotPositionMarkets).mockResolvedValue({
      marketCount: 1,
      nextCursor: null,
      positions: [],
      markets: [{
        marketId: null,
        marketKey: 'test',
        executions: [{ id: 1, status: 'open', ...feeAuthority }],
        entries: [],
      }],
    } as never);

    const response = await GET(new Request('http://localhost/api/bot-trader/positions') as never);
    const body = await response.json();
    expect(body.positions[0]).toMatchObject(feeAuthority);
    expect(body.markets[0].executions[0]).toMatchObject(feeAuthority);
  });

  it('treats refresh as a persisted-data reload and never starts live valuation', async () => {
    const response = await GET(new Request('http://localhost/api/bot-trader/positions?refresh=1') as never);
    expect(response.status).toBe(200);
    expect(getBotPositionMarkets).toHaveBeenCalledTimes(1);
  });

  it('joins each position to its persisted execution calculation envelope', async () => {
    vi.mocked(getBotPositionMarkets).mockResolvedValue({
      marketCount: 1,
      nextCursor: null,
      positions: [],
      markets: [{
        marketId: 'market-1',
        executions: [{ executionId: 7, status: 'open' }],
      }] as never,
    });
    vi.mocked(getExecutionCalculationEnvelopes).mockResolvedValue(new Map([[7, executableEnvelopeFixture]]));

    const response = await GET(new Request('http://localhost/api/bot-trader/positions') as never);
    const body = await response.json();

    expect(getExecutionCalculationEnvelopes).toHaveBeenCalledWith([7]);
    expect(body.positions[0].calculationEnvelope).toMatchObject({
      version: 1,
      status: 'executable',
      totals: { netPnlMicros: -8_560 },
    });
  });

  it('rejects invalid status and malformed limits', async () => {
    expect((await GET(new Request('http://localhost/api/bot-trader/positions?status=closed') as never)).status).toBe(400);
    expect((await GET(new Request('http://localhost/api/bot-trader/positions?limit=1.5') as never)).status).toBe(400);
    expect((await GET(new Request('http://localhost/api/bot-trader/positions?limit=0') as never)).status).toBe(400);
    expect((await GET(new Request('http://localhost/api/bot-trader/positions?limit=1001') as never)).status).toBe(400);
    expect((await GET(new Request('http://localhost/api/bot-trader/positions?limit=-1') as never)).status).toBe(400);
  });
});
