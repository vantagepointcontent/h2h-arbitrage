import path from 'node:path';
import { createClient, type Client } from '@libsql/client';
import { getPolymarketTheta } from './matcher';
import { normalizeKalshiResolution } from './settlement-resolution';

export type BotPositionStatus = 'open' | 'settled' | 'closed';
export type BotPositionSide = 'yes' | 'no';
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
  totalCostCents: number;
  expectedPayoutCents: number;
  expectedProfitCents: number;
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
  'currentPricePmCents' | 'currentValueCents' |
  'kalshiGrossProceedsMicrocents' | 'pmGrossProceedsMicrocents' |
  'kalshiNetProceedsCents' | 'pmNetProceedsCents' | 'unrealizedPnlCents' |
  'kalshiExitFeeCents' | 'pmExitFeeCents' | 'unrealizedRoiBps' |
  'lastValuationAt' | 'realizedPnlCents' |
  'settlementSide' | 'dryRun'
>;

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

export interface PositionQuote {
  kalshiYesBidCents: number | null;
  kalshiNoBidCents: number | null;
  pmYesBidCents: number | null;
  pmNoBidCents: number | null;
  kalshiYesBids?: ExecutableBidLevel[];
  kalshiNoBids?: ExecutableBidLevel[];
  pmYesBids?: ExecutableBidLevel[];
  pmNoBids?: ExecutableBidLevel[];
  observedAt: string;
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
  if (position.pmEntryTokenId == null || position.pmExitTokenId !== position.pmEntryTokenId) {
    throw new Error(`Conflicting Polymarket token fee configuration for bot position ${position.id}`);
  }
  const expectedPmFeeRateBps = Math.round((position.pmTheta ?? Number.NaN) * 10_000);
  if (!Number.isSafeInteger(expectedPmFeeRateBps) || expectedPmFeeRateBps !== position.pmExitFeeRateBps) {
    throw new Error(`Conflicting Polymarket fee configuration for bot position ${position.id}`);
  }
  if (!Number.isFinite(observedMs)
    || Math.abs(observedMs - kalshiFeeMs) > FEE_CONFIG_MAX_AGE_MS
    || Math.abs(observedMs - pmFeeMs) > FEE_CONFIG_MAX_AGE_MS) {
    throw new Error(`Stale authoritative fee configuration for bot position ${position.id}`);
  }
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
  const expected = calculateBotPositionEntryCost({
    buyPriceKalshiCents: input.buyPriceKalshiCents,
    buyPricePmCents: input.buyPricePmCents,
    sharesKalshi: input.sharesKalshi,
    sharesPm: input.sharesPm,
    kalshiFeeMultiplierPpm: input.kalshiEntryFeeMultiplierPpm!,
    pmFeeRateBps: input.pmEntryFeeRateBps!,
    pmTheta: input.pmTheta!,
  });
  if (input.kalshiEntryFeeCents !== expected.kalshiEntryFeeCents
    || input.pmEntryFeeCents !== expected.pmEntryFeeCents
    || input.feesCents !== expected.kalshiEntryFeeCents + expected.pmEntryFeeCents
    || input.totalCostCents !== expected.totalCostCents
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
  const expected = calculateBotPositionEntryCost({
    buyPriceKalshiCents: position.buyPriceKalshiCents,
    buyPricePmCents: position.buyPricePmCents,
    sharesKalshi: position.sharesKalshi,
    sharesPm: position.sharesPm,
    kalshiFeeMultiplierPpm: position.kalshiEntryFeeMultiplierPpm!,
    pmFeeRateBps: position.pmEntryFeeRateBps!,
    pmTheta: position.pmTheta!,
  });
  if (position.kalshiEntryFeeCents !== expected.kalshiEntryFeeCents
    || position.pmEntryFeeCents !== expected.pmEntryFeeCents
    || position.feesCents !== expected.kalshiEntryFeeCents + expected.pmEntryFeeCents
    || position.totalCostCents !== expected.totalCostCents
    || position.expectedPayoutCents !== Math.min(position.sharesKalshi, position.sharesPm) * 100
    || position.expectedProfitCents !== position.expectedPayoutCents - position.totalCostCents) {
    throw new Error(`Persisted entry economics conflict with authoritative fee configuration for bot position ${position.id}`);
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

export function calculatePositionValuation(
  position: BotPosition,
  quote: PositionQuote,
): PositionValuation {
  assertPersistedEntryEconomics(position);
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
    totalCostCents: Number(row.total_cost),
    expectedPayoutCents: Number(row.expected_payout),
    expectedProfitCents: Number(row.expected_profit),
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
        total_cost INTEGER NOT NULL,
        expected_payout INTEGER NOT NULL,
        expected_profit INTEGER NOT NULL,
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
      total_cost: 'INTEGER NOT NULL DEFAULT 0',
      expected_payout: 'INTEGER NOT NULL DEFAULT 0',
      expected_profit: 'INTEGER NOT NULL DEFAULT 0',
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
    await this.client.execute(`CREATE UNIQUE INDEX IF NOT EXISTS idx_bot_positions_open_pair ON bot_positions(lower(kalshi_ticker), lower(pm_condition_id)) WHERE status = 'open'`);
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
    if (await this.hasOpenPair(input.kalshiTicker, input.pmConditionId)) {
      throw new Error('An open bot position already exists for this market pair');
    }

    let result;
    try {
      result = await this.client.execute({
        sql: `INSERT INTO bot_positions (
          execution_id, market_id, market_title, kalshi_ticker, pm_condition_id,
          strategy, kalshi_side, pm_side, buy_price_kalshi, buy_price_pm,
          shares_kalshi, shares_pm, total_cost, expected_payout, expected_profit,
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
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
          ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
          'open', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
          input.executionId, input.marketId, input.marketTitle, input.kalshiTicker,
          input.pmConditionId, input.strategy, input.kalshiSide, input.pmSide,
          input.buyPriceKalshiCents, input.buyPricePmCents, input.sharesKalshi,
          input.sharesPm, input.totalCostCents, input.expectedPayoutCents,
          input.expectedProfitCents, input.feesCents, input.category, input.pmTheta,
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

  async reservePair(kalshiTicker: string, pmConditionId: string): Promise<boolean> {
    await this.ensureSchema();
    // Automatic live orders are hard-disabled; a 10-minute lease recovers paper
    // reservations after process crashes while remaining far longer than the
    // 15-second execution timeout.
    const staleBefore = new Date(Date.now() - 10 * 60_000).toISOString();
    await this.client.execute({
      sql: `DELETE FROM bot_position_reservations WHERE reserved_at < ? AND exposure_at_risk = 0`,
      args: [staleBefore],
    });
    if (await this.hasOpenPair(kalshiTicker, pmConditionId)) return false;
    try {
      await this.client.execute({
        sql: `INSERT INTO bot_position_reservations (pair_key, reserved_at) VALUES (?, ?)`,
        args: [this.pairKey(kalshiTicker, pmConditionId), new Date().toISOString()],
      });
      // Close the narrow gap between the precheck and reservation insert: a
      // prior reservation may have committed its position and released while
      // this caller waited on SQLite's writer lock.
      if (await this.hasOpenPair(kalshiTicker, pmConditionId)) {
        await this.releasePair(kalshiTicker, pmConditionId);
        return false;
      }
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

  async list(options: { status?: BotPositionStatus | 'all'; limit?: number; offset?: number } = {}): Promise<BotPosition[]> {
    await this.ensureSchema();
    const status = options.status ?? 'all';
    const limit = Math.min(1000, Math.max(1, Math.trunc(options.limit ?? 100)));
    const offset = Math.max(0, Math.trunc(options.offset ?? 0));
    const where = status === 'all' ? '' : 'WHERE bp.status = ?';
    const args: Array<string | number> = status === 'all' ? [limit, offset] : [status, limit, offset];
    const result = await this.client.execute({
      sql: `SELECT bp.*, e.dry_run FROM bot_positions bp LEFT JOIN executions e ON e.id = bp.execution_id ${where} ORDER BY bp.opened_at DESC LIMIT ? OFFSET ?`,
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
    await this.client.execute({
      sql: `UPDATE bot_positions SET
        status = ?, current_price_kalshi = ?, current_price_pm = ?,
        current_value = ?,
        kalshi_gross_proceeds_microcents = ?, pm_gross_proceeds_microcents = ?,
        kalshi_net_proceeds = ?, pm_net_proceeds = ?,
        kalshi_exit_fee = ?, pm_exit_fee = ?,
        unrealized_pnl = ?, unrealized_roi_pct = ?,
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
        unrealized_pnl = ?, unrealized_roi_pct = ?, last_valuation_at = ?,
        settled_at = ?, realized_pnl = ?, settlement_side = ?,
        resolution_source = NULL, resolution_verified_at = NULL,
        resolution_outcome = NULL, resolution_payout = NULL,
        resolution_validation_status = 'pending'
        WHERE id = ? AND status = 'open' AND pm_entry_token_id = ?
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

  async clearOpenValuation(id: number, attemptedAt: string): Promise<void> {
    await this.ensureSchema();
    await this.client.execute({
      sql: `UPDATE bot_positions SET
        current_price_kalshi = NULL, current_price_pm = NULL, current_value = NULL,
        kalshi_gross_proceeds_microcents = NULL, pm_gross_proceeds_microcents = NULL,
        kalshi_net_proceeds = NULL, pm_net_proceeds = NULL,
        kalshi_exit_fee = NULL, pm_exit_fee = NULL,
        unrealized_pnl = NULL, unrealized_roi_pct = NULL, last_valuation_at = ?
        WHERE id = ? AND status = 'open'
          AND (last_valuation_at IS NULL OR last_valuation_at <= ?)`,
      args: [attemptedAt, id, attemptedAt],
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
  kalshiContracts: number;
  pmContracts: number;
  expectedProfit: number;
  expiryDate?: string | null;
  selectionMethod?: BotSelectionMethod | null;
  category?: string | null;
}

export function calculateBotPositionEntryCost(input: {
  buyPriceKalshiCents: number;
  buyPricePmCents: number;
  sharesKalshi: number;
  sharesPm: number;
  pmTheta: number;
  kalshiFeeMultiplierPpm: number;
  pmFeeRateBps: number;
}): { kalshiEntryFeeCents: number; pmEntryFeeCents: number; totalCostCents: number } {
  const expectedPmFeeRateBps = Math.round(input.pmTheta * 10_000);
  if (!Number.isSafeInteger(expectedPmFeeRateBps) || expectedPmFeeRateBps !== input.pmFeeRateBps) {
    throw new Error('Conflicting authoritative Polymarket entry fee configuration');
  }
  const kalshiEntryFeeCents = calculateKalshiFeeCents(
    [{ size: input.sharesKalshi, priceCents: input.buyPriceKalshiCents }],
    input.kalshiFeeMultiplierPpm,
  );
  const pmEntryFeeCents = calculatePolymarketFeeCents(
    [{ size: input.sharesPm, priceCents: input.buyPricePmCents }],
    input.pmFeeRateBps,
  );
  return {
    kalshiEntryFeeCents,
    pmEntryFeeCents,
    totalCostCents: Math.round(
      input.sharesKalshi * input.buyPriceKalshiCents
      + input.sharesPm * input.buyPricePmCents
    ) + kalshiEntryFeeCents + pmEntryFeeCents,
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
  category: string;
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
  const pmTheta = getPolymarketTheta(input.category);
  if (Math.round(pmTheta * 10_000) !== feeRateBps) {
    throw new Error('Conflicting authoritative Polymarket category and token fee configuration');
  }
  const observedAt = input.observedAt ?? new Date().toISOString();
  const thetaSource = `matcher-category-theta:${encodeURIComponent(input.category.trim().toLowerCase())}`;
  return {
    kalshi: {
      feeType,
      feeMultiplierPpm,
      source: hasOverride
        ? `https://external-api.kalshi.com/trade-api/v2/events/${encodeURIComponent(eventTicker)}`
        : `https://external-api.kalshi.com/trade-api/v2/series/${encodeURIComponent(seriesTicker)}`,
      observedAt,
      version: `${feeType}:${feeMultiplierPpm}:${String(hasOverride
        ? eventRecord.last_updated_ts ?? 'upstream-version-unavailable'
        : seriesRecord.last_updated_ts ?? 'upstream-version-unavailable')}`,
    },
    polymarket: {
      tokenId,
      feeRateBps,
      source: `https://clob.polymarket.com/fee-rate?token_id=${encodeURIComponent(tokenId)}|${thetaSource}`,
      observedAt,
      version: `token-fee-rate:${feeRateBps}|matcher-category-theta-v1:${Math.round(pmTheta * 1_000_000)}`,
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
  const { kalshiEntryFeeCents, pmEntryFeeCents, totalCostCents } = calculateBotPositionEntryCost({
    buyPriceKalshiCents,
    buyPricePmCents,
    sharesKalshi,
    sharesPm,
    pmTheta,
    kalshiFeeMultiplierPpm: authority.kalshi.feeMultiplierPpm,
    pmFeeRateBps: authority.polymarket.feeRateBps,
  });
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

export async function hasOpenBotMarketPair(kalshiTicker: string | null, pmConditionId: string | null): Promise<boolean> {
  return store().hasOpenPair(kalshiTicker, pmConditionId);
}

export async function reserveBotMarketPair(kalshiTicker: string, pmConditionId: string): Promise<boolean> {
  return store().reservePair(kalshiTicker, pmConditionId);
}

export async function retainBotMarketPairForExposure(kalshiTicker: string, pmConditionId: string): Promise<void> {
  return store().retainPairForExposure(kalshiTicker, pmConditionId);
}

export async function releaseBotMarketPair(kalshiTicker: string, pmConditionId: string): Promise<void> {
  return store().releasePair(kalshiTicker, pmConditionId);
}

export async function getBotPositions(options: { status?: BotPositionStatus | 'all'; limit?: number; offset?: number } = {}): Promise<BotPosition[]> {
  return store().list(options);
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
  fetchPmBids?: (conditionId: string) => Promise<{
    yesBidCents: number | null;
    noBidCents: number | null;
    yesBids?: ExecutableBidLevel[];
    noBids?: ExecutableBidLevel[];
    resolved: boolean;
    observedAt?: string;
  } | null>;
  fetchFeeConfig?: typeof fetchAuthoritativeBotFeeConfig;
  observedAt?: string;
}): Promise<{ updated: number; settled: number; errors: Array<{ id: number; error: string }> }> {
  const [{ fetchKalshiMarket }, { fetchClobMarket, fetchClobBook, extractClobBidPrices }] = await Promise.all([
    import('./kalshi'),
    import('./polymarket-clob'),
  ]);
  const observedAt = dependencies?.observedAt ?? new Date().toISOString();
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
      observedAt,
    };
  });
  const fetchPmBids = dependencies?.fetchPmBids ?? (async (conditionId: string) => {
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
    const [yesBook, noBook] = await Promise.all([
      yesToken ? fetchClobBook(yesToken.token_id) : null,
      noToken ? fetchClobBook(noToken.token_id) : null,
    ]);
    const prices = extractClobBidPrices(market, yesBook, noBook);
    if (prices.resolved) {
      return {
        ...prices,
        yesBids: prices.yesBidCents != null
          ? [{ priceCents: prices.yesBidCents, size: Number.MAX_SAFE_INTEGER }]
          : undefined,
        noBids: prices.noBidCents != null
          ? [{ priceCents: prices.noBidCents, size: Number.MAX_SAFE_INTEGER }]
          : undefined,
        observedAt,
      };
    }
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
      observedAt: new Date(Math.min(yesObservedMs, noObservedMs)).toISOString(),
    };
  });
  const open = await store().listAllOpen();
  let updated = 0;
  let settled = 0;
  const errors: Array<{ id: number; error: string }> = [];

  await Promise.all(open.map(async (position) => {
    try {
      if (!position.kalshiTicker || !position.pmConditionId) {
        throw new Error('Position is missing venue market identifiers');
      }
      const [kalshi, kalshiBids, pmBids] = await Promise.all([
        fetchKalshi(position.kalshiTicker),
        fetchKalshiBids(position.kalshiTicker),
        fetchPmBids(position.pmConditionId),
      ]);
      if (!kalshi || !pmBids) throw new Error('Venue quote unavailable');
      const parseCents = (value: string | undefined): number | null => {
        if (value == null || !/^(?:0(?:\.\d+)?|1(?:\.0+)?)$/.test(value)) return null;
        const cents = Math.round(Number(value) * 100);
        return isPriceCents(cents) ? cents : null;
      };
      const kalshiResolution = getKalshiResolvedPrices(kalshi);
      if (!kalshiBids && !kalshiResolution.resolved) throw new Error('Kalshi executable depth unavailable');
      const attemptedMs = parseObservationMs(observedAt);
      if (!Number.isFinite(attemptedMs)) throw new Error('Malformed valuation observation timestamp');
      if (!kalshiResolution.resolved
        && (!Number.isFinite(parseObservationMs(kalshiBids?.observedAt))
          || Math.abs(attemptedMs - parseObservationMs(kalshiBids?.observedAt)) > 60_000)) {
        throw new Error('Stale Kalshi executable depth');
      }
      if (!pmBids.resolved
        && (!Number.isFinite(parseObservationMs(pmBids.observedAt))
          || Math.abs(attemptedMs - parseObservationMs(pmBids.observedAt)) > 60_000)) {
        throw new Error('Stale Polymarket executable depth');
      }
      const resolvedKalshiYesBids = kalshiResolution.resolved && kalshiResolution.yesBidCents != null
        ? [{ priceCents: kalshiResolution.yesBidCents, size: Number.MAX_SAFE_INTEGER }]
        : kalshiBids?.yesBids ?? [];
      const resolvedKalshiNoBids = kalshiResolution.resolved && kalshiResolution.noBidCents != null
        ? [{ priceCents: kalshiResolution.noBidCents, size: Number.MAX_SAFE_INTEGER }]
        : kalshiBids?.noBids ?? [];
      let valuedPosition = position;
      if (!(kalshiResolution.resolved && pmBids.resolved)) {
        if (!position.category?.trim()) throw new Error('Position is missing authoritative market category');
        const authority = await (dependencies?.fetchFeeConfig ?? fetchAuthoritativeBotFeeConfig)({
          kalshiTicker: position.kalshiTicker,
          pmConditionId: position.pmConditionId,
          pmTokenId: position.pmEntryTokenId ?? undefined,
          pmSide: position.pmSide,
          category: position.category,
        });
        if (authority.pmTheta !== position.pmTheta) {
          throw new Error('Conflicting persisted and current Polymarket fee theta');
        }
        valuedPosition = {
          ...position,
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
        observedAt,
        expiryDate: kalshi.close_time ?? position.expiryDate,
        kalshiResolved: kalshiResolution.resolved,
        pmResolved: pmBids.resolved,
      });
      if (valuedPosition !== position) {
        await store().updateValuationWithFeeConfig(position.id, valuation, {
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
        await store().updateValuation(position.id, valuation);
      }
      updated += 1;
      if (valuation.status === 'settled') settled += 1;
    } catch (error) {
      await store().clearOpenValuation(position.id, observedAt);
      errors.push({ id: position.id, error: error instanceof Error ? error.message : String(error) });
    }
  }));
  return { updated, settled, errors };
}
