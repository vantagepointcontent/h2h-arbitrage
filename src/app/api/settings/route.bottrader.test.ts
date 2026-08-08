import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getAllSettings: vi.fn(async () => []),
  getSetting: vi.fn(async () => 'paper'),
  setSettings: vi.fn(async () => ({ ok: true, errors: [] })),
  resetSetting: vi.fn(),
}));

vi.mock('@/lib/settings', () => mocks);
vi.mock('@/lib/execution-mode', () => ({ validateLiveConfirmation: vi.fn(() => false) }));
vi.mock('@/lib/error-handler', () => ({ clientSafeError: vi.fn(() => 'safe error') }));

import { POST } from './route';

function productionRequest(confirmation?: string) {
  return new Request('http://localhost/api/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ values: { 'bot.mode': 'production' }, confirmation }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getSetting.mockResolvedValue('paper');
});

describe('BotTrader production settings gate', () => {
  it('requires the exact PRODUCTION confirmation text', async () => {
    const response = await POST(productionRequest() as never);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'Entering BotTrader production mode requires the exact confirmation text PRODUCTION.',
    });
    expect(mocks.setSettings).not.toHaveBeenCalled();
  });

  it('rejects production when the global execution mode is not live', async () => {
    const response = await POST(productionRequest('PRODUCTION') as never);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'BotTrader production mode is only allowed when execute.mode is set to live.',
    });
    expect(mocks.setSettings).not.toHaveBeenCalled();
  });

  it('saves production only after confirmation and a live global mode', async () => {
    mocks.getSetting.mockResolvedValue('live');
    const response = await POST(productionRequest('PRODUCTION') as never);
    expect(response.status).toBe(200);
    expect(mocks.setSettings).toHaveBeenCalledWith({ 'bot.mode': 'production' });
  });
});
