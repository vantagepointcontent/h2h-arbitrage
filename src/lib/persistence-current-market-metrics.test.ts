import { afterEach, describe, expect, it, vi } from 'vitest';
import { createClient } from '@libsql/client';
import type { InStatement } from '@libsql/core/api';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { calculateApyPctFromDays } from './scan-apy';

let tempDir = '';

afterEach(() => {
  delete process.env.H2H_SQLITE_PATH;
  delete process.env.H2H_SAVED_MARKETS_FILE;
  vi.doUnmock('@libsql/client');
  vi.resetModules();
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('BUG-179 canonical current-market metric projection', () => {
  it('derives and persists APY from canonical ROI and expiry when optional profit is unavailable', async () => {
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
    const daysToExpiry = (
      Date.parse('2026-11-28T00:00:00.000Z') - Date.parse('2026-08-20T13:00:00.000Z')
    ) / 86_400_000;

    const persisted = await persistence.getSavedMarketById(market.id);
    expect(persisted).toMatchObject({
      canonicalCurrentRoiPct: 2,
      canonicalCurrentProfit: null,
      canonicalCurrentStrategy: 'Buy YES Kalshi + NO PM',
      canonicalApyUnavailableReason: null,
      canonicalCurrentDaysToExpiry: daysToExpiry,
      canonicalCurrentExpiryAt: '2026-11-28T00:00:00.000Z',
    });
    expect(persisted?.canonicalApyPct).toBeCloseTo((Math.pow(1.02, 365 / daysToExpiry) - 1) * 100, 12);
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
    const daysToExpiry = (
      Date.parse('2026-11-28T00:00:00.000Z') - Date.parse('2026-08-20T13:00:00.000Z')
    ) / 86_400_000;
    const apyPct = calculateApyPctFromDays(roiPct, daysToExpiry)!;

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
    const daysToExpiry = (
      Date.parse('2026-11-28T00:00:00.000Z') - Date.parse('2026-08-20T13:00:00.000Z')
    ) / 86_400_000;
    const apyPct = calculateApyPctFromDays(roiPct, daysToExpiry)!;
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
    const daysToExpiry = (
      Date.parse('2026-11-28T00:00:00.000Z') - Date.parse('2026-08-20T13:00:00.000Z')
    ) / 86_400_000;
    const apyPct = calculateApyPctFromDays(roiPct, daysToExpiry)!;
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

    expect(await persistence.reconcileSavedMarketMatchSummaries()).toBe(0);
    expect(await persistence.getSavedMarketById(market.id)).toMatchObject({
      canonicalApyPct: apyPct,
      canonicalApyRevision: firstRevision,
      canonicalApyObservedAt: '2026-08-20T13:00:00.000Z',
      canonicalCurrentRoiPct: roiPct,
      canonicalCurrentProfit: 1,
      canonicalCurrentRevision: firstRevision,
      lastScanResult: {
        matchStatus: 'unavailable',
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
    const daysToExpiry = (
      Date.parse('2026-11-28T00:00:00.000Z') - Date.parse('2026-08-20T13:00:00.000Z')
    ) / 86_400_000;
    const apyPct = calculateApyPctFromDays(roiPct, daysToExpiry)!;
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

  it('backfills APY from the persisted ROI observation while preserving unavailable match status', async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'current-market-apy-backfill-'));
    const dbPath = path.join(tempDir, 'edgefinder.db');
    process.env.H2H_SQLITE_PATH = dbPath;
    process.env.H2H_SAVED_MARKETS_FILE = path.join(tempDir, 'saved-markets.json');
    vi.resetModules();
    const persistence = await import('./persistence');
    const expiryAt = '2026-11-28T00:00:00.000Z';
    const observedAt = '2026-08-20T13:00:00.000Z';
    const roiPct = 2;
    const market = await persistence.addSavedMarket({
      kalshiUrl: 'https://kalshi.com/markets/bug-186-backfill',
      polymarketUrl: 'https://polymarket.com/event/bug-186-backfill',
      eventTitle: 'BUG-186 backfill fixture',
      expiryDate: expiryAt,
    });
    const revision = await persistence.reserveSavedMarketPublication(market.id, 'scan');
    await persistence.updateSavedMarketScanResult(market.id, {
      bestRoiPct: roiPct, bestProfit: 1, strategy: 'Buy YES Kalshi + NO PM', arbType: 'direct',
      outcomeCount: 1, matchedCount: 1, matchStatus: 'matched', kalshiCount: 1, pmCount: 1,
      scannedAt: observedAt, publicationGeneration: revision,
      allArbs: [{ artist: 'Yes', roiPct, expectedProfit: 1, strategy: 'Buy YES Kalshi + NO PM',
        arbType: 'direct', executionStatus: 'executable', expiryAt }],
    });

    const db = createClient({ url: `file:${dbPath}` });
    await db.execute({
      sql: `UPDATE saved_markets SET
              canonical_apy_pct = NULL,
              canonical_apy_unavailable_reason = 'current_candidate_non_executable',
              last_scan_result = json_set(last_scan_result,
                '$.matchStatus', 'unavailable',
                '$.matchError', 'Current venue depth is unavailable')
            WHERE id = ?`,
      args: [market.id],
    });
    db.close();

    expect(await persistence.reconcileSavedMarketMatchSummaries()).toBeGreaterThan(0);
    const persisted = await persistence.getSavedMarketById(market.id);
    const daysToExpiry = (Date.parse(expiryAt) - Date.parse(observedAt)) / 86_400_000;
    expect(persisted).toMatchObject({
      canonicalApyUnavailableReason: null,
      canonicalApyObservedAt: observedAt,
      canonicalApyRevision: revision,
      canonicalCurrentRoiPct: roiPct,
      canonicalCurrentExpiryAt: expiryAt,
      canonicalCurrentRevision: revision,
      lastScanResult: {
        matchStatus: 'unavailable',
        matchError: 'Current venue depth is unavailable',
      },
    });
    expect(persisted?.canonicalApyPct).toBeCloseTo(calculateApyPctFromDays(roiPct, daysToExpiry)!, 12);
  });

  it('recomputes APY from the persisted ROI observation when the row expiry changes', async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'current-market-expiry-update-'));
    process.env.H2H_SQLITE_PATH = path.join(tempDir, 'edgefinder.db');
    process.env.H2H_SAVED_MARKETS_FILE = path.join(tempDir, 'saved-markets.json');
    vi.resetModules();
    const persistence = await import('./persistence');
    const observedAt = '2026-08-20T13:00:00.000Z';
    const initialExpiry = '2026-11-28T00:00:00.000Z';
    const updatedExpiry = '2027-02-01T00:00:00.000Z';
    const roiPct = 2;
    const market = await persistence.addSavedMarket({
      kalshiUrl: 'https://kalshi.com/markets/bug-186-expiry-update',
      polymarketUrl: 'https://polymarket.com/event/bug-186-expiry-update',
      eventTitle: 'BUG-186 expiry update fixture',
      expiryDate: initialExpiry,
    });
    const revision = await persistence.reserveSavedMarketPublication(market.id, 'scan');
    await persistence.updateSavedMarketScanResult(market.id, {
      bestRoiPct: roiPct, bestProfit: 1, strategy: 'Buy YES Kalshi + NO PM', arbType: 'direct',
      outcomeCount: 1, matchedCount: 1, matchStatus: 'matched', kalshiCount: 1, pmCount: 1,
      scannedAt: observedAt, publicationGeneration: revision,
      allArbs: [{ artist: 'Yes', roiPct, expectedProfit: 1, strategy: 'Buy YES Kalshi + NO PM',
        arbType: 'direct', executionStatus: 'executable', expiryAt: initialExpiry }],
    });

    expect(await persistence.updateSavedMarket(market.id, { expiryDate: updatedExpiry })).toBe(true);

    const daysToExpiry = (Date.parse(updatedExpiry) - Date.parse(observedAt)) / 86_400_000;
    const persisted = await persistence.getSavedMarketById(market.id);
    expect(persisted).toMatchObject({
      expiryDate: updatedExpiry,
      canonicalApyUnavailableReason: null,
      canonicalApyObservedAt: observedAt,
      canonicalApyRevision: revision,
      canonicalCurrentRoiPct: roiPct,
      canonicalCurrentDaysToExpiry: daysToExpiry,
      canonicalCurrentExpiryAt: updatedExpiry,
      canonicalCurrentRevision: revision,
    });
    expect(persisted?.canonicalApyPct).toBeCloseTo(calculateApyPctFromDays(roiPct, daysToExpiry)!, 12);
  });

  it('recovers a missing linked-market expiry with durable provenance and recomputes retained APY atomically', async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'current-market-expiry-recovery-'));
    process.env.H2H_SQLITE_PATH = path.join(tempDir, 'edgefinder.db');
    process.env.H2H_SAVED_MARKETS_FILE = path.join(tempDir, 'saved-markets.json');
    vi.resetModules();
    const persistence = await import('./persistence');
    const observedAt = '2026-08-22T11:09:07.335Z';
    const expiryAt = '2027-01-01T04:59:00Z';
    const roiPct = 3.196;
    const market = await persistence.addSavedMarket({
      kalshiUrl: 'https://kalshi.com/markets/kxarrest/arrests/kxarrest-27jan',
      polymarketUrl: 'https://polymarket.com/event/who-will-be-arrested-before-2027',
      eventTitle: 'Who will be arrested before 2027?',
      expiryDate: null,
    });
    const revision = await persistence.reserveSavedMarketPublication(market.id, 'scan');
    await persistence.updateSavedMarketScanResult(market.id, {
      bestRoiPct: roiPct, bestProfit: 1, strategy: 'Buy YES PM + NO Kalshi', arbType: 'direct',
      outcomeCount: 1, matchedCount: 1, matchStatus: 'matched', kalshiCount: 1, pmCount: 1,
      scannedAt: observedAt, publicationGeneration: revision,
      allArbs: [{ artist: 'Anthony Fauci', roiPct, expectedProfit: 1, strategy: 'Buy YES PM + NO Kalshi',
        arbType: 'direct', executionStatus: 'executable', expiryAt: null }],
    });

    expect(await persistence.recoverSavedMarketExpiry(market.id, {
      expiryAt,
      source: 'kalshi_market_close_time',
      sourceId: 'KXARREST-27JAN',
      observedAt: '2026-08-24T22:17:00.000Z',
    })).toBe(true);

    const daysToExpiry = (Date.parse(expiryAt) - Date.parse(observedAt)) / 86_400_000;
    const persisted = await persistence.getSavedMarketById(market.id);
    expect(persisted).toMatchObject({
      expiryDate: expiryAt,
      expirySource: 'kalshi_market_close_time',
      expirySourceId: 'KXARREST-27JAN',
      expiryObservedAt: '2026-08-24T22:17:00.000Z',
      canonicalApyUnavailableReason: null,
      canonicalCurrentDaysToExpiry: daysToExpiry,
      canonicalCurrentExpiryAt: expiryAt,
      canonicalCurrentRevision: revision,
      canonicalApyRevision: revision,
    });
    expect(persisted?.canonicalApyPct).toBeCloseTo(calculateApyPctFromDays(roiPct, daysToExpiry)!, 12);
  });

  it('does not overwrite a valid linked-market expiry with null', async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'current-market-expiry-null-overwrite-'));
    process.env.H2H_SQLITE_PATH = path.join(tempDir, 'edgefinder.db');
    process.env.H2H_SAVED_MARKETS_FILE = path.join(tempDir, 'saved-markets.json');
    vi.resetModules();
    const persistence = await import('./persistence');
    const expiryAt = '2027-01-01T04:59:00Z';
    const market = await persistence.addSavedMarket({
      kalshiUrl: 'https://kalshi.com/markets/kxevent/event/kxevent-27jan',
      polymarketUrl: 'https://polymarket.com/event/event-before-2027',
      eventTitle: 'Valid linked market',
      expiryDate: expiryAt,
    });

    expect(await persistence.updateSavedMarket(market.id, { expiryDate: null })).toBe(false);
    expect(await persistence.getSavedMarketById(market.id)).toMatchObject({ expiryDate: expiryAt });
  });

  it('keeps APY expiry provenance coherent when an existing market is upserted', async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'current-market-expiry-upsert-'));
    process.env.H2H_SQLITE_PATH = path.join(tempDir, 'edgefinder.db');
    process.env.H2H_SAVED_MARKETS_FILE = path.join(tempDir, 'saved-markets.json');
    vi.resetModules();
    const persistence = await import('./persistence');
    const observedAt = '2026-08-20T13:00:00.000Z';
    const initialExpiry = '2026-11-28T00:00:00.000Z';
    const updatedExpiry = '2027-02-01T00:00:00.000Z';
    const roiPct = 2;
    const market = await persistence.addSavedMarket({
      kalshiUrl: 'https://kalshi.com/markets/bug-186-expiry-upsert',
      polymarketUrl: 'https://polymarket.com/event/bug-186-expiry-upsert',
      eventTitle: 'BUG-186 expiry upsert fixture',
      expiryDate: initialExpiry,
    });
    const revision = await persistence.reserveSavedMarketPublication(market.id, 'scan');
    await persistence.updateSavedMarketScanResult(market.id, {
      bestRoiPct: roiPct, bestProfit: 1, strategy: 'Buy YES Kalshi + NO PM', arbType: 'direct',
      outcomeCount: 1, matchedCount: 1, matchStatus: 'matched', kalshiCount: 1, pmCount: 1,
      scannedAt: observedAt, publicationGeneration: revision,
      allArbs: [{ artist: 'Yes', roiPct, expectedProfit: 1, strategy: 'Buy YES Kalshi + NO PM',
        arbType: 'direct', executionStatus: 'executable', expiryAt: initialExpiry }],
    });

    await persistence.upsertSavedMarket({
      kalshiUrl: market.kalshiUrl,
      polymarketUrl: market.polymarketUrl,
      eventTitle: market.eventTitle,
      expiryDate: updatedExpiry,
    });
    // PredictionHunt/import payloads may omit expiry after a canonical linked
    // source was recovered. Sparse null must not erase that authoritative row.
    await persistence.upsertSavedMarket({
      kalshiUrl: market.kalshiUrl,
      polymarketUrl: market.polymarketUrl,
      eventTitle: market.eventTitle,
      expiryDate: null,
    });

    const daysToExpiry = (Date.parse(updatedExpiry) - Date.parse(observedAt)) / 86_400_000;
    const persisted = await persistence.getSavedMarketById(market.id);
    expect(persisted).toMatchObject({
      expiryDate: updatedExpiry,
      canonicalCurrentDaysToExpiry: daysToExpiry,
      canonicalCurrentExpiryAt: updatedExpiry,
    });
    expect(persisted?.canonicalApyPct).toBeCloseTo(calculateApyPctFromDays(roiPct, daysToExpiry)!, 12);
  });

  it('does not publish APY from a stale expiry when expiry changes after reconciliation reads', async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'current-market-expiry-race-'));
    const dbPath = path.join(tempDir, 'edgefinder.db');
    process.env.H2H_SQLITE_PATH = dbPath;
    process.env.H2H_SAVED_MARKETS_FILE = path.join(tempDir, 'saved-markets.json');
    let interceptReconciliationWrite = false;
    let updateExpiry: (() => Promise<void>) | null = null;
    vi.doMock('@libsql/client', async (importOriginal) => {
      const actual = await importOriginal<typeof import('@libsql/client')>();
      return {
        ...actual,
        createClient(options: Parameters<typeof actual.createClient>[0]) {
          const client = actual.createClient(options);
          const execute = client.execute.bind(client);
          client.execute = (async (statement: InStatement | string) => {
            const sql = typeof statement === 'string' ? statement : statement.sql;
            if (interceptReconciliationWrite
              && sql.includes('UPDATE saved_markets SET\n              canonical_apy_pct = ?')) {
              interceptReconciliationWrite = false;
              await updateExpiry?.();
            }
            return typeof statement === 'string' ? execute(statement) : execute(statement);
          }) as typeof client.execute;
          return client;
        },
      };
    });
    vi.resetModules();
    const persistence = await import('./persistence');
    const observedAt = '2026-08-20T13:00:00.000Z';
    const initialExpiry = '2026-11-28T00:00:00.000Z';
    const updatedExpiry = '2027-02-01T00:00:00.000Z';
    const roiPct = 2;
    const market = await persistence.addSavedMarket({
      kalshiUrl: 'https://kalshi.com/markets/bug-186-expiry-race',
      polymarketUrl: 'https://polymarket.com/event/bug-186-expiry-race',
      eventTitle: 'BUG-186 expiry race fixture',
      expiryDate: initialExpiry,
    });
    const revision = await persistence.reserveSavedMarketPublication(market.id, 'scan');
    await persistence.updateSavedMarketScanResult(market.id, {
      bestRoiPct: roiPct, bestProfit: 1, strategy: 'Buy YES Kalshi + NO PM', arbType: 'direct',
      outcomeCount: 1, matchedCount: 1, matchStatus: 'matched', kalshiCount: 1, pmCount: 1,
      scannedAt: observedAt, publicationGeneration: revision,
      allArbs: [{ artist: 'Yes', roiPct, expectedProfit: 1, strategy: 'Buy YES Kalshi + NO PM',
        arbType: 'direct', executionStatus: 'executable', expiryAt: initialExpiry }],
    });
    const db = createClient({ url: `file:${dbPath}` });
    await db.execute({
      sql: `UPDATE saved_markets SET canonical_apy_pct = NULL,
              canonical_apy_unavailable_reason = 'current_candidate_non_executable',
              last_scan_result = json_set(last_scan_result, '$.matchStatus', 'unavailable')
            WHERE id = ?`,
      args: [market.id],
    });
    db.close();

    updateExpiry = async () => {
      expect(await persistence.updateSavedMarket(market.id, { expiryDate: updatedExpiry })).toBe(true);
    };
    interceptReconciliationWrite = true;
    await persistence.reconcileSavedMarketMatchSummaries();

    const daysToExpiry = (Date.parse(updatedExpiry) - Date.parse(observedAt)) / 86_400_000;
    const persisted = await persistence.getSavedMarketById(market.id);
    expect(interceptReconciliationWrite).toBe(false);
    expect(persisted).toMatchObject({
      expiryDate: updatedExpiry,
      canonicalApyUnavailableReason: null,
      canonicalCurrentDaysToExpiry: daysToExpiry,
      canonicalCurrentExpiryAt: updatedExpiry,
    });
    expect(persisted?.canonicalApyPct).toBeCloseTo(calculateApyPctFromDays(roiPct, daysToExpiry)!, 12);
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
