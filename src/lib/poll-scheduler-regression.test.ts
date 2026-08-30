import { describe, expect, it } from 'vitest';
import {
  adaptiveScanTimeoutMs,
  buildSchedulerState,
  classifyScanHttpFailure,
  completeAttempt,
  freshnessSafeInterval,
  markAttemptStarted,
  selectDueMarkets,
} from '../../scripts/poll-scheduler.mjs';

type Market = {
  id: string;
  eventTitle: string;
  kalshiUrl: string;
  polymarketUrl: string;
};

function market(index: number): Market {
  const id = String(index).padStart(3, '0');
  return {
    id,
    eventTitle: `Market ${id}`,
    kalshiUrl: `https://kalshi.com/markets/${id}`,
    polymarketUrl: `https://polymarket.com/event/${id}`,
  };
}

describe('BUG-150 recurring saved-market fairness', () => {
  it('extends only retrying markets without inflating the normal SLA capacity budget', () => {
    expect(adaptiveScanTimeoutMs(null, 21_000, 30_000, 18_000)).toBe(21_000);
    expect(adaptiveScanTimeoutMs({ avgMs: 12_000, consecFails: 1, trips: 0 }, 21_000, 30_000, 18_000)).toBe(30_000);
    expect(adaptiveScanTimeoutMs({ avgMs: 9_000, consecFails: 0, trips: 0 }, 21_000, 30_000, 18_000)).toBe(27_000);
    expect(adaptiveScanTimeoutMs({ avgMs: 4_000, consecFails: 0, trips: 0 }, 21_000, 30_000, 18_000)).toBe(18_000);
  });

  it('schedules successful scans before the SLA boundary by two wake intervals', () => {
    expect(freshnessSafeInterval(3_600_000, 3_600_000, 60_000)).toBe(3_480_000);
    expect(freshnessSafeInterval(300_000, 3_600_000, 60_000)).toBe(300_000);
  });

  it('does not poison per-market breakers when the global disk gate or scanner capacity is closed', () => {
    expect(classifyScanHttpFailure(503, { code: 'DISK_CAPACITY' }, '60', 1_000)).toEqual({
      error: 'HTTP 503 (DISK_CAPACITY)',
      errorCode: 'DISK_CAPACITY',
      dormant: false,
      countsTowardBreaker: false,
      retryAt: 61_000,
    });
    expect(classifyScanHttpFailure(503, { error: 'Scanner is at capacity.' }, '2', 1_000))
      .toMatchObject({ countsTowardBreaker: false, errorCode: 'SCAN_CAPACITY', retryAt: 3_000 });
    expect(classifyScanHttpFailure(503, { error: 'venue unavailable' }, null, 1_000))
      .toMatchObject({ countsTowardBreaker: true, errorCode: null });
    expect(classifyScanHttpFailure(500, { error: 'Scan worker exited before returning a result' }, null, 1_000))
      .toMatchObject({
        error: 'HTTP 500: Scan worker exited before returning a result',
        countsTowardBreaker: true,
      });

    const state = buildSchedulerState([market(1)], {}, 1_000, 60 * 60_000);
    markAttemptStarted(state['001'], 1_000);
    completeAttempt(state['001'], {
      ok: false,
      error: 'HTTP 503 (DISK_CAPACITY)',
      retryAt: 61_000,
      retryWithoutPenalty: true,
    }, 1_000, 60 * 60_000);
    expect(state['001']).toMatchObject({ retryCount: 0, nextDueAt: new Date(61_000).toISOString() });
  });

  it('advances beyond a failed first batch across all 496 eligible markets', () => {
    const now = Date.parse('2026-08-14T10:00:00Z');
    const markets = Array.from({ length: 496 }, (_, index) => market(index));
    const state = buildSchedulerState(markets, {}, now, 60 * 60_000);

    const firstBatch = selectDueMarkets(markets, state, now, 5);
    expect(firstBatch.map(item => item.id)).toEqual(['000', '001', '002', '003', '004']);

    for (const item of firstBatch) {
      markAttemptStarted(state[item.id], now);
      completeAttempt(
        state[item.id],
        { ok: false, error: 'HTTP 503' },
        now + 1_000,
        60 * 60_000,
      );
    }

    expect(selectDueMarkets(markets, state, now + 2_000, 5).map(item => item.id))
      .toEqual(['005', '006', '007', '008', '009']);
  });
});
