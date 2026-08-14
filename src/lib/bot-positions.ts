import path from 'node:path';
import { createClient, type Client } from '@libsql/client';
import { calcKalshiFee, calcPolymarketFee } from './matcher';
import { normalizeKalshiResolution } from './settlement-resolution';
import type { DashboardRange } from './dashboard-request';

export type BotPositionStatus = 'open' | 'settled' | 'closed';
export type BotPositionSide = 'yes' | 'no';
export type BotPositionExecutionMode = 'paper' | 'live';
export type SettlementSide = 'kalshi' | 'pm' | null;
export type BotSelectionMethod = 'roi' | 'apy' | 'hybrid';
export type KalshiFeeType = 'quadratic';

export interface AuthoritativeKalshiFeeConfig {
  feeType: KalshiFeeType;
  feeMultiplierPpm: number;
  source: string;
  observedAt: string;
  version: string;
}

export interface AuthoritativePolymarketFeeConfig {
  tokenId: string;
  feeRateBps: number;
  source: string;
  observedAt: string;
  version: string;
}

export interface AuthoritativeBotFeeConfig {
  kalshi: AuthoritativeKalshiFeeConfig;
  polymarket: AuthoritativePolymarketFeeConfig;
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
  entryCostStatus?: 'available' | 'unavailable';
  entryCostFailureReason?: string | null;
  kalshiEntryGrossMicrocents?: number | null;
  pmEntryGrossMicrocents?: number | null;
  entryCostRoundingDeltaMicrocents?: number | null;
  kalshiEntryFillCount?: number | null;
  pmEntryFillCount?: number | null;
  expectedPayoutCents: number;
  expectedProfitCents: number;
  expectedRoiBps: number | null;
  expectedApyBps: number | null;
  unitId: string | null;
  feesCents: number;
  category: string | null;
  pmTheta: number | null;
  kalshiEntryFeeType: KalshiFeeType | null;
  kalshiEntryFeeMultiplierPpm: number | null;
  kalshiEntryFeeSource: string | null;
  kalshiEntryFeeObservedAt: string | null;
  kalshiEntryFeeVersion: string | null;
  pmEntryTokenId: string | null;
  pmEntryFeeRateBps: number | null;
  pmEntryFeeSource: string | null;
  pmEntryFeeObservedAt: string | null;
  pmEntryFeeVersion: string | null;
  kalshiEntryFeeCents: number;
  pmEntryFeeCents: number;
  kalshiExitFeeType: KalshiFeeType | null;
  kalshiExitFeeMultiplierPpm: number | null;
  kalshiExitFeeSource: string | null;
  kalshiExitFeeObservedAt: string | null;
  kalshiExitFeeVersion: string | null;
  pmExitTokenId: string | null;
  pmExitFeeRateBps: number | null;
  pmExitFeeSource: string | null;
  pmExitFeeObservedAt: string | null;
  pmExitFeeVersion: string | null;
  status: BotPositionStatus;
  openedAt: string;
  expiryDate: string | null;
  settledAt: string | null;
  closedAt: string | null;
  currentPriceKalshiCents: number | null;
  currentPricePmCents: number | null;
  currentValueCents: number | null;
  kalshiGrossProceedsMicrocents: number | null;
  pmGrossProceedsMicrocents: number | null;
  kalshiNetProceedsCents: number | null;
  pmNetProceedsCents: number | null;
  kalshiExitFeeCents: number | null;
  pmExitFeeCents: number | null;
  unrealizedPnlCents: number | null;
  unrealizedRoiBps: number | null;
  lastValuationAt: string | null;
  valuationStatus: 'current' | 'stale' | 'unavailable';
  valuationFailureReason: string | null;
  valuationFailureAt: string | null;
  kalshiValuationDepth: number | null;
  pmValuationDepth: number | null;
  kalshiLiquidationValueCents: number | null;
  pmLiquidationValueCents: number | null;
  kalshiQuoteTimestamp: string | null;
  pmQuoteTimestamp: string | null;
  kalshiQuoteSource: string | null;
  pmQuoteSource: string | null;
  realizedPnlCents: number | null;
  settlementSide: SettlementSide;
  executionMode: BotPositionExecutionMode;
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
  'currentPricePmCents' | 'currentValueCents' |
  'kalshiGrossProceedsMicrocents' | 'pmGrossProceedsMicrocents' |
  'kalshiNetProceedsCents' | 'pmNetProceedsCents' | 'unrealizedPnlCents' |
  'kalshiExitFeeCents' | 'pmExitFeeCents' | 'unrealizedRoiBps' |
  'lastValuationAt' | 'realizedPnlCents' |
  'settlementSide' | 'dryRun' | 'remainingSharesKalshi' | 'remainingSharesPm' |
  'remainingOpenPrincipalCents' | 'remainingOpenFeesCents' | 'remainingOpenCostCents' |
  'closedAt' | 'valuationStatus' | 'valuationFailureReason' | 'valuationFailureAt' |
  'kalshiValuationDepth' | 'pmValuationDepth' |
  'kalshiLiquidationValueCents' | 'pmLiquidationValueCents' |
  'kalshiQuoteTimestamp' | 'pmQuoteTimestamp' | 'kalshiQuoteSource' | 'pmQuoteSource' |
  'expectedRoiBps' | 'expectedApyBps' | 'unitId' | 'entryCostStatus' | 'entryCostFailureReason'
> & {
  expectedRoiBps?: number | null;
  expectedApyBps?: number | null;
  unitId?: string | null;
};

export interface ExecutableBidLevel {
  priceCents: number;
  size: number;
}

function parseExecutableBidLevels(levels: unknown, label: string, tupleLevels = false): ExecutableBidLevel[] {
  if (!Array.isArray(levels)) throw new Error(`${label} executable bid depth unavailable`);
  const parsed = levels.map((rawLevel) => {
    const level = tupleLevels && Array.isArray(rawLevel) && rawLevel.length === 2
      ? { price: rawLevel[0], size: rawLevel[1] }
      : rawLevel;
    if (!level || typeof level !== 'object' || Array.isArray(level)) {
      throw new Error(`Malformed ${label} executable bid depth`);
    }
    const { price: rawPrice, size: rawSize } = level as Record<string, unknown>;
    const price = typeof rawPrice === 'string' && /^(?:0(?:\.\d+)?|1(?:\.0+)?)$/.test(rawPrice)
      ? Number(rawPrice)
      : null;
    const size = typeof rawSize === 'string' && /^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(rawSize)
      ? Number(rawSize)
      : null;
    if (price == null || !Number.isFinite(price) || price <= 0 || price > 1
      || size == null || !Number.isFinite(size) || size <= 0) {
      throw new Error(`Malformed ${label} executable bid depth`);
    }
    return { priceCents: price * 100, size };
  });
  const prices = new Set<number>();
  for (const level of parsed) {
    if (prices.has(level.priceCents)) throw new Error(`Duplicate ${label} executable bid price`);
    prices.add(level.priceCents);
  }
  return parsed.sort((a, b) => b.priceCents - a.priceCents);
}

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
  kalshiYesBids?: ExecutableBidLevel[];
  kalshiNoBids?: ExecutableBidLevel[];
  pmYesBids?: ExecutableBidLevel[];
  pmNoBids?: ExecutableBidLevel[];
  /** Oldest authoritative venue observation used by this valuation. */
  observedAt: string;
  /** Time the valuation attempt evaluated the venue observations. */
  valuedAt?: string;
  expiryDate: string | null;
  kalshiResolved?: boolean;
  pmResolved?: boolean;
}

export interface PositionValuation {
  status: 'open' | 'settled';
  currentPriceKalshiCents: number;
  currentPricePmCents: number;
  currentValueCents: number;
  kalshiGrossProceedsMicrocents: number;
  pmGrossProceedsMicrocents: number;
  kalshiNetProceedsCents: number;
  pmNetProceedsCents: number;
  kalshiExitFeeCents: number;
  pmExitFeeCents: number;
  unrealizedPnlCents: number;
  unrealizedRoiBps: number;
  lastValuationAt: string;
  settledAt: string | null;
  realizedPnlCents: number | null;
  settlementSide: SettlementSide;
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

function isExecutablePriceCents(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100;
}

function parseObservationMs(value: unknown): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : Number.NaN;
  if (typeof value !== 'string' || value.length === 0) return Number.NaN;
  return /^\d+$/.test(value) ? Number(value) : Date.parse(value);
}

function assertMoneyCents(name: string, value: number): void {
  if (!Number.isSafeInteger(value)) throw new Error(`${name} must be integer cents`);
}

function assertShares(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer contract count`);
}

const FEE_SCALE = 1_000_000n;
const FEE_CONFIG_MAX_AGE_MS = 60_000;
const EXECUTABLE_QUOTE_MAX_AGE_MS = 60_000;

function fixedPoint(value: number, label: string): bigint {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${label} must be a finite non-negative number`);
  const scaled = Math.round(value * Number(FEE_SCALE));
  if (!Number.isSafeInteger(scaled)) throw new Error(`${label} exceeds fixed-point limits`);
  return BigInt(scaled);
}

function ceilRatio(numerator: bigint, denominator: bigint): number {
  const value = Number((numerator + denominator - 1n) / denominator);
  if (!Number.isSafeInteger(value)) throw new Error('Fee exceeds safe integer cents');
  return value;
}

function roundRatio(numerator: bigint, denominator: bigint): number {
  const value = Number((numerator + denominator / 2n) / denominator);
  if (!Number.isSafeInteger(value)) throw new Error('Fee exceeds safe integer cents');
  return value;
}

function calculateKalshiFeeCents(
  fills: Array<{ priceCents: number; size: number }>,
  feeMultiplierPpm: number,
): number {
  if (!Number.isSafeInteger(feeMultiplierPpm) || feeMultiplierPpm < 0 || feeMultiplierPpm > 10_000_000) {
    throw new Error('Malformed authoritative Kalshi fee configuration');
  }
  const multiplier = BigInt(feeMultiplierPpm);
  let numerator = 0n;
  for (const fill of fills) {
    const quantity = fixedPoint(fill.size, 'Kalshi fill size');
    const price = fixedPoint(fill.priceCents / 100, 'Kalshi fill price');
    numerator += 7n * quantity * price * (FEE_SCALE - price) * multiplier;
  }
  return ceilRatio(numerator, FEE_SCALE ** 4n);
}

function calculatePolymarketFeeCents(
  fills: Array<{ priceCents: number; size: number }>,
  feeRateBps: number,
): number {
  if (!Number.isSafeInteger(feeRateBps) || feeRateBps < 0 || feeRateBps > 10_000) {
    throw new Error('Malformed authoritative Polymarket fee configuration');
  }
  let numerator = 0n;
  for (const fill of fills) {
    const quantity = fixedPoint(fill.size, 'Polymarket fill size');
    const price = fixedPoint(fill.priceCents / 100, 'Polymarket fill price');
    numerator += quantity * price * (FEE_SCALE - price) * BigInt(feeRateBps) * 100n;
  }
  return roundRatio(numerator, FEE_SCALE ** 3n * 10_000n);
}

function assertCurrentFeeAuthority(position: BotPosition, observedAt: string): void {
  const observedMs = Date.parse(observedAt);
  const kalshiFeeMs = Date.parse(position.kalshiExitFeeObservedAt ?? '');
  const pmFeeMs = Date.parse(position.pmExitFeeObservedAt ?? '');
  if (position.kalshiExitFeeType !== 'quadratic'
    || !Number.isSafeInteger(position.kalshiExitFeeMultiplierPpm)
    || !position.kalshiExitFeeSource?.trim() || !position.kalshiExitFeeVersion?.trim()
    || !Number.isFinite(kalshiFeeMs)) {
    throw new Error(`Missing or malformed authoritative Kalshi fee configuration for bot position ${position.id}`);
  }
  if (!position.pmExitTokenId?.trim() || !Number.isSafeInteger(position.pmExitFeeRateBps)
    || !position.pmExitFeeSource?.trim() || !position.pmExitFeeVersion?.trim()
    || !Number.isFinite(pmFeeMs)) {
    throw new Error(`Missing or malformed authoritative Polymarket fee configuration for bot position ${position.id}`);
  }
  if ((position.pmEntryTokenId == null && position.executionMode !== 'paper')
    || (position.pmEntryTokenId != null && position.pmExitTokenId !== position.pmEntryTokenId)) {
    throw new Error(`Conflicting Polymarket token fee configuration for bot position ${position.id}`);
  }
  const expectedPmFeeRateBps = Math.round((position.pmTheta ?? Number.NaN) * 10_000);
  if (!Number.isSafeInteger(expectedPmFeeRateBps) || expectedPmFeeRateBps !== position.pmExitFeeRateBps) {
    throw new Error(`Conflicting Polymarket fee configuration for bot position ${position.id}`);
  }
  if (!Number.isFinite(observedMs)) throw new Error(`Malformed valuation timestamp for bot position ${position.id}`);
}

function assertEntryFeeAuthority(input: CreateBotPosition): void {
  const openedMs = Date.parse(input.openedAt);
  const kalshiObservedMs = Date.parse(input.kalshiEntryFeeObservedAt ?? '');
  const pmObservedMs = Date.parse(input.pmEntryFeeObservedAt ?? '');
  if (input.kalshiEntryFeeType !== 'quadratic'
    || !Number.isSafeInteger(input.kalshiEntryFeeMultiplierPpm)
    || !input.kalshiEntryFeeSource?.trim() || !input.kalshiEntryFeeVersion?.trim()
    || !Number.isFinite(kalshiObservedMs)) {
    throw new Error('Missing or malformed authoritative Kalshi entry fee configuration');
  }
  if (!input.pmEntryTokenId?.trim() || !Number.isSafeInteger(input.pmEntryFeeRateBps)
    || !input.pmEntryFeeSource?.trim() || !input.pmEntryFeeVersion?.trim()
    || !Number.isFinite(pmObservedMs)) {
    throw new Error('Missing or malformed authoritative Polymarket entry fee configuration');
  }
  if (!Number.isFinite(openedMs)
    || kalshiObservedMs > openedMs || pmObservedMs > openedMs
    || Math.abs(openedMs - kalshiObservedMs) > FEE_CONFIG_MAX_AGE_MS
    || Math.abs(openedMs - pmObservedMs) > FEE_CONFIG_MAX_AGE_MS) {
    throw new Error('Stale authoritative entry fee configuration');
  }
  if (Math.round((input.pmTheta ?? Number.NaN) * 10_000) !== input.pmEntryFeeRateBps) {
    throw new Error('Conflicting authoritative Polymarket entry fee configuration');
  }
  if (input.kalshiExitFeeType !== input.kalshiEntryFeeType
    || input.kalshiExitFeeMultiplierPpm !== input.kalshiEntryFeeMultiplierPpm
    || input.pmExitTokenId !== input.pmEntryTokenId
    || input.pmExitFeeRateBps !== input.pmEntryFeeRateBps) {
    throw new Error('Conflicting initial entry and exit fee configuration');
  }
  if (!input.kalshiExitFeeSource?.trim() || !input.kalshiExitFeeVersion?.trim()
    || !input.pmExitFeeSource?.trim() || !input.pmExitFeeVersion?.trim()
    || input.kalshiExitFeeObservedAt !== input.kalshiEntryFeeObservedAt
    || input.pmExitFeeObservedAt !== input.pmEntryFeeObservedAt) {
    throw new Error('Missing or malformed authoritative initial exit fee configuration');
  }
  const grossMicrocents = input.kalshiEntryGrossMicrocents != null && input.pmEntryGrossMicrocents != null
    ? input.kalshiEntryGrossMicrocents + input.pmEntryGrossMicrocents
    : (input.buyPriceKalshiCents * input.sharesKalshi + input.buyPricePmCents * input.sharesPm) * Number(FEE_SCALE);
  if (!Number.isSafeInteger(grossMicrocents) || grossMicrocents < 0) {
    throw new Error('Malformed authoritative entry gross');
  }
  const expectedGrossCents = roundRatio(BigInt(grossMicrocents), FEE_SCALE);
  const expectedFeesCents = input.kalshiEntryFeeCents + input.pmEntryFeeCents;
  if (!Number.isSafeInteger(input.kalshiEntryFeeCents) || input.kalshiEntryFeeCents < 0
    || !Number.isSafeInteger(input.pmEntryFeeCents) || input.pmEntryFeeCents < 0
    || input.feesCents !== expectedFeesCents
    || input.totalCostCents !== expectedGrossCents + expectedFeesCents
    || input.expectedPayoutCents !== Math.min(input.sharesKalshi, input.sharesPm) * 100
    || input.expectedProfitCents !== input.expectedPayoutCents - input.totalCostCents) {
    throw new Error('Persisted entry economics conflict with authoritative entry fee configuration');
  }
}

function assertPersistedEntryEconomics(position: BotPosition): void {
  const openedMs = Date.parse(position.openedAt);
  const kalshiObservedMs = Date.parse(position.kalshiEntryFeeObservedAt ?? '');
  const pmObservedMs = Date.parse(position.pmEntryFeeObservedAt ?? '');
  if (position.kalshiEntryFeeType !== 'quadratic'
    || !Number.isSafeInteger(position.kalshiEntryFeeMultiplierPpm)
    || !position.kalshiEntryFeeSource?.trim() || !position.kalshiEntryFeeVersion?.trim()
    || !Number.isFinite(kalshiObservedMs)
    || !position.pmEntryTokenId?.trim() || !Number.isSafeInteger(position.pmEntryFeeRateBps)
    || !position.pmEntryFeeSource?.trim() || !position.pmEntryFeeVersion?.trim()
    || !Number.isFinite(pmObservedMs)) {
    throw new Error(`Missing or malformed authoritative entry fee configuration for bot position ${position.id}`);
  }
  if (!Number.isFinite(openedMs) || kalshiObservedMs > openedMs || pmObservedMs > openedMs
    || openedMs - kalshiObservedMs > FEE_CONFIG_MAX_AGE_MS
    || openedMs - pmObservedMs > FEE_CONFIG_MAX_AGE_MS) {
    throw new Error(`Stale authoritative entry fee configuration for bot position ${position.id}`);
  }
  if (Math.round((position.pmTheta ?? Number.NaN) * 10_000) !== position.pmEntryFeeRateBps) {
    throw new Error(`Conflicting authoritative entry fee configuration for bot position ${position.id}`);
  }
  const grossMicrocents = position.kalshiEntryGrossMicrocents != null && position.pmEntryGrossMicrocents != null
    ? position.kalshiEntryGrossMicrocents + position.pmEntryGrossMicrocents
    : (position.buyPriceKalshiCents * position.sharesKalshi + position.buyPricePmCents * position.sharesPm) * Number(FEE_SCALE);
  if (!Number.isSafeInteger(grossMicrocents) || grossMicrocents < 0) {
    throw new Error(`Malformed authoritative entry gross for bot position ${position.id}`);
  }
  const expectedGrossCents = roundRatio(BigInt(grossMicrocents), FEE_SCALE);
  const expectedFeesCents = position.kalshiEntryFeeCents + position.pmEntryFeeCents;
  if (!Number.isSafeInteger(position.kalshiEntryFeeCents) || position.kalshiEntryFeeCents < 0
    || !Number.isSafeInteger(position.pmEntryFeeCents) || position.pmEntryFeeCents < 0
    || position.feesCents !== expectedFeesCents
    || position.totalCostCents !== expectedGrossCents + expectedFeesCents
    || position.expectedPayoutCents !== Math.min(position.sharesKalshi, position.sharesPm) * 100
    || position.expectedProfitCents !== position.expectedPayoutCents - position.totalCostCents) {
    throw new Error(`Persisted entry economics conflict with authoritative fee configuration for bot position ${position.id}`);
  }
}

function isLegacyPaperEntryAuthorityMissing(position: BotPosition): boolean {
  return position.executionMode === 'paper'
    && position.kalshiEntryFeeType == null
    && position.kalshiEntryFeeMultiplierPpm == null
    && position.kalshiEntryFeeSource == null
    && position.kalshiEntryFeeObservedAt == null
    && position.kalshiEntryFeeVersion == null
    && position.pmEntryTokenId == null
    && position.pmEntryFeeRateBps == null
    && position.pmEntryFeeSource == null
    && position.pmEntryFeeObservedAt == null
    && position.pmEntryFeeVersion == null;
}

function assertValuationEntryEconomics(position: BotPosition): void {
  // Mark-to-market uses the immutable fee-inclusive Buy Cost recorded in the
  // ledger. Historical per-fill provenance is useful for audit detail but is
  // not required to calculate current P&L from that recorded amount.
  const required = [position.buyPriceKalshiCents, position.buyPricePmCents,
    position.sharesKalshi, position.sharesPm, position.totalCostCents];
  if (!required.every(Number.isSafeInteger)
    || position.sharesKalshi <= 0 || position.sharesPm <= 0
    || position.totalCostCents <= 0) {
    throw new Error(`Missing or malformed recorded Buy Cost for bot position ${position.id}`);
  }
}

function roiBps(pnlCents: number, costCents: number): number {
  if (costCents <= 0) return 0;
  return Math.round((pnlCents * 10_000) / costCents);
}

function fillBidLadder(
  levels: ExecutableBidLevel[] | undefined,
  quantity: number,
  positionId: number,
  venue: 'Kalshi' | 'Polymarket',
): Array<{ priceCents: number; size: number }> {
  if (!Array.isArray(levels)) throw new Error(`${venue} executable bid depth unavailable for bot position ${positionId}`);
  const prices = new Set<number>();
  for (const level of levels) {
    if (!level || typeof level !== 'object'
      || !isExecutablePriceCents(level.priceCents) || level.priceCents <= 0
      || !Number.isFinite(level.size) || level.size <= 0) {
      throw new Error(`Malformed executable bid depth on ${venue} for bot position ${positionId}`);
    }
    if (prices.has(level.priceCents)) {
      throw new Error(`Duplicate executable bid price on ${venue} for bot position ${positionId}`);
    }
    prices.add(level.priceCents);
  }
  const valid = [...levels].sort((a, b) => b.priceCents - a.priceCents);
  let remaining = quantity;
  const fills: Array<{ priceCents: number; size: number }> = [];
  for (const level of valid) {
    if (remaining <= 1e-9) break;
    const size = Math.min(remaining, level.size);
    fills.push({ priceCents: level.priceCents, size });
    remaining -= size;
  }
  if (remaining > 1e-9) {
    throw new Error(`Insufficient executable bid depth on ${venue} for bot position ${positionId}`);
  }
  return fills;
}

function calculateGrossProceedsMicrocents(
  fills: Array<{ priceCents: number; size: number }>,
  venue: 'Kalshi' | 'Polymarket',
): number {
  let numerator = 0n;
  for (const fill of fills) {
    numerator += fixedPoint(fill.priceCents, `${venue} fill price`) * fixedPoint(fill.size, `${venue} fill size`);
  }
  return roundRatio(numerator, FEE_SCALE);
}

function hasAvailableEntryCost(position: Pick<BotPosition, 'entryCostStatus'>): boolean {
  return position.entryCostStatus !== 'unavailable';
}

export function calculatePositionValuation(
  position: BotPosition,
  quote: PositionQuote,
): PositionValuation {
  assertValuationEntryEconomics(position);
  const kalshiPrice = position.kalshiSide === 'yes'
    ? quote.kalshiYesBidCents
    : quote.kalshiNoBidCents;
  const pmPrice = position.pmSide === 'yes'
    ? quote.pmYesBidCents
    : quote.pmNoBidCents;

  if (!isPriceCents(kalshiPrice) || !isPriceCents(pmPrice)) {
    throw new Error(`Missing executable bid for bot position ${position.id}`);
  }

  const expiryMs = quote.expiryDate ? Date.parse(quote.expiryDate) : Number.NaN;
  const observedMs = Date.parse(quote.observedAt);
  const expired = Number.isFinite(expiryMs) && Number.isFinite(observedMs) && expiryMs < observedMs;
  const resolvedComplement =
    (kalshiPrice === 100 && pmPrice === 0) ||
    (kalshiPrice === 0 && pmPrice === 100);
  if (expired && quote.kalshiResolved === true && quote.pmResolved === true && resolvedComplement) {
    const payoutCents = kalshiPrice === 100
      ? position.sharesKalshi * 100
      : position.sharesPm * 100;
    return {
      status: 'settled',
      currentPriceKalshiCents: kalshiPrice,
      currentPricePmCents: pmPrice,
      currentValueCents: payoutCents,
      kalshiGrossProceedsMicrocents: position.sharesKalshi * kalshiPrice * Number(FEE_SCALE),
      pmGrossProceedsMicrocents: position.sharesPm * pmPrice * Number(FEE_SCALE),
      kalshiNetProceedsCents: position.sharesKalshi * kalshiPrice,
      pmNetProceedsCents: position.sharesPm * pmPrice,
      kalshiExitFeeCents: 0,
      pmExitFeeCents: 0,
      unrealizedPnlCents: payoutCents - position.totalCostCents,
      unrealizedRoiBps: roiBps(payoutCents - position.totalCostCents, position.totalCostCents),
      lastValuationAt: quote.observedAt,
      settledAt: quote.observedAt,
      realizedPnlCents: payoutCents - position.totalCostCents,
      settlementSide: kalshiPrice === 100 ? 'kalshi' : 'pm',
    };
  }

  const valuedMs = Date.parse(quote.valuedAt ?? quote.observedAt);
  if (!Number.isFinite(observedMs) || !Number.isFinite(valuedMs)
    || observedMs > valuedMs || valuedMs - observedMs > EXECUTABLE_QUOTE_MAX_AGE_MS) {
    throw new Error(`Stale executable quote for bot position ${position.id}`);
  }

  if (position.pmTheta == null || !Number.isFinite(position.pmTheta)) {
    throw new Error(`Missing authoritative Polymarket theta for bot position ${position.id}`);
  }
  assertCurrentFeeAuthority(position, quote.observedAt);

  const kalshiLevels = position.kalshiSide === 'yes' ? quote.kalshiYesBids : quote.kalshiNoBids;
  const pmLevels = position.pmSide === 'yes' ? quote.pmYesBids : quote.pmNoBids;
  const kalshiFills = fillBidLadder(kalshiLevels, position.sharesKalshi, position.id, 'Kalshi');
  const pmFills = fillBidLadder(pmLevels, position.sharesPm, position.id, 'Polymarket');
  const kalshiGrossProceedsMicrocents = calculateGrossProceedsMicrocents(kalshiFills, 'Kalshi');
  const pmGrossProceedsMicrocents = calculateGrossProceedsMicrocents(pmFills, 'Polymarket');
  const kalshiExitFeeCents = calculateKalshiFeeCents(kalshiFills, position.kalshiExitFeeMultiplierPpm!);
  const pmExitFeeCents = calculatePolymarketFeeCents(pmFills, position.pmExitFeeRateBps!);
  const currentKalshiPrice = Math.round(kalshiGrossProceedsMicrocents / Number(FEE_SCALE) / position.sharesKalshi);
  const currentPmPrice = Math.round(pmGrossProceedsMicrocents / Number(FEE_SCALE) / position.sharesPm);
  const combinedGrossCents = roundRatio(
    BigInt(kalshiGrossProceedsMicrocents + pmGrossProceedsMicrocents),
    FEE_SCALE,
  );
  const currentValueCents = combinedGrossCents - kalshiExitFeeCents - pmExitFeeCents;
  // Allocate the single combined-cent rounding residual deterministically at
  // the ledger boundary without corrupting either venue's precise depth gross.
  const kalshiNetProceedsCents = roundRatio(BigInt(kalshiGrossProceedsMicrocents), FEE_SCALE) - kalshiExitFeeCents;
  const pmNetProceedsCents = currentValueCents - kalshiNetProceedsCents;
  const unrealizedPnlCents = currentValueCents - position.totalCostCents;
  const base: PositionValuation = {
    status: 'open',
    currentPriceKalshiCents: currentKalshiPrice,
    currentPricePmCents: currentPmPrice,
    currentValueCents,
    kalshiGrossProceedsMicrocents,
    pmGrossProceedsMicrocents,
    kalshiNetProceedsCents,
    pmNetProceedsCents,
    kalshiExitFeeCents,
    pmExitFeeCents,
    unrealizedPnlCents,
    unrealizedRoiBps: roiBps(unrealizedPnlCents, position.totalCostCents),
    lastValuationAt: quote.observedAt,
    settledAt: null,
    realizedPnlCents: null,
    settlementSide: null,
  };

  return base;
}

function rowToPosition(row: Record<string, unknown>): BotPosition {
  const executionMode: BotPositionExecutionMode = row.execution_mode === 'live' ? 'live' : 'paper';
  return {
    id: Number(row.id),
    executionId: Number(row.execution_id),
    marketId: row.market_id != null ? String(row.market_id) : null,
    marketTitle: String(row.market_title),
    kalshiTicker: row.kalshi_ticker != null ? String(row.kalshi_ticker) : null,
    pmConditionId: row.pm_condition_id != null ? String(row.pm_condition_id) : null,
    strategy: row.strategy != null ? String(row.strategy) : null,
    kalshiSide: String(row.kalshi_side) as BotPositionSide,
    pmSide: String(row.pm_side) as BotPositionSide,
    buyPriceKalshiCents: Number(row.buy_price_kalshi),
    buyPricePmCents: Number(row.buy_price_pm),
    sharesKalshi: Number(row.shares_kalshi),
    sharesPm: Number(row.shares_pm),
    remainingSharesKalshi: row.live_shares_kalshi != null ? Number(row.live_shares_kalshi) : (row.status === 'open' ? Number(row.shares_kalshi) : 0),
    remainingSharesPm: row.live_shares_pm != null ? Number(row.live_shares_pm) : (row.status === 'open' ? Number(row.shares_pm) : 0),
    remainingOpenPrincipalCents: row.live_principal != null ? Number(row.live_principal) : (row.status === 'open' ? Number(row.total_cost) - Number(row.fees ?? 0) : 0),
    remainingOpenFeesCents: row.live_fees != null ? Number(row.live_fees) : (row.status === 'open' ? Number(row.fees ?? 0) : 0),
    remainingOpenCostCents: row.live_cost != null ? Number(row.live_cost) : (row.status === 'open' ? Number(row.total_cost) : 0),
    totalCostCents: Number(row.total_cost),
    // Legacy rows still contain the fee-inclusive amount recorded as paid.
    // Missing detailed fill provenance does not make that ledger cost unknown.
    entryCostStatus: Number.isSafeInteger(Number(row.total_cost)) && Number(row.total_cost) > 0
      ? 'available'
      : 'unavailable',
    entryCostFailureReason: Number.isSafeInteger(Number(row.total_cost)) && Number(row.total_cost) > 0
      ? null
      : row.entry_cost_failure_reason != null
        ? String(row.entry_cost_failure_reason)
        : 'Recorded Buy Cost is missing or invalid',
    kalshiEntryGrossMicrocents: row.kalshi_entry_gross_microcents != null ? Number(row.kalshi_entry_gross_microcents) : null,
    pmEntryGrossMicrocents: row.pm_entry_gross_microcents != null ? Number(row.pm_entry_gross_microcents) : null,
    entryCostRoundingDeltaMicrocents: row.entry_cost_rounding_delta_microcents != null ? Number(row.entry_cost_rounding_delta_microcents) : null,
    kalshiEntryFillCount: row.kalshi_entry_fill_count != null ? Number(row.kalshi_entry_fill_count) : null,
    pmEntryFillCount: row.pm_entry_fill_count != null ? Number(row.pm_entry_fill_count) : null,
    expectedPayoutCents: Number(row.expected_payout),
    expectedProfitCents: Number(row.expected_profit),
    expectedRoiBps: row.expected_roi_bps != null ? Number(row.expected_roi_bps) : null,
    expectedApyBps: row.expected_apy_bps != null ? Number(row.expected_apy_bps) : null,
    unitId: row.unit_id != null ? String(row.unit_id) : null,
    feesCents: Number(row.fees ?? 0),
    category: row.category != null ? String(row.category) : null,
    pmTheta: row.pm_theta != null ? Number(row.pm_theta) : null,
    kalshiEntryFeeType: row.kalshi_entry_fee_type === 'quadratic' ? 'quadratic' : null,
    kalshiEntryFeeMultiplierPpm: row.kalshi_entry_fee_multiplier_ppm != null ? Number(row.kalshi_entry_fee_multiplier_ppm) : null,
    kalshiEntryFeeSource: row.kalshi_entry_fee_source != null ? String(row.kalshi_entry_fee_source) : null,
    kalshiEntryFeeObservedAt: row.kalshi_entry_fee_observed_at != null ? String(row.kalshi_entry_fee_observed_at) : null,
    kalshiEntryFeeVersion: row.kalshi_entry_fee_version != null ? String(row.kalshi_entry_fee_version) : null,
    pmEntryTokenId: row.pm_entry_token_id != null ? String(row.pm_entry_token_id) : null,
    pmEntryFeeRateBps: row.pm_entry_fee_rate_bps != null ? Number(row.pm_entry_fee_rate_bps) : null,
    pmEntryFeeSource: row.pm_entry_fee_source != null ? String(row.pm_entry_fee_source) : null,
    pmEntryFeeObservedAt: row.pm_entry_fee_observed_at != null ? String(row.pm_entry_fee_observed_at) : null,
    pmEntryFeeVersion: row.pm_entry_fee_version != null ? String(row.pm_entry_fee_version) : null,
    kalshiEntryFeeCents: Number(row.kalshi_entry_fee ?? 0),
    pmEntryFeeCents: Number(row.pm_entry_fee ?? 0),
    kalshiExitFeeType: row.kalshi_exit_fee_type === 'quadratic' ? 'quadratic' : null,
    kalshiExitFeeMultiplierPpm: row.kalshi_exit_fee_multiplier_ppm != null ? Number(row.kalshi_exit_fee_multiplier_ppm) : null,
    kalshiExitFeeSource: row.kalshi_exit_fee_source != null ? String(row.kalshi_exit_fee_source) : null,
    kalshiExitFeeObservedAt: row.kalshi_exit_fee_observed_at != null ? String(row.kalshi_exit_fee_observed_at) : null,
    kalshiExitFeeVersion: row.kalshi_exit_fee_version != null ? String(row.kalshi_exit_fee_version) : null,
    pmExitTokenId: row.pm_exit_token_id != null ? String(row.pm_exit_token_id) : null,
    pmExitFeeRateBps: row.pm_exit_fee_rate_bps != null ? Number(row.pm_exit_fee_rate_bps) : null,
    pmExitFeeSource: row.pm_exit_fee_source != null ? String(row.pm_exit_fee_source) : null,
    pmExitFeeObservedAt: row.pm_exit_fee_observed_at != null ? String(row.pm_exit_fee_observed_at) : null,
    pmExitFeeVersion: row.pm_exit_fee_version != null ? String(row.pm_exit_fee_version) : null,
    status: String(row.status) as BotPositionStatus,
    openedAt: String(row.opened_at),
    expiryDate: row.expiry_date != null ? String(row.expiry_date) : null,
    settledAt: row.settled_at != null ? String(row.settled_at) : null,
    closedAt: row.closed_at != null ? String(row.closed_at) : null,
    currentPriceKalshiCents: row.current_price_kalshi != null ? Number(row.current_price_kalshi) : null,
    currentPricePmCents: row.current_price_pm != null ? Number(row.current_price_pm) : null,
    currentValueCents: row.current_value != null ? Number(row.current_value) : null,
    kalshiGrossProceedsMicrocents: row.kalshi_gross_proceeds_microcents != null ? Number(row.kalshi_gross_proceeds_microcents) : null,
    pmGrossProceedsMicrocents: row.pm_gross_proceeds_microcents != null ? Number(row.pm_gross_proceeds_microcents) : null,
    kalshiNetProceedsCents: row.kalshi_net_proceeds != null ? Number(row.kalshi_net_proceeds) : null,
    pmNetProceedsCents: row.pm_net_proceeds != null ? Number(row.pm_net_proceeds) : null,
    kalshiExitFeeCents: row.kalshi_exit_fee != null ? Number(row.kalshi_exit_fee) : null,
    pmExitFeeCents: row.pm_exit_fee != null ? Number(row.pm_exit_fee) : null,
    unrealizedPnlCents: row.unrealized_pnl != null ? Number(row.unrealized_pnl) : null,
    unrealizedRoiBps: row.unrealized_roi_pct != null ? Number(row.unrealized_roi_pct) : null,
    lastValuationAt: row.last_valuation_at != null ? String(row.last_valuation_at) : null,
    valuationStatus: row.current_value != null && row.current_price_kalshi != null && row.current_price_pm != null
      ? (row.valuation_failure_reason != null ? 'stale' : 'current') : 'unavailable',
    valuationFailureReason: row.valuation_failure_reason != null ? String(row.valuation_failure_reason) : null,
    valuationFailureAt: row.valuation_failure_at != null ? String(row.valuation_failure_at) : null,
    kalshiValuationDepth: row.kalshi_valuation_depth != null ? Number(row.kalshi_valuation_depth) : null,
    pmValuationDepth: row.pm_valuation_depth != null ? Number(row.pm_valuation_depth) : null,
    kalshiLiquidationValueCents: row.kalshi_liquidation_value != null ? Number(row.kalshi_liquidation_value) : null,
    pmLiquidationValueCents: row.pm_liquidation_value != null ? Number(row.pm_liquidation_value) : null,
    kalshiQuoteTimestamp: row.kalshi_quote_timestamp != null ? String(row.kalshi_quote_timestamp) : null,
    pmQuoteTimestamp: row.pm_quote_timestamp != null ? String(row.pm_quote_timestamp) : null,
    kalshiQuoteSource: row.kalshi_quote_source != null ? String(row.kalshi_quote_source) : null,
    pmQuoteSource: row.pm_quote_source != null ? String(row.pm_quote_source) : null,
    realizedPnlCents: row.realized_pnl != null ? Number(row.realized_pnl) : null,
    settlementSide: row.settlement_side != null ? String(row.settlement_side) as SettlementSide : null,
    executionMode,
    dryRun: executionMode === 'paper',
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
        execution_mode TEXT NOT NULL CHECK (execution_mode IN ('paper', 'live')),
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
        live_shares_kalshi INTEGER,
        live_shares_pm INTEGER,
        live_principal INTEGER,
        live_fees INTEGER,
        live_cost INTEGER,
        total_cost INTEGER NOT NULL,
        entry_cost_status TEXT NOT NULL DEFAULT 'unavailable' CHECK (entry_cost_status IN ('available', 'unavailable')),
        entry_cost_failure_reason TEXT,
        kalshi_entry_gross_microcents INTEGER,
        pm_entry_gross_microcents INTEGER,
        entry_cost_rounding_delta_microcents INTEGER,
        kalshi_entry_fill_count INTEGER,
        pm_entry_fill_count INTEGER,
        expected_payout INTEGER NOT NULL,
        expected_profit INTEGER NOT NULL,
        expected_roi_bps INTEGER,
        expected_apy_bps INTEGER,
        unit_id TEXT,
        fees INTEGER NOT NULL DEFAULT 0,
        category TEXT,
        pm_theta REAL,
        kalshi_entry_fee_type TEXT,
        kalshi_entry_fee_multiplier_ppm INTEGER,
        kalshi_entry_fee_source TEXT,
        kalshi_entry_fee_observed_at TEXT,
        kalshi_entry_fee_version TEXT,
        pm_entry_token_id TEXT,
        pm_entry_fee_rate_bps INTEGER,
        pm_entry_fee_source TEXT,
        pm_entry_fee_observed_at TEXT,
        pm_entry_fee_version TEXT,
        kalshi_entry_fee INTEGER NOT NULL DEFAULT 0,
        pm_entry_fee INTEGER NOT NULL DEFAULT 0,
        kalshi_exit_fee_type TEXT,
        kalshi_exit_fee_multiplier_ppm INTEGER,
        kalshi_exit_fee_source TEXT,
        kalshi_exit_fee_observed_at TEXT,
        kalshi_exit_fee_version TEXT,
        pm_exit_token_id TEXT,
        pm_exit_fee_rate_bps INTEGER,
        pm_exit_fee_source TEXT,
        pm_exit_fee_observed_at TEXT,
        pm_exit_fee_version TEXT,
        status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'settled', 'closed')),
        opened_at TEXT NOT NULL,
        expiry_date TEXT,
        settled_at TEXT,
        closed_at TEXT,
        current_price_kalshi INTEGER,
        current_price_pm INTEGER,
        current_value INTEGER,
        kalshi_gross_proceeds_microcents INTEGER,
        pm_gross_proceeds_microcents INTEGER,
        kalshi_net_proceeds INTEGER,
        pm_net_proceeds INTEGER,
        kalshi_exit_fee INTEGER,
        pm_exit_fee INTEGER,
        unrealized_pnl INTEGER,
        unrealized_roi_pct INTEGER,
        last_valuation_at TEXT,
        valuation_failure_reason TEXT,
        valuation_failure_at TEXT,
        kalshi_valuation_depth REAL,
        pm_valuation_depth REAL,
        kalshi_liquidation_value INTEGER,
        pm_liquidation_value INTEGER,
        kalshi_quote_timestamp TEXT,
        pm_quote_timestamp TEXT,
        kalshi_quote_source TEXT,
        pm_quote_source TEXT,
        realized_pnl INTEGER,
        settlement_side TEXT CHECK (settlement_side IN ('kalshi', 'pm') OR settlement_side IS NULL)
        ,selection_method TEXT CHECK (selection_method IN ('roi', 'apy', 'hybrid') OR selection_method IS NULL),
        resolution_source TEXT,
        resolution_verified_at TEXT,
        resolution_outcome TEXT CHECK (resolution_outcome IN ('yes', 'no') OR resolution_outcome IS NULL),
        resolution_payout INTEGER,
        resolution_validation_status TEXT NOT NULL DEFAULT 'pending'
      )
    `);
    // Idempotent migration for installations that created the table from an
    // earlier FEAT-043 draft. SQLite ignores no columns implicitly, so add each
    // missing column explicitly before creating indexes.
    const info = await this.client.execute('PRAGMA table_info(bot_positions)');
    const existing = new Set(info.rows.map((row) => String(row.name)));
    const migrations: Record<string, string> = {
      execution_id: 'INTEGER REFERENCES executions(id)',
      execution_mode: "TEXT NOT NULL DEFAULT 'paper'",
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
      entry_cost_status: "TEXT NOT NULL DEFAULT 'unavailable'",
      entry_cost_failure_reason: 'TEXT',
      kalshi_entry_gross_microcents: 'INTEGER',
      pm_entry_gross_microcents: 'INTEGER',
      entry_cost_rounding_delta_microcents: 'INTEGER',
      kalshi_entry_fill_count: 'INTEGER',
      pm_entry_fill_count: 'INTEGER',
      expected_payout: 'INTEGER NOT NULL DEFAULT 0',
      expected_profit: 'INTEGER NOT NULL DEFAULT 0',
      expected_roi_bps: 'INTEGER',
      expected_apy_bps: 'INTEGER',
      unit_id: 'TEXT',
      fees: 'INTEGER NOT NULL DEFAULT 0',
      category: 'TEXT',
      pm_theta: 'REAL',
      kalshi_entry_fee_type: 'TEXT',
      kalshi_entry_fee_multiplier_ppm: 'INTEGER',
      kalshi_entry_fee_source: 'TEXT',
      kalshi_entry_fee_observed_at: 'TEXT',
      kalshi_entry_fee_version: 'TEXT',
      pm_entry_token_id: 'TEXT',
      pm_entry_fee_rate_bps: 'INTEGER',
      pm_entry_fee_source: 'TEXT',
      pm_entry_fee_observed_at: 'TEXT',
      pm_entry_fee_version: 'TEXT',
      kalshi_entry_fee: 'INTEGER NOT NULL DEFAULT 0',
      pm_entry_fee: 'INTEGER NOT NULL DEFAULT 0',
      kalshi_exit_fee_type: 'TEXT',
      kalshi_exit_fee_multiplier_ppm: 'INTEGER',
      kalshi_exit_fee_source: 'TEXT',
      kalshi_exit_fee_observed_at: 'TEXT',
      kalshi_exit_fee_version: 'TEXT',
      pm_exit_token_id: 'TEXT',
      pm_exit_fee_rate_bps: 'INTEGER',
      pm_exit_fee_source: 'TEXT',
      pm_exit_fee_observed_at: 'TEXT',
      pm_exit_fee_version: 'TEXT',
      status: "TEXT NOT NULL DEFAULT 'open'",
      opened_at: "TEXT NOT NULL DEFAULT ''",
      expiry_date: 'TEXT',
      settled_at: 'TEXT',
      closed_at: 'TEXT',
      current_price_kalshi: 'INTEGER',
      current_price_pm: 'INTEGER',
      current_value: 'INTEGER',
      kalshi_gross_proceeds_microcents: 'INTEGER',
      pm_gross_proceeds_microcents: 'INTEGER',
      kalshi_net_proceeds: 'INTEGER',
      pm_net_proceeds: 'INTEGER',
      kalshi_exit_fee: 'INTEGER',
      pm_exit_fee: 'INTEGER',
      unrealized_pnl: 'INTEGER',
      unrealized_roi_pct: 'INTEGER',
      last_valuation_at: 'TEXT',
      valuation_failure_reason: 'TEXT',
      valuation_failure_at: 'TEXT',
      kalshi_valuation_depth: 'REAL',
      pm_valuation_depth: 'REAL',
      kalshi_liquidation_value: 'INTEGER',
      pm_liquidation_value: 'INTEGER',
      kalshi_quote_timestamp: 'TEXT',
      pm_quote_timestamp: 'TEXT',
      kalshi_quote_source: 'TEXT',
      pm_quote_source: 'TEXT',
      realized_pnl: 'INTEGER',
      settlement_side: 'TEXT',
      selection_method: 'TEXT',
      resolution_source: 'TEXT',
      resolution_verified_at: 'TEXT',
      resolution_outcome: 'TEXT',
      resolution_payout: 'INTEGER',
      resolution_validation_status: "TEXT NOT NULL DEFAULT 'pending'",
    };
    for (const [name, definition] of Object.entries(migrations)) {
      if (!existing.has(name)) {
        await this.client.execute(`ALTER TABLE bot_positions ADD COLUMN ${name} ${definition}`);
      }
    }
    // Fee configuration and rounded prices do not prove the fills or venue-charged
    // fees that produced a legacy total. Only the live execution path marks entry
    // cost available while persisting its authoritative gross/fill evidence.
    await this.client.execute(`
      UPDATE bot_positions SET entry_cost_failure_reason =
        COALESCE(entry_cost_failure_reason, 'Legacy position lacks authoritative entry fill and fee data')
      WHERE entry_cost_status = 'unavailable'
    `);
    // Existing positions predate the denormalized execution-mode identity.
    // Backfill from the authoritative execution record; orphaned legacy rows
    // remain paper so they cannot suppress a live position.
    await this.client.execute(`
      UPDATE bot_positions
      SET execution_mode = CASE
        WHEN COALESCE((SELECT dry_run FROM executions WHERE executions.id = bot_positions.execution_id), 1) = 0 THEN 'live'
        ELSE 'paper'
      END
      WHERE execution_mode IS NULL OR execution_mode NOT IN ('paper', 'live')
         OR execution_mode != CASE
           WHEN COALESCE((SELECT dry_run FROM executions WHERE executions.id = bot_positions.execution_id), 1) = 0 THEN 'live'
           ELSE 'paper'
         END
    `);
    await this.client.execute(`
      CREATE TABLE IF NOT EXISTS bot_position_reservations (
        pair_key TEXT NOT NULL,
        execution_mode TEXT NOT NULL CHECK (execution_mode IN ('paper', 'live')),
        reserved_at TEXT NOT NULL,
        exposure_at_risk INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (pair_key, execution_mode)
      )
    `);
    await this.migrateReservationIdentity();
    await this.client.execute(`CREATE INDEX IF NOT EXISTS idx_bot_positions_status ON bot_positions(status, opened_at DESC)`);
    await this.client.execute(`DROP INDEX IF EXISTS idx_bot_positions_open_pair`);
    // Legacy paper ledgers can already contain duplicate open rows. Keep those
    // positions readable for reconciliation while preventing the duplicate set
    // from growing. A partial UNIQUE index cannot be installed until historical
    // rows are reconciled, and failing schema initialization makes the entire
    // read-only BotTrader page unavailable.
    await this.client.execute(`CREATE TRIGGER IF NOT EXISTS bot_positions_open_pair_insert_guard
      BEFORE INSERT ON bot_positions
      WHEN NEW.status = 'open' AND NEW.kalshi_ticker IS NOT NULL AND NEW.pm_condition_id IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM bot_positions
          WHERE status = 'open' AND execution_mode = NEW.execution_mode
            AND lower(kalshi_ticker) = lower(NEW.kalshi_ticker)
            AND lower(pm_condition_id) = lower(NEW.pm_condition_id)
        )
      BEGIN SELECT RAISE(ABORT, 'An open bot position already exists for this market pair'); END`);
    await this.client.execute(`CREATE TRIGGER IF NOT EXISTS bot_positions_open_pair_update_guard
      BEFORE UPDATE OF status, kalshi_ticker, pm_condition_id, execution_mode ON bot_positions
      WHEN NEW.status = 'open' AND NEW.kalshi_ticker IS NOT NULL AND NEW.pm_condition_id IS NOT NULL
        AND (OLD.status IS NOT NEW.status OR OLD.execution_mode IS NOT NEW.execution_mode
          OR lower(OLD.kalshi_ticker) IS NOT lower(NEW.kalshi_ticker)
          OR lower(OLD.pm_condition_id) IS NOT lower(NEW.pm_condition_id))
        AND EXISTS (
          SELECT 1 FROM bot_positions
          WHERE id != OLD.id AND status = 'open' AND execution_mode = NEW.execution_mode
            AND lower(kalshi_ticker) = lower(NEW.kalshi_ticker)
            AND lower(pm_condition_id) = lower(NEW.pm_condition_id)
        )
      BEGIN SELECT RAISE(ABORT, 'An open bot position already exists for this market pair'); END`);
  }

  private async migrateReservationIdentity(): Promise<void> {
    const initialInfo = await this.client.execute('PRAGMA table_info(bot_position_reservations)');
    const initialColumns = new Set(initialInfo.rows.map((row) => String(row.name)));
    const initialPrimaryKey = initialInfo.rows
      .filter((row) => Number(row.pk) > 0)
      .sort((a, b) => Number(a.pk) - Number(b.pk))
      .map((row) => String(row.name));
    if (initialColumns.has('execution_mode')
        && initialColumns.has('exposure_at_risk')
        && initialPrimaryKey.join(',') === 'pair_key,execution_mode') {
      return;
    }
    const transaction = await this.client.transaction('write');
    try {
      const info = await transaction.execute('PRAGMA table_info(bot_position_reservations)');
      const columns = new Set(info.rows.map((row) => String(row.name)));
      const primaryKey = info.rows
        .filter((row) => Number(row.pk) > 0)
        .sort((a, b) => Number(a.pk) - Number(b.pk))
        .map((row) => String(row.name));
      const currentIdentity = columns.has('execution_mode')
        && primaryKey.join(',') === 'pair_key,execution_mode';
      if (!currentIdentity) {
        await transaction.execute(`ALTER TABLE bot_position_reservations RENAME TO bot_position_reservations_legacy`);
        await transaction.execute(`
          CREATE TABLE bot_position_reservations (
            pair_key TEXT NOT NULL,
            execution_mode TEXT NOT NULL CHECK (execution_mode IN ('paper', 'live')),
            reserved_at TEXT NOT NULL,
            exposure_at_risk INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (pair_key, execution_mode)
          )
        `);
        const exposure = columns.has('exposure_at_risk') ? 'exposure_at_risk' : '0';
        const mode = columns.has('execution_mode')
          ? `CASE WHEN execution_mode = 'live' THEN 'live' ELSE 'paper' END`
          : `'paper'`;
        await transaction.execute(`
          INSERT INTO bot_position_reservations (pair_key, execution_mode, reserved_at, exposure_at_risk)
          SELECT pair_key, ${mode}, reserved_at, ${exposure}
          FROM bot_position_reservations_legacy
        `);
        await transaction.execute(`DROP TABLE bot_position_reservations_legacy`);
      } else if (!columns.has('exposure_at_risk')) {
        await transaction.execute(`ALTER TABLE bot_position_reservations ADD COLUMN exposure_at_risk INTEGER NOT NULL DEFAULT 0`);
      }
      await transaction.commit();
    } finally {
      transaction.close();
    }
  }

  async create(input: CreateBotPosition): Promise<BotPosition> {
    await this.ensureSchema();
    assertShares('sharesKalshi', input.sharesKalshi);
    assertShares('sharesPm', input.sharesPm);
    assertEntryFeeAuthority(input);
    for (const [name, value] of Object.entries({
      buyPriceKalshiCents: input.buyPriceKalshiCents,
      buyPricePmCents: input.buyPricePmCents,
      totalCostCents: input.totalCostCents,
      expectedPayoutCents: input.expectedPayoutCents,
      expectedProfitCents: input.expectedProfitCents,
      feesCents: input.feesCents,
    })) assertMoneyCents(name, value);
    if (!isPriceCents(input.buyPriceKalshiCents) || !isPriceCents(input.buyPricePmCents)) {
      throw new Error('Buy prices must be integer cents from 0 through 100');
    }
    if (await this.hasOpenPair(input.kalshiTicker, input.pmConditionId, input.executionMode)) {
      throw new Error('An open bot position already exists for this market pair');
    }
    const executionPrincipalCents = input.kalshiEntryGrossMicrocents != null && input.pmEntryGrossMicrocents != null
      ? roundRatio(BigInt(input.kalshiEntryGrossMicrocents + input.pmEntryGrossMicrocents), FEE_SCALE)
      : input.buyPriceKalshiCents * input.sharesKalshi + input.buyPricePmCents * input.sharesPm;
    const expectedRoiBps = input.expectedRoiBps
      ?? roiBps(input.expectedProfitCents, input.totalCostCents);

    let result;
    try {
      result = await this.client.execute({
        sql: `INSERT INTO bot_positions (
          execution_id, execution_mode, market_id, market_title, kalshi_ticker, pm_condition_id,
          strategy, kalshi_side, pm_side, buy_price_kalshi, buy_price_pm,
          shares_kalshi, shares_pm, live_shares_kalshi, live_shares_pm,
          live_principal, live_fees, live_cost, total_cost, expected_payout, expected_profit,
          entry_cost_status, entry_cost_failure_reason, kalshi_entry_gross_microcents,
          pm_entry_gross_microcents, entry_cost_rounding_delta_microcents,
          kalshi_entry_fill_count, pm_entry_fill_count,
          expected_roi_bps, expected_apy_bps, unit_id,
          fees, category, pm_theta, kalshi_entry_fee, pm_entry_fee,
          kalshi_entry_fee_type, kalshi_entry_fee_multiplier_ppm, kalshi_entry_fee_source,
          kalshi_entry_fee_observed_at, kalshi_entry_fee_version, pm_entry_token_id,
          pm_entry_fee_rate_bps, pm_entry_fee_source, pm_entry_fee_observed_at, pm_entry_fee_version,
          kalshi_exit_fee_type, kalshi_exit_fee_multiplier_ppm, kalshi_exit_fee_source,
          kalshi_exit_fee_observed_at, kalshi_exit_fee_version, pm_exit_token_id,
          pm_exit_fee_rate_bps, pm_exit_fee_source, pm_exit_fee_observed_at, pm_exit_fee_version,
          status, opened_at, expiry_date, current_price_kalshi,
          current_price_pm, current_value, unrealized_pnl, unrealized_roi_pct,
          last_valuation_at, selection_method
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
          , ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
          'open', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
          input.executionId, input.executionMode, input.marketId, input.marketTitle, input.kalshiTicker,
          input.pmConditionId, input.strategy, input.kalshiSide, input.pmSide,
          input.buyPriceKalshiCents, input.buyPricePmCents, input.sharesKalshi,
          input.sharesPm, input.sharesKalshi, input.sharesPm,
          executionPrincipalCents, input.feesCents, input.totalCostCents,
          input.totalCostCents, input.expectedPayoutCents, input.expectedProfitCents,
          'available', null, input.kalshiEntryGrossMicrocents ?? null, input.pmEntryGrossMicrocents ?? null,
          input.entryCostRoundingDeltaMicrocents ?? null, input.kalshiEntryFillCount ?? 1, input.pmEntryFillCount ?? 1,
          expectedRoiBps, input.expectedApyBps ?? null, input.unitId ?? `execution:${input.executionId}`,
          input.feesCents, input.category, input.pmTheta,
          input.kalshiEntryFeeCents, input.pmEntryFeeCents,
          input.kalshiEntryFeeType, input.kalshiEntryFeeMultiplierPpm, input.kalshiEntryFeeSource,
          input.kalshiEntryFeeObservedAt, input.kalshiEntryFeeVersion, input.pmEntryTokenId,
          input.pmEntryFeeRateBps, input.pmEntryFeeSource, input.pmEntryFeeObservedAt, input.pmEntryFeeVersion,
          input.kalshiExitFeeType, input.kalshiExitFeeMultiplierPpm, input.kalshiExitFeeSource,
          input.kalshiExitFeeObservedAt, input.kalshiExitFeeVersion, input.pmExitTokenId,
          input.pmExitFeeRateBps, input.pmExitFeeSource, input.pmExitFeeObservedAt, input.pmExitFeeVersion,
          input.openedAt,
          input.expiryDate, null, null, null, null, null, null,
          input.selectionMethod ?? null,
        ],
      });
    } catch (error) {
      if (String(error).includes('UNIQUE constraint failed')) {
        throw new Error('An open bot position already exists for this market pair');
      }
      throw error;
    }
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

  async hasOpenPair(kalshiTicker: string | null, pmConditionId: string | null, executionMode: BotPositionExecutionMode): Promise<boolean> {
    await this.ensureSchema();
    if (!kalshiTicker || !pmConditionId) return false;
    const result = await this.client.execute({
      sql: `SELECT 1 FROM bot_positions WHERE status = 'open' AND execution_mode = ? AND lower(kalshi_ticker) = lower(?) AND lower(pm_condition_id) = lower(?) LIMIT 1`,
      args: [executionMode, kalshiTicker, pmConditionId],
    });
    return result.rows.length > 0;
  }

  private pairKey(kalshiTicker: string, pmConditionId: string): string {
    return `${kalshiTicker.trim().toLowerCase()}\u0000${pmConditionId.trim().toLowerCase()}`;
  }

  async reservePair(kalshiTicker: string, pmConditionId: string, executionMode: BotPositionExecutionMode): Promise<boolean> {
    await this.ensureSchema();
    // Automatic live orders are hard-disabled; a 10-minute lease recovers paper
    // reservations after process crashes while remaining far longer than the
    // 15-second execution timeout.
    const staleBefore = new Date(Date.now() - 10 * 60_000).toISOString();
    await this.client.execute({
      sql: `DELETE FROM bot_position_reservations WHERE reserved_at < ? AND exposure_at_risk = 0`,
      args: [staleBefore],
    });
    if (await this.hasOpenPair(kalshiTicker, pmConditionId, executionMode)) return false;
    try {
      await this.client.execute({
        sql: `INSERT INTO bot_position_reservations (pair_key, execution_mode, reserved_at, exposure_at_risk) VALUES (?, ?, ?, ?)`,
        args: [this.pairKey(kalshiTicker, pmConditionId), executionMode, new Date().toISOString(), executionMode === 'live' ? 1 : 0],
      });
      // Close the narrow gap between the precheck and reservation insert: a
      // prior reservation may have committed its position and released while
      // this caller waited on SQLite's writer lock.
      if (await this.hasOpenPair(kalshiTicker, pmConditionId, executionMode)) {
        await this.releasePair(kalshiTicker, pmConditionId, executionMode);
        return false;
      }
      return true;
    } catch (error) {
      if (String(error).includes('UNIQUE constraint failed')) return false;
      throw error;
    }
  }

  async releasePair(kalshiTicker: string, pmConditionId: string, executionMode: BotPositionExecutionMode): Promise<void> {
    await this.ensureSchema();
    await this.client.execute({
      sql: `DELETE FROM bot_position_reservations WHERE pair_key = ? AND execution_mode = ?`,
      args: [this.pairKey(kalshiTicker, pmConditionId), executionMode],
    });
  }

  async retainPairForExposure(kalshiTicker: string, pmConditionId: string, executionMode: BotPositionExecutionMode): Promise<void> {
    await this.ensureSchema();
    await this.client.execute({
      sql: `UPDATE bot_position_reservations SET exposure_at_risk = 1 WHERE pair_key = ? AND execution_mode = ?`,
      args: [this.pairKey(kalshiTicker, pmConditionId), executionMode],
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

  async list(options: { status?: BotPositionStatus | 'all'; limit?: number; offset?: number; verifiedOnly?: boolean } = {}): Promise<BotPosition[]> {
    await this.ensureSchema();
    const status = options.status ?? 'all';
    const limit = Math.min(1000, Math.max(1, Math.trunc(options.limit ?? 100)));
    const offset = Math.max(0, Math.trunc(options.offset ?? 0));
    const clauses = [
      ...(status === 'all' ? [] : ['bp.status = ?']),
      ...(options.verifiedOnly ? ["e.source = 'bot'"] : []),
    ];
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const args: Array<string | number> = status === 'all' ? [limit, offset] : [status, limit, offset];
    const result = await this.client.execute({
      sql: `SELECT bp.*, e.dry_run FROM bot_positions bp LEFT JOIN executions e ON e.id = bp.execution_id ${where} ORDER BY bp.opened_at DESC LIMIT ? OFFSET ?`,
      args,
    });
    return result.rows.map((row) => rowToPosition(row as Record<string, unknown>));
  }

  async listAllForAnalytics(options: { mode?: 'all' | 'paper' | 'production' } = {}): Promise<BotPosition[]> {
    await this.ensureSchema();
    const mode = options.mode ?? 'all';
    const where = mode === 'all'
      ? `WHERE e.source = 'bot'`
      : `WHERE e.source = 'bot' AND e.dry_run = ?`;
    const args: Array<number> = mode === 'all' ? [] : [mode === 'paper' ? 1 : 0];
    const result = await this.client.execute({ sql: `
      SELECT bp.*, e.dry_run
      FROM bot_positions bp
      INNER JOIN executions e ON e.id = bp.execution_id
      ${where}
      ORDER BY bp.opened_at DESC
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
    await this.client.execute({
      sql: `UPDATE bot_positions SET
        status = ?, current_price_kalshi = ?, current_price_pm = ?,
        current_value = ?,
        kalshi_gross_proceeds_microcents = ?, pm_gross_proceeds_microcents = ?,
        kalshi_net_proceeds = ?, pm_net_proceeds = ?,
        kalshi_exit_fee = ?, pm_exit_fee = ?,
        unrealized_pnl = ?, unrealized_roi_pct = ?,
        valuation_failure_reason = NULL, valuation_failure_at = NULL,
        last_valuation_at = ?, settled_at = ?, realized_pnl = ?, settlement_side = ?,
        resolution_source = ?, resolution_verified_at = ?, resolution_outcome = ?,
        resolution_payout = ?, resolution_validation_status = ?
        WHERE id = ? AND status = 'open'
          AND (last_valuation_at IS NULL OR last_valuation_at <= ?)`,
      args: [
        valuation.status, valuation.currentPriceKalshiCents,
        valuation.currentPricePmCents, valuation.currentValueCents,
        valuation.kalshiGrossProceedsMicrocents, valuation.pmGrossProceedsMicrocents,
        valuation.kalshiNetProceedsCents, valuation.pmNetProceedsCents,
        valuation.kalshiExitFeeCents, valuation.pmExitFeeCents,
        valuation.unrealizedPnlCents, valuation.unrealizedRoiBps,
        valuation.lastValuationAt, valuation.settledAt,
        valuation.realizedPnlCents, valuation.settlementSide,
        valuation.status === 'settled' ? 'kalshi_market_settlement+polymarket_clob_market' : null,
        valuation.status === 'settled' ? valuation.settledAt : null,
        valuation.status === 'settled' ? (valuation.currentPriceKalshiCents === 100 ? 'yes' : 'no') : null,
        valuation.status === 'settled' ? valuation.currentValueCents : null,
        valuation.status === 'settled' ? 'verified' : 'pending', id,
        valuation.lastValuationAt,
      ],
    });
  }

  async updateExitFeeConfig(
    id: number,
    kalshi: AuthoritativeKalshiFeeConfig,
    polymarket: AuthoritativePolymarketFeeConfig,
  ): Promise<void> {
    await this.ensureSchema();
    await this.client.execute({
      sql: `UPDATE bot_positions SET
        kalshi_exit_fee_type = ?, kalshi_exit_fee_multiplier_ppm = ?,
        kalshi_exit_fee_source = ?, kalshi_exit_fee_observed_at = ?, kalshi_exit_fee_version = ?,
        pm_exit_token_id = ?, pm_exit_fee_rate_bps = ?, pm_exit_fee_source = ?,
        pm_exit_fee_observed_at = ?, pm_exit_fee_version = ?
        WHERE id = ? AND status = 'open'`,
      args: [
        kalshi.feeType, kalshi.feeMultiplierPpm, kalshi.source, kalshi.observedAt, kalshi.version,
        polymarket.tokenId, polymarket.feeRateBps, polymarket.source, polymarket.observedAt, polymarket.version,
        id,
      ],
    });
  }

  async updateValuationWithFeeConfig(
    id: number,
    valuation: PositionValuation,
    kalshi: AuthoritativeKalshiFeeConfig,
    polymarket: AuthoritativePolymarketFeeConfig,
  ): Promise<void> {
    await this.ensureSchema();
    await this.client.execute({
      sql: `UPDATE bot_positions SET
        kalshi_exit_fee_type = ?, kalshi_exit_fee_multiplier_ppm = ?,
        kalshi_exit_fee_source = ?, kalshi_exit_fee_observed_at = ?, kalshi_exit_fee_version = ?,
        pm_exit_token_id = ?, pm_exit_fee_rate_bps = ?, pm_exit_fee_source = ?,
        pm_exit_fee_observed_at = ?, pm_exit_fee_version = ?,
        status = ?, current_price_kalshi = ?, current_price_pm = ?,
        current_value = ?,
        kalshi_gross_proceeds_microcents = ?, pm_gross_proceeds_microcents = ?,
        kalshi_net_proceeds = ?, pm_net_proceeds = ?,
        kalshi_exit_fee = ?, pm_exit_fee = ?,
        unrealized_pnl = ?, unrealized_roi_pct = ?,
        valuation_failure_reason = NULL, valuation_failure_at = NULL, last_valuation_at = ?,
        settled_at = ?, realized_pnl = ?, settlement_side = ?,
        resolution_source = NULL, resolution_verified_at = NULL,
        resolution_outcome = NULL, resolution_payout = NULL,
        resolution_validation_status = 'pending'
        WHERE id = ? AND status = 'open'
          AND (pm_entry_token_id = ? OR (execution_mode = 'paper' AND pm_entry_token_id IS NULL))
          AND (last_valuation_at IS NULL OR last_valuation_at <= ?)`,
      args: [
        kalshi.feeType, kalshi.feeMultiplierPpm, kalshi.source, kalshi.observedAt, kalshi.version,
        polymarket.tokenId, polymarket.feeRateBps, polymarket.source, polymarket.observedAt, polymarket.version,
        valuation.status, valuation.currentPriceKalshiCents, valuation.currentPricePmCents,
        valuation.currentValueCents,
        valuation.kalshiGrossProceedsMicrocents, valuation.pmGrossProceedsMicrocents,
        valuation.kalshiNetProceedsCents, valuation.pmNetProceedsCents,
        valuation.kalshiExitFeeCents, valuation.pmExitFeeCents,
        valuation.unrealizedPnlCents, valuation.unrealizedRoiBps, valuation.lastValuationAt,
        valuation.settledAt, valuation.realizedPnlCents, valuation.settlementSide,
        id, polymarket.tokenId, valuation.lastValuationAt,
      ],
    });
  }

  async clearOpenValuation(id: number, attemptedAt: string, reason = 'Valuation unavailable: refresh failed'): Promise<void> {
    await this.ensureSchema();
    await this.client.execute({
      sql: `UPDATE bot_positions SET
        current_price_kalshi = NULL, current_price_pm = NULL, current_value = NULL,
        kalshi_gross_proceeds_microcents = NULL, pm_gross_proceeds_microcents = NULL,
        kalshi_net_proceeds = NULL, pm_net_proceeds = NULL,
        kalshi_exit_fee = NULL, pm_exit_fee = NULL,
        unrealized_pnl = NULL, unrealized_roi_pct = NULL, last_valuation_at = ?,
        valuation_failure_reason = ?, valuation_failure_at = ?
        WHERE id = ? AND status = 'open'
          AND (last_valuation_at IS NULL OR last_valuation_at <= ?)`,
      args: [attemptedAt, reason, attemptedAt, id, attemptedAt],
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
  executionMode: BotPositionExecutionMode;
  pairId: string;
  marketTitle: string;
  kalshiTicker: string | null;
  pmConditionId: string | null;
  strategy: string;
  kalshiSide: BotPositionSide;
  pmSide: BotPositionSide;
  kalshiPrice: number;
  pmPrice: number;
  kalshiContracts: number;
  pmContracts: number;
  expectedProfit: number;
  expiryDate?: string | null;
  selectionMethod?: BotSelectionMethod | null;
  category?: string | null;
  kalshiFills?: Array<{ priceCents: number; size: number }>;
  pmFills?: Array<{ priceCents: number; size: number }>;
  kalshiChargedFeeCents?: number;
  pmChargedFeeCents?: number;
}

export function calculateBotPositionEntryCost(input: {
  buyPriceKalshiCents?: number;
  buyPricePmCents?: number;
  sharesKalshi?: number;
  sharesPm?: number;
  kalshiFills?: Array<{ priceCents: number; size: number }>;
  pmFills?: Array<{ priceCents: number; size: number }>;
  kalshiChargedFeeCents?: number;
  pmChargedFeeCents?: number;
  pmTheta: number;
  kalshiFeeMultiplierPpm: number;
  pmFeeRateBps: number;
}): {
  kalshiEntryFeeCents: number;
  pmEntryFeeCents: number;
  totalCostCents: number;
  kalshiGrossEntryMicrocents: number;
  pmGrossEntryMicrocents: number;
  roundingDeltaMicrocents: number;
} {
  const expectedPmFeeRateBps = Math.round(input.pmTheta * 10_000);
  if (!Number.isSafeInteger(expectedPmFeeRateBps) || expectedPmFeeRateBps !== input.pmFeeRateBps) {
    throw new Error('Conflicting authoritative Polymarket entry fee configuration');
  }
  const kalshiFills = input.kalshiFills ?? [{ size: input.sharesKalshi!, priceCents: input.buyPriceKalshiCents! }];
  const pmFills = input.pmFills ?? [{ size: input.sharesPm!, priceCents: input.buyPricePmCents! }];
  const calculatedKalshiFeeCents = calculateKalshiFeeCents(kalshiFills, input.kalshiFeeMultiplierPpm);
  const calculatedPmFeeCents = calculatePolymarketFeeCents(pmFills, input.pmFeeRateBps);
  if (input.kalshiChargedFeeCents != null && (!Number.isSafeInteger(input.kalshiChargedFeeCents) || input.kalshiChargedFeeCents < 0)) {
    throw new Error('Malformed authoritative Kalshi charged fee');
  }
  if (input.pmChargedFeeCents != null && (!Number.isSafeInteger(input.pmChargedFeeCents) || input.pmChargedFeeCents < 0)) {
    throw new Error('Malformed authoritative Polymarket charged fee');
  }
  const kalshiEntryFeeCents = input.kalshiChargedFeeCents ?? calculatedKalshiFeeCents;
  const pmEntryFeeCents = input.pmChargedFeeCents ?? calculatedPmFeeCents;
  const kalshiGrossEntryMicrocents = calculateGrossProceedsMicrocents(kalshiFills, 'Kalshi');
  const pmGrossEntryMicrocents = calculateGrossProceedsMicrocents(pmFills, 'Polymarket');
  const grossEntryMicrocents = kalshiGrossEntryMicrocents + pmGrossEntryMicrocents;
  const grossEntryCents = roundRatio(BigInt(grossEntryMicrocents), FEE_SCALE);
  const totalCostCents = grossEntryCents + kalshiEntryFeeCents + pmEntryFeeCents;
  return {
    kalshiEntryFeeCents,
    pmEntryFeeCents,
    totalCostCents,
    kalshiGrossEntryMicrocents,
    pmGrossEntryMicrocents,
    roundingDeltaMicrocents: totalCostCents * Number(FEE_SCALE)
      - grossEntryMicrocents - (kalshiEntryFeeCents + pmEntryFeeCents) * Number(FEE_SCALE),
  };
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
  category?: string;
  observedAt?: string;
}, dependencies?: {
  fetchJson?: (url: string) => Promise<Record<string, unknown>>;
  fetchPmMarket?: (conditionId: string) => Promise<{
    tokens: Array<{ token_id?: unknown; outcome?: unknown }>;
  } | null>;
}): Promise<AuthoritativeBotFeeConfig> {
  if (input.observedAt != null && !Number.isFinite(Date.parse(input.observedAt))) {
    throw new Error('Malformed fee observation timestamp');
  }
  const getJson = dependencies?.fetchJson ?? fetchFeeJson;
  const marketPayload = await getJson(
    `https://external-api.kalshi.com/trade-api/v2/markets/${encodeURIComponent(input.kalshiTicker)}`,
  );
  const market = marketPayload.market;
  const eventTicker = market && typeof market === 'object' && !Array.isArray(market)
    ? (market as Record<string, unknown>).event_ticker
    : null;
  if (typeof eventTicker !== 'string' || !eventTicker.trim()) throw new Error('Kalshi market is missing authoritative event metadata');
  const eventPayload = await getJson(
    `https://external-api.kalshi.com/trade-api/v2/events/${encodeURIComponent(eventTicker)}`,
  );
  const event = eventPayload.event;
  if (!event || typeof event !== 'object' || Array.isArray(event)) throw new Error('Malformed Kalshi event fee metadata');
  const eventRecord = event as Record<string, unknown>;
  const seriesTicker = eventRecord.series_ticker;
  if (typeof seriesTicker !== 'string' || !seriesTicker.trim()) throw new Error('Kalshi event is missing authoritative series metadata');
  const seriesPayload = await getJson(
    `https://external-api.kalshi.com/trade-api/v2/series/${encodeURIComponent(seriesTicker)}`,
  );
  const series = seriesPayload.series;
  if (!series || typeof series !== 'object' || Array.isArray(series)) throw new Error('Malformed Kalshi series fee metadata');
  const seriesRecord = series as Record<string, unknown>;
  const overrideType = eventRecord.fee_type_override;
  const overrideMultiplier = eventRecord.fee_multiplier_override;
  const hasOverride = overrideType != null || overrideMultiplier != null;
  if (hasOverride && (overrideType == null || overrideMultiplier == null)) {
    throw new Error('Conflicting Kalshi event fee override');
  }
  const upstreamFeeType = hasOverride ? overrideType : seriesRecord.fee_type;
  const feeMultiplier = hasOverride ? overrideMultiplier : seriesRecord.fee_multiplier;
  const supportedQuadraticFee = upstreamFeeType === 'quadratic' || upstreamFeeType === 'quadratic_with_maker_fees';
  if (!supportedQuadraticFee || typeof feeMultiplier !== 'number' || !Number.isFinite(feeMultiplier)
    || feeMultiplier < 0 || feeMultiplier > 10) {
    throw new Error('Missing, malformed, or unsupported authoritative Kalshi fee configuration');
  }
  // Selling at the best bid is a taker action. Both supported schedules use
  // the same quadratic taker formula; maker fees do not apply here.
  const feeType = 'quadratic' as const;
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
    const matchingTokens = pmMarket.tokens.filter((token): token is { token_id: string; outcome: string } =>
      token != null && typeof token.token_id === 'string'
      && typeof token.outcome === 'string' && token.outcome.toLowerCase() === input.pmSide);
    if (matchingTokens.length !== 1 || !matchingTokens[0].token_id.trim()) {
      throw new Error('Polymarket held token fee metadata is missing or ambiguous');
    }
    tokenId = matchingTokens[0].token_id.trim();
  }
  const pmFeePayload = await getJson(
    `https://clob.polymarket.com/fee-rate?token_id=${encodeURIComponent(tokenId)}`,
  );
  const feeRateBps = pmFeePayload.base_fee;
  if (typeof feeRateBps !== 'number' || !Number.isSafeInteger(feeRateBps) || feeRateBps < 0 || feeRateBps > 10_000) {
    throw new Error('Missing or malformed authoritative Polymarket token fee rate');
  }
  // The token endpoint is the current executable fee authority; category
  // classifications can lag venue fee-policy changes.
  const pmTheta = feeRateBps / 10_000;
  const observedAt = input.observedAt ?? new Date().toISOString();
  return {
    kalshi: {
      feeType,
      feeMultiplierPpm,
      source: hasOverride
        ? `https://external-api.kalshi.com/trade-api/v2/events/${encodeURIComponent(eventTicker)}`
        : `https://external-api.kalshi.com/trade-api/v2/series/${encodeURIComponent(seriesTicker)}`,
      observedAt,
      version: `${String(upstreamFeeType)}:${feeMultiplierPpm}:${String(hasOverride
        ? eventRecord.last_updated_ts ?? 'upstream-version-unavailable'
        : seriesRecord.last_updated_ts ?? 'upstream-version-unavailable')}`,
    },
    polymarket: {
      tokenId,
      feeRateBps,
      source: `https://clob.polymarket.com/fee-rate?token_id=${encodeURIComponent(tokenId)}`,
      observedAt,
      version: `token-fee-rate:${feeRateBps}`,
    },
    pmTheta,
  };
}

export async function recordBotPosition(
  input: BotPositionInput,
  feeAuthority: AuthoritativeBotFeeConfig,
): Promise<void> {
  if (!input.category?.trim()) throw new Error('Missing authoritative market category for Polymarket fee calculation');
  if (!input.kalshiTicker || !input.pmConditionId) throw new Error('Missing venue identifiers for authoritative fee lookup');
  const openedAt = new Date().toISOString();
  assertCurrentFeeAuthority({
    id: 0,
    pmTheta: feeAuthority.pmTheta,
    pmEntryTokenId: feeAuthority.polymarket.tokenId,
    kalshiExitFeeType: feeAuthority.kalshi.feeType,
    kalshiExitFeeMultiplierPpm: feeAuthority.kalshi.feeMultiplierPpm,
    kalshiExitFeeSource: feeAuthority.kalshi.source,
    kalshiExitFeeObservedAt: feeAuthority.kalshi.observedAt,
    kalshiExitFeeVersion: feeAuthority.kalshi.version,
    pmExitTokenId: feeAuthority.polymarket.tokenId,
    pmExitFeeRateBps: feeAuthority.polymarket.feeRateBps,
    pmExitFeeSource: feeAuthority.polymarket.source,
    pmExitFeeObservedAt: feeAuthority.polymarket.observedAt,
    pmExitFeeVersion: feeAuthority.polymarket.version,
  } as BotPosition, openedAt);
  const authority = feeAuthority;
  const { pmTheta } = authority;
  const buyPriceKalshiCents = Math.round(input.kalshiPrice * 100);
  const buyPricePmCents = Math.round(input.pmPrice * 100);
  const sharesKalshi = input.kalshiContracts;
  const sharesPm = input.pmContracts;
  const entryCost = calculateBotPositionEntryCost({
    buyPriceKalshiCents,
    buyPricePmCents,
    sharesKalshi,
    sharesPm,
    kalshiFills: input.kalshiFills,
    pmFills: input.pmFills,
    kalshiChargedFeeCents: input.kalshiChargedFeeCents,
    pmChargedFeeCents: input.pmChargedFeeCents,
    pmTheta,
    kalshiFeeMultiplierPpm: authority.kalshi.feeMultiplierPpm,
    pmFeeRateBps: authority.polymarket.feeRateBps,
  });
  const { kalshiEntryFeeCents, pmEntryFeeCents, totalCostCents } = entryCost;
  const expectedPayoutCents = Math.min(sharesKalshi, sharesPm) * 100;
  const expectedProfitCents = expectedPayoutCents - totalCostCents;

  await createBotPosition({
    executionId: input.executionId,
    executionMode: input.executionMode,
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
    kalshiEntryGrossMicrocents: entryCost.kalshiGrossEntryMicrocents,
    pmEntryGrossMicrocents: entryCost.pmGrossEntryMicrocents,
    entryCostRoundingDeltaMicrocents: entryCost.roundingDeltaMicrocents,
    kalshiEntryFillCount: input.kalshiFills?.length ?? 1,
    pmEntryFillCount: input.pmFills?.length ?? 1,
    expectedPayoutCents,
    expectedProfitCents,
    feesCents: kalshiEntryFeeCents + pmEntryFeeCents,
    category: input.category,
    pmTheta,
    kalshiEntryFeeType: authority.kalshi.feeType,
    kalshiEntryFeeMultiplierPpm: authority.kalshi.feeMultiplierPpm,
    kalshiEntryFeeSource: authority.kalshi.source,
    kalshiEntryFeeObservedAt: authority.kalshi.observedAt,
    kalshiEntryFeeVersion: authority.kalshi.version,
    pmEntryTokenId: authority.polymarket.tokenId,
    pmEntryFeeRateBps: authority.polymarket.feeRateBps,
    pmEntryFeeSource: authority.polymarket.source,
    pmEntryFeeObservedAt: authority.polymarket.observedAt,
    pmEntryFeeVersion: authority.polymarket.version,
    kalshiEntryFeeCents,
    pmEntryFeeCents,
    kalshiExitFeeType: authority.kalshi.feeType,
    kalshiExitFeeMultiplierPpm: authority.kalshi.feeMultiplierPpm,
    kalshiExitFeeSource: authority.kalshi.source,
    kalshiExitFeeObservedAt: authority.kalshi.observedAt,
    kalshiExitFeeVersion: authority.kalshi.version,
    pmExitTokenId: authority.polymarket.tokenId,
    pmExitFeeRateBps: authority.polymarket.feeRateBps,
    pmExitFeeSource: authority.polymarket.source,
    pmExitFeeObservedAt: authority.polymarket.observedAt,
    pmExitFeeVersion: authority.polymarket.version,
    openedAt,
    expiryDate: input.expiryDate ?? null,
    selectionMethod: input.selectionMethod ?? null,
  });
}

export async function hasOpenBotMarketPair(kalshiTicker: string | null, pmConditionId: string | null, executionMode: BotPositionExecutionMode): Promise<boolean> {
  return store().hasOpenPair(kalshiTicker, pmConditionId, executionMode);
}

export async function reserveBotMarketPair(kalshiTicker: string, pmConditionId: string, executionMode: BotPositionExecutionMode): Promise<boolean> {
  return store().reservePair(kalshiTicker, pmConditionId, executionMode);
}

export async function retainBotMarketPairForExposure(kalshiTicker: string, pmConditionId: string, executionMode: BotPositionExecutionMode): Promise<void> {
  return store().retainPairForExposure(kalshiTicker, pmConditionId, executionMode);
}

export async function releaseBotMarketPair(kalshiTicker: string, pmConditionId: string, executionMode: BotPositionExecutionMode): Promise<void> {
  return store().releasePair(kalshiTicker, pmConditionId, executionMode);
}

export async function getBotPositions(options: { status?: BotPositionStatus | 'all'; limit?: number; offset?: number } = {}): Promise<BotPosition[]> {
  return store().list({ ...options, verifiedOnly: true });
}

export async function getBotPositionMarkets(options: {
  status?: 'all' | 'open' | 'settled';
  limit?: number;
  cursor?: string | null;
} = {}): Promise<{ marketCount: number; markets: BotPositionMarket[]; nextCursor: string | null; positions: BotExecution[] }> {
  return store().listMarkets(options);
}

export interface BotPositionAnalytics {
  positions: BotPosition[];
  totalBotTrades: { paper: number; production: number; total: number };
  openPositions: { count: number; unrealizedPnlCents: number | null };
  settledPositions: { count: number; realizedPnlCents: number; winRateBps: number };
  averageRoi: { atTradeBps: number; currentBps: number | null };
  bestTrade: BotPosition | null;
  worstTrade: BotPosition | null;
  dailyPnl: Array<{ date: string; realizedPnlCents: number; unrealizedPnlCents: number | null; trades: number }>;
  dailyPnlByMethod: Record<BotSelectionMethod, Array<{ date: string; realizedPnlCents: number; unrealizedPnlCents: number | null; trades: number }>>;
  timeStats: { tradesPerDayBps: number; averageHoldSeconds: number };
  filter: { method: 'all' | BotSelectionMethod | 'legacy'; mode: 'all' | 'paper' | 'production' };
  perMethod: Record<BotSelectionMethod | 'legacy', {
    tradeCount: number; deployedCapitalCents: number | null; realizedPnlCents: number;
    unrealizedPnlCents: number | null; winRateBps: number; averageEntryRoiBps: number | null;
    currentRoiBps: number | null; averageApyPct: number | null;
  }>;
  performance: BotPerformanceSummary;
}

export interface BotPerformanceSummary {
  positionIds: number[];
  capital: { deployedCents: number | null; currentCents: number; heldToResolutionCents: number; excludedOpenCostCents: number };
  entryCost: { available: number; unavailable: number };
  pnl: { realizedCents: number; unrealizedCents: number | null; totalCents: number | null; roiBps: number | null };
  valuation: { fresh: number; stale: number; unavailable: number; pendingSettlement: number; asOf: string | null };
  entryCohorts: Array<{
    date: string; deployedCents: number | null; currentCents: number | null; heldToResolutionCents: number;
    realizedCents: number; unrealizedCents: number | null; trades: number;
  }>;
}

const BOT_VALUATION_STALE_MS = 15 * 60_000;

function botPositionMark(position: BotPosition, nowMs: number): 'fresh' | 'stale' | 'unavailable' {
  if (position.currentValueCents == null || !position.lastValuationAt) return 'unavailable';
  const observedMs = Date.parse(position.lastValuationAt);
  if (!Number.isFinite(observedMs)) return 'unavailable';
  return nowMs - observedMs > BOT_VALUATION_STALE_MS ? 'stale' : 'fresh';
}

function isTerminalPosition(position: BotPosition): boolean {
  return position.status === 'settled' || position.status === 'closed';
}

function hasVerifiedTerminalAccounting(position: BotPosition): boolean {
  return isTerminalPosition(position)
    && position.resolutionValidationStatus === 'verified'
    && Number.isSafeInteger(position.resolutionPayoutCents)
    && Number.isSafeInteger(position.realizedPnlCents)
    && position.resolutionPayoutCents! - position.totalCostCents === position.realizedPnlCents;
}

export function summarizeBotPerformance(rows: BotPosition[], now = new Date()): BotPerformanceSummary {
  const total = (values: number[]) => values.reduce((sum, value) => sum + value, 0);
  const nowMs = now.getTime();
  const open = rows.filter((position) => position.status === 'open');
  const verifiedSettled = rows.filter(hasVerifiedTerminalAccounting);
  const unverifiedSettled = rows.filter((position) => isTerminalPosition(position) && !hasVerifiedTerminalAccounting(position));
  const mark = (position: BotPosition) => botPositionMark(position, nowMs);
  const freshOpen = open.filter((position) => mark(position) === 'fresh');
  const stale = open.filter((position) => mark(position) === 'stale').length;
  const unavailable = open.filter((position) => mark(position) === 'unavailable').length;
  const unavailableEntryCosts = rows.filter((position) => !hasAvailableEntryCost(position)).length;
  const allEntryCostsAvailable = unavailableEntryCosts === 0;
  const realizedCents = total(verifiedSettled.map((position) => position.realizedPnlCents!));
  const valuedOpen = freshOpen.filter(hasAvailableEntryCost);
  const unrealizedCents = open.length > 0 && valuedOpen.length === 0
    ? null
    : total(valuedOpen.map((position) => position.currentValueCents! - position.totalCostCents));
  const totalCents = unrealizedCents == null || unverifiedSettled.length > 0 ? null : realizedCents + unrealizedCents;
  const deployedCents = allEntryCostsAvailable ? total(rows.map((position) => position.totalCostCents)) : null;
  const currentCents = total(freshOpen.map((position) => position.currentValueCents!))
    + total(verifiedSettled.map((position) => position.resolutionPayoutCents!));
  const valuedCostCents = total(valuedOpen.map((position) => position.totalCostCents))
    + total(verifiedSettled.map((position) => position.totalCostCents));
  const excludedOpenCostCents = total(open.filter((position) => mark(position) !== 'fresh' || !hasAvailableEntryCost(position)).map((position) => position.totalCostCents));
  const oldestFreshMs = freshOpen.reduce((oldest, position) => Math.min(oldest, Date.parse(position.lastValuationAt!)), Number.POSITIVE_INFINITY);
  const dates = new Map<string, BotPerformanceSummary['entryCohorts'][number] & { incomplete: boolean }>();
  for (const position of rows) {
    const openedAt = new Date(position.openedAt);
    const date = [openedAt.getFullYear(), String(openedAt.getMonth() + 1).padStart(2, '0'), String(openedAt.getDate()).padStart(2, '0')].join('-');
    const point = dates.get(date) ?? { date, deployedCents: 0, currentCents: 0, heldToResolutionCents: 0, realizedCents: 0, unrealizedCents: 0, trades: 0, incomplete: false };
    point.deployedCents = point.deployedCents == null || !hasAvailableEntryCost(position)
      ? null
      : point.deployedCents + position.totalCostCents;
    point.trades += 1;
    if (position.status === 'open') {
      point.heldToResolutionCents += position.expectedPayoutCents;
      if (mark(position) === 'fresh') {
        point.currentCents! += position.currentValueCents!;
        point.unrealizedCents = !hasAvailableEntryCost(position) || point.unrealizedCents == null
          ? null
          : point.unrealizedCents + position.currentValueCents! - position.totalCostCents;
      }
    } else if (hasVerifiedTerminalAccounting(position)) {
      point.currentCents! += position.resolutionPayoutCents!;
      point.realizedCents += position.realizedPnlCents!;
    } else {
      point.incomplete = true;
    }
    dates.set(date, point);
  }
  const entryCohorts = [...dates.values()].sort((a, b) => a.date.localeCompare(b.date)).map(({ incomplete, ...point }) => ({
    ...point,
    currentCents: incomplete ? null : point.currentCents,
    unrealizedCents: incomplete ? null : point.unrealizedCents,
  }));
  return {
    positionIds: rows.map((position) => position.id),
    capital: {
      deployedCents,
      currentCents,
      heldToResolutionCents: total(open.map((position) => position.expectedPayoutCents)),
      excludedOpenCostCents,
    },
    entryCost: { available: rows.length - unavailableEntryCosts, unavailable: unavailableEntryCosts },
    pnl: {
      realizedCents,
      unrealizedCents,
      totalCents,
      roiBps: totalCents == null || valuedCostCents <= 0 ? null : Math.round(totalCents * 10_000 / valuedCostCents),
    },
    valuation: {
      fresh: freshOpen.length,
      stale,
      unavailable,
      pendingSettlement: unverifiedSettled.length,
      asOf: Number.isFinite(oldestFreshMs) ? new Date(oldestFreshMs).toISOString() : null,
    },
    entryCohorts,
  };
}

function dashboardRangeStart(range: DashboardRange, now: Date): number | null {
  if (range === 'all') return null;
  if (range === 'today') return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const days = range === '7d' ? 7 : range === '90d' ? 90 : 30;
  return now.getTime() - days * 86_400_000;
}

export function filterBotAnalyticsPositions(
  rows: BotPosition[],
  options: { method: 'all' | BotSelectionMethod | 'legacy'; range: DashboardRange },
  now = new Date(),
): BotPosition[] {
  const start = dashboardRangeStart(options.range, now);
  return rows.filter((position) => {
    const openedAt = Date.parse(position.openedAt);
    if (!Number.isFinite(openedAt) || (start != null && openedAt < start)) return false;
    if (options.method === 'all') return true;
    return options.method === 'legacy'
      ? position.selectionMethod == null
      : position.selectionMethod === options.method;
  });
}

export function summarizeBotPositions(rows: BotPosition[], now = new Date()) {
  const totalNumbers = (values: number[]) => values.reduce((total, value) => total + value, 0);
  const closed = rows.filter(hasVerifiedTerminalAccounting);
  const performance = summarizeBotPerformance(rows, now);
  const allEntryCostsAvailable = rows.every(hasAvailableEntryCost);
  const deployedCapitalCents = allEntryCostsAvailable
    ? totalNumbers(rows.map((position) => position.totalCostCents))
    : null;
  const apyValues = rows.flatMap((position) => {
    if (!position.expiryDate) return [];
    const durationDays = (Date.parse(position.expiryDate) - Date.parse(position.openedAt)) / 86_400_000;
    if (!Number.isFinite(durationDays) || durationDays <= 0) return [];
    return [roiBps(position.expectedProfitCents, position.totalCostCents) / 100 * 365 / durationDays];
  });
  return {
    tradeCount: rows.length, deployedCapitalCents, realizedPnlCents: performance.pnl.realizedCents, unrealizedPnlCents: performance.pnl.unrealizedCents,
    winRateBps: closed.length === 0 ? 0 : Math.round(closed.filter((position) => (position.realizedPnlCents ?? 0) > 0).length * 10_000 / closed.length),
    averageEntryRoiBps: rows.length === 0 ? 0 : allEntryCostsAvailable
      ? Math.round(totalNumbers(rows.map((position) => roiBps(position.expectedProfitCents, position.totalCostCents))) / rows.length)
      : null,
    currentRoiBps: rows.length === 0 ? 0 : performance.pnl.roiBps,
    averageApyPct: apyValues.length === 0 ? null : Math.round(totalNumbers(apyValues) / apyValues.length * 100) / 100,
  };
}

function cohortPnlFor(rows: BotPosition[], now: Date) {
  return summarizeBotPerformance(rows, now).entryCohorts.map((cohort) => ({
    date: cohort.date,
    realizedPnlCents: cohort.realizedCents,
    unrealizedPnlCents: cohort.unrealizedCents,
    trades: cohort.trades,
  }));
}

export async function getBotPositionAnalytics(options: {
  method?: 'all' | BotSelectionMethod | 'legacy';
  mode?: 'all' | 'paper' | 'production';
  range?: DashboardRange;
} = {}): Promise<BotPositionAnalytics> {
  const method = options.method ?? 'all';
  const mode = options.mode ?? 'all';
  const range = options.range ?? '30d';
  const now = new Date();
  const modePositions = await store().listAllForAnalytics({ mode });
  const allPositions = filterBotAnalyticsPositions(modePositions, { method: 'all', range }, now);
  const positions = filterBotAnalyticsPositions(modePositions, { method, range }, now);
  const paper = positions.filter((position) => position.dryRun).length;
  const production = positions.length - paper;
  const open = positions.filter((position) => position.status === 'open');
  const settled = positions.filter(hasVerifiedTerminalAccounting);
  const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);
  const score = (position: BotPosition) => position.status === 'open'
    ? (position.currentValueCents ?? position.totalCostCents) - position.totalCostCents
    : hasVerifiedTerminalAccounting(position) ? position.realizedPnlCents! : 0;
  const ranked = positions.filter((position) => position.status === 'open'
    ? botPositionMark(position, now.getTime()) === 'fresh'
    : hasVerifiedTerminalAccounting(position)).sort((a, b) => score(b) - score(a));
  const performance = summarizeBotPerformance(positions, now);
  const dailyPnl = cohortPnlFor(positions, now);
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
    now,
  );
  return {
    positions,
    totalBotTrades: { paper, production, total: positions.length },
    openPositions: {
      count: open.length,
      unrealizedPnlCents: performance.pnl.unrealizedCents,
    },
    settledPositions: {
      count: settled.length,
      realizedPnlCents: sum(settled.map((position) => position.realizedPnlCents ?? 0)),
      winRateBps: settled.length === 0 ? 0 : Math.round(settled.filter((position) => (position.realizedPnlCents ?? 0) > 0).length * 10_000 / settled.length),
    },
    averageRoi: {
      atTradeBps: positions.length === 0 ? 0 : Math.round(sum(positions.map((position) => roiBps(position.expectedProfitCents, position.totalCostCents))) / positions.length),
      currentBps: positions.length === 0 ? 0 : performance.pnl.roiBps,
    },
    bestTrade: ranked[0] ?? null,
    worstTrade: ranked.at(-1) ?? null,
    dailyPnl,
    dailyPnlByMethod: {
      roi: cohortPnlFor(allPositions.filter((position) => position.selectionMethod === 'roi'), now),
      apy: cohortPnlFor(allPositions.filter((position) => position.selectionMethod === 'apy'), now),
      hybrid: cohortPnlFor(allPositions.filter((position) => position.selectionMethod === 'hybrid'), now),
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
    performance,
  };
}

export async function pollOpenBotPositions(dependencies?: {
  fetchKalshi?: (ticker: string) => Promise<{
    yes_bid_dollars?: string;
    no_bid_dollars?: string;
    close_time?: string;
    status?: string;
    settlement_value_dollars?: string;
  } | null>;
  fetchKalshiBids?: (ticker: string) => Promise<{
    yesBids: ExecutableBidLevel[];
    noBids: ExecutableBidLevel[];
    observedAt?: string;
  } | null>;
  fetchPmBids?: (conditionId: string, heldSide?: BotPositionSide) => Promise<{
    yesBidCents: number | null;
    noBidCents: number | null;
    yesBids?: ExecutableBidLevel[];
    noBids?: ExecutableBidLevel[];
    resolved: boolean;
    observedAt?: string;
  } | null>;
  fetchFeeConfig?: typeof fetchAuthoritativeBotFeeConfig;
  observedAt?: string;
  positionStore?: BotPositionStore;
}): Promise<{ updated: number; settled: number; errors: Array<{ id: number; error: string }> }> {
  const [{ fetchKalshiMarket }, { fetchClobMarket, fetchClobBook, extractClobBidPrices }] = await Promise.all([
    import('./kalshi'),
    import('./polymarket-clob'),
  ]);
  const fetchKalshi = dependencies?.fetchKalshi ?? fetchKalshiMarket;
  const fetchKalshiBids = dependencies?.fetchKalshiBids ?? (async (ticker: string) => {
    const response = await fetch(`https://api.elections.kalshi.com/trade-api/v2/markets/${encodeURIComponent(ticker)}/orderbook`, {
      headers: { Accept: 'application/json' },
      cache: 'no-store',
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) return null;
    const data = await response.json() as unknown;
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw new Error('Malformed Kalshi order book payload');
    }
    const record = data as Record<string, unknown>;
    const fixedPoint = record.orderbook_fp;
    const legacy = record.orderbook;
    if (fixedPoint != null && (typeof fixedPoint !== 'object' || Array.isArray(fixedPoint))) {
      throw new Error('Malformed Kalshi fixed-point order book payload');
    }
    if (legacy != null && (typeof legacy !== 'object' || Array.isArray(legacy))) {
      throw new Error('Malformed Kalshi legacy order book payload');
    }
    const book = fixedPoint != null
      ? fixedPoint as Record<string, unknown>
      : legacy != null
        ? legacy as Record<string, unknown>
        : null;
    if (!book) throw new Error('Malformed Kalshi order book payload');
    const yes = (book.yes_dollars ?? book.yes_dollars_fp ?? []) as unknown;
    const no = (book.no_dollars ?? book.no_dollars_fp ?? []) as unknown;
    return {
      yesBids: parseExecutableBidLevels(yes, 'Kalshi YES bid', true),
      noBids: parseExecutableBidLevels(no, 'Kalshi NO bid', true),
      observedAt: new Date().toISOString(),
    };
  });
  const fetchPmBids = dependencies?.fetchPmBids ?? (async (conditionId: string, heldSide?: BotPositionSide) => {
    // Legacy /market imports stored the held CLOB token id in the historical
    // pmConditionId column. A token book is sufficient to mark the held leg.
    if (/^\d+$/.test(conditionId)) {
      const book = await fetchClobBook(conditionId);
      if (!book || book.asset_id !== conditionId) return null;
      const bids = parseExecutableBidLevels(book.bids, `Polymarket ${heldSide?.toUpperCase() ?? 'held'} bid`);
      parseExecutableBidLevels(book.asks, `Polymarket ${heldSide?.toUpperCase() ?? 'held'} ask`);
      const bestBid = bids.length > 0 ? Math.max(...bids.map((level) => level.priceCents)) : null;
      return {
        yesBidCents: heldSide === 'yes' ? bestBid : null,
        noBidCents: heldSide === 'no' ? bestBid : null,
        yesBids: heldSide === 'yes' ? bids : undefined,
        noBids: heldSide === 'no' ? bids : undefined,
        resolved: false,
        observedAt: new Date().toISOString(),
      };
    }
    const market = await fetchClobMarket(conditionId);
    if (!market) return null;
    if (!Array.isArray(market.tokens)) throw new Error('Malformed Polymarket token payload');
    const yesTokens = market.tokens.filter((token) => token && typeof token.token_id === 'string'
      && typeof token.outcome === 'string' && token.outcome.toLowerCase() === 'yes');
    const noTokens = market.tokens.filter((token) => token && typeof token.token_id === 'string'
      && typeof token.outcome === 'string' && token.outcome.toLowerCase() === 'no');
    if (market.tokens.length !== 2 || yesTokens.length !== 1 || noTokens.length !== 1
      || yesTokens[0].token_id === noTokens[0].token_id) {
      throw new Error('Malformed Polymarket token/outcome association');
    }
    const yesToken = yesTokens[0];
    const noToken = noTokens[0];
    const resolutionPrices = extractClobBidPrices(market, null, null);
    if (resolutionPrices.resolved) {
      return {
        ...resolutionPrices,
        yesBids: resolutionPrices.yesBidCents != null
          ? [{ priceCents: resolutionPrices.yesBidCents, size: Number.MAX_SAFE_INTEGER }]
          : undefined,
        noBids: resolutionPrices.noBidCents != null
          ? [{ priceCents: resolutionPrices.noBidCents, size: Number.MAX_SAFE_INTEGER }]
          : undefined,
        observedAt: new Date().toISOString(),
      };
    }
    const [yesBook, noBook] = await Promise.all([
      yesToken ? fetchClobBook(yesToken.token_id) : null,
      noToken ? fetchClobBook(noToken.token_id) : null,
    ]);
    const prices = extractClobBidPrices(market, yesBook, noBook);
    if (!yesBook || !noBook || yesBook.asset_id !== yesToken.token_id || noBook.asset_id !== noToken.token_id) {
      throw new Error('Malformed Polymarket token/outcome book association');
    }
    const yesObservedMs = parseObservationMs(yesBook.timestamp);
    const noObservedMs = parseObservationMs(noBook.timestamp);
    if (!Number.isFinite(yesObservedMs) || !Number.isFinite(noObservedMs)) {
      throw new Error('Malformed Polymarket order book timestamp');
    }
    parseExecutableBidLevels(yesBook.asks, 'Polymarket YES ask');
    parseExecutableBidLevels(noBook.asks, 'Polymarket NO ask');
    return {
      ...prices,
      yesBids: parseExecutableBidLevels(yesBook.bids, 'Polymarket YES bid'),
      noBids: parseExecutableBidLevels(noBook.bids, 'Polymarket NO bid'),
      // This is a freshly fetched executable book. The venue timestamps above
      // are validated as provenance, but fetch completion governs freshness.
      observedAt: new Date().toISOString(),
    };
  });
  const positionStore = dependencies?.positionStore ?? store();
  const open = await positionStore.listAllOpen();
  const valuationAttemptedAt = dependencies?.observedAt ?? new Date().toISOString();
  let updated = 0;
  let settled = 0;
  const errors: Array<{ id: number; error: string }> = [];

  const valuatePosition = async (position: BotPosition): Promise<void> => {
    try {
      if (!position.kalshiTicker || !position.pmConditionId) {
        throw new Error('Position is missing venue market identifiers');
      }
      const [kalshiResult, pmResult] = await Promise.allSettled([
        fetchKalshi(position.kalshiTicker),
        fetchPmBids(position.pmConditionId, position.pmSide),
      ]);
      if (kalshiResult.status === 'rejected') {
        throw new Error(`Kalshi market lookup failed: ${kalshiResult.reason instanceof Error ? kalshiResult.reason.message : String(kalshiResult.reason)}`);
      }
      if (pmResult.status === 'rejected') {
        throw new Error(`Polymarket market lookup failed: ${pmResult.reason instanceof Error ? pmResult.reason.message : String(pmResult.reason)}`);
      }
      const kalshi = kalshiResult.value;
      const pmBids = pmResult.value;
      if (!kalshi) throw new Error('Kalshi market lookup returned no market');
      if (!pmBids) throw new Error('Polymarket market lookup returned no market');
      const parseCents = (value: string | undefined): number | null => {
        if (value == null || !/^(?:0(?:\.\d+)?|1(?:\.0+)?)$/.test(value)) return null;
        const cents = Math.round(Number(value) * 100);
        return isPriceCents(cents) ? cents : null;
      };
      const kalshiResolution = getKalshiResolvedPrices(kalshi);
      // Authoritative settlement remains usable after venue books disappear.
      // Only unresolved positions require executable liquidation depth.
      const kalshiBids = kalshiResolution.resolved
        ? null
        : await fetchKalshiBids(position.kalshiTicker);
      if (!kalshiBids && !kalshiResolution.resolved) throw new Error('Kalshi executable depth unavailable');
      const valuationAt = dependencies?.observedAt ?? new Date().toISOString();
      const attemptedMs = parseObservationMs(valuationAt);
      if (!Number.isFinite(attemptedMs)) throw new Error('Malformed valuation observation timestamp');
      const kalshiObservedMs = kalshiResolution.resolved
        ? attemptedMs
        : parseObservationMs(kalshiBids?.observedAt);
      const pmObservedMs = parseObservationMs(pmBids.observedAt);
      if (!kalshiResolution.resolved
        && (!Number.isFinite(kalshiObservedMs)
          || kalshiObservedMs > attemptedMs
          || attemptedMs - kalshiObservedMs > EXECUTABLE_QUOTE_MAX_AGE_MS)) {
        throw new Error('Stale Kalshi executable depth');
      }
      if (!pmBids.resolved
        && (!Number.isFinite(pmObservedMs)
          || pmObservedMs > attemptedMs
          || attemptedMs - pmObservedMs > EXECUTABLE_QUOTE_MAX_AGE_MS)) {
        throw new Error('Stale Polymarket executable depth');
      }
      if (pmBids.resolved && !Number.isFinite(pmObservedMs)) {
        throw new Error('Malformed Polymarket settlement observation timestamp');
      }
      const quoteObservedAt = new Date(Math.min(kalshiObservedMs, pmObservedMs)).toISOString();
      const resolvedKalshiYesBids = kalshiResolution.resolved && kalshiResolution.yesBidCents != null
        ? [{ priceCents: kalshiResolution.yesBidCents, size: Number.MAX_SAFE_INTEGER }]
        : kalshiBids?.yesBids ?? [];
      const resolvedKalshiNoBids = kalshiResolution.resolved && kalshiResolution.noBidCents != null
        ? [{ priceCents: kalshiResolution.noBidCents, size: Number.MAX_SAFE_INTEGER }]
        : kalshiBids?.noBids ?? [];
      let valuedPosition = position;
      if (!(kalshiResolution.resolved && pmBids.resolved)) {
        const authority = await (dependencies?.fetchFeeConfig ?? fetchAuthoritativeBotFeeConfig)({
          kalshiTicker: position.kalshiTicker,
          pmConditionId: position.pmConditionId,
          pmTokenId: position.pmEntryTokenId ?? position.pmExitTokenId
            ?? (/^\d+$/.test(position.pmConditionId) ? position.pmConditionId : undefined),
          pmSide: position.pmSide,
          category: position.category ?? undefined,
        });
        const legacyPaperEntry = isLegacyPaperEntryAuthorityMissing(position);
        if (!legacyPaperEntry && authority.pmTheta !== position.pmTheta) {
          throw new Error('Conflicting persisted and current Polymarket fee theta');
        }
        valuedPosition = {
          ...position,
          pmTheta: authority.pmTheta,
          kalshiExitFeeType: authority.kalshi.feeType,
          kalshiExitFeeMultiplierPpm: authority.kalshi.feeMultiplierPpm,
          kalshiExitFeeSource: authority.kalshi.source,
          kalshiExitFeeObservedAt: authority.kalshi.observedAt,
          kalshiExitFeeVersion: authority.kalshi.version,
          pmExitTokenId: authority.polymarket.tokenId,
          pmExitFeeRateBps: authority.polymarket.feeRateBps,
          pmExitFeeSource: authority.polymarket.source,
          pmExitFeeObservedAt: authority.polymarket.observedAt,
          pmExitFeeVersion: authority.polymarket.version,
        };
      }
      const valuation = calculatePositionValuation(valuedPosition, {
        kalshiYesBidCents: kalshiResolution.yesBidCents ?? parseCents(kalshi.yes_bid_dollars),
        kalshiNoBidCents: kalshiResolution.noBidCents ?? parseCents(kalshi.no_bid_dollars),
        pmYesBidCents: pmBids.yesBidCents,
        pmNoBidCents: pmBids.noBidCents,
        kalshiYesBids: resolvedKalshiYesBids,
        kalshiNoBids: resolvedKalshiNoBids,
        pmYesBids: pmBids.yesBids,
        pmNoBids: pmBids.noBids,
        observedAt: quoteObservedAt,
        valuedAt: dependencies?.observedAt ?? new Date().toISOString(),
        expiryDate: kalshi.close_time ?? position.expiryDate,
        kalshiResolved: kalshiResolution.resolved,
        pmResolved: pmBids.resolved,
      });
      if (valuedPosition !== position) {
        await positionStore.updateValuationWithFeeConfig(position.id, valuation, {
          feeType: valuedPosition.kalshiExitFeeType!,
          feeMultiplierPpm: valuedPosition.kalshiExitFeeMultiplierPpm!,
          source: valuedPosition.kalshiExitFeeSource!,
          observedAt: valuedPosition.kalshiExitFeeObservedAt!,
          version: valuedPosition.kalshiExitFeeVersion!,
        }, {
          tokenId: valuedPosition.pmExitTokenId!,
          feeRateBps: valuedPosition.pmExitFeeRateBps!,
          source: valuedPosition.pmExitFeeSource!,
          observedAt: valuedPosition.pmExitFeeObservedAt!,
          version: valuedPosition.pmExitFeeVersion!,
        });
      } else {
        await positionStore.updateValuation(position.id, valuation);
      }
      updated += 1;
      if (valuation.status === 'settled') settled += 1;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      await positionStore.clearOpenValuation(position.id, valuationAttemptedAt, reason);
      errors.push({ id: position.id, error: reason });
    }
  };
  const workers = Array.from({ length: Math.min(8, open.length) }, async (_, workerIndex) => {
    for (let index = workerIndex; index < open.length; index += 8) {
      await valuatePosition(open[index]);
    }
  });
  await Promise.all(workers);
  return { updated, settled, errors };
}
