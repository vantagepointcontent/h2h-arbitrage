// @vitest-environment jsdom

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { OutcomeContingentApy } from '@/lib/settlement-apy';
import { executableEnvelopeFixture } from '@/lib/test-fixtures/calculation-envelope';
import { ArbOpportunitiesPanel } from './ArbOpportunitiesPanel';

const outcomeApy = {
  observedAt: '2026-08-16T12:00:00.000Z',
  apyPct: null,
  unavailableReason: 'outcome_contingent' as const,
  kalshi: null,
  polymarket: null,
  scenarioA: {
    label: 'scenario_a' as const,
    winner: 'kalshi' as const,
    roiPct: 5,
    apyPct: 500,
    settlementAt: '2026-09-01T00:00:00.000Z',
    daysToSettlement: 15.5,
    timingSource: 'kalshi.market.expected_expiration_time',
    unavailableReason: null,
  },
  scenarioB: {
    label: 'scenario_b' as const,
    winner: 'polymarket' as const,
    roiPct: 5,
    apyPct: 400,
    settlementAt: '2026-09-15T00:00:00.000Z',
    daysToSettlement: 29.5,
    timingSource: 'polymarket.event.endDate',
    unavailableReason: null,
  },
} satisfies OutcomeContingentApy;

function renderPanel(apyPct: number | null, apyUnavailableReason: 'missing_expiry' | null) {
  render(<ArbOpportunitiesPanel
    outcomes={[{
      artist: 'Canonical APY opportunity',
      kalshi: { ticker: 'KX-APY', yesAsk: 0.4, noAsk: 0.6 },
      polymarket: { conditionId: '0xapy', yesPrice: 0.5, noPrice: 0.5 },
      arbitrage: {
        strategy: 'Buy YES Kalshi + NO PM',
        expectedProfit: 5,
        roiPct: 5,
        apyPct,
        apyUnavailableReason,
        outcomeApy,
        calculationEnvelope: apyPct == null ? null : executableEnvelopeFixture,
        kalshiStake: 50,
        pmStake: 50,
        maxCapital: 100,
      },
    }]}
    formatCurrency={(value) => `$${value.toFixed(2)}`}
    marketTitle="APY test market"
    scannedAt="2026-08-16T12:00:00.000Z"
  />);
}

describe('ArbOpportunitiesPanel canonical APY presentation', () => {
  it('shows canonical APY in the primary slot and venue APYs as separate detail', () => {
    renderPanel(123.4, null);

    expect(screen.getByText('APY 123%')).toBeTruthy();
    expect(screen.getByText('Kalshi APY 500%')).toBeTruthy();
    expect(screen.getByText('Polymarket APY 400%')).toBeTruthy();
    expect(screen.queryByText(/APY K 500% \/ PM 400%/)).toBeNull();
  });

  it('shows the exact canonical blocker without replacing it with venue APYs', () => {
    renderPanel(null, 'missing_expiry');

    expect(screen.getByText('APY unavailable: missing expiry')).toBeTruthy();
    expect(screen.getByText('Kalshi APY 500%')).toBeTruthy();
    expect(screen.getByText('Polymarket APY 400%')).toBeTruthy();
    expect(screen.queryByText(/APY K 500% \/ PM 400%/)).toBeNull();
  });
});
