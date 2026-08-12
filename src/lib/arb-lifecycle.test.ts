/**
 * Tests for arb lifecycle tracking (arb-lifecycle.ts).
 * Uses the real module against the real DB file path — so we isolate by
 * using unique market IDs per test run and cleaning up after.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { recordArbObservations, getLifecycleStats, resolveLifecycleCategory } from './arb-lifecycle';
import { createClient } from '@libsql/client';
import path from 'path';

const TEST_PREFIX = `test-lifecycle-${Date.now()}`;
const db = createClient({ url: `file:${path.join(process.cwd(), 'data', 'edgefinder.db')}` });

beforeAll(async () => {
  // A fresh checkout has no runtime-created persistence schema yet. Lifecycle
  // joins saved markets for canonical categories, so create its real minimum
  // contract instead of relying on another test file to initialize the DB.
  await db.execute(`CREATE TABLE IF NOT EXISTS saved_markets (
    id TEXT PRIMARY KEY,
    kalshi_url TEXT NOT NULL,
    polymarket_url TEXT NOT NULL,
    event_title TEXT NOT NULL DEFAULT '',
    category TEXT,
    created_at TEXT NOT NULL
  )`);
});

afterAll(async () => {
  const marketPattern = `${TEST_PREFIX}%`;
  // Points reference episodes without ON DELETE CASCADE; clean children first.
  await db.execute({
    sql: `DELETE FROM arb_episode_points WHERE episode_id IN (SELECT id FROM arb_episodes WHERE market_id LIKE ?)`,
    args: [marketPattern],
  });
  await db.execute({ sql: `DELETE FROM arb_episodes WHERE market_id LIKE ?`, args: [marketPattern] });
  await db.execute({ sql: `DELETE FROM saved_markets WHERE id LIKE ?`, args: [marketPattern] });
});

const arb = (outcome: string, roiPct: number, profit = 10, stake = 100) => ({
  outcome, strategy: 'Buy K YES + PM NO', roiPct, expectedProfit: profit, totalStake: stake,
});

describe('resolveLifecycleCategory', () => {
  it('accepts only canonical domains and rejects entity/outcome labels', () => {
    expect(resolveLifecycleCategory('US presidential election', 'Donald Trump')).toBe('politics');
    expect(resolveLifecycleCategory('MLB: AL Cy Young Winner', 'Tarik Skubal')).toBe('sports');
    expect(resolveLifecycleCategory('Will Bitcoin exceed $100k?', 'Yes')).toBe('crypto');
    expect(resolveLifecycleCategory('Maximum temperature in Chicago?', 'A')).toBe('weather');
  });

  it('prefers a saved canonical category over a polluted incoming category', () => {
    expect(resolveLifecycleCategory('TIME Person of the Year 2026', 'Jeremy Hansen', 'Entertainment'))
      .toBe('entertainment');
  });
});

describe('recordArbObservations', () => {
  it('opens a new episode for a positive arb', async () => {
    const mid = `${TEST_PREFIX}-open`;
    const r = await recordArbObservations(mid, 'Test Market', 'politics', [arb('Alice', 2.5)]);
    expect(r.opened).toBe(1);
    expect(r.extended).toBe(0);
    expect(r.closed).toBe(0);

    const rows = await db.execute({ sql: `SELECT * FROM arb_episodes WHERE market_id = ?`, args: [mid] });
    expect(rows.rows.length).toBe(1);
    const ep = rows.rows[0] as any;
    expect(ep.status).toBe('open');
    expect(ep.first_roi_pct).toBeCloseTo(2.5);
    expect(ep.category).toBe('politics');
  });

  it('canonicalizes a polluted category before persisting it', async () => {
    const mid = `${TEST_PREFIX}-canonical`;
    await recordArbObservations(mid, 'MLB: AL Cy Young Winner', 'Tarik Skubal', [arb('Pitcher', 2.5)]);
    const rows = await db.execute({ sql: `SELECT category FROM arb_episodes WHERE market_id = ?`, args: [mid] });
    expect((rows.rows[0] as any).category).toBe('sports');
  });

  it('uses the saved market category instead of a polluted scan category', async () => {
    const mid = `${TEST_PREFIX}-saved-category`;
    await db.execute({
      sql: `INSERT INTO saved_markets
            (id, kalshi_url, polymarket_url, event_title, category, created_at)
            VALUES (?, ?, ?, ?, ?, ?)`,
      args: [mid, 'https://kalshi.test/market', 'https://polymarket.test/market',
        'TIME Person of the Year 2026', 'entertainment', new Date().toISOString()],
    });
    await recordArbObservations(mid, 'TIME Person of the Year 2026', 'Jeremy Hansen', [arb('Candidate', 2.5)]);
    const rows = await db.execute({ sql: `SELECT category FROM arb_episodes WHERE market_id = ?`, args: [mid] });
    expect((rows.rows[0] as any).category).toBe('entertainment');
  });

  it('extends a live episode and tracks peaks', async () => {
    const mid = `${TEST_PREFIX}-extend`;
    await recordArbObservations(mid, 'Test', undefined, [arb('Bob', 1.0, 5, 50)]);
    const r = await recordArbObservations(mid, 'Test', undefined, [arb('Bob', 3.0, 20, 200)]);
    expect(r.opened).toBe(0);
    expect(r.extended).toBe(1);

    const rows = await db.execute({ sql: `SELECT * FROM arb_episodes WHERE market_id = ?`, args: [mid] });
    const ep = rows.rows[0] as any;
    expect(ep.scan_count).toBe(2);
    expect(ep.peak_roi_pct).toBeCloseTo(3.0);
    expect(ep.last_roi_pct).toBeCloseTo(3.0);
    expect(ep.peak_stake).toBeCloseTo(200);
    expect(ep.first_roi_pct).toBeCloseTo(1.0); // first preserved
  });

  it('closes an episode when the arb disappears', async () => {
    const mid = `${TEST_PREFIX}-close`;
    await recordArbObservations(mid, 'Test', undefined, [arb('Carol', 2.0)]);
    const r = await recordArbObservations(mid, 'Test', undefined, []); // arb gone
    expect(r.closed).toBe(1);

    const rows = await db.execute({ sql: `SELECT * FROM arb_episodes WHERE market_id = ?`, args: [mid] });
    const ep = rows.rows[0] as any;
    expect(ep.status).toBe('closed');
    expect(ep.closed_at).toBeTruthy();
    expect(ep.duration_sec).toBeGreaterThanOrEqual(0);
  });

  it('handles multiple outcomes independently', async () => {
    const mid = `${TEST_PREFIX}-multi`;
    await recordArbObservations(mid, 'Test', undefined, [arb('X', 1.0), arb('Y', 2.0)]);
    // Y survives, X dies, Z is born
    const r = await recordArbObservations(mid, 'Test', undefined, [arb('Y', 2.5), arb('Z', 0.5)]);
    expect(r.opened).toBe(1);   // Z
    expect(r.extended).toBe(1); // Y
    expect(r.closed).toBe(1);   // X

    const rows = await db.execute({ sql: `SELECT outcome, status FROM arb_episodes WHERE market_id = ? ORDER BY outcome`, args: [mid] });
    const byOutcome = Object.fromEntries((rows.rows as any[]).map(r => [r.outcome, r.status]));
    expect(byOutcome).toEqual({ X: 'closed', Y: 'open', Z: 'open' });
  });

  it('ignores non-positive ROI observations', async () => {
    const mid = `${TEST_PREFIX}-nonpos`;
    const r = await recordArbObservations(mid, 'Test', undefined, [arb('Dud', 0), arb('Neg', -1.5)]);
    expect(r.opened).toBe(0);
    const rows = await db.execute({ sql: `SELECT * FROM arb_episodes WHERE market_id = ?`, args: [mid] });
    expect(rows.rows.length).toBe(0);
  });

  it('reopens a NEW episode if the arb comes back after closing', async () => {
    const mid = `${TEST_PREFIX}-reopen`;
    await recordArbObservations(mid, 'Test', undefined, [arb('Eve', 1.0)]);
    await recordArbObservations(mid, 'Test', undefined, []);            // close
    const r = await recordArbObservations(mid, 'Test', undefined, [arb('Eve', 2.0)]); // back
    expect(r.opened).toBe(1);

    const rows = await db.execute({ sql: `SELECT status FROM arb_episodes WHERE market_id = ?`, args: [mid] });
    expect(rows.rows.length).toBe(2); // two distinct episodes
  });
});

describe('getLifecycleStats', () => {
  it('returns totals and category aggregates', async () => {
    const mid = `${TEST_PREFIX}-stats`;
    await recordArbObservations(mid, 'Stats Market', 'sports', [arb('S1', 4.0)]);
    const stats = await getLifecycleStats(1);
    expect(Number(stats.totals.episodes)).toBeGreaterThanOrEqual(1);
    expect(Array.isArray(stats.byCategory)).toBe(true);
    expect(Array.isArray(stats.recentEpisodes)).toBe(true);
    const sports = stats.byCategory.find((c: any) => c.category === 'sports');
    expect(sports).toBeTruthy();
  });
});
