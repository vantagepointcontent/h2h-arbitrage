export const DASHBOARD_RANGES = ['today', '7d', '30d', '90d', 'all'] as const;

export type DashboardRange = (typeof DASHBOARD_RANGES)[number];

export function parseDashboardRange(value: string | null): DashboardRange {
  return DASHBOARD_RANGES.includes(value as DashboardRange) ? (value as DashboardRange) : '30d';
}
