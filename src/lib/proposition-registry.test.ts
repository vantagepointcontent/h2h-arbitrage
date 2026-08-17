import { describe, expect, it } from 'vitest';
import {
  canonicalPropositionRelationshipCount,
  findCanonicalPropositionRelationship,
  resolveCanonicalPropositionRelationship,
} from './proposition-registry';
import type { PropositionRelationship } from './proposition-identity';

const selfAsserted: PropositionRelationship = {
  schemaVersion: 1,
  state: 'verified_complementary',
  verificationSource: 'manually_verified_ids',
  verifiedAt: '2026-08-17T00:00:00.000Z',
  parentEventId: 'event',
  resolutionRuleId: 'rule',
  exhaustivePayoutStates: ['wins', 'loses'],
  humanLabel: 'self asserted',
  legs: {
    kalshi: {
      platform: 'kalshi', platformMarketId: 'KXTEST', parentEventId: 'event', selectedOutcome: 'wins',
      contractSide: 'yes', payoutState: 'wins', eventPayoutStates: ['wins', 'loses'], resolutionRuleId: 'rule',
      humanLabel: 'Kalshi YES', marketQuestion: 'Will it win?', tokenId: null,
    },
    polymarket: {
      platform: 'polymarket', platformMarketId: '0xcondition', parentEventId: 'event', selectedOutcome: 'wins',
      contractSide: 'no', payoutState: 'loses', eventPayoutStates: ['wins', 'loses'], resolutionRuleId: 'rule',
      humanLabel: 'Polymarket NO', marketQuestion: 'Will it win?', tokenId: 'no-token',
    },
  },
};

describe('canonical proposition registry', () => {
  it('does not trust well-formed candidate metadata that is absent from the server registry', () => {
    expect(canonicalPropositionRelationshipCount()).toBe(0);
    expect(resolveCanonicalPropositionRelationship(selfAsserted)).toBeNull();
    expect(findCanonicalPropositionRelationship({
      kalshiTicker: 'KXTEST', pmConditionId: '0xcondition', pmTokenId: 'no-token', kalshiSide: 'yes', pmSide: 'no',
    })).toBeNull();
  });
});
