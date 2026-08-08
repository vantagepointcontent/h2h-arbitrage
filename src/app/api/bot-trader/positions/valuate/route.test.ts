import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { POST } from './route';
import { pollOpenBotPositions } from '@/lib/bot-positions';

vi.mock('@/lib/bot-positions', () => ({ pollOpenBotPositions: vi.fn() }));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.mocked(pollOpenBotPositions).mockReset();
});

describe('POST /api/bot-trader/positions/valuate', () => {
  it('requires the shared token and runs the valuation poller', async () => {
    vi.stubEnv('H2H_API_TOKEN', 'secret');
    const unauthorized = await POST(new NextRequest('http://localhost/api/bot-trader/positions/valuate', { method: 'POST' }));
    expect(unauthorized.status).toBe(401);

    vi.mocked(pollOpenBotPositions).mockResolvedValue({ updated: 2, settled: 1, errors: [] });
    const authorized = await POST(new NextRequest('http://localhost/api/bot-trader/positions/valuate', {
      method: 'POST',
      headers: { 'x-h2h-token': 'secret' },
    }));
    expect(authorized.status).toBe(200);
    await expect(authorized.json()).resolves.toEqual({ success: true, updated: 2, settled: 1, errors: [] });
  });
});
