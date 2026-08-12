import type { MatchedPair, MarketCatalogRow, SavedMarket } from './persistence';

export interface MarketFinderMatch {
  id: string;
  matchId: number;
  title: string;
  kalshiTitle: string | null;
  polymarketTitle: string | null;
  kalshiUrl: string;
  polymarketUrl: string;
  confidence: number;
  category: string;
  expiryDate: string | null;
  eventType: string;
  eventDate: string | null;
  status: MatchedPair['status'];
  spreadPct: null;
}

type SavedUrls = Pick<SavedMarket, 'kalshiUrl' | 'polymarketUrl'>;
type CatalogIdentity = Pick<MarketCatalogRow, 'platform' | 'marketId' | 'category' | 'expiryDate'> & {
  eventId?: string | null;
};

export function normalizeMarketUrl(url: string | null | undefined): string {
  return (url || '').split('?')[0].replace(/\/$/, '').toLowerCase();
}

function earliestDate(...values: Array<string | null | undefined>): string | null {
  const valid = values
    .filter((value): value is string => Boolean(value) && Number.isFinite(Date.parse(value as string)))
    .sort((a, b) => Date.parse(a) - Date.parse(b));
  return valid[0] ?? null;
}

export function buildUnsavedMarketMatches(
  pairs: MatchedPair[],
  savedMarkets: SavedUrls[],
  catalogRows: CatalogIdentity[],
): MarketFinderMatch[] {
  const savedUrls = new Set(
    savedMarkets.flatMap((market) => [
      normalizeMarketUrl(market.kalshiUrl),
      normalizeMarketUrl(market.polymarketUrl),
    ]).filter(Boolean),
  );

  const catalogByIdentity = new Map<string, CatalogIdentity>();
  for (const row of catalogRows) {
    catalogByIdentity.set(`${row.platform}:${row.marketId}`.toLowerCase(), row);
    if (row.eventId) catalogByIdentity.set(`${row.platform}:${row.eventId}`.toLowerCase(), row);
  }

  return pairs
    .filter((pair) => {
      const kalshiUrl = normalizeMarketUrl(pair.kalshiUrl);
      const polymarketUrl = normalizeMarketUrl(pair.polymarketUrl);
      return Boolean(kalshiUrl && polymarketUrl)
        && !savedUrls.has(kalshiUrl)
        && !savedUrls.has(polymarketUrl);
    })
    .map((pair) => {
      const kalshiCatalog = catalogByIdentity.get(`kalshi:${pair.kalshiMarketId}`.toLowerCase());
      const polymarketCatalog = catalogByIdentity.get(`polymarket:${pair.polymarketMarketId}`.toLowerCase());
      const category = kalshiCatalog?.category || polymarketCatalog?.category || 'unknown';
      const expiryDate = earliestDate(kalshiCatalog?.expiryDate, polymarketCatalog?.expiryDate);
      return {
        id: `match-${pair.id}`,
        matchId: pair.id,
        title: pair.kalshiTitle || pair.polymarketTitle || 'Matched cross-platform market',
        kalshiTitle: pair.kalshiTitle,
        polymarketTitle: pair.polymarketTitle,
        kalshiUrl: pair.kalshiUrl!,
        polymarketUrl: pair.polymarketUrl!,
        confidence: pair.confidence,
        category,
        expiryDate,
        eventType: category,
        eventDate: expiryDate,
        status: pair.status,
        spreadPct: null,
      };
    })
    .sort((a, b) => b.confidence - a.confidence || a.title.localeCompare(b.title));
}
