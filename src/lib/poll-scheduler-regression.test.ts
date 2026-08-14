import { describe, expect, it } from 'vitest';
import {
  buildSchedulerState,
  completeAttempt,
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
