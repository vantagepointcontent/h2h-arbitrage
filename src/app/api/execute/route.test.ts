import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  executeArb: vi.fn(),
  getCredentialStatus: vi.fn(),
  getExecutionMode: vi.fn(),
  persistExecution: vi.fn(),
}));

vi.mock('@/lib/auto-execute', () => ({
  executeArb: mocks.executeArb,
  getSafetyLimitsFromEnv: vi.fn(() => ({})),
  logExecution: vi.fn(),
  getAuditLog: vi.fn(() => []),
}));
vi.mock('@/lib/execution-creds', () => ({
  getCredentialStatus: mocks.getCredentialStatus,
  saveCredential: vi.fn(),
  removeCredential: vi.fn(),
  CREDENTIAL_KEYS: [],
}));
vi.mock('@/lib/settings', () => ({
  getExecutionMode: mocks.getExecutionMode,
  setSettings: vi.fn(),
}));
vi.mock('@/lib/persistence', () => ({ persistExecution: mocks.persistExecution }));
vi.mock('@/lib/logger', () => ({ default: { info: vi.fn(), warn: vi.fn() } }));

import { fetchClobBook } from '@/lib/polymarket-clob';
import { POST } from './route';

function clobResponse(tokenId: string, overrides: Record<string, unknown> = {}): Response {
  return new Response(JSON.stringify({
    asset_id: tokenId,
    bids: [],
    asks: [{ price: '0.40', size: '1' }],
    min_order_size: '1',
    tick_size: '0.01',
    ...overrides,
  }), { status: 200, headers: { 'content-type': 'application/json' } });
}

function executeRequest(tokenId: string): Request {
  return new Request('http://localhost/api/execute', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      action: 'execute',
      request: {
        arbId: `arb-${tokenId}`,
        marketTitle: 'One-share route regression',
        kalshiOrder: {
          platform: 'kalshi', marketId: 'kalshi-market', ticker: 'KXTEST',
          side: 'buy', outcome: 'yes', size: 0.4, contracts: 1, price: 0.4, orderType: 'limit',
        },
        polymarketOrder: {
          platform: 'polymarket', marketId: 'pm-market', conditionId: tokenId,
          side: 'buy', outcome: 'no', size: 0.4, contracts: 1, price: 0.4, orderType: 'limit',
        },
        estimatedProfit: 0.2,
        maxSlippagePct: 0,
        timeoutMs: 5_000,
        dryRun: false,
      },
    }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getExecutionMode.mockResolvedValue('live');
  mocks.getCredentialStatus.mockResolvedValue({ allReady: true });
  mocks.persistExecution.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('POST /api/execute live Polymarket pre-placement validation', () => {
  it('bypasses a cached quote and rejects a newly increased venue minimum before placement', async () => {
    const tokenId = 'route-fresh-min-token';
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(clobResponse(tokenId))
      .mockResolvedValueOnce(clobResponse(tokenId, {
        asks: [{ price: '0.50', size: '1' }],
        min_order_size: '5',
      }));
    vi.stubGlobal('fetch', fetchMock);

    expect((await fetchClobBook(tokenId))?.min_order_size).toBe('1');
    const response = await POST(executeRequest(tokenId) as never);

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: 'Polymarket minimum order is 5 shares; requested 1 share',
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(mocks.executeArb).not.toHaveBeenCalled();
  });

  it('rejects a book for a different token before placement', async () => {
    const tokenId = 'route-expected-token';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(clobResponse('route-wrong-token')));

    const response = await POST(executeRequest(tokenId) as never);

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: 'Polymarket order book token does not match requested token',
    });
    expect(mocks.executeArb).not.toHaveBeenCalled();
  });

  it('rejects malformed book arrays without throwing or placing orders', async () => {
    const tokenId = 'route-malformed-book-token';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(clobResponse(tokenId, { asks: {} })));

    const response = await POST(executeRequest(tokenId) as never);

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: 'Polymarket order book asks are malformed' });
    expect(mocks.executeArb).not.toHaveBeenCalled();
  });
});