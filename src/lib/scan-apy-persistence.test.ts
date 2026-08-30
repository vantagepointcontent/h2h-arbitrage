import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createClient } from '@libsql/client';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const prefix = `test-scan-apy-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scan-apy-'));
const dbPath = path.join(tempDir, 'edgefinder.db');
const db = createClient({ url: `file:${dbPath}` });
let persistence: typeof import('./persistence');

beforeAll(async () => {
  await db.execute(`CREATE TABLE scan_results (
    id INTEGER PRIMARY KEY AUTOINCREMENT, market_id TEXT NOT NULL,
    best_roi_pct REAL NOT NULL DEFAULT 0, best_profit REAL NOT NULL DEFAULT 0,
    strategy TEXT NOT NULL DEFAULT '', outcome_count INTEGER NOT NULL DEFAULT 0,
    matched_count INTEGER NOT NULL DEFAULT 0, kalshi_count INTEGER NOT NULL DEFAULT 0,
    pm_count INTEGER NOT NULL DEFAULT 0, positive_arb_count INTEGER NOT NULL DEFAULT 0,
    total_stake REAL NOT NULL DEFAULT 0, scanned_at TEXT NOT NULL, raw_result TEXT,
    market_title TEXT, kalshi_url TEXT, polymarket_url TEXT, arb_type TEXT,
    expiry_at TEXT, days_to_expiry REAL, apy_pct REAL, apy_unavailable_reason TEXT
  )`);
  await db.execute(`CREATE TABLE saved_markets (
    id TEXT PRIMARY KEY, kalshi_url TEXT NOT NULL, polymarket_url TEXT NOT NULL,
    event_title TEXT NOT NULL DEFAULT '', category TEXT, created_at TEXT NOT NULL,
    expiry_date TEXT, favorite INTEGER NOT NULL DEFAULT 0, last_scan_result TEXT, live_result TEXT
  )`);
  await db.execute({
    sql: `INSERT INTO saved_markets
      (id, kalshi_url, polymarket_url, event_title, created_at, expiry_date, last_scan_result, live_result)
      VALUES (?, '', '', 'Current saved market', ?, ?, ?, ?)`,
    args: [
      `${prefix}-saved`,
      '2026-08-14T11:02:35.000Z',
      '2026-10-24T11:02:35.000Z',
      JSON.stringify({
        scannedAt: '2026-08-14T11:02:35.000Z', bestRoiPct: 1, bestProfit: 1,
        strategy: 'Buy YES Kalshi + NO PM', matchedCount: 1,
        allArbs: [
          { artist: 'A', roiPct: 1, expectedProfit: 1, strategy: 'Buy YES Kalshi + NO PM', apyPct: null, outcomeApy: { unavailableReason: 'unaligned_resolution_rules' } },
          {
            artist: 'Internal PM', roiPct: 1, expectedProfit: 1,
            strategy: 'Same-platform YES+NO Polymarket: Internal PM', apyPct: null,
            outcomeApy: {
              observedAt: '2026-08-14T11:02:35.000Z', unavailableReason: 'unaligned_resolution_rules',
              scenarioA: { winner: 'polymarket' }, scenarioB: { winner: 'polymarket' },
              kalshi: null,
              polymarket: { expectedAt: '2026-10-24T11:02:35.000Z', contractualAt: null, expectedSource: 'polymarket.event.endDate', contractualSource: null, earlyDetermination: null },
            },
          },
        ],
      }),
      JSON.stringify({
        updatedAt: '2026-08-14T11:02:35.000Z', bestRoiPct: 2, bestProfit: 2,
        strategy: 'Buy YES Kalshi + NO PM', matchedCount: 1,
        allArbs: [{ artist: 'Live A', roiPct: 2, expectedProfit: 2, strategy: 'Buy YES Kalshi + NO PM', apyPct: null }],
      }),
    ],
  });
  await db.execute({
    sql: `INSERT INTO scan_results
      (market_id, best_roi_pct, best_profit, strategy, positive_arb_count, scanned_at, raw_result)
      VALUES (?, ?, ?, ?, ?, ?, ?)`,
    args: [`${prefix}-legacy-valid`, 2.5, 12.5, 'Buy YES Kalshi + NO PM', 1, '2026-08-12T12:00:00.000Z', JSON.stringify({ expiryDate: '2026-08-13T00:00:00.000Z' })],
  });
  await db.execute({
    sql: `INSERT INTO scan_results
      (market_id, best_roi_pct, scanned_at, raw_result)
      VALUES (?, ?, ?, ?)`,
    args: [`${prefix}-legacy-missing`, 4, '2026-08-12T12:00:00.000Z', null],
  });
  await db.execute({
    sql: `INSERT INTO scan_results
      (market_id, best_roi_pct, best_profit, strategy, positive_arb_count, scanned_at,
       expiry_at, days_to_expiry, apy_pct, apy_unavailable_reason)
      VALUES (?, 7, 7, 'Buy YES Kalshi + NO PM', 1, ?, ?, 30, 123.456, NULL)`,
    args: [`${prefix}-immutable`, '2026-08-12T12:00:00.000Z', '2026-09-11T12:00:00.000Z'],
  });

  process.env.H2H_SQLITE_PATH = dbPath;
  vi.resetModules();
  persistence = await import('./persistence');
});

afterAll(async () => {
  db.close();
  delete process.env.H2H_SQLITE_PATH;
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('scan-time APY persistence', () => {
  it('backfills current saved opportunities from persisted ROI and canonical expiry without venue calls', async () => {
    const saved = (await persistence.getSavedMarkets()).find((market) => market.id === `${prefix}-saved`);
    const opportunity = saved?.lastScanResult?.allArbs?.[0];
    expect(opportunity?.daysToExpiry).toBe(71);
    expect(opportunity?.apyPct).toBeCloseTo((1.01 ** (365 / 71) - 1) * 100, 10);
    expect(opportunity?.apyUnavailableReason).toBeNull();
    expect(opportunity?.expiryAt).toBe('2026-10-24T11:02:35.000Z');
    expect(opportunity?.outcomeApy?.unavailableReason).not.toBe('unaligned_resolution_rules');
    expect(saved?.lastScanResult?.allArbs?.[1]?.outcomeApy?.scenarioA.winner).toBe('polymarket');
    expect(saved?.lastScanResult?.allArbs?.[1]?.outcomeApy?.scenarioB.winner).toBe('polymarket');
  });

  it('backfills eligible historical rows and records explicit unavailable reasons', async () => {
    const { rows } = await persistence.queryScanHistory({ limit: 500 });
    const valid = rows.find((row) => row.market_id === `${prefix}-legacy-valid`);
    const missing = rows.find((row) => row.market_id === `${prefix}-legacy-missing`);
    const immutable = rows.find((row) => row.market_id === `${prefix}-immutable`);

    const legacyUuids = [valid, missing, immutable].map((row) => String(row?.log_uuid));
    expect(legacyUuids).toHaveLength(new Set(legacyUuids).size);
    for (const logUuid of legacyUuids) expect(logUuid).toMatch(/^(?=.*[A-Z])(?=.*\d)[A-Z0-9]{6}$/);

    expect(Number(valid!.apy_pct) / ((1.025 ** 730 - 1) * 100)).toBeCloseTo(1, 12);
    expect(valid!.days_to_expiry).toBe(0.5);
    expect(valid!.expiry_at).toBe('2026-08-13T00:00:00.000Z');
    expect(valid!.apy_unavailable_reason).toBeNull();
    expect(missing!.apy_pct).toBeNull();
    expect(missing!.apy_unavailable_reason).toBe('missing_expiry');
    expect(immutable!.apy_pct).toBe(123.456);
    expect(immutable!.days_to_expiry).toBe(30);
  });

  it('persists a stable snapshot from exact scan and expiry timestamps', async () => {
    const saved = await persistence.saveScanResult(`${prefix}-new-valid`, {
      bestRoiPct: 3,
      bestProfit: 10,
      strategy: 'Buy YES Kalshi + NO PM',
      outcomeCount: 1,
      matchedCount: 1,
      kalshiCount: 1,
      pmCount: 1,
      positiveArbCount: 1,
      scannedAt: '2026-08-12T12:00:00.000Z',
      expiryAt: '2026-08-14T00:00:00.000Z',
    });

    const first = (await persistence.queryScanHistory({ limit: 500 })).rows.find((row) => row.id === saved.id);
    expect(Number(first!.apy_pct) / ((1.03 ** (365 / 1.5) - 1) * 100)).toBeCloseTo(1, 12);
    expect(first!.days_to_expiry).toBe(1.5);

    const second = (await persistence.queryScanHistory({ limit: 500 })).rows.find((row) => row.id === saved.id);
    expect(second!.apy_pct).toBe(first!.apy_pct);
    expect(second!.days_to_expiry).toBe(first!.days_to_expiry);
  });

  it('persists canonical APY from expiry even when venue settlement scenarios differ', async () => {
    const outcomeApy = {
      observedAt: '2026-08-14T11:02:35.000Z', apyPct: null, unavailableReason: 'outcome_contingent' as const, kalshi: null, polymarket: null,
      scenarioA: { label: 'scenario_a' as const, winner: 'kalshi' as const, roiPct: 1, apyPct: 2.5, settlementAt: '2027-01-04T15:00:00.000Z', daysToSettlement: 143, timingSource: 'kalshi.market.expected_expiration_time' as const, unavailableReason: null },
      scenarioB: { label: 'scenario_b' as const, winner: 'polymarket' as const, roiPct: 1, apyPct: 4.5, settlementAt: '2026-11-03T00:00:00.000Z', daysToSettlement: 80, timingSource: 'polymarket.event.endDate' as const, unavailableReason: null },
    };
    const saved = await persistence.saveScanResult(`${prefix}-outcome-contingent`, {
      bestRoiPct: 1, bestProfit: 1, strategy: 'Buy YES Kalshi + NO PM', arbType: 'direct', outcomeCount: 1,
      matchedCount: 1, kalshiCount: 1, pmCount: 1, positiveArbCount: 1, scannedAt: outcomeApy.observedAt,
      expiryAt: '2026-10-24T11:02:35.000Z', outcomeApy, raw: { outcomeApy },
    });
    const row = (await persistence.queryScanHistory({ limit: 500 })).rows.find((candidate) => candidate.id === saved.id);
    expect(row?.apy_pct).toBeCloseTo((1.01 ** (365 / 71) - 1) * 100, 10);
    expect(row?.expiry_at).toBe('2026-10-24T11:02:35.000Z');
    expect(row?.days_to_expiry).toBe(71);
    expect(row?.apy_unavailable_reason).toBeNull();
    const detail = await persistence.getScanHistoryDetail(saved.id);
    expect(JSON.parse(detail?.raw_result ?? '{}').outcomeApy.scenarioB.timingSource).toBe('polymarket.event.endDate');
  });
});
