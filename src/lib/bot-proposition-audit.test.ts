import { describe, expect, it } from 'vitest';
import { historicalAuditLegMetadata, historicalAuditPmEntryToken, historicalPropositionAudit } from './bot-proposition-audit';

describe('historical proposition audit manifest', () => {
  it('classifies execution #128 as an invalid mapping without fabricating live exposure', () => {
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
      severity: 'warning',
      reason: expect.stringContaining('exact requested contracts are both YES'),
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

  it('classifies Trade #101 as paper-only same-direction Republican YES exposure', () => {
    const audit = historicalPropositionAudit(101, {
      positionId: 73,
      openedAt: '2026-08-11T01:37:02.445Z',
      kalshiTicker: 'HOUSECO8-26-R',
      pmConditionId: '0x52284e2210068126179495aa36b333b455be2973ada738f6bffad6061bb116a6',
      pmTokenId: null,
      kalshiSide: 'yes',
      pmSide: 'yes',
    });
    expect(audit).toMatchObject({
      classification: 'confirmed_invalid',
      severity: 'warning',
      reason: expect.stringMatching(/both exact requested contracts.*Republican.*YES/i),
      evidence: { polymarket: {
        tokenId: '68021205636604056509276509067526372089338487160185591169779941190006739682906',
      } },
    });
    expect(historicalAuditLegMetadata(audit)).toEqual({
      kalshiMarketQuestion: 'Will Republican win the House race for CO-8?',
      pmMarketQuestion: 'Will the Republican Party win the CO-08 House seat?',
      kalshiOutcomeLabel: 'republican',
      pmOutcomeLabel: 'republican',
    });
  });

  it('binds MO-03 to the exact Democratic YES token actually bought, not the Republican label', () => {
    const audit = historicalPropositionAudit(179, {
      positionId: 140,
      openedAt: '2026-08-11T07:13:22.252Z',
      kalshiTicker: 'KXHOUSERACE-MO03-26-D',
      pmConditionId: '0x9041a41d6d08dc9282a5e135b0e2504d7c4950883e772a5942f17b607e354ca4',
      pmTokenId: null,
      kalshiSide: 'yes',
      pmSide: 'yes',
    });
    expect(audit).toMatchObject({ classification: 'confirmed_invalid', severity: 'high' });
    expect(historicalAuditLegMetadata(audit)).toEqual({
      kalshiMarketQuestion: 'Will Democratic win the House race for MO-03?',
      pmMarketQuestion: 'Will the Democratic Party win the MO-03 House seat?',
      kalshiOutcomeLabel: 'Democratic Party wins MO-03',
      pmOutcomeLabel: 'Democratic Party wins MO-03',
    });
    expect(historicalAuditPmEntryToken(audit)).toBe(
      '27237659461749395126949339507775498287619143517476509888079639110706576460737',
    );
  });
});
