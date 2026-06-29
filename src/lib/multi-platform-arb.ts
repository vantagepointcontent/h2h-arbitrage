/**
 * Multi-Platform Arbitrage — Platform Abstraction Layer
 *
 * Extends EdgeFinder beyond 2-platform (Kalshi + Polymarket) to support
 * 3+ leg arbitrage across multiple platforms.
 *
 * PlatformAdapter interface that each platform implements.
 * All downstream code works with normalized data only.
 */

// ─── Types ────────────────────────────────────────────────────────

export interface NormalizedMarket {
  id: string;
  platform: string;
  title: string;
  question?: string;
  outcomes: NormalizedOutcome[];
  endDate?: string;
  active: boolean;
  closed: boolean;
  category?: string;
  slug?: string;
  eventSlug?: string;
}

export interface NormalizedOutcome {
  name: string;
  yesPrice: number;
  noPrice: number;
  yesDepth: number;
  noDepth: number;
  bestBid: number;
  bestAsk: number;
}

export interface NormalizedOrderbook {
  marketId: string;
  platform: string;
  bids: OrderbookLevel[];
  asks: OrderbookLevel[];
}

export interface OrderbookLevel {
  price: number;
  size: number;
}

export interface PlatformAdapter {
  name: string;
  fetchMarkets(query?: string): Promise<NormalizedMarket[]>;
  fetchOrderbook(marketId: string): Promise<NormalizedOrderbook | null>;
  fetchPrice(marketId: string): Promise<{ yesPrice: number; noPrice: number } | null>;
  normalizeMarket(raw: any): NormalizedMarket;
  normalizeOrderbook(raw: any): NormalizedOrderbook;
}

// ─── Multi-Leg Arb Detection ─────────────────────────────────────

export interface ArbLeg {
  platform: string;
  marketId: string;
  outcome: string;
  side: 'yes' | 'no';
  price: number;
  depth: number;
  stake: number;
}

export interface MultiLegArb {
  legs: ArbLeg[];
  totalStake: number;
  totalCost: number;
  expectedProfit: number;
  roiPct: number;
  strategy: string;
  platforms: string[];
}

/**
 * Detect N-way arbitrage: find combinations where buying YES on one platform
 * and NO on all others costs less than $1 total (after fees).
 *
 * 2-leg: K YES + PM NO (current behavior, preserved)
 * 3-leg: K YES + PM NO + IB NO (new)
 * 4-leg: K YES + PM NO + IB NO + OP NO (new)
 */
export function detectMultiLegArb(
  markets: NormalizedMarket[],
  maxLegs: number = 4,
  fees: Record<string, number> = {},  // platform -> fee fraction (e.g. { kalshi: 0.02, polymarket: 0.02 })
): MultiLegArb[] {
  const arbs: MultiLegArb[] = [];

  // Group markets by outcome name (normalized)
  const outcomeMap = new Map<string, { platform: string; marketId: string; yesPrice: number; yesDepth: number; noPrice: number; noDepth: number }[]>();

  for (const market of markets) {
    for (const outcome of market.outcomes) {
      const normName = outcome.name.toLowerCase().replace(/[^a-z0-9]/g, '');
      if (!outcomeMap.has(normName)) outcomeMap.set(normName, []);
      outcomeMap.get(normName)!.push({
        platform: market.platform,
        marketId: market.id,
        yesPrice: outcome.yesPrice,
        yesDepth: outcome.yesDepth,
        noPrice: outcome.noPrice,
        noDepth: outcome.noDepth,
      });
    }
  }

  // For each outcome, find the cheapest YES and cheapest NO(s) across platforms
  for (const [outcomeName, entries] of outcomeMap) {
    if (entries.length < 2) continue;

    // Sort by YES price ascending (cheapest YES = best buy)
    const sortedYes = [...entries].sort((a, b) => a.yesPrice - b.yesPrice);
    // Sort by NO price ascending (cheapest NO = best buy)
    const sortedNo = [...entries].sort((a, b) => a.noPrice - b.noPrice);

    const cheapestYes = sortedYes[0];

    // Try 2-leg, 3-leg, ... up to maxLegs
    for (let numLegs = 2; numLegs <= Math.min(maxLegs, entries.length + 1); numLegs++) {
      // Buy YES from cheapestYes, buy NO from (numLegs-1) other platforms
      const noLegs = sortedNo
        .filter(e => e.platform !== cheapestYes.platform)
        .slice(0, numLegs - 1);

      if (noLegs.length < numLegs - 1) continue;

      // Total cost = YES price + sum of NO prices + fees
      const totalRawCost = cheapestYes.yesPrice + noLegs.reduce((s, l) => s + l.noPrice, 0);
      const totalFee = Object.values(fees).reduce((s, f) => s + (f as number), 0) / Math.max(1, entries.length);
      const totalCost = totalRawCost * (1 + totalFee);

      if (totalCost < 1) {
        // Arb found! Calculate stake sizing
        const profit = 1 - totalCost;
        const roiPct = (profit / totalCost) * 100;

        // Max stake = min of all depths
        const allDepths = [cheapestYes.yesDepth, ...noLegs.map(l => l.noDepth)];
        const maxStake = Math.min(...allDepths);

        const legs: ArbLeg[] = [
          {
            platform: cheapestYes.platform,
            marketId: cheapestYes.marketId,
            outcome: outcomeName,
            side: 'yes',
            price: cheapestYes.yesPrice,
            depth: cheapestYes.yesDepth,
            stake: maxStake,
          },
          ...noLegs.map(l => ({
            platform: l.platform,
            marketId: l.marketId,
            outcome: outcomeName,
            side: 'no' as const,
            price: l.noPrice,
            depth: l.noDepth,
            stake: maxStake,
          })),
        ];

        arbs.push({
          legs,
          totalStake: maxStake,
          totalCost: totalCost * maxStake,
          expectedProfit: profit * maxStake,
          roiPct,
          strategy: `Buy YES ${cheapestYes.platform} + NO ${noLegs.map(l => l.platform).join(' + ')}`,
          platforms: [cheapestYes.platform, ...noLegs.map(l => l.platform)],
        });
      }
    }
  }

  // Sort by ROI descending
  return arbs.sort((a, b) => b.roiPct - a.roiPct);
}

// ─── Platform Selector ───────────────────────────────────────────

export interface PlatformSelection {
  kalshi: boolean;
  polymarket: boolean;
  ibkr: boolean;
  opinion: boolean;
  predict: boolean;
}

export function getDefaultPlatformSelection(): PlatformSelection {
  return {
    kalshi: true,
    polymarket: true,
    ibkr: false,
    opinion: false,
    predict: false,
  };
}

// ─── Color Helpers ───────────────────────────────────────────────

const PLATFORM_COLORS: Record<string, string> = {
  kalshi: '#5DBE81',
  polymarket: '#3b82f6',
  ibkr: '#facc15',
  opinion: '#a855f7',
  predict: '#f97316',
};

export function getPlatformColor(platform: string): string {
  return PLATFORM_COLORS[platform] || '#8A9BA8';
}