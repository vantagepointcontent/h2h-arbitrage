import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { getBotActionLogs, pruneBotActionLogs } from '@/lib/bot-action-log';
import { GET } from './route';

vi.mock('@/lib/bot-action-log', () => ({
  getBotActionLogs: vi.fn(),
  pruneBotActionLogs: vi.fn(),
}));

describe('GET /api/bot-trader/logs qualified filter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(pruneBotActionLogs).mockResolvedValue(0);
    vi.mocked(getBotActionLogs).mockResolvedValue({ rows: [], nextCursor: null });
  });

  it('passes qualified=true to persistence', async () => {
    const response = await GET(new NextRequest('http://localhost/api/bot-trader/logs?qualified=true'));
    expect(response.status).toBe(200);
    expect(getBotActionLogs).toHaveBeenCalledWith(expect.objectContaining({ qualified: true }));
  });

  it('rejects invalid qualified values', async () => {
    const response = await GET(new NextRequest('http://localhost/api/bot-trader/logs?qualified=yes'));
    expect(response.status).toBe(400);
    expect(getBotActionLogs).not.toHaveBeenCalled();
  });
});