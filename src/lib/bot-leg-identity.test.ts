import { describe, expect, it } from 'vitest';
import { buildBotLegIdentity, exportBotPositionIdentitiesCsv } from './bot-leg-identity';

const position = {
  marketTitle: 'FL-26 House Election Winner',
  kalshiTicker: 'KX-FL-D',
  pmConditionId: '0xdem',
  pmEntryTokenId: 'token-dem-yes',
  kalshiSide: 'yes' as const,
  pmSide: 'yes' as const,
};

const metadata = {
  eventTitle: 'FL-26 House Election Winner',
  kalshiMarketQuestion: 'Will the Democratic Party win Florida district 26?',
  pmMarketQuestion: 'Will Democrats win the FL-26 House election?',
  mutuallyExclusiveVerified: true,
  exhaustiveVerified: true,
  matchedPairs: [
    { artist: 'Democrats', kalshiTicker: 'KX-FL-D', pmConditionId: '0xdem' },
    { artist: 'Republicans', kalshiTicker: 'KX-FL-R', pmConditionId: '0xrep' },
  ],
};

describe('buildBotLegIdentity', () => {
  it('marks YES/YES on opposite verified propositions as complementary', () => {
    expect(buildBotLegIdentity(
      { ...position, pmConditionId: '0xrep' },
      { ...metadata, mutuallyExclusiveVerified: true, exhaustiveVerified: true },
    )).toMatchObject({
      kalshi: { outcomeLabel: 'Democrats', side: 'yes' },
      polymarket: { outcomeLabel: 'Republicans', side: 'yes' },
      relationship: { state: 'verified_complementary' },
    });
  });

  it('marks YES/YES on the same proposition as same-direction', () => {
    expect(buildBotLegIdentity(position, metadata).relationship.state).toBe('same_direction');
  });

  it('marks YES/NO on the same exact proposition as verified complementary', () => {
    expect(buildBotLegIdentity({ ...position, pmSide: 'no' }, metadata).relationship.state)
      .toBe('verified_complementary');
  });

  it('keeps exact multi-outcome labels without treating YES as the outcome', () => {
    const identity = buildBotLegIdentity(
      { ...position, kalshiTicker: 'KX-A', pmConditionId: '0xb' },
      { eventTitle: '2028 nominee', matchedPairs: [
        { artist: 'Alexandria Ocasio-Cortez', kalshiTicker: 'KX-A', pmConditionId: '0xa' },
        { artist: 'Josh Shapiro', kalshiTicker: 'KX-B', pmConditionId: '0xb' },
      ], mutuallyExclusiveVerified: true, exhaustiveVerified: true },
    );
    expect(identity.kalshi.outcomeLabel).toBe('Alexandria Ocasio-Cortez');
    expect(identity.polymarket.outcomeLabel).toBe('Josh Shapiro');
  });

  it('fails closed when either exact identifier has no unique persisted label', () => {
    const identity = buildBotLegIdentity({ ...position, pmConditionId: '0xmissing' }, metadata);
    expect(identity.polymarket.outcomeLabel).toBeNull();
    expect(identity.polymarket.metadataStatus).toBe('missing');
    expect(identity.relationship.state).toBe('legacy_unknown');
    expect(identity.relationship.explanation).toContain('Outcome metadata missing');
  });

  it('does not substitute a generic event title for missing venue questions', () => {
    const identity = buildBotLegIdentity(position, {
      ...metadata,
      kalshiMarketQuestion: null,
      pmMarketQuestion: null,
    });
    expect(identity.kalshi).toMatchObject({ marketQuestion: null, outcomeLabel: 'Democrats', metadataStatus: 'missing' });
    expect(identity.polymarket).toMatchObject({ marketQuestion: null, outcomeLabel: 'Democrats', metadataStatus: 'missing' });
    expect(identity.relationship.state).toBe('same_direction');
  });

  it('marks a backend-verified but non-complementary proposition/side pairing invalid', () => {
    expect(buildBotLegIdentity(
      { ...position, pmConditionId: '0xrep', pmSide: 'no' },
      metadata,
    ).relationship.state).toBe('invalid');
  });

  it('keeps an unverified legacy pairing unknown rather than inferring validity', () => {
    expect(buildBotLegIdentity(
      { ...position, pmSide: 'no' },
      { ...metadata, mutuallyExclusiveVerified: false, exhaustiveVerified: false },
    ).relationship.state).toBe('legacy_unknown');
  });
});

describe('exportBotPositionIdentitiesCsv', () => {
  it('exports exact questions, outcome labels, sides, relationship, and technical provenance', () => {
    const identity = buildBotLegIdentity(position, metadata);
    const csv = exportBotPositionIdentitiesCsv([{ id: 97, executionId: 128, ...position, identity }]);
    expect(csv).toContain('Kalshi Question,Kalshi Outcome,Kalshi Side');
    expect(csv).toContain('Will the Democratic Party win Florida district 26?,Democrats,YES');
    expect(csv).toContain('0xdem,token-dem-yes,same_direction');
  });

  it('neutralizes spreadsheet formulas in exported metadata', () => {
    const identity = buildBotLegIdentity(position, {
      ...metadata,
      kalshiMarketQuestion: '\t=HYPERLINK("https://example.test")',
    });
    const csv = exportBotPositionIdentitiesCsv([{ id: 128, ...position, identity }]);
    expect(csv).toContain("'=HYPERLINK");
  });
});
