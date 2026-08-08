import { describe, expect, it } from 'vitest';
import {
  isMonthlyQuotaError,
  mayCheckQuota,
  nextUtcDay,
  type PredictionHuntQuotaState,
} from './predictionhunt-quota';

describe('PredictionHunt monthly quota circuit breaker', () => {
  it('detects the provider monthly quota code', () => {
    expect(isMonthlyQuotaError(new Error('429 {"code":"rate_limit.exceeded_month"}'))).toBe(true);
    expect(isMonthlyQuotaError(new Error('rate_limit.exceeded_second'))).toBe(false);
  });

  it('opens the next check at the next UTC day', () => {
    expect(nextUtcDay(new Date('2026-08-07T23:58:00.000Z')).toISOString())
      .toBe('2026-08-08T00:00:00.000Z');
  });

  it('blocks all automatic calls for the rest of the day', () => {
    const state: PredictionHuntQuotaState = {
      status: 'exhausted',
      checkedAt: '2026-08-07T10:00:00.000Z',
      nextCheckAt: '2026-08-08T00:00:00.000Z',
      reason: 'rate_limit.exceeded_month',
    };
    expect(mayCheckQuota(state, new Date('2026-08-07T23:59:59.999Z'))).toBe(false);
  });

  it('allows one availability test on the next day', () => {
    const state: PredictionHuntQuotaState = {
      status: 'exhausted',
      checkedAt: '2026-08-07T10:00:00.000Z',
      nextCheckAt: '2026-08-08T00:00:00.000Z',
      reason: 'rate_limit.exceeded_month',
    };
    expect(mayCheckQuota(state, new Date('2026-08-08T00:00:00.000Z'))).toBe(true);
  });
});
