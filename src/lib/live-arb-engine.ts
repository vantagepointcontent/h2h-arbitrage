// Live arbitrage engine: combines Kalshi + Polymarket local orderbooks
// and runs the existing matcher fee/arb logic against weighted ask prices.

import { orderbookState } from './orderbook-state';
import { calculateArbitrageMax, computeArbitrageFees, calcKalshiFee, calcPolymarketFee, getPolymarketTheta } from './matcher';
import type { UnifiedOutcome } from './matcher';
import { finiteDecimal } from './market-price';
import type { ExecutableBookQuote } from './executable-book';
import { isPriceAlignedToTick } from './venue-constraints';
import { assertFreshKalshiFeeAuthority, type KalshiFeeAuthority } from './kalshi-fee-quote';

export interface LiveArbResult {
  artist: string;
  kalshiYesAsk: number | null;
  kalshiNoAsk: number | null;
  kalshiYesDepth: number;
  kalshiNoDepth: number;
  pmYesAsk: number | null;
  pmNoAsk: number | null;
  kalshiYesExecutableQuote?: ExecutableBookQuote;
  kalshiNoExecutableQuote?: ExecutableBookQuote;
  pmYesExecutableQuote?: ExecutableBookQuote;
  pmNoExecutableQuote?: ExecutableBookQuote;
  pmYesDepth: number;
  pmNoDepth: number;
  /** Full fillable dollar depth used by canonical direct-strategy allocation. */
  kalshiYesExecutableDepth?: number;
  kalshiNoExecutableDepth?: number;
  pmYesExecutableDepth?: number;
  pmNoExecutableDepth?: number;
  kalshiBookStale?: boolean;
  pmYesBookStale?: boolean;
  pmNoBookStale?: boolean;
  /** Book identifiers required by this exact strategy, excluding unrelated sides. */
  requiredBookIds?: string[];
  /** Contracts at the exact displayed effective top ask; used to cap manual execution. */
  kalshiYesAskShares?: number;
  kalshiNoAskShares?: number;
  pmYesAskShares?: number;
  pmNoAskShares?: number;
  pmYesMinOrderSize?: number | null;
  pmNoMinOrderSize?: number | null;
  pmYesTickSize?: number | null;
  pmNoTickSize?: number | null;
  requestedContracts?: 1;
  executionStatus?: 'executable' | 'non_executable' | 'unavailable';
  executionBlocker?: string;
  strategy: string;
  roiPct: number;
  expectedProfit: number;
  kalshiStake: number;
  pmStake: number;
  fees: {
    kalshiFee: number;
    pmFee: number;
    worstCaseNetProfit: number;
    kalshiFeeAuthority?: KalshiFeeAuthority;
  } | null;
  /** True when any underlying orderbook is missing or older than the staleness threshold. */
  stale: boolean;
  lastUpdate: string;
  /** HOOKUP-04: leg identifiers so the UI can build a manual execution request. */
  kalshiTicker?: string;
  pmYesTokenId?: string;
  pmNoTokenId?: string;
  /** Stable parent market identity used by execution and revalidation. */
  pmConditionId?: string;
  category?: string;
  kalshiFeeAuthority?: KalshiFeeAuthority;
  /** ARB-01a: classification of the arb strategy.
   *  - "direct": regular YES/NO across platforms (within-outcome)
   *  - "cross": cross-outcome YES+YES across platforms
   *  - "internal": same-platform YES+NO on one verified binary market */
  arbType: 'cross' | 'direct' | 'internal' | null;
  crossOutcomeMutuallyExclusiveVerified?: boolean;
  crossOutcomeExhaustiveVerified?: boolean;
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
  pmConditionId?: string;
  /** Gamma verified exact [Yes, No] outcomes and non-neg-risk settlement. */
  pmBinaryVerified?: boolean;
  pmYesMinOrderSize?: number | null;
  pmNoMinOrderSize?: number | null;
  pmYesTickSize?: number | null;
  pmNoTickSize?: number | null;
  /** Explicit event-resolution review; pair count alone is never sufficient. */
  crossOutcomeMutuallyExclusiveVerified?: boolean;
  crossOutcomeExhaustiveVerified?: boolean;
  kalshiFeeAuthority?: KalshiFeeAuthority;
}

export interface CapturedLiveArbIdentity {
  kalshiTicker: string;
  pmConditionId: string;
  strategy: string;
  arbType: 'cross' | 'direct' | 'internal';
}

export function parseBookStaleMs(value: unknown): number {
  const parsed = finiteDecimal(value);
  return parsed !== null && parsed > 0 ? parsed : 90_000;
}

/** Compute arbitrage for a single matched outcome. */
function computeSingleOutcome(
  outcome: LiveMatchedOutcome,
  capital: number,
  category?: string,
): LiveArbResult {
  const { artist, kalshiTicker, pmYesTokenId, pmNoTokenId, pmConditionId, pmBinaryVerified,
    pmYesMinOrderSize, pmNoMinOrderSize, pmYesTickSize, pmNoTickSize,
    crossOutcomeMutuallyExclusiveVerified, crossOutcomeExhaustiveVerified, kalshiFeeAuthority } = outcome;

  // Staleness guard: don't compute arbs against dead/disconnected orderbooks.
  // BUG-06: Increased from 30s to 60s — the 30s window was too aggressive and
  // caused "Stale" status after ~1 minute when WS updates paused briefly.
  // WS auto-reconnect takes up to 15s with the reduced backoff (BUG-104), so
  // the stale window must be longer than the reconnect window.
  // BUG-104: default raised from 60s to 90s to give 3 full reconnect cycles
  // before stale kicks in.
  const STALE_MS = parseBookStaleMs(process.env.H2H_BOOK_STALE_MS);

  // Staleness only blocks live execution math; we still surface the last known
  // quotes so users can see the market rather than seeing $0 profit/ROI.
  const kalshiBookStale = orderbookState.isDepthStale(kalshiTicker, STALE_MS);
  const pmYesBookStale = orderbookState.isDepthStale(pmYesTokenId, STALE_MS);
  const pmNoBookStale = orderbookState.isDepthStale(pmNoTokenId, STALE_MS);
  let feeAuthorityStale = false;
  if (kalshiFeeAuthority) {
    try {
      assertFreshKalshiFeeAuthority(kalshiFeeAuthority, new Date().toISOString());
    } catch {
      feeAuthorityStale = true;
    }
  }
  const stale = kalshiBookStale || pmYesBookStale || pmNoBookStale || feeAuthorityStale;

  const kYes = orderbookState.getWeightedAsk(kalshiTicker, 'yes', 1);
  const kNo = orderbookState.getWeightedAsk(kalshiTicker, 'no', 1);
  const pYes = orderbookState.getWeightedAsk(pmYesTokenId, 'yes', 1);
  const pNo = orderbookState.getWeightedAsk(pmNoTokenId, 'no', 1);
  const kalshiYesExecutableQuote = orderbookState.getExecutableQuote(kalshiTicker, 'yes');
  const kalshiNoExecutableQuote = orderbookState.getExecutableQuote(kalshiTicker, 'no');
  const pmYesExecutableQuote = orderbookState.getExecutableQuote(pmYesTokenId, 'yes');
  const pmNoExecutableQuote = orderbookState.getExecutableQuote(pmNoTokenId, 'no');

  // The executable price is the shared walker's exact one-share VWAP. When
  // top depth is sufficient this equals the minimum ask; otherwise it consumes
  // only the remainder needed from deeper levels.

  // The displayed quote and its depth must come from the exact same level.
  // Kalshi asks derived from opposite bids below the REST-seeded real floor are
  // synthetic and cannot be used for either a displayed price or execution.
  const getEffectiveTopAsk = (id: string, side: 'yes' | 'no', useKalshiFloor: boolean) => {
    const book = orderbookState.getBook(id);
    const floor = useKalshiFloor ? (side === 'yes' ? book?.realYesAsk : book?.realNoAsk) : undefined;
    const level = book?.[side].asks.find((level) => floor == null || level.price >= floor - 1e-9);
    // Kalshi's REST market quote can be present while its ask size is unknown.
    // Retain that quote for display, but attach zero shares so no execution path
    // can turn it into imaginary liquidity.
    return level ?? (floor != null ? { price: floor, quantity: 0 } : null);
  };

  const kalshiYesLevel = getEffectiveTopAsk(kalshiTicker, 'yes', true);
  const kalshiNoLevel = getEffectiveTopAsk(kalshiTicker, 'no', true);
  const pmYesLevel = getEffectiveTopAsk(pmYesTokenId, 'yes', false);
  const pmNoLevel = getEffectiveTopAsk(pmNoTokenId, 'no', false);
  const quotePrice = (quote: ExecutableBookQuote): number | null => quote.status === 'executable'
    && quote.vwapPriceMicroCents != null
    ? quote.vwapPriceMicroCents / 100_000_000
    : null;
  const quoteLimitPrice = (quote: ExecutableBookQuote): number | null => quote.status === 'executable'
    && quote.limitPriceMicroCents != null
    ? quote.limitPriceMicroCents / 100_000_000
    : null;
  const kalshiYesAsk = quotePrice(kalshiYesExecutableQuote)
    ?? kalshiYesLevel?.price
    ?? (kYes.avgPrice > 0 ? kYes.avgPrice : null);
  const kalshiNoAsk = quotePrice(kalshiNoExecutableQuote)
    ?? kalshiNoLevel?.price
    ?? (kNo.avgPrice > 0 ? kNo.avgPrice : null);
  const pmYesAsk = quotePrice(pmYesExecutableQuote)
    ?? pmYesLevel?.price
    ?? (pYes.avgPrice > 0 ? pYes.avgPrice : null);
  const pmNoAsk = quotePrice(pmNoExecutableQuote)
    ?? pmNoLevel?.price
    ?? (pNo.avgPrice > 0 ? pNo.avgPrice : null);

  const kalshiYesAskShares = kalshiYesExecutableQuote.status === 'executable' ? 1 : kalshiYesLevel?.quantity ?? 0;
  const kalshiNoAskShares = kalshiNoExecutableQuote.status === 'executable' ? 1 : kalshiNoLevel?.quantity ?? 0;
  const pmYesAskShares = pmYesExecutableQuote.status === 'executable' ? 1 : pmYesLevel?.quantity ?? 0;
  const pmNoAskShares = pmNoExecutableQuote.status === 'executable' ? 1 : pmNoLevel?.quantity ?? 0;

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
  let executionStatus: NonNullable<LiveArbResult['executionStatus']> = 'unavailable';
  let executionBlocker: string | undefined = 'Tradeable prices are unavailable';

  const allAvailable = kalshiYesAsk != null && kalshiNoAsk != null && pmYesAsk != null && pmNoAsk != null;
  const allExecutable = [
    kalshiYesExecutableQuote,
    kalshiNoExecutableQuote,
    pmYesExecutableQuote,
    pmNoExecutableQuote,
  ].every((quote) => quote.status === 'executable');

  // BUG-104: even when stale we keep the last known prices visible in the UI.
  // Live execution math is only skipped when prices are missing, so stale rows
  // show greyed-out data instead of zeroed ROI/profit.
  if (allAvailable && allExecutable) {
    // Depth args must be in DOLLARS (calculateArbitrageMax does depth/price
    // to derive contract capital) — use totalCost (fillable dollars up to
    // `capital`), NOT maxQuantity (contracts). Also forward the user's
    // capital as maxCapital instead of the silent 1000 default, so live WS
    // matches the manual scan path (BUG-031b).
    //
    // When stale, we cap deployed capital to 0 because we don't know if the
    // book is still fillable; the displayed quote remains for reference.
    const candidate = calculateArbitrageMax(
      { yesAsk: kalshiYesAsk, noAsk: kalshiNoAsk, feeAuthority: kalshiFeeAuthority } as Parameters<typeof calculateArbitrageMax>[0],
      {
        bestAsk: pmYesAsk,
        noPrice: pmNoAsk,
        yesMinOrderSize: pmYesMinOrderSize,
        noMinOrderSize: pmNoMinOrderSize,
        yesTickSize: pmYesTickSize,
        noTickSize: pmNoTickSize,
        yesLimitPrice: quoteLimitPrice(pmYesExecutableQuote) ?? undefined,
        noLimitPrice: quoteLimitPrice(pmNoExecutableQuote) ?? undefined,
      } as Parameters<typeof calculateArbitrageMax>[1],
      stale ? 0 : kalshiYesDepth,
      stale ? 0 : kalshiNoDepth,
      stale ? 0 : pmYesDepth,
      stale ? 0 : pmNoDepth,
      category,
      capital,
    );

    strategy = candidate.strategy;
    roiPct = stale ? 0 : candidate.roiPct;
    expectedProfit = stale ? 0 : candidate.expectedProfit;
    kalshiStake = stale ? 0 : candidate.kalshiStake;
    pmStake = stale ? 0 : candidate.pmStake;
    executionStatus = stale ? 'unavailable' : candidate.executionStatus ?? 'unavailable';
    executionBlocker = stale ? 'Required order book is stale' : candidate.executionBlocker;
    const selectedPmMinimum = candidate.strategy === 'Buy YES Kalshi + NO PM'
      ? pmNoMinOrderSize
      : pmYesMinOrderSize;
    const selectedPmTick = candidate.strategy === 'Buy YES Kalshi + NO PM' ? pmNoTickSize : pmYesTickSize;
    const selectedPmPrice = candidate.strategy === 'Buy YES Kalshi + NO PM'
      ? quoteLimitPrice(pmNoExecutableQuote)
      : quoteLimitPrice(pmYesExecutableQuote);
    if (!stale && candidate.strategy !== 'No arb' && (!Number.isFinite(selectedPmMinimum) || selectedPmMinimum! <= 0)) {
      executionStatus = 'non_executable';
      executionBlocker = 'Polymarket minimum order is unavailable';
    } else if (!stale && candidate.strategy !== 'No arb' && selectedPmMinimum! > 1) {
      executionStatus = 'non_executable';
      executionBlocker = `Polymarket minimum order is ${selectedPmMinimum} shares; requested 1 share`;
    } else if (!stale && candidate.strategy !== 'No arb' && (!Number.isFinite(selectedPmTick) || selectedPmTick! <= 0)) {
      executionStatus = 'non_executable';
      executionBlocker = 'Polymarket tick size is unavailable';
    } else if (!stale && candidate.strategy !== 'No arb'
        && !isPriceAlignedToTick(selectedPmPrice!, selectedPmTick!)) {
      executionStatus = 'non_executable';
      executionBlocker = `Polymarket limit price ${selectedPmPrice} is not aligned to tick size ${selectedPmTick}`;
    }
    if (candidate.fees) {
      fees = {
        kalshiFee: stale ? 0 : candidate.fees.kalshiFee,
        pmFee: stale ? 0 : candidate.fees.pmFee,
        worstCaseNetProfit: stale ? 0 : candidate.fees.worstCaseNetProfit,
        kalshiFeeAuthority,
      };
    }

    if (!stale && kalshiTicker && kalshiYesAsk + kalshiNoAsk < 1
        && kalshiYesDepth >= kalshiYesAsk && kalshiNoDepth >= kalshiNoAsk) {
      const contracts = 1;
      const yesStake = contracts * kalshiYesAsk;
      const noStake = contracts * kalshiNoAsk;
      const totalFee = calcKalshiFee(contracts, kalshiYesAsk, kalshiFeeAuthority)
        + calcKalshiFee(contracts, kalshiNoAsk, kalshiFeeAuthority);
      const netProfit = contracts - yesStake - noStake - totalFee;
      if (netProfit > 0 && netProfit > expectedProfit) {
        strategy = `Same-platform YES+NO Kalshi: ${artist}`;
        roiPct = netProfit / (yesStake + noStake) * 100;
        expectedProfit = netProfit;
        kalshiStake = yesStake + noStake;
        pmStake = 0;
        fees = { kalshiFee: totalFee, pmFee: 0, worstCaseNetProfit: netProfit, kalshiFeeAuthority };
        executionStatus = 'executable';
        executionBlocker = undefined;
      }
    }

    if (!stale && pmBinaryVerified === true && pmConditionId && pmYesTokenId !== pmNoTokenId
        && pmYesAsk + pmNoAsk < 1 && pmYesAskShares >= 1 && pmNoAskShares >= 1
        && pmYesMinOrderSize != null && pmYesMinOrderSize <= 1
        && pmNoMinOrderSize != null && pmNoMinOrderSize <= 1
        && pmYesTickSize != null && pmNoTickSize != null
        && isPriceAlignedToTick(quoteLimitPrice(pmYesExecutableQuote)!, pmYesTickSize)
        && isPriceAlignedToTick(quoteLimitPrice(pmNoExecutableQuote)!, pmNoTickSize)) {
      const contracts = 1;
      const yesStake = contracts * pmYesAsk;
      const noStake = contracts * pmNoAsk;
      const theta = getPolymarketTheta(category);
      const totalFee = calcPolymarketFee(contracts, pmYesAsk, theta) + calcPolymarketFee(contracts, pmNoAsk, theta);
      const netProfit = contracts - yesStake - noStake - totalFee;
      if (netProfit > 0 && netProfit > expectedProfit) {
        strategy = `Same-platform YES+NO Polymarket: ${artist}`;
        roiPct = netProfit / (yesStake + noStake) * 100;
        expectedProfit = netProfit;
        kalshiStake = 0;
        pmStake = yesStake + noStake;
        fees = { kalshiFee: 0, pmFee: totalFee, worstCaseNetProfit: netProfit };
        executionStatus = 'executable';
        executionBlocker = undefined;
      }
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
    kalshiYesExecutableQuote,
    kalshiNoExecutableQuote,
    pmYesExecutableQuote,
    pmNoExecutableQuote,
    pmYesDepth,
    pmNoDepth,
    kalshiYesExecutableDepth: kalshiYesExecutableQuote.status === 'executable' ? kalshiYesDepth : 0,
    kalshiNoExecutableDepth: kalshiNoExecutableQuote.status === 'executable' ? kalshiNoDepth : 0,
    pmYesExecutableDepth: pmYesExecutableQuote.status === 'executable' ? pmYesDepth : 0,
    pmNoExecutableDepth: pmNoExecutableQuote.status === 'executable' ? pmNoDepth : 0,
    kalshiBookStale,
    pmYesBookStale,
    pmNoBookStale,
    kalshiYesAskShares,
    kalshiNoAskShares,
    pmYesAskShares,
    pmNoAskShares,
    pmYesMinOrderSize: pmYesMinOrderSize ?? null,
    pmNoMinOrderSize: pmNoMinOrderSize ?? null,
    pmYesTickSize: pmYesTickSize ?? null,
    pmNoTickSize: pmNoTickSize ?? null,
    requestedContracts: 1,
    executionStatus,
    ...(executionBlocker ? { executionBlocker } : {}),
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
    pmConditionId,
    category,
    kalshiFeeAuthority,
    arbType: strategy.startsWith('Same-platform YES+NO') ? 'internal' : 'direct',
    crossOutcomeMutuallyExclusiveVerified,
    crossOutcomeExhaustiveVerified,
    lastUpdate: new Date().toISOString(),
  };
}

function capturedResult(
  base: LiveArbResult,
  identity: CapturedLiveArbIdentity,
  values: Pick<LiveArbResult, 'roiPct' | 'expectedProfit' | 'kalshiStake' | 'pmStake' | 'fees' | 'stale' | 'requiredBookIds' | 'executionStatus' | 'executionBlocker'>,
): LiveArbResult {
  return {
    ...base,
    ...values,
    strategy: identity.strategy.replace(/Polymarket/g, 'PM'),
    arbType: identity.arbType,
    pmConditionId: identity.pmConditionId,
    lastUpdate: new Date().toISOString(),
  };
}

/** Fee valuation for captured legs is keyed by structured venue and price.
 * Strategy labels are display text and cannot safely infer PM NO or cross legs. */
function computeCapturedLegFees(
  contracts: number,
  kalshiPrice: number | null,
  pmPrice: number | null,
  category?: string,
  kalshiFeeAuthority?: KalshiFeeAuthority,
): { kalshiFee: number; pmFee: number } {
  return {
    kalshiFee: kalshiPrice == null ? 0 : calcKalshiFee(contracts, kalshiPrice, kalshiFeeAuthority),
    pmFee: pmPrice == null
      ? 0
      : calcPolymarketFee(contracts, pmPrice, getPolymarketTheta(category)),
  };
}

/**
 * Value immutable logged strategy identities independently of today's winner.
 * The normal scanner intentionally emits only the best strategy per outcome;
 * Logs must instead retain a still-executable captured direction even when its
 * ROI has fallen to zero or below.
 */
export function computeCapturedLiveArbitrages(
  outcomes: LiveMatchedOutcome[],
  capital: number,
  category: string | undefined,
  identities: CapturedLiveArbIdentity[],
): LiveArbResult[] {
  const bases = outcomes.map((outcome) => computeSingleOutcome(outcome, capital, category));
  const normalize = (strategy: string) => strategy.replace(/Polymarket/g, 'PM');
  const results: LiveArbResult[] = [];

  for (const identity of identities) {
    const strategy = normalize(identity.strategy);
    const current = bases.find((result) => result.kalshiTicker === identity.kalshiTicker);
    if (!current) continue;

    if (identity.arbType === 'direct') {
      if (current.pmConditionId !== identity.pmConditionId) continue;
      const pmFirst = strategy === 'Buy YES PM + NO Kalshi';
      const kalshiFirst = strategy === 'Buy YES Kalshi + NO PM';
      if (!pmFirst && !kalshiFirst) continue;
      const kalshiPrice = pmFirst ? current.kalshiNoAsk : current.kalshiYesAsk;
      const pmPrice = pmFirst ? current.pmYesAsk : current.pmNoAsk;
      const kalshiDepth = pmFirst
        ? current.kalshiNoExecutableDepth ?? current.kalshiNoDepth
        : current.kalshiYesExecutableDepth ?? current.kalshiYesDepth;
      const pmDepth = pmFirst
        ? current.pmYesExecutableDepth ?? current.pmYesDepth
        : current.pmNoExecutableDepth ?? current.pmNoDepth;
      if (kalshiPrice == null || pmPrice == null || kalshiPrice <= 0 || pmPrice <= 0) continue;
      const requiredBookStale = current.kalshiBookStale
        || (pmFirst ? current.pmYesBookStale : current.pmNoBookStale);
      const pmMinimum = pmFirst ? current.pmYesMinOrderSize : current.pmNoMinOrderSize;
      const pmTick = pmFirst ? current.pmYesTickSize : current.pmNoTickSize;
      const pmQuote = pmFirst ? current.pmYesExecutableQuote : current.pmNoExecutableQuote;
      const pmLimit = pmQuote?.limitPriceMicroCents == null ? null : pmQuote.limitPriceMicroCents / 100_000_000;
      const pmConstraintsExecutable = pmMinimum != null && pmMinimum <= 1 && pmTick != null
        && pmLimit != null && isPriceAlignedToTick(pmLimit, pmTick);
      const effectiveCapital = requiredBookStale || !pmConstraintsExecutable
        || kalshiDepth < kalshiPrice || pmDepth < pmPrice ? 0 : 1;
      if (effectiveCapital <= 0) {
        results.push(capturedResult(current, identity, {
          roiPct: 0, expectedProfit: 0, kalshiStake: 0, pmStake: 0, fees: null, stale: Boolean(requiredBookStale),
          executionStatus: requiredBookStale ? 'unavailable' : 'non_executable',
          executionBlocker: requiredBookStale ? 'Required order book is stale' : 'Captured direct legs cannot fill one share',
          requiredBookIds: [current.kalshiTicker!, pmFirst ? current.pmYesTokenId! : current.pmNoTokenId!],
        }));
        continue;
      }
      const kalshiStake = effectiveCapital * kalshiPrice;
      const pmStake = effectiveCapital * pmPrice;
      const fees = computeCapturedLegFees(effectiveCapital, kalshiPrice, pmPrice, category, current.kalshiFeeAuthority);
      const worstCaseNetProfit = effectiveCapital - kalshiStake - pmStake - fees.kalshiFee - fees.pmFee;
      results.push(capturedResult(current, identity, {
        roiPct: (worstCaseNetProfit / effectiveCapital) * 100,
        expectedProfit: worstCaseNetProfit,
        kalshiStake,
        pmStake,
        fees: { kalshiFee: fees.kalshiFee, pmFee: fees.pmFee, worstCaseNetProfit },
        stale: false,
        executionStatus: 'executable',
        executionBlocker: undefined,
        requiredBookIds: [current.kalshiTicker!, pmFirst ? current.pmYesTokenId! : current.pmNoTokenId!],
      }));
      continue;
    }

    for (const companion of bases) {
      if (companion === current) continue;
      const crossStrategy = `Buy YES both sides: Kalshi ${current.artist} + PM ${companion.artist}`;
      const kalshiInternalStrategy = `Same-platform YES+YES Kalshi: ${current.artist} + ${companion.artist}`;
      const pmInternalStrategy = `Same-platform YES+YES PM: ${current.artist} + ${companion.artist}`;
      const isCross = identity.arbType === 'cross'
        && identity.pmConditionId === companion.pmConditionId
        && outcomes.find((outcome) => outcome.kalshiTicker === current.kalshiTicker)?.crossOutcomeMutuallyExclusiveVerified === true
        && outcomes.find((outcome) => outcome.kalshiTicker === current.kalshiTicker)?.crossOutcomeExhaustiveVerified === true
        && outcomes.find((outcome) => outcome.kalshiTicker === companion.kalshiTicker)?.crossOutcomeMutuallyExclusiveVerified === true
        && outcomes.find((outcome) => outcome.kalshiTicker === companion.kalshiTicker)?.crossOutcomeExhaustiveVerified === true
        && strategy === crossStrategy;
      const isKalshiInternal = identity.arbType === 'internal' && strategy === kalshiInternalStrategy;
      const isPmInternal = identity.arbType === 'internal' && strategy === pmInternalStrategy;
      if (!isCross && !isKalshiInternal && !isPmInternal) continue;

      const firstPrice = isCross || isKalshiInternal ? current.kalshiYesAsk : current.pmYesAsk;
      const secondPrice = isCross || isPmInternal ? companion.pmYesAsk : companion.kalshiYesAsk;
      const firstDepth = isCross || isKalshiInternal ? current.kalshiYesDepth : current.pmYesDepth;
      const secondDepth = isCross || isPmInternal ? companion.pmYesDepth : companion.kalshiYesDepth;
      const stale = isCross
        ? Boolean(current.kalshiBookStale || companion.pmYesBookStale)
        : isKalshiInternal
          ? Boolean(current.kalshiBookStale || companion.kalshiBookStale)
          : Boolean(current.pmYesBookStale || companion.pmYesBookStale);
      if (firstPrice == null || secondPrice == null || firstPrice <= 0 || secondPrice <= 0) continue;
      const firstPmLimit = current.pmYesExecutableQuote?.limitPriceMicroCents == null
        ? null : current.pmYesExecutableQuote.limitPriceMicroCents / 100_000_000;
      const secondPmLimit = companion.pmYesExecutableQuote?.limitPriceMicroCents == null
        ? null : companion.pmYesExecutableQuote.limitPriceMicroCents / 100_000_000;
      const pmMinimumExecutable = isCross
        ? companion.pmYesMinOrderSize != null && companion.pmYesMinOrderSize <= 1 && companion.pmYesTickSize != null
          && secondPmLimit != null && isPriceAlignedToTick(secondPmLimit, companion.pmYesTickSize)
        : isPmInternal
          ? current.pmYesMinOrderSize != null && current.pmYesMinOrderSize <= 1 && current.pmYesTickSize != null
            && firstPmLimit != null && isPriceAlignedToTick(firstPmLimit, current.pmYesTickSize)
            && companion.pmYesMinOrderSize != null && companion.pmYesMinOrderSize <= 1 && companion.pmYesTickSize != null
            && secondPmLimit != null && isPriceAlignedToTick(secondPmLimit, companion.pmYesTickSize)
          : true;
      const effectiveCapital = stale || !pmMinimumExecutable
        || firstDepth < firstPrice || secondDepth < secondPrice ? 0 : 1;
      if (effectiveCapital <= 0) {
        results.push(capturedResult(current, identity, {
          roiPct: 0, expectedProfit: 0, kalshiStake: 0, pmStake: 0, fees: null, stale,
          executionStatus: stale ? 'unavailable' : 'non_executable',
          executionBlocker: stale ? 'Required order book is stale' : 'Captured strategy legs cannot fill one share or violate venue constraints',
          requiredBookIds: isCross
            ? [current.kalshiTicker!, companion.pmYesTokenId!]
            : isKalshiInternal
              ? [current.kalshiTicker!, companion.kalshiTicker!]
              : [current.pmYesTokenId!, companion.pmYesTokenId!],
        }));
        break;
      }

      const firstStake = effectiveCapital * firstPrice;
      const secondStake = effectiveCapital * secondPrice;
      const grossProfit = effectiveCapital - firstStake - secondStake;
      let kalshiFee = 0;
      let pmFee = 0;
      if (isCross) {
        const fees = computeCapturedLegFees(effectiveCapital, firstPrice, secondPrice, category, current.kalshiFeeAuthority);
        kalshiFee = fees.kalshiFee;
        pmFee = fees.pmFee;
      } else if (isKalshiInternal) {
        kalshiFee = calcKalshiFee(effectiveCapital, firstPrice, current.kalshiFeeAuthority)
          + calcKalshiFee(effectiveCapital, secondPrice, companion.kalshiFeeAuthority);
      } else {
        const theta = getPolymarketTheta(category);
        pmFee = calcPolymarketFee(effectiveCapital, firstPrice, theta) + calcPolymarketFee(effectiveCapital, secondPrice, theta);
      }
      const expectedProfit = grossProfit - kalshiFee - pmFee;
      results.push(capturedResult(current, identity, {
        roiPct: (expectedProfit / effectiveCapital) * 100,
        expectedProfit,
        kalshiStake: isCross ? firstStake : isKalshiInternal ? firstStake + secondStake : 0,
        pmStake: isCross ? secondStake : isPmInternal ? firstStake + secondStake : 0,
        fees: { kalshiFee, pmFee, worstCaseNetProfit: expectedProfit },
        stale: false,
        executionStatus: 'executable',
        executionBlocker: undefined,
        requiredBookIds: isCross
          ? [current.kalshiTicker!, companion.pmYesTokenId!]
          : isKalshiInternal
            ? [current.kalshiTicker!, companion.kalshiTicker!]
            : [current.pmYesTokenId!, companion.pmYesTokenId!],
      }));
      break;
    }
  }

  return results;
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

  // Cross-outcome pass requires an explicit mutual-exclusivity/exhaustiveness
  // review. Merely having two rows is not settlement evidence.
  if (results.length === 2
      && outcomes.every((outcome) => outcome.crossOutcomeMutuallyExclusiveVerified === true
        && outcome.crossOutcomeExhaustiveVerified === true)
      && outcomes[0]?.artist !== outcomes[1]?.artist
      && outcomes[0]?.kalshiTicker !== outcomes[1]?.kalshiTicker
      && outcomes[0]?.pmConditionId !== outcomes[1]?.pmConditionId) {
    for (let i = 0; i < 2; i++) {
      const cur = results[i];
      const comp = results[1 - i];
      if (cur.stale || comp.stale) continue;
      const kYesA = cur.kalshiYesAsk;
      const pYesB = comp.pmYesAsk;
      if (kYesA == null || pYesB == null || cur.kalshiNoAsk == null || comp.pmNoAsk == null) continue;
      if (kYesA + pYesB >= 1) continue;

      // Capital limited by ask depth on both legs (mirrors manual scan's leg caps)
      // An absent/zero level means the displayed quote has no verified fillable
      // size. It must block execution rather than silently becoming max capital.
      const capK = cur.kalshiYesDepth > 0 ? cur.kalshiYesDepth / kYesA : 0;
      const capP = comp.pmYesDepth > 0 ? comp.pmYesDepth / pYesB : 0;
      const pmYesLimit = comp.pmYesExecutableQuote?.limitPriceMicroCents == null
        ? null : comp.pmYesExecutableQuote.limitPriceMicroCents / 100_000_000;
      const effectiveCapital = capK >= 1 && capP >= 1
        && comp.pmYesMinOrderSize != null && comp.pmYesMinOrderSize <= 1 && comp.pmYesTickSize != null
        && pmYesLimit != null && isPriceAlignedToTick(pmYesLimit, comp.pmYesTickSize) ? 1 : 0;
      if (effectiveCapital === 0) continue;
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
        cur.kalshiFeeAuthority,
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
          kalshiFeeAuthority: fees.kalshiFeeAuthority,
        };
        cur.requestedContracts = 1;
        cur.executionStatus = 'executable';
        cur.executionBlocker = undefined;
        cur.pmConditionId = comp.pmConditionId;
        cur.pmYesTokenId = comp.pmYesTokenId;
        cur.pmNoTokenId = comp.pmNoTokenId;
        cur.pmYesAsk = comp.pmYesAsk;
        cur.pmNoAsk = comp.pmNoAsk;
        cur.pmYesDepth = comp.pmYesDepth;
        cur.pmNoDepth = comp.pmNoDepth;
        cur.pmYesAskShares = comp.pmYesAskShares;
        cur.pmNoAskShares = comp.pmNoAskShares;
        cur.pmYesMinOrderSize = comp.pmYesMinOrderSize;
        cur.pmNoMinOrderSize = comp.pmNoMinOrderSize;
        cur.pmYesTickSize = comp.pmYesTickSize;
        cur.pmNoTickSize = comp.pmNoTickSize;
        cur.crossOutcomeMutuallyExclusiveVerified = true;
        cur.crossOutcomeExhaustiveVerified = true;
      }
    }
  }


  return results;
}

// Helpers for direct Polymarket book updates from the WS message format
// Each token_id represents a specific outcome (YES or NO). The caller must
// specify which side this token is so we store it correctly.
const STRICT_DECIMAL = /^(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i;
const FIXED_DECIMAL = /^(\d+)(?:\.(\d+))?$/;

function parseExecutableDecimal(value: string): number | null {
  const normalized = value.trim();
  if (!STRICT_DECIMAL.test(normalized)) return null;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function parseFixedDecimal(value: string, fractionalDigits: number): number | null {
  const match = FIXED_DECIMAL.exec(value.trim());
  if (!match || (match[2]?.length ?? 0) > fractionalDigits) return null;
  const scaled = BigInt(match[1]) * 10n ** BigInt(fractionalDigits)
    + BigInt((match[2] ?? '').padEnd(fractionalDigits, '0'));
  return scaled > 0n && scaled <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(scaled) : null;
}

export function applyPolymarketBook(
  tokenId: string,
  asks: { price: string; size: string }[],
  side: 'yes' | 'no' = 'yes',
  metadata?: { tickSize: string; minimumOrderSize: string; depthTimestamp: string },
): void {
  // CLOB WebSocket payloads are untrusted. Require fully numeric, finite,
  // executable levels so malformed depth cannot create a phantom live arb.
  const levels = asks
    .map((a) => ({
      price: parseExecutableDecimal(a.price),
      priceMicroCents: parseFixedDecimal(a.price, 8),
      quantity: parseExecutableDecimal(a.size),
    }))
    .filter((a): a is { price: number; priceMicroCents: number; quantity: number } => a.price !== null
      && a.priceMicroCents !== null && a.quantity !== null && a.price < 1)
    .sort((a, b) => a.price - b.price);

  const existing = orderbookState.getBook(tokenId);
  const tickSizeMicroCents = metadata ? parseFixedDecimal(metadata.tickSize, 8) : null;
  const minimumOrderQuantityMicros = metadata ? parseFixedDecimal(metadata.minimumOrderSize, 6) : null;
  const constraints = metadata ? {
    tickSizeMicroCents: tickSizeMicroCents ?? 0,
    minimumOrderQuantityMicros: minimumOrderQuantityMicros ?? 0,
    depthTimestamp: metadata.depthTimestamp,
  } : existing ? undefined : {
    // A WS book arriving before its REST seed has depth but no venue tick/minimum
    // authority. Keep it visible while making executable quoting fail closed.
    tickSizeMicroCents: 0,
    minimumOrderQuantityMicros: 0,
    depthTimestamp: new Date().toISOString(),
  };
  if (existing) {
    // Update only the specified side, preserve the other
    const yesAsks = side === 'yes' ? levels : existing.yes.asks;
    const noAsks = side === 'no' ? levels : existing.no.asks;
    orderbookState.setBook(tokenId, yesAsks, noAsks, 0, constraints);
  } else {
    // First time: seed the specified side
    orderbookState.setBook(tokenId, side === 'yes' ? levels : [], side === 'no' ? levels : [], 0, constraints);
  }
}
