import { seedAllBooks } from './book-seed';
import { computeAllLiveArbitrages } from './live-arb-engine';
import { PairResolveError, resolvePairFromLinks } from './pair-resolver';
import { getScanValuationInputs } from './persistence';
import { orderbookState } from './orderbook-state';

export type CurrentLogRoiStatus =
  | 'available'
  | 'stale_quote'
  | 'unavailable_book'
  | 'insufficient_depth'
  | 'missing_links'
  | 'upstream_failure';

export interface CurrentLogRoiValuation {
  id: number;
  status: CurrentLogRoiStatus;
  roiPct?: number;
  strategy?: string;
  quotedAt?: string;
}

const CACHE_TTL_MS = 20_000;
const MAX_CACHE_ENTRIES = 128;
const cache = new Map<string, { valuation: Omit<CurrentLogRoiValuation, 'id'>; fetchedAt: number }>();
const inFlight = new Map<string, Promise<Omit<CurrentLogRoiValuation, 'id'>>>();

function valuationKey(input: { kalshiUrl: string; polymarketUrl: string; totalStake: number }): string {
  return JSON.stringify([input.kalshiUrl, input.polymarketUrl, input.totalStake]);
}

function store(key: string, valuation: Omit<CurrentLogRoiValuation, 'id'>): void {
  cache.delete(key);
  cache.set(key, { valuation, fetchedAt: Date.now() });
  while (cache.size > MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

async function valuePair(input: { kalshiUrl: string; polymarketUrl: string; totalStake: number }): Promise<Omit<CurrentLogRoiValuation, 'id'>> {
  const key = valuationKey(input);
  const cached = cache.get(key);
  if (cached && Date.now() - cached.fetchedAt <= CACHE_TTL_MS) return cached.valuation;
  const pending = inFlight.get(key);
  if (pending) return pending;

  const request = (async () => {
    try {
      const capital = Number.isFinite(input.totalStake) && input.totalStake > 0 ? input.totalStake : 100;
      const resolved = await resolvePairFromLinks([
        { platform: 'kalshi', url: input.kalshiUrl },
        { platform: 'polymarket', url: input.polymarketUrl },
      ], capital);
      await seedAllBooks(resolved.kalshiTickers, resolved.pmTokenIds, resolved.pmTokenSides);
      const requiredBooks = [...resolved.kalshiTickers, ...resolved.pmTokenIds];
      if (requiredBooks.some((id) => !orderbookState.hasBook(id))) return { status: 'unavailable_book' as const };
      const results = computeAllLiveArbitrages(resolved.matchedOutcomes, capital, resolved.category);
      if (results.length === 0) return { status: 'unavailable_book' as const };
      if (results.some((result) => result.stale)) return { status: 'stale_quote' as const };

      const executable = results
        .filter((result) => result.kalshiStake + result.pmStake > 0 && Number.isFinite(result.roiPct))
        .sort((left, right) => right.roiPct - left.roiPct);
      const best = executable[0];
      if (!best) return { status: 'insufficient_depth' as const };
      return {
        status: 'available' as const,
        roiPct: best.roiPct,
        strategy: best.strategy,
        quotedAt: new Date().toISOString(),
      };
    } catch (error) {
      if (error instanceof PairResolveError) {
        if (error.code === 'bad_kalshi_url' || error.code === 'bad_pm_url') return { status: 'missing_links' as const };
        if (error.code === 'no_matches' || error.code === 'no_tokens' || error.code === 'pm_not_found') return { status: 'unavailable_book' as const };
      }
      return { status: 'upstream_failure' as const };
    }
  })().then((valuation) => {
    store(key, valuation);
    return valuation;
  }).finally(() => inFlight.delete(key));

  inFlight.set(key, request);
  return request;
}

export async function getCurrentLogRoiBatch(ids: number[]): Promise<CurrentLogRoiValuation[]> {
  const uniqueIds = [...new Set(ids)];
  const inputs = await getScanValuationInputs(uniqueIds);
  const byId = new Map(inputs.map((input) => [input.id, input]));
  return Promise.all(uniqueIds.map(async (id) => {
    const input = byId.get(id);
    if (!input?.kalshiUrl || !input.polymarketUrl) return { id, status: 'missing_links' as const };
    return { id, ...(await valuePair({
      kalshiUrl: input.kalshiUrl,
      polymarketUrl: input.polymarketUrl,
      totalStake: input.totalStake,
    })) };
  }));
}

export function resetCurrentLogRoiStateForTests(): void {
  cache.clear();
  inFlight.clear();
}
