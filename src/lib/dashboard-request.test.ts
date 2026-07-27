import { describe, expect, it } from 'vitest';
import { parseDashboardRange } from './dashboard-request';

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
