import { NextRequest, NextResponse } from 'next/server';
import { clientSafeError } from '@/lib/error-handler';
import { getExecutionMode } from '@/lib/settings';
import logger from '@/lib/logger';
import { derivePositionRisk } from '@/lib/position-risk';
import { legacyUnverifiableEnvelope } from '@/lib/calculation-envelope';
import {
  CALCULATION_ENVELOPE_VERSION,
  MONEY_SCALE,
  PRICE_SCALE,
  QUANTITY_SCALE,
  validateCalculationEnvelope,
  type CalculationEnvelope,
  type CalculationLeg,
  type FeeScheduleAuthority,
} from '@/lib/calculation-envelope';
import { isAuthoritativeVenueEvidence, type VenueExecutionEvidence } from '@/lib/execution-evidence';

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
  feesPaid: null;
  netUnrealizedPnl: null;
  netRoiPct: null;
  exitFees: null;
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
  feesPaid: null;
  netCashPnl: null;
  netPercentPnl: null;
  exitFees: null;
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
    feesPaid: null;
    exitFees: null;
    netPnl: null;
    roiPct: null;
  } | null;
  legB: {
    platform: string;
    side: string;
    entryPrice: number;
    currentPrice: number;
    size: number;
    grossPnl: number;
    feesPaid: null;
    exitFees: null;
    netPnl: null;
    roiPct: null;
  } | null;
  totalGrossPnl: number;
  totalFees: null;
  totalNetPnl: null;
  totalRoiPct: null;
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

interface ExitFeeAuthority {
  kalshi: { feeMultiplierPpm: number; source: string; observedAt: string; version: string };
  polymarket: { feeRateBps: number; source: string; observedAt: string; version: string };
}

interface ExitOrderResult {
  status?: unknown;
  orderId?: unknown;
  filledCount?: unknown;
  evidence?: unknown;
  venueEvidence?: unknown;
}

const NULL_TOTALS = {
  grossCostMicros: null,
  grossPayoutMicros: null,
  grossProfitMicros: null,
  totalFeesMicros: null,
  netPnlMicros: null,
} as const;

function toScaledInteger(value: number, scale: number, label: string): number {
  if (!Number.isFinite(value)) throw new Error(`${label} is not finite`);
  const scaled = Math.round(value * scale);
  if (!Number.isSafeInteger(scaled)) throw new Error(`${label} exceeds safe integer range`);
  return scaled;
}

function currentPositionLegs(position: PairedPosition, observedAt: string): CalculationLeg[] {
  const legs: CalculationLeg[] = [];
  if (position.kalshi) {
    legs.push({
      venue: 'kalshi', instrumentId: position.kalshi.ticker, outcomeId: position.kalshi.ticker,
      side: position.kalshi.side.toLowerCase() as 'yes' | 'no', action: 'sell',
      requestedQuantityMicros: toScaledInteger(position.kalshi.size, QUANTITY_SCALE, 'Kalshi position quantity'),
      executableQuantityMicros: null, bookObservedAt: observedAt, fillLevels: [], vwapPriceMicros: null,
      fee: { basis: 'unavailable', amountMicros: null, schedule: null },
    });
  }
  if (position.polymarket) {
    legs.push({
      venue: 'polymarket', instrumentId: position.polymarket.asset, outcomeId: position.polymarket.conditionId,
      side: position.polymarket.side.toLowerCase() as 'yes' | 'no', action: 'sell',
      requestedQuantityMicros: toScaledInteger(position.polymarket.size, QUANTITY_SCALE, 'Polymarket position quantity'),
      executableQuantityMicros: null, bookObservedAt: observedAt, fillLevels: [], vwapPriceMicros: null,
      fee: { basis: 'unavailable', amountMicros: null, schedule: null },
    });
  }
  return legs;
}

function unavailablePositionEnvelope(position: PairedPosition, observedAt: string): CalculationEnvelope {
  const legs = currentPositionLegs(position, observedAt);
  const quantities = new Set(legs.map((leg) => leg.requestedQuantityMicros));
  return validateCalculationEnvelope({
    version: CALCULATION_ENVELOPE_VERSION,
    scope: 'position',
    status: 'unavailable',
    blocker: {
      code: 'account_feed_missing_fee_authority',
      message: 'Current account positions do not include charged entry fees or executable exit-depth fee authority',
    },
    calculatedAt: observedAt,
    requestedQuantityMicros: quantities.size === 1 ? legs[0]?.requestedQuantityMicros ?? null : null,
    executableQuantityMicros: null,
    legs,
    totals: { ...NULL_TOTALS },
    rounding: { moneyScale: MONEY_SCALE, priceScale: PRICE_SCALE, quantityScale: QUANTITY_SCALE, mode: 'venue_rules_then_sum' },
  });
}

function chargedFeeSchedule(venue: 'kalshi' | 'polymarket', authority: ExitFeeAuthority): FeeScheduleAuthority {
  if (venue === 'kalshi') {
    return {
      source: authority.kalshi.source,
      version: authority.kalshi.version,
      observedAt: authority.kalshi.observedAt,
      ratePpm: Math.round(70_000 * authority.kalshi.feeMultiplierPpm / 1_000_000),
    };
  }
  return {
    source: authority.polymarket.source,
    version: authority.polymarket.version,
    observedAt: authority.polymarket.observedAt,
    ratePpm: authority.polymarket.feeRateBps * 100,
  };
}

function evidenceFillLevels(evidence: VenueExecutionEvidence) {
  const fills = evidence.fills ?? [{ quantity: evidence.filledQuantity, price: evidence.fillPrice }];
  return fills.map((fill) => ({
    priceMicros: toScaledInteger(fill.price, PRICE_SCALE, `${evidence.venue} fill price`),
    quantityMicros: toScaledInteger(fill.quantity, QUANTITY_SCALE, `${evidence.venue} fill quantity`),
  }));
}

function roundedVwap(fillLevels: Array<{ priceMicros: number; quantityMicros: number }>): number {
  const quantity = fillLevels.reduce((sum, fill) => sum + BigInt(fill.quantityMicros), 0n);
  const weighted = fillLevels.reduce(
    (sum, fill) => sum + BigInt(fill.priceMicros) * BigInt(fill.quantityMicros),
    0n,
  );
  return Number((weighted + quantity / 2n) / quantity);
}

function venueRoundedPayoutMicros(fillLevels: Array<{ priceMicros: number; quantityMicros: number }>): number {
  return fillLevels.reduce((sum, fill) => (
    sum + Number((BigInt(fill.priceMicros) * BigInt(fill.quantityMicros) + 500_000n) / 1_000_000n)
  ), 0);
}

export function buildExitCalculationEnvelope(
  position: PairedPosition,
  results: { kalshi?: unknown; polymarket?: unknown },
  errors: { kalshi?: string; polymarket?: string },
  authority: ExitFeeAuthority | null,
  calculatedAt: string,
): CalculationEnvelope {
  const descriptors = [
    position.kalshi ? {
      venue: 'kalshi' as const,
      instrumentId: position.kalshi.ticker,
      outcomeId: position.kalshi.ticker,
      side: position.kalshi.side.toLowerCase() as 'yes' | 'no',
      size: position.kalshi.size,
      entryCost: position.kalshi.totalCost,
      rawEvidence: errors.kalshi ? null : (results.kalshi as { evidence?: unknown } | undefined)?.evidence,
    } : null,
    position.polymarket ? {
      venue: 'polymarket' as const,
      instrumentId: position.polymarket.asset,
      outcomeId: position.polymarket.conditionId,
      side: position.polymarket.side.toLowerCase() as 'yes' | 'no',
      size: position.polymarket.size,
      entryCost: position.polymarket.initialValue,
      rawEvidence: errors.polymarket ? null : (results.polymarket as { venueEvidence?: unknown } | undefined)?.venueEvidence,
    } : null,
  ].filter((value) => value !== null);

  const legs: CalculationLeg[] = descriptors.map((descriptor) => {
    const evidence = isAuthoritativeVenueEvidence(descriptor.rawEvidence)
      && descriptor.rawEvidence.venue === descriptor.venue
      ? descriptor.rawEvidence
      : null;
    const fillLevels = evidence ? evidenceFillLevels(evidence) : [];
    return {
      venue: descriptor.venue,
      instrumentId: descriptor.instrumentId,
      outcomeId: descriptor.outcomeId,
      side: descriptor.side,
      action: 'sell',
      requestedQuantityMicros: toScaledInteger(descriptor.size, QUANTITY_SCALE, `${descriptor.venue} requested quantity`),
      executableQuantityMicros: evidence
        ? toScaledInteger(evidence.filledQuantity, QUANTITY_SCALE, `${descriptor.venue} filled quantity`)
        : null,
      bookObservedAt: evidence?.venueTimestamp ?? null,
      fillLevels,
      vwapPriceMicros: fillLevels.length > 0 ? roundedVwap(fillLevels) : null,
      fee: evidence && authority ? {
        basis: 'charged',
        amountMicros: evidence.chargedFeeCents * 10_000,
        schedule: chargedFeeSchedule(descriptor.venue, authority),
      } : { basis: 'unavailable', amountMicros: null, schedule: null },
    };
  });

  const requested = new Set(legs.map((leg) => leg.requestedQuantityMicros));
  const executable = new Set(legs.map((leg) => leg.executableQuantityMicros));
  const complete = descriptors.length === 2 && legs.length === 2
    && !errors.kalshi && !errors.polymarket
    && authority !== null && requested.size === 1 && executable.size === 1
    && !executable.has(null)
    && legs.every((leg) => leg.executableQuantityMicros === leg.requestedQuantityMicros && leg.fee.basis === 'charged');

  if (!complete) {
    return validateCalculationEnvelope({
      version: CALCULATION_ENVELOPE_VERSION,
      scope: 'position',
      status: 'unavailable',
      blocker: {
        code: 'missing_charged_exit_authority',
        message: 'One or more submitted exit legs lack correlated venue fill, charged-fee, or fee-schedule authority',
      },
      calculatedAt,
      requestedQuantityMicros: requested.size === 1 ? legs[0]?.requestedQuantityMicros ?? null : null,
      executableQuantityMicros: null,
      legs,
      totals: { ...NULL_TOTALS },
      rounding: { moneyScale: MONEY_SCALE, priceScale: PRICE_SCALE, quantityScale: QUANTITY_SCALE, mode: 'venue_rules_then_sum' },
    });
  }

  const grossCostMicros = descriptors.reduce(
    (sum, descriptor) => sum + toScaledInteger(descriptor.entryCost, MONEY_SCALE, `${descriptor.venue} entry cost`),
    0,
  );
  const grossPayoutMicros = legs.reduce((sum, leg) => sum + venueRoundedPayoutMicros(leg.fillLevels), 0);
  const totalFeesMicros = legs.reduce((sum, leg) => sum + leg.fee.amountMicros!, 0);
  const grossProfitMicros = grossPayoutMicros - grossCostMicros;
  const netPnlMicros = grossProfitMicros - totalFeesMicros;

  return validateCalculationEnvelope({
    version: CALCULATION_ENVELOPE_VERSION,
    scope: 'position',
    status: 'executable',
    blocker: null,
    calculatedAt,
    requestedQuantityMicros: legs[0].requestedQuantityMicros,
    executableQuantityMicros: legs[0].executableQuantityMicros,
    legs,
    totals: { grossCostMicros, grossPayoutMicros, grossProfitMicros, totalFeesMicros, netPnlMicros },
    rounding: { moneyScale: MONEY_SCALE, priceScale: PRICE_SCALE, quantityScale: QUANTITY_SCALE, mode: 'venue_rules_then_sum' },
  });
}

// ── GET: fetch all positions ──

export async function GET(): Promise<NextResponse> {
  try {
    const [kalshiPositions, pmPositions, kalshiCash, pmCash] = await Promise.allSettled([
      fetchKalshiPositions(),
      fetchPmPositions(),
      import('@/lib/kalshi-positions').then(module => module.getKalshiCashBalance()),
      import('@/lib/polymarket-orders').then(module => module.getPmCashBalance()),
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
      calculationEnvelope: unavailablePositionEnvelope(position, quoteTimestamp),
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
      cash: {
        kalshi: kalshiCash.status === 'fulfilled' ? kalshiCash.value : null,
        polymarket: pmCash.status === 'fulfilled' ? pmCash.value : null,
        total: (kalshiCash.status === 'fulfilled' ? kalshiCash.value : 0) + (pmCash.status === 'fulfilled' ? pmCash.value : 0),
        complete: kalshiCash.status === 'fulfilled' && pmCash.status === 'fulfilled',
      },
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

    if (typeof body?.pairId !== 'string' || body.pairId.trim().length === 0) {
      return NextResponse.json({ error: 'Missing position pair id' }, { status: 400 });
    }

    // Never trust executable order fields from the client. Resolve the current
    // account positions and quote inputs server-side, then allow only a pair
    // that exists in that authoritative snapshot.
    const [kalshiPositions, pmPositions] = await Promise.all([
      fetchKalshiPositions(),
      fetchPmPositions(),
    ]);
    const verifiedPair = pairPositions(kalshiPositions, pmPositions)
      .find((position) => position.id === body.pairId.trim());

    if (!verifiedPair) {
      return NextResponse.json({ error: 'Open position pair not found' }, { status: 404 });
    }

    const verifiedKalshi = verifiedPair.kalshi;
    const verifiedPolymarket = verifiedPair.polymarket;
    if (
      (verifiedKalshi && (!Number.isFinite(verifiedKalshi.size) || verifiedKalshi.size <= 0
        || !Number.isFinite(verifiedKalshi.currentPrice) || verifiedKalshi.currentPrice <= 0 || verifiedKalshi.currentPrice > 1))
      || (verifiedPolymarket && (!Number.isFinite(verifiedPolymarket.size) || verifiedPolymarket.size <= 0
        || !Number.isFinite(verifiedPolymarket.currentPrice) || verifiedPolymarket.currentPrice <= 0 || verifiedPolymarket.currentPrice > 1))
    ) {
      return NextResponse.json({ error: 'Open position has no executable server quote' }, { status: 409 });
    }

    let exitFeeAuthority: ExitFeeAuthority | null = null;
    if (verifiedKalshi && verifiedPolymarket) {
      try {
        const { fetchAuthoritativeBotFeeConfig } = await import('@/lib/bot-positions');
        exitFeeAuthority = await fetchAuthoritativeBotFeeConfig({
          kalshiTicker: verifiedKalshi.ticker,
          pmConditionId: verifiedPolymarket.conditionId,
          pmTokenId: verifiedPolymarket.asset,
          pmSide: verifiedPolymarket.side.toLowerCase() as 'yes' | 'no',
        });
      } catch (error) {
        logger.warn('[positions] current exit fee authority unavailable', { error: String(error) });
      }
    }

    // Compatibility shapes for the existing order/audit path. Every executable
    // field below comes from the verified account snapshot, not request JSON.
    const kalshi = verifiedKalshi ? {
      ...verifiedKalshi,
      priceCents: verifiedKalshi.currentPrice * 100,
      exitPrice: verifiedKalshi.currentPrice,
      openedAt: null as string | null,
    } : null;
    const polymarket = verifiedPolymarket ? {
      ...verifiedPolymarket,
      price: verifiedPolymarket.currentPrice,
      exitPrice: verifiedPolymarket.currentPrice,
      totalCost: verifiedPolymarket.initialValue,
      openedAt: null as string | null,
    } : null;

    const results: { kalshi?: ExitOrderResult; polymarket?: ExitOrderResult } = {};
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
    const closedAt = new Date().toISOString();
    const calculationEnvelope = buildExitCalculationEnvelope(
      verifiedPair,
      results,
      errors,
      exitFeeAuthority,
      closedAt,
    );

    // Persist both the execution audit record and one immutable closed-position
    // record per successfully submitted leg. The latter powers full realized-P&L
    // history rather than trying to reconstruct entry data from a sell order.
    if (success || partialFill) {
      try {
        const { persistExecution, persistClosedPosition } = await import('@/lib/persistence');
        const canonicalNetPnl = calculationEnvelope.status === 'executable'
          ? calculationEnvelope.totals.netPnlMicros! / MONEY_SCALE
          : null;
        const legAccounting = (venue: 'kalshi' | 'polymarket', entryCost: number) => {
          if (calculationEnvelope.status !== 'executable') return null;
          const leg = calculationEnvelope.legs.find((candidate) => candidate.venue === venue);
          if (!leg || leg.vwapPriceMicros == null || leg.executableQuantityMicros == null || leg.fee.amountMicros == null) return null;
          if (leg.executableQuantityMicros !== leg.requestedQuantityMicros) return null;
          const payoutMicros = venueRoundedPayoutMicros(leg.fillLevels);
          const realizedPnl = (payoutMicros - toScaledInteger(entryCost, MONEY_SCALE, `${venue} entry cost`) - leg.fee.amountMicros) / MONEY_SCALE;
          return { leg, realizedPnl, exitPrice: leg.vwapPriceMicros / PRICE_SCALE, exitFee: leg.fee.amountMicros / MONEY_SCALE };
        };
        const kalshiAccounting = kalshi ? legAccounting('kalshi', kalshi.totalCost) : null;
        const polymarketAccounting = polymarket ? legAccounting('polymarket', polymarket.totalCost) : null;
        const closedSize = (venue: 'kalshi' | 'polymarket') => {
          const leg = calculationEnvelope.legs.find((candidate) => candidate.venue === venue);
          return leg?.executableQuantityMicros == null ? null : leg.executableQuantityMicros / QUANTITY_SCALE;
        };

        const closedRecords = [
          kalshi && !errors.kalshi ? {
            marketTitle: kalshi.title ?? 'Unknown', platform: 'kalshi' as const, side: kalshi.side,
            size: closedSize('kalshi'), entryPrice: Number(kalshi.entryPrice),
            exitPrice: kalshiAccounting?.exitPrice ?? null,
            realizedPnl: kalshiAccounting?.realizedPnl ?? null,
            roiPct: kalshiAccounting && kalshi.totalCost > 0 ? kalshiAccounting.realizedPnl / kalshi.totalCost * 100 : null,
            openedAt: kalshi.openedAt ?? null, closedAt,
            durationSecs: kalshi.openedAt ? Math.max(0, Math.floor((Date.parse(closedAt) - Date.parse(kalshi.openedAt)) / 1000)) : null,
            pairId: body.pairId ?? null, feesPaid: kalshiAccounting?.exitFee ?? null,
            ticker: kalshi.ticker, executionMode: 'live' as const,
            rawData: results.kalshi,
            calculationEnvelope,
          } : null,
          polymarket && !errors.polymarket ? {
            marketTitle: polymarket.title ?? 'Unknown', platform: 'polymarket' as const, side: polymarket.side,
            size: closedSize('polymarket'), entryPrice: Number(polymarket.entryPrice),
            exitPrice: polymarketAccounting?.exitPrice ?? null,
            realizedPnl: polymarketAccounting?.realizedPnl ?? null,
            roiPct: polymarketAccounting && polymarket.totalCost > 0 ? polymarketAccounting.realizedPnl / polymarket.totalCost * 100 : null,
            openedAt: polymarket.openedAt ?? null, closedAt,
            durationSecs: polymarket.openedAt ? Math.max(0, Math.floor((Date.parse(closedAt) - Date.parse(polymarket.openedAt)) / 1000)) : null,
            pairId: body.pairId ?? null, feesPaid: polymarketAccounting?.exitFee ?? null,
            conditionId: polymarket.conditionId, executionMode: 'live' as const,
            rawData: results.polymarket,
            calculationEnvelope,
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
            actualProfit: canonicalNetPnl,
            calculationEnvelope,
          },
          // The legacy column is NOT NULL. Persist a compatibility zero only in
          // that column; consumers must authorize P&L from calculationEnvelope.
          estimatedProfit: canonicalNetPnl ?? 0,
          calculationEnvelope: { ...calculationEnvelope, scope: 'execution' },
        }).catch(e => logger.warn('[positions] persistExecution failed', { error: String(e) }));
      } catch {
        // non-fatal
      }
    }

    return NextResponse.json({
      success,
      partialFill,
      results,
      calculationEnvelope,
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
  return positions.map((p) => {
    const size = Math.abs(p.position);
    const entryPrice = p.totalCost / Math.max(size, 1);
    const currentPrice = p.position > 0 ? p.currentYesBid : p.currentNoBid;
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
      feesPaid: null,
      netUnrealizedPnl: null,
      netRoiPct: null,
      exitFees: null,
      reportedFeesPaidCents: p.reportedFeesPaidCents,
      pairId: null,
    };
  });
}

async function fetchPmPositions(): Promise<PmPositionDto[]> {
  const { getPolymarketPositions } = await import('@/lib/polymarket-positions');
  const positions = await getPolymarketPositions();
  return positions.map(p => {

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
      feesPaid: null,
      netCashPnl: null,
      netPercentPnl: null,
      exitFees: null,
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
  return { legA, legB, totalGrossPnl, totalFees: null, totalNetPnl: null, totalRoiPct: null };
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
        totalRoiPct: (k.totalCost + p.initialValue) > 0
          ? ((k.unrealizedPnl + p.cashPnl) / (k.totalCost + p.initialValue)) * 100 : 0,
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
        totalRoiPct: k.totalCost > 0 ? (k.unrealizedPnl / k.totalCost) * 100 : 0,
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
      totalRoiPct: p.initialValue > 0 ? (p.cashPnl / p.initialValue) * 100 : 0,
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