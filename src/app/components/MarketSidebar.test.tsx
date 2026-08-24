// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { useRef, useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { FullScanStatus, MarketSidebar, NavButton } from './MarketSidebar';
import { createSavedMarketsListRequestOwner, type SavedMarket } from '@/app/lib/page-shared';

describe('NavButton mobile accessibility', () => {
  it.each([
    ['expanded navigation', false],
    ['collapsed navigation', true],
  ])('provides a 44px minimum tap target for %s', (_name, collapsed) => {
    render(
      <NavButton
        icon={<span aria-hidden="true">M</span>}
        label="Markets"
        active={false}
        collapsed={collapsed}
        onClick={vi.fn()}
      />,
    );

    expect(screen.getByRole('button', { name: 'Markets' }).className).toContain('min-h-11');
  });
});

describe('saved-market full scan states', () => {
  const now = Date.parse('2026-08-13T20:00:00Z');
  const market = (scheduler: SavedMarket['scheduler'], scannedAt: string | null = '2026-08-13T19:30:00Z'): SavedMarket => ({
    id: 'market-1', eventTitle: 'Market 1', kalshiUrl: 'k', polymarketUrl: 'p', createdAt: '2026-08-13T18:00:00Z',
    lastScanResult: { bestRoiPct: 0, bestProfit: 0, strategy: 'No arb', outcomeCount: 0, matchedCount: 0, kalshiCount: 0, pmCount: 0, scannedAt, allArbs: [] },
    scheduler,
  });

  it.each([
    ['fresh', market({ lastSuccessAt: '2026-08-13T19:30:00Z', freshnessSlaMs: 60 * 60_000 }), /30m ago/],
    ['scanning', market({ lastSuccessAt: '2026-08-13T19:30:00Z', inProgress: true, freshnessSlaMs: 60 * 60_000 }), /Scanning · 30m ago/],
    ['failed', market({ lastSuccessAt: '2026-08-13T19:30:00Z', failureReason: 'Kalshi HTTP 503', freshnessSlaMs: 60 * 60_000 }), /Failed · 30m ago/],
    ['rate limited', market({ lastSuccessAt: '2026-08-13T19:30:00Z', failureReason: 'HTTP 429', freshnessSlaMs: 60 * 60_000 }), /Rate limited · 30m ago/],
    ['due', market({ lastSuccessAt: '2026-08-13T19:30:00Z', nextDueAt: '2026-08-13T19:59:00Z', freshnessSlaMs: 60 * 60_000 }), /Due · 30m ago/],
    ['overdue', market({ lastSuccessAt: '2026-08-13T18:00:00Z', freshnessSlaMs: 60 * 60_000 }), /Overdue · 2h ago/],
    ['unavailable', market(null, null), /Unavailable · Never/],
  ])('renders %s from the last successful full scan', (_status, saved, label) => {
    render(<FullScanStatus market={saved} now={now} />);
    expect(screen.getByText(label)).toBeTruthy();
  });
});

describe.each([
  ['desktop', 1280, false],
  ['mobile', 390, true],
] as const)('BUG-159 compact APY on %s', (_viewport, width, mobileMenuOpen) => {
  it('renders only the canonical scalar APY in the saved-market sidebar', () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
    const saved: SavedMarket = {
      id: 'market-apy', eventTitle: 'Canonical APY market', kalshiUrl: 'k', polymarketUrl: 'p',
      createdAt: '2026-08-13T18:00:00Z', expiryDate: '2027-01-01T00:00:00.000Z',
      canonicalApyPct: 12.34, canonicalApyObservedAt: '2026-08-16T00:00:00.000Z', canonicalApySource: 'full_scan', canonicalApyRevision: 1,
      canonicalCurrentRoiPct: 2, canonicalCurrentProfit: 1, canonicalCurrentStrategy: 'Buy YES Kalshi + NO PM',
      canonicalCurrentDaysToExpiry: 365 * Math.log(1.02) / Math.log(1.1234),
      canonicalCurrentExpiryAt: '2027-01-01T00:00:00.000Z', canonicalCurrentRevision: 1,
      lastScanResult: { bestRoiPct: 0, bestProfit: 0, strategy: 'No arb', outcomeCount: 1, matchedCount: 1, kalshiCount: 1, pmCount: 1, scannedAt: '2026-08-16T00:00:00.000Z', allArbs: [] },
    };
    saved.lastScanResult = {
      ...saved.lastScanResult!, bestRoiPct: 2,
      allArbs: [{
        artist: 'Outcome', strategy: 'Buy YES Kalshi + NO PM', expectedProfit: 1, roiPct: 2, apyPct: 12.34,
        outcomeApy: {
          observedAt: '2026-08-16T00:00:00.000Z', apyPct: null, unavailableReason: 'outcome_contingent', kalshi: null, polymarket: null,
          scenarioA: { label: 'scenario_a', winner: 'kalshi', roiPct: 2, apyPct: 56.78, settlementAt: '2027-01-01T00:00:00.000Z', daysToSettlement: 100, timingSource: 'kalshi.market.expected_expiration_time', unavailableReason: null },
          scenarioB: { label: 'scenario_b', winner: 'polymarket', roiPct: 2, apyPct: 90.12, settlementAt: '2027-01-01T00:00:00.000Z', daysToSettlement: 100, timingSource: 'polymarket.event.endDate', unavailableReason: null },
        },
      }],
    } as SavedMarket['lastScanResult'];
    const noop = vi.fn();
    render(<MarketSidebar
      markets={[saved]} activeId={null} viewMode="overview" sidebarOpen onToggleSidebar={noop}
      onSelectMarket={noop} onDeleteMarket={noop} sort="name" sortDir="asc" onToggleSort={noop}
      timeUntilExpiry={() => '100d'} expiryFilter="all" onSetExpiryFilter={noop}
      showExpired onToggleShowExpired={noop} showArbOnly={false} onToggleShowArbOnly={noop}
      onRefreshMarkets={noop} listRefreshState={{ status: 'idle', message: null, observedAt: null, source: null, revision: null }}
      onGoOverview={noop} onGoOpportunities={noop} onGoScan={noop} onGoMarketFinder={noop}
      onGoLogs={noop} onGoDashboard={noop} onGoTrades={noop} onGoBotTrader={noop}
      favoriteIds={new Set()} onToggleFavorite={noop} sidebarFavoritesOnly={false}
      onToggleSidebarFavorites={noop} mobileMenuOpen={mobileMenuOpen} onCloseMobileMenu={noop}
    />);

    expect(screen.getByText('(12.3%)')).toBeTruthy();
    expect(screen.queryByText(/56\.8%|90\.1%|Kalshi APY|Polymarket APY/)).toBeNull();
  });
});

describe('BUG-186 compact APY unavailable reason', () => {
  it('exposes the exact missing canonical input without changing the persisted ROI display', () => {
    const noop = vi.fn();
    const saved: SavedMarket = {
      id: 'missing-expiry', eventTitle: 'Missing expiry market', kalshiUrl: 'k', polymarketUrl: 'p',
      createdAt: '2026-08-13T18:00:00Z', expiryDate: null,
      canonicalApyPct: null, canonicalApyUnavailableReason: 'missing_expiry',
      canonicalApyObservedAt: '2026-08-16T00:00:00.000Z', canonicalApySource: 'full_scan', canonicalApyRevision: 1,
      canonicalCurrentRoiPct: 2, canonicalCurrentProfit: null, canonicalCurrentStrategy: 'Buy YES Kalshi + NO PM',
      canonicalCurrentDaysToExpiry: null, canonicalCurrentExpiryAt: null, canonicalCurrentRevision: 1,
      lastScanResult: { bestRoiPct: 2, bestProfit: 0, strategy: 'Buy YES Kalshi + NO PM', outcomeCount: 1,
        matchedCount: 0, matchStatus: 'unavailable', kalshiCount: 1, pmCount: 1,
        scannedAt: '2026-08-16T00:00:00.000Z', allArbs: [] },
    };
    render(<MarketSidebar markets={[saved]} activeId={null} viewMode="overview" sidebarOpen onToggleSidebar={noop}
      onSelectMarket={noop} onDeleteMarket={noop} sort="name" sortDir="asc" onToggleSort={noop}
      timeUntilExpiry={() => 'Unknown'} expiryFilter="all" onSetExpiryFilter={noop}
      showExpired onToggleShowExpired={noop} showArbOnly={false} onToggleShowArbOnly={noop}
      onRefreshMarkets={noop} listRefreshState={{ status: 'idle', message: null, observedAt: null, source: null, revision: null }}
      onGoOverview={noop} onGoOpportunities={noop} onGoScan={noop} onGoMarketFinder={noop}
      onGoLogs={noop} onGoDashboard={noop} onGoTrades={noop} onGoBotTrader={noop}
      favoriteIds={new Set()} onToggleFavorite={noop} sidebarFavoritesOnly={false}
      onToggleSidebarFavorites={noop} mobileMenuOpen={false} onCloseMobileMenu={noop} />);

    expect(screen.getByText('+2.0%')).toBeTruthy();
    expect(screen.getByTitle('APY unavailable: missing expiry').textContent).toBe('(APY unavailable)');
  });
});

describe('BUG-168 lightweight Saved Markets refresh', () => {
  it('renders no healthy persisted-list status or revision details', () => {
    const noop = vi.fn();
    const saved: SavedMarket = {
      id: 'market-healthy', eventTitle: 'Healthy market', kalshiUrl: 'k', polymarketUrl: 'p',
      createdAt: '2026-08-01T00:00:00.000Z', lastScanResult: null,
    };

    render(<MarketSidebar markets={[saved]} activeId={null} viewMode="overview" sidebarOpen onToggleSidebar={noop}
      onSelectMarket={noop} onDeleteMarket={noop} sort="name" sortDir="asc" onToggleSort={noop}
      timeUntilExpiry={() => '100d'} expiryFilter="all" onSetExpiryFilter={noop}
      showExpired onToggleShowExpired={noop} showArbOnly={false} onToggleShowArbOnly={noop}
      onRefreshMarkets={noop}
      listRefreshState={{ status: 'success', message: null, observedAt: '2026-08-20T10:00:00.000Z', source: 'persisted-saved-markets', revision: 'rev-private' }}
      onGoOverview={noop} onGoOpportunities={noop} onGoScan={noop} onGoMarketFinder={noop}
      onGoLogs={noop} onGoDashboard={noop} onGoTrades={noop} onGoBotTrader={noop}
      favoriteIds={new Set()} onToggleFavorite={noop} sidebarFavoritesOnly={false}
      onToggleSidebarFavorites={noop} mobileMenuOpen={false} onCloseMobileMenu={noop} />);

    expect(screen.getByText('Healthy market')).toBeTruthy();
    expect(screen.queryByText(/Latest persisted list loaded|rev-private/i)).toBeNull();
    expect(screen.queryByTestId('saved-markets-revision')).toBeNull();
    expect(screen.queryByRole('status')).toBeNull();
    const filters = screen.getByPlaceholderText('Filter by name...').parentElement;
    expect(filters?.previousElementSibling?.textContent).toContain('Saved Markets (1)');
  });

  it('renders a bounded degraded state while retaining rows', () => {
    const noop = vi.fn();
    const refresh = vi.fn();
    const saved: SavedMarket = {
      id: 'market-1', eventTitle: 'Retained market', category: 'Politics', kalshiUrl: 'k', polymarketUrl: 'p',
      createdAt: '2026-08-01T00:00:00.000Z', lastScanResult: null,
    };
    render(<MarketSidebar
      markets={[saved]} activeId="market-1" viewMode="overview" sidebarOpen onToggleSidebar={noop}
      onSelectMarket={noop} onDeleteMarket={noop} sort="apy" sortDir="desc" onToggleSort={noop}
      timeUntilExpiry={() => '100d'} expiryFilter="all" onSetExpiryFilter={noop}
      showExpired onToggleShowExpired={noop} showArbOnly={false} onToggleShowArbOnly={noop}
      onRefreshMarkets={refresh}
      listRefreshState={{ status: 'degraded', message: 'Saved markets are temporarily unavailable. The last-known list is still shown.', observedAt: '2026-08-19T14:55:00.000Z', source: 'persisted-saved-markets', revision: 'rev-1' }}
      onGoOverview={noop} onGoOpportunities={noop} onGoScan={noop} onGoMarketFinder={noop}
      onGoLogs={noop} onGoDashboard={noop} onGoTrades={noop} onGoBotTrader={noop}
      favoriteIds={new Set()} onToggleFavorite={noop} sidebarFavoritesOnly={false}
      onToggleSidebarFavorites={noop} mobileMenuOpen={false} onCloseMobileMenu={noop}
    />);

    fireEvent.click(screen.getByRole('button', { name: 'Refresh markets' }));
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Retained market')).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toContain('last-known list');
    expect(screen.getByRole('alert').className).toContain('status-warning');
    expect(screen.queryByText(/\{"error"/)).toBeNull();
  });

  it('renders an unavailable list as a red actionable error', () => {
    const noop = vi.fn();
    render(<MarketSidebar markets={[]} activeId={null} viewMode="overview" sidebarOpen onToggleSidebar={noop}
      onSelectMarket={noop} onDeleteMarket={noop} sort="name" sortDir="asc" onToggleSort={noop}
      timeUntilExpiry={() => '100d'} expiryFilter="all" onSetExpiryFilter={noop}
      showExpired onToggleShowExpired={noop} showArbOnly={false} onToggleShowArbOnly={noop}
      onRefreshMarkets={noop}
      listRefreshState={{ status: 'error', message: 'Saved markets are unavailable. Reload the app and try Refresh again.', observedAt: null, source: null, revision: null }}
      onGoOverview={noop} onGoOpportunities={noop} onGoScan={noop} onGoMarketFinder={noop}
      onGoLogs={noop} onGoDashboard={noop} onGoTrades={noop} onGoBotTrader={noop}
      favoriteIds={new Set()} onToggleFavorite={noop} sidebarFavoritesOnly={false}
      onToggleSidebarFavorites={noop} mobileMenuOpen={false} onCloseMobileMenu={noop} />);

    expect(screen.getByRole('alert').textContent).toContain('Reload the app and try Refresh again.');
    expect(screen.getByRole('alert').className).toContain('status-negative');
  });

  it.each([
    ['apy', 'APY ↓'], ['roi', 'ROI ↓'], ['name', 'A-Z ↓'], ['scanned', 'Scanned ↓'],
  ] as const)('preserves filters, %s sort, selection, and scroll across rerender', (sort, sortLabel) => {
    const noop = vi.fn();
    const initial: SavedMarket = {
      id: 'market-target', eventTitle: 'Target market', category: 'Politics', kalshiUrl: 'k', polymarketUrl: 'p',
      createdAt: '2026-08-01T00:00:00.000Z', expiryDate: '2026-08-25T00:00:00.000Z',
      canonicalCurrentRoiPct: 2, canonicalCurrentProfit: 4, canonicalCurrentStrategy: 'arb',
      lastScanResult: { bestRoiPct: 2, bestProfit: 4, strategy: 'arb', outcomeCount: 1, matchedCount: 1, kalshiCount: 1, pmCount: 1, scannedAt: '2026-08-19T14:00:00.000Z', allArbs: [] },
    };
    const props = {
      activeId: 'market-target', viewMode: 'overview', sidebarOpen: true, onToggleSidebar: noop,
      onSelectMarket: noop, onDeleteMarket: noop, sort, sortDir: 'desc' as const, onToggleSort: noop,
      timeUntilExpiry: () => '6d', expiryFilter: 'lte30' as const, onSetExpiryFilter: noop,
      showExpired: false, onToggleShowExpired: noop, showArbOnly: true, onToggleShowArbOnly: noop,
      onRefreshMarkets: noop, onGoOverview: noop, onGoOpportunities: noop, onGoScan: noop,
      onGoMarketFinder: noop, onGoLogs: noop, onGoDashboard: noop, onGoTrades: noop, onGoBotTrader: noop,
      favoriteIds: new Set<string>(), onToggleFavorite: noop, sidebarFavoritesOnly: false,
      onToggleSidebarFavorites: noop, mobileMenuOpen: false, onCloseMobileMenu: noop,
    };
    const { rerender } = render(<MarketSidebar {...props} markets={[initial]}
      listRefreshState={{ status: 'loading', message: null, observedAt: null, source: null, revision: 'rev-1' }} />);

    const refreshButton = screen.getByRole('button', { name: 'Refresh markets' });
    expect(refreshButton).toHaveProperty('disabled', true);
    expect(refreshButton.querySelector('.animate-spin')).toBeTruthy();
    fireEvent.change(screen.getByPlaceholderText('Filter by name...'), { target: { value: 'target' } });
    fireEvent.change(screen.getAllByRole('combobox')[1], { target: { value: 'Politics' } });
    const list = screen.getByTestId('saved-markets-scroll');
    list.scrollTop = 137;

    rerender(<MarketSidebar {...props} markets={[{ ...initial, eventTitle: 'Target market refreshed' }]}
      listRefreshState={{ status: 'success', message: null, observedAt: '2026-08-19T15:00:00.000Z', source: 'persisted-saved-markets', revision: 'rev-2' }} />);

    expect(screen.getByPlaceholderText('Filter by name...')).toHaveProperty('value', 'target');
    expect(screen.getAllByRole('combobox')[0]).toHaveProperty('value', 'lte30');
    expect(screen.getAllByRole('combobox')[1]).toHaveProperty('value', 'Politics');
    expect(screen.getByRole('button', { name: sortLabel })).toBeTruthy();
    expect(screen.getByText('Target market refreshed').closest('.group')?.className).toContain('ring-1');
    expect(screen.getByTestId('saved-markets-scroll').scrollTop).toBe(137);
    expect(screen.queryByText(/Latest persisted list loaded|rev-2/i)).toBeNull();
    expect(refreshButton).toHaveProperty('disabled', false);
    expect(refreshButton.querySelector('.animate-spin')).toBeNull();
  });

  it('keeps the newer rendered revision when an older completion arrives later', async () => {
    let resolveOld!: (market: SavedMarket) => void;
    let resolveNew!: (market: SavedMarket) => void;
    const oldResponse = new Promise<SavedMarket>((resolve) => { resolveOld = resolve; });
    const newResponse = new Promise<SavedMarket>((resolve) => { resolveNew = resolve; });
    const base: SavedMarket = { id: 'market-1', eventTitle: 'Initial market', kalshiUrl: 'k', polymarketUrl: 'p', createdAt: '2026-08-01', lastScanResult: null };

    function Harness() {
      const owner = useRef(createSavedMarketsListRequestOwner());
      const [market, setMarket] = useState(base);
      const [revision, setRevision] = useState('rev-0');
      const start = (promise: Promise<SavedMarket>, nextRevision: string, supersede: boolean) => {
        const request = owner.current.run(() => promise, { supersede });
        void request.promise.then((next) => {
          if (!owner.current.owns(request)) return;
          setMarket(next);
          setRevision(nextRevision);
          owner.current.finish(request);
        });
      };
      const noop = vi.fn();
      return <>
        <button onClick={() => start(oldResponse, 'rev-old', false)}>Start old refresh</button>
        <button onClick={() => start(newResponse, 'rev-new', true)}>Start new refresh</button>
        <MarketSidebar markets={[market]} activeId="market-1" viewMode="overview" sidebarOpen onToggleSidebar={noop}
          onSelectMarket={noop} onDeleteMarket={noop} sort="name" sortDir="asc" onToggleSort={noop}
          timeUntilExpiry={() => '100d'} expiryFilter="all" onSetExpiryFilter={noop}
          showExpired onToggleShowExpired={noop} showArbOnly={false} onToggleShowArbOnly={noop}
          onRefreshMarkets={noop}
          listRefreshState={{ status: 'success', message: null, observedAt: '2026-08-19T15:00:00.000Z', source: 'persisted-saved-markets', revision }}
          onGoOverview={noop} onGoOpportunities={noop} onGoScan={noop} onGoMarketFinder={noop}
          onGoLogs={noop} onGoDashboard={noop} onGoTrades={noop} onGoBotTrader={noop}
          favoriteIds={new Set()} onToggleFavorite={noop} sidebarFavoritesOnly={false}
          onToggleSidebarFavorites={noop} mobileMenuOpen={false} onCloseMobileMenu={noop} />
      </>;
    }

    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Start old refresh' }));
    fireEvent.click(screen.getByRole('button', { name: 'Start new refresh' }));
    resolveNew({ ...base, eventTitle: 'Newest market' });
    expect(await screen.findByText('Newest market')).toBeTruthy();
    expect(screen.queryByText(/Latest persisted list loaded|rev-new/i)).toBeNull();
    resolveOld({ ...base, eventTitle: 'Stale market' });
    await Promise.resolve();
    expect(screen.queryByText('Stale market')).toBeNull();
    expect(screen.getByText('Newest market')).toBeTruthy();
  });

  it('shows a bounded empty state without a raw response payload', () => {
    const noop = vi.fn();
    render(<MarketSidebar markets={[]} activeId={null} viewMode="overview" sidebarOpen onToggleSidebar={noop}
      onSelectMarket={noop} onDeleteMarket={noop} sort="apy" sortDir="desc" onToggleSort={noop}
      timeUntilExpiry={() => '100d'} expiryFilter="all" onSetExpiryFilter={noop}
      showExpired onToggleShowExpired={noop} showArbOnly={false} onToggleShowArbOnly={noop}
      onRefreshMarkets={noop} listRefreshState={{ status: 'empty', message: null, observedAt: null, source: null, revision: 'rev-empty' }}
      onGoOverview={noop} onGoOpportunities={noop} onGoScan={noop} onGoMarketFinder={noop}
      onGoLogs={noop} onGoDashboard={noop} onGoTrades={noop} onGoBotTrader={noop}
      favoriteIds={new Set()} onToggleFavorite={noop} sidebarFavoritesOnly={false}
      onToggleSidebarFavorites={noop} mobileMenuOpen={false} onCloseMobileMenu={noop} />);
    expect(screen.getByText('No saved markets yet.')).toBeTruthy();
    expect(screen.queryByText('The persisted Saved Markets list is empty.')).toBeNull();
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.queryByText(/\{"/)).toBeNull();
  });
});

describe('BUG-169 complete Saved Markets APY pipeline', () => {
  it('filters all 482 rows before sorting the complete result at full precision', () => {
    const noop = vi.fn();
    const markets = Array.from({ length: 482 }, (_, index): SavedMarket => {
      const eligible = index % 2 === 0;
      const canonicalApyPct = index === 2 ? 30.01 : index === 400 ? 30.04 : index / 1000;
      const roiPct = (Math.pow(1 + canonicalApyPct / 100, 100 / 365) - 1) * 100;
      return {
        id: `market-${index.toString().padStart(3, '0')}`,
        eventTitle: `${eligible ? 'Eligible' : 'Excluded'} Market ${index.toString().padStart(3, '0')}`,
        category: eligible ? 'Politics' : 'Sports',
        kalshiUrl: 'k',
        polymarketUrl: 'p',
        createdAt: '2026-08-01T00:00:00.000Z',
        canonicalApyPct,
        canonicalApyObservedAt: '2026-08-19T14:00:00.000Z',
        canonicalApySource: 'full_scan',
        canonicalApyRevision: 1,
        canonicalCurrentRoiPct: roiPct,
        canonicalCurrentProfit: 1,
        canonicalCurrentStrategy: 'Buy YES Kalshi + NO PM',
        canonicalCurrentDaysToExpiry: 100,
        canonicalCurrentExpiryAt: '2026-11-27T14:00:00.000Z',
        canonicalCurrentRevision: 1,
      };
    });

    render(<MarketSidebar markets={markets} activeId="market-002" viewMode="overview" sidebarOpen onToggleSidebar={noop}
      onSelectMarket={noop} onDeleteMarket={noop} sort="apy" sortDir="desc" onToggleSort={noop}
      timeUntilExpiry={() => '100d'} expiryFilter="all" onSetExpiryFilter={noop}
      showExpired onToggleShowExpired={noop} showArbOnly={false} onToggleShowArbOnly={noop}
      onRefreshMarkets={noop} listRefreshState={{ status: 'idle', message: null, observedAt: null, source: null, revision: null }}
      onGoOverview={noop} onGoOpportunities={noop} onGoScan={noop} onGoMarketFinder={noop}
      onGoLogs={noop} onGoDashboard={noop} onGoTrades={noop} onGoBotTrader={noop}
      favoriteIds={new Set()} onToggleFavorite={noop} sidebarFavoritesOnly={false}
      onToggleSidebarFavorites={noop} mobileMenuOpen={false} onCloseMobileMenu={noop} />);

    fireEvent.change(screen.getAllByRole('combobox')[1], { target: { value: 'Politics' } });
    fireEvent.change(screen.getByPlaceholderText('Filter by name...'), { target: { value: 'Eligible' } });

    expect(screen.getByText('Saved Markets (241/482)')).toBeTruthy();
    const rendered = screen.getAllByText(/^Eligible Market /).map((node) => node.textContent);
    const expected = markets
      .filter((market) => market.category === 'Politics' && market.eventTitle.includes('Eligible'))
      .sort((a, b) => (b.canonicalApyPct ?? -Infinity) - (a.canonicalApyPct ?? -Infinity))
      .map((market) => market.eventTitle);
    expect(rendered).toEqual(expected);
    expect(rendered.slice(0, 2)).toEqual(['Eligible Market 400', 'Eligible Market 002']);
    expect(screen.getAllByText('(30.0%)')).toHaveLength(2);
  });
});