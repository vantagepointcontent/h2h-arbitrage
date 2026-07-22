export interface ShareRatio {
  kalshiShares: number;
  polymarketShares: number;
  display: string;
}

function gcd(a: number, b: number): number {
  while (b !== 0) [a, b] = [b, a % b];
  return a;
}

/** Converts dollar stakes to contracts, then returns a stable simplified PM:Kalshi ratio. */
export function calculateShareRatio(
  kalshiStake: number | null | undefined,
  kalshiPrice: number | null | undefined,
  polymarketStake: number | null | undefined,
  polymarketPrice: number | null | undefined,
): ShareRatio | null {
  if (!kalshiStake || !kalshiPrice || !polymarketStake || !polymarketPrice ||
      kalshiStake <= 0 || kalshiPrice <= 0 || polymarketStake <= 0 || polymarketPrice <= 0) return null;

  const kalshiShares = kalshiStake / kalshiPrice;
  const polymarketShares = polymarketStake / polymarketPrice;
  if (!Number.isFinite(kalshiShares) || !Number.isFinite(polymarketShares)) return null;

  // Contract counts can be fractional. Hundredths retains meaningful sizing without noisy floats.
  const pmUnits = Math.max(1, Math.round(polymarketShares * 100));
  const kalshiUnits = Math.max(1, Math.round(kalshiShares * 100));
  const divisor = gcd(pmUnits, kalshiUnits);
  return { kalshiShares, polymarketShares, display: `${pmUnits / divisor}:${kalshiUnits / divisor}` };
}
