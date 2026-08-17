import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createBotMessage: vi.fn(),
  updateBotMessage: vi.fn(),
  getConfigResolved: vi.fn(),
  sendTelegramMessage: vi.fn(),
}));

vi.mock('./bot-trader-messages', () => ({
  createBotMessage: mocks.createBotMessage,
  updateBotMessage: mocks.updateBotMessage,
}));
vi.mock('./telegram-alerts', async (importOriginal) => {
  const original = await importOriginal<typeof import('./telegram-alerts')>();
  return {
    ...original,
    getConfigResolved: mocks.getConfigResolved,
    sendTelegramMessage: mocks.sendTelegramMessage,
  };
});

import { sendBotExecutionAlert, sendBotOperationalAlert } from './bot-trader';

const input = { pairId: 'pair-1', marketTitle: 'Blocked market', outcome: 'Team A' };

describe('Ragnar production-readiness operational alerts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getConfigResolved.mockResolvedValue(null);
    mocks.createBotMessage.mockResolvedValue(42);
    mocks.updateBotMessage.mockResolvedValue(undefined);
    mocks.sendTelegramMessage.mockResolvedValue({ ok: false, error: 'not configured' });
  });

  it('persists the exact production blocker even when Telegram is not configured', async () => {
    await expect(sendBotOperationalAlert({ ...input, marketTitle: '<Blocked>' }, 'Configure <valid> credentials', 'scan:41:production-blocked'))
      .resolves.toEqual({ durable: true, delivered: false, error: 'Telegram not configured' });
    expect(mocks.createBotMessage).toHaveBeenCalledWith(expect.objectContaining({
      tradeId: 'scan:41:production-blocked',
      status: 'failed',
      errorReason: 'Telegram not configured',
      messageText: expect.stringMatching(/&lt;Blocked&gt;[\s\S]*Configure &lt;valid&gt; credentials/),
    }));
    expect(mocks.sendTelegramMessage).not.toHaveBeenCalled();
  });

  it('returns a durable failure instead of throwing when alert persistence fails', async () => {
    mocks.createBotMessage.mockRejectedValue(new Error('SQLITE_BUSY alert store'));

    await expect(sendBotOperationalAlert(input, 'Configure valid live credentials', 'scan:42:production-blocked'))
      .resolves.toEqual({
        durable: false,
        delivered: false,
        error: 'Alert persistence failed: SQLITE_BUSY alert store',
      });
    expect(mocks.sendTelegramMessage).not.toHaveBeenCalled();
  });

  it('durably records an unhedged second-leg failure when Telegram delivery fails', async () => {
    mocks.getConfigResolved.mockResolvedValue({ botToken: 'test-token', botTraderChatId: 'chat-1' });
    mocks.sendTelegramMessage.mockResolvedValue({ ok: false, error: 'Telegram rate limited' });

    await expect(sendBotExecutionAlert({
      ...input,
      strategy: 'Buy YES Kalshi + NO PM',
      kalshiMarketQuestion: 'Will Team A win on Kalshi?',
      pmMarketQuestion: 'Will Team A win on Polymarket?',
      kalshiOutcomeLabel: '<Team A>',
      pmOutcomeLabel: '<Team A>',
      kalshiSide: 'yes',
      pmSide: 'no',
      relationshipVerified: true,
      relationshipState: 'verified_complementary',
      relationshipExplanation: 'Canonical matcher verification for the exact selected legs.',
      roiPct: 3,
      expectedProfit: 0.03,
      kalshiStake: 0.45,
      pmStake: 0.52,
    }, {
      success: false,
      unhedged: true,
      error: 'Leg B disappeared and rollback close failed',
      alerts: [{ level: 'error', message: 'Unhedged exposure remains' }],
    }, false, 3, 'trade:unhedged'))
      .resolves.toEqual({ durable: true, delivered: false, error: 'Telegram rate limited' });
    expect(mocks.createBotMessage).toHaveBeenCalledWith(expect.objectContaining({
      tradeId: 'trade:unhedged',
      status: 'pending',
      messageText: expect.stringMatching(/Kalshi question:<\/b> Will Team A win on Kalshi\?[\s\S]*Kalshi:<\/b> &lt;Team A&gt; — YES[\s\S]*Polymarket question:<\/b> Will Team A win on Polymarket\?[\s\S]*Polymarket:<\/b> &lt;Team A&gt; — NO[\s\S]*Verified complementary[\s\S]*Canonical matcher verification for the exact selected legs/),
    }));
    expect(mocks.updateBotMessage).toHaveBeenCalledWith(42, {
      status: 'failed',
      errorReason: 'Telegram rate limited',
    });
  });
});
