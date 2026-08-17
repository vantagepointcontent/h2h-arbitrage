import { describe, expect, it } from 'vitest';
import {
  validatePropositionRelationship,
  type PropositionIdentity,
  type PropositionRelationship,
} from './proposition-identity';

const EVENT_STATES = ['democratic', 'republican'] as const;

function leg(overrides: Partial<PropositionIdentity> = {}): PropositionIdentity {
  return {
    platform: 'kalshi',
    platformMarketId: 'KXHOUSERACE-FL26-26-D',
    parentEventId: 'fl-26-house-2026',
    selectedOutcome: 'democratic',
    contractSide: 'yes',
    payoutState: 'democratic',
    eventPayoutStates: [...EVENT_STATES],
    resolutionRuleId: 'fl-26-house-2026-rules-v1',
    humanLabel: 'Kalshi YES — Democratic Party wins FL-26',
    marketQuestion: 'Will Democratic win the House race for FL-26?',
    tokenId: null,
    ...overrides,
  };
}

function relationship(
  kalshi: PropositionIdentity,
  polymarket: PropositionIdentity,
  overrides: Partial<PropositionRelationship> = {},
): PropositionRelationship {
  return {
    schemaVersion: 1,
    state: 'verified_complementary',
    verificationSource: 'authoritative_platform_metadata',
    verifiedAt: '2026-08-17T13:50:00.000Z',
    parentEventId: 'fl-26-house-2026',
    resolutionRuleId: 'fl-26-house-2026-rules-v1',
    exhaustivePayoutStates: [...EVENT_STATES],
    legs: { kalshi, polymarket },
    humanLabel: `${kalshi.humanLabel} ↔ ${polymarket.humanLabel}`,
    ...overrides,
  };
}

const pmYesRepublican = () => leg({
  platform: 'polymarket',
  platformMarketId: '0xrep',
  selectedOutcome: 'republican',
  contractSide: 'yes',
  payoutState: 'republican',
  tokenId: 'pm-republican-yes',
  humanLabel: 'Polymarket YES — Republican Party wins FL-26',
  marketQuestion: 'Will the Republican Party win the FL-26 House seat?',
});

it('accepts opposite-proposition YES+YES only when exact payout states are complementary', () => {
  expect(validatePropositionRelationship(relationship(leg(), pmYesRepublican()))).toEqual({ valid: true });
});

it('rejects same-proposition YES+YES exposure', () => {
  const pmDemocratic = leg({
    platform: 'polymarket', platformMarketId: '0xdem', tokenId: 'pm-democratic-yes',
    humanLabel: 'Polymarket YES — Democratic Party wins FL-26',
  });
  expect(validatePropositionRelationship(relationship(leg(), pmDemocratic))).toMatchObject({
    valid: false,
    state: 'same_direction_invalid',
  });
});

it('accepts YES/NO mapping when NO pays the opposite exhaustive state', () => {
  const pmNoDemocratic = leg({
    platform: 'polymarket', platformMarketId: '0xdem', tokenId: 'pm-democratic-no',
    contractSide: 'no', payoutState: 'republican',
    humanLabel: 'Polymarket NO — Democratic Party wins FL-26',
  });
  expect(validatePropositionRelationship(relationship(leg(), pmNoDemocratic))).toEqual({ valid: true });
});

it('rejects token-side inversion when the declared payout state contradicts the contract side', () => {
  const inverted = pmYesRepublican();
  inverted.contractSide = 'no';
  expect(validatePropositionRelationship(relationship(leg(), inverted))).toMatchObject({
    valid: false,
    state: 'invalid_metadata',
  });
});

it.each([
  ['similar titles with different parent IDs', pmYesRepublican(), { parentEventId: 'fl-27-house-2026' }],
  ['conflicting resolution rules', pmYesRepublican(), { resolutionRuleId: 'different-rules' }],
])('rejects %s', (_label, pm, changed) => {
  Object.assign(pm, changed);
  expect(validatePropositionRelationship(relationship(leg(), pm))).toMatchObject({ valid: false });
});

it('rejects multi-outcome non-exhaustive pairs', () => {
  const states = ['democratic', 'republican', 'independent'];
  const kalshi = leg({ eventPayoutStates: states });
  const pm = pmYesRepublican();
  pm.eventPayoutStates = states;
  expect(validatePropositionRelationship(relationship(kalshi, pm, { exhaustivePayoutStates: states }))).toMatchObject({
    valid: false,
    state: 'non_exhaustive',
  });
});

it('quarantines legacy missing relationship metadata', () => {
  expect(validatePropositionRelationship(null)).toMatchObject({ valid: false, state: 'unknown' });
});
