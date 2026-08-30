/**
 * BotTrader Engine — FEAT-040
 *
 * Scan-driven auto-execution.  Evaluates arbitrage opportunities against
 * configurable criteria and, when allowed, simulates or places trades.
 *
 * SAFETY:
 *   • `bot.mode === 'production'` alone is NOT enough to place live orders.
 *   • Real orders require BOTH `bot.mode === 'production'` AND the global
 *     `execute.mode === 'live'`.
 *   • Paper mode is simulated only when BotTrader itself is configured for
 *     paper. A production request with incomplete live prerequisites is
 *     blocked and alerted; it never silently degrades to a paper placement.
 */

import { computeApy, type UnifiedOutcome } from './matcher';
import type { LiveArbResult } from './live-arb-engine';
import {
  executeArb,
  type ExecutionRequest,
  type OrderRequest,
  type OrderResult,
} from './auto-execute';
import { isPriceAlignedToTick } from './venue-constraints';
import { getSetting } from './settings';
import type { ExecutionMode } from './execution-mode';
import {
  persistExecution,
  getTodayBotExposure,
  hasOpenBotPosition,
  type ExecutionRecord,
} from './persistence';
import {
  fetchAuthoritativeBotFeeConfig,
  calculateBotPositionEntryCost,
  recordBotPosition,
  type AuthoritativeBotFeeConfig,
  type BotPositionExecutionMode,
} from './bot-positions';
import { sendTelegramMessage, getConfigResolved, isPausedResolved } from './telegram-alerts';
import { appendBotActionLog, type BotActionStatus } from './bot-action-log';
import { createBotMessage, updateBotMessage, type BotMessageType } from './bot-trader-messages';
import logger from './logger';
import type { BotSelectionMethod } from './bot-candidate-selection';
import { calculateKalshiFeeQuote, type KalshiFeeAuthority } from './kalshi-fee-quote';
import {
  buildExecutionEvidence,
  isAnalyticsEligible,
  type ExecutionEvidence,
  type LiveExecutionEvidence,
} from './execution-evidence';
import { isExecutableQuoteConsistent, quoteOneShareFromTopAsk, type ExecutableBookQuote } from './executable-book';
import type { BotEntryEvidenceLegV1, BotEntryEvidenceV1 } from './bot-entry-recovery';
import {
  validatePropositionRelationship,
  type PropositionRelationship,
  type PropositionValidation,
} from './proposition-identity';
import {
  findCanonicalPropositionRelationship,
  resolveCanonicalPropositionRelationship,
} from './proposition-registry';

// ─── Types ─────────────────────────────────────────────────────

export interface BotSettings {
  enabled: boolean;
  mode: 'paper' | 'production';
  selectionMethod: BotSelectionMethod;
  minRoiPct: number;
  minApyPct: number;
  /** minimum dollar depth at best ask on EACH leg (per-leg, not total) */
  minDepthUsd: number;
  /** minimum shares available at best ask on BOTH legs */
  minSharesPerLeg: number;
  /** skip markets expiring sooner than this (days) */
  maxExpiryDays: number;
  maxTradesPerDay: number;
}

export interface BotTradeEvaluation {
  shouldTrade: boolean;
  reason: string;
  criteria: {
    roiPct: number;
    apyPct: number;
    /** dollar depth at the Kalshi ask used by the selected strategy */
    depthKUsd: number;
    /** dollar depth at the Polymarket ask used by the selected strategy */
    depthPUsd: number;
    /** shares available at the Kalshi ask */
    sharesK: number;
    /** shares available at the Polymarket ask */
    sharesP: number;
    expiryDays: number | null;
  };
}

export interface BotTradeInput {
  /** Stable pair identifier (saved-market id or live pair id) */
  pairId: string;
  marketTitle: string;
  /** Outcome name/artist used in the arb */
  outcome: string;
  kalshiOutcomeLabel?: string | null;
  pmOutcomeLabel?: string | null;
  kalshiMarketQuestion?: string | null;
  pmMarketQuestion?: string | null;
  relationshipState?: string | null;
  relationshipExplanation?: string | null;
  strategy: string;
  /** Immutable proof that the exact purchased contracts are complementary. */
  propositionRelationship?: PropositionRelationship | null;
  roiPct: number;
  apyPct?: number | null;
  expectedProfit: number;
  kalshiStake: number;
  pmStake: number;
  /** Kalshi ticker for the leg the strategy buys on Kalshi (if any) */
  kalshiTicker?: string | null;
  /** Polymarket conditionId/tokenId for the leg the strategy buys on PM (if any) */
  pmConditionId?: string | null;
  /** Exact Polymarket YES token id when available. */
  pmYesTokenId?: string | null;
  /** Exact Polymarket NO token id when available. */
  pmNoTokenId?: string | null;
  /** Kalshi YES ask */
  kalshiYesAsk?: number | null;
  /** Kalshi NO ask */
  kalshiNoAsk?: number | null;
  /** Polymarket YES ask */
  pmYesAsk?: number | null;
  /** Polymarket NO ask */
  pmNoAsk?: number | null;
  /** Dollar depth at Kalshi YES ask */
  kalshiYesDepth?: number;
  /** Dollar depth at Kalshi NO ask */
  kalshiNoDepth?: number;
  /** Dollar depth at PM YES ask */
  pmYesDepth?: number;
  /** Dollar depth at PM NO ask */
  pmNoDepth?: number;
  kalshiYesExecutableQuote?: ExecutableBookQuote;
  kalshiNoExecutableQuote?: ExecutableBookQuote;
  pmYesExecutableQuote?: ExecutableBookQuote;
  pmNoExecutableQuote?: ExecutableBookQuote;
  pmYesMinOrderSize?: number | null;
  pmNoMinOrderSize?: number | null;
  pmYesTickSize?: number | null;
  pmNoTickSize?: number | null;
  crossOutcomeMutuallyExclusiveVerified?: boolean;
  crossOutcomeExhaustiveVerified?: boolean;
  /** Market expiry ISO string */
  expiryDate?: string | null;
  category?: string;
  /** Immutable ranked-selection attribution. Null for explicit/manual runs. */
  selectionMethod?: BotSelectionMethod | null;
  /** Mode of the durable reservation acquired before this execution attempt. */
  reservationMode?: BotPositionExecutionMode;
  /** Canonical Logs lineage for scan-driven decisions. Null for manual runs. */
  sourceScanId?: number | null;
  sourceOpportunityId?: string | null;
}

export interface BotExecutionResult {
  executed: boolean;
  dryRun: boolean;
  reason: string;
  /** Live venue acknowledgement exists, but complete authoritative evidence is unavailable. */
  exposureState?: 'pending_reconciliation';
  executionRecord?: ExecutionRecord;
  executionResult?: Awaited<ReturnType<typeof executeArb>>;
  /** True only after the authoritative/synthetic position row was durably written. */
  positionPersisted?: boolean;
  persistenceError?: string;
  /** Durable executions primary key when an execution row was written. */
  executionId?: number;
  /** Durable delivery state for the execution/exposure alert. */
  alertStatus?: BotAlertStatus;
}

export interface BotAlertStatus {
  durable: boolean;
  delivered: boolean;
  error?: string;
}

interface BotTradePublicationInput {
  dryRun: boolean;
  marketTitle: string;
  resultSuccess: boolean;
  shouldPersistPerformance: boolean;
  positionPersisted: boolean;
  persistenceError?: string;
}

export function getBotTradePublication(input: BotTradePublicationInput): {
  executed: boolean;
  alertSuccess: boolean;
  reason: string;
  exposureState?: 'pending_reconciliation';
} {
  const durableSuccess = input.resultSuccess
    && input.shouldPersistPerformance
    && input.positionPersisted;
  let reason: string;
  if (durableSuccess) {
    reason = input.dryRun
      ? `Paper trade simulated for ${input.marketTitle}`
      : `Production trade executed for ${input.marketTitle}`;
  } else if (input.persistenceError) {
    reason = `${input.dryRun ? 'Paper' : 'Production'} trade persistence failed for ${input.marketTitle}: ${input.persistenceError}`;
  } else if (input.dryRun) {
    reason = `Paper trade did not produce a durable canonical entry record for ${input.marketTitle}`;
  } else {
    reason = `Production order acknowledgement pending authoritative fill reconciliation for ${input.marketTitle}`;
  }
  return {
    executed: durableSuccess,
    alertSuccess: durableSuccess,
    reason,
    exposureState: !input.dryRun && !durableSuccess ? 'pending_reconciliation' : undefined,
  };
}

/** Canonical gate shared by execution and position performance persistence. */
export function getBotPerformanceEvidence(
  result: Awaited<ReturnType<typeof executeArb>>,
  dryRun: boolean,
): ExecutionEvidence | null {
  if (result.success !== true) return null;
  if (!dryRun) {
    const acceptedStatuses = new Set(['filled', 'partial']);
    if (!acceptedStatuses.has(result.kalshiResult.status)
      || !acceptedStatuses.has(result.polymarketResult.status)) return null;
  }
  const evidence = buildExecutionEvidence(result, dryRun);
  if (dryRun) return evidence?.kind === 'paper' ? evidence : null;
  return isAnalyticsEligible(result, evidence) ? evidence : null;
}

export async function persistBotPerformanceExecution(
  record: ExecutionRecord,
  evidence: ExecutionEvidence | null,
  persist: (record: ExecutionRecord) => Promise<number> = persistExecution,
): Promise<number | null> {
  if (!evidence) return null;
  return persist(record);
}

export function liveEvidenceToBotPositionFill(evidence: LiveExecutionEvidence) {
  const fills = (venue: LiveExecutionEvidence['kalshi']) => (venue.fills ?? [{
    quantity: venue.filledQuantity,
    price: venue.fillPrice,
  }]).map((item) => ({
    priceCents: Math.round(item.price * 100_000_000) / 1_000_000,
    size: item.quantity,
    ...('liquidityRole' in item && item.liquidityRole ? { liquidityRole: item.liquidityRole } : {}),
  }));
  return {
    kalshiContracts: evidence.kalshi.filledQuantity,
    pmContracts: evidence.polymarket.filledQuantity,
    kalshiPrice: evidence.kalshi.fillPrice,
    pmPrice: evidence.polymarket.fillPrice,
    kalshiFills: fills(evidence.kalshi),
    pmFills: fills(evidence.polymarket),
    kalshiChargedFeeCents: evidence.kalshi.chargedFeeCents,
    pmChargedFeeCents: evidence.polymarket.chargedFeeCents,
    pmChargedFeeMicrousd: evidence.polymarket.chargedFeeMicrousd,
  };
}

function roundedRatio(numerator: bigint, denominator: bigint): number {
  const value = Number((numerator + denominator / 2n) / denominator);
  if (!Number.isSafeInteger(value)) throw new Error('Entry evidence gross exceeds safe integer range');
  return value;
}

export function buildBotEntryEvidence(
  arbId: string,
  dryRun: boolean,
  request: ExecutionRequest,
  result: Awaited<ReturnType<typeof executeArb>>,
  evidence: ExecutionEvidence,
  feeAuthority: AuthoritativeBotFeeConfig,
): BotEntryEvidenceV1 | null {
  const capturedAt = new Date().toISOString();
  const paperLeg = (
    venue: 'kalshi' | 'polymarket', order: OrderRequest, orderId: string | undefined, feeCents: number,
  ): BotEntryEvidenceLegV1 | null => {
    const quote = order.executableQuote;
    if (!orderId?.trim() || quote?.status !== 'executable' || !Array.isArray(quote.fills) || quote.fills.length === 0
      || !Number.isSafeInteger(quote.filledQuantityMicros) || quote.filledQuantityMicros <= 0
      || !Number.isSafeInteger(quote.totalCostMicroCents) || quote.totalCostMicroCents <= 0) return null;
    const fills = quote.fills.map((fill, index) => ({
      fillId: `${orderId}:quote:${index}`,
      fillAuthority: 'execution_quote' as const,
      priceMicrocents: fill.priceMicroCents ?? Math.round((fill.priceCents ?? Number.NaN) * 1_000_000),
      sizeMicrounits: fill.quantityMicros,
      observedAt: quote.depthTimestamp!,
    }));
    return {
      venue,
      marketId: venue === 'kalshi' ? order.ticker ?? order.marketId : order.conditionId ?? order.marketId,
      orderId,
      quantityMicrounits: quote.filledQuantityMicros,
      fills,
      grossMicrocents: quote.totalCostMicroCents,
      fee: venue === 'kalshi' ? {
        amountCents: feeCents, authority: 'execution_estimate', source: feeAuthority.kalshi.source,
        version: feeAuthority.kalshi.version, observedAt: feeAuthority.kalshi.observedAt, platformRounding: 'ceil_cent',
      } : {
        amountCents: feeCents, authority: 'execution_estimate', source: feeAuthority.polymarket.source,
        version: feeAuthority.polymarket.version, observedAt: feeAuthority.polymarket.observedAt, platformRounding: 'nearest_cent',
      },
    };
  };
  const liveLeg = (
    venueEvidence: LiveExecutionEvidence['kalshi'], order: OrderRequest, orderId: string | undefined,
  ): BotEntryEvidenceLegV1 | null => {
    if (!orderId?.trim() || !Array.isArray(venueEvidence.fills) || venueEvidence.fills.length === 0) return null;
    const rawFills = venueEvidence.fills;
    const fills = rawFills.map((fill) => ({
      fillId: fill.executionId,
      fillAuthority: 'venue_fill' as const,
      priceMicrocents: Math.round(fill.price * 100_000_000),
      sizeMicrounits: Math.round(fill.quantity * 1_000_000),
      observedAt: fill.venueTimestamp,
      chargedFeeCents: fill.chargedFeeCents,
    }));
    const grossNumerator = fills.reduce((sum, fill) =>
      sum + BigInt(fill.priceMicrocents) * BigInt(fill.sizeMicrounits), 0n);
    return {
      venue: venueEvidence.venue,
      marketId: venueEvidence.venue === 'kalshi' ? order.ticker ?? order.marketId : order.conditionId ?? order.marketId,
      orderId,
      quantityMicrounits: Math.round(venueEvidence.filledQuantity * 1_000_000),
      fills,
      grossMicrocents: roundedRatio(grossNumerator, 1_000_000n),
      fee: {
        amountCents: venueEvidence.chargedFeeCents, authority: 'charged',
        source: `${venueEvidence.venue}-execution:${venueEvidence.executionId}`, version: 'venue-execution-evidence:v1',
        observedAt: venueEvidence.venueTimestamp, platformRounding: 'venue_reported',
      },
    };
  };

  let kalshi: BotEntryEvidenceLegV1 | null;
  let polymarket: BotEntryEvidenceLegV1 | null;
  if (evidence.kind === 'live') {
    kalshi = liveLeg(evidence.kalshi, request.kalshiOrder, result.kalshiResult.orderId);
    polymarket = liveLeg(evidence.polymarket, request.polymarketOrder, result.polymarketResult.orderId);
  } else {
    const kalshiFills = request.kalshiOrder.executableQuote?.fills.map((fill) => ({
      priceCents: (fill.priceMicroCents ?? 0) / 1_000_000, size: fill.quantityMicros / 1_000_000,
    }));
    const pmFills = request.polymarketOrder.executableQuote?.fills.map((fill) => ({
      priceCents: (fill.priceMicroCents ?? 0) / 1_000_000, size: fill.quantityMicros / 1_000_000,
    }));
    if (!kalshiFills?.length || !pmFills?.length) return null;
    const entryCost = calculateBotPositionEntryCost({
      kalshiFills, pmFills, pmTheta: feeAuthority.pmTheta,
      kalshiFeeMultiplierPpm: feeAuthority.kalshi.feeMultiplierPpm,
      pmFeeRateBps: feeAuthority.polymarket.feeRateBps,
    });
    kalshi = paperLeg('kalshi', request.kalshiOrder, result.kalshiResult.orderId, entryCost.kalshiEntryFeeCents);
    polymarket = paperLeg('polymarket', request.polymarketOrder, result.polymarketResult.orderId, entryCost.pmEntryFeeCents);
  }
  if (!kalshi || !polymarket) return null;
  return { schemaVersion: 1, capturedAt, economicActionId: arbId, mode: dryRun ? 'paper' : 'live', legs: { kalshi, polymarket } };
}

// ─── Defaults ────────────────────────────────────────────────────

const DEFAULT_BOT_SETTINGS: BotSettings = {
  enabled: false,
  mode: 'paper',
  selectionMethod: 'hybrid',
  minRoiPct: 2.0,
  minApyPct: 0,
  minDepthUsd: 0.5,
  minSharesPerLeg: 1,
  maxExpiryDays: 1,
  maxTradesPerDay: 10,
};

export interface BotExecutionReadiness {
  requestedMode: BotSettings['mode'];
  globalMode: ExecutionMode;
  authorizationConfigured: boolean;
  credentialsReady: boolean;
  effectiveMode: BotPositionExecutionMode;
  blockedReasons: string[];
}

// ─── Settings loading ────────────────────────────────────────────

export async function getBotSettings(): Promise<BotSettings> {
  const [enabled, mode, selectionMethod, minRoiPct, minApyPct, minDepthUsd, minSharesPerLeg, maxExpiryDays, maxTradesPerDay] = await Promise.all([
    getSetting<boolean>('bot.enabled').catch(() => DEFAULT_BOT_SETTINGS.enabled),
    getSetting<string>('bot.mode').catch(() => DEFAULT_BOT_SETTINGS.mode),
    getSetting<BotSelectionMethod>('bot.selectionMethod').catch(() => DEFAULT_BOT_SETTINGS.selectionMethod),
    getSetting<number>('bot.minRoiPct').catch(() => DEFAULT_BOT_SETTINGS.minRoiPct),
    getSetting<number>('bot.minApyPct').catch(() => DEFAULT_BOT_SETTINGS.minApyPct),
    getSetting<number>('bot.minDepthUsd').catch(() => DEFAULT_BOT_SETTINGS.minDepthUsd),
    getSetting<number>('bot.minSharesPerLeg').catch(() => DEFAULT_BOT_SETTINGS.minSharesPerLeg),
    getSetting<number>('bot.maxExpiryDays').catch(() => DEFAULT_BOT_SETTINGS.maxExpiryDays),
    getSetting<number>('bot.maxTradesPerDay').catch(() => DEFAULT_BOT_SETTINGS.maxTradesPerDay),
  ]);

  return {
    enabled: enabled === true,
    mode: mode === 'production' ? 'production' : 'paper',
    selectionMethod: ['roi', 'apy', 'hybrid'].includes(selectionMethod) ? selectionMethod : 'hybrid',
    minRoiPct: Number.isFinite(minRoiPct) ? minRoiPct : DEFAULT_BOT_SETTINGS.minRoiPct,
    minApyPct: Number.isFinite(minApyPct) ? minApyPct : DEFAULT_BOT_SETTINGS.minApyPct,
    minDepthUsd: Number.isFinite(minDepthUsd) && minDepthUsd > 0
      ? minDepthUsd
      : DEFAULT_BOT_SETTINGS.minDepthUsd,
    minSharesPerLeg: Number.isFinite(minSharesPerLeg) && minSharesPerLeg >= 1
      ? Math.floor(minSharesPerLeg)
      : DEFAULT_BOT_SETTINGS.minSharesPerLeg,
    maxExpiryDays: Number.isFinite(maxExpiryDays) ? maxExpiryDays : DEFAULT_BOT_SETTINGS.maxExpiryDays,
    maxTradesPerDay: Number.isFinite(maxTradesPerDay) && maxTradesPerDay >= 1
      ? Math.floor(maxTradesPerDay)
      : DEFAULT_BOT_SETTINGS.maxTradesPerDay,
  };
}

export async function getBotExecutionReadiness(settings: BotSettings): Promise<BotExecutionReadiness> {
  const { getExecutionMode } = await import('./settings');
  const { getCredentialStatus } = await import('./execution-creds');
  const globalMode = await getExecutionMode().catch(() => 'paper' as const);
  const credentials = await getCredentialStatus().catch(() => ({ allReady: false }));
  const authorizationConfigured = process.env.H2H_AUTO_LIVE_ORDERS_AUTHORIZED === 'true';
  const blockedReasons = settings.mode === 'production' ? [
    ...(globalMode !== 'live' ? [`Global execute.mode must be live (currently ${globalMode})`] : []),
    ...(!authorizationConfigured ? ['Set H2H_AUTO_LIVE_ORDERS_AUTHORIZED=true in the protected PM2 environment'] : []),
    ...(!credentials.allReady ? ['Configure valid Kalshi and Polymarket execution credentials, then restart PM2 with --update-env'] : []),
  ] : [];
  return {
    requestedMode: settings.mode,
    globalMode,
    authorizationConfigured,
    credentialsReady: credentials.allReady,
    effectiveMode: settings.mode === 'production' && blockedReasons.length === 0 ? 'live' : 'paper',
    blockedReasons,
  };
}

export async function resolveBotExecutionMode(settings: BotSettings): Promise<BotPositionExecutionMode> {
  return (await getBotExecutionReadiness(settings)).effectiveMode;
}

// ─── Evaluation ──────────────────────────────────────────────────

function computeExpiryDays(expiryDate: string | undefined | null): number | null {
  if (!expiryDate) return null;
  const ms = new Date(expiryDate).getTime();
  if (!Number.isFinite(ms)) return null;
  const diffMs = ms - Date.now();
  return Math.max(0, diffMs / (1000 * 60 * 60 * 24));
}

function pickLegPrices(strategy: string, input: BotTradeInput): {
  kalshiPrice: number | null;
  pmPrice: number | null;
  kalshiOutcome: 'yes' | 'no';
  pmOutcome: 'yes' | 'no';
  supported: boolean;
} {
  const strategyLower = (strategy || '').toLowerCase();

  // Cross-outcome: buy YES on both platforms.
  if (strategyLower.includes('both sides')) {
    return {
      kalshiPrice: input.kalshiYesAsk ?? null,
      pmPrice: input.pmYesAsk ?? null,
      kalshiOutcome: 'yes',
      pmOutcome: 'yes',
      supported: true,
    };
  }

  // Same-platform internal arbs are not bot-tradeable (they require two Kalshi
  // or two PM orders on related outcomes; we only support two-leg cross-platform
  // for the bot's initial release).
  if (strategyLower.startsWith('same-platform')) {
    return { kalshiPrice: null, pmPrice: null, kalshiOutcome: 'yes', pmOutcome: 'yes', supported: false };
  }

  if (strategyLower.includes('yes kalshi')) {
    return {
      kalshiPrice: input.kalshiYesAsk ?? null,
      pmPrice: input.pmNoAsk ?? null,
      kalshiOutcome: 'yes',
      pmOutcome: 'no',
      supported: true,
    };
  }

  if (strategyLower.includes('yes pm')) {
    return {
      kalshiPrice: input.kalshiNoAsk ?? null,
      pmPrice: input.pmYesAsk ?? null,
      kalshiOutcome: 'no',
      pmOutcome: 'yes',
      supported: true,
    };
  }

  // Never guess from unknown strategy text: that can buy the opposite contract.
  return { kalshiPrice: null, pmPrice: null, kalshiOutcome: 'yes', pmOutcome: 'no', supported: false };
}

function validateSelectedPropositions(
  input: BotTradeInput,
  legs: ReturnType<typeof pickLegPrices>,
): PropositionValidation {
  const selectedPmToken = legs.pmOutcome === 'yes' ? input.pmYesTokenId : input.pmNoTokenId;
  const proposedCanonical = resolveCanonicalPropositionRelationship(input.propositionRelationship);
  const relationship = proposedCanonical ?? findCanonicalPropositionRelationship({
    kalshiTicker: input.kalshiTicker,
    pmConditionId: input.pmConditionId,
    pmTokenId: selectedPmToken,
    kalshiSide: legs.kalshiOutcome,
    pmSide: legs.pmOutcome,
  });
  if (!relationship) {
    return { valid: false, state: 'unknown', reason: 'Exact selected contracts are absent from the server-owned canonical proposition registry' };
  }
  if (input.propositionRelationship && !proposedCanonical) {
    return { valid: false, state: 'invalid_metadata', reason: 'Candidate proposition metadata does not match the canonical registry' };
  }
  const validation = validatePropositionRelationship(relationship);
  if (!validation.valid) return validation;
  const kalshi = relationship.legs.kalshi;
  const polymarket = relationship.legs.polymarket;
  if (kalshi.platformMarketId.trim().toLowerCase() !== input.kalshiTicker?.trim().toLowerCase()) {
    return { valid: false, state: 'invalid_metadata', reason: 'Canonical Kalshi proposition does not identify the selected ticker' };
  }
  if (polymarket.platformMarketId.trim().toLowerCase() !== input.pmConditionId?.trim().toLowerCase()) {
    return { valid: false, state: 'invalid_metadata', reason: 'Canonical Polymarket proposition does not identify the selected condition' };
  }
  if (kalshi.contractSide !== legs.kalshiOutcome || polymarket.contractSide !== legs.pmOutcome) {
    return { valid: false, state: 'invalid_metadata', reason: 'Canonical contract sides do not match the strategy-selected orders' };
  }
  if (!selectedPmToken || polymarket.tokenId !== selectedPmToken) {
    return { valid: false, state: 'invalid_metadata', reason: 'Canonical Polymarket token does not match the strategy-selected token' };
  }
  return { valid: true };
}

export function getAuthoritativeMatchedFill(result: {
  kalshiResult: Pick<OrderResult, 'filledContracts' | 'filledPrice'>;
  polymarketResult: Pick<OrderResult, 'filledContracts' | 'filledPrice'>;
}): {
  kalshiContracts: number;
  pmContracts: number;
  kalshiPrice: number;
  pmPrice: number;
  kalshiFills?: Array<{ priceCents: number; size: number }>;
  pmFills?: Array<{ priceCents: number; size: number }>;
  kalshiChargedFeeCents?: number;
  pmChargedFeeCents?: number;
} | null {
  const kalshiContracts = result.kalshiResult.filledContracts;
  const pmContracts = result.polymarketResult.filledContracts;
  const kalshiPrice = result.kalshiResult.filledPrice;
  const pmPrice = result.polymarketResult.filledPrice;
  if (
    !Number.isSafeInteger(kalshiContracts) || Number(kalshiContracts) <= 0
    || !Number.isSafeInteger(pmContracts) || Number(pmContracts) <= 0
    || kalshiContracts !== pmContracts
    || typeof kalshiPrice !== 'number' || !Number.isFinite(kalshiPrice) || kalshiPrice <= 0 || kalshiPrice > 1
    || typeof pmPrice !== 'number' || !Number.isFinite(pmPrice) || pmPrice <= 0 || pmPrice > 1
  ) return null;
  return { kalshiContracts: Number(kalshiContracts), pmContracts: Number(pmContracts), kalshiPrice, pmPrice };
}

function executableBookUnavailableReason(
  venue: 'Kalshi' | 'Polymarket',
  side: 'yes' | 'no',
  quote: ExecutableBookQuote,
): string {
  const label = `${venue} ${side.toUpperCase()}`;
  const observed = quote.depthTimestamp ? ` (observed ${quote.depthTimestamp})` : '';
  if (quote.reason === 'authoritative_empty') {
    return `${label} authoritative book is empty${observed}`;
  }
  if (quote.reason === 'empty_book') {
    return `${label} legacy empty-book evidence is non-authoritative${observed}`;
  }
  if (quote.reason === 'missing_depth') return `${label} ask depth is missing${observed}`;
  if (quote.reason === 'malformed_depth' || quote.reason === 'malformed_level') {
    return `${label} ask depth is malformed${observed}`;
  }
  if (quote.reason === 'inactive_market') return `${label} market is inactive${observed}`;
  if (quote.reason === 'stale_book') return `${label} order book is stale${observed}`;
  if (quote.reason === 'source_unavailable') return `${label} venue response is unavailable${observed}`;
  return `${label} executable book is unavailable: ${quote.reason ?? 'unknown_reason'}${observed}`;
}

export function evaluateBotTrade(
  input: BotTradeInput,
  settings: BotSettings,
): BotTradeEvaluation {
  const reasons: string[] = [];

  if ((input.strategy || '').toLowerCase().startsWith('same-platform yes+yes')) {
    reasons.push('Invalid legacy Internal arb: same-platform YES+YES is directional duplication');
  }

  if (!settings.enabled) {
    return {
      shouldTrade: false,
      reason: 'BotTrader is disabled',
      criteria: buildCriteria(input, reasons),
    };
  }

  const roiPct = input.roiPct ?? 0;
  if (roiPct <= 0) {
    return {
      shouldTrade: false,
      reason: `ROI ${roiPct.toFixed(2)}% is not positive`,
      criteria: buildCriteria(input, reasons),
    };
  }

  if (settings.selectionMethod !== 'apy' && roiPct < settings.minRoiPct) {
    reasons.push(`ROI ${roiPct.toFixed(2)}% < min ${settings.minRoiPct.toFixed(2)}%`);
  }

  const apyPct = input.apyPct ?? 0;
  if (settings.selectionMethod !== 'roi' && settings.minApyPct > 0 && apyPct < settings.minApyPct) {
    reasons.push(`APY ${apyPct.toFixed(2)}% < min ${settings.minApyPct.toFixed(2)}%`);
  }

  const expiryDays = computeExpiryDays(input.expiryDate);
  if (expiryDays !== null && settings.maxExpiryDays > 0 && expiryDays > settings.maxExpiryDays) {
    reasons.push(`Expires in ${expiryDays.toFixed(2)}d > max ${settings.maxExpiryDays}d`);
  }

  const legs = pickLegPrices(input.strategy, input);
  if (!legs.supported) reasons.push(`Unsupported strategy: ${input.strategy || '(empty)'}`);
  const propositionValidation = validateSelectedPropositions(input, legs);
  if (!propositionValidation.valid) reasons.push(propositionValidation.reason);
  if (input.strategy.startsWith('Buy YES both sides:')
      && (input.crossOutcomeMutuallyExclusiveVerified !== true || input.crossOutcomeExhaustiveVerified !== true)) {
    reasons.push('Cross-outcome resolution evidence is unavailable');
  }
  if (legs.kalshiPrice == null || legs.pmPrice == null) {
    reasons.push('Missing tradeable ask price on one or both legs');
  }
  const pmMinimumOrderSize = legs.pmOutcome === 'yes' ? input.pmYesMinOrderSize : input.pmNoMinOrderSize;
  const pmTickSize = legs.pmOutcome === 'yes' ? input.pmYesTickSize : input.pmNoTickSize;
  if (!Number.isFinite(pmMinimumOrderSize) || pmMinimumOrderSize! <= 0) {
    reasons.push(`Polymarket ${legs.pmOutcome.toUpperCase()} minimum order is unavailable`);
  }
  const canonicalExecutableQuantity = 1;
  const evaluationQuantity = Math.ceil(Math.max(
    canonicalExecutableQuantity,
    settings.minSharesPerLeg,
    pmMinimumOrderSize ?? 0,
  ));
  if (Number.isFinite(pmMinimumOrderSize) && pmMinimumOrderSize! > canonicalExecutableQuantity) {
    reasons.push(`Polymarket ${legs.pmOutcome.toUpperCase()} minimum order ${pmMinimumOrderSize} exceeds canonical executable quantity 1; evaluation quantity ${evaluationQuantity} is pricing-only and no ${evaluationQuantity}-share order can be placed`);
  }
  if (!Number.isFinite(pmTickSize) || pmTickSize! <= 0) {
    reasons.push(`Polymarket ${legs.pmOutcome.toUpperCase()} tick size is unavailable`);
  } else if (legs.pmPrice != null
      && !isPriceAlignedToTick(legs.pmPrice, pmTickSize!)) {
    reasons.push(`Polymarket ${legs.pmOutcome.toUpperCase()} price is not aligned to tick size ${pmTickSize}`);
  }

  const { depthKUsd, depthPUsd } = legDepths(legs, input);
  const sharesK = legs.kalshiPrice != null && legs.kalshiPrice > 0
    ? depthKUsd / legs.kalshiPrice
    : 0;
  const sharesP = legs.pmPrice != null && legs.pmPrice > 0
    ? depthPUsd / legs.pmPrice
    : 0;

  const selectedQuotes = pickLegQuotes(input.strategy, input);
  const kalshiUnavailable = !selectedQuotes.kalshiQuote
    || selectedQuotes.kalshiQuote.status === 'unavailable';
  const pmUnavailable = !selectedQuotes.pmQuote
    || selectedQuotes.pmQuote.status === 'unavailable';
  if (!selectedQuotes.kalshiQuote) {
    reasons.push(`Kalshi ${legs.kalshiOutcome.toUpperCase()} executable quote is unavailable`);
  } else if (kalshiUnavailable) {
    reasons.push(executableBookUnavailableReason('Kalshi', legs.kalshiOutcome, selectedQuotes.kalshiQuote!));
  }
  if (!selectedQuotes.pmQuote) {
    reasons.push(`Polymarket ${legs.pmOutcome.toUpperCase()} executable quote is unavailable`);
  } else if (pmUnavailable) {
    reasons.push(executableBookUnavailableReason('Polymarket', legs.pmOutcome, selectedQuotes.pmQuote!));
  }
  if (selectedQuotes.kalshiQuote?.status === 'executable') {
    const kalshiTickMicroCents = selectedQuotes.kalshiQuote.tickSizeMicroCents;
    if (!Number.isSafeInteger(kalshiTickMicroCents) || kalshiTickMicroCents <= 0) {
      reasons.push(`Kalshi ${legs.kalshiOutcome.toUpperCase()} tick size is unavailable`);
    } else if (kalshiTickMicroCents !== 1_000_000) {
      reasons.push(`Kalshi ${legs.kalshiOutcome.toUpperCase()} tick size $${(kalshiTickMicroCents / 100_000_000).toFixed(6)} is unsupported by the cent-only execution adapter`);
    }
  }
  if ((!kalshiUnavailable && sharesK < evaluationQuantity) || (!pmUnavailable && sharesP < evaluationQuantity)) {
    reasons.push(
      `Insufficient shares at best ask for evaluation quantity ${evaluationQuantity}: ${kalshiUnavailable ? 'Kalshi unavailable' : `Kalshi ${sharesK.toFixed(2)}`} / ${pmUnavailable ? 'PM unavailable' : `PM ${sharesP.toFixed(2)}`}; canonical executable quantity remains 1`,
    );
  }

  // Executability is price-relative: N shares at a 24c ask require $0.24 × N,
  // not a fixed $0.50 on every leg. Depth values are best-ask dollar depth.
  const requiredDepthKUsd = (legs.kalshiPrice ?? 0) * evaluationQuantity;
  const requiredDepthPUsd = (legs.pmPrice ?? 0) * evaluationQuantity;
  if ((!kalshiUnavailable && depthKUsd < requiredDepthKUsd) || (!pmUnavailable && depthPUsd < requiredDepthPUsd)) {
    reasons.push(
      `Insufficient executable depth for evaluation quantity ${evaluationQuantity}: ${kalshiUnavailable ? 'Kalshi unavailable' : `Kalshi $${depthKUsd.toFixed(2)} / $${requiredDepthKUsd.toFixed(2)} required`}; ${pmUnavailable ? 'PM unavailable' : `PM $${depthPUsd.toFixed(2)} / $${requiredDepthPUsd.toFixed(2)} required`}; canonical executable quantity remains 1`,
    );
  }

  const criteria = buildCriteria(input, reasons, { depthKUsd, depthPUsd, sharesK, sharesP, expiryDays });

  if (reasons.length > 0) {
    return {
      shouldTrade: false,
      reason: reasons.join('; '),
      criteria,
    };
  }

  return {
    shouldTrade: true,
    reason: `ROI ${roiPct.toFixed(2)}%, APY ${apyPct.toFixed(2)}%, shares K=${sharesK.toFixed(2)} P=${sharesP.toFixed(2)}, depth K=$${depthKUsd.toFixed(2)} P=$${depthPUsd.toFixed(2)}`,
    criteria,
  };
}

function legDepths(
  legs: ReturnType<typeof pickLegPrices>,
  input: BotTradeInput,
): { depthKUsd: number; depthPUsd: number } {
  return {
    depthKUsd: legs.kalshiOutcome === 'yes' ? input.kalshiYesDepth ?? 0 : input.kalshiNoDepth ?? 0,
    depthPUsd: legs.pmOutcome === 'yes' ? input.pmYesDepth ?? 0 : input.pmNoDepth ?? 0,
  };
}

function pickLegQuotes(strategy: string, input: BotTradeInput): {
  kalshiQuote?: ExecutableBookQuote;
  pmQuote?: ExecutableBookQuote;
} {
  const strategyLower = (strategy || '').toLowerCase();
  if (strategyLower.includes('both sides')) {
    return { kalshiQuote: input.kalshiYesExecutableQuote, pmQuote: input.pmYesExecutableQuote };
  }
  if (strategyLower.includes('yes kalshi')) {
    return { kalshiQuote: input.kalshiYesExecutableQuote, pmQuote: input.pmNoExecutableQuote };
  }
  if (strategyLower.includes('yes pm')) {
    return { kalshiQuote: input.kalshiNoExecutableQuote, pmQuote: input.pmYesExecutableQuote };
  }
  return {};
}

function buildCriteria(
  input: BotTradeInput,
  reasons: string[],
  overrides?: Partial<BotTradeEvaluation['criteria']>,
): BotTradeEvaluation['criteria'] {
  const expiryDays = computeExpiryDays(input.expiryDate);
  const legs = pickLegPrices(input.strategy, input);
  const { depthKUsd, depthPUsd } = legDepths(legs, input);
  const sharesK = legs.kalshiPrice != null && legs.kalshiPrice > 0
    ? depthKUsd / legs.kalshiPrice
    : 0;
  const sharesP = legs.pmPrice != null && legs.pmPrice > 0
    ? depthPUsd / legs.pmPrice
    : 0;

  return {
    roiPct: input.roiPct ?? 0,
    apyPct: input.apyPct ?? 0,
    depthKUsd: overrides?.depthKUsd ?? depthKUsd,
    depthPUsd: overrides?.depthPUsd ?? depthPUsd,
    sharesK: overrides?.sharesK ?? sharesK,
    sharesP: overrides?.sharesP ?? sharesP,
    expiryDays: overrides?.expiryDays ?? expiryDays,
  };
}

// ─── Execution helpers ───────────────────────────────────────────

function safeArbId(pairId: string, outcome: string): string {
  const sanitized = (outcome || 'unknown').toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40);
  return `bot:${pairId}:${sanitized}`;
}

export function buildExecutionRequest(input: BotTradeInput, _configuredMinShares = 1): ExecutionRequest | null {
  const legs = pickLegPrices(input.strategy, input);
  if (!legs.supported || legs.kalshiPrice == null || legs.pmPrice == null) return null;
  if (!validateSelectedPropositions(input, legs).valid) return null;
  if (input.strategy.startsWith('Buy YES both sides:')
      && (input.crossOutcomeMutuallyExclusiveVerified !== true || input.crossOutcomeExhaustiveVerified !== true)) return null;
  if (!input.kalshiTicker || !input.pmConditionId) return null;
  if (!/^0x[0-9a-f]{64}$/i.test(input.pmConditionId.trim())) return null;
  const pmConditionId = input.pmConditionId.trim().toLowerCase();
  const pmMinimumOrderSize = legs.pmOutcome === 'yes'
    ? input.pmYesMinOrderSize
    : input.pmNoMinOrderSize;
  if (!Number.isFinite(pmMinimumOrderSize) || pmMinimumOrderSize! <= 0) return null;
  const pmTickSize = legs.pmOutcome === 'yes' ? input.pmYesTickSize : input.pmNoTickSize;
  if (!Number.isFinite(pmTickSize) || pmTickSize! <= 0) return null;

  const sourceShares = Math.min(
    input.kalshiStake > 0 ? input.kalshiStake / legs.kalshiPrice : Infinity,
    input.pmStake > 0 ? input.pmStake / legs.pmPrice : Infinity,
  );
  if (!Number.isFinite(sourceShares) || sourceShares <= 0) return null;

  const explicitQuotes = pickLegQuotes(input.strategy, input);
  // Scan, reservation, and execution share one canonical quantity. Never turn
  // a verified one-share opportunity into a larger order at the final boundary.
  if (pmMinimumOrderSize! > 1) return null;
  const contracts = 1;
  const requestedQuantityMicros = contracts * 1_000_000;
  const { depthPUsd } = legDepths(legs, input);
  const depthTimestamp = explicitQuotes.pmQuote?.depthTimestamp ?? explicitQuotes.kalshiQuote?.depthTimestamp ?? null;
  const rebuiltPmQuote = quoteOneShareFromTopAsk({
    price: legs.pmPrice, depthUsd: depthPUsd, tickSize: pmTickSize, minimumOrderSize: pmMinimumOrderSize,
    requestedQuantity: contracts, depthTimestamp,
  });
  const kalshiQuote = isExecutableQuoteConsistent(explicitQuotes.kalshiQuote, 'buy', requestedQuantityMicros)
    ? explicitQuotes.kalshiQuote
    : null;
  const pmQuote = isExecutableQuoteConsistent(explicitQuotes.pmQuote, 'buy', requestedQuantityMicros)
    ? explicitQuotes.pmQuote
    : rebuiltPmQuote;
  if (kalshiQuote?.status !== 'executable' || pmQuote?.status !== 'executable'
    || kalshiQuote.vwapPriceMicroCents == null || pmQuote.vwapPriceMicroCents == null
    || kalshiQuote.limitPriceMicroCents == null || pmQuote.limitPriceMicroCents == null) return null;
  // The installed Kalshi adapter submits integer cent prices. Until that
  // boundary supports fixed-point dollar prices, sub-cent quotes must remain
  // visible but non-executable rather than being rounded into another order.
  if (kalshiQuote.tickSizeMicroCents !== 1_000_000) return null;
  const kalshiExecutionPrice = kalshiQuote.vwapPriceMicroCents / 100_000_000;
  const pmExecutionPrice = pmQuote.vwapPriceMicroCents / 100_000_000;
  const kalshiLimitPrice = kalshiQuote.limitPriceMicroCents / 100_000_000;
  const pmLimitPrice = pmQuote.limitPriceMicroCents / 100_000_000;
  if (!isPriceAlignedToTick(pmLimitPrice, pmTickSize!)) return null;

  const kalshiStake = kalshiExecutionPrice * contracts;
  const pmStake = pmExecutionPrice * contracts;
  const oneShareNetProfit = input.expectedProfit / sourceShares;

  const kalshiOrder: OrderRequest = {
    platform: 'kalshi',
    marketId: input.kalshiTicker,
    ticker: input.kalshiTicker,
    side: 'buy',
    outcome: legs.kalshiOutcome,
    size: kalshiStake,
    contracts,
    minimumOrderSize: 1,
    tickSize: kalshiQuote.tickSizeMicroCents / 100_000_000,
    price: kalshiLimitPrice,
    orderType: 'limit',
    executableQuote: kalshiQuote,
  };

  const polymarketOrder: OrderRequest = {
    platform: 'polymarket',
    marketId: legs.pmOutcome === 'yes' ? input.pmYesTokenId ?? pmConditionId : input.pmNoTokenId ?? pmConditionId,
    conditionId: legs.pmOutcome === 'yes' ? input.pmYesTokenId ?? pmConditionId : input.pmNoTokenId ?? pmConditionId,
    side: 'buy',
    outcome: legs.pmOutcome,
    size: pmStake,
    contracts,
    minimumOrderSize: pmMinimumOrderSize!,
    tickSize: pmTickSize!,
    price: pmLimitPrice,
    orderType: 'limit',
    executableQuote: pmQuote,
  };

  return {
    arbId: safeArbId(input.pairId, input.outcome),
    marketTitle: input.marketTitle,
    // Keep the canonical parent separate from the selected outcome token used
    // by the CLOB order. Durable positions and snapshot lookups use this ID.
    pmConditionId,
    kalshiOrder,
    polymarketOrder,
    estimatedProfit: oneShareNetProfit * contracts,
    maxSlippagePct: 2.0,
    timeoutMs: 15000,
    dryRun: true, // overwritten by caller before executeArb()
    scanTime: new Date().toISOString(),
    bestPriceFound: true,
  };
}

export function revalidateBotTradeEconomics(
  input: BotTradeInput,
  settings: BotSettings,
  request: ExecutionRequest,
  authority: AuthoritativeBotFeeConfig,
): { eligible: boolean; reason: string; expectedProfit: number; roiPct: number; apyPct: number | null } {
  const quoteFills = (order: OrderRequest) => order.executableQuote!.fills.map((fill) => ({
    priceCents: fill.priceMicroCents != null ? fill.priceMicroCents / 1_000_000 : fill.priceCents!,
    size: fill.quantityMicros / 1_000_000,
  }));
  const costs = calculateBotPositionEntryCost({
    kalshiFills: quoteFills(request.kalshiOrder),
    pmFills: quoteFills(request.polymarketOrder),
    pmTheta: authority.pmTheta,
    kalshiFeeMultiplierPpm: authority.kalshi.feeMultiplierPpm,
    kalshiFeeType: authority.kalshi.feeType,
    pmFeeRateBps: authority.polymarket.feeRateBps,
  });
  const expectedProfit = (1_000_000 - costs.totalCostMicrousd) / 1_000_000;
  const roiPct = expectedProfit * 100;
  const apyPct = computeApy(roiPct, input.expiryDate);
  const reasons: string[] = [];
  if (expectedProfit <= 0) reasons.push(`Authoritative net profit $${expectedProfit.toFixed(5)} is not positive`);
  if (settings.selectionMethod !== 'apy' && roiPct < settings.minRoiPct) {
    reasons.push(`Authoritative ROI ${roiPct.toFixed(2)}% < min ${settings.minRoiPct.toFixed(2)}%`);
  }
  if (settings.selectionMethod !== 'roi' && settings.minApyPct > 0 && (apyPct ?? 0) < settings.minApyPct) {
    reasons.push(`Authoritative APY ${(apyPct ?? 0).toFixed(2)}% < min ${settings.minApyPct.toFixed(2)}%`);
  }
  return {
    eligible: reasons.length === 0,
    reason: reasons.length === 0 ? 'Authoritative fee economics verified' : reasons.join('; '),
    expectedProfit,
    roiPct,
    apyPct,
  };
}

async function countTodayBotTrades(executionMode: BotPositionExecutionMode): Promise<number> {
  const { createClient } = await import('@libsql/client');
  const c = createClient({ url: `file:${process.cwd()}/data/edgefinder.db` });
  try {
    const today = new Date().toISOString().slice(0, 10);
    const res = await c.execute({
      sql: `SELECT COUNT(*) AS cnt FROM executions WHERE source = 'bot' AND dry_run = ?
        AND paper_position_deleted_at IS NULL AND timestamp >= ? AND timestamp < ?`,
      args: [executionMode === 'paper' ? 1 : 0, `${today}T00:00:00.000Z`, `${today}T23:59:59.999Z`],
    });
    return Number((res.rows as Array<{ cnt?: unknown }>)[0]?.cnt ?? 0);
  } finally {
    c.close();
  }
}

/** Compute total proposed stake for the one-share execution plan. */
function proposedStakeUsd(input: BotTradeInput, configuredMinShares: number): number {
  const request = buildExecutionRequest(input, configuredMinShares);
  return request ? request.kalshiOrder.size + request.polymarketOrder.size : Infinity;
}

// ─── Main orchestrator ─────────────────────────────────────────

export async function maybeExecuteBotTrade(
  input: BotTradeInput,
): Promise<BotExecutionResult> {
  // A pair/outcome may be evaluated repeatedly. Keep each attempt as its own
  // chain while the execution arbId remains stable for duplicate prevention.
  const tradeId = `${safeArbId(input.pairId, input.outcome)}:${crypto.randomUUID()}`;
  const log = async (
    step: string,
    action: string,
    responseStatus: BotActionStatus,
    details: { requestPayload?: unknown; responsePayload?: unknown; errorReason?: string | null; durationMs?: number | null; alertMetadata?: unknown; qualificationOutcome?: 'qualified' | 'dead' } = {},
  ) => appendBotActionLog({
    tradeId,
    trigger: 'Scan found qualifying arb',
    marketId: input.pairId,
    marketTitle: input.marketTitle,
    step,
    action,
    responseStatus,
    ...details,
  }).catch((error) => logger.warn('[bot-trader] action log failed', { tradeId, step, error: String(error) }));

  await log('detection', `Scan found arb: ROI ${input.roiPct.toFixed(2)}%, APY ${(input.apyPct ?? 0).toFixed(2)}%, ${input.marketTitle}`, 'passed', {
    requestPayload: { pairId: input.pairId, outcome: input.outcome, strategy: input.strategy },
  });
  const settings = await getBotSettings();

  const evaluation = evaluateBotTrade(input, settings);
  await log('criteria_check', evaluation.reason, evaluation.shouldTrade ? 'passed' : 'failed', {
    requestPayload: settings,
    responsePayload: evaluation.criteria,
    errorReason: evaluation.shouldTrade ? null : evaluation.reason,
    qualificationOutcome: evaluation.shouldTrade ? undefined : 'dead',
  });
  if (!evaluation.shouldTrade) {
    return { executed: false, dryRun: true, reason: evaluation.reason };
  }

  if (!settings.enabled) {
    await log('preflight', 'BotTrader enabled check', 'failed', { errorReason: 'BotTrader disabled', qualificationOutcome: 'dead' });
    return { executed: false, dryRun: true, reason: 'BotTrader disabled' };
  }

  const arbId = safeArbId(input.pairId, input.outcome);
  const readiness = await getBotExecutionReadiness(settings);
  const executionMode = readiness.effectiveMode;
  const effectiveDryRun = executionMode === 'paper';
  if (settings.mode === 'production' && readiness.blockedReasons.length > 0) {
    const reason = `Production execution blocked: ${readiness.blockedReasons.join('; ')}`;
    await log('preflight', 'Production execution readiness', 'failed', {
      responsePayload: readiness,
      errorReason: reason,
      qualificationOutcome: 'dead',
    });
    const alert = await sendBotOperationalAlert(input, reason, tradeId).catch((error) => ({
      durable: false,
      delivered: false,
      error: `Alert persistence failed: ${error instanceof Error ? error.message : String(error)}`,
    }));
    return { executed: false, dryRun: false, reason: alert.durable ? reason : `${reason}; ${alert.error}` };
  }
  if (input.reservationMode != null && input.reservationMode !== executionMode) {
    const reason = `Execution mode changed after reservation (${input.reservationMode} -> ${executionMode})`;
    await log('preflight', 'Reservation mode check', 'failed', { errorReason: reason, qualificationOutcome: 'dead' });
    return { executed: false, dryRun: effectiveDryRun, reason };
  }

  // Duplicate-prevention: don't stack trades on the same pair/outcome.
  const alreadyOpen = await hasOpenBotPosition(arbId, executionMode).catch((e) => {
    logger.warn('[bot-trader] duplicate check failed', { arbId, error: String(e) });
    return true; // fail-safe: skip on error
  });
  if (alreadyOpen) {
    await log('preflight', 'Duplicate position check', 'failed', { errorReason: `Open bot position already exists for ${arbId}`, qualificationOutcome: 'dead' });
    return { executed: false, dryRun: true, reason: `Open bot position already exists for ${arbId}` };
  }

  // Daily exposure + trade count limits.
  const todayExposure = await getTodayBotExposure(executionMode).catch((e) => {
    logger.warn('[bot-trader] daily exposure check failed', { error: String(e) });
    return Infinity;
  });
  const todayTrades = await countTodayBotTrades(executionMode).catch(() => 0);
  const maxDailyExposure = await getSetting<number>('execute.maxDailyExposure').catch(() => 500);
  const requestedMinShares = effectiveDryRun ? settings.minSharesPerLeg : 1;
  const proposedStake = proposedStakeUsd(input, requestedMinShares);

  if (todayTrades >= settings.maxTradesPerDay) {
    await log('preflight', 'Daily trade limit check', 'failed', { responsePayload: { todayTrades, maxTradesPerDay: settings.maxTradesPerDay }, errorReason: 'Daily bot trade limit reached', qualificationOutcome: 'dead' });
    return {
      executed: false,
      dryRun: true,
      reason: `Daily bot trade limit reached (${todayTrades}/${settings.maxTradesPerDay})`,
    };
  }

  if (todayExposure + proposedStake > maxDailyExposure) {
    await log('preflight', 'Daily exposure limit check', 'failed', { responsePayload: { todayExposure, proposedStake, maxDailyExposure }, errorReason: 'Daily exposure limit reached', qualificationOutcome: 'dead' });
    return {
      executed: false,
      dryRun: true,
      reason: `Daily exposure limit reached: today $${todayExposure.toFixed(2)} + proposed $${proposedStake.toFixed(2)} > $${maxDailyExposure}`,
    };
  }

  const execReq = buildExecutionRequest(input, requestedMinShares);
  if (!execReq) {
    await log('preflight', 'Build two-leg execution request', 'failed', { errorReason: 'Missing leg data', qualificationOutcome: 'dead' });
    return { executed: false, dryRun: true, reason: 'Unable to build execution request (missing leg data)' };
  }

  execReq.dryRun = effectiveDryRun;
  await log('preflight', 'Execution request and safety gates verified', 'passed', {
    requestPayload: execReq,
    responsePayload: { effectiveDryRun, executionMode, readiness, todayTrades, todayExposure },
    qualificationOutcome: 'qualified',
  });

  const entryLegs = pickLegPrices(input.strategy, input);
  const selectedPmToken = entryLegs.pmOutcome === 'yes' ? input.pmYesTokenId : input.pmNoTokenId;
  const canonicalRelationship = resolveCanonicalPropositionRelationship(input.propositionRelationship)
    ?? findCanonicalPropositionRelationship({
      kalshiTicker: input.kalshiTicker,
      pmConditionId: input.pmConditionId,
      pmTokenId: selectedPmToken,
      kalshiSide: entryLegs.kalshiOutcome,
      pmSide: entryLegs.pmOutcome,
    });
  if (!canonicalRelationship) {
    return { executed: false, dryRun: effectiveDryRun, reason: 'Canonical proposition relationship became unavailable before execution' };
  }
  let feeAuthority: AuthoritativeBotFeeConfig;
  let resolvedKalshiAuthority: KalshiFeeAuthority;
  let executionInput: BotTradeInput = { ...input, propositionRelationship: canonicalRelationship };
  try {
    if (!entryLegs.supported || !input.kalshiTicker || !input.pmConditionId || !input.category?.trim()) {
      throw new Error('Missing supported venue legs, identifiers, or market category');
    }
    feeAuthority = await fetchAuthoritativeBotFeeConfig({
      kalshiTicker: input.kalshiTicker,
      pmConditionId: execReq.pmConditionId!,
      pmTokenId: entryLegs.pmOutcome === 'yes' ? input.pmYesTokenId ?? undefined : input.pmNoTokenId ?? undefined,
      pmSide: entryLegs.pmOutcome,
      category: input.category,
    });
    if (!feeAuthority.kalshi.authority) throw new Error('Resolved Kalshi fee identity unavailable');
    resolvedKalshiAuthority = feeAuthority.kalshi.authority;
    // Placement and fee authority must bind the exact same executable token.
    execReq.polymarketOrder.marketId = feeAuthority.polymarket.tokenId;
    execReq.polymarketOrder.conditionId = feeAuthority.polymarket.tokenId;
    execReq.kalshiOrder.kalshiFeeQuote = calculateKalshiFeeQuote(resolvedKalshiAuthority, 'taker', [{
      fills: [{
        contracts: execReq.kalshiOrder.contracts ?? execReq.kalshiOrder.size,
        priceCents: execReq.kalshiOrder.price * 100,
      }],
    }]);
    execReq.polymarketOrder.signingFeeRateBps = feeAuthority.polymarket.orderBaseFeeBps;
    const economics = revalidateBotTradeEconomics(input, settings, execReq, feeAuthority);
    if (!economics.eligible) throw new Error(economics.reason);
    execReq.estimatedProfit = economics.expectedProfit;
    executionInput = {
      ...input,
      propositionRelationship: canonicalRelationship,
      expectedProfit: economics.expectedProfit,
      roiPct: economics.roiPct,
      apyPct: economics.apyPct ?? undefined,
    };
  } catch (error) {
    const reason = `Authoritative fee authority/economics preflight failed: ${String(error)}`;
    await log('safety-gate', reason, 'failed', { errorReason: reason });
    logger.warn('[bot-trader] fee authority preflight failed', { arbId, error: String(error) });
    return { executed: false, dryRun: effectiveDryRun, reason };
  }

  logger.info('[bot-trader] executing trade', {
    arbId,
    pairId: input.pairId,
    marketTitle: input.marketTitle,
    dryRun: effectiveDryRun,
    mode: settings.mode,
    executionMode,
  });

  const executionStarted = Date.now();
  const result = await executeArb(execReq);
  if (result.kalshiResult.filledContracts != null && result.kalshiResult.filledPrice != null) {
    const evidence = result.kalshiResult.venueEvidence;
    const fills = evidence?.fills?.length
      ? evidence.fills.map((fill) => ({
        contracts: fill.quantity,
        priceCents: fill.price * 100,
        liquidityRole: fill.liquidityRole,
      }))
      : [{
        contracts: result.kalshiResult.filledContracts,
        priceCents: result.kalshiResult.filledPrice * 100,
        liquidityRole: evidence?.liquidityRole,
      }];
    result.kalshiFeeQuote = calculateKalshiFeeQuote(
      resolvedKalshiAuthority,
      evidence?.liquidityRole ?? 'taker',
      [{ fills, chargedFeeCents: evidence?.chargedFeeCents ?? result.kalshiResult.chargedFeeCents }],
    );
  } else {
    result.kalshiFeeQuote = execReq.kalshiOrder.kalshiFeeQuote;
  }
  const executionDurationMs = Date.now() - executionStarted;
  for (const step of result.steps ?? []) {
    const rawStatus = String(step.status ?? '').toLowerCase();
    const responseStatus: BotActionStatus = rawStatus === 'failed' || rawStatus === 'timeout' ? 'failed' : rawStatus === 'pending' ? 'pending' : 'passed';
    await log('execution', step.description || 'Execution step', responseStatus, {
      responsePayload: step.metadata,
      errorReason: responseStatus === 'failed' ? step.description : null,
    });
  }
  const executionRecord: ExecutionRecord = {
    timestamp: new Date().toISOString(),
    arbId,
    marketTitle: input.marketTitle,
    dryRun: effectiveDryRun,
    success: result.success,
    strategy: input.strategy,
    kalshiOrder: execReq.kalshiOrder,
    polymarketOrder: execReq.polymarketOrder,
    result,
    estimatedProfit: executionInput.expectedProfit,
    steps: result.steps,
    source: 'bot',
    selectionMethod: input.selectionMethod ?? null,
    propositionRelationship: canonicalRelationship,
    sourceScanId: input.sourceScanId ?? null,
    sourceOpportunityId: input.sourceOpportunityId ?? null,
  };

  const performanceEvidence = getBotPerformanceEvidence(result, effectiveDryRun);
  const durableEntryEvidence = performanceEvidence == null
    ? null
    : buildBotEntryEvidence(arbId, effectiveDryRun, execReq, result, performanceEvidence, feeAuthority);
  const shouldPersistPerformance = performanceEvidence != null && durableEntryEvidence != null;
  executionRecord.botEntryEvidence = durableEntryEvidence;
  if (performanceEvidence?.kind === 'live') {
    executionRecord.timestamp = [
      performanceEvidence.kalshi.venueTimestamp,
      performanceEvidence.polymarket.venueTimestamp,
    ].sort().at(-1)!;
    executionRecord.estimatedProfit = performanceEvidence.actualProfit;
  }

  let executionId: number | undefined;
  let positionPersisted = false;
  let persistenceError: string | undefined;
  try {
    executionId = (await persistBotPerformanceExecution(
      executionRecord,
      shouldPersistPerformance ? performanceEvidence : null,
    )) ?? undefined;
  } catch (e) {
    persistenceError = `Execution persistence failed: ${String(e)}`;
    logger.warn('[bot-trader] persistExecution failed', { arbId, error: String(e) });
  }

  // Record bot position linked to the execution
  if (executionId != null && shouldPersistPerformance) {
    try {
      const fill = performanceEvidence?.kind === 'live'
        ? liveEvidenceToBotPositionFill(performanceEvidence)
        : getAuthoritativeMatchedFill(result);
      if (entryLegs.kalshiPrice != null && entryLegs.pmPrice != null && fill) {
        await recordBotPosition({
          executionId,
          executionMode,
          pairId: input.pairId,
          marketTitle: input.marketTitle,
          kalshiTicker: input.kalshiTicker ?? null,
          pmConditionId: execReq.pmConditionId ?? null,
          strategy: input.strategy,
          propositionRelationship: canonicalRelationship,
          kalshiMarketQuestion: canonicalRelationship.legs.kalshi.marketQuestion,
          pmMarketQuestion: canonicalRelationship.legs.polymarket.marketQuestion,
          kalshiOutcomeLabel: canonicalRelationship.legs.kalshi.payoutState,
          pmOutcomeLabel: canonicalRelationship.legs.polymarket.payoutState,
          outcomeIdentityStatus: 'verified',
          outcomeIdentitySource: 'canonical_proposition_relationship_v1',
          outcomeIdentityRecordedAt: canonicalRelationship.verifiedAt,
          outcomeIdentityFailureReason: null,
          kalshiSide: entryLegs.kalshiOutcome,
          pmSide: entryLegs.pmOutcome,
          kalshiPrice: fill.kalshiPrice,
          pmPrice: fill.pmPrice,
          kalshiContracts: fill.kalshiContracts,
          pmContracts: fill.pmContracts,
          ...(performanceEvidence?.kind === 'live' ? {
            kalshiFills: fill.kalshiFills,
            pmFills: fill.pmFills,
            kalshiChargedFeeCents: fill.kalshiChargedFeeCents,
            pmChargedFeeCents: fill.pmChargedFeeCents,
            pmChargedFeeMicrousd: performanceEvidence.polymarket.chargedFeeMicrousd,
          } : {}),
          expectedProfit: result.actualProfit ?? execReq.estimatedProfit,
          expiryDate: input.expiryDate ?? null,
          selectionMethod: input.selectionMethod ?? null,
          category: input.category ?? null,
        }, feeAuthority);
        positionPersisted = true;
      }
    } catch (e) {
      persistenceError = `Position persistence failed: ${String(e)}`;
      logger.warn('[bot-trader] recordBotPosition failed', { arbId, error: String(e) });
    }
  }

  const publication = getBotTradePublication({
    dryRun: effectiveDryRun,
    marketTitle: input.marketTitle,
    resultSuccess: result.success,
    shouldPersistPerformance,
    positionPersisted,
    persistenceError,
  });
  await log('result', publication.reason, publication.executed ? 'passed' : 'failed', {
    requestPayload: execReq,
    responsePayload: result,
    errorReason: publication.executed ? null : (persistenceError ?? result.error ?? publication.reason),
    durationMs: executionDurationMs,
    alertMetadata: result.alerts,
  });

  const publicationResult = {
    ...result,
    success: publication.alertSuccess,
    error: publication.alertSuccess ? result.error : (persistenceError ?? result.error ?? publication.reason),
  };
  const alertStatus = await sendBotExecutionAlert(
    executionInput,
    publicationResult,
    effectiveDryRun,
    executionInput.roiPct,
    tradeId,
  );
  const auditedResult = { ...result, alertDelivery: alertStatus };
  executionRecord.result = auditedResult;
  if (!alertStatus.delivered) {
    await log('alert', result.unhedged ? 'Unhedged exposure alert delivery' : 'Execution alert delivery', 'failed', {
      responsePayload: alertStatus,
      errorReason: alertStatus.error ?? 'Alert was not delivered',
      alertMetadata: { unhedged: result.unhedged, alerts: result.alerts },
    });
  }
  return {
    executed: publication.executed,
    dryRun: effectiveDryRun,
    reason: publication.reason,
    exposureState: publication.exposureState,
    executionRecord,
    executionResult: auditedResult,
    executionId,
    positionPersisted,
    persistenceError,
    alertStatus,
  };
}

export async function sendBotExecutionAlert(
  input: BotTradeInput,
  result: Pick<Awaited<ReturnType<typeof executeArb>>, 'success' | 'unhedged' | 'error' | 'alerts'>,
  dryRun: boolean,
  roiPct: number,
  tradeId: string,
): Promise<BotAlertStatus> {
  const config = await getConfigResolved();
  const emoji = result.unhedged ? '🚨' : dryRun ? '🤖' : '🦾';
  const modeLabel = dryRun ? 'PAPER' : 'PRODUCTION';
  const status = result.unhedged ? 'UNHEDGED EXPOSURE' : result.success ? 'placed' : 'attempted';

  const escapeTelegramHtml = (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  const relationship = input.propositionRelationship;
  const kalshiLabel = input.kalshiOutcomeLabel ?? relationship?.legs.kalshi.selectedOutcome ?? 'Outcome metadata missing';
  const pmLabel = input.pmOutcomeLabel ?? relationship?.legs.polymarket.selectedOutcome ?? 'Outcome metadata missing';
  const relationshipLabel = relationship?.humanLabel ?? (input.relationshipState === 'verified_complementary' ? 'Verified complementary' : input.relationshipState ?? 'Legacy / unknown');
  const relationshipExplanation = input.relationshipExplanation ?? (relationship ? 'Canonical registry verification for the exact selected legs.' : 'Canonical relationship evidence was not persisted.');
  const text = [
    `${emoji} <b>BotTrader ${status} — ${modeLabel}</b>`,
    '',
    `<b>Market:</b> ${escapeTelegramHtml(input.marketTitle)}`,
    `<b>Kalshi question:</b> ${escapeTelegramHtml(input.kalshiMarketQuestion ?? 'Market question metadata missing')}`,
    `<b>Kalshi:</b> ${escapeTelegramHtml(kalshiLabel)} — ${(relationship?.legs.kalshi.contractSide ?? 'yes').toUpperCase()}`,
    `<b>Polymarket question:</b> ${escapeTelegramHtml(input.pmMarketQuestion ?? 'Market question metadata missing')}`,
    `<b>Polymarket:</b> ${escapeTelegramHtml(pmLabel)} — ${(relationship?.legs.polymarket.contractSide ?? 'no').toUpperCase()}`,
    `<b>Relationship:</b> ${escapeTelegramHtml(relationshipLabel)} — ${escapeTelegramHtml(relationshipExplanation)}`,
    ...(relationship ? [
      `<b>Canonical Kalshi leg:</b> ${escapeTelegramHtml(relationship.legs.kalshi.humanLabel)}`,
      `<b>Canonical Polymarket leg:</b> ${escapeTelegramHtml(relationship.legs.polymarket.humanLabel)}`,
    ] : []),
    `<b>Strategy:</b> ${escapeTelegramHtml(input.strategy)}`,
    `<b>ROI:</b> ${roiPct.toFixed(2)}%`,
    `<b>Profit:</b> $${input.expectedProfit.toFixed(2)}`,
    `<b>Stake:</b> $${(input.kalshiStake + input.pmStake).toFixed(2)}`,
    ...(result.error ? [`<b>Error:</b> ${escapeTelegramHtml(result.error)}`] : []),
    ...(result.unhedged ? ['<b>Action:</b> Immediate exposure reconciliation required'] : []),
  ].join('\n');
  const chatId = config?.botTraderChatId || config?.chatId || process.env.TELEGRAM_BOT_TRADER_CHAT_ID || process.env.TELEGRAM_CHAT_ID || null;
  const messageType: BotMessageType = result.success ? 'trade_placed' : 'trade_failed';
  let messageId: number;
  if (!config || !chatId) {
    try {
      await createBotMessage({ chatId, messageText: text, messageType, tradeId, marketId: input.pairId, marketTitle: input.marketTitle, status: 'failed', errorReason: 'Telegram not configured' });
      return { durable: true, delivered: false, error: 'Telegram not configured' };
    } catch (error) {
      return { durable: false, delivered: false, error: `Alert persistence failed: ${error instanceof Error ? error.message : String(error)}` };
    }
  }
  if (await isPausedResolved()) {
    try {
      await createBotMessage({ chatId, messageText: text, messageType, tradeId, marketId: input.pairId, marketTitle: input.marketTitle, status: 'paused' });
      return { durable: true, delivered: false, error: 'Telegram delivery paused' };
    } catch (error) {
      return { durable: false, delivered: false, error: `Alert persistence failed: ${error instanceof Error ? error.message : String(error)}` };
    }
  }
  try {
    messageId = await createBotMessage({ chatId, messageText: text, messageType, tradeId, marketId: input.pairId, marketTitle: input.marketTitle, status: 'pending' });
  } catch (error) {
    return { durable: false, delivered: false, error: `Alert persistence failed: ${error instanceof Error ? error.message : String(error)}` };
  }
  const sent = await sendTelegramMessage(config.botToken, chatId, text).catch((error) => ({
    ok: false as const,
    error: error instanceof Error ? error.message : String(error),
  }));
  try {
    await updateBotMessage(messageId, sent.ok
      ? { status: 'sent', telegramMessageId: sent.messageId }
      : { status: 'failed', errorReason: sent.error || 'Telegram send failed' });
  } catch (error) {
    return {
      durable: true,
      delivered: sent.ok,
      error: `Alert status update failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  return { durable: true, delivered: sent.ok, ...(sent.ok ? {} : { error: sent.error || 'Telegram send failed' }) };
}

export async function sendBotOperationalAlert(
  input: Pick<BotTradeInput, 'pairId' | 'marketTitle' | 'outcome'>,
  reason: string,
  tradeId = `bot-operational:${crypto.randomUUID()}`,
): Promise<{ durable: boolean; delivered: boolean; error?: string }> {
  const config = await getConfigResolved();
  const chatId = config?.botTraderChatId || config?.chatId || process.env.TELEGRAM_BOT_TRADER_CHAT_ID || process.env.TELEGRAM_CHAT_ID || null;
  const escapeTelegramHtml = (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  const text = `🚨 <b>Ragnar production execution blocked</b>\n\n<b>Market:</b> ${escapeTelegramHtml(input.marketTitle)}\n<b>Outcome:</b> ${escapeTelegramHtml(input.outcome)}\n<b>Remediation:</b> ${escapeTelegramHtml(reason)}`;
  let messageId: number;
  try {
    messageId = await createBotMessage({
      chatId,
      messageText: text,
      messageType: 'trade_failed',
      tradeId,
      marketId: input.pairId,
      marketTitle: input.marketTitle,
      status: config && chatId ? 'pending' : 'failed',
      errorReason: config && chatId ? null : 'Telegram not configured',
    });
  } catch (error) {
    return {
      durable: false,
      delivered: false,
      error: `Alert persistence failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (!config || !chatId) return { durable: true, delivered: false, error: 'Telegram not configured' };
  const sent = await sendTelegramMessage(config.botToken, chatId, text);
  await updateBotMessage(messageId, sent.ok
    ? { status: 'sent', telegramMessageId: sent.messageId }
    : { status: 'failed', errorReason: sent.error || 'Telegram send failed' });
  return { durable: true, delivered: sent.ok, ...(sent.ok ? {} : { error: sent.error || 'Telegram send failed' }) };
}

// ─── Convenience adapters ────────────────────────────────────────

export function unifiedOutcomeToBotInput(
  pairId: string,
  marketTitle: string,
  expiryDate: string | undefined,
  outcome: UnifiedOutcome,
): BotTradeInput {
  const a = outcome.arbitrage;
  const input: BotTradeInput = {
    pairId,
    marketTitle,
    outcome: outcome.artist,
    strategy: a.strategy,
    propositionRelationship: outcome.propositionRelationship ?? null,
    roiPct: a.roiPct,
    apyPct: a.apyPct ?? null,
    expectedProfit: a.expectedProfit,
    kalshiStake: a.kalshiStake,
    pmStake: a.pmStake,
    kalshiTicker: outcome.kalshi?.ticker ?? null,
    pmConditionId: outcome.polymarket?.conditionId ?? null,
    pmYesTokenId: outcome.polymarket?.yesTokenId ?? null,
    pmNoTokenId: outcome.polymarket?.noTokenId ?? null,
    kalshiYesAsk: outcome.kalshi?.yesAsk ?? null,
    kalshiNoAsk: outcome.kalshi?.noAsk ?? null,
    pmYesAsk: outcome.polymarket?.bestAsk ?? null,
    pmNoAsk: outcome.polymarket?.noPrice ?? null,
    kalshiYesDepth: parseDepth(outcome.kalshi?.yesAskDepth),
    kalshiNoDepth: parseDepth(outcome.kalshi?.noAskDepth),
    pmYesDepth: outcome.polymarket?.askDepth ?? 0,
    pmNoDepth: outcome.polymarket?.noAskDepth ?? 0,
    pmYesMinOrderSize: outcome.polymarket?.yesMinOrderSize ?? null,
    pmNoMinOrderSize: outcome.polymarket?.noMinOrderSize ?? null,
    pmYesTickSize: outcome.polymarket?.yesTickSize ?? null,
    pmNoTickSize: outcome.polymarket?.noTickSize ?? null,
    expiryDate,
  };
  const legs = pickLegPrices(input.strategy, input);
  const selectedPmToken = legs.pmOutcome === 'yes' ? input.pmYesTokenId : input.pmNoTokenId;
  input.propositionRelationship = resolveCanonicalPropositionRelationship(input.propositionRelationship)
    ?? findCanonicalPropositionRelationship({
      kalshiTicker: input.kalshiTicker,
      pmConditionId: input.pmConditionId,
      pmTokenId: selectedPmToken,
      kalshiSide: legs.kalshiOutcome,
      pmSide: legs.pmOutcome,
    });
  return input;
}

export function liveArbResultToBotInput(
  pairId: string,
  marketTitle: string,
  expiryDate: string | undefined,
  result: LiveArbResult,
): BotTradeInput {
  const input: BotTradeInput = {
    pairId,
    marketTitle,
    outcome: result.artist,
    strategy: result.strategy,
    propositionRelationship: result.propositionRelationship ?? null,
    roiPct: result.roiPct,
    apyPct: null,
    expectedProfit: result.expectedProfit,
    kalshiStake: result.kalshiStake,
    pmStake: result.pmStake,
    kalshiTicker: result.kalshiTicker ?? null,
    pmConditionId: result.pmConditionId ?? null,
    pmYesTokenId: result.pmYesTokenId ?? null,
    pmNoTokenId: result.pmNoTokenId ?? null,
    category: result.category,
    kalshiYesAsk: result.kalshiYesAsk,
    kalshiNoAsk: result.kalshiNoAsk,
    pmYesAsk: result.pmYesAsk,
    pmNoAsk: result.pmNoAsk,
    kalshiYesDepth: result.kalshiYesDepth,
    kalshiNoDepth: result.kalshiNoDepth,
    pmYesDepth: result.pmYesDepth,
    pmNoDepth: result.pmNoDepth,
    kalshiYesExecutableQuote: result.kalshiYesExecutableQuote,
    kalshiNoExecutableQuote: result.kalshiNoExecutableQuote,
    pmYesExecutableQuote: result.pmYesExecutableQuote,
    pmNoExecutableQuote: result.pmNoExecutableQuote,
    pmYesMinOrderSize: result.pmYesMinOrderSize ?? null,
    pmNoMinOrderSize: result.pmNoMinOrderSize ?? null,
    pmYesTickSize: result.pmYesTickSize ?? null,
    pmNoTickSize: result.pmNoTickSize ?? null,
    crossOutcomeMutuallyExclusiveVerified: result.crossOutcomeMutuallyExclusiveVerified === true,
    crossOutcomeExhaustiveVerified: result.crossOutcomeExhaustiveVerified === true,
    expiryDate,
  };
  const legs = pickLegPrices(input.strategy, input);
  const selectedPmToken = legs.pmOutcome === 'yes' ? input.pmYesTokenId : input.pmNoTokenId;
  input.propositionRelationship = resolveCanonicalPropositionRelationship(input.propositionRelationship)
    ?? findCanonicalPropositionRelationship({
      kalshiTicker: input.kalshiTicker,
      pmConditionId: input.pmConditionId,
      pmTokenId: selectedPmToken,
      kalshiSide: legs.kalshiOutcome,
      pmSide: legs.pmOutcome,
    });
  return input;
}

// Parse depth helper (mirror matcher.parseDepth for local use without import cycle)
function parseDepth(val: string | number | null | undefined): number {
  if (val == null) return 0;
  if (typeof val === 'number') return Number.isFinite(val) && val > 0 ? val : 0;
  const s = String(val).trim().replace(/^\$/, '');
  if (s === 'Infinity') return 0;
  const m = s.match(/^(\d[\d,]*(?:\.\d+)?)\s*([KMB]?)\s*$/i);
  if (!m) return 0;
  let num = parseFloat(m[1].replace(/,/g, ''));
  const suffix = (m[2] || '').toUpperCase();
  if (suffix === 'K') num *= 1000;
  if (suffix === 'M') num *= 1_000_000;
  if (suffix === 'B') num *= 1_000_000_000;
  return Number.isFinite(num) && num > 0 ? num : 0;
}

// ─── Scan hooks ──────────────────────────────────────────────────

export async function runBotTraderOnScanOutcomes(
  pairId: string,
  marketTitle: string,
  expiryDate: string | undefined,
  inputs: BotTradeInput[],
): Promise<BotExecutionResult[]> {
  const settings = await getBotSettings();
  if (!settings.enabled) return [];

  const results: BotExecutionResult[] = [];
  for (const input of inputs) {
    if (input.roiPct <= 0 || input.strategy === 'No arb') continue;
    const res = await maybeExecuteBotTrade(input);
    results.push(res);
  }
  return results;
}

export async function runBotTraderOnLiveArbs(
  pairId: string,
  marketTitle: string,
  expiryDate: string | undefined,
  results: LiveArbResult[],
): Promise<BotExecutionResult[]> {
  const settings = await getBotSettings();
  if (!settings.enabled) return [];

  const execs: BotExecutionResult[] = [];
  for (const r of results) {
    if (r.stale || r.expectedProfit <= 0 || r.strategy === 'No arb') continue;
    const input = liveArbResultToBotInput(pairId, marketTitle, expiryDate, r);
    execs.push(await maybeExecuteBotTrade(input));
  }
  return execs;
}
