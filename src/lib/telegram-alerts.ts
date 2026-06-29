/**
 * Telegram Alerts — sends push notifications to a Telegram chat when
 * arbitrage opportunities are found.
 *
 * Configuration is read from environment variables:
 *   TELEGRAM_BOT_TOKEN   — Bot API token from @BotFather
 *   TELEGRAM_CHAT_ID     — Target chat/channel ID (negative for channels)
 *
 * Runtime thresholds (overridable per-call):
 *   minRoiPct    — only alert when ROI ≥ this (default 1.0%)
 *   minProfitUsd — only alert when expected profit ≥ this (default $1)
 *   cooldownMs   — per-market cooldown to avoid spam (default 5 min)
 *
 * The module is self-contained: no dependency on logger (avoids circular deps).
 * Errors are swallowed and returned in the result object so callers can
 * decide whether to log them.
 */

// ─── Types ────────────────────────────────────────────────────────

export interface ArbAlertInput {
  marketTitle: string;
  marketId: string;
  roiPct: number;
  expectedProfit: number;
  strategy: string;
  totalStake?: number;
  fees?: {
    kalshiFee: number;
    pmFee: number;
    worstCaseNetProfit: number;
  };
}

export interface TelegramAlertResult {
  sent: boolean;
  reason?: string;
  error?: string;
  messageId?: number;
}

export interface TelegramAlertConfig {
  botToken: string;
  chatId: string;
  minRoiPct: number;
  minProfitUsd: number;
  cooldownMs: number;
}

// ─── Internal state ───────────────────────────────────────────────

/** Track last-alert time per market to enforce cooldown. */
const lastAlertMap = new Map<string, number>();

/** Default thresholds. */
const DEFAULT_MIN_ROI = 1.0;
const DEFAULT_MIN_PROFIT = 1.0;
const DEFAULT_COOLDOWN_MS = 5 * 60 * 1000; // 5 min

// ─── Config resolution ────────────────────────────────────────────

/**
 * Read Telegram config from environment variables.
 * Returns null if not configured.
 */
export function getConfigFromEnv(): TelegramAlertConfig | null {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!botToken || !chatId) return null;

  return {
    botToken,
    chatId,
    minRoiPct: parseFloat(process.env.TELEGRAM_MIN_ROI_PCT ?? '') || DEFAULT_MIN_ROI,
    minProfitUsd: parseFloat(process.env.TELEGRAM_MIN_PROFIT_USD ?? '') || DEFAULT_MIN_PROFIT,
    cooldownMs: parseInt(process.env.TELEGRAM_COOLDOWN_MS ?? '', 10) || DEFAULT_COOLDOWN_MS,
  };
}

// ─── Message formatting ───────────────────────────────────────────

/**
 * Format an arb opportunity as a Telegram message.
 * Uses HTML parse_mode for rich formatting.
 */
export function formatArbMessage(arb: ArbAlertInput): string {
  const roiStr = arb.roiPct.toFixed(2);
  const profitStr = arb.expectedProfit.toFixed(2);
  const stakeStr = arb.totalStake ? arb.totalStake.toFixed(2) : '—';
  const feeStr = arb.fees
    ? `Net: $${arb.fees.worstCaseNetProfit.toFixed(2)}`
    : '';

  return [
    '🟢 <b>Arbitrage Found</b>',
    '',
    `<b>${escapeHtml(arb.marketTitle)}</b>`,
    '',
    `📊 ROI: <b>${roiStr}%</b>`,
    `💰 Profit: <b>$${profitStr}</b>${feeStr ? ` (${feeStr})` : ''}`,
    `🎯 Strategy: ${escapeHtml(arb.strategy)}`,
    `💵 Stake: $${stakeStr}`,
    '',
    `🕐 ${new Date().toISOString().replace('T', ' ').slice(0, 19)} UTC`,
  ].join('\n');
}

/** Escape HTML special characters for Telegram's HTML parse_mode. */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// ─── Threshold checks ─────────────────────────────────────────────

/**
 * Check if an arb should trigger an alert based on thresholds and cooldown.
 * Returns { shouldAlert: true } if it passes all checks.
 */
export function shouldAlert(
  arb: ArbAlertInput,
  config: TelegramAlertConfig,
  now: number = Date.now(),
): { shouldAlert: boolean; reason?: string } {
  if (arb.roiPct <= 0) {
    return { shouldAlert: false, reason: 'ROI is not positive' };
  }

  if (arb.roiPct < config.minRoiPct) {
    return { shouldAlert: false, reason: `ROI ${arb.roiPct.toFixed(2)}% below threshold ${config.minRoiPct}%` };
  }

  if (arb.expectedProfit < config.minProfitUsd) {
    return { shouldAlert: false, reason: `Profit $${arb.expectedProfit.toFixed(2)} below threshold $${config.minProfitUsd}` };
  }

  const lastAlert = lastAlertMap.get(arb.marketId);
  if (lastAlert && now - lastAlert < config.cooldownMs) {
    const remainingMs = config.cooldownMs - (now - lastAlert);
    return { shouldAlert: false, reason: `Cooldown active (${Math.ceil(remainingMs / 1000)}s remaining)` };
  }

  return { shouldAlert: true };
}

// ─── Telegram API call ────────────────────────────────────────────

/**
 * Send a message to Telegram via Bot API.
 * Uses fetch (available in Node 18+ / Next.js runtime).
 */
export async function sendTelegramMessage(
  botToken: string,
  chatId: string,
  text: string,
): Promise<{ ok: boolean; messageId?: number; error?: string }> {
  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }),
      signal: AbortSignal.timeout(10000), // 10s timeout
    });

    const data = await res.json();

    if (!data.ok) {
      return { ok: false, error: data.description || 'Telegram API returned error' };
    }

    return { ok: true, messageId: data.result?.message_id };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: msg };
  }
}

// ─── Public API ───────────────────────────────────────────────────

/**
 * Check an arb and send a Telegram alert if it passes all thresholds.
 * This is the main entry point for the scan loop.
 */
export async function checkAndSendAlert(
  arb: ArbAlertInput,
  configOverride?: Partial<TelegramAlertConfig>,
): Promise<TelegramAlertResult> {
  const envConfig = getConfigFromEnv();
  if (!envConfig) {
    return { sent: false, reason: 'Telegram not configured (missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID)' };
  }

  const config: TelegramAlertConfig = { ...envConfig, ...configOverride };

  const check = shouldAlert(arb, config);
  if (!check.shouldAlert) {
    return { sent: false, reason: check.reason };
  }

  const message = formatArbMessage(arb);
  const result = await sendTelegramMessage(config.botToken, config.chatId, message);

  if (!result.ok) {
    return { sent: false, error: result.error };
  }

  // Update cooldown tracker
  lastAlertMap.set(arb.marketId, Date.now());

  return { sent: true, messageId: result.messageId };
}

/**
 * Send alerts for multiple arbs from a single scan.
 * Only sends for arbs that pass thresholds; respects cooldown.
 * Returns a summary of what was sent.
 */
export async function sendBatchAlerts(
  arbs: ArbAlertInput[],
  configOverride?: Partial<TelegramAlertConfig>,
): Promise<{ sent: number; skipped: number; errors: string[] }> {
  let sent = 0;
  let skipped = 0;
  const errors: string[] = [];

  for (const arb of arbs) {
    const result = await checkAndSendAlert(arb, configOverride);
    if (result.sent) {
      sent++;
    } else if (result.error) {
      errors.push(`${arb.marketTitle}: ${result.error}`);
    } else {
      skipped++;
    }
  }

  return { sent, skipped, errors };
}

/**
 * Send a test message to verify the Telegram configuration.
 * Useful for the settings UI.
 */
export async function sendTestMessage(
  botToken: string,
  chatId: string,
): Promise<TelegramAlertResult> {
  const message = [
    '✅ <b>H2H Arbitrage — Test Alert</b>',
    '',
    'Telegram alerts are working correctly.',
    `Configured at ${new Date().toISOString().replace('T', ' ').slice(0, 19)} UTC`,
  ].join('\n');

  const result = await sendTelegramMessage(botToken, chatId, message);

  if (!result.ok) {
    return { sent: false, error: result.error };
  }

  return { sent: true, messageId: result.messageId };
}

// ─── Test helpers (exported for unit tests) ──────────────────────

/** Clear cooldown state — for testing only. */
export function _resetCooldown(): void {
  lastAlertMap.clear();
}