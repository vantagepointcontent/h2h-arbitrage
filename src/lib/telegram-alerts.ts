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
 * Alert types:
 *   🟢  NEW ARB DETECTED      — fresh arbitrage above thresholds
 *   📈  ARB SPREAD WIDENED    — ROI increased >2% since last scan
 *   ⚠️  ARB VANISHING         — ROI dropped >50% from last scan
 *   🏁  MARKET RESOLVED       — market expired/resolved
 *
 * The module is self-contained: no dependency on logger (avoids circular deps).
 * Errors are swallowed and returned in the result object so callers can
 * decide whether to log them.
 */

// ─── Types ────────────────────────────────────────────────────────

/** Arb type classification — derived from strategy string. */
export type ArbType = 'cross' | 'direct' | 'internal';

/**
 * Classify an arb type from its strategy string.
 * - "Buy YES both sides" → cross (YES on Kalshi for outcome A + YES on PM for outcome B)
 * - "Same-platform YES+YES" → internal (YES on both outcomes, same platform)
 * - "Buy YES Kalshi + NO PM" / "Buy YES PM + NO Kalshi" → direct (classic cross-platform)
 * - Everything else (incl. "No arb") → null
 */
export function classifyArbType(strategy: string): ArbType | null {
  if (!strategy || strategy === 'No arb') return null;
  if (strategy.includes('both sides')) return 'cross';
  if (strategy.startsWith('Same-platform')) return 'internal';
  if (strategy.startsWith('Buy YES')) return 'direct';
  return null;
}

/** Short uppercase tag for display in alerts and UI. */
export function arbTypeTag(strategy: string): string {
  const t = classifyArbType(strategy);
  return t ? `[${t.toUpperCase()}]` : '';
}

export interface ArbAlertInput {
  marketTitle: string;
  marketId: string;
  roiPct: number;
  expectedProfit: number;
  strategy: string;
  totalStake?: number;
  /** Outcome name — enables the episode-persistence filter (ALERT-001). */
  outcome?: string;
  /** Explicit arb type — if omitted, derived from strategy via classifyArbType(). */
  arbType?: ArbType;
  fees?: {
    kalshiFee: number;
    pmFee: number;
    worstCaseNetProfit: number;
  };
  /** Optional platform prices for enhanced messages */
  kalshiYesPrice?: number;
  kalshiNoPrice?: number;
  pmYesPrice?: number;
  pmNoPrice?: number;
  /** Optional persistence score (0-100) */
  persistenceScore?: number;
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
  /** ALERT-001: minimum total stake ($) the arb must support. 0 disables. */
  minStakeUsd: number;
  /** ALERT-001: minimum seconds the arb episode must have persisted. 0 disables. */
  minPersistenceSec: number;
}

// ─── Internal state ───────────────────────────────────────────────

/** Track last-alert time per market to enforce cooldown. */
const lastAlertMap = new Map<string, number>();

/** Track previous ROI per market for spread-change detection. */
const previousRoiMap = new Map<string, number>();

/** Markets known to be expired/resolved (avoid duplicate alerts). */
const resolvedMarkets = new Set<string>();

/** Default thresholds. */
const DEFAULT_MIN_ROI = 1.0;
const DEFAULT_MIN_PROFIT = 1.0;
const DEFAULT_COOLDOWN_MS = 5 * 60 * 1000; // 5 min

/** Minimum ROI increase (%) to trigger "spread widened" alert. */
const SPREAD_WIDENED_THRESHOLD = 2.0;

/** Minimum ROI drop fraction to trigger "vanishing" alert (50%). */
const VANISHING_DROP_FRACTION = 0.5;

/** ALERT-001 defaults: arb must support ≥$50 stake and have persisted ≥60s. */
const DEFAULT_MIN_STAKE = 50;
const DEFAULT_MIN_PERSISTENCE_SEC = 60;

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
    minStakeUsd: parseFloat(process.env.TELEGRAM_MIN_STAKE_USD ?? '') || DEFAULT_MIN_STAKE,
    minPersistenceSec: parseFloat(process.env.TELEGRAM_MIN_PERSISTENCE_SEC ?? '') || DEFAULT_MIN_PERSISTENCE_SEC,
  };
}

/** Check if alerts are paused via env var. */
export function isPaused(): boolean {
  return process.env.TELEGRAM_ALERTS_PAUSED === 'true' ||
         process.env.TELEGRAM_ALERTS_PAUSED === '1';
}

// ─── SETTINGS-001: DB-backed overrides (hot-reload) ───────────────

/**
 * Async pause check: DB setting > env. Falls back to env on DB failure.
 */
export async function isPausedResolved(): Promise<boolean> {
  try {
    const { getSetting } = await import('./settings');
    return await getSetting<boolean>('alerts.paused');
  } catch {
    return isPaused();
  }
}

/**
 * Resolve alert thresholds through the settings layer (DB > env > default).
 * Bot token / chat id stay env-only — they're secrets, not tunables.
 */
export async function getConfigResolved(): Promise<TelegramAlertConfig | null> {
  const envConfig = getConfigFromEnv();
  if (!envConfig) return null;
  try {
    const { getSetting } = await import('./settings');
    return {
      ...envConfig,
      minRoiPct: await getSetting<number>('alerts.minRoiPct'),
      minProfitUsd: await getSetting<number>('alerts.minProfitUsd'),
      cooldownMs: await getSetting<number>('alerts.cooldownMs'),
      minStakeUsd: await getSetting<number>('alerts.minStakeUsd'),
      minPersistenceSec: await getSetting<number>('alerts.minPersistenceSec'),
    };
  } catch {
    return envConfig; // settings layer unavailable — env values still apply
  }
}

// ─── Message formatting ───────────────────────────────────────────

/** Format a probability price (0–1) with adaptive precision for sub-cent values. */
function fmtProbPrice(price: number): string {
  if (price >= 0.01) return price.toFixed(2);
  if (price >= 0.001) return price.toFixed(3);
  return price.toFixed(4);
}

/** Build the platform-prices line shared by all arb formatters. */
function buildPricesLine(arb: ArbAlertInput): string {
  const parts: string[] = [];
  if (arb.kalshiYesPrice != null || arb.kalshiNoPrice != null) {
    const kYes = arb.kalshiYesPrice != null ? `$${fmtProbPrice(arb.kalshiYesPrice)}` : '—';
    const kNo = arb.kalshiNoPrice != null ? `$${fmtProbPrice(arb.kalshiNoPrice)}` : '—';
    parts.push(`<code>K: YES ${kYes} / NO ${kNo}</code>`);
  }
  if (arb.pmYesPrice != null || arb.pmNoPrice != null) {
    const pYes = arb.pmYesPrice != null ? `$${fmtProbPrice(arb.pmYesPrice)}` : '—';
    const pNo = arb.pmNoPrice != null ? `$${fmtProbPrice(arb.pmNoPrice)}` : '—';
    parts.push(`<code>PM: YES ${pYes} / NO ${pNo}</code>`);
  }
  return parts.length > 0 ? `\n📊 ${parts.join(' · ')}` : '';
}

/** Build the persistence-line shared by arb formatters. */
function buildPersistenceLine(score: number | undefined): string {
  return score != null ? `\n🛡️ Persistence: <b>${score}</b>/100` : '';
}

/** Build the deep-link shared by all formatters. */
function buildDeepLink(id: string | undefined): string {
  return id ? `\n🔗 <a href="http://100.86.7.30:3000/?view=scan&id=${encodeURIComponent(id)}">View Scan</a>` : '';
}

/** Shared footer: timestamp + deep link. */
function buildFooter(deepLink: string): string {
  return `\n🕐 ${new Date().toISOString().replace('T', ' ').slice(0, 19)} UTC\n${deepLink}`;
}

/**
 * Format an arb opportunity as a Telegram message.
 * Uses HTML parse_mode for rich formatting.
 * Includes platform prices, deep link, and persistence score when available.
 */
export function formatArbMessage(arb: ArbAlertInput): string {
  const roiStr = arb.roiPct.toFixed(2);
  const profitStr = arb.expectedProfit.toFixed(2);
  const stakeStr = arb.totalStake ? arb.totalStake.toFixed(2) : '—';
  const feeStr = arb.fees
    ? `Net: $${arb.fees.worstCaseNetProfit.toFixed(2)}`
    : '';
  const deepLink = buildDeepLink(arb.marketId);
  const tag = arb.arbType
    ? `[${arb.arbType.toUpperCase()}]`
    : arbTypeTag(arb.strategy);

  return [
    `🟢 <b>Arbitrage Found</b> ${tag}`,
    '',
    `<b>${escapeHtml(arb.marketTitle)}</b>`,
    '',
    `📈 ROI: <b>${roiStr}%</b>`,
    `💰 Profit: <b>$${profitStr}</b>${feeStr ? ` (${feeStr})` : ''}`,
    `🎯 Strategy: ${escapeHtml(arb.strategy)}`,
    `💵 Stake: $${stakeStr}`,
    buildPricesLine(arb),
    buildPersistenceLine(arb.persistenceScore),
    '',
    buildFooter(deepLink),
  ].join('\n');
}

/**
 * Format a "spread widened" alert.
 */
export function formatSpreadWidenedMessage(arb: ArbAlertInput, prevRoi: number): string {
  const delta = arb.roiPct - prevRoi;
  const deepLink = buildDeepLink(arb.marketId);
  const tag = arb.arbType
    ? `[${arb.arbType.toUpperCase()}]`
    : arbTypeTag(arb.strategy);

  return [
    `📈 <b>ARB SPREAD WIDENED</b> ${tag}`,
    '',
    `<b>${escapeHtml(arb.marketTitle)}</b>`,
    '',
    `ROI: ${prevRoi.toFixed(2)}% → <b>${arb.roiPct.toFixed(2)}%</b> (+${delta.toFixed(2)}%)`,
    `💰 Profit: <b>$${arb.expectedProfit.toFixed(2)}</b>`,
    `🎯 Strategy: ${escapeHtml(arb.strategy)}`,
    buildPricesLine(arb),
    buildPersistenceLine(arb.persistenceScore),
    '',
    buildFooter(deepLink),
  ].join('\n');
}

/**
 * Format an "arb vanishing" alert.
 */
export function formatVanishingMessage(arb: ArbAlertInput, prevRoi: number): string {
  const dropPct = ((prevRoi - arb.roiPct) / Math.abs(prevRoi) * 100);
  const deepLink = buildDeepLink(arb.marketId);
  const tag = arb.arbType
    ? `[${arb.arbType.toUpperCase()}]`
    : arbTypeTag(arb.strategy);

  return [
    `⚠️ <b>ARB VANISHING</b> ${tag}`,
    '',
    `<b>${escapeHtml(arb.marketTitle)}</b>`,
    '',
    `ROI: ${prevRoi.toFixed(2)}% → <b>${arb.roiPct.toFixed(2)}%</b> (-${dropPct.toFixed(1)}%)`,
    `💰 Profit: <b>$${arb.expectedProfit.toFixed(2)}</b>`,
    `🎯 Strategy: ${escapeHtml(arb.strategy)}`,
    buildPricesLine(arb),
    '',
    `Act now — spread is closing fast!`,
    '',
    buildFooter(deepLink),
  ].join('\n');
}

/**
 * Format a "market resolved" alert.
 */
export function formatResolvedMessage(marketTitle: string, marketId: string): string {
  const deepLink = marketId
    ? `\n🔗 <a href="http://100.86.7.30:3000/?view=scan&id=${encodeURIComponent(marketId)}">View Scan</a>`
    : '';

  return [
    '🏁 <b>MARKET RESOLVED</b>',
    '',
    `<b>${escapeHtml(marketTitle)}</b>`,
    '',
    'Market has expired or been resolved.',
    '',
    `🕐 ${new Date().toISOString().replace('T', ' ').slice(0, 19)} UTC`,
    deepLink,
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

  // ALERT-001: stake filter — a 5% ROI on a $3 fillable arb is noise.
  if (config.minStakeUsd > 0 && (arb.totalStake ?? 0) < config.minStakeUsd) {
    return { shouldAlert: false, reason: `Stake $${(arb.totalStake ?? 0).toFixed(2)} below threshold $${config.minStakeUsd}` };
  }

  const lastAlert = lastAlertMap.get(arb.marketId);
  if (lastAlert && now - lastAlert < config.cooldownMs) {
    const remainingMs = config.cooldownMs - (now - lastAlert);
    return { shouldAlert: false, reason: `Cooldown active (${Math.ceil(remainingMs / 1000)}s remaining)` };
  }

  return { shouldAlert: true };
}

// ─── Change-detection helpers ──────────────────────────────────────

/**
 * Check if ROI increased enough to warrant a "spread widened" alert.
 */
export function detectSpreadWidened(arb: ArbAlertInput): boolean {
  const prev = previousRoiMap.get(arb.marketId);
  if (prev == null) return false;
  const delta = arb.roiPct - prev;
  return delta > SPREAD_WIDENED_THRESHOLD;
}

/**
 * Check if ROI dropped enough to warrant a "vanishing" alert.
 */
export function detectVanishing(arb: ArbAlertInput): boolean {
  const prev = previousRoiMap.get(arb.marketId);
  if (prev == null) return false;
  if (prev <= 0) return false;
  const dropFraction = (prev - arb.roiPct) / Math.abs(prev);
  return dropFraction >= VANISHING_DROP_FRACTION;
}

/**
 * Check if a market is newly resolved/expired.
 */
export function detectResolved(marketId: string, marketTitle: string, isExpiredOrZero: boolean): boolean {
  if (!isExpiredOrZero) return false;
  if (resolvedMarkets.has(marketId)) return false;
  resolvedMarkets.add(marketId);
  return true;
}

// ─── State management for change detection ────────────────────────

/**
 * Record current ROI for this market so future scans can compare.
 */
function recordRoi(marketId: string, roiPct: number): void {
  previousRoiMap.set(marketId, roiPct);
}

/**
 * Mark a market as resolved so we don't re-alert.
 */
function markResolved(marketId: string): void {
  resolvedMarkets.add(marketId);
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
 * Handles: new arb, spread widened, vanishing alerts.
 */
export async function checkAndSendAlert(
  arb: ArbAlertInput,
  configOverride?: Partial<TelegramAlertConfig>,
): Promise<TelegramAlertResult> {
  const envConfig = await getConfigResolved();
  if (!envConfig) {
    return { sent: false, reason: 'Telegram not configured (missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID)' };
  }

  if (await isPausedResolved()) {
    return { sent: false, reason: 'Alerts paused (settings or TELEGRAM_ALERTS_PAUSED)' };
  }

  const config: TelegramAlertConfig = { ...envConfig, ...configOverride };

  // --- Check for spread widened (even during cooldown) ---
  if (detectSpreadWidened(arb)) {
    const prevRoi = previousRoiMap.get(arb.marketId)!;
    const message = formatSpreadWidenedMessage(arb, prevRoi);
    const result = await sendTelegramMessage(config.botToken, config.chatId, message);
    recordRoi(arb.marketId, arb.roiPct);
    if (!result.ok) return { sent: false, error: result.error };
    return { sent: true, messageId: result.messageId };
  }

  // --- Check for vanishing (even during cooldown) ---
  if (detectVanishing(arb)) {
    const prevRoi = previousRoiMap.get(arb.marketId)!;
    const message = formatVanishingMessage(arb, prevRoi);
    const result = await sendTelegramMessage(config.botToken, config.chatId, message);
    recordRoi(arb.marketId, arb.roiPct);
    if (!result.ok) return { sent: false, error: result.error };
    return { sent: true, messageId: result.messageId };
  }

  // --- Standard new arb check ---
  const check = shouldAlert(arb, config);
  if (!check.shouldAlert) {
    return { sent: false, reason: check.reason };
  }

  // --- ALERT-001: persistence filter (async — episode lookup in SQLite) ---
  // Don't ping on arbs younger than minPersistenceSec: 5-second phantoms
  // are gone before anyone can act. Requires arb.outcome; lookup failures
  // fail OPEN (alert anyway) — a lost alert is worse than a noisy one.
  if (config.minPersistenceSec > 0 && arb.outcome) {
    try {
      const { getOpenEpisodeAgeSec } = await import('./arb-lifecycle');
      const ageSec = await getOpenEpisodeAgeSec(arb.marketId, arb.outcome);
      if (ageSec < config.minPersistenceSec) {
        return { sent: false, reason: `Arb persisted ${Math.round(ageSec)}s, below threshold ${config.minPersistenceSec}s` };
      }
    } catch { /* fail open */ }
  }

  const message = formatArbMessage(arb);
  const result = await sendTelegramMessage(config.botToken, config.chatId, message);

  if (!result.ok) {
    return { sent: false, error: result.error };
  }

  // Update cooldown tracker and ROI tracker
  lastAlertMap.set(arb.marketId, Date.now());
  recordRoi(arb.marketId, arb.roiPct);

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
 * Send a market-resolved alert.
 * Call this when a scan detects an expired/zero-market result.
 */
export async function sendResolvedAlert(
  marketTitle: string,
  marketId: string,
  configOverride?: Partial<TelegramAlertConfig>,
): Promise<TelegramAlertResult> {
  if (!detectResolved(marketId, marketTitle, true)) {
    return { sent: false, reason: 'Already alerted for this resolved market' };
  }

  const envConfig = getConfigFromEnv();
  if (!envConfig) {
    return { sent: false, reason: 'Telegram not configured' };
  }

  if (isPaused()) {
    return { sent: false, reason: 'Alerts paused' };
  }

  const config: TelegramAlertConfig = { ...envConfig, ...configOverride };
  const message = formatResolvedMessage(marketTitle, marketId);
  const result = await sendTelegramMessage(config.botToken, config.chatId, message);

  if (!result.ok) {
    return { sent: false, error: result.error };
  }

  markResolved(marketId);
  return { sent: true, messageId: result.messageId };
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
    '✅ <b>EdgeFinder — Test Alert</b>',
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

/** Clear previous ROI tracking — for testing only. */
export function _resetPreviousRoi(): void {
  previousRoiMap.clear();
}

/** Clear resolved markets tracking — for testing only. */
export function _resetResolved(): void {
  resolvedMarkets.clear();
}

/** Set previous ROI for a market — for testing only. */
export function _setPreviousRoi(marketId: string, roiPct: number): void {
  previousRoiMap.set(marketId, roiPct);
}

/** Get previous ROI for inspection — for testing only. */
export function _getPreviousRoi(marketId: string): number | undefined {
  return previousRoiMap.get(marketId);
}
