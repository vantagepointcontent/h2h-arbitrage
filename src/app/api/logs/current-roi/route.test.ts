import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({ getCurrentLogRoiBatch: vi.fn() }));
vi.mock('@/lib/current-log-roi.server', () => mocks);

import { POST } from './route';
import { resetCurrentRoiRateLimitForTests } from '@/lib/current-roi-rate-limit';

function request(body: unknown) {
  return new NextRequest('http://localhost/api/logs/current-roi', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
}

describe('POST /api/logs/current-roi', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetCurrentRoiRateLimitForTests();
  });

  it('values a bounded scan-id batch', async () => {
    mocks.getCurrentLogRoiBatch.mockResolvedValue([{ id: 7, status: 'available', roiPct: 1.2 }]);
    const response = await POST(request({ ids: [7] }));
    expect(response.status).toBe(200);
    expect(mocks.getCurrentLogRoiBatch).toHaveBeenCalledWith([7]);
    await expect(response.json()).resolves.toEqual({ valuations: [{ id: 7, status: 'available', roiPct: 1.2 }] });
  });

  it.each([[], [0], [1.5], Array.from({ length: 26 }, (_, index) => index + 1)])('rejects an invalid batch', async (ids) => {
    expect((await POST(request({ ids }))).status).toBe(400);
    expect(mocks.getCurrentLogRoiBatch).not.toHaveBeenCalled();
  });

  it('rate-limits expensive endpoint traffic before downstream valuation', async () => {
    mocks.getCurrentLogRoiBatch.mockResolvedValue([]);
    const responses = await Promise.all(Array.from({ length: 11 }, (_, index) => POST(new NextRequest('http://localhost/api/logs/current-roi', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': `198.18.0.${index + 1}` },
      body: JSON.stringify({ ids: [index + 1] }),
    }))));

    expect(responses.map((response) => response.status)).toEqual([...Array(10).fill(200), 429]);
    expect(mocks.getCurrentLogRoiBatch).toHaveBeenCalledTimes(10);
    expect(Number(responses[10].headers.get('Retry-After'))).toBeGreaterThanOrEqual(1);
  });
});