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

describe('OutcomeTableBody outcome-contingent APY', () => {
  it('renders canonical APY in the compact row and venue APYs only in expanded detail', () => {
    function Harness() {
      const [expandedArtist, setExpandedArtist] = useState<string | null>(null);
      return createElement('table', null, createElement(OutcomeTableBody, {
        outcomes: [{
          artist: 'Maine Senate', kalshi: { yesAsk: 0.67, noAsk: 0.34 }, polymarket: { yesPrice: 0.7, noPrice: 0.31 },
          arbitrage: { expectedProfit: 0.0016, roiPct: 0.16026, apyPct: 0.828, daysToExpiry: 71, strategy: 'Buy YES Kalshi + NO PM', outcomeApy: {
            observedAt: '2026-08-14T11:02:35.000Z', apyPct: null, unavailableReason: 'outcome_contingent', kalshi: null, polymarket: null,
            scenarioA: { label: 'scenario_a', winner: 'kalshi', roiPct: 0.16026, apyPct: 0.40858, settlementAt: '2027-01-04T15:00:00.000Z', daysToSettlement: 143.16, timingSource: 'kalshi.market.expected_expiration_time', unavailableReason: null },
            scenarioB: { label: 'scenario_b', winner: 'polymarket', roiPct: 0.16026, apyPct: 0.72627, settlementAt: '2026-11-03T00:00:00.000Z', daysToSettlement: 80.54, timingSource: 'polymarket.event.endDate', unavailableReason: null },
          } },
        }], expandedArtist, setExpandedArtist, formatCurrency: (value: number) => `$${value.toFixed(2)}`, formatPercent: (value: number) => `${value.toFixed(2)}%`, marketExpiryDate: '2026-10-24T11:02:35.000Z',
      }));
    }
    render(<Harness />);
    expect(screen.getByText('0.83%')).toBeTruthy();
    expect(screen.queryByText('Kalshi APY:')).toBeNull();
    expect(screen.queryByText('Polymarket APY:')).toBeNull();
    fireEvent.click(screen.getByText('Maine Senate'));
    expect(screen.getByText('Kalshi APY:')).toBeTruthy();
    expect(screen.getByText('Polymarket APY:')).toBeTruthy();
    expect(screen.getByText('71 days')).toBeTruthy();
  });

  it('shows an explicit unavailable reason instead of zero APY', () => {
    render(createElement('table', null, createElement(OutcomeTableBody, {
      outcomes: [{
        artist: 'Unknown timing', kalshi: { yesAsk: 0.4, noAsk: 0.6 }, polymarket: { yesPrice: 0.5, noPrice: 0.5 },
        arbitrage: { expectedProfit: 1, roiPct: 1, apyPct: null, apyUnavailableReason: 'missing_expiry', strategy: 'Buy YES Kalshi + NO PM', outcomeApy: {
          observedAt: '2026-08-14T11:02:35.000Z', apyPct: null, unavailableReason: 'missing_settlement_date', kalshi: null, polymarket: null,
          scenarioA: { label: 'scenario_a', winner: 'kalshi', roiPct: 1, apyPct: null, settlementAt: null, daysToSettlement: null, timingSource: null, unavailableReason: 'missing_settlement_date' },
          scenarioB: { label: 'scenario_b', winner: 'polymarket', roiPct: 1, apyPct: null, settlementAt: null, daysToSettlement: null, timingSource: null, unavailableReason: 'missing_settlement_date' },
        } },
      }], expandedArtist: null, setExpandedArtist: () => {}, formatCurrency: String, formatPercent: String,
    })));
    expect(screen.getByTitle('APY unavailable: missing expiry').textContent).toBe('Unavailable');
  });

  it.each([
    ['zero', 0, '0.00%'],
    ['negative', -25, '-25.00%'],
  ])('keeps a valid %s canonical APY in expanded detail', (_case, apyPct, formatted) => {
    render(createElement('table', null, createElement(OutcomeTableBody, {
      outcomes: [{
        artist: `${_case} APY`,
        kalshi: { yesAsk: 0.45, noAsk: 0.55 },
        polymarket: { yesPrice: 0.46, noPrice: 0.54 },
        arbitrage: { expectedProfit: -1, roiPct: apyPct, apyPct, daysToExpiry: 365, strategy: 'No arb' },
      }],
      expandedArtist: `${_case} APY`, setExpandedArtist: () => {}, formatCurrency: String,
      formatPercent: (value: number) => `${value.toFixed(2)}%`,
    })));

    expect(screen.getByText('APY:')).toBeTruthy();
    expect(screen.getAllByText(formatted).length).toBeGreaterThanOrEqual(2);
  });

  it('does not use venue APYs to sort or color an unavailable canonical APY', () => {
    render(createElement('table', null, createElement(OutcomeTableBody, {
      outcomes: [{
        artist: 'Unavailable canonical', kalshi: { yesAsk: 0.4, noAsk: 0.6 }, polymarket: { yesPrice: 0.5, noPrice: 0.5 },
        arbitrage: { expectedProfit: 1, roiPct: 5, apyPct: null, apyUnavailableReason: 'missing_expiry', strategy: 'No arb', outcomeApy: {
          observedAt: '2026-08-14T11:02:35.000Z', apyPct: null, unavailableReason: 'outcome_contingent', kalshi: null, polymarket: null,
          scenarioA: { label: 'scenario_a', winner: 'kalshi', roiPct: 5, apyPct: 500, settlementAt: '2027-01-01T00:00:00.000Z', daysToSettlement: 1, timingSource: 'kalshi.market.expected_expiration_time', unavailableReason: null },
          scenarioB: { label: 'scenario_b', winner: 'polymarket', roiPct: 5, apyPct: 400, settlementAt: '2027-01-01T00:00:00.000Z', daysToSettlement: 1, timingSource: 'polymarket.event.endDate', unavailableReason: null },
        } },
      }, {
        artist: 'Canonical one', kalshi: { yesAsk: 0.4, noAsk: 0.6 }, polymarket: { yesPrice: 0.5, noPrice: 0.5 },
        arbitrage: { expectedProfit: 1, roiPct: 1, apyPct: 1, daysToExpiry: 365, strategy: 'No arb' },
      }],
      expandedArtist: null, setExpandedArtist: () => {}, formatCurrency: String,
      formatPercent: (value: number) => `${value.toFixed(2)}%`, sortField: 'apy', sortDir: 'desc',
    })));

    expect(screen.getAllByTestId('outcome-name-cell').map((cell) => cell.textContent)).toEqual(['▶Canonical one', '▶Unavailable canonical']);
    const unavailable = screen.getByTitle('APY unavailable: missing expiry');
    expect(unavailable.closest('td')?.className).toContain('text-[var(--text-secondary)]');
    expect(unavailable.closest('td')?.className).not.toContain('text-[var(--status-positive)]');
  });
});

describe('OutcomeTableBody ROI sorting', () => {
  const pricedOutcome = (artist: string, roiPct: number) => ({
    artist,
    kalshi: { ticker: `K-${artist}`, yesAsk: 0.45, noAsk: 0.55 },
    polymarket: { conditionId: `P-${artist}`, yesPrice: 0.46, noPrice: 0.54 },
    arbitrage: { expectedProfit: roiPct / 100, roiPct, strategy: roiPct > 0 ? 'Buy YES Kalshi + NO PM' : 'No arb' },
  });
  const rowNames = () => screen.getAllByTestId('outcome-name-cell').map((cell) => cell.textContent?.replace('▶', ''));
  const props = {
    expandedArtist: null,
    setExpandedArtist: () => {},
    formatCurrency: (value: number) => `$${value.toFixed(2)}`,
    formatPercent: (value: number) => `${value.toFixed(2)}%`,
  };

  it('defaults to full-precision ROI descending across positive, zero, and negative values', () => {
    render(createElement('table', null, createElement(OutcomeTableBody, {
      ...props,
      outcomes: [
        pricedOutcome('Rounded lower', 1.0041),
        pricedOutcome('Negative', -0.5),
        pricedOutcome('Rounded higher', 1.0049),
        pricedOutcome('Zero', 0),
      ],
    })));

    expect(rowNames()).toEqual(['Rounded higher', 'Rounded lower', 'Zero', 'Negative']);
  });

  it.each(['asc', 'desc'] as const)('keeps unavailable ROI rows last when sorting %s', (sortDir) => {
    render(createElement('table', null, createElement(OutcomeTableBody, {
      ...props,
      outcomes: [
        { ...pricedOutcome('Unavailable', 999), polymarket: null },
        pricedOutcome('Positive', 2),
        pricedOutcome('Negative', -2),
      ],
      sortField: 'roi',
      sortDir,
    })));

    expect(rowNames().at(-1)).toBe('Unavailable');
  });

  it('uses deterministic market identity tie-breakers when equal-ROI input order changes on refresh', () => {
    const alpha = pricedOutcome('Alpha', 1.23456);
    const beta = pricedOutcome('Beta', 1.23456);
    const { rerender } = render(createElement('table', null, createElement(OutcomeTableBody, { ...props, outcomes: [beta, alpha] })));
    expect(rowNames()).toEqual(['Alpha', 'Beta']);

    rerender(createElement('table', null, createElement(OutcomeTableBody, { ...props, outcomes: [alpha, beta] })));
    expect(rowNames()).toEqual(['Alpha', 'Beta']);
  });
});
