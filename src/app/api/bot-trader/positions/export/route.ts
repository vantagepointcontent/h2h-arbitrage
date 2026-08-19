import { NextRequest, NextResponse } from 'next/server';
import { getBotPositionAnalytics } from '@/lib/bot-positions';
import { buildBotLegIdentity, exportBotPositionIdentitiesCsv } from '@/lib/bot-leg-identity';
import { DASHBOARD_RANGES, type DashboardRange } from '@/lib/dashboard-request';
import { clientSafeError } from '@/lib/error-handler';
import { enrichBotPositionsWithPersistedIndicativeValuation } from '@/lib/bot-indicative-valuation';
import { enrichBotPositionsWithSettlementLedger } from '@/lib/bot-settlement-store';

function buyPriceMicrocents(position: Awaited<ReturnType<typeof getBotPositionAnalytics>>['positions'][number]): number | null {
  if (Number.isSafeInteger(position.kalshiEntryGrossMicrocents) && position.kalshiEntryGrossMicrocents! >= 0
    && Number.isSafeInteger(position.pmEntryGrossMicrocents) && position.pmEntryGrossMicrocents! >= 0) {
    const total = position.kalshiEntryGrossMicrocents! + position.pmEntryGrossMicrocents!;
    return Number.isSafeInteger(total) ? total : null;
  }
  const totalCents = position.buyPriceKalshiCents + position.buyPricePmCents;
  return Number.isSafeInteger(totalCents) && totalCents >= 0 ? totalCents * 1_000_000 : null;
}

function buyCostMicrocents(position: Awaited<ReturnType<typeof getBotPositionAnalytics>>['positions'][number]): number | null {
  if (position.entryCostStatus !== 'available') return null;
  if (Number.isSafeInteger(position.totalCostMicrousd) && position.totalCostMicrousd! >= 0) {
    const total = position.totalCostMicrousd! * 100;
    return Number.isSafeInteger(total) ? total : null;
  }
  return Number.isSafeInteger(position.totalCostCents) && position.totalCostCents >= 0
    ? position.totalCostCents * 1_000_000 : null;
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const method = request.nextUrl.searchParams.get('method') ?? 'all';
    const mode = request.nextUrl.searchParams.get('mode') ?? 'all';
    const range = request.nextUrl.searchParams.get('range') ?? '30d';
    if (!['all', 'roi', 'apy', 'hybrid', 'legacy'].includes(method)
      || !['all', 'paper', 'production'].includes(mode)
      || !DASHBOARD_RANGES.includes(range as DashboardRange)) {
      return NextResponse.json({ success: false, error: 'Invalid export filter' }, { status: 400 });
    }
    const analytics = await getBotPositionAnalytics({
      method: method as 'all' | 'roi' | 'apy' | 'hybrid' | 'legacy',
      mode: mode as 'all' | 'paper' | 'production',
      range: range as DashboardRange,
    });
    const indicativePositions = await enrichBotPositionsWithPersistedIndicativeValuation(analytics.positions ?? []);
    const positions = await enrichBotPositionsWithSettlementLedger(indicativePositions);
    const csv = exportBotPositionIdentitiesCsv(positions.map((position) => ({
      id: position.id,
      executionId: position.executionId,
      kalshiTicker: position.kalshiTicker,
      pmConditionId: position.pmConditionId,
      pmEntryTokenId: position.pmEntryTokenId,
      identity: buildBotLegIdentity({
        ...position,
        relationshipState: position.outcomeIdentityStatus === 'verified'
          && position.propositionRelationshipState === 'verified_complementary'
          ? 'verified_complementary'
          : position.propositionRelationshipState != null
            && position.propositionRelationshipState !== 'unknown'
            ? 'invalid' : 'legacy_unknown',
        relationshipExplanation: position.outcomeIdentityFailureReason,
      }, null),
      buyPriceMicrocents: buyPriceMicrocents(position),
      buyCostMicrocents: buyCostMicrocents(position),
      indicativeValueMicrocents: position.indicativeValueMicrocents,
      indicativePnlMicrocents: position.indicativePnlMicrocents,
      unrealizedRoiBps: position.unrealizedRoiBps,
      valuationStatus: position.valuationStatus,
      valuationFailureReason: position.valuationFailureReason,
      lastValuationAt: position.lastValuationAt,
      settlementState: position.settlementState,
      settlementGrossProceedsCents: position.settlementGrossProceedsCents,
      settlementNetProceedsCents: position.settlementNetProceedsCents,
      settlementFailureReason: position.settlementFailureReason,
      settlementCashAvailableAt: position.settlementCashAvailableAt,
      realizedPnlCents: position.realizedPnlCents,
      realizedRoiBps: position.realizedRoiBps,
      currentPriceSnapshots: position.currentPriceSnapshots,
    })));
    return new NextResponse(csv, {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': 'attachment; filename="bot-position-identities.csv"',
        'Cache-Control': 'no-store, no-cache, must-revalidate',
      },
    });
  } catch (error) {
    return NextResponse.json({ success: false, error: clientSafeError(error) }, { status: 500 });
  }
}
