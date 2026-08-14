import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  upstream: vi.fn(),
  findSavedMarketByUrls: vi.fn(),
  reserveSavedMarketPublication: vi.fn(),
  reconcileSavedMarketMatchSummary: vi.fn(),
}));

vi.mock('@/lib/kalshi', () => ({
  extractKalshiEventTicker: () => 'KXTX07',
  extractKalshiSeriesFromUrl: () => null,
  extractKalshiMatchKey: () => null,
  filterKalshiMarketsToMatch: (markets: unknown[]) => markets,
  fetchKalshiEventMarkets: mocks.upstream,
  fetchKalshiSeriesMarkets: vi.fn(async () => []),
  fetchKalshiMultiSeriesMarkets: vi.fn(async () => ({ markets: [], seriesFetched: [] })),
}));
vi.mock('@/lib/polymarket', () => ({
  extractPolymarketSlug: () => 'tx-07',
  fetchPolymarketEvent: vi.fn(async () => ({ id: 'pm-event', title: 'TX-07', markets: [], active: true })),
  fetchPolymarketMarketAsEvent: vi.fn(),
  isPolymarketMarketUrl: () => false,
  parseOutcomePrices: () => [0, 0],
}));
vi.mock('@/lib/polymarket-clob', () => ({
  fetchClobMarkets: vi.fn(async () => new Map()),
  getClobAskDepths: vi.fn(),
  getClobPrices: vi.fn(),
}));
vi.mock('@/lib/matcher', () => ({
  buildKalshiArbShape: vi.fn(),
  matchOutcomes: () => [],
  calculateAllArbitrages: () => [],
  parseDepth: vi.fn(),
  computeApy: () => 0,
  applyManualMatches: (outcomes: unknown[]) => outcomes,
  setSuspiciousRoiPct: vi.fn(),
}));
vi.mock('@/lib/settings', () => ({ getSetting: vi.fn(async () => null) }));
vi.mock('@/lib/manual-matches', () => ({ getManualMatches: vi.fn(async () => []) }));
vi.mock('@/lib/decoupled-pairs', () => ({
  getDecoupledPairs: vi.fn(async () => []),
  applyDecoupledPairs: (outcomes: unknown[]) => outcomes,
}));
vi.mock('@/lib/persistence', () => ({
  findSavedMarketByUrls: mocks.findSavedMarketByUrls,
  reserveSavedMarketPublication: mocks.reserveSavedMarketPublication,
  reconcileSavedMarketMatchSummary: mocks.reconcileSavedMarketMatchSummary,
  updateSavedMarketScanResult: vi.fn(async () => undefined),
  appendScanHistory: vi.fn(async () => undefined),
}));
vi.mock('@/lib/bot-scan-consumer', () => ({ persistAndConsumeBotScan: vi.fn(async () => undefined) }));
vi.mock('@/lib/arb-lifecycle', () => ({ recordArbObservations: vi.fn(async () => ({ opened: 0, extended: 0, closed: 0 })) }));
vi.mock('@/lib/telegram-alerts', () => ({ sendBatchAlerts: vi.fn(async () => undefined) }));
vi.mock('@/lib/scan-shared', () => ({
  withTimeout: (promise: Promise<unknown>) => promise,
  chooseBestPmStructure: (markets: unknown[]) => markets,
}));
vi.mock('@/app/lib/page-shared', () => ({ computePriceResolved: () => false }));
vi.mock('@/lib/scan-links', () => ({
  resolveScanLinks: () => ({
    platformLinks: {},
    kalshiUrl: 'https://kalshi.com/markets/tx/tx/KXTX07',
    polymarketUrl: 'https://polymarket.com/event/tx-07',
  }),
  getUnavailableScanPlatforms: () => [],
}));
vi.mock('@/lib/scan-request', () => ({ parseScanCapital: () => 1000 }));
vi.mock('@/lib/scan-clob-selection', () => ({ selectMatchedClobConditionIds: () => [] }));

import { executeFullScan } from './scan-execution';

function request(): NextRequest {
  return new NextRequest('http://localhost/api/scan', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ capital: 1000 }),
  });
}

describe('POST /api/scan saved-market lifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findSavedMarketByUrls.mockResolvedValue({ id: 'tx-07', eventTitle: 'TX-07' });
    mocks.reserveSavedMarketPublication.mockResolvedValue(41);
    mocks.reconcileSavedMarketMatchSummary.mockResolvedValue(undefined);
  });

  it('publishes refreshing before waiting for upstream market data', async () => {
    let rejectUpstream!: (error: Error) => void;
    mocks.upstream.mockImplementation(() => new Promise((_resolve, reject) => { rejectUpstream = reject; }));

    const pending = executeFullScan(request());
    await vi.waitFor(() => {
      expect(mocks.reconcileSavedMarketMatchSummary).toHaveBeenCalledWith('tx-07', {
        matchedCount: 0,
        matchStatus: 'refreshing',
        matchError: undefined,
        matchedPairs: undefined,
        scannedAt: expect.any(String),
        publicationGeneration: 41,
      });
    });

    rejectUpstream(new Error('Kalshi upstream timed out'));
    await pending;
  });

  it('publishes unavailable with the reserved generation after terminal upstream failure', async () => {
    mocks.upstream.mockRejectedValue(new Error('Kalshi upstream timed out'));

    const response = await executeFullScan(request());
    const body = await response.json();

    expect(response.status).toBeGreaterThanOrEqual(500);
    expect(mocks.reconcileSavedMarketMatchSummary).toHaveBeenLastCalledWith('tx-07', {
      matchedCount: 0,
      matchStatus: 'unavailable',
      matchError: body.error,
      matchedPairs: undefined,
      scannedAt: expect.any(String),
      publicationGeneration: 41,
    });
  });

  it('cannot let an older failed scan overwrite a newer generation', async () => {
    let currentGeneration = 41;
    const accepted: string[] = [];
    mocks.reconcileSavedMarketMatchSummary.mockImplementation(async (_id, summary) => {
      if (summary.publicationGeneration === currentGeneration) accepted.push(summary.matchStatus);
    });
    mocks.upstream.mockImplementation(async () => {
      currentGeneration = 42;
      throw new Error('Kalshi upstream timed out');
    });

    await executeFullScan(request());

    expect(accepted).toEqual(['refreshing']);
    expect(mocks.reconcileSavedMarketMatchSummary).toHaveBeenLastCalledWith(
      'tx-07',
      expect.objectContaining({ matchStatus: 'unavailable', publicationGeneration: 41 }),
    );
  });
});
