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
    buyPlatform: 'kalshi' | 'polymarket' | null;
    buyPrice: number;
    sellPlatform: 'kalshi' | 'polymarket' | null;
    sellPrice: number;
  };
}

function extractNameFromKalshiTitle(title: string): string {
  // "Will Will Christian Edwards win the Bukauskas vs Edwards professional MMA..."
  // Extract "Will {Name}" → "Name"
  
  // First: "Will {Name} win the {Opponent1} vs {Opponent2} ..."
  const willWinMatch = title.match(/^Will\s+(.+?)\s+(?:win|lose|be|finish|end|survive|get|score)/i);
  if (willWinMatch) {
    return willWinMatch[1].trim();
  }

  // Fallback: "Will [Subject] say \"[Word/Phrase]\" before [Date]"
  const sayQuoteMatch = title.match(/say\s+["']([^"']+)["']/i);
  if (sayQuoteMatch) {
    return sayQuoteMatch[1].trim();
  }

  // Fallback: "Will [Subject] say [Word/Phrase] before"
  const sayMatch = title.match(/say\s+(.+?)\s+(?:before|by|at|on|in\s+the)/i);
  if (sayMatch) {
    const candidate = sayMatch[1].trim();
    // Exclude very short or generic candidates
    if (candidate.length >= 2) return candidate;
  }

  // Fallback: just take whatever comes after "Will "
  const simpleMatch = title.match(/^Will\s+(.{2,40}?)\s+(?:win|at|by|score|finish|get|lose|be|end|survive)/i);
  if (simpleMatch) {
    return simpleMatch[1].trim();
  }

  return title.slice(0, 30);
}

function getKalshiName(km: KalshiMarket): string {
  // Try custom_strike first (for named strikes like Artist, Word)
  const cs = km.custom_strike;
  if (cs) {
    const values = Object.values(cs);
    if (values.length > 0) {
      const val = String(values[0]);
      // If it's a UUID or looks like an ID, skip and use title
      const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      if (!uuidRegex.test(val)) {
        return val;
      }
    }
  }
  // Use title
  return extractNameFromKalshiTitle(km.title || km.ticker);
}

function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function similarity(a: string, b: string): number {
  const arrA = a.split(' ').filter(s => s.length >= 2);
  const arrB = b.split(' ').filter(s => s.length >= 2);
  const setA = new Set(arrA);
  const setB = new Set(arrB);
  const all = new Set([...arrA, ...arrB]);
  if (all.size === 0) return 0;
  let shared = 0;
  for (const w of all) {
    if (setA.has(w) && setB.has(w)) shared++;
  }
  return shared / all.size;
}

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

export function matchOutcomes(
  kalshiMarkets: KalshiMarket[],
  pmMarkets: PMMarket[],
  pmEventTitle?: string,
  capital = 1000,
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
    
    // Named binary outcome markets (e.g. Drake: groupItemTitle="21 Savage", outcomes=["Yes","No"])
    // Each market represents ONE candidate/asset. Keep all of these.
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
    
    // Skip generic binary Yes/No sub-markets (Completed Match, Over/Under, etc.)
    if (isBinaryMarket(outcomes)) continue;
    
    // For named outcome markets, create one entry per outcome
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

  // Exact match pass
  for (let pi = 0; pi < pmOutcomes.length; pi++) {
    const pmo = pmOutcomes[pi];
    const pmNorm = normalizeName(pmo.title);
    const exact = kalshiMap.get(pmNorm);
    if (exact) {
      const kalshi = {
        ticker: exact.ticker,
        yesBid: parseFloat(exact.yes_bid_dollars || '0'),
        yesAsk: parseFloat(exact.yes_ask_dollars || '1'),
        noBid: parseFloat(exact.no_bid_dollars || '0'),
        noAsk: parseFloat(exact.no_ask_dollars || '1'),
        lastPrice: parseFloat(exact.last_price_dollars || '0'),
        volume24h: exact.volume_24h_fp,
        yesBidDepth: exact.yes_bid_size_fp,
        yesAskDepth: exact.yes_ask_size_fp,
        noBidDepth: exact.no_bid_size_fp,
        noAskDepth: exact.no_ask_size_fp,
      };
      matched.push({
        artist: getKalshiName(exact),
        kalshi,
        polymarket: {
          marketId: pmo.market.id,
          conditionId: pmo.market.conditionId,
          yesPrice: pmo.yesPrice,
          noPrice: pmo.noPrice,
          bestBid: pmo.market.bestBid ?? pmo.yesPrice,
          bestAsk: pmo.market.bestAsk ?? pmo.yesPrice,
          lastTradePrice: pmo.market.lastTradePrice ?? pmo.yesPrice,
          volume: pmo.market.volume,
          liquidity: pmo.market.liquidity,
          askDepth: Number(pmo.market.liquidityNum ?? pmo.market.liquidity ?? 0),
        },
        arbitrage: calculateArbitrage(kalshi, { yesPrice: pmo.yesPrice, noPrice: pmo.noPrice, bestBid: pmo.market.bestBid ?? pmo.yesPrice, bestAsk: pmo.market.bestAsk ?? pmo.yesPrice, lastTradePrice: pmo.market.lastTradePrice ?? pmo.yesPrice, askDepth: Number(pmo.market.liquidityNum ?? pmo.market.liquidity ?? 0) } as any, capital),
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
      const kalshi = {
        ticker: bestKm.ticker,
        yesBid: parseFloat(bestKm.yes_bid_dollars || '0'),
        yesAsk: parseFloat(bestKm.yes_ask_dollars || '1'),
        noBid: parseFloat(bestKm.no_bid_dollars || '0'),
        noAsk: parseFloat(bestKm.no_ask_dollars || '1'),
        lastPrice: parseFloat(bestKm.last_price_dollars || '0'),
        volume24h: bestKm.volume_24h_fp,
        yesBidDepth: bestKm.yes_bid_size_fp,
        yesAskDepth: bestKm.yes_ask_size_fp,
        noBidDepth: bestKm.no_bid_size_fp,
        noAskDepth: bestKm.no_ask_size_fp,
      };
      matched.push({
        artist: getKalshiName(bestKm),
        kalshi,
        polymarket: {
          marketId: pmo.market.id,
          conditionId: pmo.market.conditionId,
          yesPrice: pmo.yesPrice,
          noPrice: pmo.noPrice,
          bestBid: pmo.market.bestBid ?? pmo.yesPrice,
          bestAsk: pmo.market.bestAsk ?? pmo.yesPrice,
          lastTradePrice: pmo.market.lastTradePrice ?? pmo.yesPrice,
          volume: pmo.market.volume,
          liquidity: pmo.market.liquidity,
          askDepth: Number(pmo.market.liquidityNum ?? pmo.market.liquidity ?? 0),
        },
        arbitrage: calculateArbitrage(kalshi, { yesPrice: pmo.yesPrice, noPrice: pmo.noPrice, bestBid: pmo.market.bestBid ?? pmo.yesPrice, bestAsk: pmo.market.bestAsk ?? pmo.yesPrice, lastTradePrice: pmo.market.lastTradePrice ?? pmo.yesPrice, askDepth: Number(pmo.market.liquidityNum ?? pmo.market.liquidity ?? 0) } as any, capital),
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
        kalshi: {
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
        },
        polymarket: null,
        arbitrage: { strategy: 'No arb', kalshiStake: 0, pmStake: 0, expectedProfit: 0, roiPct: 0, buyPlatform: null, buyPrice: 0, sellPlatform: null, sellPrice: 0 },
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
        polymarket: {
          marketId: pmo.market.id,
          conditionId: pmo.market.conditionId,
          yesPrice: pmo.yesPrice,
          noPrice: pmo.noPrice,
          bestBid: pmo.market.bestBid ?? pmo.yesPrice,
          bestAsk: pmo.market.bestAsk ?? pmo.yesPrice,
          lastTradePrice: pmo.market.lastTradePrice ?? pmo.yesPrice,
          volume: pmo.market.volume,
          liquidity: pmo.market.liquidity,
          askDepth: Number(pmo.market.liquidityNum ?? pmo.market.liquidity ?? 0),
        },
        arbitrage: { strategy: 'No arb', kalshiStake: 0, pmStake: 0, expectedProfit: 0, roiPct: 0, buyPlatform: null, buyPrice: 0, sellPlatform: null, sellPrice: 0 },
      });
    }
  }

  return matched;
}
