import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GET } from './route';
import { getBotPositions } from '@/lib/bot-positions';

vi.mock('@/lib/bot-positions', () => ({ getBotPositions: vi.fn() }));

describe('GET /api/bot-trader/positions', () => {
  beforeEach(() => vi.mocked(getBotPositions).mockReset().mockResolvedValue([]));

  it('accepts status and bounded integer limit', async () => {
    const response = await GET(new Request('http://localhost/api/bot-trader/positions?status=open&limit=25') as never);
    expect(response.status).toBe(200);
    expect(getBotPositions).toHaveBeenCalledWith({ status: 'open', limit: 25 });
    await expect(response.json()).resolves.toEqual({ success: true, count: 0, positions: [] });
  });

  it('rejects invalid status and malformed limits', async () => {
    expect((await GET(new Request('http://localhost/api/bot-trader/positions?status=closed') as never)).status).toBe(400);
    expect((await GET(new Request('http://localhost/api/bot-trader/positions?limit=1.5') as never)).status).toBe(400);
  });
});
