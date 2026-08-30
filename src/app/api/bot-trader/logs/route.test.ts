import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { getBotActionLogs, pruneBotActionLogs } from '@/lib/bot-action-log';
import { getBotScanDecisions } from '@/lib/bot-scan-consumer';
import { getScanAuditReferences } from '@/lib/persistence';
import { GET } from './route';

vi.mock('@/lib/bot-action-log', () => ({
  getBotActionLogs: vi.fn(),
  pruneBotActionLogs: vi.fn(),
}));
vi.mock('@/lib/bot-scan-consumer', () => ({ getBotScanDecisions: vi.fn() }));
vi.mock('@/lib/persistence', () => ({ getScanAuditReferences: vi.fn() }));

describe('GET /api/bot-trader/logs qualified filter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(pruneBotActionLogs).mockResolvedValue(0);
    vi.mocked(getBotActionLogs).mockResolvedValue({ rows: [], nextCursor: null });
    vi.mocked(getBotScanDecisions).mockResolvedValue([]);
    vi.mocked(getScanAuditReferences).mockResolvedValue(new Map());
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

  it.each(['', '0', '-1', '1.5', '1e3', '9007199254740992'])('rejects a non-canonical or unsafe cursor: %s', async (cursor) => {
    const response = await GET(new NextRequest(`http://localhost/api/bot-trader/logs?cursor=${cursor}`));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ success: false, error: 'cursor must be a positive integer' });
    expect(pruneBotActionLogs).not.toHaveBeenCalled();
    expect(getBotActionLogs).not.toHaveBeenCalled();
  });

  it('passes a positive safe-integer cursor to persistence', async () => {
    const response = await GET(new NextRequest('http://localhost/api/bot-trader/logs?cursor=9007199254740991'));

    expect(response.status).toBe(200);
    expect(getBotActionLogs).toHaveBeenCalledWith(expect.objectContaining({ cursor: Number.MAX_SAFE_INTEGER }));
  });

  it('correlates scan rows by the exact persisted scan id', async () => {
    vi.mocked(getBotScanDecisions).mockResolvedValue([
      { scanId: 41, state: 'daily_limit', reasonCode: 'no_positive_arb', reason: 'No positive arb', updatedAt: '2026-08-30T12:00:00.000Z' },
      { scanId: 42, state: 'daily_limit', reasonCode: 'no_positive_arb', reason: 'No positive arb', updatedAt: '2026-08-30T12:01:00.000Z' },
    ] as Awaited<ReturnType<typeof getBotScanDecisions>>);
    vi.mocked(getScanAuditReferences).mockResolvedValue(new Map([
      [41, { scanId: 41, logUuid: 'A1B2C3', marketId: 'same-market', marketName: 'Same Market' }],
      [42, { scanId: 42, logUuid: 'D4E5F6', marketId: 'same-market', marketName: 'Same Market' }],
    ]));

    const response = await GET(new NextRequest('http://localhost/api/bot-trader/logs'));
    const body = await response.json();

    expect(getScanAuditReferences).toHaveBeenCalledWith([41, 42]);
    expect(body.decisions).toEqual([
      expect.objectContaining({ scanId: 41, logUuid: 'A1B2C3', marketId: 'same-market', marketName: 'Same Market' }),
      expect.objectContaining({ scanId: 42, logUuid: 'D4E5F6', marketId: 'same-market', marketName: 'Same Market' }),
    ]);
  });
});
