import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  consume: vi.fn(() => ({ allowed: true, retryAfterSeconds: 0 })),
  isTrustedScheduledScan: vi.fn(() => false),
  assertDiskCapacity: vi.fn(),
  run: vi.fn(),
}));

vi.mock('@/lib/scan-rate-limit', () => ({
  scanRateLimiter: { consume: mocks.consume },
  getScanClientKey: () => 'test',
  isTrustedScheduledScan: mocks.isTrustedScheduledScan,
}));
vi.mock('@/lib/scan-worker-coordinator', async () => {
  const actual = await vi.importActual<typeof import('@/lib/scan-worker-coordinator')>('@/lib/scan-worker-coordinator');
  return { ...actual, scanWorkerCoordinator: { run: mocks.run } };
});
vi.mock('@/lib/scan-links', () => ({
  resolveScanLinks: () => ({ kalshiUrl: 'https://kalshi.com/markets/a', polymarketUrl: 'https://polymarket.com/event/b' }),
}));
vi.mock('@/lib/disk-capacity.mjs', () => ({
  assertDiskCapacity: mocks.assertDiskCapacity,
}));

import { POST } from './route';
import { ScanWorkerError } from '@/lib/scan-worker-coordinator';

function request() {
  return new NextRequest('http://localhost/api/scan', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ kalshiUrl: 'k', polymarketUrl: 'p' }),
  });
}

describe('POST /api/scan worker boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.consume.mockReturnValue({ allowed: true, retryAfterSeconds: 0 });
    mocks.isTrustedScheduledScan.mockReturnValue(false);
    mocks.assertDiskCapacity.mockResolvedValue({ allowed: true });
    mocks.run.mockResolvedValue({ status: 200, headers: { 'content-type': 'application/json' }, body: '{"ok":true}', jobId: 'job-1' });
  });

  it('delegates full scan execution to a worker job', async () => {
    const response = await POST(request());

    expect(response.status).toBe(200);
    expect(response.headers.get('X-Scan-Job-Id')).toBe('job-1');
    expect(mocks.run).toHaveBeenCalledWith(
      expect.stringMatching(/^https:\/\/kalshi\.com\/markets\/a\|https:\/\/polymarket\.com\/event\/b\|/),
      expect.objectContaining({ body: expect.any(String), url: 'http://localhost/api/scan' }),
      expect.any(AbortSignal),
    );
  });

  it('lets an authenticated saved-market poller bypass the browser request budget', async () => {
    mocks.isTrustedScheduledScan.mockReturnValue(true);

    expect((await POST(request())).status).toBe(200);
    expect(mocks.consume).not.toHaveBeenCalled();
  });

  it('preserves 503 Retry-After when worker capacity is exhausted', async () => {
    mocks.run.mockRejectedValue(new ScanWorkerError('capacity', 'SCAN_CAPACITY'));

    const response = await POST(request());

    expect(response.status).toBe(503);
    expect(response.headers.get('Retry-After')).toBe('2');
  });

  it('fails before starting a worker when reserved disk headroom would be breached', async () => {
    mocks.assertDiskCapacity.mockRejectedValue(Object.assign(new Error('headroom'), { code: 'DISK_CAPACITY' }));

    const response = await POST(request());

    expect(response.status).toBe(503);
    expect(response.headers.get('Retry-After')).toBe('60');
    expect(await response.json()).toMatchObject({ code: 'DISK_CAPACITY' });
    expect(mocks.run).not.toHaveBeenCalled();
  });

  it('maps worker timeout to 504', async () => {
    mocks.run.mockRejectedValue(new ScanWorkerError('deadline', 'SCAN_TIMEOUT'));
    expect((await POST(request())).status).toBe(504);
  });
});
