import { seedAllBooks } from './book-seed';
import { computeAllLiveArbitrages } from './live-arb-engine';
import { PairResolveError, resolvePairFromLinks } from './pair-resolver';
import { getScanValuationInputs } from './persistence';
import { orderbookState } from './orderbook-state';
import type { ScanValuationInput } from './persistence';

export type CurrentLogRoiStatus =
  | 'available'
  | 'stale_quote'
  | 'unavailable_book'
  | 'insufficient_depth'
  | 'missing_links'
  | 'missing_identifiers'
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
const MAX_PAIR_CONCURRENCY = 3;
let activePairValuations = 0;
const pairWaiters: Array<() => void> = [];

type ValuationInput = Omit<ScanValuationInput, 'id' | 'kalshiUrl' | 'polymarketUrl' | 'scanCapital'> & {
  kalshiUrl: string;
  polymarketUrl: string;
  scanCapital: number;
};

function valuationKey(input: ValuationInput): string {
  return JSON.stringify([
    input.kalshiUrl,
    input.polymarketUrl,
    input.scanCapital,
    input.candidates.map((candidate) => [candidate.kalshiTicker, candidate.pmConditionId, candidate.arbType, candidate.strategy]).sort(),
  ]);
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

async function withPairPermit<T>(operation: () => Promise<T>): Promise<T> {
  if (activePairValuations >= MAX_PAIR_CONCURRENCY) {
    await new Promise<void>((resolve) => pairWaiters.push(resolve));
  }
  activePairValuations += 1;
  try {
    return await operation();
  } finally {
    activePairValuations -= 1;
    pairWaiters.shift()?.();
  }
}

function matchesCapturedCandidate(
  result: ReturnType<typeof computeAllLiveArbitrages>[number],
  candidates: ValuationInput['candidates'],
): boolean {
  const normalizeStrategy = (strategy: string) => strategy.replace(/Polymarket/g, 'PM');
  return candidates.some((candidate) => candidate.kalshiTicker === result.kalshiTicker
    && candidate.pmConditionId === result.pmConditionId
    && candidate.arbType === result.arbType
    && normalizeStrategy(candidate.strategy) === normalizeStrategy(result.strategy));
}

async function valuePair(input: ValuationInput): Promise<Omit<CurrentLogRoiValuation, 'id'>> {
  const key = valuationKey(input);
  const cached = cache.get(key);
  if (cached && Date.now() - cached.fetchedAt <= CACHE_TTL_MS) return cached.valuation;
  const pending = inFlight.get(key);
  if (pending) return pending;

  const request = withPairPermit(async () => {
    try {
      const capital = input.scanCapital;
      const resolved = await resolvePairFromLinks([
        { platform: 'kalshi', url: input.kalshiUrl },
        { platform: 'polymarket', url: input.polymarketUrl },
      ], capital);
      await seedAllBooks(resolved.kalshiTickers, resolved.pmTokenIds, resolved.pmTokenSides);
      const results = computeAllLiveArbitrages(resolved.matchedOutcomes, capital, resolved.category);
      const eligible = results.filter((result) => matchesCapturedCandidate(result, input.candidates));
      if (eligible.length === 0) return { status: 'unavailable_book' as const };

      const executable = eligible
        .filter((result) => !result.stale)
        .filter((result) => result.kalshiStake + result.pmStake > 0 && Number.isFinite(result.roiPct))
        .sort((left, right) => right.roiPct - left.roiPct);
      const best = executable[0];
      if (!best) {
        if (eligible.some((result) => result.stale)) {
          const requiredIds = eligible.flatMap((result) => [result.kalshiTicker, result.pmYesTokenId, result.pmNoTokenId])
            .filter((id): id is string => typeof id === 'string');
          return { status: requiredIds.some((id) => !orderbookState.hasBook(id)) ? 'unavailable_book' as const : 'stale_quote' as const };
        }
        return { status: 'insufficient_depth' as const };
      }
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
  }).then((valuation) => {
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
  const values: CurrentLogRoiValuation[] = [];
  const queue = [...uniqueIds];
  const workers = Array.from({ length: Math.min(3, queue.length) }, async () => {
    while (queue.length > 0) {
      const id = queue.shift();
      if (id === undefined) return;
      const input = byId.get(id);
      if (!input?.kalshiUrl || !input.polymarketUrl) {
        values.push({ id, status: 'missing_links' });
        continue;
      }
      if (!input.scanCapital || input.candidates.length === 0) {
        values.push({ id, status: 'missing_identifiers' });
        continue;
      }
      values.push({ id, ...(await valuePair({
      kalshiUrl: input.kalshiUrl,
      polymarketUrl: input.polymarketUrl,
        scanCapital: input.scanCapital,
        candidates: input.candidates,
      })) });
    }
  });
  await Promise.all(workers);
  const byValueId = new Map(values.map((value) => [value.id, value]));
  return uniqueIds.map((id) => byValueId.get(id) ?? { id, status: 'missing_links' });
}

export function resetCurrentLogRoiStateForTests(): void {
  cache.clear();
  inFlight.clear();
  activePairValuations = 0;
  pairWaiters.splice(0).forEach((resolve) => resolve());
}
