// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { CalculationEnvelope } from '@/lib/calculation-envelope';
import { executableEnvelopeFixture } from '@/lib/test-fixtures/calculation-envelope';
import { CalculationProvenance } from './CalculationProvenance';

const nonExecutableMinimum: CalculationEnvelope = {
  ...executableEnvelopeFixture,
  status: 'non_executable',
  blocker: {
    code: 'polymarket_minimum_order',
    message: 'Polymarket requires a minimum order of 5 shares; exactly one share cannot execute.',
  },
  calculatedAt: '2026-08-14T12:01:00.000Z',
  executableQuantityMicros: 0,
  legs: executableEnvelopeFixture.legs.map((leg) => ({
    ...leg,
    executableQuantityMicros: 0,
    fillLevels: [],
    vwapPriceMicros: null,
    fee: leg.venue === 'polymarket'
      ? { basis: 'unavailable' as const, amountMicros: null, schedule: null }
      : leg.fee,
  })),
  totals: {
    grossCostMicros: null,
    grossPayoutMicros: null,
    grossProfitMicros: null,
    totalFeesMicros: null,
    netPnlMicros: null,
  },
};

const staleAuthority: CalculationEnvelope = {
  ...nonExecutableMinimum,
  status: 'unavailable',
  blocker: {
    code: 'stale_fee_authority',
    message: 'Fee schedule authority is stale; refresh before execution.',
  },
};

const chargedEarlyClose: CalculationEnvelope = {
  ...executableEnvelopeFixture,
  scope: 'position',
  calculatedAt: '2026-08-14T14:00:02.000Z',
  legs: executableEnvelopeFixture.legs.map((leg, index) => ({
    ...leg,
    action: 'sell' as const,
    bookObservedAt: `2026-08-14T14:00:0${index}.000Z`,
    fee: {
      basis: 'charged' as const,
      amountMicros: index === 0 ? 15_000 : 7_000,
      schedule: {
        source: index === 0 ? 'kalshi-fill-ledger' : 'polymarket-fill-ledger',
        version: index === 0 ? 'order:k-close-1' : 'trade:pm-close-1',
        observedAt: `2026-08-14T14:00:0${index}.500Z`,
        ratePpm: index === 0 ? 70_000 : 40_000,
      },
    },
  })),
  totals: {
    grossCostMicros: 0,
    grossPayoutMicros: 1_020_000,
    grossProfitMicros: 1_020_000,
    totalFeesMicros: 22_000,
    netPnlMicros: 998_000,
  },
};

const resolution: CalculationEnvelope = {
  ...chargedEarlyClose,
  calculatedAt: '2026-12-31T00:00:00.000Z',
  legs: chargedEarlyClose.legs.map((leg) => ({
    ...leg,
    action: 'buy' as const,
    fillLevels: [{ priceMicros: 1_000_000, quantityMicros: 1_000_000 }],
    vwapPriceMicros: 1_000_000,
    fee: {
      basis: 'charged' as const,
      amountMicros: 0,
      schedule: {
        source: 'venue-resolution-ledger',
        version: 'resolution:v1',
        observedAt: '2026-12-31T00:00:00.000Z',
        ratePpm: 0,
      },
    },
  })),
  totals: {
    grossCostMicros: 2_000_000,
    grossPayoutMicros: 1_000_000,
    grossProfitMicros: -1_000_000,
    totalFeesMicros: 0,
    netPnlMicros: -1_000_000,
  },
};

describe('CalculationProvenance', () => {
  it('renders canonical one-share gross/net, calculated fees, timestamps, and authority provenance', () => {
    render(<CalculationProvenance envelope={executableEnvelopeFixture} />);

    expect(screen.getByText('Executable')).toBeTruthy();
    expect(screen.getByText('Requested 1 share')).toBeTruthy();
    expect(screen.getByText('Executable 1 share')).toBeTruthy();
    expect(screen.getByText('Gross profit').parentElement?.textContent).toContain('$0.02');
    expect(screen.getByText('Net P&L').parentElement?.textContent).toContain('-$0.00856');
    expect(screen.getByText(/Calculated entry fee \$0\.02/)).toBeTruthy();
    expect(screen.getByText(/Calculated entry fee \$0\.00856/)).toBeTruthy();
    expect(screen.getByText(/kalshi-api\/event-series · sha256:k-fee-v1/)).toBeTruthy();
    expect(screen.getAllByText(/Book observed/)).toHaveLength(2);
    expect(screen.getByText(/Calculated at/)).toBeTruthy();
  });

  it('shows the venue minimum blocker and never renders unverifiable nulls as zero', () => {
    const { container } = render(<CalculationProvenance envelope={nonExecutableMinimum} />);

    expect(screen.getByText('Non-executable')).toBeTruthy();
    expect(screen.getByText(/minimum order of 5 shares/)).toBeTruthy();
    expect(screen.getByText('Executable 0 shares')).toBeTruthy();
    expect(screen.getByText('Fee unavailable')).toBeTruthy();
    expect(container.textContent).not.toContain('$0.00');
  });

  it('surfaces stale authority as unavailable with explicit provenance state', () => {
    render(<CalculationProvenance envelope={staleAuthority} compact />);
    expect(screen.getAllByText('Unavailable').length).toBeGreaterThan(0);
    expect(screen.getByText(/Fee schedule authority is stale/)).toBeTruthy();
  });

  it('distinguishes charged early-close exit fees from calculated entry fees', () => {
    render(<CalculationProvenance envelope={chargedEarlyClose} />);
    expect(screen.getAllByText(/Charged exit fee/)).toHaveLength(2);
    expect(screen.getByText(/kalshi-fill-ledger · order:k-close-1/)).toBeTruthy();
  });

  it('keeps an explicitly charged zero resolution fee distinct from unavailable', () => {
    render(<CalculationProvenance envelope={resolution} />);
    expect(screen.getAllByText('Charged entry fee $0.00')).toHaveLength(2);
    expect(screen.queryByText('Fee unavailable')).toBeNull();
    expect(screen.getAllByText(/venue-resolution-ledger · resolution:v1/)).toHaveLength(2);
  });

  it('renders legacy rows as unverifiable rather than inventing money values', () => {
    const legacy: CalculationEnvelope = {
      ...nonExecutableMinimum,
      status: 'legacy_unverifiable',
      blocker: {
        code: 'legacy_missing_calculation_authority',
        message: 'Legacy row predates the canonical calculation envelope.',
      },
      calculatedAt: null,
      requestedQuantityMicros: null,
      executableQuantityMicros: null,
      legs: [],
    };
    const { container } = render(<CalculationProvenance envelope={legacy} />);
    expect(screen.getByText('Legacy / unverifiable')).toBeTruthy();
    expect(screen.getByText(/predates the canonical calculation envelope/)).toBeTruthy();
    expect(container.textContent).not.toContain('$0.00');
  });

  it('uses a horizontally scrollable compact grid on narrow screens', () => {
    const { container } = render(<CalculationProvenance envelope={executableEnvelopeFixture} />);
    expect(container.querySelector('[data-testid="calculation-provenance"]')?.className).toContain('overflow-x-auto');
    expect(container.querySelector('[data-testid="calculation-provenance-legs"]')?.className).toContain('min-w-[36rem]');
  });
});
