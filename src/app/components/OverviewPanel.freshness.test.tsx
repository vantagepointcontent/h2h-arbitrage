// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { MarketFreshness, getOverviewMarketFreshness } from './OverviewPanel';

afterEach(cleanup);

const now = Date.parse('2026-08-21T15:00:00Z');
const ago = (milliseconds: number) => new Date(now - milliseconds).toISOString();

describe('Markets tier-aware scan freshness', () => {
  it.each([
    ['Hot', 5 * 60_000],
    ['Warm', 15 * 60_000],
    ['Cold', 60 * 60_000],
  ])('keeps an in-SLA %s market fresh and marks it stale only after its own SLA', (_tier, freshnessSlaMs) => {
    const scheduler = { freshnessSlaMs, lastSuccessAt: ago(freshnessSlaMs - 1_000) };
    expect(getOverviewMarketFreshness({ scheduler }, scheduler.lastSuccessAt, false, now).state).toBe('fresh');

    const overdue = { freshnessSlaMs, lastSuccessAt: ago(freshnessSlaMs + 1_000) };
    expect(getOverviewMarketFreshness({ scheduler: overdue }, overdue.lastSuccessAt, false, now).state).toBe('stale');
  });

  it('renders a healthy cold-tier row as Fresh after 15 minutes', () => {
    const scheduler = { freshnessSlaMs: 60 * 60_000, lastSuccessAt: ago(45 * 60_000) };
    render(<MarketFreshness market={{ scheduler }} scannedAt={scheduler.lastSuccessAt} refreshing={false} nowMs={now} />);
    expect(screen.getByText(/Fresh ·/)).toBeTruthy();
    expect(screen.queryByText(/Stale ·/)).toBeNull();
  });

  it('uses scheduler failure and in-progress states without fabricating freshness', () => {
    const scannedAt = ago(60_000);
    const failed = { freshnessSlaMs: 15 * 60_000, lastSuccessAt: scannedAt, failureReason: 'Polymarket HTTP 503' };
    const { rerender } = render(<MarketFreshness market={{ scheduler: failed }} scannedAt={scannedAt} refreshing={false} nowMs={now} />);
    expect(screen.getByText(/Stale ·/).getAttribute('title')).toBe('Polymarket HTTP 503');

    rerender(<MarketFreshness market={{ scheduler: { ...failed, failureReason: null, inProgress: true } }} scannedAt={scannedAt} refreshing={false} nowMs={now} />);
    expect(screen.getByText('Refreshing')).toBeTruthy();
  });

  it.each([
    ['failed', { freshnessSlaMs: 15 * 60_000, lastSuccessAt: ago(60_000), failureReason: 'Polymarket HTTP 503' }, 'stale'],
    ['rate-limited', { freshnessSlaMs: 15 * 60_000, lastSuccessAt: ago(60_000), failureReason: 'HTTP 429 rate limit' }, 'stale'],
    ['overdue', { freshnessSlaMs: 15 * 60_000, lastSuccessAt: ago(16 * 60_000) }, 'stale'],
    ['in-SLA due', { freshnessSlaMs: 15 * 60_000, lastSuccessAt: ago(60_000), nextDueAt: ago(1_000) }, 'fresh'],
  ] as const)('does not let generic match refreshing mask a %s scheduler state', (_label, scheduler, expected) => {
    expect(getOverviewMarketFreshness({ scheduler }, scheduler.lastSuccessAt, true, now).state).toBe(expected);
  });
});
