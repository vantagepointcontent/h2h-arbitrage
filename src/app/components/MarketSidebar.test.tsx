// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { FullScanStatus, MarketSidebar, NavButton } from './MarketSidebar';
import type { SavedMarket } from '@/app/lib/page-shared';

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
      canonicalApyPct: 12.34, canonicalApyObservedAt: '2026-08-16T00:00:00.000Z', canonicalApySource: 'full_scan',
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
      onScanAll={noop} scanningAll={false} scanProgress={{ current: 0, total: 0 }} scanAllError=""
      onGoOverview={noop} onGoOpportunities={noop} onGoScan={noop} onGoMarketFinder={noop}
      onGoLogs={noop} onGoDashboard={noop} onGoTrades={noop} onGoBotTrader={noop}
      favoriteIds={new Set()} onToggleFavorite={noop} sidebarFavoritesOnly={false}
      onToggleSidebarFavorites={noop} mobileMenuOpen={mobileMenuOpen} onCloseMobileMenu={noop}
    />);

    expect(screen.getByText('(12.3%)')).toBeTruthy();
    expect(screen.queryByText(/56\.8%|90\.1%|Kalshi APY|Polymarket APY/)).toBeNull();
  });
});