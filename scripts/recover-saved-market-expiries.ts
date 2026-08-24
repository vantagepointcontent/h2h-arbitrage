import { getSavedMarkets, recoverSavedMarketExpiry } from '../src/lib/persistence';
import {
  extractKalshiEventTicker,
  extractKalshiMatchKey,
  fetchKalshiEventMarkets,
  filterKalshiMarketsToMatch,
} from '../src/lib/kalshi';
import {
  extractPolymarketSlug,
  fetchPolymarketEvent,
  fetchPolymarketMarketAsEvent,
  isPolymarketMarketUrl,
} from '../src/lib/polymarket';
import { resolveCanonicalMarketExpiry } from '../src/lib/canonical-market-expiry';
import { withTimeout } from '../src/lib/scan-shared';

const apply = process.argv.includes('--apply');
const observedAt = new Date().toISOString();
const markets = (await getSavedMarkets()).filter((market) => !market.archived && !market.expiryDate);
const rows: Array<Record<string, unknown>> = [];

// This is a bounded one-time reconciliation, never a request/render path. Work
// in small parallel batches to avoid venue bursts while avoiding serial N+1 latency.
for (let index = 0; index < markets.length; index += 3) {
  const batch = markets.slice(index, index + 3);
  const resolved = await Promise.all(batch.map(async (market) => {
    const kalshiTicker = extractKalshiEventTicker(market.kalshiUrl);
    const pmSlug = extractPolymarketSlug(market.polymarketUrl);
    if (!kalshiTicker || !pmSlug) {
      return { id: market.id, eventTitle: market.eventTitle, status: 'unrecoverable_links' };
    }
    try {
      const [allKalshiMarkets, pmEvent] = await Promise.all([
        withTimeout(fetchKalshiEventMarkets(kalshiTicker), 10_000, `Kalshi ${kalshiTicker}`),
        withTimeout(isPolymarketMarketUrl(market.polymarketUrl)
          ? fetchPolymarketMarketAsEvent(pmSlug)
          : fetchPolymarketEvent(pmSlug), 10_000, `Polymarket ${pmSlug}`),
      ]);
      if (!pmEvent) return { id: market.id, eventTitle: market.eventTitle, status: 'polymarket_not_found' };
      const kalshiMarkets = filterKalshiMarketsToMatch(
        allKalshiMarkets,
        extractKalshiMatchKey(market.kalshiUrl),
      );
      const resolution = resolveCanonicalMarketExpiry({
        polymarketEndDate: pmEvent.endDate,
        polymarketEventSlug: pmSlug,
        polymarketClosed: pmEvent.closed,
        polymarketMarkets: pmEvent.markets,
        kalshiMarkets,
      });
      if (!resolution) return { id: market.id, eventTitle: market.eventTitle, status: 'no_coherent_expiry' };
      const changed = apply
        ? await recoverSavedMarketExpiry(market.id, { ...resolution, observedAt })
        : false;
      return {
        id: market.id,
        eventTitle: market.eventTitle,
        status: apply ? (changed ? 'recovered' : 'not_changed') : 'would_recover',
        ...resolution,
      };
    } catch (error) {
      return {
        id: market.id,
        eventTitle: market.eventTitle,
        status: 'upstream_error',
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }));
  rows.push(...resolved);
}

console.log(JSON.stringify({
  mode: apply ? 'apply' : 'dry-run',
  observedAt,
  missingBefore: markets.length,
  recoverable: rows.filter((row) => row.status === 'would_recover' || row.status === 'recovered').length,
  recovered: rows.filter((row) => row.status === 'recovered').length,
  rows,
}, null, 2));
process.exit(0);
