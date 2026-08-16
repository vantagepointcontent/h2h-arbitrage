import { describe, expect, it } from 'vitest';
import { compareRoiDecline } from './roi-declined';

describe('compareRoiDecline', () => {
  it.each([
    { historical: 5, current: 4, declined: true, label: 'historical greater than current' },
    { historical: 5, current: 5, declined: false, label: 'equal values' },
    { historical: 4, current: 5, declined: false, label: 'current greater than historical' },
    { historical: -4, current: -5, declined: true, label: 'negative historical greater than negative current' },
    { historical: -5, current: -4, declined: false, label: 'negative current greater than negative historical' },
    { historical: 1.004, current: 1.003, declined: true, label: 'rounded-equal display with different raw precision' },
  ])('returns $declined for $label', ({ historical, current, declined }) => {
    expect(compareRoiDecline(historical, current)).toEqual({ declined, unavailableInputs: [] });
  });

  it.each([
    { historical: null, current: 0, unavailableInputs: ['scan-time ROI'] },
    { historical: 0, current: undefined, unavailableInputs: ['Current ROI'] },
    { historical: Number.NaN, current: Number.POSITIVE_INFINITY, unavailableInputs: ['scan-time ROI', 'Current ROI'] },
  ])('returns FALSE without coercing unavailable inputs', ({ historical, current, unavailableInputs }) => {
    expect(compareRoiDecline(historical, current)).toEqual({ declined: false, unavailableInputs });
  });
});
