export const MIN_SCAN_CAPITAL = 1;
export const MAX_SCAN_CAPITAL = 1_000_000;

/** Parse a scan capital request without allowing NaN, Infinity, or unsafe stakes. */
export function parseScanCapital(value: unknown): number | null {
  if (value === undefined) return 1000;
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  if (value < MIN_SCAN_CAPITAL || value > MAX_SCAN_CAPITAL) return null;
  return value;
}
