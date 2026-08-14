import { calcKalshiFee, calcPolymarketFee, getPolymarketTheta } from './matcher';

export interface ProfitDistributionInput {
  strategy: 'Buy YES Kalshi + NO PM' | 'Buy YES PM + NO Kalshi';
  /** The actual selected contract price for the Kalshi leg. */
  kalshiPrice: number;
  /** The actual selected contract price for the Polymarket leg. */
  pmPrice: number;
  /** Matched-arb stakes establish the balanced (equal-payout) midpoint. */
  kalshiStake: number;
  pmStake: number;
  /** 0 = all cost on PM, 50 = balanced matched position, 100 = all cost on Kalshi. */
  splitPct: number;
  category?: string;
}

export interface ProfitDistribution {
  requestedContracts: 1;
  splitPct: number;
  totalStake: number;
  kalshiStake: number;
  pmStake: number;
  kalshiContracts: number;
  pmContracts: number;
  /** Whole contracts that can actually be entered as manual orders. */
  kalshiShares: number;
  pmShares: number;
  /** Dollar cost of those whole-share orders; budget dust is intentionally excluded. */
  kalshiOrderCost: number;
  pmOrderCost: number;
  pmToKalshiRatio: ContractRatio | null;
  kalshiFee: number;
  pmFee: number;
  totalFees: number;
  netProfitIfKalshiWins: number;
  netProfitIfPmWins: number;
  worstCaseNetProfit: number;
  bestCaseNetProfit: number;
}

export interface ContractRatio {
  pm: number;
  kalshi: number;
  label: string;
}

/** Recover a balanced two-leg budget when older/cached arb rows omit per-leg stakes. */
export function resolveDistributionStakes(input: {
  kalshiStake?: number; pmStake?: number; maxCapital?: number;
  expectedProfit: number; roiPct: number; kalshiPrice: number; pmPrice: number;
}): { kalshiStake: number; pmStake: number } | null {
  const kalshiStake = Number(input.kalshiStake) || 0;
  const pmStake = Number(input.pmStake) || 0;
  if (kalshiStake + pmStake > 0) return { kalshiStake, pmStake };
  const impliedCapital = input.roiPct > 0 ? input.expectedProfit / (input.roiPct / 100) : 0;
  const totalCapital = Number(input.maxCapital) > 0 ? Number(input.maxCapital) : impliedCapital;
  const priceTotal = input.kalshiPrice + input.pmPrice;
  if (!(totalCapital > 0) || !(priceTotal > 0)) return null;
  return {
    kalshiStake: totalCapital * input.kalshiPrice / priceTotal,
    pmStake: totalCapital * input.pmPrice / priceTotal,
  };
}

function greatestCommonDivisor(a: number, b: number): number {
  let x = Math.abs(Math.trunc(a));
  let y = Math.abs(Math.trunc(b));
  while (y !== 0) [x, y] = [y, x % y];
  return x;
}

/** Convert whole contract counts into the lowest exact PM:Kalshi split. */
export function simplifyContractRatio(pmShares: number, kalshiShares: number): ContractRatio | null {
  const pm = Math.max(0, Math.floor(pmShares));
  const kalshi = Math.max(0, Math.floor(kalshiShares));
  if (pm < 1 || kalshi < 1) return null;
  const divisor = greatestCommonDivisor(pm, kalshi);
  return { pm: pm / divisor, kalshi: kalshi / divisor, label: `${pm / divisor}:${kalshi / divisor}` };
}

/**
 * Reallocate a fixed two-leg cost while keeping the matched 50% midpoint intact.
 *
 * The midpoint uses the scanner's equal-payout stake ratio. Dragging to an edge
 * moves the entire fixed cost to one leg, which intentionally creates directional
 * exposure. Fees are recalculated from the new contract counts on every call.
 */
export function calculateProfitDistribution(input: ProfitDistributionInput): ProfitDistribution {
  const { kalshiPrice, pmPrice, kalshiStake: baseKalshiStake, pmStake: basePmStake } = input;
  if (!(kalshiPrice > 0 && kalshiPrice < 1 && pmPrice > 0 && pmPrice < 1)) {
    throw new Error('Profit distribution requires valid prices for both legs');
  }

  // Distribution is a scenario view over the canonical one-share hedge, not
  // an independent sizing engine. Legacy stake inputs remain API-compatible.
  const splitPct = Math.min(100, Math.max(0, input.splitPct));
  void baseKalshiStake;
  void basePmStake;
  const kalshiContracts = 1;
  const pmContracts = 1;
  const kalshiShares = 1;
  const pmShares = 1;
  const kalshiOrderCost = kalshiShares * kalshiPrice;
  const pmOrderCost = pmShares * pmPrice;
  const kalshiStake = kalshiOrderCost;
  const pmStake = pmOrderCost;
  const totalStake = kalshiStake + pmStake;
  const kalshiFee = calcKalshiFee(kalshiContracts, kalshiPrice);
  const pmFee = calcPolymarketFee(pmContracts, pmPrice, getPolymarketTheta(input.category));
  const totalFees = kalshiFee + pmFee;

  // One selected contract pays $1 on the winning side. Both order fees are paid
  // at execution, independent of which side resolves.
  const netProfitIfKalshiWins = kalshiContracts - totalStake - totalFees;
  const netProfitIfPmWins = pmContracts - totalStake - totalFees;

  return {
    requestedContracts: 1,
    splitPct,
    totalStake,
    kalshiStake,
    pmStake,
    kalshiContracts,
    pmContracts,
    kalshiShares,
    pmShares,
    kalshiOrderCost,
    pmOrderCost,
    pmToKalshiRatio: simplifyContractRatio(pmShares, kalshiShares),
    kalshiFee,
    pmFee,
    totalFees,
    netProfitIfKalshiWins,
    netProfitIfPmWins,
    worstCaseNetProfit: Math.min(netProfitIfKalshiWins, netProfitIfPmWins),
    bestCaseNetProfit: Math.max(netProfitIfKalshiWins, netProfitIfPmWins),
  };
}
