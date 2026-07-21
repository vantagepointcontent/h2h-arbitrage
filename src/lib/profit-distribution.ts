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
  splitPct: number;
  totalStake: number;
  kalshiStake: number;
  pmStake: number;
  kalshiContracts: number;
  pmContracts: number;
  kalshiFee: number;
  pmFee: number;
  totalFees: number;
  netProfitIfKalshiWins: number;
  netProfitIfPmWins: number;
  worstCaseNetProfit: number;
  bestCaseNetProfit: number;
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

  const totalStake = baseKalshiStake + basePmStake;
  if (!(totalStake > 0)) throw new Error('Profit distribution requires a positive total stake');

  const splitPct = Math.min(100, Math.max(0, input.splitPct));
  const balancedKalshiFraction = baseKalshiStake / totalStake;
  // 50% exactly reproduces the scanner's hedged stake ratio; endpoints are 0% / 100%.
  const kalshiFraction = splitPct <= 50
    ? balancedKalshiFraction * (splitPct / 50)
    : balancedKalshiFraction + (1 - balancedKalshiFraction) * ((splitPct - 50) / 50);
  const kalshiStake = totalStake * kalshiFraction;
  const pmStake = totalStake - kalshiStake;
  const kalshiContracts = kalshiStake / kalshiPrice;
  const pmContracts = pmStake / pmPrice;
  const kalshiFee = calcKalshiFee(kalshiContracts, kalshiPrice);
  const pmFee = calcPolymarketFee(pmContracts, pmPrice, getPolymarketTheta(input.category));
  const totalFees = kalshiFee + pmFee;

  // One selected contract pays $1 on the winning side. Both order fees are paid
  // at execution, independent of which side resolves.
  const netProfitIfKalshiWins = kalshiContracts - totalStake - totalFees;
  const netProfitIfPmWins = pmContracts - totalStake - totalFees;

  return {
    splitPct,
    totalStake,
    kalshiStake,
    pmStake,
    kalshiContracts,
    pmContracts,
    kalshiFee,
    pmFee,
    totalFees,
    netProfitIfKalshiWins,
    netProfitIfPmWins,
    worstCaseNetProfit: Math.min(netProfitIfKalshiWins, netProfitIfPmWins),
    bestCaseNetProfit: Math.max(netProfitIfKalshiWins, netProfitIfPmWins),
  };
}
