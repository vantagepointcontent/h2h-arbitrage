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
  type OrderSide,
  type OrderRequest,
} from './auto-execute';
import { getSetting, type getExecutionMode } from './settings';
import { executionModeToDryRun } from './execution-mode';
import {
  persistExecution,
  getTodayBotExposure,
  hasOpenBotPosition,
  type ExecutionRecord,
} from './persistence';
import { recordBotPosition } from './bot-positions';
import { sendTelegramMessage, getConfigResolved, isPausedResolved } from './telegram-alerts';
import logger from './logger';

// ─── Types ─────────────────────────────────────────────────────

export interface BotSettings {
  enabled: boolean;
  mode: 'paper' | 'production';
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
}

export interface BotExecutionResult {
  executed: boolean;
  dryRun: boolean;
  reason: string;
  executionRecord?: ExecutionRecord;
  executionResult?: Awaited<ReturnType<typeof executeArb>>;
}

// ─── Defaults ────────────────────────────────────────────────────

const DEFAULT_BOT_SETTINGS: BotSettings = {
  enabled: false,
  mode: 'paper',
  minRoiPct: 2.0,
  minApyPct: 0,
  minDepthUsd: 0.5,
  minSharesPerLeg: 1,
  maxExpiryDays: 1,
  maxTradesPerDay: 10,
};

/** MASTER SAFETY GUARD: keep `false` until Victor authorizes auto-live orders. */
const AUTO_LIVE_ORDERS_AUTHORIZED = false;

// ─── Settings loading ────────────────────────────────────────────

export async function getBotSettings(): Promise<BotSettings> {
  const [enabled, mode, minRoiPct, minApyPct, minDepthUsd, minSharesPerLeg, maxExpiryDays, maxTradesPerDay] = await Promise.all([
    getSetting<boolean>('bot.enabled').catch(() => DEFAULT_BOT_SETTINGS.enabled),
    getSetting<string>('bot.mode').catch(() => DEFAULT_BOT_SETTINGS.mode),
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
} {
  const strategyLower = (strategy || '').toLowerCase();

  // Cross-outcome: buy YES on both platforms.
  if (strategyLower.includes('both sides')) {
    return {
      kalshiPrice: input.kalshiYesAsk ?? null,
      pmPrice: input.pmYesAsk ?? null,
      kalshiOutcome: 'yes',
      pmOutcome: 'yes',
    };
  }

  // Same-platform internal arbs are not bot-tradeable (they require two Kalshi
  // or two PM orders on related outcomes; we only support two-leg cross-platform
  // for the bot's initial release).
  if (strategyLower.startsWith('same-platform')) {
    return { kalshiPrice: null, pmPrice: null, kalshiOutcome: 'yes', pmOutcome: 'yes' };
  }

  if (strategyLower.includes('yes kalshi')) {
    return {
      kalshiPrice: input.kalshiYesAsk ?? null,
      pmPrice: input.pmNoAsk ?? null,
      kalshiOutcome: 'yes',
      pmOutcome: 'no',
    };
  }

  if (strategyLower.includes('yes pm')) {
    return {
      kalshiPrice: input.kalshiNoAsk ?? null,
      pmPrice: input.pmYesAsk ?? null,
      kalshiOutcome: 'no',
      pmOutcome: 'yes',
    };
  }

  // Fallback: direct Kalshi YES + PM NO.
  return {
    kalshiPrice: input.kalshiYesAsk ?? null,
    pmPrice: input.pmNoAsk ?? null,
    kalshiOutcome: 'yes',
    pmOutcome: 'no',
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

  if (roiPct < settings.minRoiPct) {
    reasons.push(`ROI ${roiPct.toFixed(2)}% < min ${settings.minRoiPct.toFixed(2)}%`);
  }

  const apyPct = input.apyPct ?? 0;
  if (settings.minApyPct > 0 && apyPct < settings.minApyPct) {
    reasons.push(`APY ${apyPct.toFixed(2)}% < min ${settings.minApyPct.toFixed(2)}%`);
  }

  const expiryDays = computeExpiryDays(input.expiryDate);
  if (expiryDays !== null && expiryDays < settings.maxExpiryDays) {
    reasons.push(`Expires in ${expiryDays.toFixed(2)}d < min ${settings.maxExpiryDays}d`);
  }

  const legs = pickLegPrices(input.strategy, input);
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

  if (depthKUsd < settings.minDepthUsd || depthPUsd < settings.minDepthUsd) {
    reasons.push(
      `Insufficient dollar depth: Kalshi $${depthKUsd.toFixed(2)} / PM $${depthPUsd.toFixed(2)} (min $${settings.minDepthUsd})`,
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
  const strategyLower = (input.strategy || '').toLowerCase();

  if (strategyLower.includes('yes kalshi')) {
    return {
      depthKUsd: input.kalshiYesDepth ?? 0,
      depthPUsd: input.pmNoDepth ?? 0,
    };
  }
  if (strategyLower.includes('yes pm')) {
    return {
      depthKUsd: input.kalshiNoDepth ?? 0,
      depthPUsd: input.pmYesDepth ?? 0,
    };
  }
  if (strategyLower.includes('both sides')) {
    return {
      depthKUsd: input.kalshiYesDepth ?? 0,
      depthPUsd: input.pmYesDepth ?? 0,
    };
  }

  // default: buy YES Kalshi + NO PM
  return {
    depthKUsd: input.kalshiYesDepth ?? 0,
    depthPUsd: input.pmNoDepth ?? 0,
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

function buildExecutionRequest(input: BotTradeInput): ExecutionRequest | null {
  const legs = pickLegPrices(input.strategy, input);
  if (legs.kalshiPrice == null || legs.pmPrice == null) return null;
  if (!input.kalshiTicker || !input.pmConditionId) return null;

  // The bot stakes the smaller of the two leg sizes suggested by the scan so
  // both legs remain matched.  In practice the scanner already equalizes them,
  // but guard against drift.
  const capital = Math.min(
    input.kalshiStake > 0 ? input.kalshiStake / legs.kalshiPrice : Infinity,
    input.pmStake > 0 ? input.pmStake / legs.pmPrice : Infinity,
  );

  if (!Number.isFinite(capital) || capital <= 0) return null;

  const kalshiStake = capital * legs.kalshiPrice;
  const pmStake = capital * legs.pmPrice;

  const kalshiOrder: OrderRequest = {
    platform: 'kalshi',
    marketId: input.kalshiTicker,
    ticker: input.kalshiTicker,
    side: 'buy',
    outcome: legs.kalshiOutcome,
    size: kalshiStake,
    price: legs.kalshiPrice,
    orderType: 'limit',
  };

  const polymarketOrder: OrderRequest = {
    platform: 'polymarket',
    marketId: input.pmConditionId,
    conditionId: input.pmConditionId,
    side: 'buy',
    outcome: legs.pmOutcome,
    size: pmStake,
    price: legs.pmPrice,
    orderType: 'limit',
  };

  return {
    arbId: safeArbId(input.pairId, input.outcome),
    marketTitle: input.marketTitle,
    kalshiOrder,
    polymarketOrder,
    estimatedProfit: input.expectedProfit,
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

/** Compute total proposed stake for the trade. */
function proposedStakeUsd(input: BotTradeInput): number {
  return input.kalshiStake + input.pmStake;
}

// ─── Main orchestrator ─────────────────────────────────────────

export async function maybeExecuteBotTrade(
  input: BotTradeInput,
): Promise<BotExecutionResult> {
  const settings = await getBotSettings();

  const evaluation = evaluateBotTrade(input, settings);
  if (!evaluation.shouldTrade) {
    return { executed: false, dryRun: true, reason: evaluation.reason };
  }

  if (!settings.enabled) {
    return { executed: false, dryRun: true, reason: 'BotTrader disabled' };
  }

  const arbId = safeArbId(input.pairId, input.outcome);

  // Duplicate-prevention: don't stack trades on the same pair/outcome.
  const alreadyOpen = await hasOpenBotPosition(arbId).catch((e) => {
    logger.warn('[bot-trader] duplicate check failed', { arbId, error: String(e) });
    return true; // fail-safe: skip on error
  });
  if (alreadyOpen) {
    return { executed: false, dryRun: true, reason: `Open bot position already exists for ${arbId}` };
  }

  // Daily exposure + trade count limits.
  const todayExposure = await getTodayBotExposure().catch((e) => {
    logger.warn('[bot-trader] daily exposure check failed', { error: String(e) });
    return Infinity;
  });
  const todayTrades = await countTodayBotTrades().catch(() => 0);
  const maxDailyExposure = await getSetting<number>('execute.maxDailyExposure').catch(() => 500);
  const proposedStake = proposedStakeUsd(input);

  if (todayTrades >= settings.maxTradesPerDay) {
    return {
      executed: false,
      dryRun: true,
      reason: `Daily bot trade limit reached (${todayTrades}/${settings.maxTradesPerDay})`,
    };
  }

  if (todayExposure + proposedStake > maxDailyExposure) {
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
    return { executed: false, dryRun: true, reason: 'Unable to build execution request (missing leg data)' };
  }

  execReq.dryRun = effectiveDryRun;

  logger.info('[bot-trader] executing trade', {
    arbId,
    pairId: input.pairId,
    marketTitle: input.marketTitle,
    dryRun: effectiveDryRun,
    mode: settings.mode,
    globalMode,
  });

  const result = await executeArb(execReq);

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
    estimatedProfit: input.expectedProfit,
    steps: result.steps,
    source: 'bot',
  };

  let executionId: number | undefined;
  try {
    executionId = await persistExecution(executionRecord);
  } catch (e) {
    logger.warn('[bot-trader] persistExecution failed', { arbId, error: String(e) });
  }

  // Record bot position linked to the execution
  if (executionId != null) {
    try {
      const legs = pickLegPrices(input.strategy, input);
      if (legs.kalshiPrice != null && legs.pmPrice != null) {
        await recordBotPosition({
          executionId,
          pairId: input.pairId,
          marketTitle: input.marketTitle,
          kalshiTicker: input.kalshiTicker ?? null,
          pmConditionId: input.pmConditionId ?? null,
          strategy: input.strategy,
          kalshiSide: legs.kalshiOutcome,
          pmSide: legs.pmOutcome,
          kalshiPrice: legs.kalshiPrice,
          pmPrice: legs.pmPrice,
          kalshiStake: input.kalshiStake,
          pmStake: input.pmStake,
          expectedProfit: input.expectedProfit,
          expiryDate: input.expiryDate ?? null,
        });
      }
    } catch (e) {
      logger.warn('[bot-trader] recordBotPosition failed', { arbId, error: String(e) });
    }
  }

  await sendBotTelegramAlert(input, result.success, effectiveDryRun, input.roiPct).catch((e) => {
    logger.warn('[bot-trader] telegram alert failed', { arbId, error: String(e) });
  });

  return {
    executed: result.success || (effectiveDryRun && !result.unhedged),
    dryRun: effectiveDryRun,
    reason: effectiveDryRun
      ? `Paper trade simulated for ${input.marketTitle}`
      : `Production trade executed for ${input.marketTitle}`,
    executionRecord,
    executionResult: result,
  };
}

async function sendBotTelegramAlert(
  input: BotTradeInput,
  success: boolean,
  dryRun: boolean,
  roiPct: number,
): Promise<void> {
  const config = await getConfigResolved();
  if (!config) return;
  if (await isPausedResolved()) return;

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

  await sendTelegramMessage(config.botToken, config.chatId, text);
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
    pmConditionId: result.pmYesTokenId ?? null,
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
