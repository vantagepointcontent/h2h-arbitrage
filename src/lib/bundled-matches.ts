export type CouplingOrientation = 'same' | 'inverted';
export type ContractSide = 'yes' | 'no';

export interface OutcomeRange {
  /** Percentage basis points (20% = 2000); null is unbounded. */
  minBps: number | null;
  minInclusive: boolean;
  maxBps: number | null;
  maxInclusive: boolean;
}

export interface BundleLeg {
  id: string;
  platform: 'kalshi' | 'polymarket';
  marketId: string;
  title: string;
  originalSide: ContractSide;
  orientation: CouplingOrientation;
  priceCents: number;
  payoutCents: number;
  feeBps: number;
  quantityStep: number;
  minimumQuantity: number;
  maximumQuantity: number;
  range: OutcomeRange;
}

export interface BundleCoverageResult {
  valid: boolean;
  errors: string[];
}

export interface BundleAllocation {
  legId: string;
  originalSide: ContractSide;
  normalizedSide: ContractSide;
  quantity: number;
  principalCents: number;
  feeCents: number;
  costCents: number;
  payoutCents: number;
}

export interface BundleAllocationResult {
  executable: boolean;
  reasons: string[];
  budgetCents: number;
  totalCostCents: number;
  roundingResidualCents: number;
  allocations: BundleAllocation[];
  outcomes: Array<{ winningLegId: string; payoutCents: number; netProfitCents: number; roiBps: number }>;
  worstCaseNetProfitCents: number;
  worstCaseRoiBps: number;
}

function safeInteger(value: number, name: string, minimum = 0): void {
  if (!Number.isSafeInteger(value) || value < minimum) throw new Error(`${name} must be a safe integer >= ${minimum}`);
}

export function normalizeBundleSide(leg: Pick<BundleLeg, 'originalSide' | 'orientation'>): ContractSide {
  return leg.orientation === 'inverted' ? (leg.originalSide === 'yes' ? 'no' : 'yes') : leg.originalSide;
}

export function validateBundleCoverage(legs: readonly BundleLeg[], target: OutcomeRange): BundleCoverageResult {
  const errors: string[] = [];
  if (legs.length < 2) errors.push('A bundle must contain at least two outcome legs');

  const contracts = new Set<string>();
  for (const leg of legs) {
    const key = `${leg.platform}:${leg.marketId.toLowerCase()}:${leg.originalSide}`;
    if (contracts.has(key)) errors.push(`Duplicate contract-side selected: ${leg.platform} ${leg.marketId} ${leg.originalSide}`);
    contracts.add(key);
    if (leg.range.minBps != null && leg.range.maxBps != null && leg.range.minBps >= leg.range.maxBps) {
      errors.push(`Invalid range for ${leg.title}`);
    }
  }

  const sorted = [...legs].sort((a, b) => (a.range.minBps ?? Number.NEGATIVE_INFINITY) - (b.range.minBps ?? Number.NEGATIVE_INFINITY));
  if (sorted.length > 0) {
    const first = sorted[0].range;
    const last = sorted[sorted.length - 1].range;
    if (first.minBps !== target.minBps || (first.minBps != null && first.minInclusive !== target.minInclusive)) {
      errors.push('Bundle start does not match the target boundary');
    }
    if (last.maxBps !== target.maxBps || (last.maxBps != null && last.maxInclusive !== target.maxInclusive)) {
      errors.push('Bundle end does not match the target boundary');
    }
  }

  for (let index = 1; index < sorted.length; index += 1) {
    const previous = sorted[index - 1].range;
    const current = sorted[index].range;
    if (previous.maxBps == null || current.minBps == null) {
      errors.push('Unbounded outcome ranges overlap');
      continue;
    }
    if (previous.maxBps < current.minBps) errors.push(`Gap between ${previous.maxBps} and ${current.minBps}`);
    else if (previous.maxBps > current.minBps) errors.push(`Overlap between ${current.minBps} and ${previous.maxBps}`);
    else if (previous.maxInclusive === current.minInclusive) {
      errors.push(previous.maxInclusive ? `Overlap at boundary ${current.minBps}` : `Gap at boundary ${current.minBps}`);
    }
  }

  return { valid: errors.length === 0, errors };
}

function feeCents(principalCents: number, feeBps: number): number {
  return Math.ceil((principalCents * feeBps) / 10_000);
}

function legCost(leg: BundleLeg, quantity: number): number {
  const principal = leg.priceCents * quantity;
  return principal + feeCents(principal, leg.feeBps);
}

export function allocateBundleBudget(legs: readonly BundleLeg[], budgetCents: number): BundleAllocationResult {
  safeInteger(budgetCents, 'budgetCents', 1);
  const reasons: string[] = [];
  for (const leg of legs) {
    safeInteger(leg.priceCents, `${leg.id}.priceCents`, 1);
    safeInteger(leg.payoutCents, `${leg.id}.payoutCents`, 1);
    safeInteger(leg.feeBps, `${leg.id}.feeBps`);
    safeInteger(leg.quantityStep, `${leg.id}.quantityStep`, 1);
    safeInteger(leg.minimumQuantity, `${leg.id}.minimumQuantity`);
    safeInteger(leg.maximumQuantity, `${leg.id}.maximumQuantity`);
    if (leg.minimumQuantity > leg.maximumQuantity) reasons.push(`${leg.title}: minimum order exceeds available liquidity`);
  }

  const quantities = legs.map(leg => Math.ceil(leg.minimumQuantity / leg.quantityStep) * leg.quantityStep);
  let totalCost = legs.reduce((sum, leg, index) => sum + legCost(leg, quantities[index]), 0);
  if (totalCost > budgetCents) reasons.push('Budget cannot satisfy every leg minimum order after fees');

  if (totalCost <= budgetCents) {
    while (true) {
      const candidates = legs
        .map((leg, index) => ({ leg, index, payout: quantities[index] * leg.payoutCents }))
        .filter(({ leg, index }) => quantities[index] + leg.quantityStep <= leg.maximumQuantity)
        .sort((a, b) => a.payout - b.payout || a.index - b.index);
      let added = false;
      for (const candidate of candidates) {
        const nextQuantity = quantities[candidate.index] + candidate.leg.quantityStep;
        const incremental = legCost(candidate.leg, nextQuantity) - legCost(candidate.leg, quantities[candidate.index]);
        if (totalCost + incremental <= budgetCents) {
          quantities[candidate.index] = nextQuantity;
          totalCost += incremental;
          added = true;
          break;
        }
      }
      if (!added) break;
    }
  }

  const allocations = legs.map((leg, index): BundleAllocation => {
    const quantity = quantities[index];
    const principalCents = quantity * leg.priceCents;
    const fee = feeCents(principalCents, leg.feeBps);
    return {
      legId: leg.id, originalSide: leg.originalSide, normalizedSide: normalizeBundleSide(leg), quantity,
      principalCents, feeCents: fee, costCents: principalCents + fee, payoutCents: quantity * leg.payoutCents,
    };
  });
  totalCost = allocations.reduce((sum, allocation) => sum + allocation.costCents, 0);
  const outcomes = allocations.map(allocation => {
    const netProfitCents = allocation.payoutCents - totalCost;
    return {
      winningLegId: allocation.legId,
      payoutCents: allocation.payoutCents,
      netProfitCents,
      roiBps: totalCost > 0 ? Math.trunc((netProfitCents * 10_000) / totalCost) : 0,
    };
  });
  const worstCaseNetProfitCents = outcomes.length ? Math.min(...outcomes.map(outcome => outcome.netProfitCents)) : -totalCost;
  const worstCaseRoiBps = totalCost > 0 ? Math.trunc((worstCaseNetProfitCents * 10_000) / totalCost) : 0;
  if (legs.some((leg, index) => quantities[index] === 0 || leg.maximumQuantity === 0)) reasons.push('One or more legs have no executable liquidity');
  if (worstCaseNetProfitCents < 0) reasons.push('Allocation cannot guarantee a non-negative result after fees and rounding');

  return {
    executable: reasons.length === 0,
    reasons,
    budgetCents,
    totalCostCents: totalCost,
    roundingResidualCents: budgetCents - totalCost,
    allocations,
    outcomes,
    worstCaseNetProfitCents,
    worstCaseRoiBps,
  };
}
