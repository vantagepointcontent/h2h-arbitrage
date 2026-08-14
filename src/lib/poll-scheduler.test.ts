import { describe, expect, it } from 'vitest';
import {
  buildSchedulerState,
  completeAttempt,
  isEligibleMarket,
  markAttemptStarted,
  minimumConcurrencyForSla,
  parseBoundedNumber,
  resetBreakerAfterExternalSuccess,
  schedulerLeaseCanStart,
  schedulerLeaseMatches,
  selectDueMarkets,
  schedulerMetrics,
} from '../../scripts/poll-scheduler.mjs';
import { acquireMarketLease, releaseMarketLease } from '../../scripts/poll-lease.mjs';
import { updateSchedulerState } from '../../scripts/poll-state.mjs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import os from 'node:os';
import path from 'node:path';

type Market = { id: string; kalshiUrl: string; polymarketUrl: string; eventTitle: string; lastScanResult?: { scannedAt?: string | null; matchStatus?: string } | null };

const market = (id: string, scannedAt: string | null = null): Market => ({
  id,
  eventTitle: `Market ${id}`,
  kalshiUrl: `https://kalshi.com/markets/${id}`,
  polymarketUrl: `https://polymarket.com/event/${id}`,
  lastScanResult: scannedAt ? { scannedAt, matchStatus: 'matched' } : null,
});

describe('saved-market fair scheduler', () => {
  it('fails closed on an ownerless scheduler lock', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'poll-state-orphan-test-'));
    const stateFile = path.join(directory, 'scheduler.json');
    try {
      const interruptedOwner = spawn(process.execPath, [
        '-e',
        'require("node:fs").mkdirSync(process.argv[1])',
        `${stateFile}.lock`,
      ]);
      const [exitCode] = await once(interruptedOwner, 'exit');
      expect(exitCode).toBe(0);

      await expect(updateSchedulerState(stateFile, state => {
        state.recovered = true;
      }, { lockWaitMs: 100 })).rejects.toThrow('Timed out acquiring scheduler state lock');

      await expect(readFile(stateFile, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 1_000);

  it('preserves corrupt scheduler state instead of replacing it with an empty object', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'poll-state-corrupt-test-'));
    const stateFile = path.join(directory, 'scheduler.json');
    try {
      await writeFile(stateFile, '{"market-a":');
      await expect(updateSchedulerState(stateFile, state => {
        state.recovered = true;
      })).rejects.toThrow();
      expect(await readFile(stateFile, 'utf8')).toBe('{"market-a":');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('merges concurrent per-market scheduler updates without losing completed state', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'poll-state-test-'));
    const stateFile = path.join(directory, 'scheduler.json');
    try {
      await writeFile(stateFile, JSON.stringify({
        a: { inProgress: true, lastSuccessAt: null },
        b: { inProgress: true, lastSuccessAt: null },
      }));

      await Promise.all([
        updateSchedulerState(stateFile, state => {
          state.a = { inProgress: false, lastSuccessAt: '2026-08-13T20:00:01.000Z' };
        }),
        updateSchedulerState(stateFile, state => {
          state.b = { inProgress: false, lastSuccessAt: '2026-08-13T20:00:02.000Z' };
        }),
      ]);

      expect(JSON.parse(await readFile(stateFile, 'utf8'))).toEqual({
        a: { inProgress: false, lastSuccessAt: '2026-08-13T20:00:01.000Z' },
        b: { inProgress: false, lastSuccessAt: '2026-08-13T20:00:02.000Z' },
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('fences a live owner and reclaims its abandoned lease after expiry', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'poll-lease-test-'));
    try {
      const first = await acquireMarketLease(directory, 'market/a', 'owner-1', 80);
      expect(first).not.toBeNull();
      expect(await acquireMarketLease(directory, 'market/a', 'owner-2', 80)).toBeNull();

      await new Promise(resolve => setTimeout(resolve, 100));
      const recovered = await acquireMarketLease(directory, 'market/a', 'owner-2', 80);
      expect(recovered).not.toBeNull();
      expect(recovered?.ownerId).toBe('owner-2');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('releases only the exact kernel-lock generation without pathname deletion', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'poll-lease-release-'));
    try {
      const first = await acquireMarketLease(directory, 'market/a', 'owner-1', 10_000);
      expect(first).not.toBeNull();
      expect(await releaseMarketLease({ token: 'not-the-owner' })).toBe(false);
      expect(await releaseMarketLease(first)).toBe(true);
      expect(await releaseMarketLease(first)).toBe(false);
      expect(await acquireMarketLease(directory, 'market/a', 'owner-2', 10_000)).not.toBeNull();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('fails closed when existing lease metadata is malformed', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'poll-lease-malformed-'));
    try {
      const leasePath = path.join(directory, createHash('sha256').update('market/a').digest('hex'));
      await mkdir(leasePath);
      await writeFile(path.join(leasePath, 'owner.json'), '{"ownerId":');
      expect(await acquireMarketLease(directory, 'market/a', 'owner-2', 80)).toBeNull();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('does not upgrade an expired legacy lease directory in place', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'poll-lease-legacy-expired-'));
    try {
      const marketId = 'legacy-market';
      const leasePath = path.join(directory, createHash('sha256').update(marketId).digest('hex'));
      await mkdir(leasePath);
      await writeFile(path.join(leasePath, 'owner.json'), JSON.stringify({
        ownerId: 'legacy-owner',
        token: 'legacy-token',
        acquiredAt: '2026-08-13T19:00:00.000Z',
        expiresAt: '2026-08-13T19:01:00.000Z',
      }));
      expect(await acquireMarketLease(
        directory,
        marketId,
        'modern-owner',
        1_000,
        Date.parse('2026-08-13T20:00:00Z'),
      )).toBeNull();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('elects exactly one successor when many contenders observe an expired lease', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'poll-lease-turnover-'));
    try {
      expect(await acquireMarketLease(directory, 'market/a', 'expired-owner', 1)).not.toBeNull();
      await new Promise(resolve => setTimeout(resolve, 5));
      const contenders = await Promise.all(Array.from({ length: 20 }, (_, index) =>
        acquireMarketLease(directory, 'market/a', `owner-${index}`, 1_000)));
      expect(contenders.filter(Boolean)).toHaveLength(1);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('bounds invalid numeric environment configuration', () => {
    expect(parseBoundedNumber('NaN', 5, 1, 20)).toBe(5);
    expect(parseBoundedNumber('0', 5, 1, 20)).toBe(5);
    expect(parseBoundedNumber('999', 5, 1, 20)).toBe(20);
    expect(parseBoundedNumber('7.8', 5, 1, 20, true)).toBe(7);
  });

  it('reserves enough bounded concurrency to finish the full queue inside the SLA', () => {
    expect(minimumConcurrencyForSla(503, 35_000, 60 * 60_000)).toBe(5);
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

  it('keeps leased work fenced and recovers it after the bounded lease expires', () => {
    const now = Date.parse('2026-08-13T20:00:00Z');
    const persisted = {
      a: { lastAttemptAt: new Date(now - 5_000).toISOString(), lastSuccessAt: null, nextDueAt: new Date(now + 60_000).toISOString(), inProgress: true, leaseOwnerId: 'owner-1', leaseExpiresAt: new Date(now + 10_000).toISOString(), failureReason: null, retryCount: 0 },
    };
    const state = buildSchedulerState([market('a')], persisted, now, 60_000);

    expect(state.a.inProgress).toBe(true);
    expect(selectDueMarkets([market('a')], state, now, 1)).toEqual([]);

    const recovered = buildSchedulerState([market('a')], state, now + 10_001, 60_000);
    expect(recovered.a.inProgress).toBe(false);
    expect(recovered.a.failureReason).toContain('worker restarted');
    expect(selectDueMarkets([market('a')], recovered, now + 10_001, 1).map(m => m.id)).toEqual(['a']);
  });

  it('rejects stale terminal writes after a successor claims the scheduler generation', () => {
    const now = Date.parse('2026-08-13T20:00:00Z');
    const item = buildSchedulerState([market('a')], {}, now, 60_000).a;
    const first = { ownerId: 'owner-a', token: 'token-a', expiresAt: new Date(now + 20).toISOString() };
    const successor = { ownerId: 'owner-b', token: 'token-b', expiresAt: new Date(now + 1_000).toISOString() };
    const expired = { ownerId: 'expired', token: 'expired-token', expiresAt: new Date(now - 1).toISOString() };
    expect(schedulerLeaseCanStart(item, expired, now)).toBe(false);
    markAttemptStarted(item, now, first);
    expect(schedulerLeaseCanStart(item, first, now + 21)).toBe(false);
    expect(schedulerLeaseCanStart(item, successor, now + 10)).toBe(false);
    expect(schedulerLeaseCanStart(item, successor, now + 21)).toBe(true);
    markAttemptStarted(item, now + 21, successor);
    expect(schedulerLeaseMatches(item, first.token, now + 21)).toBe(false);
    expect(schedulerLeaseMatches(item, successor.token, now + 21)).toBe(true);
    expect(schedulerLeaseMatches(item, successor.token, now + 1_001)).toBe(false);
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

  it('does not promote missing or unknown publication status to last success', () => {
    const now = Date.parse('2026-08-13T20:00:00Z');
    for (const matchStatus of [undefined, 'legacy_unknown']) {
      const candidate = market('a', '2026-08-13T19:59:00Z');
      candidate.lastScanResult!.matchStatus = matchStatus;
      const state = buildSchedulerState([candidate], {
        a: { lastSuccessAt: '2026-08-13T18:00:00Z', nextDueAt: '2026-08-13T18:30:00Z' },
      }, now, 60_000);
      expect(state.a.lastSuccessAt).toBe('2026-08-13T18:00:00Z');
    }
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
