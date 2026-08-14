/**
 * Integer-cent execution cash accounting.
 *
 * Prices and quantities enter at the venue boundary as decimal numbers. They are
 * quantized once to integer micros; every monetary operation after that boundary
 * uses bigint and is returned as safe integer cents.
 */

export type ExecutionVenue = 'kalshi' | 'polymarket';
export type ExecutionFeeStage = 'entry' | 'exit';
export type ExecutionFeeSource = 'charged' | 'estimated';

export interface ExecutionLedgerLeg {
  venue: ExecutionVenue;
  filledContracts?: number | null;
  filledPrice?: number | null;
  chargedFeeCents?: number | null;
  orderTerminality?: 'terminal' | 'live' | 'indeterminate';
  terminalitySource?: 'venue-order-status' | 'latest-order-response' | 'post-cancel-poll' | 'simulation';
}

export interface ExecutionLedgerClose extends ExecutionLedgerLeg {
  requestedContracts: number;
  complete: boolean;
  /** Whether the close price came from venue fill evidence or the submitted limit. */
  priceSource: 'venue' | 'estimated';
}

export interface ExecutionLedgerInput {
  kalshiEntry: ExecutionLedgerLeg;
  polymarketEntry: ExecutionLedgerLeg;
  closes: ExecutionLedgerClose[];
  unhedged: boolean;
  /** Estimated Polymarket fee rate when a charged amount is unavailable. */
  polymarketFeeRateBps?: number;
}

export interface ExecutionLedgerFee {
  venue: ExecutionVenue;
  stage: ExecutionFeeStage;
  amountCents: number;
  source: ExecutionFeeSource;
  estimatedRateBps?: number;
}

export interface ExecutionLedgerCashFlow {
  kind: 'entry-principal' | 'expected-settlement' | 'exit-proceeds';
  venue?: ExecutionVenue;
  amountCents: number;
  source: 'venue' | 'estimated' | 'contract';
}

export interface ExecutionCashLedger {
  version: 1;
  status: 'reconciled' | 'reconciliation-required';
  matchedContracts: number;
  grossSpreadCents: number | null;
  entryPrincipalCents: number | null;
  expectedSettlementCents: number;
  exitProceedsCents: number | null;
  totalEntryFeesCents: number;
  totalExitFeesCents: number;
  netPnlCents: number | null;
  /** Non-authoritative projection retained only for operator disclosure. */
  estimatedNetPnlCents: number | null;
  feesEstimated: boolean;
  issues: string[];
  entryOrders: Array<{
    venue: ExecutionVenue;
    terminality: 'terminal' | 'live' | 'indeterminate';
    source: 'venue-order-status' | 'latest-order-response' | 'post-cancel-poll' | 'simulation' | 'missing';
  }>;
  fees: ExecutionLedgerFee[];
  cashFlows: ExecutionLedgerCashFlow[];
}

const MICRO_SCALE = 1_000_000n;
const MONEY_SCALE = MICRO_SCALE * MICRO_SCALE;
const DEFAULT_FEE_RATE_BPS: Record<ExecutionVenue, number> = {
  kalshi: 700,
  polymarket: 500,
};

function decimalMicros(value: number | null | undefined): bigint | null {
  if (value == null || !Number.isFinite(value) || value < 0) return null;
  const micros = Math.round(value * Number(MICRO_SCALE));
  return Number.isSafeInteger(micros) ? BigInt(micros) : null;
}

function divideRounded(numerator: bigint, denominator: bigint): bigint {
  return (numerator + denominator / 2n) / denominator;
}

function divideCeil(numerator: bigint, denominator: bigint): bigint {
  return (numerator + denominator - 1n) / denominator;
}

function safeCents(value: bigint): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result)) throw new Error('Execution ledger exceeds safe integer cents');
  return result;
}

function principalCents(contracts: number, price: number): number | null {
  const quantityMicros = decimalMicros(contracts);
  const priceMicros = decimalMicros(price);
  if (quantityMicros == null || priceMicros == null || priceMicros <= 0n || priceMicros >= MICRO_SCALE) return null;
  return safeCents(divideRounded(quantityMicros * priceMicros * 100n, MONEY_SCALE));
}

function sumKnown(values: Array<number | null>): number | null {
  return values.some((value) => value == null)
    ? null
    : values.reduce<number>((total, value) => total + Number(value), 0);
}

function payoutCents(contracts: number): number {
  const quantityMicros = decimalMicros(contracts);
  if (quantityMicros == null) return 0;
  return safeCents(divideRounded(quantityMicros * 100n, MICRO_SCALE));
}

function estimatedFeeCents(
  venue: ExecutionVenue,
  contracts: number,
  price: number,
  polymarketFeeRateBps: number,
): { amountCents: number; rateBps: number } {
  const quantityMicros = decimalMicros(contracts);
  const priceMicros = decimalMicros(price);
  const rateBps = venue === 'polymarket' ? polymarketFeeRateBps : DEFAULT_FEE_RATE_BPS.kalshi;
  if (quantityMicros == null || priceMicros == null || priceMicros <= 0n || priceMicros >= MICRO_SCALE) {
    return { amountCents: 0, rateBps };
  }
  const numerator = quantityMicros * priceMicros * (MICRO_SCALE - priceMicros) * BigInt(rateBps) * 100n;
  const denominator = MICRO_SCALE * MONEY_SCALE * 10_000n;
  const amount = venue === 'kalshi'
    ? divideCeil(numerator, denominator)
    : divideRounded(numerator, denominator);
  return { amountCents: safeCents(amount), rateBps };
}

function legQuantity(leg: ExecutionLedgerLeg): number {
  return leg.filledContracts != null && Number.isFinite(leg.filledContracts) && leg.filledContracts > 0
    ? leg.filledContracts
    : 0;
}

function legPrice(leg: ExecutionLedgerLeg): number {
  return leg.filledPrice != null && Number.isFinite(leg.filledPrice) && leg.filledPrice > 0 && leg.filledPrice < 1
    ? leg.filledPrice
    : 0;
}

function feeFor(
  leg: ExecutionLedgerLeg,
  stage: ExecutionFeeStage,
  polymarketFeeRateBps: number,
): ExecutionLedgerFee {
  if (Number.isSafeInteger(leg.chargedFeeCents) && Number(leg.chargedFeeCents) >= 0) {
    return {
      venue: leg.venue,
      stage,
      amountCents: Number(leg.chargedFeeCents),
      source: 'charged',
    };
  }
  const estimate = estimatedFeeCents(leg.venue, legQuantity(leg), legPrice(leg), polymarketFeeRateBps);
  return {
    venue: leg.venue,
    stage,
    amountCents: estimate.amountCents,
    source: 'estimated',
    estimatedRateBps: estimate.rateBps,
  };
}

export function reconcileExecutionCashLedger(input: ExecutionLedgerInput): ExecutionCashLedger {
  const polymarketFeeRateBps = Number.isSafeInteger(input.polymarketFeeRateBps)
    && Number(input.polymarketFeeRateBps) >= 0
    ? Number(input.polymarketFeeRateBps)
    : DEFAULT_FEE_RATE_BPS.polymarket;
  const entries = [input.kalshiEntry, input.polymarketEntry];
  const kalshiContracts = legQuantity(input.kalshiEntry);
  const polymarketContracts = legQuantity(input.polymarketEntry);
  const matchedContracts = Math.min(kalshiContracts, polymarketContracts);
  const entryPrincipals = entries
    .filter((leg) => legQuantity(leg) > 0)
    .map((leg) => principalCents(legQuantity(leg), legPrice(leg)));
  const entryPrincipalCents = sumKnown(entryPrincipals);
  const expectedSettlementCents = payoutCents(matchedContracts);
  const matchedPrincipalCents = matchedContracts > 0
    ? sumKnown([
      principalCents(matchedContracts, legPrice(input.kalshiEntry)),
      principalCents(matchedContracts, legPrice(input.polymarketEntry)),
    ])
    : 0;
  const grossSpreadCents = matchedPrincipalCents == null
    ? null
    : expectedSettlementCents - matchedPrincipalCents;
  const exitProceedsCents = sumKnown(input.closes
    .filter((close) => legQuantity(close) > 0)
    .map((close) => principalCents(legQuantity(close), legPrice(close))));

  const fees = [
    ...entries.filter((leg) => legQuantity(leg) > 0).map((leg) => feeFor(leg, 'entry', polymarketFeeRateBps)),
    ...input.closes.filter((leg) => legQuantity(leg) > 0).map((leg) => feeFor(leg, 'exit', polymarketFeeRateBps)),
  ];
  const totalEntryFeesCents = fees
    .filter((fee) => fee.stage === 'entry')
    .reduce((total, fee) => total + fee.amountCents, 0);
  const totalExitFeesCents = fees
    .filter((fee) => fee.stage === 'exit')
    .reduce((total, fee) => total + fee.amountCents, 0);

  const closedByVenue = (venue: ExecutionVenue) => input.closes
    .filter((close) => close.venue === venue && close.complete)
    .reduce((total, close) => total + legQuantity(close), 0);
  const residualKalshi = kalshiContracts - closedByVenue('kalshi');
  const residualPolymarket = polymarketContracts - closedByVenue('polymarket');
  const quantitiesReconciled = Math.abs(residualKalshi - matchedContracts) < 1e-6
    && Math.abs(residualPolymarket - matchedContracts) < 1e-6;
  const closesComplete = input.closes.every((close) => close.complete);
  const feesEstimated = fees.some((fee) => fee.source === 'estimated');
  const entryOrders: ExecutionCashLedger['entryOrders'] = entries.map((leg) => ({
    venue: leg.venue,
    terminality: leg.orderTerminality ?? 'indeterminate',
    source: leg.terminalitySource ?? 'missing',
  }));
  const entriesTerminal = entryOrders.every((entry) => entry.terminality === 'terminal');
  const issues = [
    ...entries
      .filter((leg) => leg.filledContracts == null || !Number.isFinite(leg.filledContracts) || leg.filledContracts < 0)
      .map((leg) => `unknown-entry-quantity:${leg.venue}`),
    ...input.closes
      .filter((close) => close.filledContracts == null || !Number.isFinite(close.filledContracts) || close.filledContracts < 0)
      .map((close) => `unknown-exit-quantity:${close.venue}`),
    ...entries
      .filter((leg) => legQuantity(leg) > 0 && principalCents(legQuantity(leg), legPrice(leg)) == null)
      .map((leg) => `missing-entry-price:${leg.venue}`),
    ...input.closes
      .filter((close) => legQuantity(close) > 0 && principalCents(legQuantity(close), legPrice(close)) == null)
      .map((close) => `missing-exit-price:${close.venue}`),
    ...(input.closes.some((close) => close.priceSource === 'estimated' && legQuantity(close) > 0)
      ? ['estimated-exit-proceeds'] : []),
    ...(feesEstimated ? ['estimated-fees'] : []),
    ...entryOrders
      .filter((entry) => entry.terminality !== 'terminal')
      .map((entry) => `entry-order-not-terminal:${entry.venue}:${entry.terminality}`),
    ...(!closesComplete ? ['close-not-terminally-verified'] : []),
    ...(!quantitiesReconciled ? ['quantity-mismatch'] : []),
    ...(input.unhedged ? ['unhedged-exposure'] : []),
  ];
  const status = issues.length === 0
    ? 'reconciled'
    : 'reconciliation-required';
  const netPnlCents = status === 'reconciled'
    && entryPrincipalCents != null && exitProceedsCents != null
    ? expectedSettlementCents + exitProceedsCents - entryPrincipalCents
      - totalEntryFeesCents - totalExitFeesCents
    : null;
  const estimatedNetPnlCents = entriesTerminal && !input.unhedged && closesComplete && quantitiesReconciled
    && entryPrincipalCents != null && exitProceedsCents != null
    ? expectedSettlementCents + exitProceedsCents - entryPrincipalCents
      - totalEntryFeesCents - totalExitFeesCents
    : null;

  const cashFlows: ExecutionLedgerCashFlow[] = [
    ...entries.filter((leg) => legQuantity(leg) > 0 && principalCents(legQuantity(leg), legPrice(leg)) != null).map((leg) => ({
      kind: 'entry-principal' as const,
      venue: leg.venue,
      amountCents: -Number(principalCents(legQuantity(leg), legPrice(leg))),
      source: 'venue' as const,
    })),
    ...(expectedSettlementCents > 0 ? [{
      kind: 'expected-settlement' as const,
      amountCents: expectedSettlementCents,
      source: 'contract' as const,
    }] : []),
    ...input.closes.filter((close) => legQuantity(close) > 0 && principalCents(legQuantity(close), legPrice(close)) != null).map((close) => ({
      kind: 'exit-proceeds' as const,
      venue: close.venue,
      amountCents: Number(principalCents(legQuantity(close), legPrice(close))),
      source: close.priceSource,
    })),
  ];

  return {
    version: 1,
    status,
    matchedContracts,
    grossSpreadCents,
    entryPrincipalCents,
    expectedSettlementCents,
    exitProceedsCents,
    totalEntryFeesCents,
    totalExitFeesCents,
    netPnlCents,
    estimatedNetPnlCents,
    feesEstimated,
    issues,
    entryOrders,
    fees,
    cashFlows,
  };
}
