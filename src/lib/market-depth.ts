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
  const price = Number(level.price);
  const size = Number(level.size);
  if (!Number.isFinite(price) || !Number.isFinite(size) || price <= 0 || price >= 1 || size <= 0) return null;
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

export function cumulativeLevels(levels: DepthLevel[], limit = 12): CumulativeDepthLevel[] {
  let cumulativeSize = 0;
  return levels.slice(0, limit).map(level => {
    cumulativeSize += level.size;
    return { ...level, cumulativeSize };
  });
}
