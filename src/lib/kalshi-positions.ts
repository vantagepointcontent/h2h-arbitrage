/**
 * Kalshi Positions — fetch live open positions from Kalshi portfolio API.
 *
 * GET /trade-api/v2/portfolio/positions on api.elections.kalshi.com
 * Returns market_positions with ticker, position_fp, realized_pnl, etc.
 *
 * Enriches each position with current market prices (yes_bid/yes_ask) so
 * the UI can show unrealized P&L and current value.
 */

import { makeKalshiAuthHeaders } from './kalshi-auth';
import { fetchKalshiEventMarkets, type KalshiMarket } from './kalshi';
import logger from './logger';

const KALSHI_TRADE_BASE = 'https://api.elections.kalshi.com';

export interface KalshiPosition {
  ticker: string;
  /** Position size in contracts (positive = long, negative = short) */
  position: number;
  /** Total cost basis in USD */
  totalCost: number;
  /** Realized P&L in USD */
  realizedPnl: number;
  /** Current YES bid price (0-1) */
  currentYesBid: number;
  /** Current YES ask price (0-1) */
  currentYesAsk: number;
  /** Current NO bid price (0-1) */
  currentNoBid: number;
  /** Current NO ask price (0-1) */
  currentNoAsk: number;
  /** Last traded price (0-1) */
  lastPrice: number;
  /** Market title */
  title: string;
  /** Event ticker */
  eventTicker: string;
  /** Unrealized P&L in USD (estimated) */
  unrealizedPnl: number;
  /** Current market value in USD */
  currentValue: number;
  /** ROI percentage */
  roiPct: number;
}

interface KalshiPositionRaw {
  ticker: string;
  position_fp: string;
  total_traded_dollars: string;
  market_exposure_dollars: string;
  realized_pnl_dollars: string;
  fees_paid_dollars: string;
  last_updated_ts: string;
}

/** Available Kalshi portfolio cash in USD. */
export async function getKalshiCashBalance(): Promise<number> {
  const path = '/trade-api/v2/portfolio/balance';
  const res = await fetch(`${KALSHI_TRADE_BASE}${path}`, {
    method: 'GET',
    headers: makeKalshiAuthHeaders('GET', path),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`Kalshi balance fetch failed: HTTP ${res.status}`);
  const data = await res.json() as Record<string, unknown>;
  if (data.balance_dollars != null) return Math.max(0, Number(data.balance_dollars) || 0);
  return Math.max(0, (Number(data.balance) || 0) / 100);
}

export async function getKalshiPositions(): Promise<KalshiPosition[]> {
  const path = '/trade-api/v2/portfolio/positions';
  const url = `${KALSHI_TRADE_BASE}${path}?count_filter=position&limit=1000`;

  const res = await fetch(url, {
    method: 'GET',
    headers: makeKalshiAuthHeaders('GET', path),
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const msg = (body as any)?.error?.message || `HTTP ${res.status}`;
    logger.error('[kalshi-positions] failed', { status: res.status, msg });
    throw new Error(`Kalshi positions fetch failed: ${msg}`);
  }

  const data = await res.json();
  const positions: KalshiPositionRaw[] = data?.market_positions ?? [];

  // Filter to non-zero positions only
  const openPositions = positions.filter(p => {
    const pos = parseFloat(p.position_fp ?? '0');
    return Math.abs(pos) > 0.0001;
  });

  if (openPositions.length === 0) return [];

  // Enrich with current market prices
  // Group by event ticker to batch-fetch
  const enriched: KalshiPosition[] = [];

  for (const pos of openPositions) {
    try {
      const ticker = pos.ticker;
      // Derive event ticker from market ticker
      const lastHyphen = ticker.lastIndexOf('-');
      const eventTicker = lastHyphen > 0 ? ticker.slice(0, lastHyphen) : ticker;

      let market: KalshiMarket | undefined;
      try {
        const markets = await fetchKalshiEventMarkets(eventTicker);
        market = markets.find(m => m.ticker === ticker);
      } catch {
        // If we can't fetch market data, still return position without enrichment
      }

      const position = parseFloat(pos.position_fp ?? '0');
      const totalCost = parseFloat(pos.total_traded_dollars ?? '0');
      const realizedPnl = parseFloat(pos.realized_pnl_dollars ?? '0');

      const yesBid = market ? parseFloat(market.yes_bid_dollars ?? '0') : 0;
      const yesAsk = market ? parseFloat(market.yes_ask_dollars ?? '0') : 0;
      const noBid = market ? parseFloat(market.no_bid_dollars ?? '0') : 0;
      const noAsk = market ? parseFloat(market.no_ask_dollars ?? '0') : 0;
      const lastPrice = market ? parseFloat(market.last_price_dollars ?? '0') : 0;

      // Unrealized P&L: if long YES, current value = position * yesBid (sell price)
      // If short (negative position), current value = |position| * noBid
      const isLong = position > 0;
      const currentPrice = isLong ? yesBid : noBid;
      const currentValue = Math.abs(position) * currentPrice;
      const unrealizedPnl = currentValue - totalCost;
      const roiPct = totalCost > 0 ? (unrealizedPnl / totalCost) * 100 : 0;

      enriched.push({
        ticker,
        position,
        totalCost,
        realizedPnl,
        currentYesBid: yesBid,
        currentYesAsk: yesAsk,
        currentNoBid: noBid,
        currentNoAsk: noAsk,
        lastPrice,
        title: market?.title ?? ticker,
        eventTicker,
        unrealizedPnl,
        currentValue,
        roiPct,
      });
    } catch (err) {
      logger.warn('[kalshi-positions] enrichment failed', { ticker: pos.ticker, err });
    }
  }

  return enriched;
}