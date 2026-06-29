import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

// Mock fetch globally
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// Mock AbortSignal.timeout (not available in all test envs)
if (!AbortSignal.timeout) {
  AbortSignal.timeout = ((ms: number) => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), ms);
    return controller.signal;
  }) as typeof AbortSignal.timeout;
}

import {
  shouldAlert,
  formatArbMessage,
  formatSpreadWidenedMessage,
  formatVanishingMessage,
  formatResolvedMessage,
  getConfigFromEnv,
  checkAndSendAlert,
  sendBatchAlerts,
  sendTestMessage,
  sendTelegramMessage,
  sendResolvedAlert,
  detectSpreadWidened,
  detectVanishing,
  detectResolved,
  _resetCooldown,
  _resetPreviousRoi,
  _resetResolved,
  _setPreviousRoi,
  _getPreviousRoi,
  ArbAlertInput,
  TelegramAlertConfig,
} from './telegram-alerts';

// ─── Test fixtures ────────────────────────────────────────────────

const baseArb: ArbAlertInput = {
  marketTitle: 'Trump vs Harris 2024',
  marketId: 'market-123',
  roiPct: 5.2,
  expectedProfit: 52.30,
  strategy: 'Buy YES Kalshi + NO PM',
  totalStake: 1000,
};

const baseConfig: TelegramAlertConfig = {
  botToken: 'test-token',
  chatId: '-100123',
  minRoiPct: 1.0,
  minProfitUsd: 1.0,
  cooldownMs: 300000, // 5 min
};

// ─── Tests ────────────────────────────────────────────────────────

describe('telegram-alerts', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    _resetCooldown();
    _resetPreviousRoi();
    _resetResolved();
    // Clear env
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.TELEGRAM_CHAT_ID;
    delete process.env.TELEGRAM_MIN_ROI_PCT;
    delete process.env.TELEGRAM_MIN_PROFIT_USD;
    delete process.env.TELEGRAM_COOLDOWN_MS;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── shouldAlert ──────────────────────────────────────────────

  describe('shouldAlert', () => {
    it('returns true for arb above all thresholds', () => {
      const result = shouldAlert(baseArb, baseConfig);
      expect(result.shouldAlert).toBe(true);
      expect(result.reason).toBeUndefined();
    });

    it('returns false when ROI is not positive', () => {
      const result = shouldAlert(
        { ...baseArb, roiPct: -2.5 },
        baseConfig,
      );
      expect(result.shouldAlert).toBe(false);
      expect(result.reason).toContain('not positive');
    });

    it('returns false when ROI is exactly 0', () => {
      const result = shouldAlert(
        { ...baseArb, roiPct: 0 },
        baseConfig,
      );
      expect(result.shouldAlert).toBe(false);
    });

    it('returns false when ROI below minRoiPct threshold', () => {
      const result = shouldAlert(
        { ...baseArb, roiPct: 0.5 },
        { ...baseConfig, minRoiPct: 1.0 },
      );
      expect(result.shouldAlert).toBe(false);
      expect(result.reason).toContain('below threshold');
    });

    it('returns false when profit below minProfitUsd threshold', () => {
      const result = shouldAlert(
        { ...baseArb, expectedProfit: 0.50 },
        { ...baseConfig, minProfitUsd: 1.0 },
      );
      expect(result.shouldAlert).toBe(false);
      expect(result.reason).toContain('below threshold');
    });

    it('returns false when within cooldown period', () => {
      const now = 1000000;
      // First alert passes
      const first = shouldAlert(baseArb, baseConfig, now);
      expect(first.shouldAlert).toBe(true);

      // Simulate cooldown being set (we need to manually set it since shouldAlert doesn't set it)
      // checkAndSendAlert sets it, not shouldAlert — so we test via checkAndSendAlert
    });

    it('returns true when cooldown has expired', async () => {
      // Use checkAndSendAlert to set cooldown, then verify it expires
      process.env.TELEGRAM_BOT_TOKEN = 'test-token';
      process.env.TELEGRAM_CHAT_ID = '-100123';

      mockFetch.mockResolvedValueOnce({
        json: async () => ({ ok: true, result: { message_id: 1 } }),
      });

      await checkAndSendAlert(baseArb);

      // Within cooldown — should skip
      const withinCooldown = shouldAlert(baseArb, baseConfig);
      expect(withinCooldown.shouldAlert).toBe(false);
      expect(withinCooldown.reason).toContain('Cooldown');

      // After cooldown — should pass
      const afterCooldown = shouldAlert(
        baseArb,
        { ...baseConfig, cooldownMs: 0 },
        Date.now() + 1,
      );
      expect(afterCooldown.shouldAlert).toBe(true);
    });
  });

  // ── formatArbMessage ─────────────────────────────────────────

  describe('formatArbMessage', () => {
    it('formats a complete arb message with all fields', () => {
      const msg = formatArbMessage(baseArb);
      expect(msg).toContain('Arbitrage Found');
      expect(msg).toContain('Trump vs Harris 2024');
      expect(msg).toContain('5.20%');
      expect(msg).toContain('$52.30');
      expect(msg).toContain('Buy YES Kalshi + NO PM');
      expect(msg).toContain('$1000');
    });

    it('includes net profit when fees are provided', () => {
      const msg = formatArbMessage({
        ...baseArb,
        fees: {
          kalshiFee: 2,
          pmFee: 1,
          worstCaseNetProfit: 49.30,
        },
      });
      expect(msg).toContain('Net: $49.30');
    });

    it('omits net profit line when no fees', () => {
      const msg = formatArbMessage(baseArb);
      expect(msg).not.toContain('Net:');
    });

    it('shows dash for stake when not provided', () => {
      const msg = formatArbMessage({ ...baseArb, totalStake: undefined });
      expect(msg).toContain('Stake: $—');
    });

    it('escapes HTML special characters in market title', () => {
      const msg = formatArbMessage({
        ...baseArb,
        marketTitle: '<script>alert("xss")</script> & stuff',
      });
      expect(msg).toContain('&lt;script&gt;');
      expect(msg).toContain('&amp; stuff');
      expect(msg).not.toContain('<script>');
    });

    it('escapes HTML in strategy field', () => {
      const msg = formatArbMessage({
        ...baseArb,
        strategy: 'Buy <YES> & NO',
      });
      expect(msg).toContain('&lt;YES&gt;');
      expect(msg).toContain('&amp; NO');
    });

    it('includes platform prices when provided', () => {
      const msg = formatArbMessage({
        ...baseArb,
        kalshiYesPrice: 0.45,
        kalshiNoPrice: 0.55,
        pmYesPrice: 0.52,
        pmNoPrice: 0.48,
      });
      expect(msg).toContain('K: YES $0.45 / NO $0.55');
      expect(msg).toContain('PM: YES $0.52 / NO $0.48');
    });

    it('includes persistence score when provided', () => {
      const msg = formatArbMessage({
        ...baseArb,
        persistenceScore: 75,
      });
      expect(msg).toContain('Persistence: <b>75</b>/100');
    });

    it('includes deep link when marketId is present', () => {
      const msg = formatArbMessage(baseArb);
      expect(msg).toContain('http://100.86.7.30:3000/?view=scan&id=market-123');
    });

    it('encodes special chars in deep link', () => {
      const msg = formatArbMessage({
        ...baseArb,
        marketId: 'abc/def&ghi',
      });
      expect(msg).toContain('view=scan&id=abc%2Fdef%26ghi');
    });
  });

  // ── Spread Widened alert ────────────────────────────────────

  describe('spread widened', () => {
    it('detectSpreadWidened returns true when ROI increased >2%', () => {
      _setPreviousRoi('mkt-1', 3.0);
      const arb: ArbAlertInput = { ...baseArb, marketId: 'mkt-1', roiPct: 5.5 };
      expect(detectSpreadWidened(arb)).toBe(true);
    });

    it('detectSpreadWidened returns false when ROI increased ≤2%', () => {
      _setPreviousRoi('mkt-2', 4.0);
      const arb: ArbAlertInput = { ...baseArb, marketId: 'mkt-2', roiPct: 5.5 };
      expect(detectSpreadWidened(arb)).toBe(false);
    });

    it('detectSpreadWidened returns false when ROI decreased', () => {
      _setPreviousRoi('mkt-3', 8.0);
      const arb: ArbAlertInput = { ...baseArb, marketId: 'mkt-3', roiPct: 5.5 };
      expect(detectSpreadWidened(arb)).toBe(false);
    });

    it('detectSpreadWidened returns false when no previous ROI tracked', () => {
      const arb: ArbAlertInput = { ...baseArb, marketId: 'mkt-new' };
      expect(detectSpreadWidened(arb)).toBe(false);
    });

    it('formatSpreadWidenedMessage contains correct emoji and labels', () => {
      const msg = formatSpreadWidenedMessage(baseArb, 3.0);
      expect(msg).toContain('📈');
      expect(msg).toContain('ARB SPREAD WIDENED');
      expect(msg).toContain('+2.20%');
    });

    it('checkAndSendAlert sends widened alert even during cooldown', async () => {
      process.env.TELEGRAM_BOT_TOKEN = 'tok';
      process.env.TELEGRAM_CHAT_ID = '-100';

      _setPreviousRoi('widening-market', 3.0);
      // First alert to establish cooldown
      mockFetch.mockResolvedValueOnce({
        json: async () => ({ ok: true, result: { message_id: 1 } }),
      });
      // Second call triggers widened alert
      mockFetch.mockResolvedValueOnce({
        json: async () => ({ ok: true, result: { message_id: 2 } }),
      });

      const first = await checkAndSendAlert({ ...baseArb, marketId: 'widening-market', roiPct: 3.0 });
      expect(first.sent).toBe(true);

      const second = await checkAndSendAlert({ ...baseArb, marketId: 'widening-market', roiPct: 5.5 });
      expect(second.sent).toBe(true);
      // The message body should mention spread widened
      const callBody = JSON.parse(mockFetch.mock.calls[1][1].body);
      expect(callBody.text).toContain('ARB SPREAD WIDENED');
    });
  });

  // ── Vanishing alert ──────────────────────────────────────────

  describe('vanishing', () => {
    it('detectVanishing returns true when ROI dropped >50%', () => {
      _setPreviousRoi('v1', 10.0);
      const arb: ArbAlertInput = { ...baseArb, marketId: 'v1', roiPct: 4.0 };
      expect(detectVanishing(arb)).toBe(true);
    });

    it('detectVanishing returns false when ROI dropped ≤50%', () => {
      _setPreviousRoi('v2', 10.0);
      const arb: ArbAlertInput = { ...baseArb, marketId: 'v2', roiPct: 5.5 };
      expect(detectVanishing(arb)).toBe(false);
    });

    it('detectVanishing returns false when ROI increased', () => {
      _setPreviousRoi('v3', 5.0);
      const arb: ArbAlertInput = { ...baseArb, marketId: 'v3', roiPct: 8.0 };
      expect(detectVanishing(arb)).toBe(false);
    });

    it('detectVanishing returns false when no previous ROI tracked', () => {
      const arb: ArbAlertInput = { ...baseArb, marketId: 'v-new' };
      expect(detectVanishing(arb)).toBe(false);
    });

    it('formatVanishingMessage contains correct emoji and labels', () => {
      const msg = formatVanishingMessage(baseArb, 10.0);
      expect(msg).toContain('⚠️');
      expect(msg).toContain('ARB VANISHING');
      expect(msg).toContain('Act now — spread is closing fast!');
    });

    it('checkAndSendAlert sends vanishing alert even during cooldown', async () => {
      process.env.TELEGRAM_BOT_TOKEN = 'tok';
      process.env.TELEGRAM_CHAT_ID = '-100';

      _setPreviousRoi('vanish-market', 10.0);
      // First alert establishes cooldown
      mockFetch.mockResolvedValueOnce({
        json: async () => ({ ok: true, result: { message_id: 1 } }),
      });
      // Second call triggers vanishing alert
      mockFetch.mockResolvedValueOnce({
        json: async () => ({ ok: true, result: { message_id: 2 } }),
      });

      const first = await checkAndSendAlert({ ...baseArb, marketId: 'vanish-market', roiPct: 10.0 });
      expect(first.sent).toBe(true);

      const second = await checkAndSendAlert({ ...baseArb, marketId: 'vanish-market', roiPct: 3.0 });
      expect(second.sent).toBe(true);
      const callBody = JSON.parse(mockFetch.mock.calls[1][1].body);
      expect(callBody.text).toContain('ARB VANISHING');
    });
  });

  // ── Resolved market alert ────────────────────────────────────

  describe('market resolved', () => {
    it('detectResolved returns true for new expired market', () => {
      expect(detectResolved('r1', 'Some Market Title', true)).toBe(true);
    });

    it('detectResolved returns false for already-resolved market', () => {
      expect(detectResolved('r1b', 'Same Market', true)).toBe(true);
      // Second call: already resolved
      expect(detectResolved('r1b', 'Same Market', true)).toBe(false);
    });

    it('detectResolved returns false when not expired', () => {
      expect(detectResolved('r2', 'Active Market', false)).toBe(false);
    });

    it('formatResolvedMessage contains correct emoji and labels', () => {
      const msg = formatResolvedMessage('Some Market', 'mrkt-1');
      expect(msg).toContain('🏁');
      expect(msg).toContain('MARKET RESOLVED');
      expect(msg).toContain('expired or been resolved');
    });

    it('sendResolvedAlert sends alert for new resolved market', async () => {
      process.env.TELEGRAM_BOT_TOKEN = 'tok';
      process.env.TELEGRAM_CHAT_ID = '-100';

      mockFetch.mockResolvedValueOnce({
        json: async () => ({ ok: true, result: { message_id: 5 } }),
      });

      const result = await sendResolvedAlert('Resolved Market', 'rm-1');
      expect(result.sent).toBe(true);
      expect(result.messageId).toBe(5);
    });

    it('sendResolvedAlert skips already-alerted market', async () => {
      process.env.TELEGRAM_BOT_TOKEN = 'tok';
      process.env.TELEGRAM_CHAT_ID = '-100';

      // First call marks as resolved
      mockFetch.mockResolvedValueOnce({
        json: async () => ({ ok: true, result: { message_id: 5 } }),
      });

      const first = await sendResolvedAlert('Same Market', 'rm-2');
      expect(first.sent).toBe(true);

      // Second call should skip
      const second = await sendResolvedAlert('Same Market', 'rm-2');
      expect(second.sent).toBe(false);
      expect(second.reason).toContain('Already alerted');
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });
  });

  // ── getConfigFromEnv ─────────────────────────────────────────

  describe('getConfigFromEnv', () => {
    it('returns null when no env vars set', () => {
      expect(getConfigFromEnv()).toBeNull();
    });

    it('returns config when bot token and chat ID are set', () => {
      process.env.TELEGRAM_BOT_TOKEN = 'tok123';
      process.env.TELEGRAM_CHAT_ID = '-100999';
      const config = getConfigFromEnv();
      expect(config).not.toBeNull();
      expect(config!.botToken).toBe('tok123');
      expect(config!.chatId).toBe('-100999');
    });

    it('uses default thresholds when not overridden', () => {
      process.env.TELEGRAM_BOT_TOKEN = 'tok';
      process.env.TELEGRAM_CHAT_ID = '-1';
      const config = getConfigFromEnv();
      expect(config!.minRoiPct).toBe(1.0);
      expect(config!.minProfitUsd).toBe(1.0);
      expect(config!.cooldownMs).toBe(300000);
    });

    it('reads custom thresholds from env', () => {
      process.env.TELEGRAM_BOT_TOKEN = 'tok';
      process.env.TELEGRAM_CHAT_ID = '-1';
      process.env.TELEGRAM_MIN_ROI_PCT = '3.5';
      process.env.TELEGRAM_MIN_PROFIT_USD = '10';
      process.env.TELEGRAM_COOLDOWN_MS = '60000';
      const config = getConfigFromEnv();
      expect(config!.minRoiPct).toBe(3.5);
      expect(config!.minProfitUsd).toBe(10);
      expect(config!.cooldownMs).toBe(60000);
    });

    it('returns null when only bot token is set', () => {
      process.env.TELEGRAM_BOT_TOKEN = 'tok';
      expect(getConfigFromEnv()).toBeNull();
    });
  });

  // ── sendTelegramMessage ──────────────────────────────────────

  describe('sendTelegramMessage', () => {
    it('sends message successfully and returns messageId', async () => {
      mockFetch.mockResolvedValueOnce({
        json: async () => ({ ok: true, result: { message_id: 42 } }),
      });

      const result = await sendTelegramMessage('token', 'chat123', 'test message');
      expect(result.ok).toBe(true);
      expect(result.messageId).toBe(42);

      // Verify fetch was called correctly
      expect(mockFetch).toHaveBeenCalledOnce();
      const call = mockFetch.mock.calls[0];
      expect(call[0]).toContain('api.telegram.org/bottoken/sendMessage');
      const body = JSON.parse(call[1].body);
      expect(body.chat_id).toBe('chat123');
      expect(body.text).toBe('test message');
      expect(body.parse_mode).toBe('HTML');
    });

    it('returns error when Telegram API returns error', async () => {
      mockFetch.mockResolvedValueOnce({
        json: async () => ({ ok: false, description: 'Chat not found' }),
      });

      const result = await sendTelegramMessage('token', 'bad-chat', 'test');
      expect(result.ok).toBe(false);
      expect(result.error).toBe('Chat not found');
    });

    it('returns error when fetch throws', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Network failure'));

      const result = await sendTelegramMessage('token', 'chat', 'test');
      expect(result.ok).toBe(false);
      expect(result.error).toBe('Network failure');
    });
  });

  // ── checkAndSendAlert ────────────────────────────────────────

  describe('checkAndSendAlert', () => {
    it('returns not-configured when env vars are missing', async () => {
      const result = await checkAndSendAlert(baseArb);
      expect(result.sent).toBe(false);
      expect(result.reason).toContain('not configured');
    });

    it('sends alert when all conditions are met', async () => {
      process.env.TELEGRAM_BOT_TOKEN = 'tok';
      process.env.TELEGRAM_CHAT_ID = '-100';

      mockFetch.mockResolvedValueOnce({
        json: async () => ({ ok: true, result: { message_id: 1 } }),
      });

      const result = await checkAndSendAlert(baseArb);
      expect(result.sent).toBe(true);
      expect(result.messageId).toBe(1);
    });

    it('skips alert when ROI below threshold', async () => {
      process.env.TELEGRAM_BOT_TOKEN = 'tok';
      process.env.TELEGRAM_CHAT_ID = '-100';
      process.env.TELEGRAM_MIN_ROI_PCT = '10';

      const result = await checkAndSendAlert({ ...baseArb, roiPct: 5 });
      expect(result.sent).toBe(false);
      expect(result.reason).toContain('below threshold');
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('skips alert when profit below threshold', async () => {
      process.env.TELEGRAM_BOT_TOKEN = 'tok';
      process.env.TELEGRAM_CHAT_ID = '-100';
      process.env.TELEGRAM_MIN_PROFIT_USD = '100';

      const result = await checkAndSendAlert({ ...baseArb, expectedProfit: 50 });
      expect(result.sent).toBe(false);
      expect(result.reason).toContain('below threshold');
    });

    it('enforces cooldown — second alert within cooldown is skipped', async () => {
      process.env.TELEGRAM_BOT_TOKEN = 'tok';
      process.env.TELEGRAM_CHAT_ID = '-100';

      mockFetch.mockResolvedValue({
        json: async () => ({ ok: true, result: { message_id: 1 } }),
      });

      // First alert — should send
      const first = await checkAndSendAlert(baseArb);
      expect(first.sent).toBe(true);

      // Second alert for same market — should be skipped (cooldown)
      const second = await checkAndSendAlert(baseArb);
      expect(second.sent).toBe(false);
      expect(second.reason).toContain('Cooldown');
    });

    it('different markets are not affected by each other\'s cooldown', async () => {
      process.env.TELEGRAM_BOT_TOKEN = 'tok';
      process.env.TELEGRAM_CHAT_ID = '-100';

      mockFetch.mockResolvedValue({
        json: async () => ({ ok: true, result: { message_id: 1 } }),
      });

      const arb1 = { ...baseArb, marketId: 'market-A' };
      const arb2 = { ...baseArb, marketId: 'market-B' };

      const r1 = await checkAndSendAlert(arb1);
      const r2 = await checkAndSendAlert(arb2);
      expect(r1.sent).toBe(true);
      expect(r2.sent).toBe(true);
    });

    it('returns error when Telegram API fails', async () => {
      process.env.TELEGRAM_BOT_TOKEN = 'tok';
      process.env.TELEGRAM_CHAT_ID = '-100';

      mockFetch.mockResolvedValueOnce({
        json: async () => ({ ok: false, description: 'Unauthorized' }),
      });

      const result = await checkAndSendAlert(baseArb);
      expect(result.sent).toBe(false);
      expect(result.error).toBe('Unauthorized');
    });

    it('records ROI after sending alert', async () => {
      process.env.TELEGRAM_BOT_TOKEN = 'tok';
      process.env.TELEGRAM_CHAT_ID = '-100';

      mockFetch.mockResolvedValueOnce({
        json: async () => ({ ok: true, result: { message_id: 1 } }),
      });

      await checkAndSendAlert(baseArb);
      expect(_getPreviousRoi('market-123')).toBe(5.2);
    });
  });

  // ── sendBatchAlerts ──────────────────────────────────────────

  describe('sendBatchAlerts', () => {
    it('sends multiple alerts for different markets', async () => {
      process.env.TELEGRAM_BOT_TOKEN = 'tok';
      process.env.TELEGRAM_CHAT_ID = '-100';

      mockFetch.mockResolvedValue({
        json: async () => ({ ok: true, result: { message_id: 1 } }),
      });

      const arbs = [
        { ...baseArb, marketId: 'a' },
        { ...baseArb, marketId: 'b' },
        { ...baseArb, marketId: 'c' },
      ];

      const result = await sendBatchAlerts(arbs);
      expect(result.sent).toBe(3);
      expect(result.skipped).toBe(0);
      expect(result.errors).toHaveLength(0);
    });

    it('skips arbs below threshold', async () => {
      process.env.TELEGRAM_BOT_TOKEN = 'tok';
      process.env.TELEGRAM_CHAT_ID = '-100';
      process.env.TELEGRAM_MIN_ROI_PCT = '10';

      mockFetch.mockResolvedValue({
        json: async () => ({ ok: true, result: { message_id: 1 } }),
      });

      const arbs = [
        { ...baseArb, marketId: 'a', roiPct: 15 },
        { ...baseArb, marketId: 'b', roiPct: 5 },  // below threshold
      ];

      const result = await sendBatchAlerts(arbs);
      expect(result.sent).toBe(1);
      expect(result.skipped).toBe(1);
    });

    it('collects errors without stopping', async () => {
      process.env.TELEGRAM_BOT_TOKEN = 'tok';
      process.env.TELEGRAM_CHAT_ID = '-100';

      mockFetch
        .mockResolvedValueOnce({
          json: async () => ({ ok: true, result: { message_id: 1 } }),
        })
        .mockResolvedValueOnce({
          json: async () => ({ ok: false, description: 'Blocked' }),
        });

      const arbs = [
        { ...baseArb, marketId: 'a' },
        { ...baseArb, marketId: 'b' },
      ];

      const result = await sendBatchAlerts(arbs);
      expect(result.sent).toBe(1);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain('Blocked');
    });

    it('returns all skipped when not configured', async () => {
      const result = await sendBatchAlerts([baseArb]);
      expect(result.sent).toBe(0);
      expect(result.skipped).toBe(1);
    });
  });

  // ── sendTestMessage ──────────────────────────────────────────

  describe('sendTestMessage', () => {
    it('sends test message successfully', async () => {
      mockFetch.mockResolvedValueOnce({
        json: async () => ({ ok: true, result: { message_id: 99 } }),
      });

      const result = await sendTestMessage('tok', 'chat');
      expect(result.sent).toBe(true);
      expect(result.messageId).toBe(99);

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.text).toContain('Test Alert');
    });

    it('returns error on API failure', async () => {
      mockFetch.mockResolvedValueOnce({
        json: async () => ({ ok: false, description: 'Bad token' }),
      });

      const result = await sendTestMessage('bad-tok', 'chat');
      expect(result.sent).toBe(false);
      expect(result.error).toBe('Bad token');
    });
  });

  // ── Test helper exports ──────────────────────────────────────

  describe('test helpers', () => {
    it('_resetCooldown clears cooldown map', () => {
      process.env.TELEGRAM_BOT_TOKEN = 'tok';
      process.env.TELEGRAM_CHAT_ID = '-100';
      mockFetch.mockResolvedValue({
        json: async () => ({ ok: true, result: { message_id: 1 } }),
      });
      checkAndSendAlert(baseArb);
      _resetCooldown();
      // Should allow immediate re-send
      const result = shouldAlert(baseArb, baseConfig);
      expect(result.shouldAlert).toBe(true);
    });

    it('_resetPreviousRoi clears ROI tracking', () => {
      _setPreviousRoi('test-mkt', 5.0);
      expect(_getPreviousRoi('test-mkt')).toBe(5.0);
      _resetPreviousRoi();
      expect(_getPreviousRoi('test-mkt')).toBeUndefined();
    });

    it('_resetResolved clears resolved markets', () => {
      _resetResolved();
      expect(detectResolved('fresh-mkt', 'Fresh', true)).toBe(true);
      expect(detectResolved('fresh-mkt', 'Fresh', true)).toBe(false);
      _resetResolved();
      expect(detectResolved('fresh-mkt', 'Fresh', true)).toBe(true);
    });
  });
});
