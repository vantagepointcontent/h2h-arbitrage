import {
  CALCULATION_ENVELOPE_VERSION,
  MONEY_SCALE,
  type CalculationEnvelope,
} from '../calculation-envelope';

/** Audit Scenario A/B: one Kalshi YES at .67 plus one Polymarket NO at .31. */
export const executableEnvelopeFixture: CalculationEnvelope = {
  version: CALCULATION_ENVELOPE_VERSION,
  scope: 'opportunity',
  status: 'executable',
  blocker: null,
  calculatedAt: '2026-08-14T12:00:02.000Z',
  requestedQuantityMicros: 1_000_000,
  executableQuantityMicros: 1_000_000,
  legs: [
    {
      venue: 'kalshi', instrumentId: 'KX-POL-YES', outcomeId: 'YES', side: 'yes', action: 'buy',
      requestedQuantityMicros: 1_000_000, executableQuantityMicros: 1_000_000,
      bookObservedAt: '2026-08-14T12:00:00.000Z',
      fillLevels: [{ priceMicros: 670_000, quantityMicros: 1_000_000 }],
      vwapPriceMicros: 670_000,
      fee: {
        basis: 'calculated', amountMicros: 20_000,
        schedule: {
          source: 'kalshi-api/event-series', version: 'sha256:k-fee-v1',
          observedAt: '2026-08-14T11:59:59.000Z', ratePpm: 70_000,
        },
      },
    },
    {
      venue: 'polymarket', instrumentId: 'pm-no-token-1', outcomeId: 'NO', side: 'no', action: 'buy',
      requestedQuantityMicros: 1_000_000, executableQuantityMicros: 1_000_000,
      bookObservedAt: '2026-08-14T12:00:01.000Z',
      fillLevels: [{ priceMicros: 310_000, quantityMicros: 1_000_000 }],
      vwapPriceMicros: 310_000,
      fee: {
        basis: 'calculated', amountMicros: 8_560,
        schedule: {
          source: 'gamma-api/feeSchedule', version: 'sha256:pm-fee-v1',
          observedAt: '2026-08-14T11:59:58.000Z', ratePpm: 40_000,
        },
      },
    },
  ],
  totals: {
    grossCostMicros: 980_000,
    grossPayoutMicros: 1_000_000,
    grossProfitMicros: 20_000,
    totalFeesMicros: 28_560,
    netPnlMicros: -8_560,
  },
  rounding: {
    moneyScale: MONEY_SCALE,
    priceScale: 1_000_000,
    quantityScale: 1_000_000,
    mode: 'venue_rules_then_sum',
  },
};
