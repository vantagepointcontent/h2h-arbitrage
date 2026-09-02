import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({ getScanHistoryDetail: vi.fn() }));
vi.mock('@/lib/persistence', () => mocks);

import { GET } from './route';

function getDetail(id: string) {
  return GET(
    new NextRequest(`http://localhost/api/logs/${id}`),
    { params: Promise.resolve({ id }) },
  );
}

describe('GET /api/logs/[id]', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each(['', '0', '-1', '1.5', '1e3', '0x10', '+1', '01', '9007199254740992'])(
    'rejects a non-canonical or unsafe scan id: %s',
    async (id) => {
      const response = await getDetail(id);

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({ error: 'Invalid scan id' });
      expect(mocks.getScanHistoryDetail).not.toHaveBeenCalled();
    },
  );

  it('queries persistence with a canonical positive safe-integer scan id', async () => {
    const detail = { id: Number.MAX_SAFE_INTEGER, eventTitle: 'Test market' };
    mocks.getScanHistoryDetail.mockResolvedValue(detail);

    const response = await getDetail(String(Number.MAX_SAFE_INTEGER));

    expect(response.status).toBe(200);
    expect(mocks.getScanHistoryDetail).toHaveBeenCalledWith(Number.MAX_SAFE_INTEGER);
    await expect(response.json()).resolves.toEqual(detail);
  });
});
