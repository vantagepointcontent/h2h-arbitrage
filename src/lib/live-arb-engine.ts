// Live arbitrage engine: combines Kalshi + Polymarket local orderbooks
// and runs the existing matcher fee/arb logic against weighted ask prices.

import { orderbookState, WeightedAskResult } from './orderbook-state';
import { calculateArbitrageMax } from './matcher';

export interface LiveArbInputs {
  kalshiTicker: string;
  pmYesTokenId: string;
  pmNoTokenId: string;
  capital: number;
  category?: string;
}

export interface LiveArbResult {
  artist: string;
  kalshiYesAsk: number | null;
  kalshiNoAsk: number | null;
  kalshiYesDepth: number;
  kalshiNoDepth: number;
  pmYesAsk: number | null;
  pmNoAsk: number | null;
  pmYesDepth: number;
  pmNoDepth: number;
  strategy: string;
  roiPct: number;
  expectedProfit: number;
  kalshiStake: number;
  pmStake: number;
  fees: {
    kalshiFee: number;
    pmFee: number;
    worstCaseNetProfit: number;
  } | null;
  lastUpdate: string;
}

/** A single matched outcome for live scanning. */
export interface LiveMatchedOutcome {
  artist: string;
  kalshiTicker: string;
  pmYesTokenId: string;
  pmNoTokenId: string;
}

/** Compute arbitrage for a single matched outcome. */
function computeSingleOutcome(
  outcome: LiveMatchedOutcome,
  capital: number,
  category?: string,
): LiveArbResult {
  const { artist, kalshiTicker, pmYesTokenId, pmNoTokenId } = outcome;

  const kYes = orderbookState.getWeightedAsk(kalshiTicker, 'yes', capital);
  const kNo = orderbookState.getWeightedAsk(kalshiTicker, 'no', capital);
  const pYes = orderbookState.getWeightedAsk(pmYesTokenId, 'yes', capital);
  const pNo = orderbookState.getWeightedAsk(pmNoTokenId, 'no', capital);

  // If no weighted price is available, fall back to top-of-book when possible
  const fallback = (res: WeightedAskResult): number | null =>
    res.avgPrice > 0 ? res.avgPrice : null;

  const kalshiYesAsk = fallback(kYes);
  const kalshiNoAsk = fallback(kNo);
  const pmYesAsk = fallback(pYes);
  const pmNoAsk = fallback(pNo);

  // Depth = how many dollars of ask liquidity exists at the top of book for display
  const kYesBook = orderbookState.getBook(kalshiTicker)?.yes.asks;
  const kNoBook = orderbookState.getBook(kalshiTicker)?.no.asks;
  const pYesBook = orderbookState.getBook(pmYesTokenId)?.yes.asks;
  const pNoBook = orderbookState.getBook(pmNoTokenId)?.no.asks;

  const topDepth = (levels?: { price: number; quantity: number }[]) => {
    if (!levels?.length) return 0;
    return levels[0].price * levels[0].quantity;
  };

  const kalshiYesDepth = topDepth(kYesBook);
  const kalshiNoDepth = topDepth(kNoBook);
  const pmYesDepth = topDepth(pYesBook);
  const pmNoDepth = topDepth(pNoBook);

  let strategy = 'No arb';
  let roiPct = 0;
  let expectedProfit = 0;
  let kalshiStake = 0;
  let pmStake = 0;
  let fees: LiveArbResult['fees'] = null;

  const allAvailable = kalshiYesAsk != null && kalshiNoAsk != null && pmYesAsk != null && pmNoAsk != null;

  if (allAvailable) {
    const candidate = calculateArbitrageMax(
      { yesAsk: kalshiYesAsk, noAsk: kalshiNoAsk },
      { bestAsk: pmYesAsk, noPrice: pmNoAsk },
      kYes.maxQuantity,
      kNo.maxQuantity,
      pYes.maxQuantity,
      pNo.maxQuantity,
      category,
    );

    strategy = candidate.strategy;
    roiPct = candidate.roiPct;
    expectedProfit = candidate.expectedProfit;
    kalshiStake = candidate.kalshiStake;
    pmStake = candidate.pmStake;
    if (candidate.fees) {
      fees = {
        kalshiFee: candidate.fees.kalshiFee,
        pmFee: candidate.fees.pmFee,
        worstCaseNetProfit: candidate.fees.worstCaseNetProfit,
      };
    }
  }

  return {
    artist,
    kalshiYesAsk,
    kalshiNoAsk,
    kalshiYesDepth,
    kalshiNoDepth,
    pmYesAsk,
    pmNoAsk,
    pmYesDepth,
    pmNoDepth,
    strategy,
    roiPct,
    expectedProfit,
    kalshiStake,
    pmStake,
    fees,
    lastUpdate: new Date().toISOString(),
  };
}

/** Compute arbitrage for all matched outcomes in one pass. */
export function computeAllLiveArbitrages(
  outcomes: LiveMatchedOutcome[],
  capital: number,
  category?: string,
): LiveArbResult[] {
  return outcomes.map((o) => computeSingleOutcome(o, capital, category));
}

// Legacy wrapper kept for backward compatibility
export function computeLiveArbitrage(inputs: LiveArbInputs): LiveArbResult {
  return computeSingleOutcome(
    {
      artist: inputs.category || '',
      kalshiTicker: inputs.kalshiTicker,
      pmYesTokenId: inputs.pmYesTokenId,
      pmNoTokenId: inputs.pmNoTokenId,
    },
    inputs.capital,
    inputs.category,
  );
}

// Helpers for direct Polymarket book updates from the WS message format
// Each token_id represents a specific outcome (YES or NO). The caller must
// specify which side this token is so we store it correctly.
export function applyPolymarketBook(tokenId: string, asks: { price: string; size: string }[], side: 'yes' | 'no' = 'yes'): void {
  const levels = asks
    .map((a) => ({ price: parseFloat(a.price), quantity: parseFloat(a.size) }))
    .filter((a) => a.price > 0 && a.quantity > 0)
    .sort((a, b) => a.price - b.price);

  const existing = orderbookState.getBook(tokenId);
  if (existing) {
    // Update only the specified side, preserve the other
    const yesAsks = side === 'yes' ? levels : existing.yes.asks;
    const noAsks = side === 'no' ? levels : existing.no.asks;
    orderbookState.setBook(tokenId, yesAsks, noAsks);
  } else {
    // First time: seed the specified side
    orderbookState.setBook(tokenId, side === 'yes' ? levels : [], side === 'no' ? levels : []);
  }
}
