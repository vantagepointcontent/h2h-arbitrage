import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getExecutionMode: vi.fn(),
  getCredentialStatus: vi.fn(),
}));

vi.mock('./settings', () => ({
  getExecutionMode: mocks.getExecutionMode,
  getSetting: vi.fn(),
}));
vi.mock('./execution-creds', () => ({ getCredentialStatus: mocks.getCredentialStatus }));

import { getBotExecutionReadiness, type BotSettings } from './bot-trader';

const settings: BotSettings = {
  enabled: true,
  mode: 'production',
  selectionMethod: 'hybrid',
  minRoiPct: 2,
  minApyPct: 0,
  minDepthUsd: 0.5,
  minSharesPerLeg: 1,
  maxExpiryDays: 1,
  maxTradesPerDay: 10,
};

describe('BotTrader live execution readiness', () => {
  beforeEach(() => {
    mocks.getExecutionMode.mockResolvedValue('live');
    mocks.getCredentialStatus.mockResolvedValue({ allReady: true });
    vi.stubEnv('H2H_AUTO_LIVE_ORDERS_AUTHORIZED', 'true');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  it('reports live only when mode, explicit authorization, and credentials are all ready', async () => {
    await expect(getBotExecutionReadiness(settings)).resolves.toMatchObject({
      effectiveMode: 'live',
      authorizationConfigured: true,
      credentialsReady: true,
      blockedReasons: [],
    });
  });

  it.each([
    ['global emergency gate', 'live-gated', true, true, 'Global execute.mode must be live'],
    ['missing authorization', 'live', false, true, 'H2H_AUTO_LIVE_ORDERS_AUTHORIZED=true'],
    ['missing credentials', 'live', true, false, 'Configure valid Kalshi and Polymarket execution credentials'],
  ])('blocks %s without falling back truthfully', async (_label, globalMode, authorized, credentialsReady, expected) => {
    mocks.getExecutionMode.mockResolvedValue(globalMode);
    mocks.getCredentialStatus.mockResolvedValue({ allReady: credentialsReady });
    vi.stubEnv('H2H_AUTO_LIVE_ORDERS_AUTHORIZED', authorized ? 'true' : 'false');
    const readiness = await getBotExecutionReadiness(settings);
    expect(readiness.effectiveMode).toBe('paper');
    expect(readiness.blockedReasons.join('; ')).toContain(expected);
  });
});
