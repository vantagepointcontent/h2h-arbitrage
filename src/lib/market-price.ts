export function finiteMarketPrice(value: unknown): number {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number.parseFloat(value) : NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}
