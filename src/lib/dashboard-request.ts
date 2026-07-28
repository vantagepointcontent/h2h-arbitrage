export const DASHBOARD_RANGES = ['today', '7d', '30d', '90d', 'all'] as const;

export type DashboardRange = (typeof DASHBOARD_RANGES)[number];

export function parseDashboardRange(value: string | null): DashboardRange {
  return DASHBOARD_RANGES.includes(value as DashboardRange) ? (value as DashboardRange) : '30d';
}

export const DEFAULT_SUSPICIOUS_ROI_PCT = 25;

/**
 * Environment configuration is untrusted input too. A non-finite or
 * non-positive threshold would make the phantom-arb guard exclude every
 * dashboard row or let bad rows through.
 */
export function parseSuspiciousRoiThreshold(value: string | undefined): number {
  if (value === undefined || value.trim() === '') return DEFAULT_SUSPICIOUS_ROI_PCT;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_SUSPICIOUS_ROI_PCT;
}
