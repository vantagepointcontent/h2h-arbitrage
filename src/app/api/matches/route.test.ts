import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const { getMatchedPairs, matchCrossPlatformMarkets } = vi.hoisted(() => ({
  getMatchedPairs: vi.fn(),
  matchCrossPlatformMarkets: vi.fn(),
}));

vi.mock('@/lib/persistence', () => ({ getMatchedPairs }));
vi.mock('@/lib/cross-platform-matcher', () => ({ matchCrossPlatformMarkets }));

import { GET } from './route';

function request(query = '') {
  return new NextRequest(`http://localhost/api/matches${query}`);
}

describe('GET /api/matches', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getMatchedPairs.mockResolvedValue([]);
  });

  it('uses a bounded default', async () => {
    const response = await GET(request());
    expect(response.status).toBe(200);
    expect(getMatchedPairs).toHaveBeenCalledWith(undefined, 200);
  });

  it.each([
    ['0', 1],
    ['-1', 200],
    ['1.5', 200],
    ['1001', 1000],
  ])('bounds limit=%s to %s', async (value, expected) => {
    const response = await GET(request(`?limit=${value}`));
    expect(response.status).toBe(200);
    expect(getMatchedPairs).toHaveBeenCalledWith(undefined, expected);
  });

  it.each(['auto_queued', 'pending_review', 'approved', 'rejected'])('accepts status=%s', async status => {
    const response = await GET(request(`?status=${status}`));
    expect(response.status).toBe(200);
    expect(getMatchedPairs).toHaveBeenCalledWith(status, 200);
  });

  it('accepts a comma-separated status list', async () => {
    const response = await GET(request('?status=approved,rejected'));
    expect(response.status).toBe(200);
    expect(getMatchedPairs).toHaveBeenCalledWith(['approved', 'rejected'], 200);
  });

  it.each(['pending', 'approved,unknown', ','])('rejects invalid status=%s', async status => {
    const response = await GET(request(`?status=${encodeURIComponent(status)}`));
    expect(response.status).toBe(400);
    expect(getMatchedPairs).not.toHaveBeenCalled();
  });
});
