import { KalshiMarket } from './kalshi';
import { PMMarket, parseOutcomes } from './polymarket';
import type { ManualMatch } from './manual-matches';
import { finiteDecimal, finiteMarketPrice } from './market-price';
import {
  calculateOutcomeContingentApy,
  kalshiSettlementTiming,
  polymarketSettlementTiming,
  type OutcomeContingentApy,
  type SettlementTiming,
} from './settlement-apy';
import { calculateScanApy, type ScanApyUnavailableReason } from './scan-apy';
import { isPriceAlignedToTick } from './venue-constraints';
import { calculateKalshiFeeUsd, type KalshiFeeAuthority } from './kalshi-fee-quote';
import { getPolymarketCategoryFeeRateBps, resolvePolymarketFeeRateBps } from './polymarket-fees';
import type { PropositionRelationship } from './proposition-identity';

export interface UnifiedOutcome {
  artist: string;
  /** Exact venue contract questions captured from platform payloads. */
  kalshiMarketQuestion?: string | null;
  pmMarketQuestion?: string | null;
  /** Exact venue-provided outcome labels; never derived from the shared display name. */
  kalshiOutcomeLabel?: string | null;
  pmOutcomeLabel?: string | null;
  kalshiStale?: boolean;
  polymarketStale?: boolean;
  polymarketRefresh?: {
    conditionId: string;
    outcome: string;
    status: 'refreshed' | 'timed_out' | 'error' | 'unavailable';
    observedAt: string | null;
    source: 'live-clob' | 'saved-market-snapshot' | null;
    servedFromSnapshot: boolean;
    snapshotAgeMs: number | null;
    reason?: string;
  };
  kalshi: {
    ticker: string;
    yesBid: number;
    yesAsk: number;
    noBid: number;
    noAsk: number;
    lastPrice: number;
    volume24h?: string;
    yesBidDepth?: string;
    yesAskDepth?: string;
    noBidDepth?: string;
    noAskDepth?: string;
    eventId?: string;
    settlementTiming?: SettlementTiming;
    feeAuthority?: KalshiFeeAuthority;
  } | null;
  polymarket: {
    marketId: string;
    conditionId: string;
    yesTokenId?: string;
    noTokenId?: string;
    yesPrice: number;
    noPrice: number;
    /** Exact token-book sell bids and quantities; never inferred for neg-risk. */
    yesBid?: number;
    noBid?: number;
    yesBidDepth?: number;
    noBidDepth?: number;
    quoteObservedAt?: string;
    bestBid: number;
    bestAsk: number;
    lastTradePrice: number;
    volume?: string;
    liquidity?: string;
    askDepth?: number;
    noAskDepth?: number;
    /** Venue constraints from the exact YES/NO token books. */
    yesMinOrderSize?: number;
    noMinOrderSize?: number;
    yesTickSize?: number;
    noTickSize?: number;
    /** Worst consumed marketable limits; VWAP remains in bestAsk/noPrice. */
    yesLimitPrice?: number;
    noLimitPrice?: number;
    negRisk?: boolean;
    feesEnabled?: boolean;
    feeSchedule?: {
      rate: number;
      exponent: number;
      takerOnly: boolean;
      rebateRate: number;
    } | null;
    /** Exact [Yes, No] outcome structure was verified from platform data. */
    binaryVerified?: boolean;
    /** False when prices are indicative only (no executable CLOB asks). */
    isExecutable?: boolean;
    couplingOrientation?: 'same' | 'inverted';
    couplingAudit?: {
      originalYesPrice: number;
      originalNoPrice: number;
      originalSide: 'YES';
      normalizedSide: 'YES' | 'NO';
    };
    settlementTiming?: SettlementTiming;
  } | null;
  arbitrage: {
    strategy: string;
    /** ARB-01a: classification of the arb strategy.
     *  - "direct": regular YES/NO across platforms (within-outcome)
     *  - "cross": cross-outcome YES+YES across platforms
     *  - "internal": same-platform YES+NO on one verified binary market */
    arbType: 'cross' | 'direct' | 'internal' | null;
    kalshiStake: number;
    pmStake: number;
    expectedProfit: number;
    roiPct: number;
    /** Canonical event-time APY derived from this ROI and persisted expiry/TTE. */
    apyPct?: number | null;
    daysToExpiry?: number | null;
    expiryAt?: string | null;
    apyUnavailableReason?: ScanApyUnavailableReason | null;
    outcomeApy?: OutcomeContingentApy;
    maxCapital: number;
    buyPlatform: 'kalshi' | 'polymarket' | null;
    buyPrice: number;
    sellPlatform: 'kalshi' | 'polymarket' | null;
    sellPrice: number;
    /** Exact Polymarket parent identity selected by cross-outcome strategies. */
    pmConditionId?: string;
    /** True when ROI exceeds the sanity threshold AND depth on some leg was
     *  unknown/assumed-infinite — almost certainly a phantom quote on an
     *  illiquid book, not a fillable arb. Excluded from stats/alerts. */
    suspicious?: boolean;
    /** True only when every required orderbook leg has known positive ask depth. */
    depthVerified?: boolean;
    /** Canonical opportunity sizing is always one contract/share per leg. */
    requestedContracts?: 1;
    executionStatus?: 'executable' | 'non_executable' | 'unavailable';
    executionBlocker?: string;
    /** Fee-adjusted profit per winning platform for the buy side */
    fees?: {
      kalshiFee: number;
      pmFee: number;
      kalshiFeeDetails: string;
      pmFeeDetails: string;
      netProfitIfKalshiWins: number;
      netProfitIfPmWins: number;
      worstCaseNetProfit: number;
      kalshiFeeAuthority?: KalshiFeeAuthority;
    };
  };
  source: 'auto' | 'manual';
  /** True only when matching supplied explicit rule-alignment evidence. */
  resolutionRulesAligned?: boolean;
  propositionRelationship?: PropositionRelationship | null;
  /** True when this PM market is neg-risk (independent YES/NO, not complementary) */
  negRisk?: boolean;
  /** True when this outcome is a virtual cross-outcome arbitrage row */
  isCrossOutcome?: boolean;
  /**
   * Canonical platform-neutral representation. The legacy `kalshi` and
   * `polymarket` fields remain during the FEAT-3/4 migration so current
   * consumers continue to work without a flag-day cutover.
   */
  platforms?: MatchedPlatformData[];
}

/** Normalized per-platform data for one matched outcome. */
export interface MatchedPlatformData {
  platformId: 'kalshi' | 'polymarket';
  marketId: string;
  outcomeId: string;
  yesPrice: number;
  noPrice: number;
  bestBid: number;
  bestAsk: number;
  lastPrice: number;
  askDepth?: number;
  bidDepth?: number;
  raw: NonNullable<UnifiedOutcome['kalshi']> | NonNullable<UnifiedOutcome['polymarket']>;
}

/**
 * Populate the canonical N-platform field from legacy data. This is the
 * compatibility boundary for the phased migration: new callers consume
 * `platforms`, while FEAT-4/5 move existing callers off the legacy fields.
 */
export function normalizeOutcomePlatforms(outcome: UnifiedOutcome): UnifiedOutcome {
  const platforms: MatchedPlatformData[] = [];
  if (outcome.kalshi) {
    const k = outcome.kalshi;
    platforms.push({
      platformId: 'kalshi', marketId: k.ticker, outcomeId: k.ticker,
      yesPrice: k.yesAsk, noPrice: k.noAsk, bestBid: k.yesBid,
      bestAsk: k.yesAsk, lastPrice: k.lastPrice,
      askDepth: parseDepth(k.yesAskDepth), bidDepth: parseDepth(k.yesBidDepth), raw: k,
    });
  }
  if (outcome.polymarket) {
    const p = outcome.polymarket;
    platforms.push({
      platformId: 'polymarket', marketId: p.marketId, outcomeId: p.conditionId,
      yesPrice: p.yesPrice, noPrice: p.noPrice, bestBid: p.bestBid,
      bestAsk: p.bestAsk, lastPrice: p.lastTradePrice,
      askDepth: p.askDepth, bidDepth: p.noAskDepth, raw: p,
    });
  }
  return { ...outcome, platforms };
}

type PolymarketShape = NonNullable<UnifiedOutcome['polymarket']>;

/** Normalize an explicit proposition mapping exactly once. */
export function normalizeManualPairPolymarketShape(
  shape: PolymarketShape,
  orientation: ManualMatch['orientation'] | undefined,
): PolymarketShape {
  if (shape.couplingOrientation || orientation !== 'inverted') return shape;
  return {
    ...shape,
    yesPrice: shape.noPrice,
    noPrice: shape.yesPrice,
    bestAsk: shape.noPrice,
    askDepth: shape.noAskDepth,
    couplingOrientation: 'inverted',
    couplingAudit: {
      originalYesPrice: shape.yesPrice,
      originalNoPrice: shape.noPrice,
      originalSide: 'YES',
      normalizedSide: 'NO',
    },
  };
}

/** Default fee parameters per platform. Polymarket theta varies by category. */
export function getPolymarketTheta(category?: string): number {
  return getPolymarketCategoryFeeRateBps(category) / 10_000;
}

/** Compatibility facade; formula, multiplier, and rounding are centralized. */
export function calcKalshiFee(contracts: number, price: number, authority?: KalshiFeeAuthority): number {
  return calculateKalshiFeeUsd(contracts, price, authority);
}

/** Polymarket fee: theta * contracts * price * (1 - price). Rounded to 5 decimals. */
export function calcPolymarketFee(contracts: number, price: number, theta = 0.05): number {
  if (contracts <= 0 || price <= 0 || price >= 1) return 0;
  const raw = theta * contracts * price * (1 - price);
  return Math.round(raw * 100000) / 100000;
}

/** Format a fee value with 2 decimals and a concise note. */
export function formatFee(value: number): string {
  return `$${value.toFixed(2)}`;
}

/** Format a probability price (0–1) with adaptive precision for sub-cent values. */
function fmtProbPrice(price: number): string {
  if (price >= 0.01) return price.toFixed(2);
  if (price >= 0.001) return price.toFixed(3);
  return price.toFixed(4);
}

/** Compute gross profit and fee-adjusted net profit for a two-leg arbitrage. */
export function computeArbitrageFees(
  strategy: string,
  capital: number,
  kalshiStake: number,
  pmStake: number,
  kalshiBuyPrice: number,
  kalshiSellPrice: number,
  pmBuyPrice: number,
  pmSellPrice: number,
  category?: string,
  kalshiFeeAuthority?: KalshiFeeAuthority,
  pmFeeRateBps?: number,
): {
  grossProfit: number;
  kalshiFee: number;
  pmFee: number;
  netProfitIfKalshiWins: number;
  netProfitIfPmWins: number;
  netProfitIfBothYes?: number;
  worstCaseNetProfit: number;
  kalshiFeeDetails: string;
  pmFeeDetails: string;
  kalshiFeeAuthority?: KalshiFeeAuthority;
} {
  const grossProfit = capital - kalshiStake - pmStake;

  let kalshiFeeAmount = 0;
  let kalshiFeeDetails = 'Kalshi: no fee (0 contracts or settled)';
  let pmFeeAmount = 0;
  let pmFeeDetails = 'Polymarket: no fee (0 contracts or settled)';
  const isCrossOutcome = /^Buy YES both sides: Kalshi .+ \+ (?:PM|Polymarket) .+/.test(strategy);

  if (strategy.includes('YES Kalshi') || isCrossOutcome || strategy.startsWith('Buy YES both sides:')) {
    // This strategy places exactly one Kalshi order: buy YES.
    const kalshiYesContracts = kalshiStake / kalshiBuyPrice;
    kalshiFeeAmount = calcKalshiFee(kalshiYesContracts, kalshiBuyPrice, kalshiFeeAuthority);
    kalshiFeeDetails = `Kalshi YES buy ${kalshiYesContracts.toFixed(0)} @ $${fmtProbPrice(kalshiBuyPrice)} = ${formatFee(kalshiFeeAmount)}`;
  } else if (strategy.includes('NO Kalshi')) {
    // This strategy places exactly one Kalshi order: buy NO.
    const kalshiNoContracts = kalshiStake / kalshiSellPrice;
    kalshiFeeAmount = calcKalshiFee(kalshiNoContracts, kalshiSellPrice, kalshiFeeAuthority);
    kalshiFeeDetails = `Kalshi NO buy ${kalshiNoContracts.toFixed(0)} @ $${fmtProbPrice(kalshiSellPrice)} = ${formatFee(kalshiFeeAmount)}`;
  }

  if (strategy.includes('YES PM')
      || strategy.includes('YES Polymarket')
      || isCrossOutcome
      || strategy.startsWith('Buy YES both sides:')) {
    const pmYesContracts = pmStake / pmBuyPrice;
    const pmTheta = (pmFeeRateBps ?? getPolymarketCategoryFeeRateBps(category)) / 10_000;
    pmFeeAmount = calcPolymarketFee(pmYesContracts, pmBuyPrice, pmTheta);
    pmFeeDetails = `Polymarket YES buy ${pmYesContracts.toFixed(0)} @ $${fmtProbPrice(pmBuyPrice)} (θ=${pmTheta.toFixed(2)}) = ${formatFee(pmFeeAmount)}`;
  } else if (strategy.includes('NO PM') || strategy.includes('NO Polymarket')) {
    const pmNoContracts = pmStake / pmSellPrice;
    const pmTheta = (pmFeeRateBps ?? getPolymarketCategoryFeeRateBps(category)) / 10_000;
    pmFeeAmount = calcPolymarketFee(pmNoContracts, pmSellPrice, pmTheta);
    pmFeeDetails = `Polymarket NO buy ${pmNoContracts.toFixed(0)} @ $${fmtProbPrice(pmSellPrice)} (θ=${pmTheta.toFixed(2)}) = ${formatFee(pmFeeAmount)}`;
  }

  // Both platforms charge trading fees at execution time, regardless of which
  // side resolves — so BOTH fees must be subtracted in every outcome branch.
  const totalFees = kalshiFeeAmount + pmFeeAmount;
  // Net profit if Kalshi side wins (Kalshi YES pays $1 per contract, PM NO loses)
  const netProfitIfKalshiWins = capital - kalshiStake - pmStake - totalFees;
  // Net profit if PM side wins (PM YES pays $1 per contract, Kalshi NO loses)
  const netProfitIfPmWins = capital - kalshiStake - pmStake - totalFees;
  // Cross-outcome: buy YES on both platforms, one side will win and pay $1
  const netProfitIfBothYes = capital - kalshiStake - pmStake - kalshiFeeAmount - pmFeeAmount;

  let worstCaseNetProfit: number;
  if (strategy.includes('YES both sides')) {
    // Exactly one leg wins; both legs pay fees; net is deterministic after fees
    worstCaseNetProfit = netProfitIfBothYes;
  } else {
    worstCaseNetProfit = Math.min(netProfitIfKalshiWins, netProfitIfPmWins);
  }

  return {
    grossProfit,
    kalshiFee: kalshiFeeAmount,
    pmFee: pmFeeAmount,
    netProfitIfKalshiWins,
    netProfitIfPmWins,
    netProfitIfBothYes,
    worstCaseNetProfit,
    kalshiFeeDetails,
    pmFeeDetails,
    kalshiFeeAuthority,
  };
}

const MONTH_MAP: Record<string, string> = {
  JAN: 'Jan', FEB: 'Feb', MAR: 'Mar', APR: 'Apr', MAY: 'May', JUN: 'Jun',
  JUL: 'Jul', AUG: 'Aug', SEP: 'Sep', OCT: 'Oct', NOV: 'Nov', DEC: 'Dec',
};

/** Parse the date suffix and sub-code from a Kalshi ticker, e.g.
 *  KXIPOSPACEX-27MAY01   -> { year: '2027', month: 'May', day: '01' }
 *  KXHIGHTSEA-26MAY23-T77 -> { year: '2026', month: 'May', day: '23', sub: 'T77' }
 *  KXHIGHTSEA-26MAY23-B74.5 -> { year: '2026', month: 'May', day: '23', sub: 'B74.5' }
 */
function parseKalshiTicker(ticker: string): { label?: string; sub?: string } | null {
  const m = ticker.match(/-([0-9]{2})([A-Z]{3})([0-9]{2})(?:.*-([A-Z][A-Z0-9.]*))?$/);
  if (!m) return null;
  const [, yy, mon, dd, sub] = m;
  const month = MONTH_MAP[mon] || mon;
  const year = '20' + yy;
  let label: string;
  if (dd === '01') {
    label = `${month} ${year}`;
  } else {
    label = `${month} ${dd}, ${year}`;
  }
  return { label, sub };
}

/** BUG-030: last-resort readable name from a raw ticker like "KXALHOUSE-26-R3" */
function humanizeKalshiTicker(ticker: string): string {
  const seg = ticker.split('-')[0] || ticker;
  return seg.replace(/^KX/i, '').replace(/([A-Z])(\d)/g, '$1 $2');
}

function extractNameFromKalshiTitle(title: string): string {
  const willWinMatch = title.match(/^Will\s+(.+?)\s+(?:win|lose|be|finish|end|survive|get|score)/i);
  if (willWinMatch) return willWinMatch[1].trim();
  const sayQuoteMatch = title.match(/say\s+["']([^"']+)["']/i);
  if (sayQuoteMatch) return sayQuoteMatch[1].trim();
  const sayMatch = title.match(/say\s+(.+?)\s+(?:before|by|at|on|in\s+the)/i);
  if (sayMatch) {
    const candidate = sayMatch[1].trim();
    if (candidate.length >= 2) return candidate;
  }
  const simpleMatch = title.match(/^Will\s+(.{2,40}?)\s+(?:win|at|by|score|finish|get|lose|be|end|survive)/i);
  if (simpleMatch) return simpleMatch[1].trim();
  return title.slice(0, 30);
}

/** Extract a bet-type keyword from market text to prevent cross-bet-type matching */
function extractBetType(text: string): string {
  const lower = text.toLowerCase();
  if (/top\s*scorer|anytime\s*scorer/i.test(lower)) return 'top-scorer';
  if (/mvp|most\s*valuable/i.test(lower)) return 'mvp';
  if (/winner|will\s+win|champion/i.test(lower)) return 'winner';
  if (/over|under/i.test(lower)) return 'totals';
  if (/spread|cover/i.test(lower)) return 'spread';
  if (/first\s*(goal|touch|down|score)/i.test(lower)) return 'first';
  if (/anytime/i.test(lower)) return 'anytime';
  if (/series\s*price|series\s*winner/i.test(lower)) return 'series';
  if (/game\s*props|player\s*props/i.test(lower)) return 'props';
  // BUG-05 Sub-Issue 4: "advance" and "advances" are a distinct bet type.
  // Without this, "France advances" (PM) would fuzzy-match "France"
  // (Kalshi Moneyline) because the bet-type prefix isn't applied.
  if (/advance/i.test(lower)) return 'advance';
  // Moneyline / regulation time winner — distinct from "winner" (tournament)
  if (/moneyline|regulation\s*time/i.test(lower)) return 'moneyline';
  // Both teams to score
  if (/both\s*teams\s*to\s*score|btts/i.test(lower)) return 'btts';
  return '';
}

/** Strip a bet-type prefix (added for matching) from the display name */
const BET_TYPE_PREFIXES = ['top-scorer', 'mvp', 'winner', 'totals', 'spread', 'first', 'anytime', 'series', 'props', 'advance', 'moneyline', 'btts'];
function stripBetTypePrefix(name: string): string {
  for (const prefix of BET_TYPE_PREFIXES) {
    if (name.toLowerCase().startsWith(prefix + ' ')) {
      return name.slice(prefix.length + 1);
    }
  }
  return name;
}

function getKalshiName(km: KalshiMarket): string {
  // 1. For sport match-winner markets (custom_strike UUID + yes_sub_title), use yes_sub_title
  //    BUT prefix with bet-type keyword to prevent cross-bet-type false matches
  if (km.yes_sub_title && km.no_sub_title) {
    const cs = km.custom_strike;
    if (cs) {
      const values = Object.values(cs);
      if (values.length > 0) {
        const val = String(values[0]);
        const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        if (uuidRegex.test(val)) {
          // Sport market with UUID custom_strike: entity name is in yes_sub_title, e.g. "Belgium", "Tie"
          // Include bet-type context from title to prevent cross-bet-type matching
          const betType = extractBetType(km.title || '');
          // Political markets (e.g. KXHOUSERACE): yes_sub_title is the candidate name,
          // but PM groupItemTitle is the party name. Use the title-extracted name instead
          // so "Republican" matches "Republican Party".
          if (cs && 'political_party' in cs) {
            const titleName = extractNameFromKalshiTitle(km.title || km.ticker);
            return betType ? `${betType} ${titleName}` : titleName;
          }
          return betType ? `${betType} ${km.yes_sub_title}` : km.yes_sub_title;
        }
      }
    }
  }

  // 2. Otherwise, use custom_strike value (non-UUID) or extracted title
  let base = '';
  const cs = km.custom_strike;
  if (cs) {
    const values = Object.values(cs);
    if (values.length > 0) {
      const val = String(values[0]);
      const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      if (!uuidRegex.test(val)) base = val;
    }
  }
  if (!base) {
    // BUG-030: never fall back to the raw ticker as a display name.
    // Fallback chain: title → yes_sub_title → humanized ticker.
    if (km.title) {
      base = extractNameFromKalshiTitle(km.title);
    } else if (km.yes_sub_title) {
      base = km.yes_sub_title;
    } else {
      base = humanizeKalshiTicker(km.ticker);
    }
  }

  // 3. Append ticker-derived date/sub-code so identical bases stay distinct.
  const parsed = parseKalshiTicker(km.ticker);
  if (!parsed) return base;

  if (parsed.sub) {
    // sub like T77  -> >77°F,  T70 -> <70°F,  B74.5 -> 74-75°F
    let detail = parsed.sub;
    if (detail.startsWith('T')) {
      const val = parseFloat(detail.slice(1));
      // Temperature threshold:  T70 -> <70°, T77 -> >77°
      detail = (val <= 50 ? '\u003c' : '\u003e') + detail.slice(1) + '°F';
    } else if (detail.startsWith('B')) {
      const val = parseFloat(detail.slice(1));
      detail = (val - 0.5) + '-' + (val + 0.5) + '°F';
    }
    return `${base} (${detail}, ${parsed.label})`;
  }
  return `${base} (${parsed.label})`;
}

export function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
}

export function similarity(a: string, b: string): number {
  const arrA = a.split(' ').filter(s => s.length >= 2);
  const arrB = b.split(' ').filter(s => s.length >= 2);
  const setA = new Set(arrA);
  const setB = new Set(arrB);
  const all = new Set([...arrA, ...arrB]);
  if (all.size === 0) return 0;
  let shared = 0;
  for (const w of all) if (setA.has(w) && setB.has(w)) shared++;
  return shared / all.size;
}

export function parseDepth(val: string | number | null | undefined): number {
  if (val === null || val === undefined) return 0;
  // A synthetic/unbounded depth is not an executable order-book level. Every
  // executable arbitrage needs a finite ask quantity from the actual book.
  if (typeof val === 'number') return Number.isFinite(val) && val > 0 ? val : 0;
  const s = String(val).trim().replace(/^\$/, '');
  if (s === 'Infinity') return 0;
  // The complete value must be a numeric depth with at most one known suffix.
  // Never treat a malformed upstream value such as "500 contracts" as fillable.
  const m = s.match(/^([\d.,]+)\s*([KMB]?)\s*$/i);
  if (!m) return 0;
  let num = parseFloat(m[1].replace(/,/g, ''));
  const suffix = (m[2] || '').toUpperCase();
  if (suffix === 'K') num *= 1000;
  if (suffix === 'M') num *= 1_000_000;
  if (suffix === 'B') num *= 1_000_000_000;
  return Number.isFinite(num) && num > 0 ? num : 0;
}

/** Compute the maximum profit possible given available liquidity (depth). */
export function calculateArbitrageMax(
  kalshi: NonNullable<UnifiedOutcome['kalshi']>,
  pm: NonNullable<UnifiedOutcome['polymarket']>,
  depthKYes: number,
  depthKNo: number,
  depthPYes: number,
  depthPNo: number,
  category?: string,
  maxCapital = 1000,
): UnifiedOutcome['arbitrage'] {
  // RES-012 F1: `maxCapital` is retained for API compatibility, but canonical
  // opportunity economics always request one explicit unit on every leg.
  void maxCapital;
  const requestedContracts = 1 as const;
  const kYes = kalshi.yesAsk;
  const kNo = kalshi.noAsk;
  const pYes = pm.bestAsk;
  const pNo = pm.noPrice;
  const pYesLimit = finiteDecimal(pm.yesLimitPrice) ?? pYes;
  const pNoLimit = finiteDecimal(pm.noLimitPrice) ?? pNo;
  const pmFeeRateBps = resolvePolymarketFeeRateBps(pm, category);
  if (pmFeeRateBps == null) {
    return {
      strategy: 'No arb', arbType: null, kalshiStake: 0, pmStake: 0,
      expectedProfit: 0, roiPct: 0, apyPct: 0, maxCapital: 0,
      buyPlatform: null, buyPrice: 0, sellPlatform: null, sellPrice: 0,
      depthVerified: false, requestedContracts,
      executionStatus: 'unavailable', executionBlocker: 'Polymarket fee authority is unavailable',
    };
  }
  // A zero, negative, non-finite, or above-par ask is not a tradeable quote.
  // Do not turn malformed/missing upstream prices into an apparent arbitrage.
  const isTradeableAsk = (price: number) => Number.isFinite(price) && price > 0 && price <= 1;

  let maxProfit = -Infinity;
  let strategy = 'No arb';
  let bestCapital = 0;
  let kalshiStakeResult = 0;
  let pmStakeResult = 0;
  let buyPlatform: 'kalshi' | 'polymarket' | null = null;
  let buyPrice = 0;
  let sellPlatform: 'kalshi' | 'polymarket' | null = null;
  let sellPrice = 0;
  let feeInfo: UnifiedOutcome['arbitrage']['fees'] = undefined;
  let hasCandidate = false;
  let bestUnexecutableQuote: {
    strategy: string;
    roiPct: number;
    buyPlatform: 'kalshi' | 'polymarket';
    buyPrice: number;
    sellPlatform: 'kalshi' | 'polymarket';
    sellPrice: number;
    blocker: string;
    fees: NonNullable<UnifiedOutcome['arbitrage']['fees']>;
  } | null = null;

  const considerUnexecutableQuote = (
    quoteStrategy: string,
    kalshiPrice: number,
    pmPrice: number,
    quoteBuyPlatform: 'kalshi' | 'polymarket',
    quoteSellPlatform: 'kalshi' | 'polymarket',
    blocker: string,
    authoritativeContracts: number,
  ) => {
    // Preserve the established display normalization for depth/tick blockers,
    // but price venue-minimum evidence at the exact quantity BotTrader will use.
    const quoteCapital = authoritativeContracts > 1 ? authoritativeContracts : 100;
    const fees = computeArbitrageFees(
      quoteStrategy, quoteCapital, quoteCapital * kalshiPrice, quoteCapital * pmPrice,
      kYes, kNo, pYes, pNo, category, kalshi.feeAuthority,
      pmFeeRateBps,
    );
    const roiPct = (fees.worstCaseNetProfit / quoteCapital) * 100;
    if (roiPct > 0 && (!bestUnexecutableQuote || roiPct > bestUnexecutableQuote.roiPct)) {
      bestUnexecutableQuote = {
        strategy: quoteStrategy, roiPct,
        buyPlatform: quoteBuyPlatform,
        buyPrice: quoteBuyPlatform === 'kalshi' ? kYes : pYes,
        sellPlatform: quoteSellPlatform,
        sellPrice: quoteSellPlatform === 'kalshi' ? kNo : pNo,
        blocker,
        fees: {
          kalshiFee: fees.kalshiFee,
          pmFee: fees.pmFee,
          kalshiFeeDetails: fees.kalshiFeeDetails,
          pmFeeDetails: fees.pmFeeDetails,
          netProfitIfKalshiWins: fees.netProfitIfKalshiWins,
          netProfitIfPmWins: fees.netProfitIfPmWins,
          worstCaseNetProfit: fees.worstCaseNetProfit,
        },
      };
    }
  };

  // UI-03: Always compute both strategies regardless of spread, so we return
  // the actual (negative) net ROI even when no arb exists. Victor wants to see
  // how close a pair is to being profitable. The < 1 gate was hiding all
  // negative-spread pairs, showing 0.0% instead of the real number.
  {
    // Strategy 1: Buy YES Kalshi + NO PM

    const pmMinimum = finiteDecimal(pm.noMinOrderSize);
    const pmTick = finiteDecimal(pm.noTickSize);
    const blocker = pmMinimum === null
      ? 'Polymarket NO minimum order is unavailable'
      : pmMinimum > requestedContracts
      ? `Polymarket NO minimum order is ${pmMinimum} shares; requested 1 share`
      : pmTick === null
        ? 'Polymarket NO tick size is unavailable'
        : !isPriceAlignedToTick(pNoLimit, pmTick)
          ? `Polymarket NO limit price ${pNoLimit} is not aligned to tick size ${pmTick}`
      : depthKYes < kYes
        ? `Kalshi YES top-of-book depth ${depthKYes} USD cannot fill requested 1 contract at ${kYes} USD`
        : depthPNo < pNo
          ? `Polymarket NO top-of-book depth ${depthPNo} USD cannot fill requested 1 share at ${pNo} USD`
          : undefined;
    const capital = blocker == null && isTradeableAsk(kYes) && isTradeableAsk(pNo) ? requestedContracts : 0;
    if (blocker && isTradeableAsk(kYes) && isTradeableAsk(pNo)) {
      considerUnexecutableQuote('Buy YES Kalshi + NO PM', kYes, pNo, 'kalshi', 'polymarket', blocker, pmMinimum ?? 1);
    }
    const effectiveCapital = capital;
    if (effectiveCapital > 0) {
      const fees = computeArbitrageFees(
        'Buy YES Kalshi + NO PM',
        effectiveCapital,
        effectiveCapital * kYes,
        effectiveCapital * pNo,
        kYes,
        kNo,
        pYes,
        pNo,
        category,
        kalshi.feeAuthority,
        pmFeeRateBps,
      );
      // UI-03: Track best candidate regardless of sign (not just > 0)
      if (fees.worstCaseNetProfit > maxProfit) {
        maxProfit = fees.worstCaseNetProfit;
        strategy = 'Buy YES Kalshi + NO PM';
        bestCapital = effectiveCapital;
        kalshiStakeResult = effectiveCapital * kYes;
        pmStakeResult = effectiveCapital * pNo;
        buyPlatform = 'kalshi';
        buyPrice = kYes;
        sellPlatform = 'polymarket';
        sellPrice = pNo;
        feeInfo = {
          kalshiFee: fees.kalshiFee,
          pmFee: fees.pmFee,
          kalshiFeeDetails: fees.kalshiFeeDetails,
          pmFeeDetails: fees.pmFeeDetails,
          netProfitIfKalshiWins: fees.netProfitIfKalshiWins,
          netProfitIfPmWins: fees.netProfitIfPmWins,
          worstCaseNetProfit: fees.worstCaseNetProfit,
          kalshiFeeAuthority: fees.kalshiFeeAuthority,
        };
        hasCandidate = true;
      }
    }
  }

  {
    // Strategy 2: Buy YES PM + NO Kalshi

    const pmMinimum = finiteDecimal(pm.yesMinOrderSize);
    const pmTick = finiteDecimal(pm.yesTickSize);
    const blocker = pmMinimum === null
      ? 'Polymarket YES minimum order is unavailable'
      : pmMinimum > requestedContracts
      ? `Polymarket YES minimum order is ${pmMinimum} shares; requested 1 share`
      : pmTick === null
        ? 'Polymarket YES tick size is unavailable'
        : !isPriceAlignedToTick(pYesLimit, pmTick)
          ? `Polymarket YES limit price ${pYesLimit} is not aligned to tick size ${pmTick}`
      : depthKNo < kNo
        ? `Kalshi NO top-of-book depth ${depthKNo} USD cannot fill requested 1 contract at ${kNo} USD`
        : depthPYes < pYes
          ? `Polymarket YES top-of-book depth ${depthPYes} USD cannot fill requested 1 share at ${pYes} USD`
          : undefined;
    const capital = blocker == null && isTradeableAsk(pYes) && isTradeableAsk(kNo) ? requestedContracts : 0;
    if (blocker && isTradeableAsk(pYes) && isTradeableAsk(kNo)) {
      considerUnexecutableQuote('Buy YES PM + NO Kalshi', kNo, pYes, 'polymarket', 'kalshi', blocker, pmMinimum ?? 1);
    }
    const effectiveCapital = capital;
    if (effectiveCapital > 0) {
      const fees = computeArbitrageFees(
        'Buy YES PM + NO Kalshi',
        effectiveCapital,
        effectiveCapital * kNo,
        effectiveCapital * pYes,
        kYes,
        kNo,
        pYes,
        pNo,
        category,
        kalshi.feeAuthority,
        pmFeeRateBps,
      );
      // UI-03: Track best candidate regardless of sign (not just > 0)
      if (fees.worstCaseNetProfit > maxProfit) {
        maxProfit = fees.worstCaseNetProfit;
        strategy = 'Buy YES PM + NO Kalshi';
        bestCapital = effectiveCapital;
        kalshiStakeResult = effectiveCapital * kNo;
        pmStakeResult = effectiveCapital * pYes;
        buyPlatform = 'polymarket';
        buyPrice = pYes;
        sellPlatform = 'kalshi';
        sellPrice = kNo;
        feeInfo = {
          kalshiFee: fees.kalshiFee,
          pmFee: fees.pmFee,
          kalshiFeeDetails: fees.kalshiFeeDetails,
          pmFeeDetails: fees.pmFeeDetails,
          netProfitIfKalshiWins: fees.netProfitIfKalshiWins,
          netProfitIfPmWins: fees.netProfitIfPmWins,
          worstCaseNetProfit: fees.worstCaseNetProfit,
          kalshiFeeAuthority: fees.kalshiFeeAuthority,
        };
        hasCandidate = true;
      }
    }
  }

  // UI-03: hasCandidate is now always true when both kalshi and pm have valid
  // prices — we always computed at least one strategy. The only way it's false
  // is if effectiveCapital was 0 for both (e.g. zero-depth on all legs).
  if (!hasCandidate) {
    const quote = bestUnexecutableQuote as {
      strategy: string;
      roiPct: number;
      buyPlatform: 'kalshi' | 'polymarket';
      buyPrice: number;
      sellPlatform: 'kalshi' | 'polymarket';
      sellPrice: number;
      blocker: string;
      fees: NonNullable<UnifiedOutcome['arbitrage']['fees']>;
    } | null;
    if (quote) {
      return {
        strategy: quote.strategy,
        roiPct: quote.roiPct,
        buyPlatform: quote.buyPlatform,
        buyPrice: quote.buyPrice,
        sellPlatform: quote.sellPlatform,
        sellPrice: quote.sellPrice,
        kalshiStake: 0,
        pmStake: 0,
        expectedProfit: 0,
        maxCapital: 0,
        fees: quote.fees,
        arbType: 'direct',
        depthVerified: false,
        requestedContracts,
        executionStatus: 'non_executable',
        executionBlocker: quote.blocker,
      };
    }
    return {
      strategy: 'No arb',
      kalshiStake: 0,
      pmStake: 0,
      expectedProfit: 0,
      roiPct: 0,
      maxCapital: 0,
      buyPlatform: null,
      buyPrice: 0,
      sellPlatform: null,
      sellPrice: 0,
      fees: undefined,
      arbType: 'direct',
      depthVerified: false,
      requestedContracts,
      executionStatus: 'unavailable',
    };
  }

  const quote = bestUnexecutableQuote as {
    strategy: string;
    roiPct: number;
    buyPlatform: 'kalshi' | 'polymarket';
    buyPrice: number;
    sellPlatform: 'kalshi' | 'polymarket';
    sellPrice: number;
    blocker: string;
    fees: NonNullable<UnifiedOutcome['arbitrage']['fees']>;
  } | null;
  const executableRoiPct = bestCapital > 0 ? (maxProfit / bestCapital) * 100 : 0;
  if (quote && quote.roiPct > executableRoiPct) {
    return {
      strategy: quote.strategy,
      roiPct: quote.roiPct,
      buyPlatform: quote.buyPlatform,
      buyPrice: quote.buyPrice,
      sellPlatform: quote.sellPlatform,
      sellPrice: quote.sellPrice,
      kalshiStake: 0,
      pmStake: 0,
      expectedProfit: 0,
      maxCapital: 0,
      fees: quote.fees,
      arbType: 'direct',
      depthVerified: false,
      requestedContracts,
      executionStatus: 'non_executable',
      executionBlocker: quote.blocker,
    };
  }

  return {
    strategy,
    kalshiStake: kalshiStakeResult,
    pmStake: pmStakeResult,
    expectedProfit: maxProfit,
    roiPct: bestCapital > 0 ? (maxProfit / bestCapital) * 100 : 0,
    maxCapital: bestCapital,
    buyPlatform,
    buyPrice,
    sellPlatform,
    sellPrice,
    fees: feeInfo,
    arbType: 'direct',
    depthVerified: true,
    requestedContracts,
    executionStatus: 'executable',
  };
}

/** Compute the best arbitrage for a single outcome, including cross-outcome with a complement. */
export function calculateBestArbitrageForOutcome(
  current: UnifiedOutcome,
  complement: UnifiedOutcome | null,
  category?: string,
  maxCapital = 1000,
  crossOutcomeVerified = false,
): UnifiedOutcome['arbitrage'] {
  if (!current.kalshi || !current.polymarket) {
    return { strategy: 'No arb', arbType: null, kalshiStake: 0, pmStake: 0, expectedProfit: 0, roiPct: 0, apyPct: 0, buyPlatform: null, buyPrice: 0, sellPlatform: null, sellPrice: 0, maxCapital: 0 };
  }

  // BUG-086b: Zero prices mean no orderbook/liquidity — don't compute arbitrage
  if ((current.kalshi.yesAsk ?? 0) === 0 && (current.kalshi.noAsk ?? 0) === 0) {
    return { strategy: 'No arb', arbType: null, kalshiStake: 0, pmStake: 0, expectedProfit: 0, roiPct: 0, apyPct: 0, buyPlatform: null, buyPrice: 0, sellPlatform: null, sellPrice: 0, maxCapital: 0 };
  }
  if (current.polymarket.isExecutable === false) {
    return { strategy: 'No arb', arbType: null, kalshiStake: 0, pmStake: 0, expectedProfit: 0, roiPct: 0, apyPct: 0, buyPlatform: null, buyPrice: 0, sellPlatform: null, sellPrice: 0, maxCapital: 0 };
  }
  if ((current.polymarket.bestAsk ?? 0) === 0 && (current.polymarket.noPrice ?? 0) === 0 && (current.polymarket.yesPrice ?? 0) === 0) {
    return { strategy: 'No arb', arbType: null, kalshiStake: 0, pmStake: 0, expectedProfit: 0, roiPct: 0, apyPct: 0, buyPlatform: null, buyPrice: 0, sellPlatform: null, sellPrice: 0, maxCapital: 0 };
  }

  const depthKYes = parseDepth(current.kalshi.yesAskDepth);
  const depthKNo = parseDepth(current.kalshi.noAskDepth);
  // CLOB depth is normally numeric, but it is still upstream data. Normalize
  // it here as well as at ingestion: Infinity/NaN must never turn into an
  // executable capital cap through Math.min(..., maxCapital).
  const depthPYes = parseDepth(current.polymarket.askDepth);
  const depthPNo = parseDepth(current.polymarket.noAskDepth);

  // Base: within-outcome arbitrages (existing yellow methods)
  let best: UnifiedOutcome['arbitrage'] = calculateArbitrageMax(
    current.kalshi,
    current.polymarket,
    depthKYes,
    depthKNo,
    depthPYes,
    depthPNo,
    category,
    maxCapital,
  );

  // BUG-142: an Internal arb is complementary YES + NO on one authoritative
  // binary contract. Each leg needs positive executable depth and its own fee.
  const kYes = current.kalshi.yesAsk;
  const kNo = current.kalshi.noAsk;
  if (current.kalshi.ticker && kYes > 0 && kNo > 0 && kYes + kNo < 1) {
    const contracts = depthKYes >= kYes && depthKNo >= kNo ? 1 : 0;
    if (contracts > 0) {
      const yesStake = contracts * kYes;
      const noStake = contracts * kNo;
      const yesFee = calcKalshiFee(contracts, kYes, current.kalshi.feeAuthority);
      const noFee = calcKalshiFee(contracts, kNo, current.kalshi.feeAuthority);
      const totalFee = yesFee + noFee;
      const netProfit = contracts - yesStake - noStake - totalFee;
      const totalStake = yesStake + noStake;
      if (netProfit > 0 && netProfit > best.expectedProfit) {
        best = {
          strategy: `Same-platform YES+NO Kalshi: ${current.artist}`,
          arbType: 'internal', kalshiStake: totalStake, pmStake: 0,
          expectedProfit: netProfit, roiPct: totalStake > 0 ? netProfit / totalStake * 100 : 0,
          maxCapital: contracts, buyPlatform: 'kalshi', buyPrice: kYes,
          sellPlatform: 'kalshi', sellPrice: kNo, depthVerified: true,
          requestedContracts: 1, executionStatus: 'executable',
          fees: {
            kalshiFee: totalFee, pmFee: 0,
            kalshiFeeDetails: `Kalshi YES ${contracts.toFixed(0)} @ $${fmtProbPrice(kYes)} (${formatFee(yesFee)}) + NO ${contracts.toFixed(0)} @ $${fmtProbPrice(kNo)} (${formatFee(noFee)}) = ${formatFee(totalFee)}`,
            pmFeeDetails: 'Polymarket: not involved',
            netProfitIfKalshiWins: netProfit, netProfitIfPmWins: netProfit,
            worstCaseNetProfit: netProfit,
            kalshiFeeAuthority: current.kalshi.feeAuthority,
          },
        };
      }
    }
  }

  const pYes = current.polymarket.bestAsk;
  const pNo = current.polymarket.noPrice;
  const currentPmFeeRateBps = resolvePolymarketFeeRateBps(current.polymarket, category);
  if (current.polymarket.binaryVerified === true && current.polymarket.negRisk !== true
      && currentPmFeeRateBps != null && current.polymarket.conditionId
      && pYes > 0 && pNo > 0 && pYes + pNo < 1) {
    const yesMinimum = finiteDecimal(current.polymarket.yesMinOrderSize);
    const noMinimum = finiteDecimal(current.polymarket.noMinOrderSize);
    const yesTick = finiteDecimal(current.polymarket.yesTickSize);
    const noTick = finiteDecimal(current.polymarket.noTickSize);
    const minimumsExecutable = yesMinimum != null && yesMinimum <= 1 && noMinimum != null && noMinimum <= 1;
    const ticksExecutable = yesTick != null && noTick != null
      && isPriceAlignedToTick(pYes, yesTick)
      && isPriceAlignedToTick(pNo, noTick);
    const contracts = minimumsExecutable && ticksExecutable && depthPYes >= pYes && depthPNo >= pNo ? 1 : 0;
    if (contracts > 0) {
      const yesStake = contracts * pYes;
      const noStake = contracts * pNo;
      const theta = currentPmFeeRateBps / 10_000;
      const yesFee = calcPolymarketFee(contracts, pYes, theta);
      const noFee = calcPolymarketFee(contracts, pNo, theta);
      const totalFee = yesFee + noFee;
      const netProfit = contracts - yesStake - noStake - totalFee;
      const totalStake = yesStake + noStake;
      if (netProfit > 0 && netProfit > best.expectedProfit) {
        best = {
          strategy: `Same-platform YES+NO Polymarket: ${current.artist}`,
          arbType: 'internal', kalshiStake: 0, pmStake: totalStake,
          expectedProfit: netProfit, roiPct: totalStake > 0 ? netProfit / totalStake * 100 : 0,
          maxCapital: contracts, buyPlatform: 'polymarket', buyPrice: pYes,
          sellPlatform: 'polymarket', sellPrice: pNo,
          pmConditionId: current.polymarket.conditionId, depthVerified: true,
          requestedContracts: 1, executionStatus: 'executable',
          fees: {
            kalshiFee: 0, pmFee: totalFee, kalshiFeeDetails: 'Kalshi: not involved',
            pmFeeDetails: `Polymarket YES ${contracts.toFixed(0)} @ $${fmtProbPrice(pYes)} (${formatFee(yesFee)}) + NO ${contracts.toFixed(0)} @ $${fmtProbPrice(pNo)} (${formatFee(noFee)}) = ${formatFee(totalFee)}`,
            netProfitIfKalshiWins: netProfit, netProfitIfPmWins: netProfit,
            worstCaseNetProfit: netProfit,
          },
        };
      }
    }
  }

  // Cross-outcome: buy YES on both platforms. Only valid for strict binary markets.
  if (crossOutcomeVerified && complement?.kalshi && complement?.polymarket
      && current.artist !== complement.artist
      && current.kalshi.ticker !== complement.kalshi.ticker
      && current.polymarket.conditionId !== complement.polymarket.conditionId) {
    const kYesA = current.kalshi.yesAsk;
    const pYesB = complement.polymarket.bestAsk;
    const complementPmFeeRateBps = resolvePolymarketFeeRateBps(complement.polymarket, category);
    if (complementPmFeeRateBps != null && kYesA + pYesB < 1) {
      const compAskDepth = parseDepth(complement.polymarket.askDepth);
      const capKA = depthKYes >= kYesA ? 1 : 0;
      const capPB = compAskDepth >= pYesB ? 1 : 0;
      const compKalshiYesDepth = parseDepth(complement.kalshi.yesAskDepth ?? 0);
      const capKB = compKalshiYesDepth >= complement.kalshi.yesAsk ? 1 : 0;
      const capPA = depthPYes >= current.polymarket.bestAsk ? 1 : 0;
      // Capital limited by all four legs because we buy YES on both platforms across both outcomes
      const pmMinimum = finiteDecimal(complement.polymarket.yesMinOrderSize);
      const pmTick = finiteDecimal(complement.polymarket.yesTickSize);
      const pmConstraintsExecutable = pmMinimum != null && pmMinimum <= 1 && pmTick != null
        && isPriceAlignedToTick(pYesB, pmTick);
      const capital = pmConstraintsExecutable ? Math.min(capKA, capPB, capKB, capPA, 1) : 0;
      const effectiveCapital = capital;
      if (effectiveCapital > 0) {
        // Cross-outcome stake: buy YES Kalshi on current, buy YES PM on complement
        const kalshiStake = effectiveCapital * kYesA;
        const pmStake = effectiveCapital * pYesB;
        const fees = computeArbitrageFees(
          `Buy YES both sides: Kalshi ${current.artist} + Polymarket ${complement.artist}`,
          effectiveCapital,
          kalshiStake,
          pmStake,
          kYesA,
          current.kalshi.noAsk,
          pYesB,
          complement.polymarket.noPrice,
          category,
          current.kalshi.feeAuthority,
          complementPmFeeRateBps,
        );
        if (fees.worstCaseNetProfit > best.expectedProfit) {
          best = {
            strategy: `Buy YES both sides: Kalshi ${current.artist} + PM ${complement.artist}`,
            arbType: 'cross',
            kalshiStake,
            pmStake,
            expectedProfit: fees.worstCaseNetProfit,
            roiPct: effectiveCapital > 0 ? (fees.worstCaseNetProfit / effectiveCapital) * 100 : 0,
            maxCapital: effectiveCapital,
            buyPlatform: 'kalshi',
            buyPrice: kYesA,
            sellPlatform: 'polymarket',
            sellPrice: pYesB,
            pmConditionId: complement.polymarket.conditionId,
            fees: {
              kalshiFee: fees.kalshiFee,
              pmFee: fees.pmFee,
              kalshiFeeDetails: fees.kalshiFeeDetails,
              pmFeeDetails: fees.pmFeeDetails,
              netProfitIfKalshiWins: fees.netProfitIfKalshiWins,
              netProfitIfPmWins: fees.netProfitIfPmWins,
              worstCaseNetProfit: fees.worstCaseNetProfit,
              kalshiFeeAuthority: current.kalshi.feeAuthority,
            },
            depthVerified: true,
            requestedContracts: 1,
            executionStatus: 'executable',
          };
        }
      }
    }
  }


  // Sanity guard: flag phantom arbs (huge ROI on legs with unknown depth).
  const depthUnknown =
    depthPYes <= 0 || depthPNo <= 0 || depthKYes <= 0 || depthKNo <= 0;

  // BUG-08: Filter false-positive arbs on near-resolved markets.
  // When prices are at extremes (e.g. 0.01/0.99), the market is essentially
  // resolved. Any "arb" with < 0.5% ROI after fees is noise from floating-point
  // precision, not a real opportunity. Zero it out.
  if (best.strategy !== 'No arb') {
    const kalshiYesAsk = current.kalshi.yesAsk;
    const kalshiNoAsk = current.kalshi.noAsk;
    const pmYesAsk = current.polymarket.bestAsk;
    const pmNoAsk = current.polymarket.noPrice;
    const MIN_NET_ROI = 0.5; // % — must beat this after fees to count as arb
    const hasExtremePrice =
      (kalshiYesAsk != null && kalshiYesAsk <= 0.02) ||
      (kalshiNoAsk != null && kalshiNoAsk <= 0.02) ||
      (pmYesAsk != null && pmYesAsk <= 0.02) ||
      (pmNoAsk != null && pmNoAsk <= 0.02) ||
      (kalshiYesAsk != null && kalshiYesAsk >= 0.98) ||
      (kalshiNoAsk != null && kalshiNoAsk >= 0.98) ||
      (pmYesAsk != null && pmYesAsk >= 0.98) ||
      (pmNoAsk != null && pmNoAsk >= 0.98);
    const netRoi = best.fees
      ? (best.fees.worstCaseNetProfit / Math.max(best.kalshiStake + best.pmStake, 0.01)) * 100
      : best.roiPct;
    if (hasExtremePrice && netRoi < MIN_NET_ROI) {
      best.strategy = 'No arb';
      best.arbType = null;
      best.roiPct = 0;
      best.expectedProfit = 0;
      best.kalshiStake = 0;
      best.pmStake = 0;
      if (best.fees) best.fees.worstCaseNetProfit = 0;
    }
  }

  return markSuspiciousArb(best, depthUnknown);
}

/** ROI above this on a leg with unknown/assumed-infinite depth is almost
 *  certainly a phantom quote on a dead/illiquid book, not a fillable arb.
 *  Real cross-platform arbs live in the 1–5% range. Env-tunable. */
/** Parse the suspicious-ROI threshold without allowing a malformed environment
 * value to silently disable (Infinity) or invert (zero/negative) the guard. */
export function parseSuspiciousRoiPct(value: unknown): number {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value.trim()) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 25;
}

export const SUSPICIOUS_ROI_PCT = parseSuspiciousRoiPct(process.env.H2H_SUSPICIOUS_ROI_PCT);

/** SET-003: runtime-tunable suspicious-ROI threshold. Defaults to the env/25
 *  constant; the scan route overwrites it from the settings DB per request. */
let suspiciousRoiPct = SUSPICIOUS_ROI_PCT;
export function setSuspiciousRoiPct(v: number): void {
  if (Number.isFinite(v) && v > 0) suspiciousRoiPct = v;
}

/** Flag an arb result as suspicious when ROI exceeds the sanity threshold and
 *  at least one leg's depth was unknown (assumed Infinity / zero-parsed). */
export function markSuspiciousArb<T extends { roiPct: number; strategy: string; suspicious?: boolean }>(
  arb: T,
  depthUnknown: boolean,
): T {
  if (arb.strategy !== 'No arb' && arb.roiPct > suspiciousRoiPct && depthUnknown) {
    arb.suspicious = true;
  }
  return arb;
}

/** For a list of matched outcomes, compute the best arbitrage per outcome including cross-outcome.
 *  Cross-outcome YES+YES is only considered for strict binary markets (exactly two matched outcomes),
 *  and is assigned to the outcome where Kalshi YES is bought so each arb appears once. */
export function calculateAllArbitrages(
  outcomes: UnifiedOutcome[],
  category?: string,
  maxCapital = 1000,
  crossOutcomeGate?: { mutuallyExclusive: boolean; exhaustive: boolean },
): UnifiedOutcome[] {
  // Cross-outcome YES+YES is only valid for a strictly binary market: exactly two possible outcomes.
  const isStrictBinary = outcomes.length === 2
    && crossOutcomeGate?.mutuallyExclusive === true
    && crossOutcomeGate.exhaustive === true;
  const matched = outcomes.filter(o => o.kalshi && o.polymarket);
  const [a, b] = isStrictBinary ? matched : [null, null];

  return outcomes.map(o => {
    let complement: UnifiedOutcome | null = null;
    if (isStrictBinary && a && b) {
      complement = o.artist === a.artist ? b : o.artist === b.artist ? a : null;
    }
    return {
      ...o,
      arbitrage: calculateBestArbitrageForOutcome(o, complement, category, maxCapital, isStrictBinary),
    };
  });
}

/** Bind scenario APY to the exact Kalshi/PM legs selected by each strategy. */
export function attachOutcomeContingentApy(
  outcomes: UnifiedOutcome[],
  observedAt: string,
  expiryAt?: string | null,
): UnifiedOutcome[] {
  return outcomes.map((outcome) => {
    const selectedPm = outcome.arbitrage.pmConditionId
      ? outcomes.find((candidate) => candidate.polymarket?.conditionId === outcome.arbitrage.pmConditionId)?.polymarket
      : outcome.polymarket;
    const outcomeApy = calculateOutcomeContingentApy({
      roiPct: outcome.arbitrage.roiPct,
      observedAt,
      arbType: outcome.arbitrage.arbType,
      strategy: outcome.arbitrage.strategy,
      kalshi: outcome.kalshi?.settlementTiming ?? null,
      polymarket: selectedPm?.settlementTiming ?? null,
      rulesAligned: outcome.arbitrage.arbType === 'internal'
        || outcome.resolutionRulesAligned === true,
    });
    const canonicalApy = calculateScanApy(outcome.arbitrage.roiPct, observedAt, expiryAt);
    return {
      ...outcome,
      arbitrage: {
        ...outcome.arbitrage,
        apyPct: canonicalApy.apyPct,
        daysToExpiry: canonicalApy.daysToExpiry,
        expiryAt: expiryAt ?? null,
        apyUnavailableReason: canonicalApy.unavailableReason,
        outcomeApy,
      },
    };
  });
}

/** @deprecated Persist calculateScanApy() at event time instead of recomputing in consumers. */
export function computeApy(roiPct: number, expiryDate: string | null | undefined): number | null {
  return calculateScanApy(roiPct, new Date().toISOString(), expiryDate).apyPct;
}

function filterKalshiMarketsByEventTitle(kMarkets: KalshiMarket[], pmEventTitle: string): KalshiMarket[] {
  // Fast path: small Kalshi sets don't need filtering
  if (kMarkets.length <= 30) return kMarkets;

  const stopWords = new Set(['the', 'and', 'or', 'vs', 'at', 'in', 'on', 'by', 'to', 'of', 'for', 'a', 'an', 'will', 'be', 'has', 'is', 'are', 'was', 'were']);

  // Extract meaningful PM event words
  const pmWords = normalizeName(pmEventTitle)
    .split(' ')
    .filter(w => w.length >= 3 && !stopWords.has(w));

  // No meaningful PM words: return top markets ranked by volume/liquidity
  if (pmWords.length === 0) {
    return kMarkets
      .slice()
      .sort((a, b) => {
        const depthA = (a.open_interest_fp ? Number(a.open_interest_fp) : 0);
        const depthB = (b.open_interest_fp ? Number(b.open_interest_fp) : 0);
        return depthB - depthA;
      })
      .slice(0, 60);
  }

  // Score ALL Kalshi markets against PM event title
  const pmWordsSet = new Set(pmWords);
  const scored = kMarkets.map(km => {
    const title = normalizeName(km.title || '');
    const titleWords = new Set(title.split(' '));
    let score = 0;
    for (const w of pmWordsSet) {
      if (titleWords.has(w)) score += 1;
    }
    return { km, score };
  });

  // Sort by score descending, then by volume as tiebreaker
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const depthA = (a.km.open_interest_fp ? Number(a.km.open_interest_fp) : 0);
    const depthB = (b.km.open_interest_fp ? Number(b.km.open_interest_fp) : 0);
    return depthB - depthA;
  });

  // Take top markets (up to 100) to ensure we don't miss matches
  return scored.slice(0, 100).map(s => s.km);
}

function isBinaryMarket(outcomes: string[]): boolean {
  const lower = outcomes.map(o => o.toLowerCase());
  return (lower.length === 2 && lower.includes('yes') && lower.includes('no'));
}

function hasVerifiedBinaryTokens(market: PMMarket, outcomes: string[]): boolean {
  if (!market.conditionId || !isBinaryMarket(outcomes)) return false;
  try {
    const tokenIds = JSON.parse(market.clobTokenIds ?? 'null');
    return Array.isArray(tokenIds)
      && tokenIds.length === outcomes.length
      && tokenIds.every((tokenId) => typeof tokenId === 'string' && tokenId.trim() !== '')
      && new Set(tokenIds).size === tokenIds.length;
  } catch {
    return false;
  }
}

// --- Helper to build the PM shape used by matching; scan route calculates arbitrage. ---
export function buildPmArbShape(market: PMMarket, eventEndDate?: string) {
  const { outcomes, prices } = parseOutcomes(market);
  let tokenIds: string[] = [];
  try {
    const parsed = JSON.parse(market.clobTokenIds ?? '[]') as unknown;
    if (Array.isArray(parsed) && parsed.every((token) => typeof token === 'string')) tokenIds = parsed;
  } catch { /* missing token metadata remains explicit */ }
  const yesIndex = outcomes.findIndex((outcome) => outcome.toLowerCase() === 'yes');
  const noIndex = outcomes.findIndex((outcome) => outcome.toLowerCase() === 'no');
  const exactTokens = {
    ...(yesIndex >= 0 && tokenIds[yesIndex] ? { yesTokenId: tokenIds[yesIndex] } : {}),
    ...(noIndex >= 0 && tokenIds[noIndex] ? { noTokenId: tokenIds[noIndex] } : {}),
  };
  const isNegRisk = market.neg_risk === true || market.negRisk === true;
  const binaryVerified = hasVerifiedBinaryTokens(market, outcomes) && !isNegRisk;
  
  // DEBUG
  const DEBUG_H2H = process.env.DEBUG_H2H === '1' || process.env.DEBUG_H2H === 'true';
  if (DEBUG_H2H) {
    console.log('[DEBUG] buildPmArbShape:', market.conditionId?.slice(0, 12), 'neg_risk:', market.neg_risk, 'prices:', prices);
  }
  
  // Gamma API bestBid/bestAsk are YES-side orderbook prices.
  // bestBid = what buyers offer for YES (so NO sell = 1 - bestBid).
  // bestAsk = what sellers charge for YES (so YES buy = bestAsk).
  //
  // CRITICAL: gamma outcomePrices is aggressively cached and stale
  // (e.g. outcomePrices=[0,1] while bestAsk=0.001 live). Never use
  // outcomePrices when bestBid/bestAsk are present.
  //
  // When only one side has orderbook data, derive the other from it
  // (binary YES/NO markets sum to 1). This avoids JS null coercion
  // (1 - null = 1) which produced NO=$1 for every market with null bestBid.
  // 
  // FOR NEG-RISK MARKETS: outcomes are independent. The CLOB enrichment
  // already fetched both YES and NO token orderbooks and provided the
  // correct yesPrice/noPrice in outcomePrices. We should USE THOSE DIRECTLY
  // instead of re-deriving from YES-side bestBid/bestAsk (which is wrong
  // for neg-risk since NO has its own orderbook).
  // Gamma's expanded payload is untyped network input. A malformed best quote
  // must behave as absent, not as a live orderbook value or an arbitrary value
  // returned to the client.
  const binaryQuoteOrNull = (value: unknown): number | null => {
    const parsed = finiteDecimal(value);
    return parsed !== null && parsed >= 0 && parsed <= 1 ? parsed : null;
  };
  const rawBestAsk = binaryQuoteOrNull(market.bestAsk);
  const rawBestBid = binaryQuoteOrNull(market.bestBid);

  // A successful CLOB lookup with no asks is non-executable. Preserve the
  // CLOB token prices for display, but force the execution fields to zero.
  if (market.clobEmpty) {
    return {
      marketId: market.id,
      conditionId: market.conditionId,
      ...exactTokens,
      yesPrice: prices[0] ?? 0,
      noPrice: prices[1] ?? 0,
      bestBid: 0,
      bestAsk: 0,
      lastTradePrice: 0,
      volume: market.volume,
      liquidity: market.liquidity,
      askDepth: 0,
      noAskDepth: 0,
      yesMinOrderSize: finiteDecimal(market.yesMinOrderSize) ?? undefined,
      noMinOrderSize: finiteDecimal(market.noMinOrderSize) ?? undefined,
      yesTickSize: finiteDecimal(market.yesTickSize) ?? undefined,
      noTickSize: finiteDecimal(market.noTickSize) ?? undefined,
      negRisk: market.neg_risk === true,
      feesEnabled: market.feesEnabled,
      feeSchedule: market.feeSchedule,
      binaryVerified,
      isExecutable: false,
      settlementTiming: polymarketSettlementTiming(eventEndDate ?? market.endDate, market.endDate),
    } as NonNullable<UnifiedOutcome['polymarket']>;
  }

  let yesPrice: number;
  let noPrice: number;

  // Detect "empty orderbook" — when bestAsk≈1 and bestBid≈0 there's no
  // real liquidity. Use gamma outcomePrices instead.
  const hasOrderbook = !(rawBestAsk != null && rawBestBid != null && rawBestAsk >= 0.99 && rawBestBid <= 0.01);

  if (!hasOrderbook) {
    yesPrice = prices[0] ?? 0;
    noPrice = prices[1] ?? (1 - yesPrice);
  } else if (isNegRisk) {
    // Neg-risk: CLOB enrichment already provided correct prices in outcomePrices
    // (fetched from YES token ask and NO token bid independently).
    // The parsed `prices` array has [yesPrice, noPrice] from the live CLOB data.
    // Just use them as-is — don't apply binary market derivation logic.
    yesPrice = prices[0] ?? 0;
    noPrice = prices[1] ?? 0;
  } else if (rawBestAsk != null && rawBestBid != null) {
    yesPrice = rawBestAsk;
    noPrice = 1 - rawBestBid;
  } else if (rawBestAsk != null) {
    yesPrice = rawBestAsk;
    noPrice = 1 - rawBestAsk;
  } else if (rawBestBid != null) {
    yesPrice = 1 - rawBestBid;
    noPrice = rawBestBid;
  } else {
    // No CLOB orderbook data — fall back to gamma outcomePrices.
    // BUG-022: Previously zeroed out all prices when CLOB was empty, which
    // hid legitimate markets that simply have no active CLOB orderbook but
    // do have gamma-cached prices from last trade. These prices may be stale
    // but they're far more useful than 0¢ for the user.
    yesPrice = prices[0] ?? 0;
    noPrice = prices[1] ?? (1 - yesPrice);
  }

  return {
    marketId: market.id,
    conditionId: market.conditionId,
    ...exactTokens,
    yesPrice,
    noPrice,
    yesBid: market.yesBid,
    noBid: market.noBid,
    yesBidDepth: market.yesBidDepth,
    noBidDepth: market.noBidDepth,
    quoteObservedAt: market.quoteObservedAt,
    // When no CLOB orderbook, use gamma prices as bestAsk/bestBid so
    // arb calculation doesn't zero them out. These are stale but non-zero.
    bestBid: rawBestBid != null ? rawBestBid : (yesPrice > 0 ? yesPrice * 0.98 : 0),
    bestAsk: rawBestAsk != null ? rawBestAsk : yesPrice,
    lastTradePrice: finiteMarketPrice(market.lastTradePrice ?? prices[0] ?? 0),
    volume: market.volume,
    liquidity: market.liquidity,
    // MF-001: Gamma liquidity is aggregate market metadata, not quantity that
    // can be filled at the current ask. Missing CLOB depth must fail closed.
    askDepth: Number.isFinite(market.askDepth) ? market.askDepth : 0,
    noAskDepth: Number.isFinite(market.noAskDepth) ? market.noAskDepth : 0,
    yesMinOrderSize: finiteDecimal(market.yesMinOrderSize) ?? undefined,
    noMinOrderSize: finiteDecimal(market.noMinOrderSize) ?? undefined,
    yesTickSize: finiteDecimal(market.yesTickSize) ?? undefined,
    noTickSize: finiteDecimal(market.noTickSize) ?? undefined,
    negRisk: market.neg_risk === true,
    feesEnabled: market.feesEnabled,
    feeSchedule: market.feeSchedule,
    binaryVerified,
    settlementTiming: polymarketSettlementTiming(eventEndDate ?? market.endDate, market.endDate),
  } as NonNullable<UnifiedOutcome['polymarket']>;
}

export function buildKalshiArbShape(km: KalshiMarket): NonNullable<UnifiedOutcome['kalshi']> {
  // A quoted ask can be valid even when Kalshi omits the corresponding size.
  // Preserve that price for display/matching, but keep explicit zero-size offers
  // non-executable. Downstream depth remains zero when size is unknown, so this
  // does not reintroduce BUG-101's synthetic infinite liquidity.
  const executableAsk = (
    price: string | number | null | undefined,
    size: string | number | null | undefined,
  ): number => {
    if (size != null && Number(size) === 0) return 0;
    return finiteMarketPrice(price);
  };

  return {
    ticker: km.ticker,
    yesBid: finiteMarketPrice(km.yes_bid_dollars),
    yesAsk: executableAsk(km.yes_ask_dollars, km.yes_ask_size_fp),
    noBid: finiteMarketPrice(km.no_bid_dollars),
    noAsk: executableAsk(km.no_ask_dollars, km.no_ask_size_fp),
    lastPrice: finiteMarketPrice(km.last_price_dollars),
    volume24h: km.volume_24h_fp,
    yesBidDepth: km.yes_bid_size_fp,
    yesAskDepth: km.yes_ask_size_fp,
    noBidDepth: km.no_bid_size_fp,
    noAskDepth: km.no_ask_size_fp,
    settlementTiming: kalshiSettlementTiming(km),
    eventId: km.event_ticker,
    feeAuthority: km.feeAuthority,
  };
}

export function matchOutcomes(
  kalshiMarkets: KalshiMarket[],
  pmMarkets: PMMarket[],
  pmEventTitle?: string,
  capital = 1000,
  expiryDate?: string,
): UnifiedOutcome[] {
  // BUG-05c/05d: Skip title-based filtering when Kalshi markets were already
  // filtered by match key (small set = precise). Title-based filtering can
  // surface WRONG markets (e.g. Moneyline when looking for "advances") because
  // title words like "France" match multiple market types.
  const kMarkets = (pmEventTitle && kalshiMarkets.length > 30)
    ? filterKalshiMarketsByEventTitle(kalshiMarkets, pmEventTitle)
    : kalshiMarkets;

  // Build Kalshi name map with collision detection
  const kalshiMap = new Map<string, KalshiMarket>();
  const kalshiCollisions = new Set<string>();
  for (const km of kMarkets) {
    const name = normalizeName(getKalshiName(km));
    const existing = kalshiMap.get(name);
    if (existing && existing !== km) {
      if (!kalshiCollisions.has(name)) {
        kalshiCollisions.add(name);
        console.debug(
          `[matcher]: Kalshi name collision on "${name}" — "${km.ticker}" overlaps with "${existing.ticker}"`,
        );
      }
    }
    kalshiMap.set(name, km);
  }

  const pmOutcomes: { title: string; outcomeLabel: string | null; yesPrice: number; noPrice: number; market: PMMarket }[] = [];
  const pmSeenNames = new Map<string, string>(); // normalized -> first raw title
  for (const pm of pmMarkets) {
    const { outcomes, prices } = parseOutcomes(pm);
    const hasNamedGroup = pm.groupItemTitle && pm.groupItemTitle.trim() !== '' && pm.groupItemTitle !== 'N/A';
    const isNamedBinary = hasNamedGroup && outcomes.length === 2 && outcomes[0].toLowerCase() === 'yes' && outcomes[1].toLowerCase() === 'no';

    if (isNamedBinary) {
      const title = pm.groupItemTitle!;
      // Enrich with bet-type context to prevent cross-bet-type matching
      const pmBetType = extractBetType(pm.question || '');
      const enrichedTitle = pmBetType ? `${pmBetType} ${title}` : title;
      const norm = normalizeName(enrichedTitle);
      const prev = pmSeenNames.get(norm);
      if (prev && prev !== enrichedTitle) {
        console.debug(`[matcher]: PM name collision on "${norm}" — "${enrichedTitle}" overlaps with "${prev}"`);
      } else if (!prev) {
        pmSeenNames.set(norm, enrichedTitle);
      }
      pmOutcomes.push({
        title: enrichedTitle,
        outcomeLabel: pm.groupItemTitle?.trim() || null,
        yesPrice: prices[0] || 0,
        noPrice: prices[1] !== undefined ? prices[1] : (1 - (prices[0] || 0)),
        market: pm,
      });
      continue;
    }

    if (isBinaryMarket(outcomes) && !hasNamedGroup) {
      // Binary market without groupItemTitle: use event title as artist
      const title = pm.question || 'Unknown';
      const norm = normalizeName(title);
      const prev = pmSeenNames.get(norm);
      if (prev && prev !== title) {
        console.debug(`[matcher]: PM name collision on "${norm}" — "${title}" overlaps with "${prev}"`);
      } else if (!prev) {
        pmSeenNames.set(norm, title);
      }
      pmOutcomes.push({
        title,
        outcomeLabel: null,
        yesPrice: prices[0] || 0,
        noPrice: prices[1] !== undefined ? prices[1] : (1 - (prices[0] || 0)),
        market: pm,
      });
      continue;
    }

    for (let i = 0; i < outcomes.length; i++) {
      const title = outcomes[i] || pm.groupItemTitle || pm.question || '';
      const norm = normalizeName(title);
      const prev = pmSeenNames.get(norm);
      if (prev && prev !== title) {
        console.debug(`[matcher]: PM name collision on "${norm}" — "${title}" overlaps with "${prev}"`);
      } else if (!prev) {
        pmSeenNames.set(norm, title);
      }
      pmOutcomes.push({
        title,
        outcomeLabel: outcomes[i]?.trim() || null,
        yesPrice: prices[i] || 0,
        noPrice: prices.length > i + 1 ? prices[i + 1] : (1 - prices[i]),
        market: pm,
      });
    }
  }

  const matched: UnifiedOutcome[] = [];
  const usedKalshi = new Set<string>();
  const usedPm = new Set<number>();

  const noArbResult: UnifiedOutcome['arbitrage'] = { strategy: 'No arb', kalshiStake: 0, pmStake: 0, expectedProfit: 0, roiPct: 0, apyPct: 0, buyPlatform: null, buyPrice: 0, sellPlatform: null, sellPrice: 0, arbType: 'direct', maxCapital: 0 };

  // Exact match pass
  const placeholderArb = noArbResult;
  for (let pi = 0; pi < pmOutcomes.length; pi++) {
    const pmo = pmOutcomes[pi];
    const pmNorm = normalizeName(pmo.title);
    const exact = kalshiMap.get(pmNorm);
    if (exact) {
      const kalshi = buildKalshiArbShape(exact);
      const pmShape = buildPmArbShape(pmo.market, expiryDate);
      matched.push({
        artist: stripBetTypePrefix(getKalshiName(exact)),
        kalshiMarketQuestion: exact.title?.trim() || null,
        pmMarketQuestion: pmo.market.question?.trim() || null,
        kalshiOutcomeLabel: exact.yes_sub_title?.trim() || null,
        pmOutcomeLabel: pmo.outcomeLabel,
        kalshi,
        polymarket: pmShape,
        arbitrage: placeholderArb,
        source: 'auto' as const,
        resolutionRulesAligned: true,
        negRisk: pmShape.negRisk,
      });
      usedKalshi.add(exact.ticker);
      usedPm.add(pi);
    }
  }

  // Fuzzy match pass for remaining
  const unusedKalshi = Array.from(kalshiMap.entries()).filter(([, v]) => !usedKalshi.has(v.ticker));
  const unusedPm = Array.from(new Set(pmOutcomes.map((_, i) => i))).filter(i => !usedPm.has(i));

  for (const pi of unusedPm) {
    const pmo = pmOutcomes[pi];
    let bestKm: KalshiMarket | null = null;
    let bestScore = 0;
    for (const [, km] of unusedKalshi) {
      const kmName = getKalshiName(km);
      const s = similarity(normalizeName(pmo.title), normalizeName(kmName));
      // Raise threshold for large events to reduce false-positive cross-bet-type matches
      const minThreshold = pmOutcomes.length > 20 ? 0.6 : 0.4;
      if (s > bestScore && s >= minThreshold) {
        bestScore = s;
        bestKm = km;
      }
    }
    if (bestKm) {
      const kalshi = buildKalshiArbShape(bestKm);
      const pmShape = buildPmArbShape(pmo.market, expiryDate);
      const displayName = stripBetTypePrefix(getKalshiName(bestKm));
      matched.push({
        artist: displayName,
        kalshiMarketQuestion: bestKm.title?.trim() || null,
        pmMarketQuestion: pmo.market.question?.trim() || null,
        kalshiOutcomeLabel: bestKm.yes_sub_title?.trim() || null,
        pmOutcomeLabel: pmo.outcomeLabel,
        kalshi,
        polymarket: pmShape,
        arbitrage: placeholderArb,
        source: 'auto' as const,
        negRisk: pmShape.negRisk,
      });
      usedKalshi.add(bestKm.ticker);
      usedPm.add(pi);
    }
  }

  // Remaining Kalshi only
  for (const [, km] of unusedKalshi) {
    if (!usedKalshi.has(km.ticker)) {
      matched.push({
        artist: stripBetTypePrefix(getKalshiName(km)),
        kalshiMarketQuestion: km.title?.trim() || null,
        kalshiOutcomeLabel: km.yes_sub_title?.trim() || null,
        kalshi: buildKalshiArbShape(km),
        polymarket: null,
        arbitrage: noArbResult,
        source: 'auto' as const,
      });
    }
  }

  // Remaining PM only
  for (const pi of unusedPm) {
    if (!usedPm.has(pi)) {
      const pmo = pmOutcomes[pi];
      const pmShape = buildPmArbShape(pmo.market, expiryDate);
      matched.push({
        artist: stripBetTypePrefix(pmo.title) || 'Unknown',
        pmMarketQuestion: pmo.market.question?.trim() || null,
        pmOutcomeLabel: pmo.outcomeLabel,
        kalshi: null,
        polymarket: pmShape,
        arbitrage: noArbResult,
        source: 'auto' as const,
        negRisk: pmShape.negRisk,
      });
    }
  }

  return matched.map(normalizeOutcomePlatforms);
}

/**
 * Apply manually configured matches to a list of outcomes.
 * For each manual match where we have a Kalshi-only and PM-only entry,
 * merge them into one UnifiedOutcome with source: 'manual'.
 * Returns the merged list and removes the original single-platform entries.
 */
export function applyManualMatches(
  outcomes: UnifiedOutcome[],
  manualMatches: ManualMatch[],
  kalshiMarkets: KalshiMarket[],
  pmMarkets: PMMarket[],
  capital = 1000,
  expiryDate?: string,
): UnifiedOutcome[] {
  if (!manualMatches.length) return outcomes;

  const kalshiByTicker = new Map(kalshiMarkets.map(k => [k.ticker, k]));
  const pmByConditionId = new Map(pmMarkets.map(m => [m.conditionId, m]));

  // Index outcomes by ticker and conditionId
  const kalshiOnlyIdx = new Map<string, number>(); // ticker -> index
  const pmOnlyIdx = new Map<string, number>();     // conditionId -> index
  const matchedPairs = new Set<string>();            // "kalshiTicker|pmConditionId"

  for (let i = 0; i < outcomes.length; i++) {
    const o = outcomes[i];
    if (o.kalshi && !o.polymarket) kalshiOnlyIdx.set(o.kalshi.ticker, i);
    if (o.polymarket && !o.kalshi) pmOnlyIdx.set(o.polymarket.conditionId, i);
    if (o.kalshi && o.polymarket) matchedPairs.add(`${o.kalshi.ticker}|${o.polymarket.conditionId}`);
  }

  const merged = [...outcomes];
  const indicesToRemove = new Set<number>();

  for (const mm of manualMatches) {
    // Skip if this pair was already auto-matched
    if (matchedPairs.has(`${mm.kalshiTicker}|${mm.pmConditionId}`)) continue;

    const kIdx = kalshiOnlyIdx.get(mm.kalshiTicker);
    const pIdx = pmOnlyIdx.get(mm.pmConditionId);

    if (kIdx === undefined || pIdx === undefined) continue;

    const kalshi = outcomes[kIdx].kalshi;
    const pmRaw = outcomes[pIdx].polymarket;
    if (!kalshi || !pmRaw) continue;

    // Rebuild PM shape using fresh market data if available
    const pmMarket = pmByConditionId.get(mm.pmConditionId);
    const pmShapeRaw = pmMarket
      ? buildPmArbShape(pmMarket, expiryDate)
      : pmRaw;
    const pmShape = normalizeManualPairPolymarketShape(pmShapeRaw, mm.orientation);

    // Use placeholder - arbitrage will be calculated by caller with depth info
    const noArbResult: UnifiedOutcome['arbitrage'] = { strategy: 'No arb', kalshiStake: 0, pmStake: 0, expectedProfit: 0, roiPct: 0, apyPct: 0, buyPlatform: null, buyPrice: 0, sellPlatform: null, sellPrice: 0, arbType: 'direct', maxCapital: 0 };

    merged[kIdx] = {
      // UI: Show only the Polymarket name in the Outcome column after coupling.
      // Previously this concatenated both platform names ("KalshiName + PMName")
      // which cluttered the display. The PM name alone is sufficient.
      artist: outcomes[pIdx].artist,
      kalshiMarketQuestion: outcomes[kIdx].kalshiMarketQuestion ?? null,
      pmMarketQuestion: outcomes[pIdx].pmMarketQuestion ?? null,
      kalshiOutcomeLabel: outcomes[kIdx].kalshiOutcomeLabel ?? null,
      pmOutcomeLabel: outcomes[pIdx].pmOutcomeLabel ?? null,
      kalshi,
      polymarket: pmShape,
      arbitrage: noArbResult,
      source: 'manual' as const,
      resolutionRulesAligned: true,
      negRisk: pmShape.negRisk,
    };
    indicesToRemove.add(pIdx);
  }

  // Remove PM-only entries that got merged
  return merged.filter((_, i) => !indicesToRemove.has(i)).map(normalizeOutcomePlatforms);
}
