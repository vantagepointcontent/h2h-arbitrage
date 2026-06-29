/**
 * Liquidity-aware stake sizing.
 *
 * Calculates realistic position sizes based on actual orderbook depth
 * so traders can see how much capital they can actually deploy versus
 * the theoretical infinite-liquidity assumption.
 */

export interface LiquidityAnalysis {
  /** Maximum stake that can be deployed at current prices */
  maxFillableStake: number;
  /** Available liquidity on Kalshi side (dollar depth) */
  kalshiDepth: number;
  /** Available liquidity on Polymarket side (dollar depth, Infinity per project rule) */
  polymarketDepth: number;
  /** True if maxFillableStake >= $100 */
  isLiquid: boolean;
  /** none=$10K+, low=$1K-$10K, critical=<$1K */
  warningLevel: 'none' | 'low' | 'critical';
  /** Estimated price impact in percent for the max fillable stake */
  slippageEstimate: number;
  /** Profit on max fillable stake (net of fees and slippage) */
  realisticProfit: number;
  /** Profit if infinite liquidity (current behaviour) */
  theoreticalProfit: number;
  /** realisticProfit / theoreticalProfit (0–1) */
  realToTheoreticalRatio: number;
}

/**
 * Analyse liquidity constraints for a cross-platform arbitrage.
 *
 * @param kalshiAskPrice - Yes-side ask price on Kalshi (0–1)
 * @param kalshiAskDepth - Dollar depth available at the Kalshi ask
 * @param polymarketAskPrice - Ask price on Polymarket (0–1)
 * @param polymarketDepth - Dollar depth on Polymarket (Infinity per project rule)
 * @param kalshiNoPrice - No-side price on Kalshi (0–1)
 * @param polymarketNoPrice - No-side price on Polymarket (0–1)
 * @param fees - Fee rates for each platform
 */
export function analyzeLiquidity(
  kalshiAskPrice: number,
  kalshiAskDepth: number,
  polymarketAskPrice: number,
  polymarketDepth: number,
  kalshiNoPrice: number,
  polymarketNoPrice: number,
  fees: { kalshiFee: number; pmFee: number },
): LiquidityAnalysis {
  // --- max fillable stake ---
  // Binding constraint: min(dollar depth on each side)
  const maxFillableStake = Math.min(kalshiAskDepth, polymarketDepth);

  // --- slippage tiers ---
  const bindingDepth = maxFillableStake;
  let slippageEstimate: number;
  if (bindingDepth < 500) {
    slippageEstimate = 2;
  } else if (bindingDepth < 2000) {
    slippageEstimate = 1;
  } else {
    slippageEstimate = 0.5;
  }

  // --- spread (arbitrage edge) ---
  // Using Kalshi YES ask vs Polymarket NO price as representative spread
  const spread = 1 - (kalshiAskPrice + polymarketNoPrice);

  // --- fee overhead ---
  const totalFees = fees.kalshiFee + fees.pmFee;

  // --- profits ---
  const theoreticalProfit = maxFillableStake * (spread - totalFees);
  const realisticProfit = maxFillableStake * (spread - totalFees - slippageEstimate / 100);

  // --- ratio ---
  let realToTheoreticalRatio: number;
  if (theoreticalProfit <= 0) {
    realToTheoreticalRatio = realisticProfit <= 0 ? 0 : 1;
  } else {
    realToTheoreticalRatio = realisticProfit / theoreticalProfit;
  }

  // Clamp to [0, 1] for degenerate cases
  if (realToTheoreticalRatio < 0) realToTheoreticalRatio = 0;
  if (realToTheoreticalRatio > 1) realToTheoreticalRatio = 1;

  // --- derived flags ---
  const isLiquid = maxFillableStake >= 100;

  let warningLevel: 'none' | 'low' | 'critical';
  if (maxFillableStake >= 10000) {
    warningLevel = 'none';
  } else if (maxFillableStake >= 1000) {
    warningLevel = 'low';
  } else {
    warningLevel = 'critical';
  }

  return {
    maxFillableStake,
    kalshiDepth: kalshiAskDepth,
    polymarketDepth: polymarketDepth,
    isLiquid,
    warningLevel,
    slippageEstimate,
    realisticProfit,
    theoreticalProfit,
    realToTheoreticalRatio,
  };
}
