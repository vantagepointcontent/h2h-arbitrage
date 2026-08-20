import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { executableEnvelopeFixture } from '@/lib/test-fixtures/calculation-envelope';

const mocks = vi.hoisted(() => ({
  queryScanHistory: vi.fn(),
  getScanHistoryDetail: vi.fn(),
  queryScanHistoryStream: vi.fn(),
  countScanHistory: vi.fn(),
  getSavedMarkets: vi.fn(),
  getCurrentLogRoiBatch: vi.fn(),
  getBotScanEvaluationSummaries: vi.fn(),
  getLogsDataQualityHealth: vi.fn(),
}));
vi.mock('@/lib/persistence', () => mocks);
vi.mock('@/lib/current-log-roi.server', () => ({ getCurrentLogRoiBatch: mocks.getCurrentLogRoiBatch }));
vi.mock('@/lib/bot-scan-consumer', () => ({ getBotScanEvaluationSummaries: mocks.getBotScanEvaluationSummaries }));

import { GET as getLogs } from './route';
import { GET as getLogDetail } from './[id]/route';
import { GET as exportLogs, HEAD as headExportLogs } from './export/route';

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
  scan_status: 'completed',
  raw_result: null,
  calculation_envelope: JSON.stringify(executableEnvelopeFixture),
};

describe('Logs scan-time APY serialization', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSavedMarkets.mockResolvedValue([]);
    mocks.queryScanHistory.mockResolvedValue({ rows: [persistedRow], total: 1, uniqueMarkets: 1 });
    mocks.queryScanHistoryStream.mockImplementation(async function* () { yield [persistedRow]; });
    mocks.getCurrentLogRoiBatch.mockResolvedValue([{ id: 7, status: 'available', roiPct: 1.5 }]);
    mocks.getLogsDataQualityHealth.mockResolvedValue({ latest: null, rolling: { batches: 0, degradedBatches: 0, fields: {} } });
    mocks.getBotScanEvaluationSummaries.mockResolvedValue(new Map([[7, {
      scanId: 7, status: 'completed', botTraderEvaluationCompleted: true,
      reason: 'Every candidate has a terminal auditable decision',
      startedAt: '2026-08-12T12:00:01.000Z', completedAt: '2026-08-12T12:00:02.000Z',
      updatedAt: '2026-08-12T12:00:02.000Z', settingsVersion: 'bot-settings-v1:test',
      candidateCount: 1, evaluatedCount: 1, eligibleCount: 0,
      placementAttemptCount: 0, placedCount: 0, skippedCount: 1, failureCount: 0,
      missingCandidateIndexes: [], failingCandidateIndexes: [],
    }]]));
  });

  it('returns persisted APY and TTE through the Logs API', async () => {
    const response = await getLogs(new NextRequest('http://localhost/api/logs'));
    const body = await response.json();

    expect(body.logs[0]).toMatchObject({
      apy_pct: 1825,
      days_to_expiry: 0.5,
      expiry_at: '2026-08-13T00:00:00.000Z',
      apy_unavailable_reason: null,
      scan_status: 'completed',
      calculation_envelope: {
        version: 1,
        status: 'executable',
        requestedQuantityMicros: 1_000_000,
        totals: { totalFeesMicros: 28_560, netPnlMicros: -8_560 },
      },
      botTraderEvaluationCompleted: true,
      botTraderEvaluationStatus: 'completed',
      botTraderEvaluation: expect.objectContaining({
        candidateCount: 1,
        evaluatedCount: 1,
        placedCount: 0,
      }),
    });
    expect(mocks.getBotScanEvaluationSummaries).toHaveBeenCalledWith([7]);
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
      maxRoiWithoutMin: 14.25,
      summary: {
        totalArbs: 1200,
        avgRoi: 2.75,
        bestRoi: 9.5,
        totalProfit: 4321.5,
        arbTypeCounts: { direct: 400, cross: 300, internal: 212 },
      },
    });

    const response = await getLogs(new NextRequest(
      'http://localhost/api/logs?search=MN-01&eventType=arb&arbType=cross&positiveArbOnly=true&maxTteDays=90&limit=250',
    ));
    const body = await response.json();

    expect(mocks.queryScanHistory).toHaveBeenCalledWith(expect.objectContaining({
      search: 'MN-01',
      eventType: 'arb',
      arbType: 'cross',
      positiveArbOnly: true,
      maxTteDays: 90,
      limit: 250,
    }));
    expect(body).toMatchObject({
      total: 912,
      uniqueMarkets: 44,
      maxRoiWithoutMin: 14.25,
      summary: { totalArbs: 1200 },
    });
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
    expect(values[columns.indexOf('Days to Expiry')]).toBe('0.5');
    expect(values[columns.indexOf('Expiry At')]).toBe('2026-08-13T00:00:00.000Z');
    expect(values[columns.indexOf('Calculation Version')]).toBe('1');
    expect(values[columns.indexOf('Calculation Status')]).toBe('executable');
    expect(values[columns.indexOf('Requested Quantity')]).toBe('1');
    expect(values[columns.indexOf('Executable Quantity')]).toBe('1');
    expect(values[columns.indexOf('Gross Cost ($)')]).toBe('0.98');
    expect(values[columns.indexOf('Total Fees ($)')]).toBe('0.02856');
    expect(values[columns.indexOf('Net P&L ($)')]).toBe('-0.00856');
    expect(values[columns.indexOf('BotTrader Evaluation Completed')]).toBe('TRUE');
    expect(values[columns.indexOf('BotTrader Evaluation Status')]).toBe('completed');
    expect(values[columns.indexOf('BotTrader Candidates Evaluated')]).toBe('1');
    expect(values[columns.indexOf('BotTrader Candidates Total')]).toBe('1');
    expect(values[columns.indexOf('BotTrader Placed Count')]).toBe('0');
    expect(csv).toContain('pm-no-token-1');
  });

  it('returns and exports the intentional no-positive-arb not-applicable status', async () => {
    mocks.getBotScanEvaluationSummaries.mockResolvedValue(new Map([[7, {
      scanId: 7,
      status: 'not_applicable_no_positive_arb',
      botTraderEvaluationCompleted: false,
      reason: 'No Positive Arb — BotTrader not applicable',
      startedAt: '2026-08-12T12:00:01.000Z',
      completedAt: '2026-08-12T12:00:01.000Z',
      updatedAt: '2026-08-12T12:00:01.000Z',
      settingsVersion: null,
      candidateCount: 0,
      evaluatedCount: 0,
      eligibleCount: 0,
      placementAttemptCount: 0,
      placedCount: 0,
      skippedCount: 0,
      failureCount: 0,
      missingCandidateIndexes: [],
      failingCandidateIndexes: [],
    }]]));

    const response = await getLogs(new NextRequest('http://localhost/api/logs'));
    const body = await response.json();
    expect(body.logs[0]).toMatchObject({
      botTraderEvaluationCompleted: false,
      botTraderEvaluationStatus: 'not_applicable_no_positive_arb',
      botTraderEvaluation: {
        reason: 'No Positive Arb — BotTrader not applicable',
        candidateCount: 0,
        evaluatedCount: 0,
        placementAttemptCount: 0,
      },
    });

    const exportResponse = await exportLogs(new NextRequest('http://localhost/api/logs/export'));
    const [header, row] = (await exportResponse.text()).trim().split('\n').map((line) => line.split(','));
    expect(row[header.indexOf('BotTrader Evaluation Completed')]).toBe('FALSE');
    expect(row[header.indexOf('BotTrader Evaluation Status')]).toBe('not_applicable_no_positive_arb');
    expect(row[header.indexOf('BotTrader Evaluation Reason')]).toBe('No Positive Arb — BotTrader not applicable');
    expect(row[header.indexOf('BotTrader Candidates Evaluated')]).toBe('0');
    expect(row[header.indexOf('BotTrader Placement Attempts')]).toBe('0');
  });

  it('exports the resolver field-level APY reason instead of a legacy aggregate reason', async () => {
    mocks.queryScanHistoryStream.mockImplementationOnce(async function* () {
      yield [{
        ...persistedRow,
        apy_pct: null,
        apy_unavailable_reason: 'outcome_contingent',
        raw_result: JSON.stringify({ allArbs: [{ roiPct: 2.5, expectedProfit: 12.5, totalStake: 100 }] }),
      }];
    });

    const response = await exportLogs(new NextRequest('http://localhost/api/logs/export'));
    const [header, row] = (await response.text()).trim().split('\n').map((line) => line.split(','));

    expect(row[header.indexOf('APY %')]).toBe('');
    expect(row[header.indexOf('APY Unavailable Reason')]).toBe(
      'No authoritative scan-time APY value was persisted for this result.',
    );
  });

  it('exports Current ROI and ROI Declined from full-precision persisted values', async () => {
    mocks.queryScanHistoryStream.mockImplementationOnce(async function* () {
      yield [
        { ...persistedRow, id: 7, best_roi_pct: 1.004 },
        { ...persistedRow, id: 8, market_id: 'market-8', best_roi_pct: 4 },
      ];
    });
    mocks.getCurrentLogRoiBatch.mockResolvedValueOnce([
      { id: 7, status: 'available', roiPct: 1.003 },
      { id: 8, status: 'never_scanned' },
    ]);

    const response = await exportLogs(new NextRequest('http://localhost/api/logs/export'));
    const [header, first, second] = (await response.text()).trim().split('\n').map((line) => line.split(','));

    const roiIndex = header.indexOf('ROI %');
    expect(header.slice(roiIndex, roiIndex + 6)).toEqual([
      'ROI %', 'ROI Unavailable Reason', 'Current ROI %',
      'Current ROI Unavailable Reason', 'ROI Declined?', 'ROI Declined Unavailable Reason',
    ]);
    expect(first.slice(roiIndex, roiIndex + 6)).toEqual(['1.004', '', '1.003', '', 'TRUE', '']);
    expect(second.slice(roiIndex, roiIndex + 6)).toEqual([
      '4', '', '', 'No successfully completed scan exists for the exact linked market pair.', '',
      'Current ROI is unavailable: No successfully completed scan exists for the exact linked market pair.',
    ]);
    expect(mocks.getCurrentLogRoiBatch).toHaveBeenCalledWith([7, 8]);
  });

  it('serializes immutable legacy financial scalars field-by-field despite a legacy envelope', async () => {
    mocks.queryScanHistory.mockResolvedValue({
      rows: [{ ...persistedRow, calculation_envelope: null, best_profit: null }],
      total: 1,
      uniqueMarkets: 1,
    });

    const response = await getLogs(new NextRequest('http://localhost/api/logs'));
    const body = await response.json();

    expect(body.logs[0].historical_financials).toMatchObject({
      revision: 2,
      fields: {
        roiPct: { status: 'available', value: 2.5 },
        profitUsd: { status: 'unavailable', reasonCode: 'historical_profit_not_persisted' },
        apyPct: { status: 'available', value: 1825 },
        stakeUsd: { status: 'available', value: 100 },
      },
    });
  });

  it('exports the field-level historical APY reason instead of a stale legacy reason', async () => {
    mocks.queryScanHistoryStream.mockImplementationOnce(async function* () {
      yield [{ ...persistedRow, apy_pct: null, apy_unavailable_reason: 'stale_legacy_reason' }];
    });

    const response = await exportLogs(new NextRequest('http://localhost/api/logs/export'));
    const [header, row] = (await response.text()).trim().split('\n').map((line) => line.split(','));
    expect(row[header.indexOf('APY %')]).toBe('');
    expect(row[header.indexOf('APY Unavailable Reason')])
      .toBe('No authoritative scan-time APY value was persisted for this result.');
  });

  it('exports both winning-leg settlement scenarios and provenance', async () => {
    mocks.queryScanHistoryStream.mockImplementationOnce(async function* () {
      yield [{ ...persistedRow, apy_pct: null, apy_unavailable_reason: 'outcome_contingent', raw_result: JSON.stringify({ outcomeApy: {
        scenarioA: { winner: 'kalshi', settlementAt: '2027-01-04T15:00:00.000Z', apyPct: 0.40858, timingSource: 'kalshi.market.expected_expiration_time', unavailableReason: null },
        scenarioB: { winner: 'polymarket', settlementAt: '2026-11-03T00:00:00.000Z', apyPct: 0.72627, timingSource: 'polymarket.event.endDate', unavailableReason: null },
      } }) }];
    });
    const response = await exportLogs(new NextRequest('http://localhost/api/logs/export'));
    const [header, row] = (await response.text()).trim().split('\n');
    const columns = header.split(',');
    const values = row.split(',');
    expect(values[columns.indexOf('APY Unavailable Reason')])
      .toBe('No authoritative scan-time APY value was persisted for this result.');
    expect(values[columns.indexOf('Scenario A Settlement')]).toBe('2027-01-04T15:00:00.000Z');
    expect(values[columns.indexOf('Scenario A Timing Source')]).toBe('kalshi.market.expected_expiration_time');
    expect(values[columns.indexOf('Scenario B Settlement')]).toBe('2026-11-03T00:00:00.000Z');
    expect(values[columns.indexOf('Scenario B APY %')]).toBe('0.72627');
  });

  it('applies search and classification filters to export before streaming', async () => {
    await exportLogs(new NextRequest(
      'http://localhost/api/logs/export?search=mn-01&eventType=arb&arbType=direct&maxTteDays=180',
    ));

    expect(mocks.queryScanHistoryStream).toHaveBeenCalledWith(expect.objectContaining({
      search: 'mn-01',
      eventType: 'arb',
      arbType: 'direct',
      maxTteDays: 180,
    }));
  });

  it('applies the same TTE filter to the complete export count', async () => {
    mocks.countScanHistory.mockResolvedValue(123);
    const response = await headExportLogs(new NextRequest(
      'http://localhost/api/logs/export?maxTteDays=30',
    ));

    expect(mocks.countScanHistory).toHaveBeenCalledWith(expect.objectContaining({ maxTteDays: 30 }));
    expect(response.headers.get('X-Export-Row-Count')).toBe('123');
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
