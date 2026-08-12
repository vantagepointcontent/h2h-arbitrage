import type { CouplingTombstone } from './coupling-store';
import {
  couplingKey,
  deleteCoupling,
  getDeletedCouplings,
  removeTombstoneById,
} from './coupling-store';

export type DecoupledPair = CouplingTombstone;

export async function getDecoupledPairs(): Promise<DecoupledPair[]> {
  return getDeletedCouplings();
}

export async function addDecoupledPair(
  pair: Omit<DecoupledPair, 'id' | 'couplingKey' | 'decoupledAt' | 'revision'>,
): Promise<DecoupledPair> {
  return deleteCoupling(pair);
}

export async function removeDecoupledPair(id: string): Promise<boolean> {
  return removeTombstoneById(id);
}

/** Split exact deleted tuples so either market remains eligible for unrelated matches. */
export function applyDecoupledPairs<T extends {
  kalshi: { ticker: string } | null;
  polymarket: { conditionId: string; marketId?: string } | null;
  arbitrage: Record<string, unknown>;
  artist: string;
}>(outcomes: T[], decoupledPairs: DecoupledPair[]): T[] {
  if (!decoupledPairs.length) return outcomes;
  const deleted = new Set(decoupledPairs.map((pair) => pair.couplingKey));
  const result: T[] = [];
  for (const outcome of outcomes) {
    if (outcome.kalshi && outcome.polymarket
      && deleted.has(couplingKey(outcome.kalshi.ticker, outcome.polymarket.conditionId))) {
      result.push(
        {
          ...outcome,
          polymarket: null,
          arbitrage: { ...outcome.arbitrage, strategy: 'No arb', expectedProfit: 0, roiPct: 0, apyPct: 0, kalshiStake: 0, pmStake: 0 },
        },
        {
          ...outcome,
          kalshi: null,
          artist: outcome.polymarket.marketId || outcome.polymarket.conditionId,
          arbitrage: { ...outcome.arbitrage, strategy: 'No arb', expectedProfit: 0, roiPct: 0, apyPct: 0, kalshiStake: 0, pmStake: 0 },
        },
      );
    } else {
      result.push(outcome);
    }
  }
  return result;
}

export function removeDeletedCouplingArbs<T extends {
  allArbs?: Array<{ kalshiTicker?: string; pmConditionId?: string; roiPct?: number; expectedProfit?: number; strategy?: string }>;
  bestRoiPct: number;
  bestProfit: number;
  strategy: string;
  matchedCount: number;
}>(result: T, pairs: DecoupledPair[]): T {
  if (!result.allArbs?.length || !pairs.length) return result;
  const deleted = new Set(pairs.map((pair) => pair.couplingKey));
  const allArbs = result.allArbs.filter((arb) => !arb.kalshiTicker || !arb.pmConditionId
    || !deleted.has(couplingKey(arb.kalshiTicker, arb.pmConditionId)));
  if (allArbs.length === result.allArbs.length) return result;
  const best = allArbs.reduce<typeof allArbs[number] | null>(
    (current, arb) => !current || Number(arb.roiPct) > Number(current.roiPct) ? arb : current,
    null,
  );
  return {
    ...result,
    allArbs,
    matchedCount: Math.max(0, result.matchedCount - (result.allArbs.length - allArbs.length)),
    bestRoiPct: best ? Number(best.roiPct) || 0 : 0,
    bestProfit: best ? Number(best.expectedProfit) || 0 : 0,
    strategy: best ? String(best.strategy || '') : 'No arb',
  };
}
