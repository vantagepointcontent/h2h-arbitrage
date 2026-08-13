import { describe, expect, it } from 'vitest';
import {
  buildSchedulerState,
  completeAttempt,
  isEligibleMarket,
  markAttemptStarted,
  parseBoundedNumber,
  resetBreakerAfterExternalSuccess,
  selectDueMarkets,
  schedulerMetrics,
} from '../../scripts/poll-scheduler.mjs';

type Market = { id: string; kalshiUrl: string; polymarketUrl: string; eventTitle: string; lastScanResult?: { scannedAt?: string | null; matchStatus?: string } | null };

const market = (id: string, scannedAt: string | null = null): Market => ({
  id,
  eventTitle: `Market ${id}`,
  kalshiUrl: `https://kalshi.com/markets/${id}`,
  polymarketUrl: `https://polymarket.com/event/${id}`,
  lastScanResult: scannedAt ? { scannedAt } : null,
});

describe('saved-market fair scheduler', () => {
  it('bounds invalid numeric environment configuration', () => {
    expect(parseBoundedNumber('NaN', 5, 1, 20)).toBe(5);
    expect(parseBoundedNumber('0', 5, 1, 20)).toBe(5);
    expect(parseBoundedNumber('999', 5, 1, 20)).toBe(20);
    expect(parseBoundedNumber('7.8', 5, 1, 20, true)).toBe(7);
  });
  it('processes later entries after an earlier entry fails instead of retrying it first', () => {
    const now = Date.parse('2026-08-13T20:00:00Z');
    const markets = ['a', 'b', 'c', 'd'].map(id => market(id));
    const state = buildSchedulerState(markets, {}, now, 60_000);

    expect(selectDueMarkets(markets, state, now, 2).map(m => m.id)).toEqual(['a', 'b']);
    markAttemptStarted(state.a, now);
    markAttemptStarted(state.b, now);
    completeAttempt(state.a, { ok: false, error: 'HTTP 500' }, now + 1_000, 60_000);
    completeAttempt(state.b, { ok: true }, now + 1_000, 60_000);

    expect(selectDueMarkets(markets, state, now + 2_000, 2).map(m => m.id)).toEqual(['c', 'd']);
  });

  it('recovers in-progress work immediately after worker restart', () => {
    const now = Date.parse('2026-08-13T20:00:00Z');
    const persisted = {
      a: { lastAttemptAt: new Date(now - 5_000).toISOString(), lastSuccessAt: null, nextDueAt: new Date(now + 60_000).toISOString(), inProgress: true, failureReason: null, retryCount: 0 },
    };
    const state = buildSchedulerState([market('a')], persisted, now, 60_000);

    expect(state.a.inProgress).toBe(false);
    expect(state.a.failureReason).toContain('worker restarted');
    expect(selectDueMarkets([market('a')], state, now, 1).map(m => m.id)).toEqual(['a']);
  });

  it('backs off repeated failures without blocking healthy markets', () => {
    const now = Date.parse('2026-08-13T20:00:00Z');
    const markets = [market('failed'), market('healthy')];
    const state = buildSchedulerState(markets, {}, now, 3_600_000);
    markAttemptStarted(state.failed, now);
    completeAttempt(state.failed, { ok: false, error: 'Polymarket timeout' }, now + 1_000, 3_600_000);

    expect(state.failed.retryCount).toBe(1);
    expect(Date.parse(state.failed.nextDueAt)).toBeGreaterThan(now + 1_000);
    expect(selectDueMarkets(markets, state, now + 2_000, 10).map(m => m.id)).toEqual(['healthy']);
  });

  it('honors a longer circuit-breaker retry deadline', () => {
    const now = Date.parse('2026-08-13T20:00:00Z');
    const state = buildSchedulerState([market('a')], {}, now, 60_000);
    markAttemptStarted(state.a, now);
    completeAttempt(state.a, { ok: false, error: 'timeout', retryAt: now + 20 * 60_000 }, now, 60_000);
    expect(Date.parse(state.a.nextDueAt)).toBe(now + 20 * 60_000);
  });

  it('keeps expired markets out unless their price is explicitly unresolved', () => {
    const now = Date.parse('2026-08-13T20:00:00Z');
    expect(isEligibleMarket({ ...market('closed'), expiryDate: '2026-08-13T19:00:00Z' }, now)).toBe(false);
    expect(isEligibleMarket({
      ...market('in-play'),
      expiryDate: '2026-08-13T19:00:00Z',
      lastScanResult: { scannedAt: null, priceResolved: false },
    }, now)).toBe(true);
  });

  it('normalizes invalid freshness configuration to the safe default', () => {
    const now = Date.parse('2026-08-13T20:00:00Z');
    const state = buildSchedulerState([market('a')], {}, now, Number.NaN);
    expect(state.a.freshnessSlaMs).toBe(60 * 60_000);
    expect(() => completeAttempt(state.a, { ok: true }, now, Number.NaN, Number.NaN)).not.toThrow();
  });

  it('does not promote a failed API diagnostic timestamp to last success', () => {
    const now = Date.parse('2026-08-13T20:00:00Z');
    const failed = market('a', '2026-08-13T19:59:00Z');
    failed.lastScanResult!.matchStatus = 'unavailable';
    const state = buildSchedulerState([failed], {
      a: { lastSuccessAt: '2026-08-13T18:00:00Z', nextDueAt: '2026-08-13T18:30:00Z', inProgress: false, retryCount: 1, failureReason: 'HTTP 503' },
    }, now, 60_000);

    expect(state.a.lastSuccessAt).toBe('2026-08-13T18:00:00Z');
  });

  it('recognizes a newer successful manual full scan and avoids an immediate duplicate', () => {
    const now = Date.parse('2026-08-13T20:00:00Z');
    const state = buildSchedulerState([market('a', '2026-08-13T19:59:00Z')], {
      a: { lastSuccessAt: '2026-08-13T18:00:00Z', nextDueAt: '2026-08-13T18:30:00Z', inProgress: false, retryCount: 0 },
    }, now, 60_000);

    expect(state.a.lastSuccessAt).toBe('2026-08-13T19:59:00Z');
    expect(state.a.nextDueAt).toBe('2026-08-13T20:00:00.000Z');
  });

  it('clears failed retry state when a newer manual full scan succeeds', () => {
    const now = Date.parse('2026-08-13T20:00:00Z');
    const state = buildSchedulerState([market('a', '2026-08-13T19:59:00Z')], {
      a: {
        lastAttemptAt: '2026-08-13T19:30:00Z',
        lastSuccessAt: '2026-08-13T18:00:00Z',
        nextDueAt: '2026-08-13T20:30:00Z',
        inProgress: false,
        retryCount: 3,
        failureReason: 'Kalshi HTTP 503',
      },
    }, now, 60_000);

    expect(state.a).toMatchObject({
      lastSuccessAt: '2026-08-13T19:59:00Z',
      nextDueAt: '2026-08-13T20:00:00.000Z',
      failureReason: null,
      retryCount: 0,
    });

    const breaker = { avgMs: 4_000, consecFails: 3, trips: 2, cooldownUntil: now + 30 * 60_000 };
    expect(resetBreakerAfterExternalSuccess(breaker)).toBe(true);
    expect(breaker).toEqual({ avgMs: 4_000, consecFails: 0, trips: 0, cooldownUntil: 0 });
  });

  it('bounds every successful market next-due time by the freshness SLA', () => {
    const now = Date.parse('2026-08-13T20:00:00Z');
    const state = buildSchedulerState([market('a')], {}, now, 3_600_000);
    markAttemptStarted(state.a, now);
    completeAttempt(state.a, { ok: true }, now + 1_000, 3_600_000, 24 * 3_600_000);

    expect(Date.parse(state.a.nextDueAt)).toBe(now + 1_000 + 3_600_000);
    expect(state.a.freshnessSlaMs).toBe(3_600_000);
  });

  it('orders a large due set oldest-first with stable round-robin fairness', () => {
    const now = Date.parse('2026-08-13T20:00:00Z');
    const markets = Array.from({ length: 1_000 }, (_, i) => market(String(i).padStart(4, '0')));
    const state = buildSchedulerState(markets, {}, now, 3_600_000);
    for (let i = 0; i < 100; i += 1) state[markets[i].id].lastAttemptAt = new Date(now - i * 1_000).toISOString();

    const selected = selectDueMarkets(markets, state, now, 1_000);
    expect(selected).toHaveLength(1_000);
    expect(new Set(selected.map(item => item.id)).size).toBe(1_000);
    expect(selected.at(-1)?.id).toBe('0000');
  });

  it('reports overdue, failed, scanning, queue depth, and oldest success age', () => {
    const now = Date.parse('2026-08-13T20:00:00Z');
    const markets = [market('overdue'), market('failed'), market('scanning')];
    const state = buildSchedulerState(markets, {}, now, 60_000);
    state.overdue.lastSuccessAt = new Date(now - 120_000).toISOString();
    state.failed.failureReason = 'Kalshi HTTP 503';
    state.failed.retryCount = 2;
    state.scanning.inProgress = true;

    expect(schedulerMetrics(markets, state, now, 60_000)).toMatchObject({
      eligibleCount: 3, dueCount: 2, overdueCount: 1, failedCount: 1, inProgressCount: 1, oldestSuccessAgeMs: 120_000,
    });
  });

  it('retains only the two saved linked-event URLs in selected work', () => {
    const now = Date.parse('2026-08-13T20:00:00Z');
    const markets = [market('scoped')];
    const state = buildSchedulerState(markets, {}, now, 60_000);

    expect(selectDueMarkets(markets, state, now, 1)[0]).toMatchObject({
      kalshiUrl: 'https://kalshi.com/markets/scoped',
      polymarketUrl: 'https://polymarket.com/event/scoped',
    });
  });
});
