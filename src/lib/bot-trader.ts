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
 *   • Paper mode (`bot.mode === 'paper'` or `execute.mode === 'paper'`) always
 *     simulates, even when `bot.mode` is production.
 *   • The production/live path is currently BLOCKED by a hard-coded `false`
 *     guard in `maybeExecuteBotTrade`.  Victor must explicitly authorize
 *     automatic live order placement before that guard is removed.
 */

import type { UnifiedOutcome } from './matcher';
import type { LiveArbResult } from './live-arb-engine';
import {
  executeArb,
  type ExecutionRequest,
  type ExecutionResult,
  type OrderSide,
  type OrderRequest,
  type OrderResult,
} from './auto-execute';
import { getSetting, type getExecutionMode } from './settings';
import { executionModeToDryRun } from './execution-mode';
import {
  persistExecution,
  getTodayBotExposure,
  type ExecutionRecord,
} from './persistence';
import {
  fetchAuthoritativeBotFeeConfig,
  recordBotPosition,
  type AuthoritativeBotFeeConfig,
} from './bot-positions';
import { sendTelegramMessage, getConfigResolved, isPausedResolved } from './telegram-alerts';
import { appendBotActionLog, type BotActionStatus } from './bot-action-log';
import { createBotMessage, updateBotMessage, type BotMessageType } from './bot-trader-messages';
import logger from './logger';
import type { BotSelectionMethod } from './bot-candidate-selection';

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
  maxUnitsPerMarket?: number;
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
  strategy: string;
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
  /** Market expiry ISO string */
  expiryDate?: string | null;
  category?: string;
  /** Immutable ranked-selection attribution. Null for explicit/manual runs. */
  selectionMethod?: BotSelectionMethod | null;
}

export interface BotExecutionResult {
  executed: boolean;
  dryRun: boolean;
  reason: string;
  executionRecord?: ExecutionRecord;
  executionResult?: Awaited<ReturnType<typeof executeArb>>;
  positionPersisted?: boolean;
  persistenceError?: string;
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
  maxUnitsPerMarket: 3,
};

/** MASTER SAFETY GUARD: keep `false` until Victor authorizes auto-live orders. */
const AUTO_LIVE_ORDERS_AUTHORIZED = false;

// ─── Settings loading ────────────────────────────────────────────

export async function getBotSettings(): Promise<BotSettings> {
  const [enabled, mode, selectionMethod, minRoiPct, minApyPct, minDepthUsd, minSharesPerLeg, maxExpiryDays, maxTradesPerDay, maxUnitsPerMarket] = await Promise.all([
    getSetting<boolean>('bot.enabled').catch(() => DEFAULT_BOT_SETTINGS.enabled),
    getSetting<string>('bot.mode').catch(() => DEFAULT_BOT_SETTINGS.mode),
    getSetting<BotSelectionMethod>('bot.selectionMethod').catch(() => DEFAULT_BOT_SETTINGS.selectionMethod),
    getSetting<number>('bot.minRoiPct').catch(() => DEFAULT_BOT_SETTINGS.minRoiPct),
    getSetting<number>('bot.minApyPct').catch(() => DEFAULT_BOT_SETTINGS.minApyPct),
    getSetting<number>('bot.minDepthUsd').catch(() => DEFAULT_BOT_SETTINGS.minDepthUsd),
    getSetting<number>('bot.minSharesPerLeg').catch(() => DEFAULT_BOT_SETTINGS.minSharesPerLeg),
    getSetting<number>('bot.maxExpiryDays').catch(() => DEFAULT_BOT_SETTINGS.maxExpiryDays),
    getSetting<number>('bot.maxTradesPerDay').catch(() => DEFAULT_BOT_SETTINGS.maxTradesPerDay),
    getSetting<number>('bot.maxUnitsPerMarket').catch(() => DEFAULT_BOT_SETTINGS.maxUnitsPerMarket),
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
    maxUnitsPerMarket: Number.isFinite(maxUnitsPerMarket) && Number(maxUnitsPerMarket) >= 1
      ? Math.floor(Number(maxUnitsPerMarket))
      : DEFAULT_BOT_SETTINGS.maxUnitsPerMarket,
  };
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

export interface MatchedFillLegEvidence {
  contracts: number;
  price: number;
  feeCents: number;
  executionId: string;
  executedAt: string;
}

const MATCHED_FILL_EVIDENCE = Symbol('BotTraderMatchedFillEvidence');
const MATCHED_FILL_PROVENANCE = new WeakMap<object, 'venue' | 'synthetic'>();

interface MatchedFillEvidence {
  readonly [MATCHED_FILL_EVIDENCE]: true;
  readonly source: 'venue' | 'synthetic';
  readonly kalshi: Readonly<MatchedFillLegEvidence>;
  readonly polymarket: Readonly<MatchedFillLegEvidence>;
}

export function createSyntheticMatchedFillEvidence(input: {
  kalshi: MatchedFillLegEvidence;
  polymarket: MatchedFillLegEvidence;
}): MatchedFillEvidence {
  const evidence: MatchedFillEvidence = Object.freeze({
    source: 'synthetic',
    kalshi: Object.freeze({ ...input.kalshi }),
    polymarket: Object.freeze({ ...input.polymarket }),
    [MATCHED_FILL_EVIDENCE]: true as const,
  });
  MATCHED_FILL_PROVENANCE.set(evidence, 'synthetic');
  return evidence;
}

export interface AuthoritativeMatchedFill {
  source: MatchedFillEvidence['source'];
  kalshiContracts: number;
  pmContracts: number;
  kalshiPrice: number;
  pmPrice: number;
  kalshiFeeCents: number;
  pmFeeCents: number;
  kalshiExecutionId: string;
  pmExecutionId: string;
  kalshiExecutedAt: string;
  pmExecutedAt: string;
}

export function getAuthoritativeMatchedFill(evidence?: MatchedFillEvidence): AuthoritativeMatchedFill | null {
  if (!evidence || evidence[MATCHED_FILL_EVIDENCE] !== true) return null;
  const source = MATCHED_FILL_PROVENANCE.get(evidence);
  if (!source) return null;
  const { kalshi, polymarket } = evidence;
  if (
    !Number.isSafeInteger(kalshi.contracts) || kalshi.contracts <= 0
    || !Number.isSafeInteger(polymarket.contracts) || polymarket.contracts <= 0
    || kalshi.contracts !== polymarket.contracts
    || !Number.isFinite(kalshi.price) || kalshi.price <= 0 || kalshi.price > 1
    || !Number.isFinite(polymarket.price) || polymarket.price <= 0 || polymarket.price > 1
    || !Number.isSafeInteger(kalshi.feeCents) || kalshi.feeCents < 0
    || !Number.isSafeInteger(polymarket.feeCents) || polymarket.feeCents < 0
    || !kalshi.executionId.trim() || !polymarket.executionId.trim()
    || !Number.isFinite(Date.parse(kalshi.executedAt))
    || !Number.isFinite(Date.parse(polymarket.executedAt))
  ) return null;
  return {
    source,
    kalshiContracts: kalshi.contracts, pmContracts: polymarket.contracts,
    kalshiPrice: kalshi.price, pmPrice: polymarket.price,
    kalshiFeeCents: kalshi.feeCents, pmFeeCents: polymarket.feeCents,
    kalshiExecutionId: kalshi.executionId, pmExecutionId: polymarket.executionId,
    kalshiExecutedAt: kalshi.executedAt, pmExecutedAt: polymarket.executedAt,
  };
}

export function sanitizeExecutionResultForPersistence(
  result: ExecutionResult,
  dryRun: boolean,
): ExecutionResult {
  if (dryRun) return result;
  const withoutFabricatedFill = (leg: OrderResult): OrderResult => {
    const { filledSize: _filledSize, filledContracts: _filledContracts, filledPrice: _filledPrice, timestamp: _timestamp, ...acknowledgement } = leg;
    // The persisted JSON intentionally omits a timestamp until the venue supplies one.
    return { ...acknowledgement, status: 'pending' } as OrderResult;
  };
  return {
    ...result,
    success: false,
    kalshiResult: withoutFabricatedFill(result.kalshiResult),
    polymarketResult: withoutFabricatedFill(result.polymarketResult),
    actualProfit: undefined,
    netExposure: undefined,
    steps: result.steps.map((step) => ({
      status: step.status,
      description: 'Live execution step; fill details withheld pending venue reconciliation',
    } as typeof step)),
    alerts: result.alerts?.map((alert) => ({
      level: alert.level,
      leg: alert.leg,
      action: alert.action,
      message: 'Live execution alert; fill details withheld pending venue reconciliation',
    })),
  };
}

export function evaluateBotTrade(
  input: BotTradeInput,
  settings: BotSettings,
): BotTradeEvaluation {
  const reasons: string[] = [];

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
  if (legs.kalshiPrice == null || legs.pmPrice == null) {
    reasons.push('Missing tradeable ask price on one or both legs');
  }

  const { depthKUsd, depthPUsd } = legDepths(legs, input);
  const sharesK = legs.kalshiPrice != null && legs.kalshiPrice > 0
    ? depthKUsd / legs.kalshiPrice
    : 0;
  const sharesP = legs.pmPrice != null && legs.pmPrice > 0
    ? depthPUsd / legs.pmPrice
    : 0;

  if (sharesK < settings.minSharesPerLeg || sharesP < settings.minSharesPerLeg) {
    reasons.push(
      `Insufficient shares at best ask: Kalshi ${sharesK.toFixed(2)} / PM ${sharesP.toFixed(2)} (min ${settings.minSharesPerLeg})`,
    );
  }

  // Executability is price-relative: N shares at a 24c ask require $0.24 × N,
  // not a fixed $0.50 on every leg. Depth values are best-ask dollar depth.
  const requiredDepthKUsd = (legs.kalshiPrice ?? 0) * settings.minSharesPerLeg;
  const requiredDepthPUsd = (legs.pmPrice ?? 0) * settings.minSharesPerLeg;
  if (depthKUsd < requiredDepthKUsd || depthPUsd < requiredDepthPUsd) {
    reasons.push(
      `Insufficient executable depth at quoted ask: Kalshi $${depthKUsd.toFixed(2)} / $${requiredDepthKUsd.toFixed(2)} required; PM $${depthPUsd.toFixed(2)} / $${requiredDepthPUsd.toFixed(2)} required`,
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

export function buildExecutionRequest(input: BotTradeInput): ExecutionRequest | null {
  const legs = pickLegPrices(input.strategy, input);
  if (!legs.supported || legs.kalshiPrice == null || legs.pmPrice == null) return null;
  if (!input.kalshiTicker || !input.pmConditionId) return null;

  const sourceShares = Math.min(
    input.kalshiStake > 0 ? input.kalshiStake / legs.kalshiPrice : Infinity,
    input.pmStake > 0 ? input.pmStake / legs.pmPrice : Infinity,
  );
  if (!Number.isFinite(sourceShares) || sourceShares <= 0) return null;

  // Depth qualifies the opportunity; it does not size the placement. Each
  // BotTrader placement is one matched share on each selected strategy leg.
  const contracts = 1;
  const kalshiStake = legs.kalshiPrice;
  const pmStake = legs.pmPrice;
  const oneShareNetProfit = input.expectedProfit / sourceShares;

  const kalshiOrder: OrderRequest = {
    platform: 'kalshi',
    marketId: input.kalshiTicker,
    ticker: input.kalshiTicker,
    side: 'buy',
    outcome: legs.kalshiOutcome,
    size: kalshiStake,
    contracts,
    price: legs.kalshiPrice,
    orderType: 'limit',
  };

  const polymarketOrder: OrderRequest = {
    platform: 'polymarket',
    marketId: legs.pmOutcome === 'yes' ? input.pmYesTokenId ?? input.pmConditionId : input.pmNoTokenId ?? input.pmConditionId,
    conditionId: legs.pmOutcome === 'yes' ? input.pmYesTokenId ?? input.pmConditionId : input.pmNoTokenId ?? input.pmConditionId,
    side: 'buy',
    outcome: legs.pmOutcome,
    size: pmStake,
    contracts,
    price: legs.pmPrice,
    orderType: 'limit',
  };

  return {
    arbId: safeArbId(input.pairId, input.outcome),
    marketTitle: input.marketTitle,
    kalshiOrder,
    polymarketOrder,
    estimatedProfit: oneShareNetProfit,
    maxSlippagePct: 2.0,
    timeoutMs: 15000,
    dryRun: true, // overwritten by caller before executeArb()
    scanTime: new Date().toISOString(),
    bestPriceFound: true,
  };
}

/** Sum dollar stake for a bot trade record. */
function botStakeUsd(record: ExecutionRecord): number {
  const k = record.kalshiOrder && typeof record.kalshiOrder === 'object' && record.kalshiOrder != null
    ? Number((record.kalshiOrder as { size?: unknown }).size ?? 0)
    : 0;
  const p = record.polymarketOrder && typeof record.polymarketOrder === 'object' && record.polymarketOrder != null
    ? Number((record.polymarketOrder as { size?: unknown }).size ?? 0)
    : 0;
  const kValid = Number.isFinite(k) && k > 0 ? k : 0;
  const pValid = Number.isFinite(p) && p > 0 ? p : 0;
  return kValid + pValid;
}

async function countTodayBotTrades(): Promise<number> {
  const { createClient } = await import('@libsql/client');
  const c = createClient({ url: `file:${process.cwd()}/data/edgefinder.db` });
  try {
    const today = new Date().toISOString().slice(0, 10);
    const res = await c.execute({
      sql: `SELECT COUNT(*) AS cnt FROM executions WHERE source = 'bot' AND timestamp >= ? AND timestamp < ?`,
      args: [`${today}T00:00:00.000Z`, `${today}T23:59:59.999Z`],
    });
    return Number((res.rows as Array<{ cnt?: unknown }>)[0]?.cnt ?? 0);
  } finally {
    c.close();
  }
}

/** Compute total proposed stake for the one-share execution plan. */
function proposedStakeUsd(input: BotTradeInput): number {
  const request = buildExecutionRequest(input);
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


  // Daily exposure + trade count limits.
  const todayExposure = await getTodayBotExposure().catch((e) => {
    logger.warn('[bot-trader] daily exposure check failed', { error: String(e) });
    return Infinity;
  });
  const todayTrades = await countTodayBotTrades().catch(() => 0);
  const maxDailyExposure = await getSetting<number>('execute.maxDailyExposure').catch(() => 500);
  const proposedStake = proposedStakeUsd(input);

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

  // Resolve global execution mode.
  const { getExecutionMode } = await import('./settings');
  const globalMode = await getExecutionMode().catch(() => 'paper' as const);
  const globalDryRun = executionModeToDryRun(globalMode);

  // Determine effective mode: production only when explicitly authorized.
  const wantsProduction = settings.mode === 'production' && globalMode === 'live';
  const effectiveDryRun = globalDryRun || !wantsProduction || !AUTO_LIVE_ORDERS_AUTHORIZED;

  if (wantsProduction && !AUTO_LIVE_ORDERS_AUTHORIZED) {
    logger.warn('[bot-trader] production/live requested but not yet authorized; falling back to paper simulation', {
      pairId: input.pairId,
      marketTitle: input.marketTitle,
    });
  }

  const execReq = buildExecutionRequest(input);
  if (!execReq) {
    await log('preflight', 'Build two-leg execution request', 'failed', { errorReason: 'Missing leg data', qualificationOutcome: 'dead' });
    return { executed: false, dryRun: true, reason: 'Unable to build execution request (missing leg data)' };
  }

  execReq.dryRun = effectiveDryRun;
  await log('preflight', 'Execution request and safety gates verified', 'passed', {
    requestPayload: execReq,
    responsePayload: { effectiveDryRun, autoLiveOrdersAuthorized: AUTO_LIVE_ORDERS_AUTHORIZED, todayTrades, todayExposure },
    qualificationOutcome: 'qualified',
  });

  const entryLegs = pickLegPrices(input.strategy, input);
  let feeAuthority: AuthoritativeBotFeeConfig;
  try {
    if (!entryLegs.supported || !input.kalshiTicker || !input.pmConditionId || !input.category?.trim()) {
      throw new Error('Missing supported venue legs, identifiers, or market category');
    }
    feeAuthority = await fetchAuthoritativeBotFeeConfig({
      kalshiTicker: input.kalshiTicker,
      pmConditionId: input.pmConditionId,
      pmTokenId: entryLegs.pmOutcome === 'yes' ? input.pmYesTokenId ?? undefined : input.pmNoTokenId ?? undefined,
      pmSide: entryLegs.pmOutcome,
      category: input.category,
    });
    // Placement and fee evidence must identify the same selected CLOB token.
    execReq.polymarketOrder.marketId = feeAuthority.polymarket.tokenId;
    execReq.polymarketOrder.conditionId = feeAuthority.polymarket.tokenId;
  } catch (error) {
    const reason = `Authoritative fee authority unavailable: ${String(error)}`;
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
    globalMode,
  });

  const executionStarted = Date.now();
  const result = await executeArb(execReq);
  const reportedResult = sanitizeExecutionResultForPersistence(result, effectiveDryRun);
  const executionDurationMs = Date.now() - executionStarted;
  for (const step of reportedResult.steps ?? []) {
    const rawStatus = String(step.status ?? '').toLowerCase();
    const responseStatus: BotActionStatus = rawStatus === 'failed' || rawStatus === 'timeout' ? 'failed' : rawStatus === 'pending' ? 'pending' : 'passed';
    await log('execution', step.description || 'Execution step', responseStatus, {
      responsePayload: step.metadata,
      errorReason: responseStatus === 'failed' ? step.description : null,
    });
  }
  await log('result', reportedResult.success
    ? `${effectiveDryRun ? 'Paper simulation completed' : 'Trade completed'} for ${input.marketTitle}`
    : `${effectiveDryRun ? 'Trade attempt failed' : 'Trade acknowledgement pending authoritative reconciliation'} for ${input.marketTitle}`,
  reportedResult.success ? 'passed' : (effectiveDryRun ? 'failed' : 'pending'), {
    requestPayload: execReq,
    responsePayload: reportedResult,
    errorReason: reportedResult.success ? null : (result.error || (effectiveDryRun ? 'Execution failed' : 'Authoritative fill reconciliation required')),
    durationMs: executionDurationMs,
    alertMetadata: reportedResult.alerts,
  });

  const executionRecord: ExecutionRecord = {
    timestamp: new Date().toISOString(),
    arbId,
    marketTitle: input.marketTitle,
    dryRun: effectiveDryRun,
    success: reportedResult.success,
    strategy: input.strategy,
    kalshiOrder: execReq.kalshiOrder,
    polymarketOrder: execReq.polymarketOrder,
    result: reportedResult,
    estimatedProfit: input.expectedProfit,
    steps: reportedResult.steps,
    source: 'bot',
    selectionMethod: input.selectionMethod ?? null,
  };

  // Dry-run results are explicitly synthetic. The current live adapters expose
  // requested prices/local timestamps, so they cannot be promoted to venue evidence.
  const fill = effectiveDryRun ? getAuthoritativeMatchedFill(createSyntheticMatchedFillEvidence({
    kalshi: {
      contracts: result.kalshiResult.filledContracts ?? 0,
      price: result.kalshiResult.filledPrice ?? 0,
      feeCents: 0,
      executionId: result.kalshiResult.orderId ?? `paper:${arbId}:kalshi`,
      executedAt: result.kalshiResult.timestamp ?? executionRecord.timestamp,
    },
    polymarket: {
      contracts: result.polymarketResult.filledContracts ?? 0,
      price: result.polymarketResult.filledPrice ?? 0,
      feeCents: 0,
      executionId: result.polymarketResult.orderId ?? `paper:${arbId}:polymarket`,
      executedAt: result.polymarketResult.timestamp ?? executionRecord.timestamp,
    },
  })) : null;
  // A successful live placement with no venue-proven fill remains untracked
  // exposure. Report positionPersisted=false so the consumer retains its lock.
  const positionExpected = fill != null || !effectiveDryRun;

  let executionId: number | undefined;
  let positionPersisted = !positionExpected;
  let persistenceError: string | undefined;
  try {
    executionId = await persistExecution(executionRecord);
  } catch (e) {
    persistenceError = `Execution persistence failed: ${String(e)}`;
    logger.warn('[bot-trader] persistExecution failed', { arbId, error: String(e) });
  }

  // Record bot position linked to the execution
  if (executionId != null && positionExpected) {
    try {
      if (entryLegs.kalshiPrice != null && entryLegs.pmPrice != null && fill) {
        await recordBotPosition({
          executionId,
          pairId: input.pairId,
          marketTitle: input.marketTitle,
          kalshiTicker: input.kalshiTicker ?? null,
          pmConditionId: input.pmConditionId ?? null,
          strategy: input.strategy,
          kalshiSide: entryLegs.kalshiOutcome,
          pmSide: entryLegs.pmOutcome,
          kalshiPrice: fill.kalshiPrice,
          pmPrice: fill.pmPrice,
          kalshiQuantity: fill.kalshiContracts,
          pmQuantity: fill.pmContracts,
          executedAt: executionRecord.timestamp,
          expectedProfit: execReq.estimatedProfit,
          expectedRoiPct: input.roiPct,
          expectedApyPct: input.apyPct ?? null,
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

  await sendBotTelegramAlert(input, reportedResult.success, effectiveDryRun, input.roiPct, tradeId).catch((e) => {
    logger.warn('[bot-trader] telegram alert failed', { arbId, error: String(e) });
  });

  return {
    executed: reportedResult.success || fill != null || (effectiveDryRun && !result.unhedged),
    dryRun: effectiveDryRun,
    reason: effectiveDryRun
      ? `Paper trade simulated for ${input.marketTitle}`
      : `Production order acknowledgement pending authoritative fill reconciliation for ${input.marketTitle}`,
    executionRecord,
    executionResult: reportedResult,
    positionPersisted,
    persistenceError,
  };
}

async function sendBotTelegramAlert(
  input: BotTradeInput,
  success: boolean,
  dryRun: boolean,
  roiPct: number,
  tradeId: string,
): Promise<void> {
  const config = await getConfigResolved();
  const emoji = dryRun ? '🤖' : '🦾';
  const modeLabel = dryRun ? 'PAPER' : 'PRODUCTION';
  const status = success ? 'placed' : 'attempted';

  const text = [
    `${emoji} <b>BotTrader ${status} — ${modeLabel}</b>`,
    '',
    `<b>Market:</b> ${input.marketTitle}`,
    `<b>Outcome:</b> ${input.outcome}`,
    `<b>Strategy:</b> ${input.strategy}`,
    `<b>ROI:</b> ${roiPct.toFixed(2)}%`,
    `<b>Profit:</b> $${input.expectedProfit.toFixed(2)}`,
    `<b>Stake:</b> $${(input.kalshiStake + input.pmStake).toFixed(2)}`,
  ].join('\n');
  const chatId = config?.botTraderChatId || config?.chatId || process.env.TELEGRAM_BOT_TRADER_CHAT_ID || process.env.TELEGRAM_CHAT_ID || null;
  const messageType: BotMessageType = success ? 'trade_placed' : 'trade_failed';
  if (!config || !chatId) {
    await createBotMessage({ chatId, messageText: text, messageType, tradeId, marketId: input.pairId, marketTitle: input.marketTitle, status: 'failed', errorReason: 'Telegram not configured' });
    return;
  }
  if (await isPausedResolved()) {
    await createBotMessage({ chatId, messageText: text, messageType, tradeId, marketId: input.pairId, marketTitle: input.marketTitle, status: 'paused' });
    return;
  }
  const messageId = await createBotMessage({ chatId, messageText: text, messageType, tradeId, marketId: input.pairId, marketTitle: input.marketTitle, status: 'pending' });
  const sent = await sendTelegramMessage(config.botToken, chatId, text);
  await updateBotMessage(messageId, sent.ok
    ? { status: 'sent', telegramMessageId: sent.messageId }
    : { status: 'failed', errorReason: sent.error || 'Telegram send failed' });
}

// ─── Convenience adapters ────────────────────────────────────────

export function unifiedOutcomeToBotInput(
  pairId: string,
  marketTitle: string,
  expiryDate: string | undefined,
  outcome: UnifiedOutcome,
): BotTradeInput {
  const a = outcome.arbitrage;
  return {
    pairId,
    marketTitle,
    outcome: outcome.artist,
    strategy: a.strategy,
    roiPct: a.roiPct,
    apyPct: a.apyPct ?? null,
    expectedProfit: a.expectedProfit,
    kalshiStake: a.kalshiStake,
    pmStake: a.pmStake,
    kalshiTicker: outcome.kalshi?.ticker ?? null,
    pmConditionId: outcome.polymarket?.conditionId ?? null,
    kalshiYesAsk: outcome.kalshi?.yesAsk ?? null,
    kalshiNoAsk: outcome.kalshi?.noAsk ?? null,
    pmYesAsk: outcome.polymarket?.bestAsk ?? null,
    pmNoAsk: outcome.polymarket?.noPrice ?? null,
    kalshiYesDepth: parseDepth(outcome.kalshi?.yesAskDepth),
    kalshiNoDepth: parseDepth(outcome.kalshi?.noAskDepth),
    pmYesDepth: outcome.polymarket?.askDepth ?? 0,
    pmNoDepth: outcome.polymarket?.noAskDepth ?? 0,
    expiryDate,
  };
}

export function liveArbResultToBotInput(
  pairId: string,
  marketTitle: string,
  expiryDate: string | undefined,
  result: LiveArbResult,
): BotTradeInput {
  return {
    pairId,
    marketTitle,
    outcome: result.artist,
    strategy: result.strategy,
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
    expiryDate,
  };
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
