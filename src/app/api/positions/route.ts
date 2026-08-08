import { NextRequest, NextResponse } from 'next/server';
import { clientSafeError } from '@/lib/error-handler';
import { getExecutionMode } from '@/lib/settings';
import logger from '@/lib/logger';
import { calcKalshiFee, calcPolymarketFee, getPolymarketTheta } from '@/lib/matcher';
import { derivePositionRisk } from '@/lib/position-risk';

/**
 * Open Positions API.
 *
 * GET  /api/positions              — fetch all open positions from Kalshi + Polymarket,
 *                                    pair arb legs, return enriched list.
 * POST /api/positions
 *   { action: 'exit', kalshiTicker, pmAsset, kalshiSize, pmSize, kalshiSide, pmSide,
 *     kalshiPriceCents, pmPrice }
 *                                    — place SELL orders on both legs to close an arb pair.
 *                                    Kill switch + confirmation enforced.
 */

export const dynamic = 'force-dynamic';

// ── Types ──

interface KalshiPositionDto {
  platform: 'kalshi';
  ticker: string;
  title: string;
  eventTicker: string;
  side: 'YES' | 'NO';
  position: number;       // contracts (signed: + = long, - = short)
  size: number;           // abs(position)
  entryPrice: number;     // avg entry price (0-1)
  currentPrice: number;   // current bid for the side we'd sell
  currentValue: number;   // USD
  totalCost: number;      // USD
  unrealizedPnl: number;  // USD (gross)
  roiPct: number;         // gross ROI %
  realizedPnl: number;
  lastPrice: number;
  // Fee-adjusted (net) fields
  feesPaid: number;       // estimated fees paid at entry (USD)
  netUnrealizedPnl: number; // unrealizedPnl - exitFees
  netRoiPct: number;      // net ROI %
  exitFees: number;       // estimated fees to sell at current price (USD)
  // Arb pair linkage
  pairId: string | null;  // shared with the opposite leg if part of an arb pair
}

interface PmPositionDto {
  platform: 'polymarket';
  asset: string;          // token ID
  conditionId: string;
  title: string;
  slug: string;
  outcome: string;        // "Yes" or "No"
  side: 'YES' | 'NO';
  size: number;           // shares
  entryPrice: number;     // avgPrice (0-1)
  currentPrice: number;   // curPrice (0-1)
  currentValue: number;   // USD
  initialValue: number;   // USD
  cashPnl: number;        // USD (gross)
  percentPnl: number;     // % (gross)
  endDate: string;
  negativeRisk: boolean;
  // Fee-adjusted (net) fields
  feesPaid: number;       // estimated fees paid at entry (USD)
  netCashPnl: number;     // cashPnl - exitFees
  netPercentPnl: number;  // net %
  exitFees: number;       // estimated fees to sell at current price (USD)
  // Arb pair linkage
  pairId: string | null;  // shared with the opposite leg if part of an arb pair
}

interface RoiBreakdown {
  legA: {
    platform: string;
    side: string;
    entryPrice: number;
    currentPrice: number;
    size: number;
    grossPnl: number;
    feesPaid: number;   // entry fees
    exitFees: number;   // estimated exit fees
    netPnl: number;     // grossPnl - exitFees (entry fees already in cost basis)
    roiPct: number;     // net ROI %
  } | null;
  legB: {
    platform: string;
    side: string;
    entryPrice: number;
    currentPrice: number;
    size: number;
    grossPnl: number;
    feesPaid: number;
    exitFees: number;
    netPnl: number;
    roiPct: number;
  } | null;
  totalGrossPnl: number;
  totalFees: number;     // entry + exit fees for both legs
  totalNetPnl: number;
  totalRoiPct: number;   // net ROI %
}

interface PairedPosition {
  id: string;
  marketTitle: string;
  kalshi: KalshiPositionDto | null;
  polymarket: PmPositionDto | null;
  totalValue: number;
  totalCost: number;
  totalUnrealizedPnl: number;  // gross
  totalRoiPct: number;         // net ROI %
  breakdown: RoiBreakdown;
}

// ── GET: fetch all positions ──

export async function GET(): Promise<NextResponse> {
  try {
    const [kalshiPositions, pmPositions] = await Promise.allSettled([
      fetchKalshiPositions(),
      fetchPmPositions(),
    ]);

    const kalshi: KalshiPositionDto[] =
      kalshiPositions.status === 'fulfilled' ? kalshiPositions.value : [];
    const pm: PmPositionDto[] =
      pmPositions.status === 'fulfilled' ? pmPositions.value : [];

    const kalshiError = kalshiPositions.status === 'rejected' ? kalshiPositions.reason?.message : null;
    const pmError = pmPositions.status === 'rejected' ? pmPositions.reason?.message : null;

    // Pair positions by title similarity (arb legs = same market on both platforms)
    const paired = pairPositions(kalshi, pm);

    // Account feeds do not expose orderbook-depth timestamps. Publish the fetch
    // timestamp and explicitly mark liquidity as unverified instead of implying it.
    const quoteTimestamp = new Date().toISOString();
    const enriched = paired.map((position) => ({
      ...position,
      ...derivePositionRisk(position),
      quoteTimestamps: {
        kalshi: position.kalshi ? quoteTimestamp : null,
        polymarket: position.polymarket ? quoteTimestamp : null,
      },
    }));

    // Needs-attention positions first, then stable alphabetical ordering.
    enriched.sort((a, b) => {
      const riskDelta = b.attentionReasons.length - a.attentionReasons.length;
      return riskDelta || a.marketTitle.localeCompare(b.marketTitle);
    });

    return NextResponse.json({
      success: true,
      positions: enriched,
      raw: { kalshi, polymarket: pm },
      errors: { kalshi: kalshiError, polymarket: pmError },
    });
  } catch (err) {
    return NextResponse.json({ error: clientSafeError(err) }, { status: 500 });
  }
}

// ── POST: exit (close both legs) ──

export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    const body = await req.json();
    const action = body?.action;

    if (action !== 'exit') {
      return NextResponse.json({ error: 'Unknown action. Use "exit".' }, { status: 400 });
    }

    // Only explicit live mode permits closing real positions.
    const executionMode = await getExecutionMode().catch(() => 'paper' as const);
    if (executionMode !== 'live') {
      return NextResponse.json(
        { error: `Execution mode is ${executionMode}. Switch explicitly to live before closing positions.` },
        { status: 403 },
      );
    }

    const { kalshi, polymarket } = body;

    if (!kalshi && !polymarket) {
      return NextResponse.json({ error: 'No positions specified for exit' }, { status: 400 });
    }

    const results: { kalshi?: any; polymarket?: any } = {};
    const errors: { kalshi?: string; polymarket?: string } = {};

    // Close Kalshi leg: place SELL order
    if (kalshi) {
      try {
        const { placeKalshiSellOrder } = await import('@/lib/kalshi-orders');
        const result = await placeKalshiSellOrder({
          ticker: kalshi.ticker,
          side: kalshi.side === 'YES' ? 'yes' : 'no',
          count: Math.floor(kalshi.size),
          priceCents: Math.round(kalshi.priceCents),
          clientOrderId: `exit-${Date.now()}-kalshi`,
        });
        results.kalshi = result;
        logger.info('[positions] Kalshi sell order placed', { ticker: kalshi.ticker, result });
      } catch (err) {
        errors.kalshi = err instanceof Error ? err.message : String(err);
        logger.error('[positions] Kalshi sell failed', { error: errors.kalshi });
      }
    }

    // Close Polymarket leg: place SELL order
    if (polymarket) {
      try {
        const { placePmSellOrder } = await import('@/lib/polymarket-orders');
        const result = await placePmSellOrder({
          tokenId: polymarket.asset,
          price: polymarket.price,
          size: polymarket.size,
        });
        results.polymarket = result;
        logger.info('[positions] Polymarket sell order placed', { asset: polymarket.asset, result });
      } catch (err) {
        errors.polymarket = err instanceof Error ? err.message : String(err);
        logger.error('[positions] Polymarket sell failed', { error: errors.polymarket });
      }
    }

    const success = !errors.kalshi && !errors.polymarket;
    const partialFill = (errors.kalshi && !errors.polymarket) || (!errors.kalshi && errors.polymarket);

    // Persist both the execution audit record and one immutable closed-position
    // record per successfully submitted leg. The latter powers full realized-P&L
    // history rather than trying to reconstruct entry data from a sell order.
    if (success || partialFill) {
      try {
        const { persistExecution, persistClosedPosition } = await import('@/lib/persistence');
        const closedAt = new Date().toISOString();
        const netLegPnl = (leg: any, grossPnl: number) => grossPnl - Number(leg?.exitFees ?? 0);
        const totalRealizedPnl =
          (kalshi && !errors.kalshi ? netLegPnl(kalshi, Number(kalshi.unrealizedPnl ?? 0)) : 0)
          + (polymarket && !errors.polymarket ? netLegPnl(polymarket, Number(polymarket.cashPnl ?? 0)) : 0);

        const closedRecords = [
          kalshi && !errors.kalshi ? {
            marketTitle: kalshi.title ?? 'Unknown', platform: 'kalshi' as const, side: kalshi.side,
            size: Number(kalshi.size), entryPrice: Number(kalshi.entryPrice ?? 0),
            exitPrice: Number(kalshi.exitPrice ?? kalshi.priceCents / 100),
            realizedPnl: netLegPnl(kalshi, Number(kalshi.unrealizedPnl ?? 0)),
            roiPct: Number(kalshi.totalCost ?? 0) > 0
              ? netLegPnl(kalshi, Number(kalshi.unrealizedPnl ?? 0)) / Number(kalshi.totalCost) * 100 : 0,
            openedAt: kalshi.openedAt ?? null, closedAt,
            durationSecs: kalshi.openedAt ? Math.max(0, Math.floor((Date.parse(closedAt) - Date.parse(kalshi.openedAt)) / 1000)) : null,
            pairId: body.pairId ?? null, feesPaid: Number(kalshi.feesPaid ?? 0) + Number(kalshi.exitFees ?? 0),
            ticker: kalshi.ticker, executionMode: 'live' as const,
          } : null,
          polymarket && !errors.polymarket ? {
            marketTitle: polymarket.title ?? 'Unknown', platform: 'polymarket' as const, side: polymarket.side,
            size: Number(polymarket.size), entryPrice: Number(polymarket.entryPrice ?? 0),
            exitPrice: Number(polymarket.exitPrice ?? polymarket.price),
            realizedPnl: netLegPnl(polymarket, Number(polymarket.cashPnl ?? 0)),
            roiPct: Number(polymarket.totalCost ?? 0) > 0
              ? netLegPnl(polymarket, Number(polymarket.cashPnl ?? 0)) / Number(polymarket.totalCost) * 100 : 0,
            openedAt: polymarket.openedAt ?? null, closedAt,
            durationSecs: polymarket.openedAt ? Math.max(0, Math.floor((Date.parse(closedAt) - Date.parse(polymarket.openedAt)) / 1000)) : null,
            pairId: body.pairId ?? null, feesPaid: Number(polymarket.feesPaid ?? 0) + Number(polymarket.exitFees ?? 0),
            conditionId: polymarket.conditionId, executionMode: 'live' as const,
          } : null,
        ].filter(Boolean);
        await Promise.all(closedRecords.map((record) => persistClosedPosition(record!)));
        await persistExecution({
          timestamp: closedAt,
          arbId: `exit-${Date.now()}`,
          marketTitle: kalshi?.title ?? polymarket?.title ?? 'Unknown',
          dryRun: false,
          success,
          strategy: 'manual-exit',
          kalshiOrder: kalshi ? {
            ticker: kalshi.ticker,
            outcome: kalshi.side,
            side: 'sell',
            size: kalshi.size,
            price: kalshi.priceCents / 100,
            platform: 'kalshi',
          } : null,
          polymarketOrder: polymarket ? {
            outcome: polymarket.outcome,
            side: 'sell',
            size: polymarket.size,
            price: polymarket.price,
            platform: 'polymarket',
            conditionId: polymarket.conditionId,
          } : null,
          result: {
            kalshiResult: results.kalshi ? {
              status: results.kalshi.status,
              orderId: results.kalshi.orderId,
              filledSize: results.kalshi.filledCount,
            } : undefined,
            polymarketResult: results.polymarket ? {
              status: results.polymarket.status,
              orderId: results.polymarket.orderId,
            } : undefined,
            actualProfit: totalRealizedPnl,
          },
          estimatedProfit: totalRealizedPnl,
        }).catch(e => logger.warn('[positions] persistExecution failed', { error: String(e) }));
      } catch {
        // non-fatal
      }
    }

    return NextResponse.json({
      success,
      partialFill,
      results,
      errors: Object.keys(errors).length > 0 ? errors : undefined,
    });
  } catch (err) {
    return NextResponse.json({ error: clientSafeError(err) }, { status: 500 });
  }
}

// ── Helpers ──

async function fetchKalshiPositions(): Promise<KalshiPositionDto[]> {
  const { getKalshiPositions } = await import('@/lib/kalshi-positions');
  const positions = await getKalshiPositions();
  return positions.map(p => {
    const size = Math.abs(p.position);
    const entryPrice = p.totalCost / Math.max(size, 1);
    const currentPrice = p.position > 0 ? p.currentYesBid : p.currentNoBid;
    // Entry fees: contracts * entryPrice * (1-entryPrice) * rate
    const feesPaid = calcKalshiFee(size, entryPrice);
    // Exit fees: selling at currentPrice
    const exitFees = calcKalshiFee(size, currentPrice);
    const netUnrealizedPnl = p.unrealizedPnl - exitFees;
    const netRoiPct = p.totalCost > 0 ? (netUnrealizedPnl / p.totalCost) * 100 : 0;
    return {
      platform: 'kalshi' as const,
      ticker: p.ticker,
      title: p.title,
      eventTicker: p.eventTicker,
      side: p.position > 0 ? 'YES' as const : 'NO' as const,
      position: p.position,
      size,
      entryPrice,
      currentPrice,
      currentValue: p.currentValue,
      totalCost: p.totalCost,
      unrealizedPnl: p.unrealizedPnl,
      roiPct: p.roiPct,
      realizedPnl: p.realizedPnl,
      lastPrice: p.lastPrice,
      feesPaid,
      netUnrealizedPnl,
      netRoiPct,
      exitFees,
      pairId: null,  // populated by pairPositions()
    };
  });
}

async function fetchPmPositions(): Promise<PmPositionDto[]> {
  const { getPolymarketPositions } = await import('@/lib/polymarket-positions');
  const positions = await getPolymarketPositions();
  return positions.map(p => {
    // Entry fees: theta * shares * entryPrice * (1-entryPrice)
    const entryTheta = getPolymarketTheta(); // default category
    const feesPaid = calcPolymarketFee(p.size, p.avgPrice, entryTheta);
    // Exit fees: selling at current price
    const exitFees = calcPolymarketFee(p.size, p.curPrice, entryTheta);
    const netCashPnl = p.cashPnl - exitFees;
    const netPercentPnl = p.initialValue > 0 ? (netCashPnl / p.initialValue) * 100 : 0;
    return {
      platform: 'polymarket' as const,
      asset: p.asset,
      conditionId: p.conditionId,
      title: p.title,
      slug: p.slug,
      outcome: p.outcome,
      side: p.outcome.toLowerCase() === 'yes' ? 'YES' as const : 'NO' as const,
      size: p.size,
      entryPrice: p.avgPrice,
      currentPrice: p.curPrice,
      currentValue: p.currentValue,
      initialValue: p.initialValue,
      cashPnl: p.cashPnl,
      percentPnl: p.percentPnl,
      endDate: p.endDate,
      negativeRisk: p.negativeRisk,
      feesPaid,
      netCashPnl,
      netPercentPnl,
      exitFees,
      pairId: null,  // populated by pairPositions()
    };
  });
}

/** Build a per-leg breakdown for ROI tooltip. */
function buildBreakdown(
  k: KalshiPositionDto | null,
  p: PmPositionDto | null,
): RoiBreakdown {
  const legA = k ? {
    platform: 'Kalshi',
    side: k.side,
    entryPrice: k.entryPrice,
    currentPrice: k.currentPrice,
    size: k.size,
    grossPnl: k.unrealizedPnl,
    feesPaid: k.feesPaid,
    exitFees: k.exitFees,
    netPnl: k.netUnrealizedPnl,
    roiPct: k.netRoiPct,
  } : null;

  const legB = p ? {
    platform: 'Polymarket',
    side: p.side,
    entryPrice: p.entryPrice,
    currentPrice: p.currentPrice,
    size: p.size,
    grossPnl: p.cashPnl,
    feesPaid: p.feesPaid,
    exitFees: p.exitFees,
    netPnl: p.netCashPnl,
    roiPct: p.netPercentPnl,
  } : null;

  const totalGrossPnl = (legA?.grossPnl ?? 0) + (legB?.grossPnl ?? 0);
  const totalFees = (legA?.feesPaid ?? 0) + (legA?.exitFees ?? 0) + (legB?.feesPaid ?? 0) + (legB?.exitFees ?? 0);
  const totalNetPnl = (legA?.netPnl ?? 0) + (legB?.netPnl ?? 0);
  const totalCost = (k?.totalCost ?? 0) + (p?.initialValue ?? 0);
  const totalRoiPct = totalCost > 0 ? (totalNetPnl / totalCost) * 100 : 0;

  return { legA, legB, totalGrossPnl, totalFees, totalNetPnl, totalRoiPct };
}

/**
 * Pair Kalshi and Polymarket positions by market title similarity.
 * Arb trades buy YES on one platform and NO on the other for the same market.
 * We normalize titles and match on fuzzy similarity.
 */
function pairPositions(kalshi: KalshiPositionDto[], pm: PmPositionDto[]): PairedPosition[] {
  const pairs: PairedPosition[] = [];
  const usedPm = new Set<number>();

  // For each Kalshi position, find the best-matching Polymarket position
  for (const k of kalshi) {
    let bestMatch: { idx: number; score: number } | null = null;

    for (let i = 0; i < pm.length; i++) {
      if (usedPm.has(i)) continue;
      const score = titleSimilarity(k.title, pm[i].title);
      if (score > 0.5 && (!bestMatch || score > bestMatch.score)) {
        bestMatch = { idx: i, score };
      }
    }

    if (bestMatch) {
      usedPm.add(bestMatch.idx);
      const p = pm[bestMatch.idx];
      const breakdown = buildBreakdown(k, p);
      const pairId = `pair-${k.ticker}-${p.asset.slice(0, 8)}`;
      // Link both legs with the shared pairId
      k.pairId = pairId;
      p.pairId = pairId;
      pairs.push({
        id: pairId,
        marketTitle: k.title,
        kalshi: k,
        polymarket: p,
        totalValue: k.currentValue + p.currentValue,
        totalCost: k.totalCost + p.initialValue,
        totalUnrealizedPnl: k.unrealizedPnl + p.cashPnl,
        totalRoiPct: breakdown.totalRoiPct,
        breakdown,
      });
    } else {
      // Unpaired Kalshi position
      k.pairId = null;
      const breakdown = buildBreakdown(k, null);
      pairs.push({
        id: `solo-k-${k.ticker}`,
        marketTitle: k.title,
        kalshi: k,
        polymarket: null,
        totalValue: k.currentValue,
        totalCost: k.totalCost,
        totalUnrealizedPnl: k.unrealizedPnl,
        totalRoiPct: breakdown.totalRoiPct,
        breakdown,
      });
    }
  }

  // Add unpaired Polymarket positions
  for (let i = 0; i < pm.length; i++) {
    if (usedPm.has(i)) continue;
    const p = pm[i];
    p.pairId = null;
    const breakdown = buildBreakdown(null, p);
    pairs.push({
      id: `solo-p-${p.asset.slice(0, 12)}`,
      marketTitle: p.title,
      kalshi: null,
      polymarket: p,
      totalValue: p.currentValue,
      totalCost: p.initialValue,
      totalUnrealizedPnl: p.cashPnl,
      totalRoiPct: breakdown.totalRoiPct,
      breakdown,
    });
  }

  return pairs;
}

/**
 * Fuzzy title similarity: normalize both titles, compute Jaccard similarity
 * on word sets. Returns 0-1.
 */
function titleSimilarity(a: string, b: string): number {
  const normalize = (s: string) =>
    s.toLowerCase()
      .replace(/[^a-z0-9\s]/g, '')
      .split(/\s+/)
      .filter(w => w.length > 2);

  const wa = new Set(normalize(a));
  const wb = new Set(normalize(b));
  if (wa.size === 0 || wb.size === 0) return 0;

  let intersection = 0;
  for (const w of wa) {
    if (wb.has(w)) intersection++;
  }
  const union = wa.size + wb.size - intersection;
  return intersection / union;
}