import { KalshiMarket } from './kalshi';
import { PMMarket, parseOutcomes } from './polymarket';

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
  } | null;
  arbitrage: {
    strategy: string;
    kalshiStake: number;
    pmStake: number;
    expectedProfit: number;
    roiPct: number;
    apyPct: number;
    buyPlatform: 'kalshi' | 'polymarket' | null;
    buyPrice: number;
    sellPlatform: 'kalshi' | 'polymarket' | null;
    sellPrice: number;
  };
  source: 'auto' | 'manual';
}

export interface ManualMatch {
  id: string;
  kalshiTicker: string;
  pmConditionId: string;
  kalshiTitle: string;
  pmTitle: string;
  kalshiUrl?: string;
  polymarketUrl?: string;
  createdAt: string;
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
  const m = ticker.match(/-([0-9]{2})([A-Z]{3})([0-9]{2})(?:-([TB].+))?$/);
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

function getKalshiName(km: KalshiMarket): string {
  // 1. Get a human-readable base name (custom_strike or extracted title)
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
    base = extractNameFromKalshiTitle(km.title || km.ticker);
  }

  // 2. ALWAYS append ticker-derived date/sub-code so identical bases stay distinct.
  // Fixes "SpaceX" from custom_strike (all 13 markets same) and
  // "the maximum temperature" from title (all 6 markets same).
  const parsed = parseKalshiTicker(km.ticker);
  if (!parsed) return base; // ticker has no date suffix

  if (parsed.sub) {
    // sub like T77  -> >77°F,  T70 -> <70°F,  B74.5 -> 74-75°F
    let detail = parsed.sub;
    if (detail.startsWith('T')) {
      const val = parseFloat(detail.slice(1));
      // Temperature threshold:  T70 -> <70°, T77 -> >77° (heuristic: lower T = threshold, higher T = threshold)
      detail = (val <= 50 ? '\u003c' : '\u003e') + detail.slice(1) + '°F';
    } else if (detail.startsWith('B')) {
      const val = parseFloat(detail.slice(1));
      detail = (val - 0.5) + '-' + (val + 0.5) + '°F';
    }
    return `${base} (${detail}, ${parsed.label})`;
  }
  // No sub-code — just month/year (e.g. SpaceX IPO markets)
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
) {
  const kYes = kalshi.yesAsk;
  const kNo = kalshi.noAsk;
  const pYes = pm.bestAsk;
  const pNo = pm.noPrice;

  let maxProfit = 0;
  let strategy = 'No arb';
  let bestCapital = 0;
  let kalshiStakeResult = 0;
  let pmStakeResult = 0;
  let buyPlatform: 'kalshi' | 'polymarket' | null = null;
  let buyPrice = 0;
  let sellPlatform: 'kalshi' | 'polymarket' | null = null;
  let sellPrice = 0;

  if (kYes + pNo < 1) {
    const capK = depthKYes > 0 ? depthKYes / kYes : Infinity;
    const capP = depthPNo > 0 ? depthPNo / pNo : Infinity;
    const capital = Math.min(capK, capP);
    if (isFinite(capital) && capital > 0) {
      const roi = 1 - (kYes + pNo);
      const profit = capital * roi;
      if (profit > maxProfit) {
        maxProfit = profit;
        strategy = 'Buy YES Kalshi + NO PM';
        bestCapital = capital;
        kalshiStakeResult = capital * kYes;
        pmStakeResult = capital * pNo;
        buyPlatform = 'kalshi';
        buyPrice = kYes;
        sellPlatform = 'polymarket';
        sellPrice = pNo;
      }
    }
  }

  if (pYes + kNo < 1) {
    const capP = depthPYes > 0 ? depthPYes / pYes : Infinity;
    const capK = depthKNo > 0 ? depthKNo / kNo : Infinity;
    const capital = Math.min(capP, capK);
    if (isFinite(capital) && capital > 0) {
      const roi = 1 - (pYes + kNo);
      const profit = capital * roi;
      if (profit > maxProfit) {
        maxProfit = profit;
        strategy = 'Buy YES PM + NO Kalshi';
        bestCapital = capital;
        kalshiStakeResult = capital * kNo;
        pmStakeResult = capital * pYes;
        buyPlatform = 'polymarket';
        buyPrice = pYes;
        sellPlatform = 'kalshi';
        sellPrice = kNo;
      }
    }
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
  };
}

/** Legacy entry-point kept for callers that still pass a fixed capital */
export function calculateArbitrage(kalshi: NonNullable<UnifiedOutcome['kalshi']>, pm: NonNullable<UnifiedOutcome['polymarket']>, capital = 1000) {
  const kYes = kalshi.yesAsk;
  const kNo = kalshi.noAsk;
  const pYes = pm.bestAsk;
  const pNo = pm.noPrice;

  let bestRoi = 0;
  let strategy = 'No arb';
  let kalshiStake = 0;
  let pmStake = 0;
  let profit = 0;
  let buyPlatform: 'kalshi' | 'polymarket' | null = null;
  let buyPrice = 0;
  let sellPlatform: 'kalshi' | 'polymarket' | null = null;
  let sellPrice = 0;

  if (kYes + pNo < 1) {
    const r = 1 - (kYes + pNo);
    if (r > bestRoi) {
      bestRoi = r;
      strategy = 'Buy YES Kalshi + NO PM';
      kalshiStake = capital * kYes;
      pmStake = capital * pNo;
      profit = capital * r;
      buyPlatform = 'kalshi';
      buyPrice = kYes;
      sellPlatform = 'polymarket';
      sellPrice = pNo;
    }
  }
  if (pYes + kNo < 1) {
    const r = 1 - (pYes + kNo);
    if (r > bestRoi) {
      bestRoi = r;
      strategy = 'Buy YES PM + NO Kalshi';
      kalshiStake = capital * kNo;
      pmStake = capital * pYes;
      profit = capital * r;
      buyPlatform = 'polymarket';
      buyPrice = pYes;
      sellPlatform = 'kalshi';
      sellPrice = kNo;
    }
  }

  return {
    strategy,
    kalshiStake,
    pmStake,
    expectedProfit: profit,
    roiPct: bestRoi * 100,
    buyPlatform,
    buyPrice,
    sellPlatform,
    sellPrice,
  };
}

/** Compute APY from ROI and days until expiry. Linear annualisation: 10% in 30 days = 10 * 365/30 = 121.7%. */
export function computeApy(roiPct: number, expiryDate: string | null | undefined): number {
  if (!expiryDate) return 0;
  const expiry = new Date(expiryDate).getTime();
  const now = Date.now();
  if (expiry <= now) return 0;
  const daysToExpiry = (expiry - now) / (1000 * 60 * 60 * 24);
  if (daysToExpiry <= 0) return 0;
  return roiPct * (365 / daysToExpiry);
}

function filterKalshiMarketsByEventTitle(kMarkets: KalshiMarket[], pmEventTitle: string): KalshiMarket[] {
  if (kMarkets.length <= 20) return kMarkets;
  const stopWords = new Set(['the', 'and', 'or', 'vs', 'at', 'in', 'on', 'by', 'to', 'of', 'for', 'a', 'an']);
  const pmWords = normalizeName(pmEventTitle).split(' ').filter(w => w.length >= 3 && !stopWords.has(w));
  if (pmWords.length === 0) return kMarkets.slice(0, 30);
  const matches: KalshiMarket[] = [];
  for (const km of kMarkets) {
    const title = normalizeName(km.title || '');
    const score = pmWords.filter(w => title.includes(w)).length;
    if (score >= 2) matches.push(km);
  }
  return matches.length > 0 ? matches : kMarkets.slice(0, 30);
}

function isBinaryMarket(outcomes: string[]): boolean {
  const lower = outcomes.map(o => o.toLowerCase());
  return (lower.length === 2 && lower.includes('yes') && lower.includes('no'));
}

// --- Helper to build the PM shape used by calculateArbitrage ---
function buildPmArbShape(market: PMMarket) {
  const { prices } = parseOutcomes(market);
  return {
    marketId: market.id,
    conditionId: market.conditionId,
    yesPrice: prices[0] || 0,
    noPrice: prices[1] !== undefined ? prices[1] : (1 - (prices[0] || 0)),
    bestBid: market.bestBid ?? prices[0] ?? 0,
    bestAsk: market.bestAsk ?? prices[0] ?? 0,
    lastTradePrice: market.lastTradePrice ?? prices[0] ?? 0,
    volume: market.volume,
    liquidity: market.liquidity,
    askDepth: Number(market.liquidityNum ?? market.liquidity ?? 0),
  } as NonNullable<UnifiedOutcome['polymarket']>;
}

function buildKalshiArbShape(km: KalshiMarket): NonNullable<UnifiedOutcome['kalshi']> {
  return {
    ticker: km.ticker,
    yesBid: parseFloat(km.yes_bid_dollars || '0'),
    yesAsk: parseFloat(km.yes_ask_dollars || '1'),
    noBid: parseFloat(km.no_bid_dollars || '0'),
    noAsk: parseFloat(km.no_ask_dollars || '1'),
    lastPrice: parseFloat(km.last_price_dollars || '0'),
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
  const kMarkets = pmEventTitle ? filterKalshiMarketsByEventTitle(kalshiMarkets, pmEventTitle) : kalshiMarkets;

  const kalshiMap = new Map<string, KalshiMarket>();
  for (const km of kMarkets) {
    const name = normalizeName(getKalshiName(km));
    kalshiMap.set(name, km);
  }

  const pmOutcomes: { title: string; yesPrice: number; noPrice: number; market: PMMarket }[] = [];
  for (const pm of pmMarkets) {
    const { outcomes, prices } = parseOutcomes(pm);
    const hasNamedGroup = pm.groupItemTitle && pm.groupItemTitle.trim() !== '' && pm.groupItemTitle !== 'N/A';
    const isNamedBinary = hasNamedGroup && outcomes.length === 2 && outcomes[0].toLowerCase() === 'yes' && outcomes[1].toLowerCase() === 'no';

    if (isNamedBinary) {
      pmOutcomes.push({
        title: pm.groupItemTitle!,
        yesPrice: prices[0] || 0,
        noPrice: prices[1] !== undefined ? prices[1] : (1 - (prices[0] || 0)),
        market: pm,
      });
      continue;
    }

    if (isBinaryMarket(outcomes)) continue;

    for (let i = 0; i < outcomes.length; i++) {
      pmOutcomes.push({
        title: outcomes[i] || pm.groupItemTitle || pm.question || '',
        yesPrice: prices[i] || 0,
        noPrice: prices.length > i + 1 ? prices[i + 1] : (1 - prices[i]),
        market: pm,
      });
    }
  }

  const matched: UnifiedOutcome[] = [];
  const usedKalshi = new Set<string>();
  const usedPm = new Set<number>();

  const noArbResult: UnifiedOutcome['arbitrage'] = { strategy: 'No arb', kalshiStake: 0, pmStake: 0, expectedProfit: 0, roiPct: 0, apyPct: 0, buyPlatform: null, buyPrice: 0, sellPlatform: null, sellPrice: 0 };

  // Exact match pass
  for (let pi = 0; pi < pmOutcomes.length; pi++) {
    const pmo = pmOutcomes[pi];
    const pmNorm = normalizeName(pmo.title);
    const exact = kalshiMap.get(pmNorm);
    if (exact) {
      const kalshi = buildKalshiArbShape(exact);
      const pmShape = buildPmArbShape(pmo.market);
      const arbRaw = calculateArbitrage(kalshi, pmShape, capital);
      const apyPct = computeApy(arbRaw.roiPct, expiryDate);
      matched.push({
        artist: getKalshiName(exact),
        kalshi,
        polymarket: pmShape,
        arbitrage: { ...arbRaw, apyPct },
        source: 'auto' as const,
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
      if (s > bestScore && s >= 0.4) {
        bestScore = s;
        bestKm = km;
      }
    }
    if (bestKm) {
      const kalshi = buildKalshiArbShape(bestKm);
      const pmShape = buildPmArbShape(pmo.market);
      const arbRaw = calculateArbitrage(kalshi, pmShape, capital);
      const apyPct = computeApy(arbRaw.roiPct, expiryDate);
      matched.push({
        artist: getKalshiName(bestKm),
        kalshi,
        polymarket: pmShape,
        arbitrage: { ...arbRaw, apyPct },
        source: 'auto' as const,
      });
      usedKalshi.add(bestKm.ticker);
      usedPm.add(pi);
    }
  }

  // Remaining Kalshi only
  for (const [, km] of unusedKalshi) {
    if (!usedKalshi.has(km.ticker)) {
      matched.push({
        artist: getKalshiName(km),
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
      matched.push({
        artist: pmo.title || 'Unknown',
        kalshi: null,
        polymarket: buildPmArbShape(pmo.market),
        arbitrage: noArbResult,
        source: 'auto' as const,
      });
    }
  }

  return matched;
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

    const arbRaw = calculateArbitrage(kalshi, pmShape, capital);
    const apyPct = computeApy(arbRaw.roiPct, expiryDate);

    merged[kIdx] = {
      artist: `${outcomes[kIdx].artist} + ${outcomes[pIdx].artist}`,
      kalshi,
      polymarket: pmShape,
      arbitrage: { ...arbRaw, apyPct },
      source: 'manual' as const,
    };
    indicesToRemove.add(pIdx);
  }

  // Remove PM-only entries that got merged
  return merged.filter((_, i) => !indicesToRemove.has(i));
}
