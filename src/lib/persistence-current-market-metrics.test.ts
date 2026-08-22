import { afterEach, describe, expect, it, vi } from 'vitest';
import { createClient } from '@libsql/client';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let tempDir = '';

afterEach(() => {
  delete process.env.H2H_SQLITE_PATH;
  delete process.env.H2H_SAVED_MARKETS_FILE;
  vi.resetModules();
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('BUG-179 canonical current-market metric projection', () => {
  it('recovers field-level legacy ROI while leaving contradictory zero profit and APY unavailable', async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'current-market-legacy-roi-only-'));
    process.env.H2H_SQLITE_PATH = path.join(tempDir, 'edgefinder.db');
    process.env.H2H_SAVED_MARKETS_FILE = path.join(tempDir, 'saved-markets.json');
    vi.resetModules();
    const persistence = await import('./persistence');
    const market = await persistence.addSavedMarket({
      kalshiUrl: 'https://kalshi.com/markets/legacy-roi', polymarketUrl: 'https://polymarket.com/event/legacy-roi',
      eventTitle: 'Legacy ROI-only candidate', expiryDate: '2026-11-28T00:00:00.000Z',
    });
    const revision = await persistence.reserveSavedMarketPublication(market.id, 'scan');
    await persistence.updateSavedMarketScanResult(market.id, {
      bestRoiPct: 2, bestProfit: 0, strategy: 'Buy YES Kalshi + NO PM', arbType: 'direct',
      outcomeCount: 1, matchedCount: 1, matchStatus: 'matched', kalshiCount: 1, pmCount: 1,
      scannedAt: '2026-08-20T13:00:00.000Z', publicationGeneration: revision,
      allArbs: [{ artist: 'Yes', roiPct: 2, expectedProfit: 0, strategy: 'Buy YES Kalshi + NO PM',
        arbType: 'direct', totalStake: 99, daysToExpiry: 100, expiryAt: '2026-11-28T00:00:00.000Z' }],
    });

    expect(await persistence.getSavedMarketById(market.id)).toMatchObject({
      canonicalCurrentRoiPct: 2,
      canonicalCurrentProfit: null,
      canonicalCurrentStrategy: 'Buy YES Kalshi + NO PM',
      canonicalApyPct: null,
      canonicalApyUnavailableReason: 'current_profit_unavailable',
    });
  });

  it('recovers a pre-executionStatus persisted candidate instead of relabeling it No arb', async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'current-market-legacy-metrics-'));
    process.env.H2H_SQLITE_PATH = path.join(tempDir, 'edgefinder.db');
    process.env.H2H_SAVED_MARKETS_FILE = path.join(tempDir, 'saved-markets.json');
    vi.resetModules();
    const persistence = await import('./persistence');
    const market = await persistence.addSavedMarket({
      kalshiUrl: 'https://kalshi.com/markets/legacy', polymarketUrl: 'https://polymarket.com/event/legacy',
      eventTitle: 'Legacy persisted candidate', expiryDate: '2026-11-28T00:00:00.000Z',
    });
    const revision = await persistence.reserveSavedMarketPublication(market.id, 'scan');
    const roiPct = 2;
    const daysToExpiry = 100;
    const apyPct = (Math.pow(1 + roiPct / 100, 365 / daysToExpiry) - 1) * 100;

    await persistence.updateSavedMarketScanResult(market.id, {
      bestRoiPct: roiPct, bestProfit: 1, strategy: 'Buy YES Kalshi + NO PM', arbType: 'direct',
      outcomeCount: 1, matchedCount: 1, matchStatus: 'matched', kalshiCount: 1, pmCount: 1,
      scannedAt: '2026-08-20T13:00:00.000Z', publicationGeneration: revision,
      allArbs: [{ artist: 'Yes', roiPct, expectedProfit: 1, strategy: 'Buy YES Kalshi + NO PM',
        arbType: 'direct', totalStake: 99, apyPct, daysToExpiry, expiryAt: '2026-11-28T00:00:00.000Z' }],
    });

    expect(await persistence.getSavedMarketById(market.id)).toMatchObject({
      canonicalCurrentRoiPct: roiPct,
      canonicalCurrentProfit: 1,
      canonicalCurrentStrategy: 'Buy YES Kalshi + NO PM',
      canonicalApyPct: apyPct,
    });
  });

  it('publishes one executable revision atomically and preserves canonical values on a zero-candidate completion', async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'current-market-metrics-'));
    const dbPath = path.join(tempDir, 'edgefinder.db');
    process.env.H2H_SQLITE_PATH = dbPath;
    process.env.H2H_SAVED_MARKETS_FILE = path.join(tempDir, 'saved-markets.json');
    vi.resetModules();
    const persistence = await import('./persistence');

    const market = await persistence.addSavedMarket({
      kalshiUrl: 'https://kalshi.com/markets/bug-179',
      polymarketUrl: 'https://polymarket.com/event/bug-179',
      eventTitle: 'BUG-179 fixture',
      expiryDate: '2026-11-28T00:00:00.000Z',
    });
    const firstRevision = await persistence.reserveSavedMarketPublication(market.id, 'scan');
    const roiPct = 2;
    const daysToExpiry = 100;
    const apyPct = (Math.pow(1 + roiPct / 100, 365 / daysToExpiry) - 1) * 100;
    expect(await persistence.updateSavedMarketScanResult(market.id, {
      bestRoiPct: roiPct,
      bestProfit: 1,
      strategy: 'Buy YES Kalshi + NO PM',
      arbType: 'direct',
      outcomeCount: 1,
      matchedCount: 1,
      matchStatus: 'matched',
      kalshiCount: 1,
      pmCount: 1,
      scannedAt: '2026-08-20T13:00:00.000Z',
      publicationGeneration: firstRevision,
      allArbs: [{
        artist: 'Yes', roiPct, expectedProfit: 1, strategy: 'Buy YES Kalshi + NO PM',
        arbType: 'direct', totalStake: 99, executionStatus: 'executable', apyPct,
        daysToExpiry, expiryAt: '2026-11-28T00:00:00.000Z',
      }],
    })).toBe(true);

    expect(await persistence.getSavedMarketById(market.id)).toMatchObject({
      canonicalApyPct: apyPct,
      canonicalApyRevision: firstRevision,
      canonicalCurrentRoiPct: roiPct,
      canonicalCurrentProfit: 1,
      canonicalCurrentStrategy: 'Buy YES Kalshi + NO PM',
      canonicalCurrentDaysToExpiry: daysToExpiry,
      canonicalCurrentExpiryAt: '2026-11-28T00:00:00.000Z',
      canonicalCurrentRevision: firstRevision,
    });

    const failedRevision = await persistence.reserveSavedMarketPublication(market.id, 'scan');
    await persistence.reconcileSavedMarketMatchSummary(market.id, {
      matchedCount: 0,
      matchStatus: 'unavailable',
      matchError: 'Polymarket timeout',
      scannedAt: '2026-08-20T13:03:00.000Z',
      publicationGeneration: failedRevision,
    });
    expect(await persistence.getSavedMarketById(market.id)).toMatchObject({
      canonicalApyPct: apyPct,
      canonicalApyRevision: firstRevision,
      canonicalCurrentRoiPct: roiPct,
      canonicalCurrentRevision: firstRevision,
    });

    const secondRevision = await persistence.reserveSavedMarketPublication(market.id, 'scan');
    expect(await persistence.updateSavedMarketScanResult(market.id, {
      bestRoiPct: 0,
      bestProfit: 0,
      strategy: 'No arb',
      arbType: null,
      outcomeCount: 1,
      matchedCount: 0,
      matchStatus: 'confirmed_zero',
      kalshiCount: 1,
      pmCount: 1,
      scannedAt: '2026-08-20T13:05:00.000Z',
      publicationGeneration: secondRevision,
      allArbs: [],
    })).toBe(true);

    expect(await persistence.getSavedMarketById(market.id)).toMatchObject({
      canonicalApyPct: apyPct,
      canonicalApyRevision: firstRevision,
      canonicalCurrentRoiPct: roiPct,
      canonicalCurrentProfit: 1,
      canonicalCurrentStrategy: 'Buy YES Kalshi + NO PM',
      canonicalCurrentDaysToExpiry: daysToExpiry,
      canonicalCurrentExpiryAt: '2026-11-28T00:00:00.000Z',
      canonicalCurrentRevision: firstRevision,
      lastScanResult: {
        matchStatus: 'unavailable',
        matchError: expect.stringContaining('no_positive_candidate_persists_prior'),
        publicationGeneration: secondRevision,
      },
    });
    expect(await persistence.updateSavedMarketScanResult(market.id, {
      bestRoiPct: roiPct, bestProfit: 1, strategy: 'Buy YES Kalshi + NO PM', arbType: 'direct',
      outcomeCount: 1, matchedCount: 1, matchStatus: 'matched', kalshiCount: 1, pmCount: 1,
      scannedAt: '2026-08-20T13:01:00.000Z', publicationGeneration: firstRevision, allArbs: [],
    })).toBe(false);

    const oldWriter = createClient({ url: `file:${dbPath}` });
    await oldWriter.execute({
      sql: `UPDATE saved_markets SET canonical_apy_pct = 99, canonical_apy_revision = ? WHERE id = ?`,
      args: [secondRevision + 1, market.id],
    });
    const guarded = await oldWriter.execute({
      sql: `SELECT canonical_apy_pct, canonical_apy_unavailable_reason,
              canonical_current_strategy, canonical_current_revision
            FROM saved_markets WHERE id = ?`,
      args: [market.id],
    });
    const guardAlerts = await oldWriter.execute({
      sql: `SELECT COUNT(*) AS count FROM saved_market_metric_alerts
            WHERE market_id = ? AND reason = 'current_metric_invariant_failed'`,
      args: [market.id],
    });
    oldWriter.close();
    expect(guarded.rows[0]).toMatchObject({
      canonical_apy_pct: null,
      canonical_apy_unavailable_reason: 'current_metric_invariant_failed',
      canonical_current_strategy: 'No arb',
      canonical_current_revision: secondRevision + 1,
    });
    expect(Number(guardAlerts.rows[0]?.count ?? 0)).toBeGreaterThan(0);
  });

  it('clears canonical metrics when the first completed scan is a genuine zero-candidate scan', async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'current-market-first-zero-'));
    const dbPath = path.join(tempDir, 'edgefinder.db');
    process.env.H2H_SQLITE_PATH = dbPath;
    process.env.H2H_SAVED_MARKETS_FILE = path.join(tempDir, 'saved-markets.json');
    vi.resetModules();
    const persistence = await import('./persistence');

    const market = await persistence.addSavedMarket({
      kalshiUrl: 'https://kalshi.com/markets/bug-182-first-zero',
      polymarketUrl: 'https://polymarket.com/event/bug-182-first-zero',
      eventTitle: 'BUG-182 first-zero fixture',
      expiryDate: '2026-11-28T00:00:00.000Z',
    });
    const revision = await persistence.reserveSavedMarketPublication(market.id, 'scan');
    await persistence.updateSavedMarketScanResult(market.id, {
      bestRoiPct: 0,
      bestProfit: 0,
      strategy: 'No arb',
      arbType: null,
      outcomeCount: 1,
      matchedCount: 0,
      matchStatus: 'confirmed_zero',
      kalshiCount: 1,
      pmCount: 1,
      scannedAt: '2026-08-20T13:00:00.000Z',
      publicationGeneration: revision,
      allArbs: [],
    });

    expect(await persistence.getSavedMarketById(market.id)).toMatchObject({
      canonicalApyPct: null,
      canonicalApyUnavailableReason: 'no_canonical_arbitrage',
      canonicalApyRevision: revision,
      canonicalCurrentRoiPct: null,
      canonicalCurrentProfit: null,
      canonicalCurrentStrategy: 'No arb',
      canonicalCurrentDaysToExpiry: null,
      canonicalCurrentExpiryAt: null,
      canonicalCurrentRevision: revision,
    });
  });

  it('preserves prior canonical metrics when a matched scan produces no positive candidate', async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'current-market-matched-no-positive-'));
    const dbPath = path.join(tempDir, 'edgefinder.db');
    process.env.H2H_SQLITE_PATH = dbPath;
    process.env.H2H_SAVED_MARKETS_FILE = path.join(tempDir, 'saved-markets.json');
    vi.resetModules();
    const persistence = await import('./persistence');

    const market = await persistence.addSavedMarket({
      kalshiUrl: 'https://kalshi.com/markets/bug-182-no-positive',
      polymarketUrl: 'https://polymarket.com/event/bug-182-no-positive',
      eventTitle: 'BUG-182 no-positive fixture',
      expiryDate: '2026-11-28T00:00:00.000Z',
    });
    const firstRevision = await persistence.reserveSavedMarketPublication(market.id, 'scan');
    const roiPct = 2;
    const daysToExpiry = 100;
    const apyPct = (Math.pow(1 + roiPct / 100, 365 / daysToExpiry) - 1) * 100;
    await persistence.updateSavedMarketScanResult(market.id, {
      bestRoiPct: roiPct,
      bestProfit: 1,
      strategy: 'Buy YES Kalshi + NO PM',
      arbType: 'direct',
      outcomeCount: 1,
      matchedCount: 1,
      matchStatus: 'matched',
      kalshiCount: 1,
      pmCount: 1,
      scannedAt: '2026-08-20T13:00:00.000Z',
      publicationGeneration: firstRevision,
      allArbs: [{
        artist: 'Yes', roiPct, expectedProfit: 1, strategy: 'Buy YES Kalshi + NO PM',
        arbType: 'direct', totalStake: 99, executionStatus: 'executable', apyPct,
        daysToExpiry, expiryAt: '2026-11-28T00:00:00.000Z',
      }],
    });

    const secondRevision = await persistence.reserveSavedMarketPublication(market.id, 'scan');
    expect(await persistence.updateSavedMarketScanResult(market.id, {
      bestRoiPct: 0,
      bestProfit: 0,
      strategy: 'No arb',
      arbType: null,
      outcomeCount: 1,
      matchedCount: 1,
      matchStatus: 'matched',
      kalshiCount: 1,
      pmCount: 1,
      scannedAt: '2026-08-20T13:05:00.000Z',
      publicationGeneration: secondRevision,
      allArbs: [],
    })).toBe(true);

    const saved = await persistence.getSavedMarketById(market.id);
    expect(saved).toMatchObject({
      canonicalApyPct: apyPct,
      canonicalApyRevision: firstRevision,
      canonicalCurrentRoiPct: roiPct,
      canonicalCurrentProfit: 1,
      canonicalCurrentStrategy: 'Buy YES Kalshi + NO PM',
      canonicalCurrentDaysToExpiry: daysToExpiry,
      canonicalCurrentExpiryAt: '2026-11-28T00:00:00.000Z',
      canonicalCurrentRevision: firstRevision,
      lastScanResult: {
        matchStatus: 'unavailable',
        matchError: expect.stringContaining('no_positive_candidate_persists_prior'),
        publicationGeneration: secondRevision,
      },
    });
  });

  it('preserves a prior executable revision when a matched publisher supplies only non-executable evidence', async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'current-market-incomplete-replacement-'));
    process.env.H2H_SQLITE_PATH = path.join(tempDir, 'edgefinder.db');
    process.env.H2H_SAVED_MARKETS_FILE = path.join(tempDir, 'saved-markets.json');
    vi.resetModules();
    const persistence = await import('./persistence');
    const market = await persistence.addSavedMarket({
      kalshiUrl: 'https://kalshi.com/markets/incomplete-replacement',
      polymarketUrl: 'https://polymarket.com/event/incomplete-replacement',
      eventTitle: 'Incomplete replacement fixture',
      expiryDate: '2026-11-28T00:00:00.000Z',
    });
    const roiPct = 2;
    const daysToExpiry = 100;
    const apyPct = (Math.pow(1 + roiPct / 100, 365 / daysToExpiry) - 1) * 100;
    const firstRevision = await persistence.reserveSavedMarketPublication(market.id, 'scan');
    expect(await persistence.updateSavedMarketScanResult(market.id, {
      bestRoiPct: roiPct, bestProfit: 1, strategy: 'Buy YES Kalshi + NO PM', arbType: 'direct',
      outcomeCount: 1, matchedCount: 1, matchStatus: 'matched', kalshiCount: 1, pmCount: 1,
      scannedAt: '2026-08-20T13:00:00.000Z', publicationGeneration: firstRevision,
      allArbs: [{ artist: 'Yes', roiPct, expectedProfit: 1, strategy: 'Buy YES Kalshi + NO PM',
        arbType: 'direct', totalStake: 99, executionStatus: 'executable', apyPct,
        daysToExpiry, expiryAt: '2026-11-28T00:00:00.000Z' }],
    })).toBe(true);

    const failedRevision = await persistence.reserveSavedMarketPublication(market.id, 'scan');
    expect(await persistence.updateSavedMarketScanResult(market.id, {
      bestRoiPct: 12.5, bestProfit: 0, strategy: 'Buy YES Kalshi + NO PM', arbType: 'direct',
      outcomeCount: 1, matchedCount: 1, matchStatus: 'matched', kalshiCount: 1, pmCount: 1,
      scannedAt: '2026-08-20T13:05:00.000Z', publicationGeneration: failedRevision,
      allArbs: [{ artist: 'Yes', roiPct: 12.5, expectedProfit: 0, strategy: 'Buy YES Kalshi + NO PM',
        arbType: 'direct', totalStake: 0, executionStatus: 'non_executable',
        apyPct: null, daysToExpiry, expiryAt: '2026-11-28T00:00:00.000Z' }],
    })).toBe(true);

    expect(await persistence.getSavedMarketById(market.id)).toMatchObject({
      canonicalCurrentRoiPct: roiPct,
      canonicalCurrentProfit: 1,
      canonicalCurrentRevision: firstRevision,
      canonicalApyPct: apyPct,
      canonicalApyRevision: firstRevision,
      lastScanResult: {
        matchStatus: 'unavailable',
        matchError: expect.stringContaining('executable_candidate_unavailable'),
        scannedAt: '2026-08-20T13:00:00.000Z',
        publicationGeneration: failedRevision,
      },
    });
  });

  it('reconciles and alerts on a persisted APY-only row without reading historical logs', async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'current-market-reconcile-'));
    const dbPath = path.join(tempDir, 'edgefinder.db');
    process.env.H2H_SQLITE_PATH = dbPath;
    process.env.H2H_SAVED_MARKETS_FILE = path.join(tempDir, 'saved-markets.json');
    vi.resetModules();
    const persistence = await import('./persistence');
    const market = await persistence.addSavedMarket({
      kalshiUrl: 'https://kalshi.com/markets/stale', polymarketUrl: 'https://polymarket.com/event/stale',
      eventTitle: 'NCAA Football: 2027 National Champion', expiryDate: null,
    });
    const revision = await persistence.reserveSavedMarketPublication(market.id, 'scan');
    await persistence.updateSavedMarketScanResult(market.id, {
      bestRoiPct: 0, bestProfit: 0, strategy: 'No arb', arbType: null,
      outcomeCount: 1, matchedCount: 1, matchStatus: 'matched', kalshiCount: 1, pmCount: 1,
      scannedAt: '2026-08-20T13:00:00.000Z', publicationGeneration: revision, allArbs: [],
    });

    const db = createClient({ url: `file:${dbPath}` });
    await db.execute('DROP TRIGGER saved_market_apy_invariant_guard');
    await db.execute('DROP TRIGGER saved_market_metric_revision_guard');
    await db.execute({
      sql: `UPDATE saved_markets SET canonical_apy_pct = 30.5,
              canonical_apy_unavailable_reason = NULL, canonical_current_roi_pct = NULL,
              canonical_current_strategy = 'No arb', canonical_current_days_to_expiry = NULL
            WHERE id = ?`,
      args: [market.id],
    });
    expect(await persistence.reconcileSavedMarketMatchSummaries()).toBeGreaterThan(0);
    const alert = await db.execute({
      sql: 'SELECT reason, reconciled FROM saved_market_metric_alerts WHERE market_id = ?', args: [market.id],
    });
    db.close();

    expect(await persistence.getSavedMarketById(market.id)).toMatchObject({
      canonicalApyPct: null,
      canonicalCurrentRoiPct: null,
      canonicalCurrentStrategy: 'No arb',
    });
    expect(alert.rows[0]).toMatchObject({ reason: 'no_canonical_arbitrage', reconciled: 1 });
  });
});
