import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({ getCurrentLogRoiBatch: vi.fn() }));
vi.mock('@/lib/current-log-roi.server', () => mocks);

import { POST } from './route';

function request(body: unknown) {
  return new NextRequest('http://localhost/api/logs/current-roi', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
}

describe('POST /api/logs/current-roi', () => {
  beforeEach(() => vi.clearAllMocks());

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
});