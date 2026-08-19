// WS-107: watcher-written liveResult — persistence + TTL fallback tests.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';

// Run against an isolated temp DB (persistence.ts resolves data/edgefinder.db
// from process.cwd()).
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws107-'));
const origCwd = process.cwd();

let persistence: typeof import('./persistence');

beforeAll(async () => {
  fs.mkdirSync(path.join(tmpDir, 'data'), { recursive: true });
  process.chdir(tmpDir);
  vi.resetModules();
  persistence = await import('./persistence');
});

afterAll(() => {
  process.chdir(origCwd);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeScan(overrides: Partial<import('./persistence').LastScanResult> = {}) {
  return {
    bestRoiPct: 5.5,
    bestProfit: 55,
    strategy: 'Buy YES Kalshi + NO PM',
    outcomeCount: 4,
    matchedCount: 3,
    kalshiCount: 4,
    pmCount: 4,
    scannedAt: new Date().toISOString(),
    allArbs: [{ artist: 'A', roiPct: 5.5, expectedProfit: 55, strategy: 'Buy YES Kalshi + NO PM' }],
    ...overrides,
  };
}

describe('WS-107 liveResult persistence', () => {
  it('uses the safe TTL when the live-result environment value is invalid', () => {
    expect(persistence.parseLiveResultTtlMs('not-a-duration')).toBe(10 * 60_000);
    expect(persistence.parseLiveResultTtlMs('0')).toBe(10 * 60_000);
    expect(persistence.parseLiveResultTtlMs('-1')).toBe(10 * 60_000);
    expect(persistence.parseLiveResultTtlMs('300000')).toBe(300000);
  });

  it('migrates legacy two-platform URLs into platformLinks without losing them', async () => {
    const m = await persistence.addSavedMarket({
      kalshiUrl: 'https://kalshi.com/markets/KXTEST',
      polymarketUrl: 'https://polymarket.com/event/test-market',
      eventTitle: 'Platform link migration', category: '', expiryDate: null,
    });

    const got = (await persistence.getSavedMarkets()).find((x) => x.id === m.id)!;
    expect((got as any).platformLinks).toEqual([
      { platform: 'kalshi', url: 'https://kalshi.com/markets/KXTEST' },
      { platform: 'polymarket', url: 'https://polymarket.com/event/test-market' },
    ]);
  });

  it('writes and reads back a fresh liveResult', async () => {
    const m = await persistence.addSavedMarket({
      kalshiUrl: 'https://kalshi.com/markets/x', polymarketUrl: 'https://polymarket.com/event/x',
      eventTitle: 'Test market', category: 'Politics', expiryDate: null,
    });
    await persistence.updateSavedMarketLiveResult(m.id, makeScan());
    const markets = await persistence.getSavedMarkets();
    const got = markets.find((x) => x.id === m.id)!;
    expect(got.liveResult).toBeTruthy();
    expect(got.liveResult!.bestRoiPct).toBe(5.5);
    expect(got.liveResult!.strategy).toBe('Buy YES Kalshi + NO PM');
    expect(got.liveResult!.allArbs).toHaveLength(1);
    expect(got.liveResult!.allArbs![0].calculationEnvelope).toMatchObject({
      status: 'legacy_unverifiable',
      totals: { totalFeesMicros: null, netPnlMicros: null },
    });
    expect(got.liveResult!.calculationEnvelope).toMatchObject({
      status: 'legacy_unverifiable',
      totals: { totalFeesMicros: null, netPnlMicros: null },
    });
  });

  it('invalidates legacy Internal results before saved-market persistence', async () => {
    const m = await persistence.addSavedMarket({
      kalshiUrl: 'https://kalshi.com/markets/legacy', polymarketUrl: 'https://polymarket.com/event/legacy',
      eventTitle: 'Legacy internal', category: 'Politics', expiryDate: null,
    });
    await persistence.updateSavedMarketScanResult(m.id, makeScan({
      strategy: 'Same-platform YES+YES Kalshi: A + B',
      arbType: 'internal', bestRoiPct: 12, bestProfit: 12,
      allArbs: [{
        artist: 'A', roiPct: 12, expectedProfit: 12,
        strategy: 'Same-platform YES+YES Kalshi: A + B', arbType: 'internal',
      }],
    }));

    const got = (await persistence.getSavedMarkets()).find((x) => x.id === m.id)!;
    expect(got.lastScanResult).toMatchObject({
      strategy: 'No arb', arbType: null, bestRoiPct: 0, bestProfit: 0, allArbs: [],
    });
  });

  it('liveResult write does not touch lastScanResult', async () => {
    const m = await persistence.addSavedMarket({
      kalshiUrl: 'https://kalshi.com/markets/y', polymarketUrl: 'https://polymarket.com/event/y',
      eventTitle: 'Test 2', category: '', expiryDate: null,
    });
    await persistence.updateSavedMarketScanResult(m.id, makeScan({ bestRoiPct: 1.1 }));
    await persistence.updateSavedMarketLiveResult(m.id, makeScan({ bestRoiPct: 9.9 }));
    const got = (await persistence.getSavedMarkets()).find((x) => x.id === m.id)!;
    expect(got.lastScanResult!.bestRoiPct).toBe(1.1);
    expect(got.liveResult!.bestRoiPct).toBe(9.9);
  });

  it('stale liveResult (older than TTL) is dropped on read → poller fallback', async () => {
    const m = await persistence.addSavedMarket({
      kalshiUrl: 'https://kalshi.com/markets/z', polymarketUrl: 'https://polymarket.com/event/z',
      eventTitle: 'Test 3', category: '', expiryDate: null,
    });
    const staleTs = new Date(Date.now() - persistence.LIVE_RESULT_TTL_MS - 60_000).toISOString();
    await persistence.updateSavedMarketLiveResult(m.id, makeScan({ scannedAt: staleTs }));
    const got = (await persistence.getSavedMarkets()).find((x) => x.id === m.id)!;
    expect(got.liveResult).toBeNull();
  });

  it('liveResult with missing/garbage scannedAt is dropped', async () => {
    const m = await persistence.addSavedMarket({
      kalshiUrl: 'https://kalshi.com/markets/w', polymarketUrl: 'https://polymarket.com/event/w',
      eventTitle: 'Test 4', category: '', expiryDate: null,
    });
    await persistence.updateSavedMarketLiveResult(m.id, makeScan({ scannedAt: 'not-a-date' }));
    const got = (await persistence.getSavedMarkets()).find((x) => x.id === m.id)!;
    expect(got.liveResult).toBeNull();
  });

  it('clearSavedMarketLiveResult removes the live view', async () => {
    const m = await persistence.addSavedMarket({
      kalshiUrl: 'https://kalshi.com/markets/v', polymarketUrl: 'https://polymarket.com/event/v',
      eventTitle: 'Test 5', category: '', expiryDate: null,
    });
    await persistence.updateSavedMarketLiveResult(m.id, makeScan());
    // Seed the in-process saved-markets cache before the clear. The clear
    // must invalidate it just like every other saved-market write.
    expect((await persistence.getSavedMarkets()).find((x) => x.id === m.id)!.liveResult).toBeTruthy();
    await persistence.clearSavedMarketLiveResult(m.id);
    const got = (await persistence.getSavedMarkets()).find((x) => x.id === m.id)!;
    expect(got.liveResult).toBeNull();
  });

  it('liveResult updates last_matched_at when matchedCount > 0', async () => {
    const m = await persistence.addSavedMarket({
      kalshiUrl: 'https://kalshi.com/markets/u', polymarketUrl: 'https://polymarket.com/event/u',
      eventTitle: 'Test 6', category: '', expiryDate: null,
    });
    await persistence.updateSavedMarketLiveResult(m.id, makeScan({ matchedCount: 2 }));
    const got = (await persistence.getSavedMarkets()).find((x) => x.id === m.id)!;
    expect(got.lastMatchedAt).toBeTruthy();
  });

  it('persists concurrent canonical scan publications without transaction commit exhaustion', async () => {
    const markets = await Promise.all(Array.from({ length: 12 }, async (_, index) => persistence.addSavedMarket({
      kalshiUrl: `https://kalshi.com/markets/concurrent-${index}`,
      polymarketUrl: `https://polymarket.com/event/concurrent-${index}`,
      eventTitle: `Concurrent publication ${index}`,
      category: '',
      expiryDate: null,
    })));

    await expect(Promise.all(markets.map(async (market, index) => {
      const generation = await persistence.reserveSavedMarketPublication(market.id, 'scan');
      return persistence.updateSavedMarketScanResult(market.id, makeScan({
        bestRoiPct: index,
        publicationGeneration: generation,
        matchedCount: 0,
        matchedPairs: [],
        matchStatus: 'confirmed_zero',
        allArbs: [],
      }));
    }))).resolves.toEqual(Array(12).fill(true));
  });

  it('does not let an older completed scan overwrite a newer canonical match summary', async () => {
    const m = await persistence.addSavedMarket({
      kalshiUrl: 'https://kalshi.com/markets/order', polymarketUrl: 'https://polymarket.com/event/order',
      eventTitle: 'Ordering test', category: '', expiryDate: null,
    });
    const newer = makeScan({
      scannedAt: '2026-08-12T19:12:45.296Z', matchedCount: 2, matchStatus: 'matched',
    });
    const older = makeScan({
      scannedAt: '2026-08-12T19:11:45.296Z', matchedCount: 0,
      matchStatus: 'confirmed_zero', allArbs: [],
    });

    await persistence.updateSavedMarketScanResult(m.id, newer);
    await persistence.updateSavedMarketScanResult(m.id, older);

    const got = (await persistence.getSavedMarkets()).find((x) => x.id === m.id)!;
    expect(got.lastScanResult).toMatchObject({
      scannedAt: newer.scannedAt, matchedCount: 2, matchStatus: 'matched',
    });
  });

  it('retains the latest confirmed matches when a temporary unavailable result arrives', async () => {
    const m = await persistence.addSavedMarket({
      kalshiUrl: 'https://kalshi.com/markets/failure', polymarketUrl: 'https://polymarket.com/event/failure',
      eventTitle: 'Failure retention', category: '', expiryDate: null,
    });
    await persistence.updateSavedMarketScanResult(m.id, makeScan({
      scannedAt: '2026-08-12T19:12:45.296Z', matchedCount: 2, matchStatus: 'matched',
    }));

    await persistence.updateSavedMarketScanResult(m.id, makeScan({
      scannedAt: '2026-08-12T19:13:45.296Z', matchedCount: 0,
      matchStatus: 'unavailable', matchError: 'Polymarket unavailable', allArbs: [],
    }));

    const got = (await persistence.getSavedMarkets()).find((x) => x.id === m.id)!;
    expect(got.lastScanResult).toMatchObject({
      scannedAt: '2026-08-12T19:12:45.296Z',
      matchedCount: 2, matchStatus: 'unavailable', matchError: 'Polymarket unavailable',
    });
  });

  it('orders equal timestamps by authority so temporary failures cannot replace completed results', async () => {
    const scannedAt = '2026-08-12T19:14:45.296Z';
    const unavailable = makeScan({ scannedAt, matchedCount: 0, matchStatus: 'unavailable', matchError: 'slow', allArbs: [] });
    const matched = makeScan({ scannedAt, matchedCount: 2, matchStatus: 'matched' });
    const makeMarket = (suffix: string) => persistence.addSavedMarket({
      kalshiUrl: `https://kalshi.com/markets/${suffix}`, polymarketUrl: `https://polymarket.com/event/${suffix}`,
      eventTitle: `Equal ordering ${suffix}`, category: '', expiryDate: null,
    });

    const first = await makeMarket('equal-order');
    await persistence.updateSavedMarketScanResult(first.id, matched);
    await persistence.updateSavedMarketScanResult(first.id, unavailable);
    expect((await persistence.getSavedMarketById(first.id))?.lastScanResult).toMatchObject({ matchStatus: 'matched', matchedCount: 2 });

    const second = await makeMarket('equal-order-reverse');
    await persistence.updateSavedMarketScanResult(second.id, unavailable);
    await persistence.updateSavedMarketScanResult(second.id, matched);
    expect((await persistence.getSavedMarketById(second.id))?.lastScanResult).toMatchObject({ matchStatus: 'matched', matchedCount: 2 });
  });

  it.each(['scan', 'live'] as const)(
    'uses producer-reserved generations to order equal-timestamp completed %s results in both arrival orders',
    async (channel) => {
      const scannedAt = new Date().toISOString();
      const publish = channel === 'scan'
        ? persistence.updateSavedMarketScanResult
        : persistence.updateSavedMarketLiveResult;
      const resultFor = (generation: number, status: 'matched' | 'confirmed_zero') => makeScan({
        scannedAt,
        publicationGeneration: generation,
        matchedCount: status === 'matched' ? 1 : 0,
        matchStatus: status,
        matchedPairs: status === 'matched'
          ? [{ artist: 'Democratic', kalshiTicker: 'EQUAL-D', pmConditionId: 'equal-d' }]
          : [],
        allArbs: [],
      });
      const read = async (id: string) => {
        const market = await persistence.getSavedMarketById(id);
        return channel === 'scan' ? market?.lastScanResult : market?.liveResult;
      };

      for (const arrivalOrder of ['newer-first', 'older-first'] as const) {
        const suffix = `${channel}-${arrivalOrder}`;
        const market = await persistence.addSavedMarket({
          kalshiUrl: `https://kalshi.com/markets/${suffix}`,
          polymarketUrl: `https://polymarket.com/event/${suffix}`,
          eventTitle: `Completed ordering ${suffix}`,
          category: '',
          expiryDate: null,
        });
        const olderGeneration = await persistence.reserveSavedMarketPublication(market.id, channel);
        const newerGeneration = await persistence.reserveSavedMarketPublication(market.id, channel);
        const older = resultFor(olderGeneration, 'confirmed_zero');
        const newer = resultFor(newerGeneration, 'matched');

        if (arrivalOrder === 'newer-first') {
          await publish(market.id, newer);
          await publish(market.id, older);
        } else {
          await publish(market.id, older);
          await publish(market.id, newer);
        }

        expect(await read(market.id)).toMatchObject({
          publicationGeneration: newerGeneration,
          matchStatus: 'matched',
          matchedCount: 1,
        });
      }
    },
  );

  it('fences a stale response after a newer manual coupling deletion summary', async () => {
    const m = await persistence.addSavedMarket({
      kalshiUrl: 'https://kalshi.com/markets/manual-delete', polymarketUrl: 'https://polymarket.com/event/manual-delete',
      eventTitle: 'Manual deletion ordering', category: '', expiryDate: null,
    });
    await persistence.reconcileSavedMarketMatchSummary(m.id, {
      scannedAt: '2026-08-12T19:50:14.096Z', matchedCount: 1, matchStatus: 'matched',
      matchedPairs: [{ artist: 'Democratic', kalshiTicker: 'TX07-D', pmConditionId: 'pm-d' }],
    });
    await persistence.reconcileSavedMarketMatchSummary(m.id, {
      scannedAt: '2026-08-12T19:49:14.096Z', matchedCount: 2, matchStatus: 'matched',
      matchedPairs: [
        { artist: 'Democratic', kalshiTicker: 'TX07-D', pmConditionId: 'pm-d' },
        { artist: 'Republican', kalshiTicker: 'TX07-R', pmConditionId: 'pm-r' },
      ],
    });

    const got = (await persistence.getSavedMarkets()).find((x) => x.id === m.id)!;
    expect(got.lastScanResult).toMatchObject({
      matchedCount: 1, matchStatus: 'matched',
      matchedPairs: [{ artist: 'Democratic', kalshiTicker: 'TX07-D', pmConditionId: 'pm-d' }],
    });
  });

  it('does not let an older live watcher result overwrite a newer live match summary', async () => {
    const m = await persistence.addSavedMarket({
      kalshiUrl: 'https://kalshi.com/markets/live-order', polymarketUrl: 'https://polymarket.com/event/live-order',
      eventTitle: 'Live ordering test', category: '', expiryDate: null,
    });
    await persistence.updateSavedMarketLiveResult(m.id, makeScan({
      scannedAt: new Date().toISOString(), matchedCount: 2, matchStatus: 'matched',
    }));
    await persistence.updateSavedMarketLiveResult(m.id, makeScan({
      scannedAt: new Date(Date.now() - 60_000).toISOString(), matchedCount: 0,
      matchStatus: 'confirmed_zero', allArbs: [],
    }));

    const got = (await persistence.getSavedMarkets()).find((x) => x.id === m.id)!;
    expect(got.liveResult).toMatchObject({ matchedCount: 2, matchStatus: 'matched' });
  });

  it('does not clear a valid live match summary on temporary watcher unavailability', async () => {
    const fixtureId = `live-failure-${process.pid}-${Date.now()}`;
    const m = await persistence.addSavedMarket({
      kalshiUrl: `https://kalshi.com/markets/${fixtureId}`, polymarketUrl: `https://polymarket.com/event/${fixtureId}`,
      eventTitle: `Live failure retention ${fixtureId}`, category: '', expiryDate: null,
    });
    const secondScannedAtMs = Date.now();
    await persistence.updateSavedMarketLiveResult(m.id, makeScan({
      scannedAt: new Date(secondScannedAtMs - 1_000).toISOString(), matchedCount: 2, matchStatus: 'matched',
    }));
    await persistence.updateSavedMarketLiveResult(m.id, makeScan({
      scannedAt: new Date(secondScannedAtMs).toISOString(), matchedCount: 0,
      matchStatus: 'unavailable', matchError: 'Kalshi unavailable', allArbs: [],
    }));

    const got = (await persistence.getSavedMarkets()).find((x) => x.id === m.id)!;
    expect(got.liveResult).toMatchObject({
      matchedCount: 2, matchStatus: 'unavailable', matchError: 'Kalshi unavailable',
    });
  });
});
