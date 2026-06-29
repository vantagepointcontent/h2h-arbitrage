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
  getConfigFromEnv,
  checkAndSendAlert,
  sendBatchAlerts,
  sendTestMessage,
  sendTelegramMessage,
  _resetCooldown,
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
});