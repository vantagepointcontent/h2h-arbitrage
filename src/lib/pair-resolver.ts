// Pair resolution pipeline — shared by /api/ws/live-scan and the WS watcher daemon (WS-102).
// Resolves a (kalshiUrl, pmUrl) saved-market pair into matched outcomes with
// Kalshi tickers and Polymarket CLOB token IDs, ready for orderbook streaming.

import { LiveMatchedOutcome } from './live-arb-engine';
import { extractKalshiEventTicker, extractKalshiMatchKey, filterKalshiMarketsToMatch, fetchKalshiEventMarkets, fetchKalshiMultiSeriesMarkets, extractKalshiSeriesFromUrl, KalshiMarket } from './kalshi';
import { extractPolymarketSlug, fetchPolymarketEvent, fetchPolymarketMarketAsEvent, isPolymarketMarketUrl, PMMarket } from './polymarket';
import { matchOutcomes, applyManualMatches, UnifiedOutcome } from './matcher';
import { getManualMatches } from './manual-matches';
import { getDecoupledPairs, applyDecoupledPairs } from './decoupled-pairs';
import type { MarketLink } from './platforms/types';
import logger from './logger';
import { fetchClobBook } from './polymarket-clob';
import { finiteDecimal } from './market-price';
import { resolveKalshiFeeAuthority } from './kalshi-fee-quote';

interface PmToken {
  outcome: string;
  token_id: string;
}

export interface ResolvedPair {
  matchedOutcomes: LiveMatchedOutcome[];
  kalshiTickers: string[];
  pmTokenIds: string[];
  /** Which outcome side (yes/no) each PM token_id represents */
  pmTokenSides: Map<string, 'yes' | 'no'>;
  category?: string;
}

export type PairResolutionError =
  | 'bad_kalshi_url'
  | 'bad_pm_url'
  | 'kalshi_fetch_failed'
  | 'pm_not_found'
  | 'pm_fetch_failed'
  | 'no_matches'
  | 'no_tokens';

export class PairResolveError extends Error {
  constructor(public code: PairResolutionError, message: string) {
    super(message);
    this.name = 'PairResolveError';
  }
}

/**
 * Canonical platform-link entry point. The live scanner currently has working
 * adapters only for Kalshi and Polymarket, so extra links are intentionally
 * preserved for future adapters but not silently treated as executable.
 */
export async function resolvePairFromLinks(links: MarketLink[], capital: number): Promise<ResolvedPair> {
  const kalshiUrl = links.find(link => link.platform === 'kalshi')?.url;
  const polymarketUrl = links.find(link => link.platform === 'polymarket')?.url;
  if (!kalshiUrl) throw new PairResolveError('bad_kalshi_url', 'A Kalshi platform link is required for live resolution');
  if (!polymarketUrl) throw new PairResolveError('bad_pm_url', 'A Polymarket platform link is required for live resolution');
  return resolvePair(kalshiUrl, polymarketUrl, capital);
}

/**
 * Resolve a Kalshi/Polymarket URL pair into streamable matched outcomes.
 * Mirrors the manual-scan matching path exactly (event fetch with series
 * fallbacks, manual matches, decoupled pairs, CLOB token lookup).
 * Throws PairResolveError with a machine-readable code on failure.
 */
export async function resolvePair(kalshiUrl: string, pmUrl: string, capital: number): Promise<ResolvedPair> {
  const kalshiEventTicker = extractKalshiEventTicker(kalshiUrl);
  const pmSlug = extractPolymarketSlug(pmUrl);

  if (!kalshiEventTicker) throw new PairResolveError('bad_kalshi_url', 'Could not extract Kalshi event ticker from URL');
  if (!pmSlug) throw new PairResolveError('bad_pm_url', 'Could not extract Polymarket slug from URL');

  // ── Resolve ALL Kalshi markets for the event (with multi-series + fallbacks) ──
  // BUG-07: Fetch ALL market types per event (Moneyline, totals, spreads, etc.)
  const kalshiSeriesTicker = extractKalshiSeriesFromUrl(kalshiUrl);
  let kalshiMarkets: KalshiMarket[] = [];
  try {
    // Try multi-series first to get all market types
    if (kalshiSeriesTicker) {
      try {
        const multi = await fetchKalshiMultiSeriesMarkets(kalshiEventTicker, kalshiSeriesTicker);
        kalshiMarkets = multi.markets;
      } catch {
        // Fall through to single event fetch
      }
    }
    if (kalshiMarkets.length === 0) {
      kalshiMarkets = await fetchKalshiEventMarkets(kalshiEventTicker);
    }
    if (kalshiMarkets.length === 0) {
      // Fallback: try series prefix
      const seriesMatch = kalshiEventTicker.match(/^([A-Z]+)/);
      const seriesFallback = seriesMatch ? seriesMatch[1] : null;
      if (seriesFallback && seriesFallback !== kalshiEventTicker) {
        const { fetchKalshiSeriesMarkets } = await import('./kalshi');
        kalshiMarkets = await fetchKalshiSeriesMarkets(seriesFallback);
      }
      if (kalshiMarkets.length === 0 && kalshiEventTicker) {
        const { fetchKalshiSeriesMarkets } = await import('./kalshi');
        kalshiMarkets = await fetchKalshiSeriesMarkets(kalshiEventTicker);
      }
    }
  } catch (err) {
    logger.error('[pair-resolver] failed to fetch Kalshi event markets', { err, kalshiEventTicker });
    throw new PairResolveError('kalshi_fetch_failed', 'Failed to fetch Kalshi event markets');
  }

  // Filter Kalshi markets to the specific match within a multi-game event
  const matchKey = extractKalshiMatchKey(kalshiUrl);
  kalshiMarkets = filterKalshiMarketsToMatch(kalshiMarkets, matchKey);

  // ── Resolve ALL Polymarket markets for the event ──
  let pmEvent: Awaited<ReturnType<typeof fetchPolymarketEvent>> | null = null;
  let pmMarkets: PMMarket[] = [];
  let category: string | undefined;

  try {
    pmEvent = await (isPolymarketMarketUrl(pmUrl)
      ? fetchPolymarketMarketAsEvent(pmSlug)
      : fetchPolymarketEvent(pmSlug));
    if (!pmEvent) throw new PairResolveError('pm_not_found', 'Polymarket event not found');
    pmMarkets = pmEvent.markets || [];
    // Pick category from first market or event title
    category = pmMarkets[0]?.groupItemTitle || pmEvent?.title;
  } catch (err) {
    if (err instanceof PairResolveError) throw err;
    logger.error('[pair-resolver] failed to resolve Polymarket event', { err, pmUrl });
    throw new PairResolveError('pm_fetch_failed', 'Failed to resolve Polymarket event');
  }

  // ── Match outcomes (same logic as scan route) ──
  const [manualMatches, decoupledPairs] = await Promise.all([getManualMatches(), getDecoupledPairs()]);
  const baseOutcomes = matchOutcomes(kalshiMarkets, pmMarkets, pmEvent?.title, capital);
  const mergedOutcomes = applyManualMatches(baseOutcomes, manualMatches, kalshiMarkets, pmMarkets, capital, pmEvent?.endDate);
  const finalOutcomes = applyDecoupledPairs(mergedOutcomes as unknown as UnifiedOutcome[], decoupledPairs);

  // Filter to only fully matched outcomes (both Kalshi and PM present)
  const matched = finalOutcomes.filter((o) => o.kalshi && o.polymarket);
  if (matched.length === 0) {
    throw new PairResolveError('no_matches', 'No matching outcomes found between Kalshi and Polymarket');
  }
  const feeAuthorities = new Map(await Promise.all(
    [...new Set(matched.map((outcome) => outcome.kalshi!.ticker))].map(async (ticker) => [
      ticker,
      await resolveKalshiFeeAuthority(ticker),
    ] as const),
  ));

  // ── Resolve Polymarket token IDs for ALL matched markets ──
  const conditionIds = [...new Set(matched.map((o) => o.polymarket!.conditionId))];
  const tokenMap = new Map<string, { yes: string; no: string }>();
  const constraintMap = new Map<string, {
    yesMinOrderSize: number | null; noMinOrderSize: number | null;
    yesTickSize: number | null; noTickSize: number | null;
  }>();

  for (const cid of conditionIds) {
    try {
      const clobRes = await fetch(`https://clob.polymarket.com/markets/${cid}`, { cache: 'no-store' });
      if (!clobRes.ok) continue;
      const clobMarket = await clobRes.json() as { tokens?: PmToken[] };
      const tokens = clobMarket.tokens || [];
      const yes = tokens.find((t) => t.outcome.toLowerCase() === 'yes');
      const no = tokens.find((t) => t.outcome.toLowerCase() === 'no');
      if (yes && no) {
        tokenMap.set(cid, { yes: yes.token_id, no: no.token_id });
        const [yesBook, noBook] = await Promise.all([
          fetchClobBook(yes.token_id),
          fetchClobBook(no.token_id),
        ]);
        const positive = (value: unknown) => {
          const parsed = finiteDecimal(value);
          return parsed !== null && parsed > 0 ? parsed : null;
        };
        constraintMap.set(cid, {
          yesMinOrderSize: positive(yesBook?.min_order_size),
          noMinOrderSize: positive(noBook?.min_order_size),
          yesTickSize: positive(yesBook?.tick_size),
          noTickSize: positive(noBook?.tick_size),
        });
      }
    } catch (err) {
      logger.warn('[pair-resolver] failed to fetch CLOB tokens', { cid, err });
    }
  }

  // Build matched outcomes with resolved token IDs
  const liveMatched: LiveMatchedOutcome[] = [];
  const allKalshiTickers = new Set<string>();
  const allPmTokenIds = new Set<string>();
  const pmTokenSides = new Map<string, 'yes' | 'no'>();

  for (const o of matched) {
    const cid = o.polymarket!.conditionId;
    const tokens = tokenMap.get(cid);
    if (!tokens) continue;
    const constraints = constraintMap.get(cid);

    liveMatched.push({
      artist: o.artist,
      kalshiTicker: o.kalshi!.ticker,
      pmConditionId: cid,
      pmYesTokenId: tokens.yes,
      pmNoTokenId: tokens.no,
      pmBinaryVerified: o.polymarket!.binaryVerified === true,
      // Constraints are execution-authoritative and must come from this resolve.
      // Never retain prior values after a failed/partial book refresh.
      pmYesMinOrderSize: constraints?.yesMinOrderSize ?? null,
      pmNoMinOrderSize: constraints?.noMinOrderSize ?? null,
      pmYesTickSize: constraints?.yesTickSize ?? null,
      pmNoTickSize: constraints?.noTickSize ?? null,
      kalshiFeeAuthority: feeAuthorities.get(o.kalshi!.ticker)!,
      pmFeesEnabled: o.polymarket!.feesEnabled,
      pmFeeSchedule: o.polymarket!.feeSchedule,
    });
    allKalshiTickers.add(o.kalshi!.ticker);
    allPmTokenIds.add(tokens.yes);
    allPmTokenIds.add(tokens.no);
    pmTokenSides.set(tokens.yes, 'yes');
    pmTokenSides.set(tokens.no, 'no');
  }

  if (liveMatched.length === 0) {
    throw new PairResolveError('no_tokens', 'Could not resolve Polymarket token IDs for matched outcomes');
  }

  return {
    matchedOutcomes: liveMatched,
    kalshiTickers: [...allKalshiTickers],
    pmTokenIds: [...allPmTokenIds],
    pmTokenSides,
    category,
  };
}
