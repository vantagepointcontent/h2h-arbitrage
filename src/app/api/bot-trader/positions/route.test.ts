import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GET } from './route';
import { getBotPositionMarkets } from '@/lib/bot-positions';

vi.mock('@/lib/bot-positions', () => ({ getBotPositionMarkets: vi.fn() }));

describe('GET /api/bot-trader/positions', () => {
  beforeEach(() => vi.mocked(getBotPositionMarkets).mockReset().mockResolvedValue({
    marketCount: 0, markets: [], nextCursor: null, positions: [],
  }));

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

  it('rejects invalid status and malformed limits', async () => {
    expect((await GET(new Request('http://localhost/api/bot-trader/positions?status=closed') as never)).status).toBe(400);
    expect((await GET(new Request('http://localhost/api/bot-trader/positions?limit=1.5') as never)).status).toBe(400);
    expect((await GET(new Request('http://localhost/api/bot-trader/positions?limit=0') as never)).status).toBe(400);
    expect((await GET(new Request('http://localhost/api/bot-trader/positions?limit=1001') as never)).status).toBe(400);
    expect((await GET(new Request('http://localhost/api/bot-trader/positions?limit=-1') as never)).status).toBe(400);
  });
});
