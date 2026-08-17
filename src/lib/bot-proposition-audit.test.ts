import { describe, expect, it } from 'vitest';
import { historicalPropositionAudit } from './bot-proposition-audit';

describe('historical proposition audit manifest', () => {
  it('classifies immutable BotTrader execution #128 as high-severity invalid', () => {
    expect(historicalPropositionAudit(128, {
      positionId: 97,
      openedAt: '2026-08-11T01:50:13.377Z',
      kalshiTicker: 'KXHOUSERACE-FL26-26-D',
      pmConditionId: '0xe25b0be3d538078068d0bf2fd311bfbda4b07be31bee8ac4cdf1a0999d2bf328',
      pmTokenId: null,
      kalshiSide: 'yes',
      pmSide: 'yes',
    })).toMatchObject({
      executionId: 128,
      classification: 'confirmed_invalid',
      severity: 'high',
      reason: expect.stringContaining('Both executed legs are YES'),
    });
  });

  it('does not apply a database-local execution ID to a different trade identity', () => {
    expect(historicalPropositionAudit(128, {
      positionId: 97,
      openedAt: '2026-08-11T01:50:13.377Z',
      kalshiTicker: 'KXOTHER',
      pmConditionId: '0xother',
      pmTokenId: 'other-token',
      kalshiSide: 'yes',
      pmSide: 'yes',
    })).toBeNull();
  });
});
