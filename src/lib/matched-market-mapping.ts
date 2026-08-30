import { createHash } from 'node:crypto';
import path from 'node:path';
import { createClient, type Client } from '@libsql/client';
import {
  validatePropositionRelationship,
  type PropositionRelationshipV2,
} from './proposition-identity';

export type MappingSource = 'matched_market_review' | 'legacy_registry_migration';

export interface MatchedMarketMappingInput {
  matchedMarketId: string;
  relationship: PropositionRelationshipV2;
  source: MappingSource;
}

export interface MatchedMarketExecutionTuple {
  matchedMarketId: string;
  kalshiTicker: string;
  pmConditionId: string;
  pmTokenId: string;
  kalshiSide: 'yes' | 'no';
  pmSide: 'yes' | 'no';
}

export type MatchedMarketMappingResolution =
  | { state: 'verified'; matchedMarketId: string; mappingId: string; revision: string; relationship: PropositionRelationshipV2 }
  | { state: 'missing' | 'mismatch' | 'invalid'; matchedMarketId: string; reason: string };

function normalized(value: string): string { return value.trim().toLowerCase(); }
function tupleFor(relationship: PropositionRelationshipV2) {
  return {
    kalshiTicker: relationship.legs.kalshi.platformMarketId.trim().toUpperCase(),
    pmConditionId: normalized(relationship.legs.polymarket.platformMarketId),
    pmTokenId: relationship.legs.polymarket.tokenId!.trim(),
    kalshiSide: relationship.legs.kalshi.contractSide,
    pmSide: relationship.legs.polymarket.contractSide,
  };
}
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
function mappingIdentity(matchedMarketId: string, relationship: PropositionRelationshipV2): string {
  const tuple = tupleFor(relationship);
  return createHash('sha256').update(canonicalJson({ matchedMarketId, ...tuple })).digest('hex');
}
function mappingRevision(relationship: PropositionRelationshipV2): string {
  return createHash('sha256').update(canonicalJson(relationship)).digest('hex');
}

export function createMatchedMarketMappingStore(client: Client) {
  async function ensureSchema(): Promise<void> {
    await client.batch([
      `CREATE TABLE IF NOT EXISTS matched_market_mappings (
        mapping_id TEXT PRIMARY KEY,
        matched_market_id TEXT NOT NULL,
        kalshi_ticker TEXT NOT NULL,
        pm_condition_id TEXT NOT NULL,
        pm_token_id TEXT NOT NULL,
        kalshi_side TEXT NOT NULL CHECK(kalshi_side IN ('yes','no')),
        pm_side TEXT NOT NULL CHECK(pm_side IN ('yes','no')),
        relationship_json TEXT NOT NULL,
        mapping_revision TEXT NOT NULL,
        evidence_revision TEXT NOT NULL,
        resolution_rule_revision TEXT NOT NULL,
        source TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(matched_market_id,kalshi_ticker,pm_condition_id,pm_token_id,kalshi_side,pm_side)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_matched_market_mappings_market ON matched_market_mappings(matched_market_id)`,
      `CREATE TABLE IF NOT EXISTS matched_market_mapping_audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        matched_market_id TEXT,
        mapping_id TEXT,
        classification TEXT NOT NULL CHECK(classification IN ('mapped','missing','conflicting','rejected')),
        reason TEXT NOT NULL,
        recorded_at TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS matched_market_mapping_rejections (
        rejection_id TEXT PRIMARY KEY,
        kalshi_ticker TEXT NOT NULL,
        pm_condition_id TEXT NOT NULL,
        pm_token_id TEXT NOT NULL,
        kalshi_side TEXT NOT NULL,
        pm_side TEXT NOT NULL,
        code TEXT NOT NULL,
        reason TEXT NOT NULL,
        source_json TEXT NOT NULL,
        recorded_at TEXT NOT NULL
      )`,
    ], 'write');
  }

  async function persistVerified(input: MatchedMarketMappingInput): Promise<{ mappingId: string; revision: string; inserted: boolean }> {
    await ensureSchema();
    const validation = validatePropositionRelationship(input.relationship);
    if (!validation.valid || input.relationship.schemaVersion !== 2) {
      throw new Error(`Invalid Matched Market exact outcome mapping: ${validation.valid ? 'review evidence is required' : validation.reason}`);
    }
    const marketId = input.matchedMarketId.trim();
    if (!marketId) throw new Error('Matched Market ID is required');
    const market = await client.execute({ sql: 'SELECT id FROM saved_markets WHERE id=? LIMIT 1', args: [marketId] });
    if (market.rows.length === 0) throw new Error(`Matched Market ${marketId} does not exist`);
    const tuple = tupleFor(input.relationship);
    const mappingId = mappingIdentity(marketId, input.relationship);
    const revision = mappingRevision(input.relationship);
    const existing = await client.execute({
      sql: `SELECT mapping_id,mapping_revision,relationship_json FROM matched_market_mappings WHERE matched_market_id=?`,
      args: [marketId],
    });
    const incompatible = existing.rows.some((row) => {
      if (String(row.mapping_id) === mappingId) return String(row.mapping_revision) !== revision;
      try {
        const approved = JSON.parse(String(row.relationship_json)) as PropositionRelationshipV2;
        return normalized(approved.parentEventId) !== normalized(input.relationship.parentEventId)
          || normalized(approved.resolutionRuleId) !== normalized(input.relationship.resolutionRuleId);
      } catch {
        return true;
      }
    });
    if (incompatible) {
      await client.execute({
        sql: `INSERT INTO matched_market_mapping_audit (matched_market_id,mapping_id,classification,reason,recorded_at)
          SELECT ?,?,?,?,? WHERE NOT EXISTS (
            SELECT 1 FROM matched_market_mapping_audit WHERE mapping_id=? AND classification='conflicting'
          )`,
        args: [marketId, mappingId, 'conflicting', 'Conflicting Matched Market mapping was rejected without overwrite',
          new Date().toISOString(), mappingId],
      });
      throw new Error(`Conflicting Matched Market mapping for ${marketId}; existing authority was not overwritten`);
    }
    const inserted = !existing.rows.some((row) => String(row.mapping_id) === mappingId);
    if (inserted) {
      await client.execute({
        sql: `INSERT INTO matched_market_mappings
          (mapping_id,matched_market_id,kalshi_ticker,pm_condition_id,pm_token_id,kalshi_side,pm_side,
           relationship_json,mapping_revision,evidence_revision,resolution_rule_revision,source,created_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        args: [mappingId, marketId, tuple.kalshiTicker, tuple.pmConditionId, tuple.pmTokenId, tuple.kalshiSide, tuple.pmSide,
          JSON.stringify(input.relationship), revision, input.relationship.evidenceRevision,
          input.relationship.resolutionRuleRevision, input.source, new Date().toISOString()],
      });
      await client.execute({
        sql: `INSERT INTO matched_market_mapping_audit (matched_market_id,mapping_id,classification,reason,recorded_at)
          VALUES (?,?,?,?,?)`,
        args: [marketId, mappingId, 'mapped', `Persisted exact ${tuple.kalshiTicker}/${tuple.pmConditionId}/${tuple.pmTokenId}/${tuple.kalshiSide}/${tuple.pmSide}`, new Date().toISOString()],
      });
    }
    return { mappingId, revision, inserted };
  }

  async function resolve(input: MatchedMarketExecutionTuple): Promise<MatchedMarketMappingResolution> {
    await ensureSchema();
    const marketId = input.matchedMarketId.trim();
    const market = await client.execute({ sql: 'SELECT id FROM saved_markets WHERE id=? LIMIT 1', args: [marketId] });
    if (market.rows.length === 0) {
      return { state: 'invalid', matchedMarketId: marketId, reason: `Matched market ${marketId || '(missing)'} does not exist` };
    }
    const rows = await client.execute({ sql: 'SELECT * FROM matched_market_mappings WHERE matched_market_id=? ORDER BY mapping_id', args: [marketId] });
    if (rows.rows.length === 0) {
      return { state: 'missing', matchedMarketId: marketId, reason: 'Matched market exists, but exact outcome mapping is missing/unverified' };
    }
    const received = {
      kalshiTicker: input.kalshiTicker.trim().toUpperCase(), pmConditionId: normalized(input.pmConditionId),
      pmTokenId: input.pmTokenId.trim(), kalshiSide: input.kalshiSide, pmSide: input.pmSide,
    };
    const exact = rows.rows.find((row) => String(row.kalshi_ticker) === received.kalshiTicker
      && String(row.pm_condition_id) === received.pmConditionId && String(row.pm_token_id) === received.pmTokenId
      && row.kalshi_side === received.kalshiSide && row.pm_side === received.pmSide);
    if (!exact) {
      const expected = rows.rows[0];
      const differences = [
        ['kalshiTicker', expected.kalshi_ticker, received.kalshiTicker],
        ['pmConditionId', expected.pm_condition_id, received.pmConditionId],
        ['pmTokenId', expected.pm_token_id, received.pmTokenId],
        ['kalshiSide', expected.kalshi_side, received.kalshiSide],
        ['pmSide', expected.pm_side, received.pmSide],
      ].filter(([, wanted, actual]) => String(wanted) !== String(actual))
        .map(([field, wanted, actual]) => `${field} expected ${wanted}, received ${actual}`);
      return { state: 'mismatch', matchedMarketId: marketId,
        reason: `Matched market exact outcome mapping mismatch: ${differences.join('; ') || 'ambiguous mapping'}` };
    }
    try {
      const relationship = JSON.parse(String(exact.relationship_json)) as PropositionRelationshipV2;
      const validation = validatePropositionRelationship(relationship);
      if (!validation.valid || relationship.schemaVersion !== 2 || mappingRevision(relationship) !== String(exact.mapping_revision)) {
        return { state: 'invalid', matchedMarketId: marketId,
          reason: `Matched market exact outcome mapping is corrupt/unverified: ${validation.valid ? 'revision mismatch' : validation.reason}` };
      }
      return { state: 'verified', matchedMarketId: marketId, mappingId: String(exact.mapping_id),
        revision: String(exact.mapping_revision), relationship };
    } catch {
      return { state: 'invalid', matchedMarketId: marketId, reason: 'Matched market exact outcome mapping is corrupt/unverified: malformed relationship JSON' };
    }
  }

  async function counts() {
    await ensureSchema();
    const result = await client.execute(`SELECT classification,count(*) n FROM matched_market_mapping_audit GROUP BY classification`);
    const counts = { mapped: 0, missing: 0, conflicting: 0, rejected: 0 };
    for (const row of result.rows) counts[String(row.classification) as keyof typeof counts] = Number(row.n);
    return counts;
  }
  return { ensureSchema, persistVerified, resolve, counts };
}

const DB_PATH = process.env.H2H_SQLITE_PATH || path.join(process.cwd(), 'data', 'edgefinder.db');

interface LegacyRegistryInput {
  schemaVersion: number;
  relationships: PropositionRelationshipV2[];
  rejections: Array<{
    executionTuple: Omit<MatchedMarketExecutionTuple, 'matchedMarketId'>;
    code: string;
    reason: string;
    [key: string]: unknown;
  }>;
}

function payloadContainsPair(payload: unknown, kalshiTicker: string, pmConditionId: string): boolean {
  if (!payload) return false;
  let text: string;
  try { text = typeof payload === 'string' ? payload : JSON.stringify(payload); } catch { return false; }
  return text.toLowerCase().includes(kalshiTicker.toLowerCase())
    && text.toLowerCase().includes(pmConditionId.toLowerCase());
}

/** One-shot, idempotent migration from the retired source file into Matched Market records. */
export async function migrateLegacyRegistryToMatchedMarkets(client: Client, registry: LegacyRegistryInput) {
  const store = createMatchedMarketMappingStore(client);
  await store.ensureSchema();
  const report = { mapped: 0, missing: 0, conflicting: 0, rejected: 0 };
  const markets = await client.execute('SELECT id,last_scan_result,live_result FROM saved_markets ORDER BY id');
  for (const relationship of registry.relationships) {
    const tuple = tupleFor(relationship);
    const matched = markets.rows.filter((row) => payloadContainsPair(row.last_scan_result, tuple.kalshiTicker, tuple.pmConditionId)
      || payloadContainsPair(row.live_result, tuple.kalshiTicker, tuple.pmConditionId));
    if (matched.length !== 1) {
      const classification = matched.length === 0 ? 'missing' : 'conflicting';
      report[classification] += 1;
      const unresolvedMappingId = mappingIdentity('unresolved', relationship);
      await client.execute({
        sql: `INSERT INTO matched_market_mapping_audit (matched_market_id,mapping_id,classification,reason,recorded_at)
          SELECT ?,?,?,?,? WHERE NOT EXISTS (
            SELECT 1 FROM matched_market_mapping_audit WHERE mapping_id=? AND classification=?
          )`,
        args: [matched.length === 1 ? String(matched[0].id) : null, unresolvedMappingId, classification,
          matched.length === 0
            ? `No Matched Market contains exact pair ${tuple.kalshiTicker}/${tuple.pmConditionId}`
            : `Multiple Matched Markets contain exact pair ${tuple.kalshiTicker}/${tuple.pmConditionId}`,
          new Date().toISOString(), unresolvedMappingId, classification],
      });
      continue;
    }
    try {
      await store.persistVerified({ matchedMarketId: String(matched[0].id), relationship, source: 'legacy_registry_migration' });
      report.mapped += 1;
    } catch (error) {
      report.conflicting += 1;
      if (!String(error).includes('Conflicting Matched Market mapping')) throw error;
    }
  }
  for (const rejection of registry.rejections) {
    const tuple = rejection.executionTuple;
    const rejectionId = createHash('sha256').update(canonicalJson({ tuple, code: rejection.code, reason: rejection.reason })).digest('hex');
    const inserted = await client.execute({
      sql: `INSERT OR IGNORE INTO matched_market_mapping_rejections
        (rejection_id,kalshi_ticker,pm_condition_id,pm_token_id,kalshi_side,pm_side,code,reason,source_json,recorded_at)
        VALUES (?,?,?,?,?,?,?,?,?,?)`,
      args: [rejectionId, tuple.kalshiTicker.trim().toUpperCase(), normalized(tuple.pmConditionId), tuple.pmTokenId.trim(),
        tuple.kalshiSide, tuple.pmSide, rejection.code, rejection.reason, JSON.stringify(rejection), new Date().toISOString()],
    });
    if (Number(inserted.rowsAffected ?? 0) > 0) {
      report.rejected += 1;
      await client.execute({
        sql: `INSERT INTO matched_market_mapping_audit (mapping_id,classification,reason,recorded_at) VALUES (?,?,?,?)`,
        args: [rejectionId, 'rejected', `${rejection.code}: ${rejection.reason}`, new Date().toISOString()],
      });
    } else {
      report.rejected += 1;
    }
  }
  return report;
}

export async function resolveMatchedMarketMapping(input: MatchedMarketExecutionTuple): Promise<MatchedMarketMappingResolution> {
  const client = createClient({ url: `file:${DB_PATH}` });
  try { return await createMatchedMarketMappingStore(client).resolve(input); }
  finally { client.close(); }
}
