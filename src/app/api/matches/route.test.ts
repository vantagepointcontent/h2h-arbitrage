import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const { getMatchedPairs, matchCrossPlatformMarkets } = vi.hoisted(() => ({
  getMatchedPairs: vi.fn(),
  matchCrossPlatformMarkets: vi.fn(),
}));

vi.mock('@/lib/persistence', () => ({ getMatchedPairs }));
vi.mock('@/lib/cross-platform-matcher', () => ({
  matchCrossPlatformMarkets,
  DEFAULT_MATCHER_OPTIONS: {
    candidateThreshold: 50,
    maxVerifications: 500,
    maxExpiryDays: 7,
    autoQueueThreshold: 70,
    reviewThreshold: 50,
  },
}));

import { GET, POST } from './route';

function request(query = '') {
  return new NextRequest(`http://localhost/api/matches${query}`);
}

function postRequest(body: unknown) {
  return new NextRequest('http://localhost/api/matches', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
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

describe('POST /api/matches', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    matchCrossPlatformMarkets.mockResolvedValue({ verifiedPairs: 0 });
  });

  it('preserves matcher defaults when optional thresholds are omitted', async () => {
    const response = await POST(postRequest({ action: 'run' }));
    expect(response.status).toBe(200);
    expect(matchCrossPlatformMarkets).toHaveBeenCalledWith({});
  });

  it('forwards validated thresholds', async () => {
    const options = { candidateThreshold: 45, maxVerifications: 250, maxExpiryDays: 30, autoQueueThreshold: 80, reviewThreshold: 55 };
    const response = await POST(postRequest({ action: 'run', ...options }));
    expect(response.status).toBe(200);
    expect(matchCrossPlatformMarkets).toHaveBeenCalledWith(options);
  });

  it.each([null, [], 'run', 1])('rejects non-object JSON body %j', async body => {
    const response = await POST(postRequest(body));
    expect(response.status).toBe(400);
    expect(matchCrossPlatformMarkets).not.toHaveBeenCalled();
  });

  it.each([
    ['candidateThreshold', -1], ['candidateThreshold', 101], ['candidateThreshold', '50'],
    ['maxVerifications', 0], ['maxVerifications', 1.5], ['maxVerifications', 5001],
    ['maxExpiryDays', 0], ['maxExpiryDays', 3651],
    ['autoQueueThreshold', Number.NaN], ['reviewThreshold', 101],
  ])('rejects invalid %s=%j', async (name, value) => {
    const response = await POST(postRequest({ action: 'run', [name]: value }));
    expect(response.status).toBe(400);
    expect(matchCrossPlatformMarkets).not.toHaveBeenCalled();
  });

  it('rejects an auto-queue threshold below the review threshold', async () => {
    const response = await POST(postRequest({ action: 'run', autoQueueThreshold: 50, reviewThreshold: 70 }));
    expect(response.status).toBe(400);
    expect(matchCrossPlatformMarkets).not.toHaveBeenCalled();
  });
});
