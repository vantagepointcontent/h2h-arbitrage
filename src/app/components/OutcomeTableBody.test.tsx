// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createElement, useState, type ComponentProps } from 'react';
import { OutcomeTableBody } from './OutcomeTableBody';

vi.mock('./MarketDepthCharts', () => ({ MarketDepthCharts: () => null }));

afterEach(cleanup);

describe('OutcomeTableBody mobile table support', () => {
  it('keeps the outcome name visible while a narrow viewport scrolls horizontally', () => {
    render(createElement('table', null, createElement(OutcomeTableBody, {
      outcomes: [{
        artist: 'Example outcome',
        kalshi: { yesAsk: 0.45, noAsk: 0.55 },
        polymarket: { yesPrice: 0.46, noPrice: 0.54 },
        arbitrage: { expectedProfit: 0, roiPct: 0, strategy: 'No arb' },
      }],
      expandedArtist: null,
      setExpandedArtist: () => {},
      formatCurrency: (value: number) => `$${value.toFixed(2)}`,
      formatPercent: (value: number) => `${value.toFixed(2)}%`,
    })));

    const outcomeCell = screen.getByTestId('outcome-name-cell');
    expect(outcomeCell.className).toContain('sticky');
    expect(outcomeCell.className).toContain('left-0');
    expect(outcomeCell.className).toContain('bg-[var(--surface-panel)]');
  });
});

describe('OutcomeTableBody malformed cached market fallback', () => {
  it('renders an inline fallback instead of throwing for malformed outcome payloads', () => {
    render(createElement('table', null, createElement(OutcomeTableBody, {
      outcomes: [null, { artist: 'Partial row' }] as unknown as ComponentProps<typeof OutcomeTableBody>['outcomes'],
      expandedArtist: null,
      setExpandedArtist: () => {},
      formatCurrency: (value: number) => `$${value.toFixed(2)}`,
      formatPercent: (value: number) => `${value.toFixed(2)}%`,
    })));

    expect(screen.getByRole('alert').textContent).toContain('Market outcome details are unavailable');
  });

  it('expands the affected zero-stake market without throwing and shows a non-destructive sizing fallback', () => {
    function Harness() {
      const [expandedArtist, setExpandedArtist] = useState<string | null>(null);
      return createElement('table', null, createElement(OutcomeTableBody, {
        outcomes: [{
          artist: 'Mark Sanford',
          kalshi: { ticker: 'KXPRIMARYPLACE-SCRSENS26-1-MSAN', yesAsk: 0.02, noAsk: 0.99 },
          polymarket: {
            conditionId: '0xa2586ba4a78b8e7997870a3385b7a42c7f54f8824b810be586e857b67d6c358a',
            yesPrice: 0.001,
            noPrice: 0.999,
          },
          arbitrage: {
            expectedProfit: 0,
            roiPct: 0.825,
            apyPct: 243.9,
            kalshiStake: 0,
            pmStake: 0,
            strategy: 'Buy YES PM + NO Kalshi',
          },
        }],
        expandedArtist,
        setExpandedArtist,
        formatCurrency: (value: number) => `$${value.toFixed(2)}`,
        formatPercent: (value: number) => `${value.toFixed(2)}%`,
        marketTitle: 'South Carolina Senate Special Republican Primary: First Round Winner',
        marketExpiryDate: '2026-08-11T23:59:00Z',
      }));
    }

    render(<Harness />);
    fireEvent.click(screen.getByText('Mark Sanford'));

    expect(screen.getByText('Total Stake:')).toBeTruthy();
    expect(screen.getByRole('status').textContent).toContain('Stake sizing is unavailable');
  });
});
