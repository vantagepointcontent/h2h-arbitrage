import { finiteDecimal } from './market-price';

export interface RawDepthLevel {
  price: string | number;
  size: string | number;
}

export interface DepthLevel {
  price: number;
  size: number;
}

export interface CumulativeDepthLevel extends DepthLevel {
  cumulativeSize: number;
}

export interface DepthBook {
  bids: DepthLevel[];
  asks: DepthLevel[];
}

function parseLevel(level: RawDepthLevel): DepthLevel | null {
  const price = finiteDecimal(level.price);
  const size = finiteDecimal(level.size);
  if (price === null || size === null || price <= 0 || price >= 1 || size <= 0) return null;
  return { price, size };
}

function normalize(levels: RawDepthLevel[], side: 'bids' | 'asks'): DepthLevel[] {
  const sorted = levels
    .map(parseLevel)
    .filter((level): level is DepthLevel => level !== null)
    .sort((a, b) => side === 'bids' ? b.price - a.price : a.price - b.price);

  return sorted;
}

export function buildDepthBook(bids: RawDepthLevel[] = [], asks: RawDepthLevel[] = []): DepthBook {
  return { bids: normalize(bids, 'bids'), asks: normalize(asks, 'asks') };
}

/** Kalshi publishes YES and NO bid ladders. NO bids are executable YES asks at 1 - price. */
export function buildKalshiYesBook(yesBids: RawDepthLevel[] = [], noBids: RawDepthLevel[] = []): DepthBook {
  const yesAsks = noBids.flatMap(level => {
    const noBidPrice = finiteDecimal(level.price);
    return noBidPrice !== null ? [{ price: 1 - noBidPrice, size: level.size }] : [];
  });
  return buildDepthBook(yesBids, yesAsks);
}

export function cumulativeLevels(levels: DepthLevel[], limit = 12): CumulativeDepthLevel[] {
  let cumulativeSize = 0;
  return levels.slice(0, limit).map(level => {
    cumulativeSize += level.size;
    return { ...level, cumulativeSize };
  });
}
