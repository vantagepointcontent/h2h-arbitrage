// Live arbitrage engine: combines Kalshi + Polymarket local orderbooks
// and runs the existing matcher fee/arb logic against weighted ask prices.

import { orderbookState, WeightedAskResult } from './orderbook-state';
import { calculateArbitrageMax, computeArbitrageFees, calcKalshiFee, calcPolymarketFee, getPolymarketTheta } from './matcher';

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
  /** Contracts at the exact displayed effective top ask; used to cap manual execution. */
  kalshiYesAskShares?: number;
  kalshiNoAskShares?: number;
  pmYesAskShares?: number;
  pmNoAskShares?: number;
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
  /** True when any underlying orderbook is missing or older than the staleness threshold. */
  stale: boolean;
  lastUpdate: string;
  /** HOOKUP-04: leg identifiers so the UI can build a manual execution request. */
  kalshiTicker?: string;
  pmYesTokenId?: string;
  pmNoTokenId?: string;
  /** ARB-01a: classification of the arb strategy.
   *  - "direct": regular YES/NO across platforms (within-outcome)
   *  - "cross": cross-outcome YES+YES across platforms
   *  - "internal": same-platform YES+YES (FEAT-016) */
  arbType: 'cross' | 'direct' | 'internal';
  /** HOOKUP-02 (FEAT-004): likelihood-to-last rating, attached by persistence-tracker. */
  persistence?: import('./persistence-score').PersistenceScore;
  /** HOOKUP-03 (FEAT-005): arb-formation signal, attached by persistence-tracker. */
  formation?: {
    signal: 'FORMING' | 'STABLE' | 'DIVERGING';
    minutesToArb: number | null;
    predictedSpread: number;
    kalshiVelocity1min: number;
    pmVelocity1min: number;
    isSpike: boolean;
  };
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

  // Staleness guard: don't compute arbs against dead/disconnected orderbooks.
  // BUG-06: Increased from 30s to 60s — the 30s window was too aggressive and
  // caused "Stale" status after ~1 minute when WS updates paused briefly.
  // WS auto-reconnect takes up to 30s (exponential backoff), so the stale
  // window must be longer than the reconnect window.
  const STALE_MS = Number(process.env.H2H_BOOK_STALE_MS || 60_000);
  const stale =
    orderbookState.isStale(kalshiTicker, STALE_MS) ||
    orderbookState.isStale(pmYesTokenId, STALE_MS) ||
    orderbookState.isStale(pmNoTokenId, STALE_MS);

  const kYes = orderbookState.getWeightedAsk(kalshiTicker, 'yes', capital);
  const kNo = orderbookState.getWeightedAsk(kalshiTicker, 'no', capital);
  const pYes = orderbookState.getWeightedAsk(pmYesTokenId, 'yes', capital);
  const pNo = orderbookState.getWeightedAsk(pmNoTokenId, 'no', capital);

  // BUG-06: Use top-of-book price for ROI calculation to match the scan API,
  // which uses yesAsk/noAsk from REST (top-of-book). The weighted average
  // price (avgPrice) was causing ROI mismatch because it includes slippage
  // from deeper orderbook levels. The scan API doesn't account for slippage
  // either, so using top-of-book makes both paths consistent.
  // We still pass totalCost (fillable depth) to calculateArbitrageMax for
  // depth-based capital capping.

  // The displayed quote and its depth must come from the exact same level.
  // Kalshi asks derived from opposite bids below the REST-seeded real floor are
  // synthetic and cannot be used for either a displayed price or execution.
  const getEffectiveTopAsk = (id: string, side: 'yes' | 'no', useKalshiFloor: boolean) => {
    const book = orderbookState.getBook(id);
    const floor = useKalshiFloor ? (side === 'yes' ? book?.realYesAsk : book?.realNoAsk) : undefined;
    return book?.[side].asks.find((level) => floor == null || level.price >= floor - 1e-9) ?? null;
  };

  const kalshiYesLevel = getEffectiveTopAsk(kalshiTicker, 'yes', true);
  const kalshiNoLevel = getEffectiveTopAsk(kalshiTicker, 'no', true);
  const pmYesLevel = getEffectiveTopAsk(pmYesTokenId, 'yes', false);
  const pmNoLevel = getEffectiveTopAsk(pmNoTokenId, 'no', false);
  const kalshiYesAsk = kalshiYesLevel?.price ?? (kYes.avgPrice > 0 ? kYes.avgPrice : null);
  const kalshiNoAsk = kalshiNoLevel?.price ?? (kNo.avgPrice > 0 ? kNo.avgPrice : null);
  const pmYesAsk = pmYesLevel?.price ?? (pYes.avgPrice > 0 ? pYes.avgPrice : null);
  const pmNoAsk = pmNoLevel?.price ?? (pNo.avgPrice > 0 ? pNo.avgPrice : null);

  const kalshiYesAskShares = kalshiYesLevel?.quantity ?? 0;
  const kalshiNoAskShares = kalshiNoLevel?.quantity ?? 0;
  const pmYesAskShares = pmYesLevel?.quantity ?? 0;
  const pmNoAskShares = pmNoLevel?.quantity ?? 0;

  // Dollar depth remains for the existing scanner display/capital calculations,
  // but it is intentionally derived from the same effective quote selected above.
  const kalshiYesDepth = kalshiYesAsk != null ? kalshiYesAsk * kalshiYesAskShares : 0;
  const kalshiNoDepth = kalshiNoAsk != null ? kalshiNoAsk * kalshiNoAskShares : 0;
  const pmYesDepth = pmYesAsk != null ? pmYesAsk * pmYesAskShares : 0;
  const pmNoDepth = pmNoAsk != null ? pmNoAsk * pmNoAskShares : 0;

  let strategy = 'No arb';
  let roiPct = 0;
  let expectedProfit = 0;
  let kalshiStake = 0;
  let pmStake = 0;
  let fees: LiveArbResult['fees'] = null;

  const allAvailable = kalshiYesAsk != null && kalshiNoAsk != null && pmYesAsk != null && pmNoAsk != null;

  if (allAvailable && !stale) {
    // Depth args must be in DOLLARS (calculateArbitrageMax does depth/price
    // to derive contract capital) — use totalCost (fillable dollars up to
    // `capital`), NOT maxQuantity (contracts). Also forward the user's
    // capital as maxCapital instead of the silent 1000 default, so live WS
    // matches the manual scan path (BUG-031b).
    const candidate = calculateArbitrageMax(
      { yesAsk: kalshiYesAsk, noAsk: kalshiNoAsk } as any,
      { bestAsk: pmYesAsk, noPrice: pmNoAsk } as any,
      kYes.totalCost,
      kNo.totalCost,
      pYes.totalCost,
      pNo.totalCost,
      category,
      capital,
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
    kalshiYesAskShares,
    kalshiNoAskShares,
    pmYesAskShares,
    pmNoAskShares,
    strategy,
    roiPct,
    expectedProfit,
    kalshiStake,
    pmStake,
    fees,
    stale,
    kalshiTicker,
    pmYesTokenId,
    pmNoTokenId,
    arbType: 'direct',
    lastUpdate: new Date().toISOString(),
  };
}

/** Compute arbitrage for all matched outcomes in one pass.
 *  Includes cross-outcome ("Buy YES both sides") arbs for strict binary markets,
 *  mirroring calculateBestArbitrageForOutcome in matcher.ts. */
export function computeAllLiveArbitrages(
  outcomes: LiveMatchedOutcome[],
  capital: number,
  category?: string,
): LiveArbResult[] {
  const results = outcomes.map((o) => computeSingleOutcome(o, capital, category));

  // Cross-outcome pass: only for strict binary (exactly 2 outcomes), same rule as manual scan.
  if (results.length === 2) {
    for (let i = 0; i < 2; i++) {
      const cur = results[i];
      const comp = results[1 - i];
      if (cur.stale || comp.stale) continue;
      const kYesA = cur.kalshiYesAsk;
      const pYesB = comp.pmYesAsk;
      if (kYesA == null || pYesB == null || cur.kalshiNoAsk == null || comp.pmNoAsk == null) continue;
      if (kYesA + pYesB >= 1) continue;

      // Capital limited by ask depth on both legs (mirrors manual scan's leg caps)
      const capK = cur.kalshiYesDepth > 0 ? cur.kalshiYesDepth / kYesA : Infinity;
      const capP = comp.pmYesDepth > 0 ? comp.pmYesDepth / pYesB : Infinity;
      const capped = Math.min(capK, capP, capital);
      const effectiveCapital = isFinite(capped) && capped > 0 ? capped : capital;
      const kalshiStake = effectiveCapital * kYesA;
      const pmStake = effectiveCapital * pYesB;
      const fees = computeArbitrageFees(
        `Buy YES both sides: Kalshi ${cur.artist} + Polymarket ${comp.artist}`,
        effectiveCapital,
        kalshiStake,
        pmStake,
        kYesA,
        cur.kalshiNoAsk,
        pYesB,
        comp.pmNoAsk,
        category,
      );
      if (fees.worstCaseNetProfit > cur.expectedProfit) {
        cur.strategy = `Buy YES both sides: Kalshi ${cur.artist} + PM ${comp.artist}`;
        cur.arbType = 'cross';
        cur.roiPct = effectiveCapital > 0 ? (fees.worstCaseNetProfit / effectiveCapital) * 100 : 0;
        cur.expectedProfit = fees.worstCaseNetProfit;
        cur.kalshiStake = kalshiStake;
        cur.pmStake = pmStake;
        cur.fees = {
          kalshiFee: fees.kalshiFee,
          pmFee: fees.pmFee,
          worstCaseNetProfit: fees.worstCaseNetProfit,
        };
      }
    }
  }

    // Internal arb pass: same-platform YES+YES on strict binary markets.
    // Mirrors FEAT-016 in matcher.ts (lines 619-719).
    if (results.length === 2) {
      for (let i = 0; i < 2; i++) {
        const cur = results[i];
        const comp = results[1 - i];
        if (cur.stale || comp.stale) continue;

        // ── Kalshi same-platform YES+YES ──
        const kYesA = cur.kalshiYesAsk;
        const kYesB = comp.kalshiYesAsk;
        if (kYesA != null && kYesB != null && kYesA > 0 && kYesB > 0 && kYesA + kYesB < 1) {
          const capKA = cur.kalshiYesDepth > 0 ? cur.kalshiYesDepth / kYesA : Infinity;
          const capKB = comp.kalshiYesDepth > 0 ? comp.kalshiYesDepth / kYesB : Infinity;
          const capped = Math.min(capKA, capKB, capital);
          const effectiveCapital = isFinite(capped) && capped > 0 ? capped : capital;
          if (effectiveCapital > 0) {
            const stakeA = effectiveCapital * kYesA;
            const stakeB = effectiveCapital * kYesB;
            const grossProfit = effectiveCapital - stakeA - stakeB;
            const contractsA = stakeA / kYesA;
            const contractsB = stakeB / kYesB;
            const feeA = calcKalshiFee(contractsA, kYesA);
            const feeB = calcKalshiFee(contractsB, kYesB);
            const totalFee = feeA + feeB;
            const netProfit = grossProfit - totalFee;
            const roiPct = effectiveCapital > 0 ? (netProfit / effectiveCapital) * 100 : 0;
            if (netProfit > cur.expectedProfit) {
              cur.strategy = `Same-platform YES+YES Kalshi: ${cur.artist} + ${comp.artist}`;
              cur.arbType = 'internal';
              cur.roiPct = roiPct;
              cur.expectedProfit = netProfit;
              cur.kalshiStake = stakeA + stakeB;
              cur.pmStake = 0;
              cur.fees = { kalshiFee: totalFee, pmFee: 0, worstCaseNetProfit: netProfit };
            }
          }
        }

        // ── Polymarket same-platform YES+YES ──
        const pYesA = cur.pmYesAsk;
        const pYesB = comp.pmYesAsk;
        if (pYesA != null && pYesB != null && pYesA > 0 && pYesB > 0 && pYesA + pYesB < 1) {
          const capPA = cur.pmYesDepth > 0 ? cur.pmYesDepth / pYesA : Infinity;
          const capPB = comp.pmYesDepth > 0 ? comp.pmYesDepth / pYesB : Infinity;
          const capped = Math.min(capPA, capPB, capital);
          const effectiveCapital = isFinite(capped) && capped > 0 ? capped : capital;
          if (effectiveCapital > 0) {
            const stakeA = effectiveCapital * pYesA;
            const stakeB = effectiveCapital * pYesB;
            const grossProfit = effectiveCapital - stakeA - stakeB;
            const pmTheta = getPolymarketTheta(category);
            const contractsA = stakeA / pYesA;
            const contractsB = stakeB / pYesB;
            const feeA = calcPolymarketFee(contractsA, pYesA, pmTheta);
            const feeB = calcPolymarketFee(contractsB, pYesB, pmTheta);
            const totalFee = feeA + feeB;
            const netProfit = grossProfit - totalFee;
            const roiPct = effectiveCapital > 0 ? (netProfit / effectiveCapital) * 100 : 0;
            if (netProfit > cur.expectedProfit) {
              cur.strategy = `Same-platform YES+YES Polymarket: ${cur.artist} + ${comp.artist}`;
              cur.arbType = 'internal';
              cur.roiPct = roiPct;
              cur.expectedProfit = netProfit;
              cur.kalshiStake = 0;
              cur.pmStake = stakeA + stakeB;
              cur.fees = { kalshiFee: 0, pmFee: totalFee, worstCaseNetProfit: netProfit };
            }
          }
        }
      }
    }

  return results;
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
