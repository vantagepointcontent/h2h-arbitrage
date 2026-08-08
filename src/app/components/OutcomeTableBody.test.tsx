// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { createElement } from 'react';
import { OutcomeTableBody } from './OutcomeTableBody';

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
