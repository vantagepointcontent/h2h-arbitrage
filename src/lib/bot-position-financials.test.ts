import { describe, expect, it } from 'vitest';
import { projectOpenPositionPnlCents } from './bot-position-financials';

describe('projectOpenPositionPnlCents', () => {
  it.each([
    [2_490_000, 2],
    [2_500_000, 3],
    [-2_490_000, -2],
    [-2_500_000, -3],
  ])('rounds persisted microcent P&L once per row (%i)', (indicativePnlMicrocents, expected) => {
    expect(projectOpenPositionPnlCents({
      currentValueCents: 99,
      buyCostCents: 97,
      indicativePnlMicrocents,
    })).toBe(expected);
  });

  it('derives legacy row P&L from persisted integer-cent value and buy cost', () => {
    expect(projectOpenPositionPnlCents({
      currentValueCents: 105,
      buyCostCents: 97,
      indicativePnlMicrocents: null,
      realizedPnlCents: 4,
    })).toBe(12);
  });

  it.each([null, Number.NaN, Number.POSITIVE_INFINITY, 2.49, -1])(
    'keeps unusable persisted current values unavailable (%s)',
    (currentValueCents) => {
      expect(projectOpenPositionPnlCents({
        currentValueCents,
        buyCostCents: 97,
        indicativePnlMicrocents: 2_490_000,
      })).toBeNull();
    },
  );

  it.each([null, Number.NaN, Number.NEGATIVE_INFINITY, 97.5, -1])(
    'keeps unusable persisted buy costs unavailable (%s)',
    (buyCostCents) => {
      expect(projectOpenPositionPnlCents({
        currentValueCents: 99,
        buyCostCents,
        indicativePnlMicrocents: 2_490_000,
      })).toBeNull();
    },
  );

  it.each([Number.NaN, Number.POSITIVE_INFINITY, 2.49, Number.MAX_SAFE_INTEGER + 1])(
    'does not hide malformed exact P&L behind a legacy fallback (%s)',
    (indicativePnlMicrocents) => {
      expect(projectOpenPositionPnlCents({
        currentValueCents: 99,
        buyCostCents: 97,
        indicativePnlMicrocents,
      })).toBeNull();
    },
  );
});
