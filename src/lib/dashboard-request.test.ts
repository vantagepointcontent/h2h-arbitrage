import { describe, expect, it } from 'vitest';
import { parseDashboardRange, parseSuspiciousRoiThreshold } from './dashboard-request';

describe('parseDashboardRange', () => {
  it.each(['today', '7d', '30d', '90d', 'all'] as const)(
    'accepts the supported %s range',
    (range) => {
      expect(parseDashboardRange(range)).toBe(range);
    },
  );

  it.each([null, '', '  ', '365d', 'all;drop table scan_results']) (
    'uses the documented 30d default for unsupported range values',
    (range) => {
      expect(parseDashboardRange(range)).toBe('30d');
    },
  );
});

describe('parseSuspiciousRoiThreshold', () => {
  it.each([
    ['25', 25],
    ['12.5', 12.5],
    [' 30 ', 30],
  ])('accepts finite positive configuration %s', (value, expected) => {
    expect(parseSuspiciousRoiThreshold(value)).toBe(expected);
  });

  it.each([undefined, '', ' ', 'Infinity', '-Infinity', 'NaN', '0', '-1', 'not-a-number'])
  ('uses the safe default for invalid configuration %s', (value) => {
    expect(parseSuspiciousRoiThreshold(value)).toBe(25);
  });
});
