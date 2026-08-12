import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  queryScanHistory: vi.fn(),
  queryScanHistoryStream: vi.fn(),
  countScanHistory: vi.fn(),
  getSavedMarkets: vi.fn(),
}));
vi.mock('@/lib/persistence', () => mocks);

import { GET as getLogs } from './route';
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
});
