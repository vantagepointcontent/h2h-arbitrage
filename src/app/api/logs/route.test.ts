import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  queryScanHistory: vi.fn(),
  getScanHistoryDetail: vi.fn(),
  queryScanHistoryStream: vi.fn(),
  countScanHistory: vi.fn(),
  getSavedMarkets: vi.fn(),
}));
vi.mock('@/lib/persistence', () => mocks);

import { GET as getLogs } from './route';
import { GET as getLogDetail } from './[id]/route';
import { GET as exportLogs } from './export/route';

const persistedRow = {
  id: 7,
  market_id: 'market-7',
  market_title: 'Snapshot market',
  best_roi_pct: 2.5,
  best_profit: 12.5,
  strategy: 'Buy YES Kalshi + NO PM',
  outcome_count: 1,
  matched_count: 1,
  kalshi_count: 1,
  pm_count: 1,
  positive_arb_count: 1,
  total_stake: 100,
  scanned_at: '2026-08-12T12:00:00.000Z',
  expiry_at: '2026-08-13T00:00:00.000Z',
  days_to_expiry: 0.5,
  apy_pct: 1825,
  apy_unavailable_reason: null,
  raw_result: null,
};

describe('Logs scan-time APY serialization', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSavedMarkets.mockResolvedValue([]);
    mocks.queryScanHistory.mockResolvedValue({ rows: [persistedRow], total: 1, uniqueMarkets: 1 });
    mocks.queryScanHistoryStream.mockImplementation(async function* () { yield [persistedRow]; });
  });

  it('returns persisted APY and TTE through the Logs API', async () => {
    const response = await getLogs(new NextRequest('http://localhost/api/logs'));
    const body = await response.json();

    expect(body.logs[0]).toMatchObject({
      apy_pct: 1825,
      days_to_expiry: 0.5,
      expiry_at: '2026-08-13T00:00:00.000Z',
      apy_unavailable_reason: null,
    });
  });

  it('omits heavy raw scan details from paginated list responses', async () => {
    mocks.queryScanHistory.mockResolvedValue({
      rows: [{ ...persistedRow, raw_result: '{"allArbs":[{"large":"blob"}]}' }],
      total: 1,
      uniqueMarkets: 1,
    });

    const response = await getLogs(new NextRequest('http://localhost/api/logs'));
    const body = await response.json();

    expect(body.logs[0]).not.toHaveProperty('raw_result');
  });

  it('loads one immutable scan detail by numeric id', async () => {
    mocks.getScanHistoryDetail.mockResolvedValue({
      id: 7,
      raw_result: '{"allArbs":[{"roiPct":2.5}]}',
    });

    const response = await getLogDetail(
      new NextRequest('http://localhost/api/logs/7'),
      { params: Promise.resolve({ id: '7' }) },
    );

    expect(mocks.getScanHistoryDetail).toHaveBeenCalledWith(7);
    expect(await response.json()).toEqual({
      id: 7,
      raw_result: '{"allArbs":[{"roiPct":2.5}]}',
    });
  });

  it('passes complete server-side filters and returns full-filter summaries', async () => {
    mocks.queryScanHistory.mockResolvedValue({
      rows: [persistedRow],
      total: 912,
      uniqueMarkets: 44,
      summary: {
        totalArbs: 1200,
        avgRoi: 2.75,
        bestRoi: 9.5,
        totalProfit: 4321.5,
        arbTypeCounts: { direct: 400, cross: 300, internal: 212 },
      },
    });

    const response = await getLogs(new NextRequest(
      'http://localhost/api/logs?search=MN-01&eventType=arb&arbType=cross&positiveArbOnly=true&limit=250',
    ));
    const body = await response.json();

    expect(mocks.queryScanHistory).toHaveBeenCalledWith(expect.objectContaining({
      search: 'MN-01',
      eventType: 'arb',
      arbType: 'cross',
      positiveArbOnly: true,
      limit: 250,
    }));
    expect(body).toMatchObject({ total: 912, uniqueMarkets: 44, summary: { totalArbs: 1200 } });
  });

  it('uses a stable timestamp and id cursor without dropping tied rows', async () => {
    await getLogs(new NextRequest(
      'http://localhost/api/logs?before=2026-08-12T12%3A00%3A00.000Z%7C7',
    ));

    expect(mocks.queryScanHistory).toHaveBeenCalledWith(expect.objectContaining({
      before: { scannedAt: '2026-08-12T12:00:00.000Z', id: 7 },
    }));
  });

  it('exports exactly the same persisted APY percentage', async () => {
    const response = await exportLogs(new NextRequest('http://localhost/api/logs/export'));
    const csv = await response.text();
    const [header, row] = csv.trim().split('\n');
    const columns = header.split(',');
    const values = row.split(',');

    expect(columns).toContain('APY %');
    expect(values[columns.indexOf('APY %')]).toBe('1825');
    expect(values[columns.indexOf('APY Unavailable Reason')]).toBe('');
  });

  it('applies search and classification filters to export before streaming', async () => {
    await exportLogs(new NextRequest(
      'http://localhost/api/logs/export?search=mn-01&eventType=arb&arbType=direct',
    ));

    expect(mocks.queryScanHistoryStream).toHaveBeenCalledWith(expect.objectContaining({
      search: 'mn-01',
      eventType: 'arb',
      arbType: 'direct',
    }));
  });

  it('does not impose a 50,000-row cap on complete exports', async () => {
    mocks.queryScanHistoryStream.mockImplementation(async function* (filters: { maxRows?: number }) {
      expect(filters.maxRows).toBeUndefined();
      for (let offset = 0; offset < 50_001; offset += 1000) {
        yield Array.from({ length: Math.min(1000, 50_001 - offset) }, (_, index) => ({
          ...persistedRow, id: offset + index + 1, market_id: `market-${offset + index + 1}`,
        }));
      }
    });

    const response = await exportLogs(new NextRequest('http://localhost/api/logs/export'));
    const csv = await response.text();
    expect(csv.trim().split('\n')).toHaveLength(50_002);
  });
});
