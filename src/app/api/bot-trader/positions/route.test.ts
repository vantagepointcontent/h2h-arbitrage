import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GET } from './route';
import { getBotPositions } from '@/lib/bot-positions';

vi.mock('@/lib/bot-positions', () => ({ getBotPositions: vi.fn() }));

describe('GET /api/bot-trader/positions', () => {
  beforeEach(() => vi.mocked(getBotPositions).mockReset().mockResolvedValue([]));

  it('accepts status and bounded integer limit', async () => {
    const response = await GET(new Request('http://localhost/api/bot-trader/positions?status=open&limit=25&offset=50') as never);
    expect(response.status).toBe(200);
    expect(getBotPositions).toHaveBeenCalledWith({ status: 'open', limit: 25, offset: 50 });
    await expect(response.json()).resolves.toEqual({ success: true, count: 0, positions: [] });
  });

  it('uses defaults when no query params provided', async () => {
    const response = await GET(new Request('http://localhost/api/bot-trader/positions') as never);
    expect(response.status).toBe(200);
    expect(getBotPositions).toHaveBeenCalledWith({ status: 'all', limit: 100, offset: 0 });
    await expect(response.json()).resolves.toEqual({ success: true, count: 0, positions: [] });
  });

  it('accepts status=settled', async () => {
    const response = await GET(new Request('http://localhost/api/bot-trader/positions?status=settled') as never);
    expect(response.status).toBe(200);
    expect(getBotPositions).toHaveBeenCalledWith({ status: 'settled', limit: 100, offset: 0 });
  });

  it('rejects invalid status and malformed limits', async () => {
    expect((await GET(new Request('http://localhost/api/bot-trader/positions?status=closed') as never)).status).toBe(400);
    expect((await GET(new Request('http://localhost/api/bot-trader/positions?limit=1.5') as never)).status).toBe(400);
    expect((await GET(new Request('http://localhost/api/bot-trader/positions?limit=0') as never)).status).toBe(400);
    expect((await GET(new Request('http://localhost/api/bot-trader/positions?limit=1001') as never)).status).toBe(400);
    expect((await GET(new Request('http://localhost/api/bot-trader/positions?limit=-1') as never)).status).toBe(400);
    expect((await GET(new Request('http://localhost/api/bot-trader/positions?offset=-1') as never)).status).toBe(400);
  });
});
