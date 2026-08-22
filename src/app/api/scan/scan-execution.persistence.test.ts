import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import fs from 'node:fs';

const state = vi.hoisted(() => {
  const tempDir = `/tmp/bug182-scan-persistence-${process.pid}`;
  process.env.H2H_SQLITE_PATH = `${tempDir}/edgefinder.db`;
  process.env.H2H_SAVED_MARKETS_FILE = `${tempDir}/saved-markets.json`;
  return {
    tempDir,
    fetchClobMarkets: vi.fn(),
    getClobPrices: vi.fn(),
    getClobAskDepths: vi.fn(),
    calculateAllArbitrages: vi.fn(),
  };
});

vi.mock('@/lib/kalshi', () => ({
  extractKalshiEventTicker: () => 'KXBUG182',
  extractKalshiSeriesFromUrl: () => null,
  extractKalshiMatchKey: () => null,
  filterKalshiMarketsToMatch: (markets: unknown[]) => markets,
  fetchKalshiEventMarkets: vi.fn(async () => [
    { ticker: 'KXBUG182-YES', title: 'Will BUG-182 occur?', yes_ask: 40, no_ask: 60 },
  ]),
  fetchKalshiSeriesMarkets: vi.fn(async () => []),
  fetchKalshiMultiSeriesMarkets: vi.fn(async () => ({ markets: [], seriesFetched: [] })),
}));
vi.mock('@/lib/polymarket', () => ({
  extractPolymarketSlug: () => 'bug-182',
  fetchPolymarketEvent: vi.fn(async () => ({
    id: 'pm-event', title: 'BUG-182', active: true, endDate: '2026-11-28T00:00:00.000Z',
    markets: [{ id: 'pm-yes', conditionId: 'pm-condition', question: 'Will BUG-182 occur?', outcomePrices: '[0.4,0.6]' }],
  })),
  fetchPolymarketMarketAsEvent: vi.fn(),
  isPolymarketMarketUrl: () => false,
  parseOutcomePrices: () => [0.4, 0.6],
}));
vi.mock('@/lib/polymarket-clob', () => ({
  fetchClobMarkets: state.fetchClobMarkets,
  getClobPrices: state.getClobPrices,
  getClobAskDepths: state.getClobAskDepths,
}));
vi.mock('@/lib/matcher', () => ({
  buildKalshiArbShape: vi.fn(),
  matchOutcomes: () => [{
    artist: 'Yes',
    kalshi: { ticker: 'KXBUG182-YES' },
    polymarket: { conditionId: 'pm-condition' },
  }],
  calculateAllArbitrages: state.calculateAllArbitrages,
  attachOutcomeContingentApy: (outcomes: unknown[]) => outcomes,
  parseDepth: vi.fn(),
  applyManualMatches: (outcomes: unknown[]) => outcomes,
  setSuspiciousRoiPct: vi.fn(),
}));
vi.mock('@/lib/settings', () => ({ getSetting: vi.fn(async () => null) }));
vi.mock('@/lib/kalshi-fee-quote', () => ({ resolveKalshiFeeAuthoritiesForMarkets: vi.fn(async () => undefined) }));
vi.mock('@/lib/manual-matches', () => ({ getManualMatches: vi.fn(async () => []) }));
vi.mock('@/lib/decoupled-pairs', () => ({
  getDecoupledPairs: vi.fn(async () => []),
  applyDecoupledPairs: (outcomes: unknown[]) => outcomes,
}));
vi.mock('@/lib/bot-scan-consumer', () => ({ persistAndConsumeBotScan: vi.fn(async () => undefined) }));
vi.mock('@/lib/arb-lifecycle', () => ({ recordArbObservations: vi.fn(async () => ({ opened: 0, extended: 0, closed: 0 })) }));
vi.mock('@/lib/telegram-alerts', () => ({ sendBatchAlerts: vi.fn(async () => undefined) }));
vi.mock('@/lib/saved-market-scan-lock', () => ({
  acquireSavedMarketScanLock: vi.fn(async () => ({
    status: 'acquired', lock: { path: '/tmp/bug182-lock', ownerPid: 1, ownerToken: 'test' },
  })),
  releaseSavedMarketScanLock: vi.fn(async () => undefined),
}));
vi.mock('@/lib/scan-shared', () => ({
  withTimeout: (promise: Promise<unknown>) => promise,
  chooseBestPmStructure: (markets: unknown[]) => markets,
}));
vi.mock('@/app/lib/page-shared', () => ({ computePriceResolved: () => false }));
vi.mock('@/lib/scan-links', () => ({
  resolveScanLinks: () => ({
    platformLinks: {},
    kalshiUrl: 'https://kalshi.com/markets/bug-182/bug-182/KXBUG182',
    polymarketUrl: 'https://polymarket.com/event/bug-182',
  }),
  getUnavailableScanPlatforms: () => [],
}));
vi.mock('@/lib/scan-request', () => ({ parseScanCapital: () => 1000 }));
vi.mock('@/lib/scan-clob-selection', () => ({ selectMatchedClobConditionIds: () => ['pm-condition'] }));
vi.mock('@/lib/current-price-snapshots', () => ({
  persistPlatformPriceSnapshots: vi.fn(async () => undefined),
  snapshotInputsFromOutcomes: vi.fn(() => []),
}));

import { executeFullScan } from './scan-execution';
import * as persistence from '@/lib/persistence';

function request(): NextRequest {
  return new NextRequest('http://localhost/api/scan', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ capital: 1000 }),
  });
}

let marketId = '';
let canonicalRevision = 0;
const canonicalRoiPct = 2;
const canonicalProfit = 1;
const canonicalDaysToExpiry = 100;
const canonicalApyPct = (Math.pow(1 + canonicalRoiPct / 100, 365 / canonicalDaysToExpiry) - 1) * 100;

beforeAll(async () => {
  fs.rmSync(state.tempDir, { recursive: true, force: true });
  fs.mkdirSync(state.tempDir, { recursive: true });
  const market = await persistence.addSavedMarket({
    kalshiUrl: 'https://kalshi.com/markets/bug-182/bug-182/KXBUG182',
    polymarketUrl: 'https://polymarket.com/event/bug-182',
    eventTitle: 'BUG-182',
    expiryDate: '2026-11-28T00:00:00.000Z',
  });
  marketId = market.id;
  canonicalRevision = await persistence.reserveSavedMarketPublication(market.id, 'scan');
  await persistence.updateSavedMarketScanResult(market.id, {
    bestRoiPct: canonicalRoiPct,
    bestProfit: canonicalProfit,
    strategy: 'Buy YES Kalshi + NO PM',
    arbType: 'direct',
    outcomeCount: 1,
    matchedCount: 1,
    matchStatus: 'matched',
    kalshiCount: 1,
    pmCount: 1,
    scannedAt: '2026-08-20T13:00:00.000Z',
    publicationGeneration: canonicalRevision,
    allArbs: [{
      artist: 'Yes', roiPct: canonicalRoiPct, expectedProfit: canonicalProfit,
      strategy: 'Buy YES Kalshi + NO PM', arbType: 'direct', totalStake: 99,
      executionStatus: 'executable', apyPct: canonicalApyPct,
      daysToExpiry: canonicalDaysToExpiry, expiryAt: '2026-11-28T00:00:00.000Z',
    }],
  });
});

afterAll(() => {
  delete process.env.H2H_SQLITE_PATH;
  delete process.env.H2H_SAVED_MARKETS_FILE;
  fs.rmSync(state.tempDir, { recursive: true, force: true });
});

beforeEach(() => {
  vi.clearAllMocks();
  state.fetchClobMarkets.mockResolvedValue(new Map([['pm-condition', {
    condition_id: 'pm-condition', tokens: [{ outcome: 'Yes', price: 0.4 }, { outcome: 'No', price: 0.6 }],
  }]]));
  state.getClobPrices.mockResolvedValue({
    yesPrice: 0.4, noPrice: 0.6, bestBid: 0.39, bestAsk: 0.4, lastTradePrice: 0.4,
  });
  state.getClobAskDepths.mockResolvedValue({
    yesAskDepth: 500, noAskDepth: 500, yesBid: 0.39, noBid: 0.59,
    yesBidDepth: 500, noBidDepth: 500,
    yesMinOrderSize: 1, noMinOrderSize: 1, yesTickSize: 0.01, noTickSize: 0.01,
  });
  state.calculateAllArbitrages.mockReturnValue([]);
});

async function expectCanonicalRevisionPreserved(reasonCode: string) {
  const response = await executeFullScan(request());
  expect(response.status).toBe(503);
  expect(await response.json()).toMatchObject({ reasonCode, fullScanPersisted: false });
  expect(await persistence.getSavedMarketById(marketId)).toMatchObject({
    canonicalCurrentRoiPct: canonicalRoiPct,
    canonicalCurrentProfit: canonicalProfit,
    canonicalCurrentRevision: canonicalRevision,
    canonicalApyPct,
    canonicalApyRevision: canonicalRevision,
    lastScanResult: {
      matchStatus: 'unavailable',
      matchError: expect.stringContaining(reasonCode),
      scannedAt: '2026-08-20T13:00:00.000Z',
    },
  });
}

describe('BUG-182 real scan to persistence fencing', () => {
  it('preserves the seeded canonical revision when CLOB metadata fails', async () => {
    state.fetchClobMarkets.mockRejectedValueOnce(new Error('metadata timeout'));
    await expectCanonicalRevisionPreserved('clob_metadata_unavailable');
  });

  it('preserves the seeded canonical revision when selected CLOB metadata is partial', async () => {
    state.fetchClobMarkets.mockResolvedValueOnce(new Map());
    await expectCanonicalRevisionPreserved('clob_metadata_incomplete');
  });

  it('preserves the seeded canonical revision when a selected CLOB book fails', async () => {
    state.getClobPrices.mockRejectedValueOnce(new Error('book timeout'));
    await expectCanonicalRevisionPreserved('clob_book_unavailable');
  });

  it('preserves the seeded canonical revision when a selected CLOB book is empty', async () => {
    state.getClobPrices.mockResolvedValueOnce(null);
    await expectCanonicalRevisionPreserved('clob_book_empty');
  });

  it('preserves the seeded canonical revision when every selected candidate is non-executable', async () => {
    state.calculateAllArbitrages.mockReturnValue([{
      artist: 'Indicative only',
      kalshi: { ticker: 'KXBUG182-YES', yesAsk: 0.4, noAsk: 0.6, yesAskDepth: 0, noAskDepth: 0 },
      polymarket: { conditionId: 'pm-condition', yesPrice: 0.42, noPrice: 0.58, askDepth: 0, noAskDepth: 0 },
      arbitrage: {
        roiPct: 12.5, expectedProfit: 0, strategy: 'Buy YES Kalshi + NO PM', arbType: 'direct',
        kalshiStake: 0, pmStake: 0, executionStatus: 'non_executable',
        executionBlocker: 'Captured direct legs cannot fill one share',
      },
    }]);
    await expectCanonicalRevisionPreserved('executable_candidate_unavailable');
  });
});


