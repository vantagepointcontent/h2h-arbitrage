export const MIN_LIVE_SCAN_CAPITAL = 1;
export const MAX_LIVE_SCAN_CAPITAL = 1_000_000;
const DEFAULT_LIVE_SCAN_CAPITAL = 10;

/**
 * Parse the capital query parameter before it reaches live arbitrage sizing.
 * Query values are strings, so blank and non-finite values must not silently
 * turn into zero or NaN.
 */
export function parseLiveScanCapital(value: string | null): number | null {
  if (value === null) return DEFAULT_LIVE_SCAN_CAPITAL;
  if (value.trim() === "") return null;

  const capital = Number(value);
  if (!Number.isFinite(capital)) return null;
  if (capital < MIN_LIVE_SCAN_CAPITAL || capital > MAX_LIVE_SCAN_CAPITAL) return null;
  return capital;
}
