// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { FullScanStatus, NavButton } from './MarketSidebar';
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