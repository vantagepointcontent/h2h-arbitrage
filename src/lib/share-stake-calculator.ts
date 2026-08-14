import { computeArbitrageFees } from './matcher';
import type { KalshiFeeAuthority } from './kalshi-fee-quote';

export type ShareStakeStrategy = 'Buy YES Kalshi + NO PM' | 'Buy YES PM + NO Kalshi';

export interface ShareStakeInput {
  strategy: ShareStakeStrategy;
  shares: number;
  kalshiYesAsk: number;
  kalshiNoAsk: number;
  pmYesAsk: number;
  pmNoAsk: number;
  kalshiAvailableShares: number | null;
  pmAvailableShares: number | null;
  category?: string;
  kalshiFeeAuthority?: KalshiFeeAuthority;
}

export interface ShareStakeCalculation {
  requestedContracts: 1;
  kalshiPrice: number;
  pmPrice: number;
  kalshiCost: number;
  pmCost: number;
  totalCost: number;
  kalshiFee: number;
  pmFee: number;
  netProfit: number;
  netProfitPct: number;
  kalshiAvailableShares: number | null;
  pmAvailableShares: number | null;
  exceedsKalshiDepth: boolean;
  exceedsPmDepth: boolean;
}

/**
 * Prices a manual, equal-share two-leg arb using the same fee implementation as
 * the scanner. Unknown depth deliberately stays null: it is not safe to imply a
 * fillable order when CLOB ask-level data was not returned.
 */
export function calculateShareStake(input: ShareStakeInput): ShareStakeCalculation | null {
  const shares = input.shares === 1 ? 1 : 0;
  const isKalshiYes = input.strategy === 'Buy YES Kalshi + NO PM';
  const kalshiPrice = isKalshiYes ? input.kalshiYesAsk : input.kalshiNoAsk;
  const pmPrice = isKalshiYes ? input.pmNoAsk : input.pmYesAsk;

  if (!shares || !isPrice(kalshiPrice) || !isPrice(pmPrice)) return null;

  const kalshiCost = shares * kalshiPrice;
  const pmCost = shares * pmPrice;
  const totalCost = kalshiCost + pmCost;
  const fees = computeArbitrageFees(
    input.strategy,
    shares,
    kalshiCost,
    pmCost,
    input.kalshiYesAsk,
    input.kalshiNoAsk,
    input.pmYesAsk,
    input.pmNoAsk,
    input.category,
    input.kalshiFeeAuthority,
  );
  const netProfit = fees.worstCaseNetProfit;

  return {
    requestedContracts: 1,
    kalshiPrice,
    pmPrice,
    kalshiCost,
    pmCost,
    totalCost,
    kalshiFee: fees.kalshiFee,
    pmFee: fees.pmFee,
    netProfit,
    netProfitPct: totalCost > 0 ? (netProfit / totalCost) * 100 : 0,
    kalshiAvailableShares: validDepth(input.kalshiAvailableShares),
    pmAvailableShares: validDepth(input.pmAvailableShares),
    exceedsKalshiDepth: input.kalshiAvailableShares != null && shares > input.kalshiAvailableShares,
    exceedsPmDepth: input.pmAvailableShares != null && shares > input.pmAvailableShares,
  };
}

function isPrice(value: number): boolean {
  return Number.isFinite(value) && value > 0 && value < 1;
}

function validDepth(value: number | null): number | null {
  return value != null && Number.isFinite(value) && value > 0 ? value : null;
}

/** Only accept an actual positive numeric ask-level quantity, never display liquidity as depth. */
export function parseAskLevelDepth(value: string | number | null | undefined): number | null {
  if (typeof value === 'number') return validDepth(value);
  if (typeof value !== 'string' || !/^\d+(?:\.\d+)?$/.test(value.trim())) return null;
  return validDepth(Number(value));
}
