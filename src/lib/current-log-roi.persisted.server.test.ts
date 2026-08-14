import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getLatestCompletedScanRoiForLogIds: vi.fn(),
}));

vi.mock('./persistence', () => ({
  getLatestCompletedScanRoiForLogIds: mocks.getLatestCompletedScanRoiForLogIds,
}));

import { getCurrentLogRoiBatch } from './current-log-roi.server';

describe('getCurrentLogRoiBatch persisted scan resolution', () => {
  beforeEach(() => vi.clearAllMocks());

  it('deduplicates ids and delegates one bounded persisted lookup without venue work', async () => {
    mocks.getLatestCompletedScanRoiForLogIds.mockResolvedValue([
      { id: 7, status: 'available', roiPct: 1.25, strategy: 'best', scannedAt: '2026-08-14T01:00:00.000Z', scanId: 99 },
      { id: 8, status: 'no_arbitrage', scannedAt: '2026-08-14T01:00:00.000Z', scanId: 99 },
    ]);

    await expect(getCurrentLogRoiBatch([7, 8, 7])).resolves.toEqual([
      { id: 7, status: 'available', roiPct: 1.25, strategy: 'best', scannedAt: '2026-08-14T01:00:00.000Z', scanId: 99 },
      { id: 8, status: 'no_arbitrage', scannedAt: '2026-08-14T01:00:00.000Z', scanId: 99 },
    ]);
    expect(mocks.getLatestCompletedScanRoiForLogIds).toHaveBeenCalledTimes(1);
    expect(mocks.getLatestCompletedScanRoiForLogIds).toHaveBeenCalledWith([7, 8]);
  });
});
