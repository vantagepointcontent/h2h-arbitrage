/**
 * Tests for arb lifecycle tracking (arb-lifecycle.ts).
 * Uses the real module against the real DB file path — so we isolate by
 * using unique market IDs per test run and cleaning up after.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { recordArbObservations, getLifecycleStats } from './arb-lifecycle';
import { createClient } from '@libsql/client';
import path from 'path';

const TEST_PREFIX = `test-lifecycle-${Date.now()}`;
const db = createClient({ url: `file:${path.join(process.cwd(), 'data', 'edgefinder.db')}` });

afterAll(async () => {
  await db.execute({ sql: `DELETE FROM arb_episodes WHERE market_id LIKE ?`, args: [`${TEST_PREFIX}%`] });
});

const arb = (outcome: string, roiPct: number, profit = 10, stake = 100) => ({
  outcome, strategy: 'Buy K YES + PM NO', roiPct, expectedProfit: profit, totalStake: stake,
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
