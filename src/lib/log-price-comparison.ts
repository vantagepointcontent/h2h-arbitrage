export type QuotePlatform = 'kalshi' | 'polymarket';
export type QuoteOutcome = 'yes' | 'no';

export interface CapturedArbitrageQuote {
  strategy?: string;
  kalshiTicker?: string;
  pmConditionId?: string;
  kalshiYesAsk?: number;
  kalshiNoAsk?: number;
  pmYesPrice?: number;
  pmNoPrice?: number;
  pmBestAsk?: number;
}

export interface HistoricalPriceLeg {
  platform: QuotePlatform;
  marketId: string | null;
  outcome: QuoteOutcome;
  priceThen: number | null;
}

function capturedPrice(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= 1
    ? value
    : null;
}

/** Build the two executable legs from immutable identifiers and prices captured by the scan. */
export function buildHistoricalLegs(arb: CapturedArbitrageQuote): HistoricalPriceLeg[] {
  const strategy = (arb.strategy ?? '').toLowerCase();
  const kalshiOutcome: QuoteOutcome = strategy.includes('yes pm') ? 'no' : 'yes';
  const pmOutcome: QuoteOutcome = strategy.includes('yes kalshi') ? 'no' : 'yes';

  return [
    {
      platform: 'kalshi',
      marketId: arb.kalshiTicker ?? null,
      outcome: kalshiOutcome,
      priceThen: capturedPrice(kalshiOutcome === 'yes' ? arb.kalshiYesAsk : arb.kalshiNoAsk),
    },
    {
      platform: 'polymarket',
      marketId: arb.pmConditionId ?? null,
      outcome: pmOutcome,
      priceThen: capturedPrice(pmOutcome === 'yes' ? (arb.pmBestAsk ?? arb.pmYesPrice) : arb.pmNoPrice),
    },
  ];
}

export type PriceDirection = 'up' | 'down' | 'unchanged';

export function calculatePriceChange(priceThen: number | null, priceNow: number | null): {
  absolute: number;
  percentage: number;
  direction: PriceDirection;
} | null {
  if (priceThen == null || priceNow == null || priceThen <= 0) return null;
  const absolute = Math.round((priceNow - priceThen) * 1e8) / 1e8;
  const percentage = Math.round((absolute / priceThen) * 100 * 1e8) / 1e8;
  return {
    absolute,
    percentage,
    direction: absolute > 0 ? 'up' : absolute < 0 ? 'down' : 'unchanged',
  };
}
