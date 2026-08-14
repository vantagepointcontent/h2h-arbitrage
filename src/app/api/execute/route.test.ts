import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  executeArb: vi.fn(),
  getCredentialStatus: vi.fn(),
  getExecutionMode: vi.fn(),
  persistExecution: vi.fn(),
  loggerError: vi.fn(),
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
vi.mock('@/lib/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: mocks.loggerError },
  errorFingerprint: vi.fn(() => 'test-error'),
  fingerprintHash: vi.fn(() => 'test-hash'),
}));

import { fetchClobBook, fetchClobMarket } from '@/lib/polymarket-clob';
import { POST } from './route';

function clobResponse(tokenId: string, overrides: Record<string, unknown> = {}): Response {
  return new Response(JSON.stringify({
    asset_id: tokenId,
    bids: [],
    asks: [{ price: '0.40', size: '1' }],
    min_order_size: '1',
    tick_size: '0.01',
    timestamp: String(Date.now()),
    ...overrides,
  }), { status: 200, headers: { 'content-type': 'application/json' } });
}

function marketResponse(tokens: unknown[], conditionId = 'parent-condition'): Response {
  return new Response(JSON.stringify({
    condition_id: conditionId,
    tokens,
  }), { status: 200, headers: { 'content-type': 'application/json' } });
}

function binaryMarketResponse(yesTokenId = 'yes-token', noTokenId = 'no-token'): Response {
  return marketResponse([
    { token_id: yesTokenId, outcome: 'Yes' },
    { token_id: noTokenId, outcome: 'No' },
  ]);
}

function executeRequest(
  tokenId: string,
  outcome: 'yes' | 'no' = 'no',
  pmConditionId = 'parent-condition',
): Request {
  return new Request('http://localhost/api/execute', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      action: 'execute',
      request: {
        arbId: `arb-${tokenId}`,
        marketTitle: 'One-share route regression',
        pmConditionId,
        kalshiOrder: {
          platform: 'kalshi', marketId: 'kalshi-market', ticker: 'KXTEST',
          side: 'buy', outcome: 'yes', size: 0.4, contracts: 1, price: 0.4, orderType: 'limit',
        },
        polymarketOrder: {
          platform: 'polymarket', marketId: 'pm-market', conditionId: tokenId,
          side: 'buy', outcome, size: 0.4, contracts: 1, price: 0.4, orderType: 'limit',
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
  mocks.executeArb.mockResolvedValue({
    success: true,
    kalshiResult: { platform: 'kalshi', status: 'filled', timestamp: new Date().toISOString() },
    polymarketResult: { platform: 'polymarket', status: 'filled', timestamp: new Date().toISOString() },
    rollbackExecuted: false,
    unhedged: false,
    executionTimeMs: 1,
    alerts: [],
    steps: [],
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('POST /api/execute live Polymarket pre-placement validation', () => {
  it('bypasses a cached quote and rejects a newly increased venue minimum before placement', async () => {
    const tokenId = 'no-token';
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(clobResponse(tokenId))
      .mockResolvedValueOnce(binaryMarketResponse())
      .mockResolvedValueOnce(clobResponse(tokenId, {
        asks: [{ price: '0.50', size: '1' }],
        min_order_size: '5',
      }));
    vi.stubGlobal('fetch', fetchMock);

    expect((await fetchClobBook(tokenId))?.min_order_size).toBe('1');
    const response = await POST(executeRequest(tokenId) as never);

    expect(mocks.loggerError).not.toHaveBeenCalled();
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: 'Polymarket minimum order is 5 shares; requested 1 share',
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(mocks.executeArb).not.toHaveBeenCalled();
  });

  it('rejects a book for a different token before placement', async () => {
    const tokenId = 'no-token';
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(binaryMarketResponse())
      .mockResolvedValueOnce(clobResponse('route-wrong-token')));

    const response = await POST(executeRequest(tokenId) as never);

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: 'Polymarket order book token does not match requested token',
    });
    expect(mocks.executeArb).not.toHaveBeenCalled();
  });

  it('rejects malformed book arrays without throwing or placing orders', async () => {
    const tokenId = 'no-token';
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(binaryMarketResponse())
      .mockResolvedValueOnce(clobResponse(tokenId, { asks: {} })));

    const response = await POST(executeRequest(tokenId) as never);

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: 'Polymarket order book asks are malformed' });
    expect(mocks.executeArb).not.toHaveBeenCalled();
  });

  it.each([
    ['YES token submitted as NO', 'yes-token', 'no'],
    ['NO token submitted as YES', 'no-token', 'yes'],
  ] as const)('rejects %s before fetching a book or placing orders', async (_name, tokenId, outcome) => {
    const fetchMock = vi.fn().mockResolvedValue(binaryMarketResponse());
    vi.stubGlobal('fetch', fetchMock);

    const response = await POST(executeRequest(tokenId, outcome) as never);

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: `Polymarket ${outcome.toUpperCase()} token does not match the parent market`,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(mocks.executeArb).not.toHaveBeenCalled();
  });

  it.each([
    ['missing outcome mapping', [{ token_id: 'yes-token', outcome: 'Yes' }]],
    ['ambiguous outcome mapping', [
      { token_id: 'yes-token', outcome: 'Yes' },
      { token_id: 'no-token-a', outcome: 'No' },
      { token_id: 'no-token-b', outcome: 'No' },
    ]],
    ['same token for both outcomes', [
      { token_id: 'shared-token', outcome: 'Yes' },
      { token_id: 'shared-token', outcome: 'No' },
    ]],
  ])('rejects %s before placement', async (_name, tokens) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(marketResponse(tokens)));

    const response = await POST(executeRequest('no-token') as never);

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: 'Polymarket parent token mapping is invalid' });
    expect(mocks.executeArb).not.toHaveBeenCalled();
  });

  it('bypasses a cached parent mapping and rejects a newly changed outcome token', async () => {
    const conditionId = 'fresh-parent-condition';
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(marketResponse([
        { token_id: 'yes-token', outcome: 'Yes' },
        { token_id: 'no-token', outcome: 'No' },
      ], conditionId))
      .mockResolvedValueOnce(marketResponse([
        { token_id: 'yes-token', outcome: 'Yes' },
        { token_id: 'new-no-token', outcome: 'No' },
      ], conditionId));
    vi.stubGlobal('fetch', fetchMock);

    expect((await fetchClobMarket(conditionId))?.tokens[1]?.token_id).toBe('no-token');
    const response = await POST(executeRequest('no-token', 'no', conditionId) as never);

    expect(response.status).toBe(409);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(mocks.executeArb).not.toHaveBeenCalled();
  });

  it('rejects a missing parent condition ID without contacting CLOB or placing orders', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const response = await POST(executeRequest('no-token', 'no', '') as never);

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: 'Polymarket parent token mapping is invalid' });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.executeArb).not.toHaveBeenCalled();
  });

  it('places exactly once for a server-bound explicit NO token and shuffled fresh book', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(marketResponse([
        { token_id: 'no-token', outcome: 'No' },
        { token_id: 'yes-token', outcome: 'Yes' },
      ]))
      .mockResolvedValueOnce(clobResponse('no-token', {
        asks: [{ price: '0.60', size: '10' }, { price: '0.40', size: '1' }],
      })));

    const response = await POST(executeRequest('no-token') as never);

    expect(response.status).toBe(200);
    expect(mocks.executeArb).toHaveBeenCalledTimes(1);
    expect(mocks.executeArb).toHaveBeenCalledWith(expect.objectContaining({
      pmConditionId: 'parent-condition',
      polymarketOrder: expect.objectContaining({
        conditionId: 'no-token', outcome: 'no', contracts: 1, minimumOrderSize: 1, tickSize: 0.01,
      }),
    }));
  });

  it.each([
    ['missing', undefined, 'Polymarket order book timestamp is unavailable'],
    ['malformed', 'not-a-timestamp', 'Polymarket order book timestamp is malformed'],
    ['stale', '0', 'Polymarket order book is stale'],
    ['future-invalid', String(Date.now() + 60_000), 'Polymarket order book timestamp is in the future'],
  ])('rejects a %s book timestamp before placement', async (_name, timestamp, error) => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(binaryMarketResponse())
      .mockResolvedValueOnce(clobResponse('no-token', { timestamp })));

    const response = await POST(executeRequest('no-token') as never);

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error });
    expect(mocks.executeArb).not.toHaveBeenCalled();
  });
});