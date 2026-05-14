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
  } | null;
}

function normalizeArtistName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function matchOutcomes(
  kalshiMarkets: KalshiMarket[],
  pmMarkets: PMMarket[]
): UnifiedOutcome[] {
  const kalshiMap = new Map<string, KalshiMarket>();
  const pmMap = new Map<string, PMMarket>();

  for (const km of kalshiMarkets) {
    const artist = km.custom_strike?.Artist;
    if (artist) {
      kalshiMap.set(normalizeArtistName(artist), km);
    }
  }

  for (const pm of pmMarkets) {
    const artist = pm.groupItemTitle;
    if (artist) {
      pmMap.set(normalizeArtistName(artist), pm);
    }
  }

  const allArtists = new Set([
    ...Array.from(kalshiMap.keys()),
    ...Array.from(pmMap.keys()),
  ]);

  const outcomes: UnifiedOutcome[] = [];

  for (const artist of Array.from(allArtists)) {
    const km = kalshiMap.get(artist) || null;
    const pm = pmMap.get(artist) || null;

    const pmParsed = pm ? parseOutcomes(pm) : null;

    outcomes.push({
      artist: km?.custom_strike?.Artist || pm?.groupItemTitle || artist,
      kalshi: km ? {
        ticker: km.ticker,
        yesBid: parseFloat(km.yes_bid_dollars || '0'),
        yesAsk: parseFloat(km.yes_ask_dollars || '0'),
        noBid: parseFloat(km.no_bid_dollars || '0'),
        noAsk: parseFloat(km.no_ask_dollars || '0'),
        lastPrice: parseFloat(km.last_price_dollars || '0'),
        volume24h: km.volume_24h_fp,
      } : null,
      polymarket: pm && pmParsed ? {
        marketId: pm.id,
        conditionId: pm.conditionId,
        yesPrice: pmParsed.prices[0] || 0,
        noPrice: pmParsed.prices[1] || 0,
        bestBid: pm.bestBid || 0,
        bestAsk: pm.bestAsk || 0,
        lastTradePrice: pm.lastTradePrice || 0,
        volume: pm.volume,
        liquidity: pm.liquidity,
      } : null,
    });
  }

  // Sort: matched first (both platforms), then by artist name
  return outcomes.sort((a, b) => {
    const aMatched = a.kalshi && a.polymarket ? 1 : 0;
    const bMatched = b.kalshi && b.polymarket ? 1 : 0;
    if (aMatched !== bMatched) return bMatched - aMatched;
    return a.artist.localeCompare(b.artist);
  });
}

// Arbitrage calculations
export interface ArbitrageCalc {
  strategy: 'NO_OP' | string;
  kalshiStake: number;
  pmStake: number;
  expectedProfit: number;
  roiPct: number;
  // Detailed breakdown
  buyPlatform: 'kalshi' | 'polymarket' | null;
  buyPrice: number;
  sellPlatform: 'kalshi' | 'polymarket' | null;
  sellPrice: number;
}

export function calculateArbitrage(
  outcome: UnifiedOutcome,
  totalCapital: number = 1000
): ArbitrageCalc {
  if (!outcome.kalshi || !outcome.polymarket) {
    return {
      strategy: 'NO_OP',
      kalshiStake: 0,
      pmStake: 0,
      expectedProfit: 0,
      roiPct: 0,
      buyPlatform: null,
      buyPrice: 0,
      sellPlatform: null,
      sellPrice: 0,
    };
  }

  const k = outcome.kalshi;
  const p = outcome.polymarket;

  // Best YES price to BUY (lower is better to buy)
  const yesBuyOptions = [
    { platform: 'kalshi' as const, price: k.yesAsk },
    { platform: 'polymarket' as const, price: p.bestAsk || p.yesPrice },
  ].sort((a, b) => a.price - b.price);

  // Best NO price to BUY
  const noBuyOptions = [
    { platform: 'kalshi' as const, price: k.noAsk },
    { platform: 'polymarket' as const, price: p.noPrice }, // PM has no separate "NO" orderbook, use outcomePrices[1]
  ].sort((a, b) => a.price - b.price);

  // Strategy: Buy YES on cheaper platform + Buy NO on cheaper platform
  const yesBuy = yesBuyOptions[0];
  const noBuy = noBuyOptions[0];

  const totalCost = yesBuy.price + noBuy.price;
  const profit = 1 - totalCost; // If we hold both, one pays $1
  const roi = (profit / totalCost) * 100;

  // Kelly-style sizing: stake proportionally by odds
  const yesWeight = yesBuy.price / totalCost;
  const noWeight = noBuy.price / totalCost;

  const kalshiStake =
    (yesBuy.platform === 'kalshi' ? yesWeight : 0) +
    (noBuy.platform === 'kalshi' ? noWeight : 0);

  const pmStake =
    (yesBuy.platform === 'polymarket' ? yesWeight : 0) +
    (noBuy.platform === 'polymarket' ? noWeight : 0);

  return {
    strategy: `BUY YES @ ${yesBuy.platform.toUpperCase()} + BUY NO @ ${noBuy.platform.toUpperCase()}`,
    kalshiStake: Math.round(kalshiStake * totalCapital * 100) / 100,
    pmStake: Math.round(pmStake * totalCapital * 100) / 100,
    expectedProfit: Math.round(profit * totalCapital * 100) / 100,
    roiPct: Math.round(roi * 100) / 100,
    buyPlatform: yesBuy.platform,
    buyPrice: yesBuy.price,
    sellPlatform: noBuy.platform,
    sellPrice: noBuy.price,
  };
}
