import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createClient } from '@libsql/client';

let tempDir = '';

afterEach(() => {
  delete process.env.H2H_SQLITE_PATH;
  vi.resetModules();
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('Logs FTS persistence', () => {
  it('reconciles summary totals with every canonical row in the same filtered result set', async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'logs-summary-reconciliation-'));
    process.env.H2H_SQLITE_PATH = path.join(tempDir, 'logs.db');
    vi.resetModules();
    const persistence = await import('./persistence');
    for (const [marketId, positiveArbCount, bestProfit, strategy, arbType] of [
      ['summary-a', 1, 125, 'Buy YES Kalshi + NO PM', 'direct'],
      ['summary-b', 3, 275, 'Buy YES both sides: Kalshi A + PM B', 'cross'],
      ['summary-c', 2, 600, 'Same-platform YES+NO Kalshi: Proposition', 'internal'],
    ] as const) {
      await persistence.saveScanResult(marketId, {
        bestRoiPct: bestProfit / 100,
        bestProfit,
        strategy,
        arbType,
        outcomeCount: positiveArbCount,
        matchedCount: positiveArbCount,
        kalshiCount: positiveArbCount,
        pmCount: positiveArbCount,
        positiveArbCount,
        totalStake: 10_000,
        scannedAt: '2026-08-20T10:00:00.000Z',
      });
    }

    const history = await persistence.queryScanHistory({ positiveArbOnly: true, limit: 500 });
    expect(history.rows).toHaveLength(history.total);
    expect(history.summary.totalProfit).toBe(history.rows.reduce((sum, row) => sum + Number(row.best_profit), 0));
    expect(history.summary.totalArbs).toBe(history.rows.reduce((sum, row) => sum + Number(row.positive_arb_count), 0));
    expect(history.summary.totalProfit).toBe(1_000);
    expect(history.summary.totalArbs).toBe(6);
    expect(history.summary.arbTypeCounts).toEqual({ direct: 1, cross: 3, internal: 2 });
    expect(history.summary.totalArbs).toBe(
      history.summary.arbTypeCounts.direct
      + history.summary.arbTypeCounts.cross
      + history.summary.arbTypeCounts.internal,
    );
  });

  it('excludes declared-type mismatches and unrecognized strategies from rows, summaries, filters, counts, and export streams', async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'logs-canonical-sql-'));
    const databasePath = path.join(tempDir, 'logs.db');
    process.env.H2H_SQLITE_PATH = databasePath;
    vi.resetModules();
    const persistence = await import('./persistence');
    for (const marketId of ['valid-direct', 'mismatched-type', 'unrecognized-strategy']) {
      await persistence.saveScanResult(marketId, {
        bestRoiPct: 2,
        bestProfit: 5,
        strategy: 'Buy YES Kalshi + NO PM',
        arbType: 'direct',
        outcomeCount: 2,
        matchedCount: 2,
        kalshiCount: 2,
        pmCount: 2,
        positiveArbCount: 2,
        totalStake: 100,
        scannedAt: '2026-08-20T10:00:00.000Z',
      });
    }

    // Reproduce stale immutable production evidence that predates canonical projection.
    const client = createClient({ url: `file:${databasePath}` });
    await client.execute({
      sql: `UPDATE scan_results SET strategy = ?, arb_type = 'direct', arb_valid = 1,
              arb_invalidation_reason = NULL, positive_arb_count = 2
            WHERE market_id = 'mismatched-type'`,
      args: ['Buy YES both sides: Kalshi A + PM B'],
    });
    await client.execute({
      sql: `UPDATE scan_results SET strategy = ?, arb_type = 'direct', arb_valid = 1,
              arb_invalidation_reason = NULL, positive_arb_count = 2
            WHERE market_id = 'unrecognized-strategy'`,
      args: ['Buy YES both sides: Kalshi A + PM'],
    });
    client.close();

    const history = await persistence.queryScanHistory({ limit: 500 });
    expect(history.total).toBe(3);
    expect(history.summary.totalArbs).toBe(2);
    expect(history.summary.arbTypeCounts).toEqual({ direct: 2, cross: 0, internal: 0 });
    expect(history.summary.totalArbs).toBe(
      history.summary.arbTypeCounts.direct
      + history.summary.arbTypeCounts.cross
      + history.summary.arbTypeCounts.internal,
    );
    expect(history.rows.find((row) => row.market_id === 'mismatched-type')).toMatchObject({
      arb_type: null,
      arb_valid: 0,
      arb_invalidation_reason: 'arb_type_strategy_mismatch',
      positive_arb_count: 0,
    });
    expect(history.rows.find((row) => row.market_id === 'unrecognized-strategy')).toMatchObject({
      arb_type: null,
      arb_valid: 0,
      arb_invalidation_reason: 'unrecognized_arbitrage_strategy',
      positive_arb_count: 0,
    });

    const direct = await persistence.queryScanHistory({ arbType: 'direct', limit: 500 });
    expect(direct.total).toBe(1);
    expect(direct.rows.map((row) => row.market_id)).toEqual(['valid-direct']);
    expect(direct.summary.totalArbs).toBe(2);
    expect(await persistence.countScanHistory({ arbType: 'direct' })).toBe(1);
    const streamed: string[] = [];
    for await (const batch of persistence.queryScanHistoryStream({ arbType: 'direct', chunkSize: 1 })) {
      streamed.push(...batch.map((row) => row.market_id));
    }
    expect(streamed).toEqual(['valid-direct']);
  });

  it('filters canonical scan-time TTE cumulatively before rows, metrics, counts, and exports', async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'logs-tte-'));
    process.env.H2H_SQLITE_PATH = path.join(tempDir, 'logs.db');
    vi.resetModules();
    const persistence = await import('./persistence');
    for (const [marketId, daysToExpiry, bestProfit] of [
      ['tte-10', 10, 10],
      ['tte-45', 45, 45],
      ['tte-120', 120, 120],
      ['tte-200', 200, 200],
      ['tte-expired', -1, 999],
    ] as const) {
      const scannedAt = '2026-01-01T00:00:00.000Z';
      await persistence.saveScanResult(marketId, {
        bestRoiPct: daysToExpiry, bestProfit, strategy: 'Buy YES Kalshi + NO PM', outcomeCount: 1,
        matchedCount: 1, kalshiCount: 1, pmCount: 1, positiveArbCount: 1, totalStake: 100,
        scannedAt,
        expiryAt: new Date(Date.parse(scannedAt) + daysToExpiry * 86_400_000).toISOString(),
      });
    }
    await persistence.saveScanResult('tte-unavailable', {
      bestRoiPct: 500, bestProfit: 500, strategy: 'Buy YES Kalshi + NO PM', outcomeCount: 1,
      matchedCount: 1, kalshiCount: 1, pmCount: 1, positiveArbCount: 1, totalStake: 100,
      scannedAt: '2026-01-01T00:00:00.000Z',
    });

    const under90 = await persistence.queryScanHistory({ maxTteDays: 90, limit: 1 });
    expect(under90.rows.map((row) => row.market_id)).toEqual(['tte-45']);
    expect(under90.total).toBe(2);
    expect(under90.uniqueMarkets).toBe(2);
    expect(under90.summary.totalProfit).toBe(55);
    expect(under90.maxRoiWithoutMin).toBe(45);
    expect(await persistence.countScanHistory({ maxTteDays: 90 })).toBe(2);
    const streamed: string[] = [];
    for await (const batch of persistence.queryScanHistoryStream({ maxTteDays: 90, chunkSize: 1 })) {
      streamed.push(...batch.map((row) => row.market_id));
    }
    expect(streamed).toEqual(['tte-45', 'tte-10']);

    expect((await persistence.queryScanHistory({ maxTteDays: 30 })).rows.map((row) => row.market_id)).toEqual(['tte-10']);
    expect((await persistence.queryScanHistory({ maxTteDays: 180 })).rows.map((row) => row.market_id)).toEqual(['tte-120', 'tte-45', 'tte-10']);
    expect((await persistence.queryScanHistory({})).rows.map((row) => row.market_id)).toEqual([
      'tte-unavailable', 'tte-expired', 'tte-200', 'tte-120', 'tte-45', 'tte-10',
    ]);
  });

  it('preserves legacy raw evidence but invalidates YES+YES Internal metrics everywhere', async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'logs-internal-audit-'));
    process.env.H2H_SQLITE_PATH = path.join(tempDir, 'logs.db');
    vi.resetModules();
    const persistence = await import('./persistence');
    const raw = { allArbs: [{ strategy: 'Same-platform YES+YES Kalshi: A + B', expectedProfit: 10 }] };
    const invalid = await persistence.saveScanResult('legacy-internal', {
      bestRoiPct: 10, bestProfit: 10, strategy: 'Same-platform YES+YES Kalshi: A + B',
      arbType: 'internal', outcomeCount: 2, matchedCount: 2, kalshiCount: 2, pmCount: 2,
      positiveArbCount: 1, totalStake: 90, scannedAt: '2026-08-12T12:00:00.000Z', raw,
    });
    await persistence.saveScanResult('valid-internal', {
      bestRoiPct: 5, bestProfit: 5, strategy: 'Same-platform YES+NO Kalshi: Proposition',
      arbType: 'internal', outcomeCount: 1, matchedCount: 1, kalshiCount: 1, pmCount: 1,
      positiveArbCount: 1, totalStake: 95, scannedAt: '2026-08-12T12:01:00.000Z',
    });

    const history = await persistence.queryScanHistory({ positiveArbOnly: true, arbType: 'internal' });
    expect(history.rows.map((row) => row.market_id)).toEqual(['valid-internal']);
    expect(history.summary.totalArbs).toBe(1);
    expect(history.summary.totalProfit).toBe(5);
    const detail = await persistence.getScanHistoryDetail(invalid.id);
    expect(JSON.parse(detail?.raw_result ?? '{}')).toEqual(raw);
    const invalidRows = await persistence.getScanHistory('legacy-internal', 1);
    expect(invalidRows[0]).toMatchObject({
      arb_valid: 0,
      arb_invalidation_reason: 'legacy_internal_yes_yes_directional_duplication',
      positive_arb_count: 0,
      best_profit: 0,
    });
  });

  it('projects no-arb and non-executable scans with no Arb Type while keeping validation separate', async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'logs-no-arb-'));
    process.env.H2H_SQLITE_PATH = path.join(tempDir, 'logs.db');
    vi.resetModules();
    const persistence = await import('./persistence');
    const saved = await persistence.saveScanResult('no-arb', {
      bestRoiPct: 99, bestProfit: 99, strategy: 'No arb', outcomeCount: 1,
      matchedCount: 1, kalshiCount: 1, pmCount: 1, positiveArbCount: 1,
      totalStake: 99, scannedAt: '2026-08-12T12:00:00.000Z',
    });

    const nonExecutable = await persistence.saveScanResult('non-executable', {
      bestRoiPct: 2, bestProfit: 2, strategy: 'Buy YES Kalshi + NO PM', arbType: 'direct', outcomeCount: 1,
      matchedCount: 1, kalshiCount: 1, pmCount: 1, positiveArbCount: 0,
      totalStake: 0, scannedAt: '2026-08-12T12:01:00.000Z',
    });

    const history = await persistence.queryScanHistory({ limit: 10 });
    const row = history.rows.find((item) => item.id === saved.id);
    const nonExecutableRow = history.rows.find((item) => item.id === nonExecutable.id);
    expect(row).toMatchObject({
      arb_type: null,
      arb_valid: 1,
      arb_invalidation_reason: null,
      positive_arb_count: 0,
      best_profit: 0,
      best_roi_pct: 0,
    });
    expect(nonExecutableRow).toMatchObject({
      arb_type: null,
      arb_valid: 1,
      arb_invalidation_reason: null,
      positive_arb_count: 0,
    });
    expect((await persistence.queryScanHistory({ arbType: 'direct' })).rows).toHaveLength(0);
    const exported: Array<Record<string, unknown>> = [];
    for await (const batch of persistence.queryScanHistoryStream({ chunkSize: 1 })) exported.push(...batch);
    expect(exported.find((item) => item.id === saved.id)).toMatchObject({ arb_type: null, arb_valid: 1 });
    expect(exported.find((item) => item.id === nonExecutable.id)).toMatchObject({ arb_type: null, arb_valid: 1 });
  });

  it('loads immutable current-valuation identity and original scan capital from the captured payload', async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'logs-valuation-input-'));
    process.env.H2H_SQLITE_PATH = path.join(tempDir, 'logs.db');
    vi.resetModules();
    const persistence = await import('./persistence');
    const saved = await persistence.saveScanResult('valuation-input', {
      bestRoiPct: 2,
      bestProfit: 2,
      strategy: 'Buy YES Kalshi + NO PM',
      arbType: 'direct',
      outcomeCount: 2,
      matchedCount: 2,
      kalshiCount: 2,
      pmCount: 2,
      positiveArbCount: 2,
      totalStake: 100,
      scannedAt: '2026-08-13T20:00:00.000Z',
      kalshiUrl: 'https://kalshi.com/markets/a/a/A',
      polymarketUrl: 'https://polymarket.com/event/a',
      raw: { scanCapital: 100, allArbs: [
        { strategy: 'Buy YES Kalshi + NO PM', arbType: 'direct', kalshiTicker: 'A-1', pmConditionId: 'C-1', totalStake: 95 },
        { strategy: 'Buy YES PM + NO Kalshi', arbType: 'direct', kalshiTicker: 'A-2', pmConditionId: 'C-2', totalStake: 90 },
      ] },
    });

    await expect(persistence.getScanValuationInputs([saved.id])).resolves.toEqual([{
      id: saved.id,
      kalshiUrl: 'https://kalshi.com/markets/a/a/A',
      polymarketUrl: 'https://polymarket.com/event/a',
      scanCapital: 100,
      candidates: [
        { strategy: 'Buy YES Kalshi + NO PM', arbType: 'direct', kalshiTicker: 'A-1', pmConditionId: 'C-1' },
        { strategy: 'Buy YES PM + NO Kalshi', arbType: 'direct', kalshiTicker: 'A-2', pmConditionId: 'C-2' },
      ],
    }]);
  });

  it('reports the complete non-ROI-filtered maximum when min ROI excludes every row', async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'logs-roi-range-'));
    process.env.H2H_SQLITE_PATH = path.join(tempDir, 'logs.db');
    vi.resetModules();
    const persistence = await import('./persistence');
    for (const [marketId, bestRoiPct] of [['low', 2.5], ['high', 8.75]] as const) {
      await persistence.saveScanResult(marketId, {
        bestRoiPct, bestProfit: 1, strategy: 'direct', outcomeCount: 1, matchedCount: 1,
        kalshiCount: 1, pmCount: 1, positiveArbCount: 1, totalStake: 100,
        scannedAt: '2026-08-12T12:00:00.000Z', marketTitle: `${marketId} ROI market`,
      });
    }

    const result = await persistence.queryScanHistory({ minRoi: 99, positiveArbOnly: true });

    expect(result.rows).toHaveLength(0);
    expect(result.maxRoiWithoutMin).toBe(8.75);
  });

  it('uses the FTS virtual-table index for case-insensitive contains search', async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'logs-search-'));
    process.env.H2H_SQLITE_PATH = path.join(tempDir, 'logs.db');
    vi.resetModules();
    const persistence = await import('./persistence');

    await persistence.saveScanResult('outside-page', {
      bestRoiPct: 2,
      bestProfit: 1,
      strategy: 'Buy YES Kalshi + NO PM',
      outcomeCount: 1,
      matchedCount: 1,
      kalshiCount: 1,
      pmCount: 1,
      positiveArbCount: 1,
      totalStake: 100,
      scannedAt: '2026-08-12T12:00:00.000Z',
      marketTitle: 'MN-01 House Election Winner',
    });

    const result = await persistence.queryScanHistory({ search: 'mn-01', limit: 250 });
    expect(result.rows.map((row) => row.market_id)).toEqual(['outside-page']);
    const plan = await persistence.explainScanHistorySearchPlan('MN-01');
    expect(plan.join(' ')).toMatch(/VIRTUAL TABLE INDEX \d+:M\d+/i);
  });

  it('refreshes indexed fallback text when a saved market title changes', async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'logs-search-title-'));
    process.env.H2H_SQLITE_PATH = path.join(tempDir, 'logs.db');
    vi.resetModules();
    const persistence = await import('./persistence');
    const suffix = crypto.randomUUID();
    const market = await persistence.addSavedMarket({
      kalshiUrl: `https://kalshi.com/markets/${suffix}`,
      polymarketUrl: `https://polymarket.com/event/${suffix}`,
      eventTitle: `Original fallback ${suffix}`, category: '', expiryDate: null,
    });
    await persistence.saveScanResult(market.id, {
      bestRoiPct: 2, bestProfit: 1, strategy: 'Buy YES Kalshi + NO PM', outcomeCount: 1,
      matchedCount: 1, kalshiCount: 1, pmCount: 1, positiveArbCount: 1, totalStake: 100,
      scannedAt: '2026-08-12T12:00:00.000Z',
    });

    await persistence.upsertSavedMarket({
      kalshiUrl: market.kalshiUrl, polymarketUrl: market.polymarketUrl,
      eventTitle: `MN-01 renamed ${suffix}`, category: '', expiryDate: null,
    });

    expect((await persistence.queryScanHistory({ search: 'mn-01' })).rows).toHaveLength(1);
    expect((await persistence.queryScanHistory({ search: `original fallback ${suffix}` })).rows).toHaveLength(0);

    await persistence.updateSavedMarket(market.id, { eventTitle: `Final searchable ${suffix}` });
    expect((await persistence.queryScanHistory({ search: `final searchable ${suffix}` })).rows).toHaveLength(1);
    expect((await persistence.queryScanHistory({ search: 'mn-01' })).rows).toHaveLength(0);
  });

  it.each([
    ['%', 'Literal % title'],
    ['_', 'Literal _ title'],
    ['\\', 'Literal \\ title'],
  ])('treats the short search term %s as a literal character', async (search, matchingTitle) => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'logs-search-literal-'));
    process.env.H2H_SQLITE_PATH = path.join(tempDir, 'logs.db');
    vi.resetModules();
    const persistence = await import('./persistence');
    await persistence.saveScanResult('matching', {
      bestRoiPct: 2, bestProfit: 1, strategy: 'direct', outcomeCount: 1, matchedCount: 1,
      kalshiCount: 1, pmCount: 1, positiveArbCount: 1, totalStake: 100,
      scannedAt: '2026-08-12T12:00:00.000Z', marketTitle: matchingTitle,
    });
    await persistence.saveScanResult('ordinary', {
      bestRoiPct: 2, bestProfit: 1, strategy: 'direct', outcomeCount: 1, matchedCount: 1,
      kalshiCount: 1, pmCount: 1, positiveArbCount: 1, totalStake: 100,
      scannedAt: '2026-08-12T11:00:00.000Z', marketTitle: 'Ordinary title',
    });

    const result = await persistence.queryScanHistory({ search });
    expect(result.rows.map((row) => row.market_id)).toEqual(['matching']);
    expect(result.total).toBe(1);
  });
});
