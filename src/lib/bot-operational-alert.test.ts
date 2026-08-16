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

import { sendBotOperationalAlert } from './bot-trader';

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
    await expect(sendBotOperationalAlert(input, 'Configure valid live credentials', 'scan:41:production-blocked'))
      .resolves.toEqual({ durable: true, delivered: false, error: 'Telegram not configured' });
    expect(mocks.createBotMessage).toHaveBeenCalledWith(expect.objectContaining({
      tradeId: 'scan:41:production-blocked',
      status: 'failed',
      errorReason: 'Telegram not configured',
      messageText: expect.stringContaining('Configure valid live credentials'),
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
});
