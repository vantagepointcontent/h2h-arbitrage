import { KalshiMarket } from './kalshi';
import { PMMarket, parseOutcomes } from './polymarket';
import type { ManualMatch } from './manual-matches';
import { classifyArbType, type ArbType } from './arb-types';
import { finiteMarketPrice } from './market-price';

export interface UnifiedOutcome {
  artist: string;
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
  } | null;
  polymarket: {
    marketId: string;
    conditionId: string;
    yesPrice: number;
    noPrice: number;
    bestBid: number;
    bestAsk: number;
    lastTradePrice: number;
    volume?: string;
    liquidity?: string;
    askDepth?: number;
    noAskDepth?: number;
    negRisk?: boolean;
    /** False when prices are indicative only (no executable CLOB asks). */
    isExecutable?: boolean;
  } | null;
  arbitrage: {
    strategy: string;
    /** Arb type classification: "cross" | "direct" | "internal" | null */
    arbType: ArbType | null;
    kalshiStake: number;
    pmStake: number;
    expectedProfit: number;
    roiPct: number;
    apyPct?: number;
    maxCapital?: number;
    buyPlatform: 'kalshi' | 'polymarket' | null;
    buyPrice: number;
    sellPlatform: 'kalshi' | 'polymarket' | null;
    sellPrice: number;
    /** True when ROI exceeds the sanity threshold AND depth on some leg was
     *  unknown/assumed-infinite — almost certainly a phantom quote on an
     *  illiquid book, not a fillable arb. Excluded from stats/alerts. */
    suspicious?: boolean;
    /** True only when every required orderbook leg has known positive ask depth. */
    depthVerified?: boolean;
    /** ARB-01a: classification of the arb strategy.
     *  - "direct": regular YES/NO across platforms (within-outcome)
     *  - "cross": cross-outcome YES+YES across platforms
     *  - "internal": same-platform YES+YES (FEAT-016) */
    arbType?: 'cross' | 'direct' | 'internal';
    /** Fee-adjusted profit per winning platform for the buy side */
    fees?: {
      kalshiFee: number;
      pmFee: number;
      kalshiFeeDetails: string;
      pmFeeDetails: string;
      netProfitIfKalshiWins: number;
      netProfitIfPmWins: number;
      worstCaseNetProfit: number;
    };
  };
  source: 'auto' | 'manual';
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

/** Default fee parameters per platform. Polymarket theta varies by category. */
export function getPolymarketTheta(category?: string): number {
  const c = (category || 'other').toLowerCase();
  if (c.includes('crypto')) return 0.07;
  if (c.includes('sport')) return 0.03;
  if (c.includes('finance')) return 0.04;
  if (c.includes('politic')) return 0.04;
  if (c.includes('econom')) return 0.05;
  if (c.includes('culture')) return 0.05;
  if (c.includes('weather')) return 0.05;
  if (c.includes('mention')) return 0.04;
  if (c.includes('tech')) return 0.04;
  if (c.includes('geopol')) return 0;
  return 0.05;
}

/** Kalshi fee: round up to nearest cent. Default taker rate 0.07. */
export function calcKalshiFee(contracts: number, price: number, rate = 0.07): number {
  if (contracts <= 0 || price <= 0 || price >= 1) return 0;
  const raw = rate * contracts * price * (1 - price);
  // Ignore binary floating-point dust only; genuine fractions of a cent still round up.
  return Math.ceil(raw * 100 - 1e-9) / 100;
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
} {
  const grossProfit = capital - kalshiStake - pmStake;

  let kalshiFeeAmount = 0;
  let kalshiFeeDetails = 'Kalshi: no fee (0 contracts or settled)';
  let pmFeeAmount = 0;
  let pmFeeDetails = 'Polymarket: no fee (0 contracts or settled)';

  if (strategy.includes('YES Kalshi')) {
    // This strategy places exactly one Kalshi order: buy YES.
    const kalshiYesContracts = kalshiStake / kalshiBuyPrice;
    kalshiFeeAmount = calcKalshiFee(kalshiYesContracts, kalshiBuyPrice);
    kalshiFeeDetails = `Kalshi YES buy ${kalshiYesContracts.toFixed(0)} @ $${fmtProbPrice(kalshiBuyPrice)} = ${formatFee(kalshiFeeAmount)}`;
  } else if (strategy.includes('NO Kalshi')) {
    // This strategy places exactly one Kalshi order: buy NO.
    const kalshiNoContracts = kalshiStake / kalshiSellPrice;
    kalshiFeeAmount = calcKalshiFee(kalshiNoContracts, kalshiSellPrice);
    kalshiFeeDetails = `Kalshi NO buy ${kalshiNoContracts.toFixed(0)} @ $${fmtProbPrice(kalshiSellPrice)} = ${formatFee(kalshiFeeAmount)}`;
  }

  if (strategy.includes('YES PM')) {
    const pmYesContracts = pmStake / pmBuyPrice;
    const pmTheta = getPolymarketTheta(category);
    pmFeeAmount = calcPolymarketFee(pmYesContracts, pmBuyPrice, pmTheta);
    pmFeeDetails = `Polymarket YES buy ${pmYesContracts.toFixed(0)} @ $${fmtProbPrice(pmBuyPrice)} (θ=${pmTheta.toFixed(2)}) = ${formatFee(pmFeeAmount)}`;
  } else if (strategy.includes('NO PM')) {
    const pmNoContracts = pmStake / (1 - pmBuyPrice);
    const pmTheta = getPolymarketTheta(category);
    pmFeeAmount = calcPolymarketFee(pmNoContracts, 1 - pmBuyPrice, pmTheta);
    pmFeeDetails = `Polymarket NO buy ${pmNoContracts.toFixed(0)} @ $${fmtProbPrice(1 - pmBuyPrice)} (θ=${pmTheta.toFixed(2)}) = ${formatFee(pmFeeAmount)}`;
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
  if (typeof val === 'number') return val;
  const s = String(val).trim().replace(/^\$/, '');
  if (s === 'Infinity') return Infinity;
  const m = s.match(/^([\d.,]+)\s*([KMB]?)/i);
  if (!m) return 0;
  let num = parseFloat(m[1].replace(/,/g, ''));
  const suffix = (m[2] || '').toUpperCase();
  if (suffix === 'K') num *= 1000;
  if (suffix === 'M') num *= 1_000_000;
  if (suffix === 'B') num *= 1_000_000_000;
  return num;
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
) {
  const kYes = kalshi.yesAsk;
  const kNo = kalshi.noAsk;
  const pYes = pm.bestAsk;
  const pNo = pm.noPrice;
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
  } | null = null;

  const considerUnexecutableQuote = (
    quoteStrategy: string,
    kalshiPrice: number,
    pmPrice: number,
    quoteBuyPlatform: 'kalshi' | 'polymarket',
    quoteSellPlatform: 'kalshi' | 'polymarket',
  ) => {
    const quoteCapital = 100;
    const fees = computeArbitrageFees(
      quoteStrategy, quoteCapital, quoteCapital * kalshiPrice, quoteCapital * pmPrice,
      kYes, kNo, pYes, pNo, category,
    );
    const roiPct = (fees.worstCaseNetProfit / quoteCapital) * 100;
    if (roiPct > 0 && (!bestUnexecutableQuote || roiPct > bestUnexecutableQuote.roiPct)) {
      bestUnexecutableQuote = {
        strategy: quoteStrategy, roiPct,
        buyPlatform: quoteBuyPlatform,
        buyPrice: quoteBuyPlatform === 'kalshi' ? kYes : pYes,
        sellPlatform: quoteSellPlatform,
        sellPrice: quoteSellPlatform === 'kalshi' ? kNo : pNo,
      };
    }
  };

  // UI-03: Always compute both strategies regardless of spread, so we return
  // the actual (negative) net ROI even when no arb exists. Victor wants to see
  // how close a pair is to being profitable. The < 1 gate was hiding all
  // negative-spread pairs, showing 0.0% instead of the real number.
  {
    // Strategy 1: Buy YES Kalshi + NO PM
    if (isTradeableAsk(kYes) && isTradeableAsk(pNo) && (depthKYes <= 0 || depthPNo <= 0)) {
      considerUnexecutableQuote('Buy YES Kalshi + NO PM', kYes, pNo, 'kalshi', 'polymarket');
    }
    const capK = depthKYes > 0 && isTradeableAsk(kYes) ? depthKYes / kYes : 0;
    const capP = depthPNo > 0 && isTradeableAsk(pNo) ? depthPNo / pNo : 0;
    const capital = Math.min(capK, capP, maxCapital);
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
        };
        hasCandidate = true;
      }
    }
  }

  {
    // Strategy 2: Buy YES PM + NO Kalshi
    if (isTradeableAsk(pYes) && isTradeableAsk(kNo) && (depthPYes <= 0 || depthKNo <= 0)) {
      considerUnexecutableQuote('Buy YES PM + NO Kalshi', kNo, pYes, 'polymarket', 'kalshi');
    }
    const capP = depthPYes > 0 && isTradeableAsk(pYes) ? depthPYes / pYes : 0;
    const capK = depthKNo > 0 && isTradeableAsk(kNo) ? depthKNo / kNo : 0;
    const capital = Math.min(capP, capK, maxCapital);
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
        fees: undefined,
        arbType: 'direct',
        depthVerified: false,
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
    };
  }

  const quote = bestUnexecutableQuote as {
    strategy: string;
    roiPct: number;
    buyPlatform: 'kalshi' | 'polymarket';
    buyPrice: number;
    sellPlatform: 'kalshi' | 'polymarket';
    sellPrice: number;
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
      fees: undefined,
      arbType: 'direct',
      depthVerified: false,
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
  };
}

/** Compute the best arbitrage for a single outcome, including cross-outcome with a complement. */
export function calculateBestArbitrageForOutcome(
  current: UnifiedOutcome,
  complement: UnifiedOutcome | null,
  category?: string,
  maxCapital = 1000,
): UnifiedOutcome['arbitrage'] {
  if (!current.kalshi || !current.polymarket) {
    return { strategy: 'No arb', arbType: null, kalshiStake: 0, pmStake: 0, expectedProfit: 0, roiPct: 0, apyPct: 0, buyPlatform: null, buyPrice: 0, sellPlatform: null, sellPrice: 0 };
  }

  // BUG-086b: Zero prices mean no orderbook/liquidity — don't compute arbitrage
  if ((current.kalshi.yesAsk ?? 0) === 0 && (current.kalshi.noAsk ?? 0) === 0) {
    return { strategy: 'No arb', arbType: null, kalshiStake: 0, pmStake: 0, expectedProfit: 0, roiPct: 0, apyPct: 0, buyPlatform: null, buyPrice: 0, sellPlatform: null, sellPrice: 0 };
  }
  if (current.polymarket.isExecutable === false) {
    return { strategy: 'No arb', arbType: null, kalshiStake: 0, pmStake: 0, expectedProfit: 0, roiPct: 0, apyPct: 0, buyPlatform: null, buyPrice: 0, sellPlatform: null, sellPrice: 0 };
  }
  if ((current.polymarket.bestAsk ?? 0) === 0 && (current.polymarket.noPrice ?? 0) === 0 && (current.polymarket.yesPrice ?? 0) === 0) {
    return { strategy: 'No arb', arbType: null, kalshiStake: 0, pmStake: 0, expectedProfit: 0, roiPct: 0, apyPct: 0, buyPlatform: null, buyPrice: 0, sellPlatform: null, sellPrice: 0 };
  }

  const depthKYes = parseDepth(current.kalshi.yesAskDepth);
  const depthKNo = parseDepth(current.kalshi.noAskDepth);
  const depthPYes = current.polymarket.askDepth ?? 0;
  const depthPNo = current.polymarket.noAskDepth ?? 0;

  // Base: within-outcome arbitrages (existing yellow methods)
  let best = calculateArbitrageMax(
    current.kalshi,
    current.polymarket,
    depthKYes,
    depthKNo,
    depthPYes,
    depthPNo,
    category,
    maxCapital,
  );

  // Cross-outcome: buy YES on both platforms. Only valid for strict binary markets.
  if (complement?.kalshi && complement?.polymarket) {
    const kYesA = current.kalshi.yesAsk;
    const pYesB = complement.polymarket.bestAsk;
    if (kYesA + pYesB < 1) {
      const compAskDepth = complement.polymarket.askDepth ?? 0;
      const capKA = depthKYes > 0 ? depthKYes / kYesA : 0;
      const capPB = parseDepth(compAskDepth) > 0 ? compAskDepth / pYesB : 0;
      const compKalshiYesDepth = parseDepth(complement.kalshi.yesAskDepth ?? 0);
      const capKB = compKalshiYesDepth > 0 ? compKalshiYesDepth / complement.kalshi.yesAsk : 0;
      const capPA = depthPYes > 0 ? depthPYes / current.polymarket.bestAsk : 0;
      // Capital limited by all four legs because we buy YES on both platforms across both outcomes
      const capital = Math.min(capKA, capPB, capKB, capPA, maxCapital);
      const effectiveCapital = capital;
      if (effectiveCapital > 0) {
        const grossRoi = 1 - (kYesA + pYesB);
        const grossProfit = effectiveCapital * grossRoi;
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
            fees: {
              kalshiFee: fees.kalshiFee,
              pmFee: fees.pmFee,
              kalshiFeeDetails: fees.kalshiFeeDetails,
              pmFeeDetails: fees.pmFeeDetails,
              netProfitIfKalshiWins: fees.netProfitIfKalshiWins,
              netProfitIfPmWins: fees.netProfitIfPmWins,
              worstCaseNetProfit: fees.worstCaseNetProfit,
            },
            depthVerified: true,
          };
        }
      }
    }
  }

  // FEAT-016: Same-platform YES+YES arbitrage. On a strict binary market
  // (exactly 2 mutually exclusive, exhaustive outcomes), buying YES on BOTH
  // outcomes on the SAME platform guarantees exactly one $1 payout. If the
  // combined YES ask prices are < $1.00 (after fees), it's a guaranteed profit.
  // This is distinct from cross-outcome arb (which buys YES on DIFFERENT platforms).
  if (complement?.kalshi && complement?.polymarket) {
    // ── Kalshi same-platform YES+YES ──
    const kYesA = current.kalshi.yesAsk;
    const kYesB = complement.kalshi.yesAsk;
    if (kYesA > 0 && kYesB > 0 && kYesA + kYesB < 1) {
      const depthKA = depthKYes;
      const depthKB = parseDepth(complement.kalshi.yesAskDepth);
      const capKA = depthKA > 0 ? depthKA / kYesA : 0;
      const capKB = depthKB > 0 ? depthKB / kYesB : 0;
      const capital = Math.min(capKA, capKB, maxCapital);
      const effectiveCapital = capital;
      if (effectiveCapital > 0) {
        const kalshiStakeA = effectiveCapital * kYesA;
        const kalshiStakeB = effectiveCapital * kYesB;
        const grossProfit = effectiveCapital - kalshiStakeA - kalshiStakeB;
        // Kalshi fees: both legs are YES buys, fee = contracts * price * rate
        const contractsA = kalshiStakeA / kYesA;
        const contractsB = kalshiStakeB / kYesB;
        const kalshiFeeA = calcKalshiFee(contractsA, kYesA);
        const kalshiFeeB = calcKalshiFee(contractsB, kYesB);
        const totalKalshiFee = kalshiFeeA + kalshiFeeB;
        const netProfit = grossProfit - totalKalshiFee;
        const roiPct = effectiveCapital > 0 ? (netProfit / effectiveCapital) * 100 : 0;
        if (netProfit > best.expectedProfit) {
          best = {
            strategy: `Same-platform YES+YES Kalshi: ${current.artist} + ${complement.artist}`,
            arbType: 'internal',
            kalshiStake: kalshiStakeA + kalshiStakeB,
            pmStake: 0,
            expectedProfit: netProfit,
            roiPct,
            maxCapital: effectiveCapital,
            buyPlatform: 'kalshi',
            buyPrice: kYesA,
            sellPlatform: 'kalshi',
            sellPrice: kYesB,
            fees: {
              kalshiFee: totalKalshiFee,
              pmFee: 0,
              kalshiFeeDetails: `Kalshi YES A ${contractsA.toFixed(0)} @ $${fmtProbPrice(kYesA)} (${formatFee(kalshiFeeA)}) + YES B ${contractsB.toFixed(0)} @ $${fmtProbPrice(kYesB)} (${formatFee(kalshiFeeB)}) = ${formatFee(totalKalshiFee)}`,
              pmFeeDetails: 'Polymarket: not involved',
              netProfitIfKalshiWins: netProfit,
              netProfitIfPmWins: netProfit,
              worstCaseNetProfit: netProfit,
            },
            depthVerified: true,
          };
        }
      }
    }

    // ── Polymarket same-platform YES+YES ──
    const pYesA = current.polymarket.bestAsk;
    const pYesB = complement.polymarket.bestAsk;
    if (pYesA > 0 && pYesB > 0 && pYesA + pYesB < 1) {
      const depthPA = depthPYes;
      const depthPB = complement.polymarket.askDepth != null && complement.polymarket.askDepth > 0
        ? complement.polymarket.askDepth : 0;
      const capPA = depthPA > 0 ? depthPA / pYesA : 0;
      const capPB = depthPB > 0 ? depthPB / pYesB : 0;
      const capital = Math.min(capPA, capPB, maxCapital);
      const effectiveCapital = capital;
      if (effectiveCapital > 0) {
        const pmStakeA = effectiveCapital * pYesA;
        const pmStakeB = effectiveCapital * pYesB;
        const grossProfit = effectiveCapital - pmStakeA - pmStakeB;
        // Polymarket fees: both legs are YES buys
        const pmTheta = getPolymarketTheta(category);
        const contractsA = pmStakeA / pYesA;
        const contractsB = pmStakeB / pYesB;
        const pmFeeA = calcPolymarketFee(contractsA, pYesA, pmTheta);
        const pmFeeB = calcPolymarketFee(contractsB, pYesB, pmTheta);
        const totalPmFee = pmFeeA + pmFeeB;
        const netProfit = grossProfit - totalPmFee;
        const roiPct = effectiveCapital > 0 ? (netProfit / effectiveCapital) * 100 : 0;
        if (netProfit > best.expectedProfit) {
          best = {
            strategy: `Same-platform YES+YES Polymarket: ${current.artist} + ${complement.artist}`,
            arbType: 'internal',
            kalshiStake: 0,
            pmStake: pmStakeA + pmStakeB,
            expectedProfit: netProfit,
            roiPct,
            maxCapital: effectiveCapital,
            buyPlatform: 'polymarket',
            buyPrice: pYesA,
            sellPlatform: 'polymarket',
            sellPrice: pYesB,
            fees: {
              kalshiFee: 0,
              pmFee: totalPmFee,
              kalshiFeeDetails: 'Kalshi: not involved',
              pmFeeDetails: `Polymarket YES A ${contractsA.toFixed(0)} @ $${fmtProbPrice(pYesA)} (θ=${pmTheta.toFixed(2)}, ${formatFee(pmFeeA)}) + YES B ${contractsB.toFixed(0)} @ $${fmtProbPrice(pYesB)} (θ=${pmTheta.toFixed(2)}, ${formatFee(pmFeeB)}) = ${formatFee(totalPmFee)}`,
              netProfitIfKalshiWins: netProfit,
              netProfitIfPmWins: netProfit,
              worstCaseNetProfit: netProfit,
            },
            depthVerified: true,
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
export const SUSPICIOUS_ROI_PCT = Number(process.env.H2H_SUSPICIOUS_ROI_PCT || 25);

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
): UnifiedOutcome[] {
  // Cross-outcome YES+YES is only valid for a strictly binary market: exactly two possible outcomes.
  const isStrictBinary = outcomes.length === 2;
  const matched = outcomes.filter(o => o.kalshi && o.polymarket);
  const [a, b] = isStrictBinary ? matched : [null, null];

  return outcomes.map(o => {
    let complement: UnifiedOutcome | null = null;
    if (isStrictBinary && a && b) {
      complement = o.artist === a.artist ? b : o.artist === b.artist ? a : null;
    }
    return {
      ...o,
      arbitrage: calculateBestArbitrageForOutcome(o, complement, category, maxCapital),
    };
  });
}

/** Compute APY from ROI and days until expiry. Linear annualisation: 10% in 30 days = 10 * 365/30 = 121.7%. */
export function computeApy(roiPct: number, expiryDate: string | null | undefined): number {
  if (roiPct <= 0) return 0;
  if (!expiryDate) return Math.max(0, roiPct);
  const expiry = new Date(expiryDate).getTime();
  const now = Date.now();
  if (expiry <= now) return 0;
  const daysToExpiry = (expiry - now) / (1000 * 60 * 60 * 24);
  if (daysToExpiry <= 0) return 0;
  return roiPct * (365 / daysToExpiry);
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

// --- Helper to build the PM shape used by matching; scan route calculates arbitrage. ---
export function buildPmArbShape(market: PMMarket) {
  const { prices } = parseOutcomes(market);
  const isNegRisk = market.neg_risk === true;
  
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
  const rawBestAsk = market.bestAsk;
  const rawBestBid = market.bestBid;

  // A successful CLOB lookup with no asks is non-executable. Preserve the
  // CLOB token prices for display, but force the execution fields to zero.
  if (market.clobEmpty) {
    return {
      marketId: market.id,
      conditionId: market.conditionId,
      yesPrice: prices[0] ?? 0,
      noPrice: prices[1] ?? 0,
      bestBid: 0,
      bestAsk: 0,
      lastTradePrice: 0,
      volume: market.volume,
      liquidity: market.liquidity,
      askDepth: 0,
      noAskDepth: 0,
      negRisk: market.neg_risk === true,
      isExecutable: false,
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
    yesPrice,
    noPrice,
    // When no CLOB orderbook, use gamma prices as bestAsk/bestBid so
    // arb calculation doesn't zero them out. These are stale but non-zero.
    bestBid: rawBestBid != null ? rawBestBid : (yesPrice > 0 ? yesPrice * 0.98 : 0),
    bestAsk: rawBestAsk != null ? rawBestAsk : yesPrice,
    lastTradePrice: market.lastTradePrice ?? prices[0] ?? 0,
    volume: market.volume,
    liquidity: market.liquidity,
    // MF-001: Gamma liquidity is aggregate market metadata, not quantity that
    // can be filled at the current ask. Missing CLOB depth must fail closed.
    askDepth: Number.isFinite(market.askDepth) ? market.askDepth : 0,
    noAskDepth: Number.isFinite(market.noAskDepth) ? market.noAskDepth : 0,
    negRisk: market.neg_risk === true,
  } as NonNullable<UnifiedOutcome['polymarket']>;
}

export function buildKalshiArbShape(km: KalshiMarket): NonNullable<UnifiedOutcome['kalshi']> {
  return {
    ticker: km.ticker,
    // Invalid upstream quotes must fail closed rather than leaking NaN into
    // matching and stake calculations. Missing asks retain the legacy $1
    // default, while malformed supplied values become non-executable $0.
    yesBid: finiteMarketPrice(km.yes_bid_dollars || '0'),
    yesAsk: finiteMarketPrice(km.yes_ask_dollars || '1'),
    noBid: finiteMarketPrice(km.no_bid_dollars || '0'),
    noAsk: finiteMarketPrice(km.no_ask_dollars || '1'),
    lastPrice: finiteMarketPrice(km.last_price_dollars || '0'),
    volume24h: km.volume_24h_fp,
    yesBidDepth: km.yes_bid_size_fp,
    yesAskDepth: km.yes_ask_size_fp,
    noBidDepth: km.no_bid_size_fp,
    noAskDepth: km.no_ask_size_fp,
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

  const pmOutcomes: { title: string; yesPrice: number; noPrice: number; market: PMMarket }[] = [];
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
        yesPrice: prices[i] || 0,
        noPrice: prices.length > i + 1 ? prices[i + 1] : (1 - prices[i]),
        market: pm,
      });
    }
  }

  const matched: UnifiedOutcome[] = [];
  const usedKalshi = new Set<string>();
  const usedPm = new Set<number>();

  const noArbResult: UnifiedOutcome['arbitrage'] = { strategy: 'No arb', kalshiStake: 0, pmStake: 0, expectedProfit: 0, roiPct: 0, apyPct: 0, buyPlatform: null, buyPrice: 0, sellPlatform: null, sellPrice: 0, arbType: 'direct' };

  // Exact match pass
  const placeholderArb = noArbResult;
  for (let pi = 0; pi < pmOutcomes.length; pi++) {
    const pmo = pmOutcomes[pi];
    const pmNorm = normalizeName(pmo.title);
    const exact = kalshiMap.get(pmNorm);
    if (exact) {
      const kalshi = buildKalshiArbShape(exact);
      const pmShape = buildPmArbShape(pmo.market);
      matched.push({
        artist: stripBetTypePrefix(getKalshiName(exact)),
        kalshi,
        polymarket: pmShape,
        arbitrage: placeholderArb,
        source: 'auto' as const,
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
      const pmShape = buildPmArbShape(pmo.market);
      const displayName = stripBetTypePrefix(getKalshiName(bestKm));
      matched.push({
        artist: displayName,
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
      const pmShape = buildPmArbShape(pmo.market);
      matched.push({
        artist: stripBetTypePrefix(pmo.title) || 'Unknown',
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
    const pmShape = pmMarket
      ? buildPmArbShape(pmMarket)
      : pmRaw;

    // Use placeholder - arbitrage will be calculated by caller with depth info
    const noArbResult: UnifiedOutcome['arbitrage'] = { strategy: 'No arb', kalshiStake: 0, pmStake: 0, expectedProfit: 0, roiPct: 0, apyPct: 0, buyPlatform: null, buyPrice: 0, sellPlatform: null, sellPrice: 0, arbType: 'direct' };

    merged[kIdx] = {
      // UI: Show only the Polymarket name in the Outcome column after coupling.
      // Previously this concatenated both platform names ("KalshiName + PMName")
      // which cluttered the display. The PM name alone is sufficient.
      artist: outcomes[pIdx].artist,
      kalshi,
      polymarket: pmShape,
      arbitrage: noArbResult,
      source: 'manual' as const,
      negRisk: pmShape.negRisk,
    };
    indicesToRemove.add(pIdx);
  }

  // Remove PM-only entries that got merged
  return merged.filter((_, i) => !indicesToRemove.has(i)).map(normalizeOutcomePlatforms);
}
