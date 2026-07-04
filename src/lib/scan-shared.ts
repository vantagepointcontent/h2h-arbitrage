/**
 * Shared scan utilities: withTimeout and chooseBestPmStructure.
 * Used by both scan/route.ts and saved-markets/refresh/refresh-single.ts.
 * Each call site defines its own timeout constants — this module has none.
 */

import { matchOutcomes } from '@/lib/matcher';

export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
  );
  return Promise.race([promise, timeout]);
}

/**
 * Try both Polymarket structures:
 * (A) markets that have a groupItemTitle (named binary)
 * (B) markets that have NO groupItemTitle (unnamed binary)
 * If both are non-empty, run matching on each and return the one that yields more matched outcomes.
 * If the winner set is empty, fall back to the full set.
 */
export function chooseBestPmStructure(
  allPmMarkets: any[],
  kalshiMarkets: any[],
  pmEventTitle: string,
): any[] {
  const namedMarkets = allPmMarkets.filter((m: any) =>
    m.groupItemTitle && m.groupItemTitle !== '' && m.groupItemTitle !== 'N/A'
  );
  const unnamedMarkets = allPmMarkets.filter((m: any) =>
    !m.groupItemTitle || m.groupItemTitle === '' || m.groupItemTitle === 'N/A'
  );

  if (namedMarkets.length === 0) return unnamedMarkets;
  if (unnamedMarkets.length === 0) return namedMarkets;

  // Run matching on both sets and count matched outcomes
  const namedOutcomes = matchOutcomes(kalshiMarkets, namedMarkets, pmEventTitle, 1000);
  const unnamedOutcomes = matchOutcomes(kalshiMarkets, unnamedMarkets, pmEventTitle, 1000);

  const namedMatched = namedOutcomes.filter((o: any) => o.kalshi && o.polymarket).length;
  const unnamedMatched = unnamedOutcomes.filter((o: any) => o.kalshi && o.polymarket).length;

  if (namedMatched === 0 && unnamedMatched === 0) return allPmMarkets;
  if (namedMatched >= unnamedMatched) return namedMarkets;
  return unnamedMarkets;
}