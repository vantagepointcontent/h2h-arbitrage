import { describe, expect, it } from 'vitest';
import {
  buildScanLinkPayload,
  createQuickPricesRequestOwner,
  createSavedMarketHydrationOwner,
  mergeQuickPricesResult,
  restoreSavedMarketPopNavigation,
} from './lib/page-shared';

type RefreshState = { loading: boolean; bgRefreshing: boolean };

type SavedMarketViewState = RefreshState & {
  activeMarketId: string | null;
  detailMarketId: string | null;
  sidebarMarketIds: string[];
  historyMarketIds: string[];
};

function createRefreshHarness() {
  const owner = createQuickPricesRequestOwner();
  const state: RefreshState = { loading: false, bgRefreshing: false };
  const setMode = (mode: 'foreground' | 'background' | null, active: boolean) => {
    if (mode === 'foreground') state.loading = active;
    if (mode === 'background') state.bgRefreshing = active;
  };

  return {
    owner,
    state,
    begin(marketId: string, mode: 'foreground' | 'background') {
      const request = owner.begin(marketId, mode);
      setMode(request.displacedMode, false);
      setMode(mode, true);
      return request;
    },
    finish(request: ReturnType<typeof owner.begin>) {
      if (owner.finish(request)) setMode(request.mode, false);
    },
    cancel() {
      setMode(owner.cancel(), false);
    },
  };
}

function createSavedMarketViewHarness() {
  const owner = createQuickPricesRequestOwner();
  const state: SavedMarketViewState = {
    loading: false,
    bgRefreshing: false,
    activeMarketId: 'market-a',
    detailMarketId: null,
    sidebarMarketIds: [],
    historyMarketIds: [],
  };
  const setMode = (mode: 'foreground' | 'background' | null, active: boolean) => {
    if (mode === 'foreground') state.loading = active;
    if (mode === 'background') state.bgRefreshing = active;
  };

  return {
    state,
    begin(marketId: string, mode: 'foreground' | 'background') {
      const request = owner.begin(marketId, mode);
      setMode(request.displacedMode, false);
      setMode(mode, true);
      return request;
    },
    select(marketId: string) {
      state.activeMarketId = marketId;
    },
    navigateAway() {
      state.activeMarketId = null;
      setMode(owner.cancel(), false);
    },
    apply(request: ReturnType<typeof owner.begin>) {
      if (!owner.owns(request, state.activeMarketId)) return false;
      state.detailMarketId = request.marketId;
      state.sidebarMarketIds.push(request.marketId);
      state.historyMarketIds.push(request.marketId);
      return true;
    },
    finish(request: ReturnType<typeof owner.begin>) {
      if (owner.finish(request)) setMode(request.mode, false);
    },
  };
}

describe('saved-market quick-price request ownership', () => {
  it('keeps failed-platform last-known values visibly stale while applying fresh sibling data', () => {
    const previous = {
      eventTitle: 'NC-14', kalshiCount: 1, pmCount: 1, matchedCount: 1,
      outcomes: [{
        artist: 'Democratic',
        kalshi: { ticker: 'NC14-D', yesBid: 0.12, yesAsk: 0.13, noBid: 0.86, noAsk: 0.87, lastPrice: 0.13 },
        polymarket: { marketId: 'p', conditionId: 'p', yesPrice: 0.18, noPrice: 0.83, bestBid: 0.17, bestAsk: 0.18, lastTradePrice: 0.18 },
        arbitrage: { strategy: 'old', kalshiStake: 100, pmStake: 100, expectedProfit: 9, roiPct: 4.5, buyPlatform: 'kalshi' as const, buyPrice: 0.13, sellPlatform: 'polymarket' as const, sellPrice: 0.83 },
      }], unmatchedKalshi: [], unmatchedPolymarket: [],
    };
    const incoming = {
      ...previous,
      kalshiCount: 0,
      outcomes: [{ ...previous.outcomes[0], kalshi: null, polymarket: { ...previous.outcomes[0].polymarket, yesPrice: 0.2, bestAsk: 0.2 } }],
      platformDiagnostics: {
        kalshi: { status: 'failed' as const, count: 0, reason: 'Kalshi API 503' },
        polymarket: { status: 'fresh' as const, count: 1 },
      },
    };

    const merged = mergeQuickPricesResult(previous, incoming);

    expect(merged.outcomes[0].kalshi?.yesAsk).toBe(0.13);
    expect(merged.outcomes[0].polymarket?.yesPrice).toBe(0.2);
    expect(merged.outcomes[0].kalshiStale).toBe(true);
    expect(merged.outcomes[0].polymarketStale).toBe(false);
    expect(merged.outcomes[0].arbitrage.expectedProfit).toBe(0);
    expect(merged.outcomes[0].arbitrage.roiPct).toBe(0);
  });

  it('prevents response A from updating market B after rapid selection', () => {
    const owner = createQuickPricesRequestOwner();
    const requestA = owner.begin('market-a');
    const requestB = owner.begin('market-b');

    expect(requestA.controller.signal.aborted).toBe(true);
    expect(owner.owns(requestA, 'market-b')).toBe(false);
    expect(owner.owns(requestB, 'market-b')).toBe(true);
  });

  it('does not let an aborted older request clear the current loading owner', () => {
    const owner = createQuickPricesRequestOwner();
    const requestA = owner.begin('market-a');
    const requestB = owner.begin('market-b');

    expect(owner.finish(requestA)).toBe(false);
    expect(owner.owns(requestB, 'market-b')).toBe(true);
    expect(owner.finish(requestB)).toBe(true);
    expect(owner.owns(requestB, 'market-b')).toBe(false);
  });

  it('clears foreground loading when a silent refresh replaces it', () => {
    const harness = createRefreshHarness();
    const foreground = harness.begin('market-a', 'foreground');
    const background = harness.begin('market-b', 'background');

    expect(foreground.controller.signal.aborted).toBe(true);
    expect(harness.state).toEqual({ loading: false, bgRefreshing: true });

    harness.finish(foreground);
    expect(harness.state).toEqual({ loading: false, bgRefreshing: true });
    harness.finish(background);
    expect(harness.state).toEqual({ loading: false, bgRefreshing: false });
  });

  it('clears silent refresh state when a foreground refresh replaces it', () => {
    const harness = createRefreshHarness();
    const background = harness.begin('market-a', 'background');
    const foreground = harness.begin('market-b', 'foreground');

    expect(background.controller.signal.aborted).toBe(true);
    expect(harness.state).toEqual({ loading: true, bgRefreshing: false });

    harness.finish(background);
    expect(harness.state).toEqual({ loading: true, bgRefreshing: false });
    harness.finish(foreground);
    expect(harness.state).toEqual({ loading: false, bgRefreshing: false });
  });

  it('clears the owned loading mode when navigation cancels a refresh', () => {
    const harness = createRefreshHarness();
    const foreground = harness.begin('market-a', 'foreground');

    harness.cancel();

    expect(foreground.controller.signal.aborted).toBe(true);
    expect(harness.state).toEqual({ loading: false, bgRefreshing: false });
    harness.finish(foreground);
    expect(harness.state).toEqual({ loading: false, bgRefreshing: false });
  });

  it('prevents a full rescan for market A from mutating market B after selection', () => {
    const harness = createSavedMarketViewHarness();
    const fullRescanA = harness.begin('market-a', 'foreground');

    harness.select('market-b');

    expect(harness.apply(fullRescanA)).toBe(false);
    expect(harness.state.detailMarketId).toBeNull();
    expect(harness.state.sidebarMarketIds).toEqual([]);
    expect(harness.state.historyMarketIds).toEqual([]);
  });

  it('cancels a full rescan on navigation without committing or leaving loading stuck', () => {
    const harness = createSavedMarketViewHarness();
    const fullRescanA = harness.begin('market-a', 'foreground');

    harness.navigateAway();

    expect(fullRescanA.controller.signal.aborted).toBe(true);
    expect(harness.apply(fullRescanA)).toBe(false);
    expect(harness.state).toMatchObject({
      loading: false,
      bgRefreshing: false,
      detailMarketId: null,
      sidebarMarketIds: [],
      historyMarketIds: [],
    });
  });

  it('lets a full rescan supersede a quick refresh without stale commits or loading races', () => {
    const harness = createSavedMarketViewHarness();
    const quickRefresh = harness.begin('market-a', 'background');
    const fullRescan = harness.begin('market-a', 'foreground');

    expect(quickRefresh.controller.signal.aborted).toBe(true);
    expect(harness.state).toMatchObject({ loading: true, bgRefreshing: false });
    expect(harness.apply(quickRefresh)).toBe(false);
    harness.finish(quickRefresh);
    expect(harness.state).toMatchObject({ loading: true, bgRefreshing: false });

    expect(harness.apply(fullRescan)).toBe(true);
    harness.finish(fullRescan);
    expect(harness.state).toMatchObject({
      loading: false,
      bgRefreshing: false,
      detailMarketId: 'market-a',
      sidebarMarketIds: ['market-a'],
      historyMarketIds: ['market-a'],
    });
  });

  it('does not let delayed market A hydration overwrite B or cancel B refresh', async () => {
    const hydrationOwner = createSavedMarketHydrationOwner();
    const refreshOwner = createQuickPricesRequestOwner();
    const commits: string[] = [];
    let resolveA!: () => void;
    const delayedA = new Promise<void>((resolve) => { resolveA = resolve; });

    const hydrationA = hydrationOwner.begin('market-a');
    const finishA = delayedA.then(() => {
      if (!hydrationOwner.owns(hydrationA, 'market-b')) return;
      commits.push('market-a');
      refreshOwner.begin('market-a', 'background');
    });

    hydrationOwner.begin('market-b');
    const refreshB = refreshOwner.begin('market-b', 'background');
    resolveA();
    await finishA;

    expect(commits).toEqual([]);
    expect(refreshB.controller.signal.aborted).toBe(false);
    expect(refreshOwner.owns(refreshB, 'market-b')).toBe(true);
  });

  it('does not let a delayed fallback lookup continue after navigation away', async () => {
    const hydrationOwner = createSavedMarketHydrationOwner();
    const commits: string[] = [];
    const lookup = hydrationOwner.begin('market-a');

    hydrationOwner.cancel();
    if (hydrationOwner.owns(lookup, null)) commits.push('market-a');

    expect(commits).toEqual([]);
  });

  it('uses captured saved-market URLs instead of stale manual platform links', () => {
    const staleManualLinks = [
      { platform: 'kalshi', url: 'https://kalshi.com/old-a' },
      { platform: 'polymarket', url: 'https://polymarket.com/old-a' },
    ];

    expect(buildScanLinkPayload({
      kalshiUrl: 'https://kalshi.com/saved-b',
      polymarketUrl: 'https://polymarket.com/saved-b',
      platformLinks: staleManualLinks,
      savedMarketId: 'market-b',
    })).toEqual({
      kalshiUrl: 'https://kalshi.com/saved-b',
      polymarketUrl: 'https://polymarket.com/saved-b',
    });
  });

  it('retains canonical platform links for an unsaved manual scan', () => {
    const manualLinks = [
      { platform: 'kalshi', url: 'https://kalshi.com/manual' },
      { platform: 'polymarket', url: 'https://polymarket.com/manual' },
    ];

    expect(buildScanLinkPayload({
      kalshiUrl: '',
      polymarketUrl: '',
      platformLinks: manualLinks,
      savedMarketId: null,
    })).toEqual({ platformLinks: manualLinks });
  });

  it('restores the saved-market detail before browser Forward starts its refresh', () => {
    const owner = createQuickPricesRequestOwner();
    const state = {
      viewMode: 'overview' as 'overview' | 'scan',
      activeMarketId: null as string | null,
      detailMarketId: 'market-b' as string | null,
      loading: false,
    };
    const staleB = owner.begin('market-b', 'background');
    owner.cancel();
    let refreshA: ReturnType<typeof owner.begin> | null = null;
    state.detailMarketId = null;

    restoreSavedMarketPopNavigation('market-a', {
      setViewMode(viewMode) {
        state.viewMode = viewMode;
      },
      setActiveMarketId(marketId) {
        state.activeMarketId = marketId;
      },
      startRefresh() {
        // Mirrors the view-mode ownership effect: a refresh started while the
        // Markets view is still active would be cancelled immediately.
        refreshA = owner.begin('market-a', 'foreground');
        state.loading = true;
        if (state.viewMode !== 'scan' || state.activeMarketId !== 'market-a') {
          owner.cancel();
          state.loading = false;
        }
      },
    });

    expect(state).toMatchObject({
      viewMode: 'scan',
      activeMarketId: 'market-a',
      detailMarketId: null,
      loading: true,
    });
    expect(refreshA).not.toBeNull();
    expect(refreshA!.controller.signal.aborted).toBe(false);
    expect(owner.owns(refreshA!, state.activeMarketId)).toBe(true);

    // A response retained from the previous detail cannot render after Forward.
    if (owner.owns(staleB, state.activeMarketId)) state.detailMarketId = 'market-b-stale';
    expect(state.detailMarketId).toBeNull();

    if (owner.owns(refreshA!, state.activeMarketId)) state.detailMarketId = 'market-a';
    expect(state.detailMarketId).toBe('market-a');
  });
});
