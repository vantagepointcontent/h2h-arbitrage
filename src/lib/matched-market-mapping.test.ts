import { afterEach, describe, expect, it, vi } from 'vitest';
import { createClient, type Client } from '@libsql/client';
import type { PropositionRelationshipV2 } from './proposition-identity';
import {
  createMatchedMarketMappingStore,
  migrateLegacyRegistryToMatchedMarkets,
  type MatchedMarketMappingInput,
} from './matched-market-mapping';

const relationship: PropositionRelationshipV2 = {
  schemaVersion: 2,
  state: 'verified_complementary',
  verificationSource: 'authoritative_platform_metadata',
  verifiedAt: '2026-08-30T12:00:00.000Z',
  parentEventId: 'event-1',
  resolutionRuleId: 'event-1-rules-v1',
  exhaustivePayoutStates: ['team a wins', 'team a loses'],
  humanLabel: 'Team A exact outcome',
  legs: {
    kalshi: {
      platform: 'kalshi', platformMarketId: 'KXTEAM-A', parentEventId: 'event-1', selectedOutcome: 'team a wins',
      contractSide: 'yes', payoutState: 'team a wins', eventPayoutStates: ['team a wins', 'team a loses'],
      resolutionRuleId: 'event-1-rules-v1', humanLabel: 'Kalshi YES', marketQuestion: 'Will Team A win?', tokenId: null,
    },
    polymarket: {
      platform: 'polymarket', platformMarketId: '0xcondition', parentEventId: 'event-1', selectedOutcome: 'team a wins',
      contractSide: 'no', payoutState: 'team a loses', eventPayoutStates: ['team a wins', 'team a loses'],
      resolutionRuleId: 'event-1-rules-v1', humanLabel: 'Polymarket NO', marketQuestion: 'Will Team A win?', tokenId: 'pm-no-token',
    },
  },
  reviewedBy: ['reviewer-a', 'reviewer-b'], reviewedAt: '2026-08-30T12:01:00.000Z', reviewTask: 'BUG-860',
  evidenceRevision: `sha256:${'a'.repeat(64)}`, resolutionRuleRevision: `sha256:${'b'.repeat(64)}`,
  evidence: [{ uri: 'artifacts/evidence.json', sha256: 'a'.repeat(64), observedAt: '2026-08-30T11:59:00.000Z' }],
};

const mapping: MatchedMarketMappingInput = {
  matchedMarketId: 'matched-1',
  relationship,
  source: 'matched_market_review',
};

let clients: Client[] = [];
async function harness() {
  const client = createClient({ url: ':memory:' });
  clients.push(client);
  await client.execute(`CREATE TABLE saved_markets (id TEXT PRIMARY KEY, event_title TEXT, last_scan_result TEXT, live_result TEXT)`);
  await client.execute({ sql: `INSERT INTO saved_markets (id,event_title) VALUES (?,?)`, args: ['matched-1', 'Team A'] });
  const store = createMatchedMarketMappingStore(client);
  await store.ensureSchema();
  return { client, store };
}
afterEach(() => { for (const client of clients) client.close(); clients = []; });

describe('Matched Market executable mapping authority', () => {
  it('authorizes only the exact persisted stable-ID outcome tuple', async () => {
    const { store } = await harness();
    await store.persistVerified(mapping);

    await expect(store.resolve({
      matchedMarketId: 'matched-1', kalshiTicker: 'KXTEAM-A', pmConditionId: '0xcondition',
      pmTokenId: 'pm-no-token', kalshiSide: 'yes', pmSide: 'no',
    })).resolves.toMatchObject({ state: 'verified', matchedMarketId: 'matched-1', relationship });
  });

  it('fails closed with the Matched Market wording when the record has URLs but no exact mapping', async () => {
    const { store } = await harness();
    await expect(store.resolve({
      matchedMarketId: 'matched-1', kalshiTicker: 'KXTEAM-A', pmConditionId: '0xcondition',
      pmTokenId: 'pm-no-token', kalshiSide: 'yes', pmSide: 'no',
    })).resolves.toEqual({
      state: 'missing', matchedMarketId: 'matched-1',
      reason: 'Matched market exists, but exact outcome mapping is missing/unverified',
    });
  });

  it('resolves from the pre-existing authority schema without issuing DDL in the execution hot path', async () => {
    const { client, store } = await harness();
    await store.persistVerified(mapping);
    const batch = vi.spyOn(client, 'batch').mockRejectedValue(new Error('resolve attempted a schema write'));

    await expect(store.resolve({
      matchedMarketId: 'matched-1', kalshiTicker: 'KXTEAM-A', pmConditionId: '0xcondition',
      pmTokenId: 'pm-no-token', kalshiSide: 'yes', pmSide: 'no',
    })).resolves.toMatchObject({ state: 'verified', matchedMarketId: 'matched-1' });
    expect(batch).not.toHaveBeenCalled();
  });

  it.each([
    ['wrong token', { pmTokenId: 'wrong-token' }, 'pmTokenId expected pm-no-token, received wrong-token'],
    ['wrong side', { pmSide: 'yes' as const }, 'pmSide expected no, received yes'],
    ['wrong sport or settlement relationship', { kalshiTicker: 'KXOTHER' }, 'kalshiTicker expected KXTEAM-A, received KXOTHER'],
  ])('fails closed on %s and names the mismatched identifier', async (_name, override, expected) => {
    const { store } = await harness();
    await store.persistVerified(mapping);
    const result = await store.resolve({
      matchedMarketId: 'matched-1', kalshiTicker: 'KXTEAM-A', pmConditionId: '0xcondition',
      pmTokenId: 'pm-no-token', kalshiSide: 'yes', pmSide: 'no', ...override,
    });
    expect(result).toMatchObject({ state: 'mismatch', matchedMarketId: 'matched-1' });
    if (result.state !== 'mismatch') throw new Error('Expected a mismatched mapping resolution');
    expect(result.reason).toContain(expected);
  });

  it('persists and resolves both reviewed binary execution directions for one Matched Market', async () => {
    const { store } = await harness();
    await store.persistVerified(mapping);
    const opposite = structuredClone(relationship);
    opposite.humanLabel = 'Team A opposite exact outcome';
    opposite.legs.kalshi.contractSide = 'no';
    opposite.legs.kalshi.payoutState = 'team a loses';
    opposite.legs.kalshi.humanLabel = 'Kalshi NO';
    opposite.legs.polymarket.contractSide = 'yes';
    opposite.legs.polymarket.payoutState = 'team a wins';
    opposite.legs.polymarket.tokenId = 'pm-yes-token';
    opposite.legs.polymarket.humanLabel = 'Polymarket YES';

    await expect(store.persistVerified({ ...mapping, relationship: opposite }))
      .resolves.toMatchObject({ inserted: true });
    await expect(store.resolve({
      matchedMarketId: 'matched-1', kalshiTicker: 'KXTEAM-A', pmConditionId: '0xcondition',
      pmTokenId: 'pm-no-token', kalshiSide: 'yes', pmSide: 'no',
    })).resolves.toMatchObject({ state: 'verified', relationship });
    await expect(store.resolve({
      matchedMarketId: 'matched-1', kalshiTicker: 'KXTEAM-A', pmConditionId: '0xcondition',
      pmTokenId: 'pm-yes-token', kalshiSide: 'no', pmSide: 'yes',
    })).resolves.toMatchObject({ state: 'verified', relationship: opposite });
    await expect(store.counts()).resolves.toEqual({ mapped: 2, missing: 0, conflicting: 0, rejected: 0 });
  });

  it('never silently overwrites a conflicting revision for the same exact tuple', async () => {
    const { store } = await harness();
    await store.persistVerified(mapping);
    const conflicting = structuredClone(relationship);
    conflicting.humanLabel = 'Changed review of the same exact tuple';
    conflicting.evidenceRevision = `sha256:${'c'.repeat(64)}`;

    await expect(store.persistVerified({ ...mapping, relationship: conflicting }))
      .rejects.toThrow(/conflicting Matched Market mapping/i);
    await expect(store.counts()).resolves.toEqual({ mapped: 1, missing: 0, conflicting: 1, rejected: 0 });
  });

  it('rejects settlement-incompatible relationship evidence before persistence', async () => {
    const { store } = await harness();
    const incompatible = structuredClone(relationship);
    incompatible.legs.polymarket.resolutionRuleId = 'different-settlement-rules';

    await expect(store.persistVerified({ ...mapping, relationship: incompatible }))
      .rejects.toThrow(/invalid matched market exact outcome mapping/i);
    await expect(store.resolve({
      matchedMarketId: 'matched-1', kalshiTicker: 'KXTEAM-A', pmConditionId: '0xcondition',
      pmTokenId: 'pm-no-token', kalshiSide: 'yes', pmSide: 'no',
    })).resolves.toMatchObject({ state: 'missing' });
  });

  it('migrates legacy approvals into the one matching Matched Market and reports every unmapped/rejected decision', async () => {
    const { client, store } = await harness();
    await client.execute({
      sql: `UPDATE saved_markets SET last_scan_result=? WHERE id='matched-1'`,
      args: [JSON.stringify({ matchedPairs: [{ kalshiTicker: 'KXTEAM-A', pmConditionId: '0xcondition' }] })],
    });
    const missing = structuredClone(relationship);
    missing.legs.kalshi.platformMarketId = 'KXMISSING';
    missing.legs.polymarket.platformMarketId = '0xmissing';
    missing.legs.polymarket.tokenId = 'missing-token';

    const report = await migrateLegacyRegistryToMatchedMarkets(client, {
      schemaVersion: 2,
      relationships: [relationship, missing],
      rejections: [{ executionTuple: {
        kalshiTicker: 'KXBAD', pmConditionId: '0xbad', pmTokenId: 'bad-token', kalshiSide: 'yes', pmSide: 'no',
      }, code: 'non_equivalent_wrong_sport', reason: 'Basketball is not football.' }],
    });

    expect(report).toEqual({ mapped: 1, missing: 1, conflicting: 0, rejected: 1 });
    await expect(store.resolve({
      matchedMarketId: 'matched-1', kalshiTicker: 'KXTEAM-A', pmConditionId: '0xcondition',
      pmTokenId: 'pm-no-token', kalshiSide: 'yes', pmSide: 'no',
    })).resolves.toMatchObject({ state: 'verified' });
    const rejected = await client.execute('SELECT code,reason FROM matched_market_mapping_rejections');
    expect(rejected.rows).toEqual([expect.objectContaining({ code: 'non_equivalent_wrong_sport', reason: 'Basketball is not football.' })]);

    const rerun = await migrateLegacyRegistryToMatchedMarkets(client, {
      schemaVersion: 2,
      relationships: [relationship, missing],
      rejections: [{ executionTuple: {
        kalshiTicker: 'KXBAD', pmConditionId: '0xbad', pmTokenId: 'bad-token', kalshiSide: 'yes', pmSide: 'no',
      }, code: 'non_equivalent_wrong_sport', reason: 'Basketball is not football.' }],
    });
    expect(rerun).toEqual(report);
    await expect(store.counts()).resolves.toEqual({ mapped: 1, missing: 1, conflicting: 0, rejected: 1 });
    const audits = await client.execute('SELECT COUNT(*) AS count FROM matched_market_mapping_audit');
    expect(Number(audits.rows[0]?.count)).toBe(3);
  });
});
