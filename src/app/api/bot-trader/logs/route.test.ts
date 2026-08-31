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
    expect(getBotActionLogs).toHaveBeenCalledWith(expect.objectContaining({ qualified: true, positiveArb: true }));
  });

  it('excludes scan-level decisions from the qualified candidate result set', async () => {
    vi.mocked(getBotScanDecisions).mockResolvedValue([
      { scanId: 41, state: 'daily_limit', reasonCode: 'no_positive_arb', reason: 'No positive arb', updatedAt: '2026-08-30T12:00:00.000Z' },
      { scanId: 42, state: 'rejected', reasonCode: 'scan_criteria_rejected', reason: 'Criteria rejected', updatedAt: '2026-08-30T12:01:00.000Z' },
    ] as Awaited<ReturnType<typeof getBotScanDecisions>>);

    const response = await GET(new NextRequest('http://localhost/api/bot-trader/logs?qualified=true'));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.decisions).toEqual([]);
    expect(getScanAuditReferences).not.toHaveBeenCalled();
  });

  it('rejects invalid qualified values', async () => {
    const response = await GET(new NextRequest('http://localhost/api/bot-trader/logs?qualified=yes'));
    expect(response.status).toBe(400);
    expect(getBotActionLogs).not.toHaveBeenCalled();
  });

  it('composes positive-arb filtering with qualification and every placement-log filter', async () => {
    const response = await GET(new NextRequest('http://localhost/api/bot-trader/logs?positiveArb=true&qualified=true&status=failed&since=2026-08-01T00%3A00%3A00.000Z&marketId=market-1&cursor=41'));

    expect(response.status).toBe(200);
    expect(getBotActionLogs).toHaveBeenCalledWith({
      positiveArb: true,
      qualified: true,
      status: 'failed',
      since: '2026-08-01T00:00:00.000Z',
      marketId: 'market-1',
      cursor: 41,
    });
    expect(getBotScanDecisions).not.toHaveBeenCalled();
  });

  it('filters no-positive-arb scan classifications server-side while retaining later gate rejections', async () => {
    vi.mocked(getBotScanDecisions).mockResolvedValue([
      { scanId: 41, state: 'criteria_rejected', reasonCode: 'no_positive_arb', reason: 'No Positive Arb — BotTrader not applicable', updatedAt: '2026-08-30T12:00:00.000Z' },
      { scanId: 42, state: 'criteria_rejected', reasonCode: 'scan_criteria_rejected', reason: 'Positive candidate missed ROI threshold', updatedAt: '2026-08-30T12:01:00.000Z' },
    ] as Awaited<ReturnType<typeof getBotScanDecisions>>);

    const response = await GET(new NextRequest('http://localhost/api/bot-trader/logs?positiveArb=true'));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(getBotActionLogs).toHaveBeenCalledWith(expect.objectContaining({ positiveArb: true }));
    expect(getBotScanDecisions).toHaveBeenCalledWith(expect.objectContaining({ positiveArbOnly: true }));
    expect(body.decisions).toEqual([expect.objectContaining({ scanId: 42, reasonCode: 'scan_criteria_rejected' })]);
  });

  it('preserves positive-arb classification when status filtering omits the detection row', async () => {
    vi.mocked(getBotActionLogs).mockResolvedValue({
      rows: [{
        id: 7,
        tradeId: 'later-rejected',
        trigger: 'scan',
        marketId: 'market-1',
        marketTitle: 'Positive candidate rejected later',
        timestamp: '2026-08-30T12:00:00.000Z',
        step: 'criteria_check',
        action: 'ROI threshold rejected',
        requestPayload: null,
        responsePayload: null,
        responseStatus: 'failed',
        errorReason: 'ROI threshold rejected',
        durationMs: null,
        alertMetadata: null,
        qualificationOutcome: 'dead',
        positiveArb: true,
      }],
      nextCursor: null,
    });

    const response = await GET(new NextRequest('http://localhost/api/bot-trader/logs?status=failed&positiveArb=true'));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.trades).toEqual([expect.objectContaining({ tradeId: 'later-rejected', positiveArb: true })]);
  });

  it('rejects invalid positiveArb values', async () => {
    const response = await GET(new NextRequest('http://localhost/api/bot-trader/logs?positiveArb=yes'));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ success: false, error: 'positiveArb must be true or false' });
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
