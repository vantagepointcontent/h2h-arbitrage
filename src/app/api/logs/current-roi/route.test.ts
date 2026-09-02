import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({ getCurrentLogRoiBatch: vi.fn() }));
vi.mock('@/lib/current-log-roi.server', () => mocks);

import { GET, POST } from './route';


function request(body: unknown) {
  return new NextRequest('http://localhost/api/logs/current-roi', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
}

describe('POST /api/logs/current-roi', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('values a bounded scan-id batch', async () => {
    mocks.getCurrentLogRoiBatch.mockResolvedValue([{ id: 7, status: 'available', roiPct: 1.2 }]);
    const response = await POST(request({ ids: [7] }));
    expect(response.status).toBe(200);
    expect(mocks.getCurrentLogRoiBatch).toHaveBeenCalledWith([7]);
    await expect(response.json()).resolves.toEqual({ valuations: [{ id: 7, status: 'available', roiPct: 1.2 }] });
  });

  it('preserves unavailable provenance separately from a genuine persisted zero', async () => {
    mocks.getCurrentLogRoiBatch.mockResolvedValue([
      {
        id: 7,
        status: 'unavailable',
        reasonCode: 'historical_roi_not_persisted',
        reason: 'No authoritative scan-time ROI value was persisted for this result.',
      },
      { id: 8, status: 'available', roiPct: 0 },
    ]);

    const response = await POST(request({ ids: [7, 8] }));
    await expect(response.json()).resolves.toEqual({ valuations: [
      {
        id: 7,
        status: 'unavailable',
        reasonCode: 'historical_roi_not_persisted',
        reason: 'No authoritative scan-time ROI value was persisted for this result.',
      },
      { id: 8, status: 'available', roiPct: 0 },
    ] });
  });

  it.each([[], [0], [1.5], [Number.MAX_SAFE_INTEGER + 1], Array.from({ length: 101 }, (_, index) => index + 1)])('rejects an invalid batch', async (ids) => {
    expect((await POST(request({ ids }))).status).toBe(400);
    expect(mocks.getCurrentLogRoiBatch).not.toHaveBeenCalled();
  });

  it('serves repeated cheap persisted lookups without the former live-valuation throttle', async () => {
    mocks.getCurrentLogRoiBatch.mockResolvedValue([]);
    const responses = await Promise.all(Array.from({ length: 11 }, (_, index) => POST(new NextRequest('http://localhost/api/logs/current-roi', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': `198.18.0.${index + 1}` },
      body: JSON.stringify({ ids: [index + 1] }),
    }))));

    expect(responses.map((response) => response.status)).toEqual(Array(11).fill(200));
    expect(mocks.getCurrentLogRoiBatch).toHaveBeenCalledTimes(11);
  });
});

describe('GET /api/logs/current-roi', () => {
  beforeEach(() => vi.clearAllMocks());

  it('serves the browser read-only batch without requiring mutation authorization', async () => {
    mocks.getCurrentLogRoiBatch.mockResolvedValue([{ id: 7, status: 'available', roiPct: 1.2 }]);

    const response = await GET(new NextRequest('http://localhost/api/logs/current-roi?ids=7,8,7'));

    expect(response.status).toBe(200);
    expect(mocks.getCurrentLogRoiBatch).toHaveBeenCalledWith([7, 8, 7]);
    await expect(response.json()).resolves.toEqual({ valuations: [{ id: 7, status: 'available', roiPct: 1.2 }] });
  });

  it.each(['', '0', '1.5', '01', '1e3', '0x10', '9007199254740992', Array.from({ length: 101 }, (_, index) => index + 1).join(',')])(
    'rejects invalid browser batch %s', async (ids) => {
      expect((await GET(new NextRequest(`http://localhost/api/logs/current-roi?ids=${ids}`))).status).toBe(400);
      expect(mocks.getCurrentLogRoiBatch).not.toHaveBeenCalled();
    },
  );
});