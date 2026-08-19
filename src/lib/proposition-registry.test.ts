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
    expect(canonicalPropositionRelationshipCount()).toBe(2);
    expect(resolveCanonicalPropositionRelationship(selfAsserted)).toBeNull();
    expect(findCanonicalPropositionRelationship({
      kalshiTicker: 'KXTEST', pmConditionId: '0xcondition', pmTokenId: 'no-token', kalshiSide: 'yes', pmSide: 'no',
    })).toBeNull();
  });

  it('resolves the independently verified F1 control identity by exact execution identifiers', () => {
    const relationship = findCanonicalPropositionRelationship({
      kalshiTicker: 'KXF1ACTION-2026-COL',
      pmConditionId: '0xf700d212b47dbd6f262c41bb464e458458d7e8b97569eda06f74fd3f4133b961',
      pmTokenId: '38424385756462253442221613485727105608987714090195314133724025202573806948368',
      kalshiSide: 'yes',
      pmSide: 'no',
    });
    expect(relationship).toMatchObject({
      verificationSource: 'authoritative_platform_metadata',
      legs: {
        kalshi: { selectedOutcome: 'Franco Colapinto wins', payoutState: 'Franco Colapinto wins' },
        polymarket: { selectedOutcome: 'Franco Colapinto wins', payoutState: 'Franco Colapinto does not win' },
      },
    });
  });

  it('does not canonically bless the reported MO-03 or NY-21 rows without immutable outcome proof', () => {
    expect(findCanonicalPropositionRelationship({
      kalshiTicker: 'KXHOUSERACE-MO03-26-D',
      pmConditionId: '0x9041a41d6d08dc9282a5e135b0e2504d7c4950883e772a5942f17b607e354ca4',
      pmTokenId: '27237659461749395126949339507775498287619143517476509888079639110706576460737',
      kalshiSide: 'yes', pmSide: 'yes',
    })).toBeNull();
    expect(findCanonicalPropositionRelationship({
      kalshiTicker: 'KXHOUSERACE-NY21-26-R',
      pmConditionId: '0x4f3d35bc886f93949cf06a73ffdd8d14210a1d06a136ebb506f5aa653514d970',
      pmTokenId: '61536378782761462213691399252544797782501798493464719286188000407153618893171',
      kalshiSide: 'yes', pmSide: 'no',
    })).toBeNull();
  });

  it('resolves the intended MO-03 Democratic YES plus Republican YES pair exactly', () => {
    expect(findCanonicalPropositionRelationship({
      kalshiTicker: 'KXHOUSERACE-MO03-26-D',
      pmConditionId: '0xf32f28247b2a9653f52ee8078e6aa265c0fdc00b0697ef390902d86fdbef35e4',
      pmTokenId: '78731837307763791013205666606889953610367275623708569393097319597715511164419',
      kalshiSide: 'yes', pmSide: 'yes',
    })).toMatchObject({
      state: 'verified_complementary',
      legs: {
        kalshi: { payoutState: 'Democratic Party wins MO-03' },
        polymarket: { payoutState: 'Republican Party wins MO-03' },
      },
    });
  });
});
