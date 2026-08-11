import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  approveMatchedPair: vi.fn(),
  rejectMatchedPair: vi.fn(),
}));

vi.mock('@/lib/persistence', () => mocks);

import { POST as approve } from './approve/route';
import { POST as reject } from './reject/route';

const request = new Request('http://localhost/api/matches/1/action', { method: 'POST' }) as never;
const context = (id: string) => ({ params: Promise.resolve({ id }) });

describe('matched-pair action route IDs', () => {
  beforeEach(() => vi.clearAllMocks());

  it.each(['12garbage', '0', '-1', '1.5', '9007199254740992'])('rejects malformed approve ID %s before persistence', async (id) => {
    const response = await approve(request, context(id));

    expect(response.status).toBe(400);
    expect(mocks.approveMatchedPair).not.toHaveBeenCalled();
  });

  it.each(['12garbage', '0', '-1', '1.5', '9007199254740992'])('rejects malformed reject ID %s before persistence', async (id) => {
    const response = await reject(request, context(id));

    expect(response.status).toBe(400);
    expect(mocks.rejectMatchedPair).not.toHaveBeenCalled();
  });

  it('passes a strict positive approve ID to persistence', async () => {
    mocks.approveMatchedPair.mockResolvedValue({ approved: true, market: { id: 'market' } });

    const response = await approve(request, context('42'));

    expect(response.status).toBe(200);
    expect(mocks.approveMatchedPair).toHaveBeenCalledWith(42);
  });

  it('passes a strict positive reject ID to persistence', async () => {
    mocks.rejectMatchedPair.mockResolvedValue(true);

    const response = await reject(request, context('42'));

    expect(response.status).toBe(200);
    expect(mocks.rejectMatchedPair).toHaveBeenCalledWith(42);
  });
});
