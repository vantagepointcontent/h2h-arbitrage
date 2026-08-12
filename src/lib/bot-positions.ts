import path from 'node:path';
import { createClient, type Client } from '@libsql/client';
import { calcKalshiFee, calcPolymarketFee, getPolymarketTheta } from './matcher';
import { normalizeKalshiResolution } from './settlement-resolution';

export type BotPositionStatus = 'open' | 'settled' | 'closed';
export type BotPositionSide = 'yes' | 'no';
export type SettlementSide = 'kalshi' | 'pm' | null;
export type BotSelectionMethod = 'roi' | 'apy' | 'hybrid';

export interface AuthoritativeBotFeeConfig {
  kalshi: {
    feeType: 'quadratic';
    feeMultiplierPpm: number;
    source: string;
    observedAt: string;
    version: string;
  };
  polymarket: {
    tokenId: string;
    feeRateBps: number;
    source: string;
    observedAt: string;
    version: string;
  };
  pmTheta: number;
}

export interface BotPosition {
  id: number;
  executionId: number;
  marketId: string | null;
  marketTitle: string;
  kalshiTicker: string | null;
  pmConditionId: string | null;
  strategy: string | null;
  kalshiSide: BotPositionSide;
  pmSide: BotPositionSide;
  buyPriceKalshiCents: number;
  buyPricePmCents: number;
  sharesKalshi: number;
  sharesPm: number;
  remainingSharesKalshi: number;
  remainingSharesPm: number;
  remainingOpenPrincipalCents: number;
  remainingOpenFeesCents: number;
  remainingOpenCostCents: number;
  totalCostCents: number;
  expectedPayoutCents: number;
  expectedProfitCents: number;
  /** Immutable placement-time snapshots. Null marks a legacy execution. */
  expectedRoiBps: number | null;
  expectedApyBps: number | null;
  unitId: string | null;
  feesCents: number;
  category: string | null;
  pmTheta: number | null;
  kalshiEntryFeeCents: number;
  pmEntryFeeCents: number;
  status: BotPositionStatus;
  openedAt: string;
  expiryDate: string | null;
  settledAt: string | null;
  closedAt: string | null;
  currentPriceKalshiCents: number | null;
  currentPricePmCents: number | null;
  currentValueCents: number | null;
  unrealizedPnlCents: number | null;
  unrealizedRoiBps: number | null;
  lastValuationAt: string | null;
  valuationStatus: 'current' | 'stale' | 'unavailable';
  valuationFailureReason: string | null;
  valuationFailureAt: string | null;
  kalshiValuationDepth: number | null;
  pmValuationDepth: number | null;
  kalshiExitFeeCents: number | null;
  pmExitFeeCents: number | null;
  kalshiLiquidationValueCents: number | null;
  pmLiquidationValueCents: number | null;
  kalshiQuoteTimestamp: string | null;
  pmQuoteTimestamp: string | null;
  kalshiQuoteSource: string | null;
  pmQuoteSource: string | null;
  realizedPnlCents: number | null;
  settlementSide: SettlementSide;
  dryRun: boolean;
  selectionMethod?: BotSelectionMethod | null;
  resolutionSource?: string | null;
  resolutionVerifiedAt?: string | null;
  resolutionOutcome?: BotPositionSide | null;
  resolutionPayoutCents?: number | null;
  resolutionValidationStatus?: 'pending' | 'verified' | 'invalid';
}

export type CreateBotPosition = Omit<BotPosition,
  'id' | 'status' | 'settledAt' | 'currentPriceKalshiCents' |
  'currentPricePmCents' | 'currentValueCents' | 'unrealizedPnlCents' |
  'unrealizedRoiBps' | 'lastValuationAt' | 'realizedPnlCents' |
  'settlementSide' | 'dryRun' | 'remainingSharesKalshi' | 'remainingSharesPm' |
  'remainingOpenPrincipalCents' | 'remainingOpenFeesCents' | 'remainingOpenCostCents' |
  'closedAt' | 'valuationStatus' | 'valuationFailureReason' | 'valuationFailureAt' |
  'kalshiValuationDepth' | 'pmValuationDepth' | 'kalshiExitFeeCents' | 'pmExitFeeCents' |
  'kalshiLiquidationValueCents' | 'pmLiquidationValueCents' |
  'kalshiQuoteTimestamp' | 'pmQuoteTimestamp' | 'kalshiQuoteSource' | 'pmQuoteSource'
>;

export type BotExecutionStatus = 'open' | 'partially_closed' | 'closed' | 'settled';

export interface BotExecutionLeg {
  venue: 'kalshi' | 'polymarket';
  marketRef: string | null;
  side: BotPositionSide;
  executionPriceCents: number;
  originalQuantity: number;
  originalPrincipalCents: number;
  entryFeeCents: number;
  remainingOpenQuantity: number;
  remainingOpenPrincipalCents: number;
  remainingOpenFeeCents: number;
  currentExecutablePriceCents: number | null;
  currentLiquidationValueCents: number | null;
  executableDepthUsed: number | null;
  exitFeeCents: number | null;
  quoteTimestamp: string | null;
  quoteSource: string | null;
}

export type BotExecution = Omit<BotPosition, 'status'> & {
  status: BotExecutionStatus;
  entryId: number;
  executedAt: string;
  mode: 'paper' | 'production';
  executionStatus: BotExecutionStatus;
  executionPrincipalCents: number;
  executionFeesCents: number;
  executionBuyCostCents: number;
  legs: BotExecutionLeg[];
};

export interface BotPositionMarket {
  marketKey: string;
  marketId: string | null;
  marketTitle: string;
  kalshiTicker: string | null;
  pmConditionId: string | null;
  currentLiveStakeCents: number;
  liveStakeCents: number;
  currentValueCents: number | null;
  unrealizedPnlCents: number | null;
  valuedExecutionCount: number;
  unavailableExecutionCount: number;
  staleExecutionCount: number;
  oldestStaleValuationAt: string | null;
  valuedLiveStakeCents: number;
  realizedPnlCents: number;
  totalPnlCents: number;
  status: 'open' | 'closed' | 'settled';
  latestExecutionAt: string;
  latestOpenedAt: string;
  executions: BotExecution[];
  entries: BotExecution[];
}

export interface PositionQuote {
  kalshiYesBidCents: number | null;
  kalshiNoBidCents: number | null;
  pmYesBidCents: number | null;
  pmNoBidCents: number | null;
  kalshiHeldBidLevels?: ExecutableBidLevel[];
  pmHeldBidLevels?: ExecutableBidLevel[];
  observedAt: string;
  expiryDate: string | null;
  kalshiResolved?: boolean;
  pmResolved?: boolean;
}

export interface ExecutableBidLevel { priceCents: number; quantity: number }
export interface KalshiBidLevels {
  yesBidLevels: ExecutableBidLevel[];
  noBidLevels: ExecutableBidLevel[];
}
export interface LegValuationSnapshot {
  executablePriceCents: number;
  executableDepthUsed: number;
  grossProceedsCents: number;
  exitFeeCents: number;
  netProceedsCents: number;
  quoteTimestamp: string;
  source: 'kalshi_orderbook' | 'polymarket_clob_book';
}

export interface PositionValuation {
  status: 'open' | 'settled';
  currentPriceKalshiCents: number;
  currentPricePmCents: number;
  currentValueCents: number;
  unrealizedPnlCents: number;
  unrealizedRoiBps: number;
  lastValuationAt: string;
  settledAt: string | null;
  realizedPnlCents: number | null;
  settlementSide: SettlementSide;
  legs: { kalshi: LegValuationSnapshot; polymarket: LegValuationSnapshot };
}

interface KalshiSettlementMarket {
  status?: string;
  settlement_value_dollars?: string;
  yes_bid_dollars?: string;
  no_bid_dollars?: string;
}

/** Return authoritative binary settlement prices, independent of empty books. */
export function getKalshiResolvedPrices(market: KalshiSettlementMarket): {
  yesBidCents: number | null;
  noBidCents: number | null;
  resolved: boolean;
} {
  const resolution = normalizeKalshiResolution(market);
  return resolution.verified
    ? { yesBidCents: resolution.yesPayoutCents, noBidCents: resolution.noPayoutCents, resolved: true }
    : { yesBidCents: null, noBidCents: null, resolved: false };
}

function isPriceCents(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 0 && Number(value) <= 100;
}

function assertMoneyCents(name: string, value: number): void {
  if (!Number.isSafeInteger(value)) throw new Error(`${name} must be integer cents`);
}

function assertShares(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer contract count`);
}

function roiBps(pnlCents: number, costCents: number): number {
  if (costCents <= 0) return 0;
  return Math.round((pnlCents * 10_000) / costCents);
}

export function calculatePositionValuation(
  position: BotPosition,
  quote: PositionQuote,
): PositionValuation {
  const kalshiPrice = position.kalshiSide === 'yes'
    ? quote.kalshiYesBidCents
    : quote.kalshiNoBidCents;
  const pmPrice = position.pmSide === 'yes'
    ? quote.pmYesBidCents
    : quote.pmNoBidCents;

  if (!isPriceCents(kalshiPrice) || !isPriceCents(pmPrice)) {
    throw new Error(`Missing executable bid for bot position ${position.id}`);
  }

  if (position.pmTheta == null || !Number.isFinite(position.pmTheta)) {
    throw new Error(`Missing authoritative Polymarket theta for bot position ${position.id}`);
  }

  const liquidate = (venue: 'Kalshi' | 'Polymarket', quantity: number, price: number, levels?: ExecutableBidLevel[]): LegValuationSnapshot => {
    let remaining = quantity;
    let gross = 0;
    let fee = 0;
    let kalshiFeeNumerator = 0;
    for (const level of [...(levels ?? [{ priceCents: price, quantity }])].sort((a, b) => b.priceCents - a.priceCents)) {
      if (!isPriceCents(level.priceCents) || !Number.isFinite(level.quantity) || level.quantity <= 0) continue;
      const fill = Math.min(remaining, level.quantity);
      gross += fill * level.priceCents;
      if (venue === 'Kalshi') {
        kalshiFeeNumerator += 7 * fill * level.priceCents * (100 - level.priceCents);
      } else {
        fee += calcPolymarketFee(fill, level.priceCents / 100, position.pmTheta as number) * 100;
      }
      remaining -= fill;
      if (remaining <= 1e-9) break;
    }
    if (remaining > 1e-9) {
      const available = Math.max(0, quantity - remaining);
      throw new Error(`Insufficient ${venue} executable depth for bot position ${position.id}: available ${available}, required ${quantity}, shortfall ${remaining}`);
    }
    const grossProceedsCents = Math.round(gross);
    const exitFeeCents = venue === 'Kalshi'
      ? Math.ceil(kalshiFeeNumerator / 10_000 - 1e-9)
      : Math.round(fee);
    return { executablePriceCents: price, executableDepthUsed: quantity, grossProceedsCents, exitFeeCents,
      netProceedsCents: grossProceedsCents - exitFeeCents, quoteTimestamp: quote.observedAt,
      source: venue === 'Kalshi' ? 'kalshi_orderbook' : 'polymarket_clob_book' };
  };
  const kalshiLeg = liquidate('Kalshi', position.remainingSharesKalshi, kalshiPrice, quote.kalshiHeldBidLevels);
  const pmLeg = liquidate('Polymarket', position.remainingSharesPm, pmPrice, quote.pmHeldBidLevels);
  const currentValueCents = kalshiLeg.netProceedsCents + pmLeg.netProceedsCents;
  const unrealizedPnlCents = currentValueCents - position.remainingOpenCostCents;
  const base: PositionValuation = {
    status: 'open',
    currentPriceKalshiCents: kalshiPrice,
    currentPricePmCents: pmPrice,
    currentValueCents,
    unrealizedPnlCents,
    unrealizedRoiBps: roiBps(unrealizedPnlCents, position.remainingOpenCostCents),
    lastValuationAt: quote.observedAt,
    settledAt: null,
    realizedPnlCents: position.realizedPnlCents,
    settlementSide: null,
    legs: { kalshi: kalshiLeg, polymarket: pmLeg },
  };

  const expiryMs = quote.expiryDate ? Date.parse(quote.expiryDate) : Number.NaN;
  const observedMs = Date.parse(quote.observedAt);
  const expired = Number.isFinite(expiryMs) && Number.isFinite(observedMs) && expiryMs < observedMs;
  const resolvedComplement =
    (kalshiPrice === 100 && pmPrice === 0) ||
    (kalshiPrice === 0 && pmPrice === 100);

  if (!expired || !quote.kalshiResolved || !quote.pmResolved || !resolvedComplement) return base;

  const payoutCents = kalshiPrice === 100
    ? position.remainingSharesKalshi * 100
    : position.remainingSharesPm * 100;
  const settlementPnlCents = payoutCents - position.remainingOpenCostCents;
  return {
    ...base,
    status: 'settled',
    currentValueCents: payoutCents,
    unrealizedPnlCents: settlementPnlCents,
    unrealizedRoiBps: roiBps(settlementPnlCents, position.remainingOpenCostCents),
    settledAt: quote.observedAt,
    realizedPnlCents: (position.realizedPnlCents ?? 0) + settlementPnlCents,
    settlementSide: kalshiPrice === 100 ? 'kalshi' : 'pm',
    legs: base.legs,
  };
}

function rowToPosition(row: Record<string, unknown>): BotPosition {
  const status = String(row.status) as BotPositionStatus;
  const sharesKalshi = Number(row.shares_kalshi);
  const sharesPm = Number(row.shares_pm);
  const totalCostCents = Number(row.total_cost);
  const feesCents = Number(row.fees ?? 0);
  const storedKalshiFee = Number(row.kalshi_entry_fee ?? 0);
  const storedPmFee = Number(row.pm_entry_fee ?? 0);
  const executionPrincipal = Number(row.buy_price_kalshi) * sharesKalshi + Number(row.buy_price_pm) * sharesPm;
  const kalshiEntryFeeCents = storedKalshiFee + storedPmFee === feesCents
    ? storedKalshiFee
    : (executionPrincipal === 0 ? 0 : Math.round(feesCents * Number(row.buy_price_kalshi) * sharesKalshi / executionPrincipal));
  const pmEntryFeeCents = storedKalshiFee + storedPmFee === feesCents
    ? storedPmFee
    : feesCents - kalshiEntryFeeCents;
  const isOpen = status === 'open';
  return {
    id: Number(row.id),
    executionId: Number(row.execution_id ?? row.id),
    marketId: row.market_id != null ? String(row.market_id) : null,
    marketTitle: String(row.market_title),
    kalshiTicker: row.kalshi_ticker != null ? String(row.kalshi_ticker) : null,
    pmConditionId: row.pm_condition_id != null ? String(row.pm_condition_id) : null,
    strategy: row.strategy != null ? String(row.strategy) : null,
    kalshiSide: String(row.kalshi_side) as BotPositionSide,
    pmSide: String(row.pm_side) as BotPositionSide,
    buyPriceKalshiCents: Number(row.buy_price_kalshi),
    buyPricePmCents: Number(row.buy_price_pm),
    sharesKalshi,
    sharesPm,
    remainingSharesKalshi: row.live_shares_kalshi != null ? Number(row.live_shares_kalshi) : (isOpen ? sharesKalshi : 0),
    remainingSharesPm: row.live_shares_pm != null ? Number(row.live_shares_pm) : (isOpen ? sharesPm : 0),
    remainingOpenPrincipalCents: row.live_principal != null ? Number(row.live_principal) : (isOpen ? Math.max(0, totalCostCents - feesCents) : 0),
    remainingOpenFeesCents: row.live_fees != null ? Number(row.live_fees) : (isOpen ? feesCents : 0),
    remainingOpenCostCents: row.live_cost != null ? Number(row.live_cost) : (isOpen ? totalCostCents : 0),
    totalCostCents,
    expectedPayoutCents: Number(row.expected_payout),
    expectedProfitCents: Number(row.expected_profit),
    expectedRoiBps: row.expected_roi_bps != null ? Number(row.expected_roi_bps) : null,
    expectedApyBps: row.expected_apy_bps != null ? Number(row.expected_apy_bps) : null,
    unitId: row.unit_id != null ? String(row.unit_id) : null,
    feesCents,
    category: row.category != null ? String(row.category) : null,
    pmTheta: row.pm_theta != null ? Number(row.pm_theta) : null,
    kalshiEntryFeeCents,
    pmEntryFeeCents,
    status,
    openedAt: String(row.opened_at),
    expiryDate: row.expiry_date != null ? String(row.expiry_date) : null,
    settledAt: row.settled_at != null ? String(row.settled_at) : null,
    closedAt: row.closed_at != null ? String(row.closed_at) : null,
    currentPriceKalshiCents: row.current_price_kalshi != null ? Number(row.current_price_kalshi) : null,
    currentPricePmCents: row.current_price_pm != null ? Number(row.current_price_pm) : null,
    currentValueCents: row.current_value != null ? Number(row.current_value) : null,
    unrealizedPnlCents: row.unrealized_pnl != null ? Number(row.unrealized_pnl) : null,
    unrealizedRoiBps: row.unrealized_roi_pct != null ? Number(row.unrealized_roi_pct) : null,
    lastValuationAt: row.last_valuation_at != null ? String(row.last_valuation_at) : null,
    valuationStatus: row.current_value != null && row.current_price_kalshi != null && row.current_price_pm != null
      ? (row.valuation_failure_reason != null ? 'stale' : 'current') : 'unavailable',
    valuationFailureReason: row.valuation_failure_reason != null ? String(row.valuation_failure_reason) : null,
    valuationFailureAt: row.valuation_failure_at != null ? String(row.valuation_failure_at) : null,
    kalshiValuationDepth: row.kalshi_valuation_depth != null ? Number(row.kalshi_valuation_depth) : null,
    pmValuationDepth: row.pm_valuation_depth != null ? Number(row.pm_valuation_depth) : null,
    kalshiExitFeeCents: row.kalshi_exit_fee != null ? Number(row.kalshi_exit_fee) : null,
    pmExitFeeCents: row.pm_exit_fee != null ? Number(row.pm_exit_fee) : null,
    kalshiLiquidationValueCents: row.kalshi_liquidation_value != null ? Number(row.kalshi_liquidation_value) : null,
    pmLiquidationValueCents: row.pm_liquidation_value != null ? Number(row.pm_liquidation_value) : null,
    kalshiQuoteTimestamp: row.kalshi_quote_timestamp != null ? String(row.kalshi_quote_timestamp) : null,
    pmQuoteTimestamp: row.pm_quote_timestamp != null ? String(row.pm_quote_timestamp) : null,
    kalshiQuoteSource: row.kalshi_quote_source != null ? String(row.kalshi_quote_source) : null,
    pmQuoteSource: row.pm_quote_source != null ? String(row.pm_quote_source) : null,
    realizedPnlCents: row.realized_pnl != null ? Number(row.realized_pnl) : null,
    settlementSide: row.settlement_side != null ? String(row.settlement_side) as SettlementSide : null,
    dryRun: Boolean(Number(row.dry_run ?? 1)),
    selectionMethod: row.selection_method != null ? String(row.selection_method) as BotSelectionMethod : null,
    resolutionSource: row.resolution_source != null ? String(row.resolution_source) : null,
    resolutionVerifiedAt: row.resolution_verified_at != null ? String(row.resolution_verified_at) : null,
    resolutionOutcome: row.resolution_outcome != null ? String(row.resolution_outcome) as BotPositionSide : null,
    resolutionPayoutCents: row.resolution_payout != null ? Number(row.resolution_payout) : null,
    resolutionValidationStatus: (row.resolution_validation_status != null ? String(row.resolution_validation_status) : 'pending') as 'pending' | 'verified' | 'invalid',
  };
}

function prorateCents(originalCents: number, remaining: number, original: number): number {
  if (remaining === 0) return 0;
  return Math.round((originalCents * remaining) / original);
}

function executionStatus(position: BotPosition): BotExecutionStatus {
  if (position.status === 'settled') return 'settled';
  if (position.remainingSharesKalshi === 0 && position.remainingSharesPm === 0) return 'closed';
  if (position.remainingSharesKalshi < position.sharesKalshi || position.remainingSharesPm < position.sharesPm) {
    return 'partially_closed';
  }
  return 'open';
}

function marketKey(position: BotPosition): string {
  const canonicalMarketId = position.marketId?.trim().toLowerCase();
  if (canonicalMarketId) return `market:${canonicalMarketId}`;
  const kalshiTicker = position.kalshiTicker?.trim().toLowerCase();
  const pmConditionId = position.pmConditionId?.trim().toLowerCase();
  if (kalshiTicker && pmConditionId) return `pair:${kalshiTicker}:${pmConditionId}`;
  return `legacy-execution:${position.executionId}`;
}

function toExecution(position: BotPosition): BotExecution {
  const kalshiPrincipal = position.buyPriceKalshiCents * position.sharesKalshi;
  const pmPrincipal = position.buyPricePmCents * position.sharesPm;
  const status = executionStatus(position);
  const leg = (
    venue: 'kalshi' | 'polymarket',
    marketRef: string | null,
    side: BotPositionSide,
    price: number,
    originalQuantity: number,
    entryFeeCents: number,
    remainingQuantity: number,
    currentPrice: number | null,
  ): BotExecutionLeg => {
    const originalPrincipalCents = price * originalQuantity;
    const remainingOpenPrincipalCents = prorateCents(originalPrincipalCents, remainingQuantity, originalQuantity);
    const remainingOpenFeeCents = prorateCents(entryFeeCents, remainingQuantity, originalQuantity);
    const calculatedLiquidationValueCents = (() => {
      if (remainingQuantity === 0) return 0;
      if (currentPrice == null) return null;
      if (venue === 'polymarket' && (position.pmTheta == null || !Number.isFinite(position.pmTheta))) return null;
      const exitFeeCents = venue === 'kalshi'
        ? Math.round(calcKalshiFee(remainingQuantity, currentPrice / 100) * 100)
        : Math.round(calcPolymarketFee(remainingQuantity, currentPrice / 100, position.pmTheta as number) * 100);
      return currentPrice * remainingQuantity - exitFeeCents;
    })();
    const currentLiquidationValueCents = venue === 'kalshi'
      ? position.kalshiLiquidationValueCents ?? calculatedLiquidationValueCents
      : position.pmLiquidationValueCents ?? calculatedLiquidationValueCents;
    return {
      venue, marketRef, side, executionPriceCents: price, originalQuantity,
      originalPrincipalCents, entryFeeCents, remainingOpenQuantity: remainingQuantity,
      remainingOpenPrincipalCents, remainingOpenFeeCents,
      currentExecutablePriceCents: currentPrice,
      currentLiquidationValueCents,
      executableDepthUsed: venue === 'kalshi' ? position.kalshiValuationDepth : position.pmValuationDepth,
      exitFeeCents: venue === 'kalshi' ? position.kalshiExitFeeCents : position.pmExitFeeCents,
      quoteTimestamp: venue === 'kalshi' ? position.kalshiQuoteTimestamp : position.pmQuoteTimestamp,
      quoteSource: venue === 'kalshi' ? position.kalshiQuoteSource : position.pmQuoteSource,
    };
  };
  const legs = [
    leg('kalshi', position.kalshiTicker, position.kalshiSide, position.buyPriceKalshiCents,
      position.sharesKalshi, position.kalshiEntryFeeCents, position.remainingSharesKalshi,
      position.currentPriceKalshiCents),
    leg('polymarket', position.pmConditionId, position.pmSide, position.buyPricePmCents,
      position.sharesPm, position.pmEntryFeeCents, position.remainingSharesPm,
      position.currentPricePmCents),
  ];
  return {
    ...position,
    status,
    entryId: position.id,
    executedAt: position.openedAt,
    mode: position.dryRun ? 'paper' : 'production',
    executionStatus: status,
    executionPrincipalCents: kalshiPrincipal + pmPrincipal,
    executionFeesCents: position.feesCents,
    executionBuyCostCents: position.totalCostCents,
    currentValueCents: status === 'closed' || status === 'settled' ? 0 : position.currentValueCents,
    unrealizedPnlCents: status === 'closed' || status === 'settled' ? 0 : position.unrealizedPnlCents,
    legs,
  };
}

function groupPositions(rows: BotPosition[]): BotPositionMarket[] {
  const grouped = new Map<string, BotPosition[]>();
  for (const row of rows) {
    const key = marketKey(row);
    grouped.set(key, [...(grouped.get(key) ?? []), row]);
  }
  return [...grouped.entries()].map(([key, positions]) => {
    positions.sort((a, b) => b.openedAt.localeCompare(a.openedAt) || b.executionId - a.executionId || b.id - a.id);
    const executions = positions.map(toExecution);
    const latest = positions[0];
    const currentLiveStakeCents = executions.reduce((sum, item) => sum + item.remainingOpenCostCents, 0);
    const valued = executions.filter((item) => (item.status === 'open' || item.status === 'partially_closed') && item.currentValueCents != null && item.unrealizedPnlCents != null);
    const unavailableExecutionCount = executions.filter((item) => (item.status === 'open' || item.status === 'partially_closed') && item.currentValueCents == null).length;
    const stale = valued.filter((item) => item.valuationStatus === 'stale');
    const oldestStaleValuationAt = stale.reduce<string | null>((oldest, item) =>
      item.lastValuationAt != null && (oldest == null || item.lastValuationAt < oldest) ? item.lastValuationAt : oldest, null);
    const valuedLiveStakeCents = valued.reduce((sum, item) => sum + item.remainingOpenCostCents, 0);
    const currentValueCents = valued.length ? valued.reduce((sum, item) => sum + (item.currentValueCents as number), 0) : null;
    const realizedPnlCents = executions.reduce((sum, item) => sum + (item.realizedPnlCents ?? 0), 0);
    const anyOpen = executions.some((item) => item.status === 'open' || item.status === 'partially_closed');
    const allSettled = executions.every((item) => item.status === 'settled');
    const status: BotPositionMarket['status'] = anyOpen ? 'open' : (allSettled ? 'settled' : 'closed');
    const unrealizedPnlCents = valued.length
      ? valued.reduce((sum, item) => sum + (item.unrealizedPnlCents as number), 0)
      : null;
    return {
      marketKey: key,
      marketId: latest.marketId,
      marketTitle: latest.marketTitle,
      kalshiTicker: latest.kalshiTicker,
      pmConditionId: latest.pmConditionId,
      currentLiveStakeCents,
      liveStakeCents: currentLiveStakeCents,
      currentValueCents,
      unrealizedPnlCents,
      valuedExecutionCount: valued.length,
      unavailableExecutionCount,
      staleExecutionCount: stale.length,
      oldestStaleValuationAt,
      valuedLiveStakeCents,
      realizedPnlCents,
      totalPnlCents: realizedPnlCents + (unrealizedPnlCents ?? 0),
      status,
      latestExecutionAt: latest.openedAt,
      latestOpenedAt: latest.openedAt,
      executions,
      entries: executions,
    };
  }).sort((a, b) => b.latestExecutionAt.localeCompare(a.latestExecutionAt) || a.marketKey.localeCompare(b.marketKey));
}

export class BotPositionStore {
  private readonly client: Client;
  private schemaReady: Promise<void> | null = null;

  constructor(dbUrl = `file:${path.join(process.cwd(), 'data', 'edgefinder.db')}`) {
    this.client = createClient({ url: dbUrl });
  }

  private ensureSchema(): Promise<void> {
    if (!this.schemaReady) this.schemaReady = this.createSchema();
    return this.schemaReady;
  }

  private async createSchema(): Promise<void> {
    await this.client.execute('PRAGMA busy_timeout = 5000');
    await this.client.execute('PRAGMA foreign_keys = ON');
    await this.client.execute(`
      CREATE TABLE IF NOT EXISTS bot_positions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        execution_id INTEGER NOT NULL REFERENCES executions(id),
        market_id TEXT,
        market_title TEXT NOT NULL,
        kalshi_ticker TEXT,
        pm_condition_id TEXT,
        strategy TEXT,
        kalshi_side TEXT NOT NULL CHECK (kalshi_side IN ('yes', 'no')),
        pm_side TEXT NOT NULL CHECK (pm_side IN ('yes', 'no')),
        buy_price_kalshi INTEGER NOT NULL,
        buy_price_pm INTEGER NOT NULL,
        shares_kalshi INTEGER NOT NULL,
        shares_pm INTEGER NOT NULL,
        live_shares_kalshi INTEGER NOT NULL,
        live_shares_pm INTEGER NOT NULL,
        live_principal INTEGER NOT NULL,
        live_fees INTEGER NOT NULL,
        live_cost INTEGER NOT NULL,
        total_cost INTEGER NOT NULL,
        expected_payout INTEGER NOT NULL,
        expected_profit INTEGER NOT NULL,
        fees INTEGER NOT NULL DEFAULT 0,
        category TEXT,
        pm_theta REAL,
        kalshi_entry_fee INTEGER NOT NULL DEFAULT 0,
        pm_entry_fee INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'settled', 'closed')),
        opened_at TEXT NOT NULL,
        expiry_date TEXT,
        settled_at TEXT,
        closed_at TEXT,
        current_price_kalshi INTEGER,
        current_price_pm INTEGER,
        current_value INTEGER,
        unrealized_pnl INTEGER,
        unrealized_roi_pct INTEGER,
        last_valuation_at TEXT,
        realized_pnl INTEGER,
        settlement_side TEXT CHECK (settlement_side IN ('kalshi', 'pm') OR settlement_side IS NULL)
        ,selection_method TEXT CHECK (selection_method IN ('roi', 'apy', 'hybrid') OR selection_method IS NULL),
        resolution_source TEXT,
        resolution_verified_at TEXT,
        resolution_outcome TEXT CHECK (resolution_outcome IN ('yes', 'no') OR resolution_outcome IS NULL),
        resolution_payout INTEGER,
        resolution_validation_status TEXT NOT NULL DEFAULT 'pending',
        valuation_failure_reason TEXT,
        valuation_failure_at TEXT,
        kalshi_valuation_depth REAL,
        pm_valuation_depth REAL,
        kalshi_exit_fee INTEGER,
        pm_exit_fee INTEGER,
        kalshi_liquidation_value INTEGER,
        pm_liquidation_value INTEGER,
        kalshi_quote_timestamp TEXT,
        pm_quote_timestamp TEXT,
        kalshi_quote_source TEXT,
        pm_quote_source TEXT
      )
    `);
    // Idempotent migration for installations that created the table from an
    // earlier FEAT-043 draft. SQLite ignores no columns implicitly, so add each
    // missing column explicitly before creating indexes.
    const info = await this.client.execute('PRAGMA table_info(bot_positions)');
    const existing = new Set(info.rows.map((row) => String(row.name)));
    const migrations: Record<string, string> = {
      execution_id: 'INTEGER REFERENCES executions(id)',
      market_id: 'TEXT',
      market_title: "TEXT NOT NULL DEFAULT ''",
      kalshi_ticker: 'TEXT',
      pm_condition_id: 'TEXT',
      strategy: 'TEXT',
      kalshi_side: "TEXT NOT NULL DEFAULT 'yes'",
      pm_side: "TEXT NOT NULL DEFAULT 'no'",
      buy_price_kalshi: 'INTEGER NOT NULL DEFAULT 0',
      buy_price_pm: 'INTEGER NOT NULL DEFAULT 0',
      shares_kalshi: 'INTEGER NOT NULL DEFAULT 0',
      shares_pm: 'INTEGER NOT NULL DEFAULT 0',
      live_shares_kalshi: 'INTEGER',
      live_shares_pm: 'INTEGER',
      live_principal: 'INTEGER',
      live_fees: 'INTEGER',
      live_cost: 'INTEGER',
      total_cost: 'INTEGER NOT NULL DEFAULT 0',
      expected_payout: 'INTEGER NOT NULL DEFAULT 0',
      expected_profit: 'INTEGER NOT NULL DEFAULT 0',
      expected_roi_bps: 'INTEGER',
      expected_apy_bps: 'INTEGER',
      unit_id: 'TEXT',
      fees: 'INTEGER NOT NULL DEFAULT 0',
      category: 'TEXT',
      pm_theta: 'REAL',
      kalshi_entry_fee: 'INTEGER NOT NULL DEFAULT 0',
      pm_entry_fee: 'INTEGER NOT NULL DEFAULT 0',
      status: "TEXT NOT NULL DEFAULT 'open'",
      opened_at: "TEXT NOT NULL DEFAULT ''",
      expiry_date: 'TEXT',
      settled_at: 'TEXT',
      closed_at: 'TEXT',
      current_price_kalshi: 'INTEGER',
      current_price_pm: 'INTEGER',
      current_value: 'INTEGER',
      unrealized_pnl: 'INTEGER',
      unrealized_roi_pct: 'INTEGER',
      last_valuation_at: 'TEXT',
      realized_pnl: 'INTEGER',
      settlement_side: 'TEXT',
      selection_method: 'TEXT',
      resolution_source: 'TEXT',
      resolution_verified_at: 'TEXT',
      resolution_outcome: 'TEXT',
      resolution_payout: 'INTEGER',
      resolution_validation_status: "TEXT NOT NULL DEFAULT 'pending'",
      valuation_failure_reason: 'TEXT',
      valuation_failure_at: 'TEXT',
      kalshi_valuation_depth: 'REAL',
      pm_valuation_depth: 'REAL',
      kalshi_exit_fee: 'INTEGER',
      pm_exit_fee: 'INTEGER',
      kalshi_liquidation_value: 'INTEGER',
      pm_liquidation_value: 'INTEGER',
      kalshi_quote_timestamp: 'TEXT',
      pm_quote_timestamp: 'TEXT',
      kalshi_quote_source: 'TEXT',
      pm_quote_source: 'TEXT',
    };
    for (const [name, definition] of Object.entries(migrations)) {
      if (!existing.has(name)) {
        try {
          await this.client.execute(`ALTER TABLE bot_positions ADD COLUMN ${name} ${definition}`);
        } catch (error) {
          // Two store instances may initialize the same SQLite file concurrently.
          if (!String(error).includes('duplicate column name')) throw error;
        }
      }
    }
    await this.client.execute(`UPDATE bot_positions SET
      live_shares_kalshi = CASE WHEN status = 'open' THEN shares_kalshi ELSE 0 END,
      live_shares_pm = CASE WHEN status = 'open' THEN shares_pm ELSE 0 END,
      live_principal = CASE WHEN status = 'open' THEN MAX(0, total_cost - fees) ELSE 0 END,
      live_fees = CASE WHEN status = 'open' THEN fees ELSE 0 END,
      live_cost = CASE WHEN status = 'open' THEN total_cost ELSE 0 END
      WHERE live_shares_kalshi IS NULL OR live_shares_pm IS NULL
         OR live_principal IS NULL OR live_fees IS NULL OR live_cost IS NULL`);
    await this.client.execute(`UPDATE bot_positions
      SET expected_roi_bps = ROUND(expected_profit * 10000.0 / NULLIF(total_cost, 0))
      WHERE expected_roi_bps IS NULL AND total_cost > 0`);
    await this.client.execute(`UPDATE bot_positions
      SET expected_apy_bps = ROUND(expected_roi_bps * 365.0 / NULLIF((julianday(expiry_date) - julianday(opened_at)), 0))
      WHERE expected_apy_bps IS NULL AND expected_roi_bps IS NOT NULL
        AND expiry_date IS NOT NULL AND opened_at IS NOT NULL`);
    await this.client.execute(`UPDATE bot_positions
      SET unit_id = 'execution:' || execution_id
      WHERE unit_id IS NULL AND execution_id IS NOT NULL`);
    await this.client.execute(`
      CREATE TABLE IF NOT EXISTS bot_position_reservations (
        pair_key TEXT PRIMARY KEY,
        reserved_at TEXT NOT NULL,
        exposure_at_risk INTEGER NOT NULL DEFAULT 0
      )
    `);
    const reservationInfo = await this.client.execute('PRAGMA table_info(bot_position_reservations)');
    if (!reservationInfo.rows.some((row) => String(row.name) === 'exposure_at_risk')) {
      await this.client.execute(`ALTER TABLE bot_position_reservations ADD COLUMN exposure_at_risk INTEGER NOT NULL DEFAULT 0`);
    }
    await this.client.execute(`CREATE INDEX IF NOT EXISTS idx_bot_positions_status ON bot_positions(status, opened_at DESC)`);
    await this.client.execute(`DROP INDEX IF EXISTS idx_bot_positions_open_pair`);
    await this.client.execute(`DROP INDEX IF EXISTS idx_bot_positions_execution`);
    await this.client.execute(`CREATE INDEX IF NOT EXISTS idx_bot_positions_execution ON bot_positions(execution_id)`);
  }

  async create(input: CreateBotPosition): Promise<BotPosition> {
    await this.ensureSchema();
    assertShares('sharesKalshi', input.sharesKalshi);
    assertShares('sharesPm', input.sharesPm);
    for (const [name, value] of Object.entries({
      buyPriceKalshiCents: input.buyPriceKalshiCents,
      buyPricePmCents: input.buyPricePmCents,
      totalCostCents: input.totalCostCents,
      expectedPayoutCents: input.expectedPayoutCents,
      expectedProfitCents: input.expectedProfitCents,
      feesCents: input.feesCents,
      kalshiEntryFeeCents: input.kalshiEntryFeeCents,
      pmEntryFeeCents: input.pmEntryFeeCents,
    })) assertMoneyCents(name, value);
    if (!isPriceCents(input.buyPriceKalshiCents) || !isPriceCents(input.buyPricePmCents)) {
      throw new Error('Buy prices must be integer cents from 0 through 100');
    }
    const executionPrincipalCents = input.buyPriceKalshiCents * input.sharesKalshi
      + input.buyPricePmCents * input.sharesPm;
    if (input.kalshiEntryFeeCents + input.pmEntryFeeCents !== input.feesCents) {
      throw new Error('Entry fee components must equal aggregate entry fees');
    }
    if (executionPrincipalCents + input.feesCents !== input.totalCostCents) {
      throw new Error('Total cost must equal execution principal plus entry fees');
    }
    if (input.expectedProfitCents !== input.expectedPayoutCents - input.totalCostCents) {
      throw new Error('Expected profit must equal expected payout minus total cost');
    }

    const initialRoiBps = roiBps(input.expectedProfitCents, input.totalCostCents);
    let result;
    try {
      result = await this.client.execute({
        sql: `INSERT INTO bot_positions (
          execution_id, market_id, market_title, kalshi_ticker, pm_condition_id,
          strategy, kalshi_side, pm_side, buy_price_kalshi, buy_price_pm,
          shares_kalshi, shares_pm, live_shares_kalshi, live_shares_pm,
          live_principal, live_fees, live_cost, total_cost, expected_payout, expected_profit,
          expected_roi_bps, expected_apy_bps, unit_id,
          fees, category, pm_theta, kalshi_entry_fee, pm_entry_fee, status, opened_at, expiry_date, current_price_kalshi,
          current_price_pm, current_value, unrealized_pnl, unrealized_roi_pct,
          last_valuation_at, selection_method
        ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?, ?
          WHERE NOT EXISTS (SELECT 1 FROM bot_positions WHERE execution_id = ?)`,
        args: [
          input.executionId, input.marketId, input.marketTitle, input.kalshiTicker,
          input.pmConditionId, input.strategy, input.kalshiSide, input.pmSide,
          input.buyPriceKalshiCents, input.buyPricePmCents, input.sharesKalshi,
          input.sharesPm, input.sharesKalshi, input.sharesPm, executionPrincipalCents,
          input.feesCents, input.totalCostCents, input.totalCostCents, input.expectedPayoutCents,
          input.expectedProfitCents, input.expectedRoiBps ?? null, input.expectedApyBps ?? null, input.unitId ?? null,
          input.feesCents, input.category, input.pmTheta,
          input.kalshiEntryFeeCents, input.pmEntryFeeCents, input.openedAt,
          input.expiryDate, input.buyPriceKalshiCents, input.buyPricePmCents,
          input.expectedPayoutCents, input.expectedProfitCents, initialRoiBps,
          input.openedAt,
          input.selectionMethod ?? null,
          input.executionId,
        ],
      });
    } catch (error) {
      if (String(error).includes('UNIQUE constraint failed')) {
        throw new Error(`Bot execution ${input.executionId} already has a position record`);
      }
      throw error;
    }
    if (result.rowsAffected !== 1) throw new Error(`Bot execution ${input.executionId} already has a position record`);
    const id = Number(result.lastInsertRowid ?? 0);
    const created = await this.getById(id);
    if (!created) throw new Error('Created bot position could not be read back');
    return created;
  }

  async getById(id: number): Promise<BotPosition | null> {
    await this.ensureSchema();
    const result = await this.client.execute({
      sql: `SELECT bp.*, e.dry_run FROM bot_positions bp LEFT JOIN executions e ON e.id = bp.execution_id WHERE bp.id = ?`,
      args: [id],
    });
    return result.rows[0] ? rowToPosition(result.rows[0] as Record<string, unknown>) : null;
  }

  async hasOpenPair(kalshiTicker: string | null, pmConditionId: string | null): Promise<boolean> {
    await this.ensureSchema();
    if (!kalshiTicker || !pmConditionId) return false;
    const result = await this.client.execute({
      sql: `SELECT 1 FROM bot_positions WHERE status = 'open' AND lower(kalshi_ticker) = lower(?) AND lower(pm_condition_id) = lower(?) LIMIT 1`,
      args: [kalshiTicker, pmConditionId],
    });
    return result.rows.length > 0;
  }

  private pairKey(kalshiTicker: string, pmConditionId: string): string {
    return `${kalshiTicker.trim().toLowerCase()}\u0000${pmConditionId.trim().toLowerCase()}`;
  }

  async reservePair(kalshiTicker: string, pmConditionId: string, maxUnitsPerMarket = 1): Promise<boolean> {
    await this.ensureSchema();
    // Automatic live orders are hard-disabled; a 10-minute lease recovers paper
    // reservations after process crashes while remaining far longer than the
    // 15-second execution timeout.
    const staleBefore = new Date(Date.now() - 10 * 60_000).toISOString();
    await this.client.execute({
      sql: `DELETE FROM bot_position_reservations WHERE reserved_at < ? AND exposure_at_risk = 0`,
      args: [staleBefore],
    });
    const active = await this.client.execute({
      sql: `SELECT COUNT(*) AS count FROM bot_positions
        WHERE status = 'open' AND (live_shares_kalshi > 0 OR live_shares_pm > 0)
          AND lower(kalshi_ticker) = lower(?) AND lower(pm_condition_id) = lower(?)`,
      args: [kalshiTicker, pmConditionId],
    });
    if (Number(active.rows[0]?.count ?? 0) >= maxUnitsPerMarket) return false;
    try {
      await this.client.execute({
        sql: `INSERT INTO bot_position_reservations (pair_key, reserved_at) VALUES (?, ?)`,
        args: [this.pairKey(kalshiTicker, pmConditionId), new Date().toISOString()],
      });
      return true;
    } catch (error) {
      if (String(error).includes('UNIQUE constraint failed')) return false;
      throw error;
    }
  }

  async releasePair(kalshiTicker: string, pmConditionId: string): Promise<void> {
    await this.ensureSchema();
    await this.client.execute({
      sql: `DELETE FROM bot_position_reservations WHERE pair_key = ?`,
      args: [this.pairKey(kalshiTicker, pmConditionId)],
    });
  }

  async retainPairForExposure(kalshiTicker: string, pmConditionId: string): Promise<void> {
    await this.ensureSchema();
    await this.client.execute({
      sql: `UPDATE bot_position_reservations SET exposure_at_risk = 1 WHERE pair_key = ?`,
      args: [this.pairKey(kalshiTicker, pmConditionId)],
    });
  }

  static groupForAnalytics(rows: BotPosition[]): BotPositionMarket[] {
    return groupPositions(rows);
  }

  async reduceExposure(id: number, reduction: {
    expectedRemainingSharesKalshi: number;
    expectedRemainingSharesPm: number;
    expectedLastValuationAt: string | null;
    remainingSharesKalshi: number;
    remainingSharesPm: number;
    realizedPnlCents: number;
    observedAt: string;
  }): Promise<BotPosition> {
    await this.ensureSchema();
    const current = await this.getById(id);
    if (!current || current.status !== 'open') throw new Error(`Open bot position ${id} was not found`);
    for (const [name, value] of Object.entries({
      expectedRemainingSharesKalshi: reduction.expectedRemainingSharesKalshi,
      expectedRemainingSharesPm: reduction.expectedRemainingSharesPm,
      remainingSharesKalshi: reduction.remainingSharesKalshi,
      remainingSharesPm: reduction.remainingSharesPm,
    })) {
      if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer`);
    }
    assertMoneyCents('realizedPnlCents', reduction.realizedPnlCents);
    if (reduction.remainingSharesKalshi > reduction.expectedRemainingSharesKalshi
      || reduction.remainingSharesPm > reduction.expectedRemainingSharesPm) {
      throw new Error('Remaining exposure cannot increase');
    }
    if (reduction.remainingSharesKalshi > current.sharesKalshi
      || reduction.remainingSharesPm > current.sharesPm) {
      throw new Error('Remaining exposure cannot exceed original execution quantity');
    }
    if (reduction.expectedLastValuationAt !== current.lastValuationAt) {
      throw new Error('Bot position reduction lost compare-and-swap race');
    }

    const kalshiPrincipal = prorateCents(
      current.buyPriceKalshiCents * current.sharesKalshi,
      reduction.remainingSharesKalshi,
      current.sharesKalshi,
    );
    const pmPrincipal = prorateCents(
      current.buyPricePmCents * current.sharesPm,
      reduction.remainingSharesPm,
      current.sharesPm,
    );
    const kalshiFees = prorateCents(current.kalshiEntryFeeCents, reduction.remainingSharesKalshi, current.sharesKalshi);
    const pmFees = prorateCents(current.pmEntryFeeCents, reduction.remainingSharesPm, current.sharesPm);
    const livePrincipal = kalshiPrincipal + pmPrincipal;
    const liveFees = kalshiFees + pmFees;
    const liveCost = livePrincipal + liveFees;
    const fullyClosed = reduction.remainingSharesKalshi === 0 && reduction.remainingSharesPm === 0;
    let currentValue: number | null = fullyClosed ? 0 : null;
    if (!fullyClosed && isPriceCents(current.currentPriceKalshiCents)
      && isPriceCents(current.currentPricePmCents)
      && current.pmTheta != null && Number.isFinite(current.pmTheta)) {
      const kalshiExitFee = Math.round(calcKalshiFee(reduction.remainingSharesKalshi, current.currentPriceKalshiCents / 100) * 100);
      const pmExitFee = Math.round(calcPolymarketFee(reduction.remainingSharesPm, current.currentPricePmCents / 100, current.pmTheta) * 100);
      currentValue = current.currentPriceKalshiCents * reduction.remainingSharesKalshi
        + current.currentPricePmCents * reduction.remainingSharesPm - kalshiExitFee - pmExitFee;
    }
    const unrealizedPnl = currentValue == null ? null : currentValue - liveCost;
    const unrealizedRoi = unrealizedPnl == null ? null : roiBps(unrealizedPnl, liveCost);
    const expectedValuation = reduction.expectedLastValuationAt;
    const result = await this.client.execute({
      sql: `UPDATE bot_positions SET
        live_shares_kalshi = ?, live_shares_pm = ?, live_principal = ?, live_fees = ?, live_cost = ?,
        status = ?, closed_at = CASE WHEN ? = 'closed' THEN COALESCE(closed_at, ?) ELSE closed_at END,
        current_value = ?, unrealized_pnl = ?, unrealized_roi_pct = ?, realized_pnl = ?
        WHERE id = ? AND status = 'open'
          AND live_shares_kalshi = ? AND live_shares_pm = ?
          AND ((last_valuation_at IS NULL AND ? IS NULL) OR last_valuation_at = ?)`,
      args: [
        reduction.remainingSharesKalshi, reduction.remainingSharesPm, livePrincipal, liveFees, liveCost,
        fullyClosed ? 'closed' : 'open', fullyClosed ? 'closed' : 'open', reduction.observedAt,
        currentValue, unrealizedPnl, unrealizedRoi, reduction.realizedPnlCents,
        id, reduction.expectedRemainingSharesKalshi, reduction.expectedRemainingSharesPm,
        expectedValuation, expectedValuation,
      ],
    });
    if (result.rowsAffected !== 1) throw new Error('Bot position reduction lost compare-and-swap race');
    const updated = await this.getById(id);
    if (!updated) throw new Error(`Reduced bot position ${id} could not be read back`);
    return updated;
  }

  async listMarkets(options: {
    status?: 'all' | 'open' | 'settled';
    limit?: number;
    cursor?: string | null;
  } = {}): Promise<{ marketCount: number; markets: BotPositionMarket[]; nextCursor: string | null; positions: BotExecution[] }> {
    await this.ensureSchema();
    const result = await this.client.execute(`
      SELECT bp.*, e.dry_run FROM bot_positions bp
      LEFT JOIN executions e ON e.id = bp.execution_id
      ORDER BY bp.opened_at DESC, bp.execution_id DESC, bp.id DESC
    `);
    const groups = groupPositions(result.rows.map((row) => rowToPosition(row as Record<string, unknown>)));
    const status = options.status ?? 'all';
    let filtered = status === 'all' ? groups : groups.filter((group) =>
      status === 'open' ? group.currentLiveStakeCents > 0 : group.status === 'settled');
    if (options.cursor) {
      let cursor: { latestExecutionAt: string; marketKey: string };
      try {
        cursor = JSON.parse(Buffer.from(options.cursor, 'base64url').toString('utf8')) as typeof cursor;
      } catch {
        throw new Error('Invalid positions cursor');
      }
      if (typeof cursor.latestExecutionAt !== 'string' || typeof cursor.marketKey !== 'string') {
        throw new Error('Invalid positions cursor');
      }
      filtered = filtered.filter((group) => group.latestExecutionAt < cursor.latestExecutionAt
        || (group.latestExecutionAt === cursor.latestExecutionAt && group.marketKey > cursor.marketKey));
    }
    const limit = Math.min(1000, Math.max(1, Math.trunc(options.limit ?? 100)));
    const markets = filtered.slice(0, limit);
    const hasMore = filtered.length > markets.length;
    const last = markets.at(-1);
    const nextCursor = hasMore && last
      ? Buffer.from(JSON.stringify({ latestExecutionAt: last.latestExecutionAt, marketKey: last.marketKey })).toString('base64url')
      : null;
    return {
      marketCount: markets.length,
      markets,
      nextCursor,
      positions: markets.flatMap((market) => market.executions),
    };
  }

  async list(options: { status?: BotPositionStatus | 'all'; limit?: number } = {}): Promise<BotPosition[]> {
    await this.ensureSchema();
    const status = options.status ?? 'all';
    const limit = Math.min(1000, Math.max(1, Math.trunc(options.limit ?? 100)));
    const where = status === 'all' ? '' : 'WHERE bp.status = ?';
    const args: Array<string | number> = status === 'all' ? [limit] : [status, limit];
    const result = await this.client.execute({
      sql: `SELECT bp.*, e.dry_run FROM bot_positions bp LEFT JOIN executions e ON e.id = bp.execution_id ${where} ORDER BY bp.opened_at DESC LIMIT ?`,
      args,
    });
    return result.rows.map((row) => rowToPosition(row as Record<string, unknown>));
  }

  async listAllForAnalytics(options: { mode?: 'all' | 'paper' | 'production'; limit?: number } = {}): Promise<BotPosition[]> {
    await this.ensureSchema();
    const limit = Math.min(5000, Math.max(1, Math.trunc(options.limit ?? 5000)));
    const mode = options.mode ?? 'all';
    const where = mode === 'all' ? '' : `WHERE e.dry_run = ?`;
    const args: Array<number> = mode === 'all' ? [limit] : [mode === 'paper' ? 1 : 0, limit];
    const result = await this.client.execute({ sql: `
      SELECT bp.*, e.dry_run
      FROM bot_positions bp
      LEFT JOIN executions e ON e.id = bp.execution_id
      ${where}
      ORDER BY bp.opened_at DESC
      LIMIT ?
    `, args });
    return result.rows.map((row) => rowToPosition(row as Record<string, unknown>));
  }

  async listAllOpen(): Promise<BotPosition[]> {
    await this.ensureSchema();
    const result = await this.client.execute(`
      SELECT bp.*, e.dry_run
      FROM bot_positions bp
      LEFT JOIN executions e ON e.id = bp.execution_id
      WHERE bp.status = 'open'
      ORDER BY bp.opened_at ASC
    `);
    return result.rows.map((row) => rowToPosition(row as Record<string, unknown>));
  }

  async updateValuation(id: number, valuation: PositionValuation): Promise<void> {
    await this.ensureSchema();
    const settled = valuation.status === 'settled';
    await this.client.execute({
      sql: `UPDATE bot_positions SET
        status = ?, current_price_kalshi = ?, current_price_pm = ?,
        current_value = ?, unrealized_pnl = ?, unrealized_roi_pct = ?,
        live_shares_kalshi = CASE WHEN ? THEN 0 ELSE live_shares_kalshi END,
        live_shares_pm = CASE WHEN ? THEN 0 ELSE live_shares_pm END,
        live_principal = CASE WHEN ? THEN 0 ELSE live_principal END,
        live_fees = CASE WHEN ? THEN 0 ELSE live_fees END,
        live_cost = CASE WHEN ? THEN 0 ELSE live_cost END,
        last_valuation_at = ?, settled_at = ?, realized_pnl = ?, settlement_side = ?,
        resolution_source = ?, resolution_verified_at = ?, resolution_outcome = ?,
        resolution_payout = ?, resolution_validation_status = ?,
        kalshi_valuation_depth = ?, pm_valuation_depth = ?,
        kalshi_exit_fee = ?, pm_exit_fee = ?,
        kalshi_liquidation_value = ?, pm_liquidation_value = ?,
        kalshi_quote_timestamp = ?, pm_quote_timestamp = ?,
        kalshi_quote_source = ?, pm_quote_source = ?,
        valuation_failure_reason = NULL, valuation_failure_at = NULL
        WHERE id = ? AND status = 'open'
          AND (last_valuation_at IS NULL OR last_valuation_at <= ?)
          AND (valuation_failure_at IS NULL OR valuation_failure_at <= ?)`,
      args: [
        valuation.status, valuation.currentPriceKalshiCents,
        valuation.currentPricePmCents, settled ? 0 : valuation.currentValueCents,
        settled ? 0 : valuation.unrealizedPnlCents, settled ? 0 : valuation.unrealizedRoiBps,
        settled ? 1 : 0, settled ? 1 : 0, settled ? 1 : 0, settled ? 1 : 0, settled ? 1 : 0,
        valuation.lastValuationAt, valuation.settledAt,
        valuation.realizedPnlCents, valuation.settlementSide,
        valuation.status === 'settled' ? 'kalshi_market_settlement+polymarket_clob_market' : null,
        valuation.status === 'settled' ? valuation.settledAt : null,
        valuation.status === 'settled' ? (valuation.currentPriceKalshiCents === 100 ? 'yes' : 'no') : null,
        valuation.status === 'settled' ? valuation.currentValueCents : null,
        valuation.status === 'settled' ? 'verified' : 'pending',
        valuation.legs.kalshi.executableDepthUsed, valuation.legs.polymarket.executableDepthUsed,
        valuation.legs.kalshi.exitFeeCents, valuation.legs.polymarket.exitFeeCents,
        valuation.legs.kalshi.netProceedsCents, valuation.legs.polymarket.netProceedsCents,
        valuation.legs.kalshi.quoteTimestamp, valuation.legs.polymarket.quoteTimestamp,
        valuation.legs.kalshi.source, valuation.legs.polymarket.source,
        id, valuation.lastValuationAt, valuation.lastValuationAt,
      ],
    });
  }

  async recordValuationFailure(id: number, reason: string, failedAt: string): Promise<void> {
    await this.ensureSchema();
    await this.client.execute({
      sql: `UPDATE bot_positions SET valuation_failure_reason = ?, valuation_failure_at = ?
        WHERE id = ? AND status = 'open'
          AND (last_valuation_at IS NULL OR last_valuation_at < ?)
          AND (valuation_failure_at IS NULL OR valuation_failure_at <= ?)`,
      args: [reason, failedAt, id, failedAt, failedAt],
    });
  }

  close(): void {
    this.client.close();
  }
}

let defaultStore: BotPositionStore | null = null;
function store(): BotPositionStore {
  if (!defaultStore) defaultStore = new BotPositionStore();
  return defaultStore;
}

export async function createBotPosition(input: CreateBotPosition): Promise<BotPosition> {
  return store().create(input);
}

/** Compatibility adapter used by BotTrader after a successful paper execution. */
export interface BotPositionInput {
  executionId: number;
  pairId: string;
  marketTitle: string;
  kalshiTicker: string | null;
  pmConditionId: string | null;
  strategy: string;
  kalshiSide: BotPositionSide;
  pmSide: BotPositionSide;
  kalshiPrice: number;
  pmPrice: number;
  kalshiQuantity: number;
  pmQuantity: number;
  executedAt: string;
  expectedProfit: number;
  expectedRoiPct?: number | null;
  expectedApyPct?: number | null;
  expiryDate?: string | null;
  selectionMethod?: BotSelectionMethod | null;
  category?: string | null;
}

async function fetchFeeJson(url: string): Promise<Record<string, unknown>> {
  const response = await fetch(url, {
    headers: { Accept: 'application/json', 'User-Agent': 'h2h-arbitrage/1.0' },
    cache: 'no-store',
    signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok) throw new Error(`Authoritative fee endpoint returned HTTP ${response.status}`);
  const data: unknown = await response.json();
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Malformed authoritative fee response');
  return data as Record<string, unknown>;
}

export async function fetchAuthoritativeBotFeeConfig(input: {
  kalshiTicker: string;
  pmConditionId: string;
  pmTokenId?: string;
  pmSide: BotPositionSide;
  category: string;
  observedAt?: string;
}, dependencies?: {
  fetchJson?: (url: string) => Promise<Record<string, unknown>>;
  fetchPmMarket?: (conditionId: string) => Promise<{ tokens: Array<{ token_id?: unknown; outcome?: unknown }> } | null>;
}): Promise<AuthoritativeBotFeeConfig> {
  const getJson = dependencies?.fetchJson ?? fetchFeeJson;
  const marketPayload = await getJson(`https://external-api.kalshi.com/trade-api/v2/markets/${encodeURIComponent(input.kalshiTicker)}`);
  const market = marketPayload.market;
  const eventTicker = market && typeof market === 'object' && !Array.isArray(market)
    ? (market as Record<string, unknown>).event_ticker : null;
  if (typeof eventTicker !== 'string' || !eventTicker.trim()) throw new Error('Kalshi market is missing authoritative event metadata');
  const eventPayload = await getJson(`https://external-api.kalshi.com/trade-api/v2/events/${encodeURIComponent(eventTicker)}`);
  const event = eventPayload.event;
  if (!event || typeof event !== 'object' || Array.isArray(event)) throw new Error('Malformed Kalshi event fee metadata');
  const eventRecord = event as Record<string, unknown>;
  const seriesTicker = eventRecord.series_ticker;
  if (typeof seriesTicker !== 'string' || !seriesTicker.trim()) throw new Error('Kalshi event is missing authoritative series metadata');
  const seriesPayload = await getJson(`https://external-api.kalshi.com/trade-api/v2/series/${encodeURIComponent(seriesTicker)}`);
  const series = seriesPayload.series;
  if (!series || typeof series !== 'object' || Array.isArray(series)) throw new Error('Malformed Kalshi series fee metadata');
  const seriesRecord = series as Record<string, unknown>;
  const overrideType = eventRecord.fee_type_override;
  const overrideMultiplier = eventRecord.fee_multiplier_override;
  const hasOverride = overrideType != null || overrideMultiplier != null;
  if (hasOverride && (overrideType == null || overrideMultiplier == null)) throw new Error('Conflicting Kalshi event fee override');
  const feeType = hasOverride ? overrideType : seriesRecord.fee_type;
  const feeMultiplier = hasOverride ? overrideMultiplier : seriesRecord.fee_multiplier;
  if (feeType !== 'quadratic' || typeof feeMultiplier !== 'number' || !Number.isFinite(feeMultiplier)
    || feeMultiplier < 0 || feeMultiplier > 10) {
    throw new Error('Missing, malformed, or unsupported authoritative Kalshi fee configuration');
  }
  const feeMultiplierPpm = Math.round(feeMultiplier * 1_000_000);
  if (!Number.isSafeInteger(feeMultiplierPpm)) throw new Error('Malformed authoritative Kalshi fee multiplier');

  let tokenId = input.pmTokenId?.trim() ?? '';
  if (!tokenId) {
    const fetchPmMarket = dependencies?.fetchPmMarket ?? (async (conditionId: string) => {
      const { fetchClobMarket } = await import('./polymarket-clob');
      return fetchClobMarket(conditionId);
    });
    const pmMarket = await fetchPmMarket(input.pmConditionId);
    if (!pmMarket || !Array.isArray(pmMarket.tokens)) throw new Error('Polymarket market fee metadata unavailable');
    const tokens = pmMarket.tokens.filter((token): token is { token_id: string; outcome: string } =>
      typeof token?.token_id === 'string' && typeof token.outcome === 'string'
      && token.outcome.toLowerCase() === input.pmSide);
    if (tokens.length !== 1 || !tokens[0].token_id.trim()) throw new Error('Polymarket held token fee metadata is missing or ambiguous');
    tokenId = tokens[0].token_id.trim();
  }
  const pmFeePayload = await getJson(`https://clob.polymarket.com/fee-rate?token_id=${encodeURIComponent(tokenId)}`);
  const feeRateBps = pmFeePayload.base_fee;
  if (typeof feeRateBps !== 'number' || !Number.isSafeInteger(feeRateBps) || feeRateBps < 0 || feeRateBps > 10_000) {
    throw new Error('Missing or malformed authoritative Polymarket token fee rate');
  }
  const pmTheta = getPolymarketTheta(input.category);
  if (Math.round(pmTheta * 10_000) !== feeRateBps) throw new Error('Conflicting authoritative Polymarket category and token fee configuration');
  const observedAt = input.observedAt ?? new Date().toISOString();
  return {
    kalshi: {
      feeType, feeMultiplierPpm,
      source: hasOverride ? `kalshi-event:${eventTicker}` : `kalshi-series:${seriesTicker}`,
      observedAt, version: `${feeType}:${feeMultiplierPpm}`,
    },
    polymarket: {
      tokenId, feeRateBps, source: 'polymarket-clob:/fee-rate', observedAt,
      version: `token-fee-rate:${feeRateBps}`,
    },
    pmTheta,
  };
}

export async function recordBotPosition(input: BotPositionInput, feeAuthority: AuthoritativeBotFeeConfig): Promise<void> {
  if (!input.category?.trim()) throw new Error('Missing authoritative market category for Polymarket fee calculation');
  if (feeAuthority.pmTheta !== getPolymarketTheta(input.category)
    || feeAuthority.polymarket.feeRateBps !== Math.round(feeAuthority.pmTheta * 10_000)) {
    throw new Error('Conflicting authoritative Polymarket fee configuration');
  }
  const pmTheta = feeAuthority.pmTheta;
  const buyPriceKalshiCents = Math.round(input.kalshiPrice * 100);
  const buyPricePmCents = Math.round(input.pmPrice * 100);
  assertShares('kalshiQuantity', input.kalshiQuantity);
  assertShares('pmQuantity', input.pmQuantity);
  const sharesKalshi = input.kalshiQuantity;
  const sharesPm = input.pmQuantity;
  const kalshiEntryFeeCents = calculateAuthoritativeKalshiFeeCents(
    sharesKalshi,
    input.kalshiPrice,
    feeAuthority.kalshi.feeMultiplierPpm,
  );
  const pmEntryFeeCents = Math.round(calcPolymarketFee(sharesPm, input.pmPrice, pmTheta) * 100);
  const totalCostCents = sharesKalshi * buyPriceKalshiCents + sharesPm * buyPricePmCents + kalshiEntryFeeCents + pmEntryFeeCents;
  const expectedPayoutCents = Math.min(sharesKalshi, sharesPm) * 100;
  const expectedProfitCents = expectedPayoutCents - totalCostCents;

  await createBotPosition({
    executionId: input.executionId,
    marketId: input.pairId,
    marketTitle: input.marketTitle,
    kalshiTicker: input.kalshiTicker,
    pmConditionId: input.pmConditionId,
    strategy: input.strategy,
    kalshiSide: input.kalshiSide,
    pmSide: input.pmSide,
    buyPriceKalshiCents,
    buyPricePmCents,
    sharesKalshi,
    sharesPm,
    totalCostCents,
    expectedPayoutCents,
    expectedProfitCents,
    expectedRoiBps: input.expectedRoiPct == null ? roiBps(expectedProfitCents, totalCostCents) : Math.round(input.expectedRoiPct * 100),
    expectedApyBps: input.expectedApyPct == null ? null : Math.round(input.expectedApyPct * 100),
    unitId: `execution:${input.executionId}`,
    feesCents: kalshiEntryFeeCents + pmEntryFeeCents,
    category: input.category,
    pmTheta,
    kalshiEntryFeeCents,
    pmEntryFeeCents,
    openedAt: input.executedAt,
    expiryDate: input.expiryDate ?? null,
    selectionMethod: input.selectionMethod ?? null,
  });
}

export function calculateAuthoritativeKalshiFeeCents(
  contracts: number,
  price: number,
  feeMultiplierPpm: number,
): number {
  if (!Number.isSafeInteger(feeMultiplierPpm) || feeMultiplierPpm < 0) {
    throw new Error('Invalid authoritative Kalshi fee multiplier');
  }
  if (feeMultiplierPpm === 0) return 0;
  const authoritativeRate = 0.07 * feeMultiplierPpm / 1_000_000;
  return Math.round(calcKalshiFee(contracts, price, authoritativeRate) * 100);
}

export async function hasOpenBotMarketPair(kalshiTicker: string | null, pmConditionId: string | null): Promise<boolean> {
  return store().hasOpenPair(kalshiTicker, pmConditionId);
}

export async function reserveBotMarketPair(kalshiTicker: string, pmConditionId: string, maxUnitsPerMarket = 1): Promise<boolean> {
  return store().reservePair(kalshiTicker, pmConditionId, maxUnitsPerMarket);
}

export async function retainBotMarketPairForExposure(kalshiTicker: string, pmConditionId: string): Promise<void> {
  return store().retainPairForExposure(kalshiTicker, pmConditionId);
}

export async function releaseBotMarketPair(kalshiTicker: string, pmConditionId: string): Promise<void> {
  return store().releasePair(kalshiTicker, pmConditionId);
}

export async function getBotPositions(options: { status?: BotPositionStatus | 'all'; limit?: number } = {}): Promise<BotPosition[]> {
  return store().list(options);
}

export async function getBotPositionMarkets(options: {
  status?: 'all' | 'open' | 'settled';
  limit?: number;
  cursor?: string | null;
} = {}): Promise<{ marketCount: number; markets: BotPositionMarket[]; nextCursor: string | null; positions: BotExecution[] }> {
  return store().listMarkets(options);
}

export interface BotPositionAnalytics {
  totalBotTrades: { paper: number; production: number; total: number };
  openPositions: { count: number; unrealizedPnlCents: number };
  settledPositions: { count: number; realizedPnlCents: number; winRateBps: number };
  averageRoi: { atTradeBps: number; currentBps: number };
  bestTrade: BotPosition | null;
  worstTrade: BotPosition | null;
  dailyPnl: Array<{ date: string; realizedPnlCents: number; unrealizedPnlCents: number; trades: number }>;
  dailyPnlByMethod: Record<BotSelectionMethod, Array<{ date: string; realizedPnlCents: number; unrealizedPnlCents: number; trades: number }>>;
  timeStats: { tradesPerDayBps: number; averageHoldSeconds: number };
  filter: { method: 'all' | BotSelectionMethod | 'legacy'; mode: 'all' | 'paper' | 'production' };
  perMethod: Record<BotSelectionMethod | 'legacy', {
    tradeCount: number; deployedCapitalCents: number; realizedPnlCents: number;
    unrealizedPnlCents: number; winRateBps: number; averageEntryRoiBps: number;
    currentRoiBps: number; averageApyPct: number | null;
  }>;
}

export function summarizeBotPositions(rows: BotPosition[]) {
  const totalNumbers = (values: number[]) => values.reduce((total, value) => total + value, 0);
  const closed = rows.filter((position) => position.status === 'settled');
  const openRows = rows.filter((position) => position.status === 'open');
  const deployedCapitalCents = totalNumbers(rows.map((position) => position.totalCostCents));
  const realizedPnlCents = totalNumbers(closed.map((position) => position.realizedPnlCents ?? 0));
  const unrealizedPnlCents = totalNumbers(openRows.map((position) => position.unrealizedPnlCents ?? 0));
  const apyValues = rows.flatMap((position) => {
    if (!position.expiryDate) return [];
    const durationDays = (Date.parse(position.expiryDate) - Date.parse(position.openedAt)) / 86_400_000;
    if (!Number.isFinite(durationDays) || durationDays <= 0) return [];
    return [roiBps(position.expectedProfitCents, position.totalCostCents) / 100 * 365 / durationDays];
  });
  return {
    tradeCount: rows.length, deployedCapitalCents, realizedPnlCents, unrealizedPnlCents,
    winRateBps: closed.length === 0 ? 0 : Math.round(closed.filter((position) => (position.realizedPnlCents ?? 0) > 0).length * 10_000 / closed.length),
    averageEntryRoiBps: rows.length === 0 ? 0 : Math.round(totalNumbers(rows.map((position) => roiBps(position.expectedProfitCents, position.totalCostCents))) / rows.length),
    currentRoiBps: deployedCapitalCents === 0 ? 0 : roiBps(realizedPnlCents + unrealizedPnlCents, deployedCapitalCents),
    averageApyPct: apyValues.length === 0 ? null : Math.round(totalNumbers(apyValues) / apyValues.length * 100) / 100,
  };
}

function dailyPnlFor(rows: BotPosition[]) {
  const dates = new Map<string, { realizedPnlCents: number; unrealizedPnlCents: number; trades: number }>();
  for (const position of rows) {
    const date = position.openedAt.slice(0, 10);
    const value = dates.get(date) ?? { realizedPnlCents: 0, unrealizedPnlCents: 0, trades: 0 };
    value.trades += 1;
    value.realizedPnlCents += position.realizedPnlCents ?? 0;
    value.unrealizedPnlCents += position.status === 'open' ? position.unrealizedPnlCents ?? 0 : 0;
    dates.set(date, value);
  }
  return [...dates.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, values]) => ({ date, ...values }));
}

export async function getBotPositionAnalytics(options: {
  method?: 'all' | BotSelectionMethod | 'legacy';
  mode?: 'all' | 'paper' | 'production';
} = {}): Promise<BotPositionAnalytics> {
  const method = options.method ?? 'all';
  const mode = options.mode ?? 'all';
  const allPositions = await store().listAllForAnalytics({ mode, limit: 5000 });
  const positions = method === 'all' ? allPositions : allPositions.filter((position) =>
    method === 'legacy' ? position.selectionMethod == null : position.selectionMethod === method);
  const paper = positions.filter((position) => position.dryRun).length;
  const production = positions.length - paper;
  const open = positions.filter((position) => position.status === 'open');
  const settled = positions.filter((position) => position.status === 'settled');
  const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);
  const score = (position: BotPosition) => position.realizedPnlCents ?? position.unrealizedPnlCents ?? 0;
  const ranked = [...positions].sort((a, b) => score(b) - score(a));
  const dailyPnl = dailyPnlFor(positions);
  const distinctDays = Math.max(1, dailyPnl.length);
  const holdSeconds = settled.map((position) => {
    const start = Date.parse(position.openedAt);
    const end = position.settledAt ? Date.parse(position.settledAt) : start;
    return Math.max(0, Math.round((end - start) / 1000));
  });
  const summarizeMethod = (key: BotSelectionMethod | 'legacy') => summarizeBotPositions(
    allPositions.filter((position) => key === 'legacy'
      ? position.selectionMethod == null
      : position.selectionMethod === key),
  );
  return {
    totalBotTrades: { paper, production, total: positions.length },
    openPositions: {
      count: open.length,
      unrealizedPnlCents: sum(open.map((position) => position.unrealizedPnlCents ?? 0)),
    },
    settledPositions: {
      count: settled.length,
      realizedPnlCents: sum(settled.map((position) => position.realizedPnlCents ?? 0)),
      winRateBps: settled.length === 0 ? 0 : Math.round(settled.filter((position) => (position.realizedPnlCents ?? 0) > 0).length * 10_000 / settled.length),
    },
    averageRoi: {
      atTradeBps: positions.length === 0 ? 0 : Math.round(sum(positions.map((position) => roiBps(position.expectedProfitCents, position.totalCostCents))) / positions.length),
      currentBps: positions.length === 0 ? 0 : Math.round(sum(positions.map((position) => position.unrealizedRoiBps ?? 0)) / positions.length),
    },
    bestTrade: ranked[0] ?? null,
    worstTrade: ranked.at(-1) ?? null,
    dailyPnl,
    dailyPnlByMethod: {
      roi: dailyPnlFor(allPositions.filter((position) => position.selectionMethod === 'roi')),
      apy: dailyPnlFor(allPositions.filter((position) => position.selectionMethod === 'apy')),
      hybrid: dailyPnlFor(allPositions.filter((position) => position.selectionMethod === 'hybrid')),
    },
    timeStats: {
      tradesPerDayBps: Math.round(positions.length * 10_000 / distinctDays),
      averageHoldSeconds: holdSeconds.length === 0 ? 0 : Math.round(sum(holdSeconds) / holdSeconds.length),
    },
    filter: { method, mode },
    perMethod: {
      roi: summarizeMethod('roi'),
      apy: summarizeMethod('apy'),
      hybrid: summarizeMethod('hybrid'),
      legacy: summarizeMethod('legacy'),
    },
  };
}

type KalshiOrderbookPayload = {
  orderbook_fp?: { yes_dollars?: [string, string][]; no_dollars?: [string, string][] };
  orderbook?: { yes_dollars_fp?: [string, string][]; no_dollars_fp?: [string, string][] };
};

export async function fetchKalshiBidLevels(ticker: string, dependencies?: {
  fetchImpl?: typeof fetch;
  makeHeaders?: (method: string, path: string) => Record<string, string>;
}): Promise<KalshiBidLevels> {
  const encodedTicker = encodeURIComponent(ticker);
  const kalshiPath = `/trade-api/v2/markets/${encodedTicker}/orderbook`;
  const [{ makeKalshiAuthHeaders }, { rateLimiters }] = await Promise.all([
    import('./kalshi-auth'),
    import('./rate-limiter'),
  ]);
  const fetchImpl = dependencies?.fetchImpl ?? fetch;
  const makeHeaders = dependencies?.makeHeaders ?? makeKalshiAuthHeaders;
  const response = await rateLimiters.kalshi.execute(() => fetchImpl(
    `https://external-api.kalshi.com${kalshiPath}`,
    {
      headers: makeHeaders('GET', kalshiPath),
      cache: 'no-store',
      signal: AbortSignal.timeout(8_000),
    },
  ));
  if (!response.ok) throw new Error(`Kalshi order book unavailable (HTTP ${response.status})`);
  const payload = await response.json() as KalshiOrderbookPayload;
  const parse = (levels: [string, string][] | undefined): ExecutableBidLevel[] => (levels ?? []).flatMap(([price, quantity]) => {
    if (!/^(?:0(?:\.\d+)?|1(?:\.0+)?)$/.test(price) || !/^\d+(?:\.\d+)?$/.test(quantity)) return [];
    const priceCents = Math.round(Number(price) * 100);
    const parsedQuantity = Number(quantity);
    return isPriceCents(priceCents) && Number.isFinite(parsedQuantity) && parsedQuantity > 0
      ? [{ priceCents, quantity: parsedQuantity }] : [];
  });
  return {
    yesBidLevels: parse(payload.orderbook_fp?.yes_dollars ?? payload.orderbook?.yes_dollars_fp),
    noBidLevels: parse(payload.orderbook_fp?.no_dollars ?? payload.orderbook?.no_dollars_fp),
  };
}

export async function pollOpenBotPositions(dependencies?: {
  positionStore?: Pick<BotPositionStore, 'listAllOpen' | 'updateValuation' | 'recordValuationFailure'>;
  fetchKalshi?: (ticker: string) => Promise<{
    yes_bid_dollars?: string;
    no_bid_dollars?: string;
    yes_bid_size_fp?: string;
    no_bid_size_fp?: string;
    close_time?: string;
    status?: string;
    settlement_value_dollars?: string;
  } | null>;
  fetchKalshiBids?: (ticker: string) => Promise<KalshiBidLevels>;
  fetchPmBids?: (conditionId: string) => Promise<{
    yesBidCents: number | null; noBidCents: number | null; resolved: boolean;
    yesBidLevels?: ExecutableBidLevel[]; noBidLevels?: ExecutableBidLevel[];
  } | null>;
  observedAt?: string;
}): Promise<{ updated: number; settled: number; errors: Array<{ id: number; error: string }> }> {
  const [{ fetchKalshiMarketFast }, { fetchClobBook, fetchClobMarket, getClobBidPrices }, { getSavedMarketById }] = await Promise.all([
    import('./kalshi'),
    import('./polymarket-clob'),
    import('./persistence'),
  ]);
  const fetchKalshi = dependencies?.fetchKalshi ?? fetchKalshiMarketFast;
  const fetchKalshiBids = dependencies?.fetchKalshiBids
    ?? (dependencies?.fetchKalshi ? null : fetchKalshiBidLevels);
  const fetchPmBids = dependencies?.fetchPmBids ?? (async (conditionId: string) => {
    const market = await fetchClobMarket(conditionId);
    if (market) {
      const yesToken = market.tokens.find((token) => token.outcome.toLowerCase() === 'yes');
      const noToken = market.tokens.find((token) => token.outcome.toLowerCase() === 'no');
      const [prices, yesBook, noBook] = await Promise.all([
        getClobBidPrices(market),
        yesToken ? fetchClobBook(yesToken.token_id) : null,
        noToken ? fetchClobBook(noToken.token_id) : null,
      ]);
      const levels = (book: Awaited<ReturnType<typeof fetchClobBook>>): ExecutableBidLevel[] =>
        (book?.bids ?? []).flatMap(({ price, size }) =>
          /^(?:0(?:\.\d+)?|1(?:\.0+)?)$/.test(price) && /^\d+(?:\.\d+)?$/.test(size)
            ? [{ priceCents: Math.round(Number(price) * 100), quantity: Number(size) }] : []);
      return { ...prices, yesBidLevels: levels(yesBook), noBidLevels: levels(noBook) };
    }
    // Legacy rows stored the held token ID rather than the parent condition ID.
    // A direct token book still provides an authoritative executable sell bid.
    const book = await fetchClobBook(conditionId);
    if (!book) return null;
    const bids = book.bids.flatMap(({ price }) => /^(?:0(?:\.\d+)?|1(?:\.0+)?)$/.test(price) ? [Math.round(Number(price) * 100)] : []);
    const heldBid = bids.length ? Math.max(...bids) : null;
    const heldLevels = book.bids.flatMap(({ price, size }) =>
      /^(?:0(?:\.\d+)?|1(?:\.0+)?)$/.test(price) && /^\d+(?:\.\d+)?$/.test(size)
        ? [{ priceCents: Math.round(Number(price) * 100), quantity: Number(size) }] : []);
    return { yesBidCents: heldBid, noBidCents: heldBid, resolved: false, yesBidLevels: heldLevels, noBidLevels: heldLevels };
  });
  const observedAt = dependencies?.observedAt ?? new Date().toISOString();
  const positionStore = dependencies?.positionStore ?? store();
  const open = await positionStore.listAllOpen();
  let updated = 0;
  let settled = 0;
  const errors: Array<{ id: number; error: string }> = [];

  const valuate = async (position: BotPosition) => {
    try {
      if (!position.kalshiTicker || !position.pmConditionId) {
        throw new Error('Position is missing venue market identifiers');
      }
      const [kalshi, kalshiBids, pmBids] = await Promise.all([
        fetchKalshi(position.kalshiTicker),
        fetchKalshiBids?.(position.kalshiTicker) ?? null,
        fetchPmBids(position.pmConditionId),
      ]);
      if (!kalshi || !pmBids) throw new Error('Venue quote unavailable');
      const parseCents = (value: string | undefined): number | null => {
        if (value == null || !/^(?:0(?:\.\d+)?|1(?:\.0+)?)$/.test(value)) return null;
        const cents = Math.round(Number(value) * 100);
        return isPriceCents(cents) ? cents : null;
      };
      const kalshiResolution = getKalshiResolvedPrices(kalshi);
      const saved = position.marketId ? await getSavedMarketById(position.marketId).catch(() => null) : null;
      const valuationPosition = position.pmTheta == null && saved?.category
        ? { ...position, pmTheta: getPolymarketTheta(saved.category) }
        : position;
      const fallbackBidLevels = (side: BotPositionSide): ExecutableBidLevel[] => {
        const price = side === 'yes' ? parseCents(kalshi.yes_bid_dollars) : parseCents(kalshi.no_bid_dollars);
        const rawQuantity = side === 'yes' ? kalshi.yes_bid_size_fp : kalshi.no_bid_size_fp;
        const quantity = rawQuantity != null && /^\d+(?:\.\d+)?$/.test(rawQuantity) ? Number(rawQuantity) : null;
        return price != null && quantity != null && quantity > 0 ? [{ priceCents: price, quantity }] : [];
      };
      const yesBidLevels = kalshiBids?.yesBidLevels ?? fallbackBidLevels('yes');
      const noBidLevels = kalshiBids?.noBidLevels ?? fallbackBidLevels('no');
      const bestBid = (levels: ExecutableBidLevel[]): number | null => levels.length
        ? Math.max(...levels.map((level) => level.priceCents)) : null;
      const valuation = calculatePositionValuation(valuationPosition, {
        kalshiYesBidCents: kalshiResolution.yesBidCents ?? bestBid(yesBidLevels) ?? parseCents(kalshi.yes_bid_dollars),
        kalshiNoBidCents: kalshiResolution.noBidCents ?? bestBid(noBidLevels) ?? parseCents(kalshi.no_bid_dollars),
        pmYesBidCents: pmBids.yesBidCents,
        pmNoBidCents: pmBids.noBidCents,
        kalshiHeldBidLevels: kalshiResolution.resolved ? undefined
          : (position.kalshiSide === 'yes' ? yesBidLevels : noBidLevels),
        pmHeldBidLevels: position.pmSide === 'yes' ? pmBids.yesBidLevels : pmBids.noBidLevels,
        observedAt,
        expiryDate: kalshi.close_time ?? position.expiryDate,
        kalshiResolved: kalshiResolution.resolved,
        pmResolved: pmBids.resolved,
      });
      await positionStore.updateValuation(position.id, valuation);
      updated += 1;
      if (valuation.status === 'settled') settled += 1;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      await positionStore.recordValuationFailure(position.id, reason, observedAt).catch(() => undefined);
      errors.push({ id: position.id, error: reason });
    }
  };
  const concurrency = 8;
  for (let index = 0; index < open.length; index += concurrency) {
    await Promise.all(open.slice(index, index + concurrency).map(valuate));
  }
  return { updated, settled, errors };
}
