export type SettlementVenue = 'kalshi' | 'polymarket';
export type SettlementSide = 'yes' | 'no';
export type SettlementExecutionMode = 'paper' | 'live';
export type SettlementExposureState =
  | 'filled'
  | 'partial_fill'
  | 'zero_fill'
  | 'failed'
  | 'rolled_back'
  | 'closed'
  | 'unknown';
export type SettlementLegLifecycleState =
  | 'open'
  | 'resolution_detected'
  | 'settlement_pending'
  | 'redeemable'
  | 'settled'
  | 'redeemed'
  | 'reconciled'
  | 'failed'
  | 'unresolved';
export type SettlementCreditState =
  | 'pending'
  | 'redeemable'
  | 'redeemed'
  | 'credited'
  | 'simulated_credited'
  | 'not_applicable';
export type SettlementPositionState =
  | 'open'
  | 'partially_settled'
  | 'settlement_pending'
  | 'settlement_unresolved'
  | 'settled';

export interface SettlementExecutionLegEvidence {
  venue: SettlementVenue;
  marketId: string | null;
  outcomeId: string | null;
  side: SettlementSide;
  requestedQuantity: number;
  filledQuantity: number | null;
  orderId: string | null;
  fillIds: string[];
  exposureState: SettlementExposureState;
  mode: SettlementExecutionMode;
}

export interface SettlementResolutionObservation {
  venue: SettlementVenue;
  marketId: string;
  outcomeId: string;
  winningSide: SettlementSide;
  resolvedAt: string;
  source: string;
  sourceVersion: string;
  creditState?: 'redeemable' | 'redeemed' | 'credited';
  creditedAt?: string;
  settlementFeeCents?: number;
}

export interface ReconciledSettlementLeg extends SettlementExecutionLegEvidence {
  lifecycleState: SettlementLegLifecycleState;
  resolutionWinningSide: SettlementSide | null;
  resolutionDetectedAt: string | null;
  resolutionSource: string | null;
  resolutionSourceVersion: string | null;
  payoutEntitlementCents: number | null;
  settlementFeeCents: number | null;
  netSettlementProceedsCents: number | null;
  creditState: SettlementCreditState;
  cashAvailableAt: string | null;
  failureReason: string | null;
  reconciledAt: string | null;
}

export interface SettlementLifecycleResult {
  positionState: SettlementPositionState;
  legs: ReconciledSettlementLeg[];
  grossSettlementProceedsCents: number | null;
  netSettlementProceedsCents: number | null;
  realizedPnlCents: number | null;
  realizedRoiBps: number | null;
  cashAvailableAt: string | null;
  failureReason: string | null;
  reconciledAt: string;
}

export interface ReconcileSettlementInput {
  positionId: number;
  executionMode: SettlementExecutionMode;
  buyCostCents: number;
  remainingOpenCostCents?: number;
  realizedPnlBeforeSettlementCents: number;
  legs: SettlementExecutionLegEvidence[];
  resolutions: SettlementResolutionObservation[];
  priorLegs?: ReconciledSettlementLeg[];
  observedAt: string;
}

const EXACT_LEG_EVIDENCE_MISSING = 'Settlement unresolved — exact legacy leg evidence missing';

function assertSafeNonNegativeInteger(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new Error(`${label} must be a non-negative safe integer`);
  }
}

function hasNoRemainingExposure(leg: SettlementExecutionLegEvidence): boolean {
  return leg.exposureState === 'zero_fill'
    || leg.exposureState === 'failed'
    || leg.exposureState === 'rolled_back'
    || leg.exposureState === 'closed';
}

function unresolvedLeg(leg: SettlementExecutionLegEvidence, reason: string): ReconciledSettlementLeg {
  return {
    ...leg,
    lifecycleState: 'unresolved',
    resolutionWinningSide: null,
    resolutionDetectedAt: null,
    resolutionSource: null,
    resolutionSourceVersion: null,
    payoutEntitlementCents: null,
    settlementFeeCents: null,
    netSettlementProceedsCents: null,
    creditState: 'pending',
    cashAvailableAt: null,
    failureReason: reason,
    reconciledAt: null,
  };
}

function openLeg(leg: SettlementExecutionLegEvidence): ReconciledSettlementLeg {
  return {
    ...leg,
    lifecycleState: 'open',
    resolutionWinningSide: null,
    resolutionDetectedAt: null,
    resolutionSource: null,
    resolutionSourceVersion: null,
    payoutEntitlementCents: null,
    settlementFeeCents: null,
    netSettlementProceedsCents: null,
    creditState: 'pending',
    cashAvailableAt: null,
    failureReason: null,
    reconciledAt: null,
  };
}

function failedLeg(
  leg: SettlementExecutionLegEvidence,
  prior: ReconciledSettlementLeg | undefined,
  reason: string,
): ReconciledSettlementLeg {
  return {
    ...(prior ?? openLeg(leg)),
    lifecycleState: 'failed',
    payoutEntitlementCents: null,
    settlementFeeCents: null,
    netSettlementProceedsCents: null,
    creditState: 'pending',
    cashAvailableAt: null,
    failureReason: reason,
    reconciledAt: null,
  };
}

function resolutionFor(
  leg: SettlementExecutionLegEvidence,
  observations: SettlementResolutionObservation[],
): SettlementResolutionObservation | null {
  const matches = observations.filter((observation) => observation.venue === leg.venue
    && observation.marketId.trim().toLowerCase() === leg.marketId!.trim().toLowerCase()
    && observation.outcomeId.trim().toLowerCase() === leg.outcomeId!.trim().toLowerCase());
  if (matches.length > 1) {
    const winner = new Set(matches.map((match) => match.winningSide));
    if (winner.size > 1) throw new Error(`Conflicting authoritative resolution observations for ${leg.venue}`);
  }
  return matches[0] ?? null;
}

function reconcileResolvedLeg(
  leg: SettlementExecutionLegEvidence,
  observation: SettlementResolutionObservation,
  executionMode: SettlementExecutionMode,
  observedAt: string,
): ReconciledSettlementLeg {
  const quantity = leg.filledQuantity!;
  const payoutEntitlementCents = leg.side === observation.winningSide ? quantity * 100 : 0;
  assertSafeNonNegativeInteger(payoutEntitlementCents, `${leg.venue} payout entitlement`);
  const settlementFeeCents = observation.settlementFeeCents ?? 0;
  assertSafeNonNegativeInteger(settlementFeeCents, `${leg.venue} settlement fee`);
  if (settlementFeeCents > payoutEntitlementCents) {
    return failedLeg(leg, undefined, `${leg.venue} settlement fee exceeds payout entitlement`);
  }
  const netSettlementProceedsCents = payoutEntitlementCents - settlementFeeCents;

  if (payoutEntitlementCents === 0) {
    return {
      ...leg,
      lifecycleState: 'reconciled',
      resolutionWinningSide: observation.winningSide,
      resolutionDetectedAt: observation.resolvedAt,
      resolutionSource: observation.source,
      resolutionSourceVersion: observation.sourceVersion,
      payoutEntitlementCents,
      settlementFeeCents,
      netSettlementProceedsCents,
      creditState: 'not_applicable',
      cashAvailableAt: observation.resolvedAt,
      failureReason: null,
      reconciledAt: observedAt,
    };
  }

  if (executionMode === 'paper') {
    return {
      ...leg,
      lifecycleState: 'reconciled',
      resolutionWinningSide: observation.winningSide,
      resolutionDetectedAt: observation.resolvedAt,
      resolutionSource: observation.source,
      resolutionSourceVersion: observation.sourceVersion,
      payoutEntitlementCents,
      settlementFeeCents,
      netSettlementProceedsCents,
      creditState: 'simulated_credited',
      cashAvailableAt: observedAt,
      failureReason: null,
      reconciledAt: observedAt,
    };
  }

  const creditState = observation.creditState ?? 'pending';
  const lifecycleState: SettlementLegLifecycleState = creditState === 'credited'
    ? 'reconciled'
    : creditState === 'redeemed'
      ? 'redeemed'
      : creditState === 'redeemable'
        ? 'redeemable'
        : 'settlement_pending';
  const cashAvailableAt = creditState === 'credited' ? observation.creditedAt ?? null : null;
  return {
    ...leg,
    lifecycleState,
    resolutionWinningSide: observation.winningSide,
    resolutionDetectedAt: observation.resolvedAt,
    resolutionSource: observation.source,
    resolutionSourceVersion: observation.sourceVersion,
    payoutEntitlementCents,
    settlementFeeCents,
    netSettlementProceedsCents,
    creditState,
    cashAvailableAt,
    failureReason: creditState === 'credited' && cashAvailableAt == null
      ? 'Authoritative credit timestamp is missing'
      : creditState === 'pending'
        ? 'Resolved; awaiting authoritative venue redemption or credit evidence'
        : null,
    reconciledAt: lifecycleState === 'reconciled' ? observedAt : null,
  };
}

function noExposureLeg(leg: SettlementExecutionLegEvidence, observedAt: string): ReconciledSettlementLeg {
  return {
    ...leg,
    lifecycleState: 'reconciled',
    resolutionWinningSide: null,
    resolutionDetectedAt: null,
    resolutionSource: 'execution_exposure_evidence',
    resolutionSourceVersion: `exposure:${leg.exposureState}`,
    payoutEntitlementCents: 0,
    settlementFeeCents: 0,
    netSettlementProceedsCents: 0,
    creditState: 'not_applicable',
    cashAvailableAt: null,
    failureReason: leg.exposureState === 'failed' ? 'Order failed with no authoritative positive fill' : null,
    reconciledAt: observedAt,
  };
}

export function reconcileSettlementLifecycle(input: ReconcileSettlementInput): SettlementLifecycleResult {
  assertSafeNonNegativeInteger(input.positionId, 'positionId');
  assertSafeNonNegativeInteger(input.buyCostCents, 'buyCostCents');
  assertSafeNonNegativeInteger(input.remainingOpenCostCents ?? input.buyCostCents, 'remainingOpenCostCents');
  if (!Number.isSafeInteger(input.realizedPnlBeforeSettlementCents)) {
    throw new Error('realizedPnlBeforeSettlementCents must be safe integer cents');
  }
  if (!Number.isFinite(Date.parse(input.observedAt))) throw new Error('observedAt must be an ISO timestamp');
  if (input.legs.length !== 2 || new Set(input.legs.map((leg) => leg.venue)).size !== 2) {
    throw new Error('A cross-venue position requires exactly one leg per venue');
  }

  const priorByVenue = new Map(input.priorLegs?.map((leg) => [leg.venue, leg]));
  const resolvedByVenue = new Map<SettlementVenue, SettlementResolutionObservation | null>();
  let conflictReason: string | null = null;

  for (const leg of input.legs) {
    const prior = priorByVenue.get(leg.venue);
    if (!leg.marketId?.trim() || !leg.outcomeId?.trim() || !leg.orderId?.trim()
      || (leg.exposureState !== 'zero_fill' && leg.exposureState !== 'failed' && leg.fillIds.length === 0)) {
      resolvedByVenue.set(leg.venue, null);
      continue;
    }
    let observation: SettlementResolutionObservation | null = null;
    try {
      observation = resolutionFor(leg, input.resolutions);
    } catch (error) {
      conflictReason = error instanceof Error ? error.message : String(error);
    }
    if (prior?.resolutionWinningSide && observation
      && prior.resolutionWinningSide !== observation.winningSide) {
      conflictReason = `Conflicting authoritative resolution for ${leg.venue}`;
    }
    resolvedByVenue.set(leg.venue, observation);
  }

  if (conflictReason) {
    const reason = `Settlement unresolved — ${conflictReason}`;
    const legs = input.legs.map((leg) => failedLeg(leg, priorByVenue.get(leg.venue), reason));
    return {
      positionState: 'settlement_unresolved', legs,
      grossSettlementProceedsCents: null, netSettlementProceedsCents: null,
      realizedPnlCents: null, realizedRoiBps: null, cashAvailableAt: null,
      failureReason: reason, reconciledAt: input.observedAt,
    };
  }

  const legs = input.legs.map((leg): ReconciledSettlementLeg => {
    if (hasNoRemainingExposure(leg)) return noExposureLeg(leg, input.observedAt);
    if (leg.exposureState === 'unknown' || leg.filledQuantity == null
      || !Number.isSafeInteger(leg.filledQuantity) || leg.filledQuantity <= 0
      || !leg.marketId?.trim() || !leg.outcomeId?.trim() || !leg.orderId?.trim()
      || leg.fillIds.length === 0) {
      return unresolvedLeg(leg, EXACT_LEG_EVIDENCE_MISSING);
    }
    if (leg.mode !== input.executionMode || leg.requestedQuantity !== leg.filledQuantity) {
      return unresolvedLeg(leg, 'Settlement unresolved — execution mode or filled quantity evidence conflicts');
    }
    const observation = resolvedByVenue.get(leg.venue);
    const prior = priorByVenue.get(leg.venue);
    if (observation && prior?.resolutionWinningSide === observation.winningSide
      && prior.resolutionSourceVersion === observation.sourceVersion
      && prior.marketId === leg.marketId && prior.outcomeId === leg.outcomeId
      && prior.side === leg.side && prior.filledQuantity === leg.filledQuantity
      && prior.lifecycleState === 'reconciled') {
      return prior;
    }
    return observation
      ? reconcileResolvedLeg(leg, observation, input.executionMode, input.observedAt)
      : openLeg(leg);
  });

  if (legs.some((leg) => leg.lifecycleState === 'unresolved' || leg.lifecycleState === 'failed')) {
    const failureReason = legs.find((leg) => leg.failureReason)?.failureReason ?? EXACT_LEG_EVIDENCE_MISSING;
    return {
      positionState: 'settlement_unresolved', legs,
      grossSettlementProceedsCents: null, netSettlementProceedsCents: null,
      realizedPnlCents: null, realizedRoiBps: null, cashAvailableAt: null,
      failureReason, reconciledAt: input.observedAt,
    };
  }

  const openCount = legs.filter((leg) => leg.lifecycleState === 'open').length;
  const pendingCount = legs.filter((leg) => !['open', 'reconciled'].includes(leg.lifecycleState)).length;
  if (openCount > 0) {
    return {
      positionState: openCount === legs.length ? 'open' : 'partially_settled', legs,
      grossSettlementProceedsCents: null, netSettlementProceedsCents: null,
      realizedPnlCents: null, realizedRoiBps: null, cashAvailableAt: null,
      failureReason: null, reconciledAt: input.observedAt,
    };
  }
  if (pendingCount > 0) {
    return {
      positionState: 'settlement_pending', legs,
      grossSettlementProceedsCents: null, netSettlementProceedsCents: null,
      realizedPnlCents: null, realizedRoiBps: null, cashAvailableAt: null,
      failureReason: legs.find((leg) => leg.failureReason)?.failureReason ?? 'Settlement credit reconciliation pending',
      reconciledAt: input.observedAt,
    };
  }

  const grossSettlementProceedsCents = legs.reduce((sum, leg) => sum + leg.payoutEntitlementCents!, 0);
  const netSettlementProceedsCents = legs.reduce((sum, leg) => sum + leg.netSettlementProceedsCents!, 0);
  const realizedPnlCents = input.realizedPnlBeforeSettlementCents
    + netSettlementProceedsCents - (input.remainingOpenCostCents ?? input.buyCostCents);
  const realizedRoiBps = input.buyCostCents > 0
    ? Math.round(realizedPnlCents * 10_000 / input.buyCostCents)
    : null;
  const cashTimes = legs.flatMap((leg) => leg.cashAvailableAt ? [leg.cashAvailableAt] : []);
  const cashAvailableAt = cashTimes.length > 0 ? cashTimes.sort().at(-1)! : input.observedAt;
  const legReconciledTimes = legs.flatMap((leg) => leg.reconciledAt ? [leg.reconciledAt] : []);
  const reconciledAt = legReconciledTimes.length === legs.length
    ? legReconciledTimes.sort().at(-1)!
    : input.observedAt;
  return {
    positionState: 'settled', legs, grossSettlementProceedsCents, netSettlementProceedsCents,
    realizedPnlCents, realizedRoiBps, cashAvailableAt, failureReason: null,
    reconciledAt,
  };
}
