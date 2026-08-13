import { validateBundleCoverage, type BundleLeg, type OutcomeRange } from './bundled-matches';

export interface BundledMatchInput {
  name: string;
  budgetCents: number;
  targetRange: OutcomeRange;
  legs: BundleLeg[];
  marketId?: string;
}

function safeInteger(value: unknown, name: string, minimum = 0): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`${name} must be a safe integer >= ${minimum}`);
  }
  return value;
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} must be a non-empty string`);
  return value.trim();
}

function range(value: unknown, name: string): OutcomeRange {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name} must be an outcome range`);
  const object = value as Record<string, unknown>;
  const bound = (item: unknown, field: string): number | null => {
    if (item === null) return null;
    return safeInteger(item, `${name}.${field}`);
  };
  if (typeof object.minInclusive !== 'boolean' || typeof object.maxInclusive !== 'boolean') {
    throw new Error(`${name} inclusivity values must be boolean`);
  }
  return {
    minBps: bound(object.minBps, 'minBps'), minInclusive: object.minInclusive,
    maxBps: bound(object.maxBps, 'maxBps'), maxInclusive: object.maxInclusive,
  };
}

function parseLeg(value: unknown, index: number): BundleLeg {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`legs[${index}] must be an object`);
  const object = value as Record<string, unknown>;
  if (object.platform !== 'kalshi' && object.platform !== 'polymarket') throw new Error(`legs[${index}].platform is invalid`);
  if (object.originalSide !== 'yes' && object.originalSide !== 'no') throw new Error(`legs[${index}].originalSide is invalid`);
  if (object.orientation !== 'same' && object.orientation !== 'inverted') throw new Error(`legs[${index}].orientation must be same or inverted`);
  return {
    id: requiredString(object.id, `legs[${index}].id`),
    platform: object.platform,
    marketId: requiredString(object.marketId, `legs[${index}].marketId`),
    title: requiredString(object.title, `legs[${index}].title`),
    originalSide: object.originalSide,
    orientation: object.orientation,
    priceCents: safeInteger(object.priceCents, `legs[${index}].priceCents`, 1),
    payoutCents: safeInteger(object.payoutCents, `legs[${index}].payoutCents`, 1),
    feeBps: safeInteger(object.feeBps, `legs[${index}].feeBps`),
    quantityStep: safeInteger(object.quantityStep, `legs[${index}].quantityStep`, 1),
    minimumQuantity: safeInteger(object.minimumQuantity, `legs[${index}].minimumQuantity`),
    maximumQuantity: safeInteger(object.maximumQuantity, `legs[${index}].maximumQuantity`),
    range: range(object.range, `legs[${index}].range`),
  };
}

export function parseBundledMatchInput(body: unknown): BundledMatchInput | { error: string } {
  try {
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Request body must be an object');
    const object = body as Record<string, unknown>;
    if (!Array.isArray(object.legs)) throw new Error('legs must be an array');
    const result: BundledMatchInput = {
      name: requiredString(object.name, 'name'),
      budgetCents: safeInteger(object.budgetCents, 'budgetCents', 1),
      targetRange: range(object.targetRange, 'targetRange'),
      legs: object.legs.map(parseLeg),
      ...(typeof object.marketId === 'string' && object.marketId.trim() ? { marketId: object.marketId.trim() } : {}),
    };
    const coverage = validateBundleCoverage(result.legs, result.targetRange);
    if (!coverage.valid) return { error: coverage.errors.join('; ') };
    return result;
  } catch (error) {
    return { error: error instanceof Error ? error.message : 'Invalid bundled match input' };
  }
}
