import { createHash } from 'node:crypto';
import path from 'node:path';
import { createClient, type Client } from '@libsql/client';
import {
  validatePropositionRelationship,
  type PropositionRelationshipV2,
} from './proposition-identity';

export type MappingSource = 'matched_market_review' | 'legacy_registry_migration' | 'matched_market_scan_derivation';

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

export interface MatchedMarketDerivationInput extends MatchedMarketExecutionTuple {
  sourceScanId: number | null;
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

function candidateSides(strategy: unknown): Pick<MatchedMarketExecutionTuple, 'kalshiSide' | 'pmSide'> | null {
  if (typeof strategy !== 'string') return null;
  const value = strategy.toLowerCase();
  if (value.includes('yes kalshi') && value.includes('no pm')) return { kalshiSide: 'yes', pmSide: 'no' };
  if (value.includes('yes pm') && value.includes('no kalshi')) return { kalshiSide: 'no', pmSide: 'yes' };
  return null;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function outcomeKey(value: string): string {
  return value.normalize('NFKD').replace(/\([^)]*\)/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function compatibleOutcomeLabels(values: string[]): boolean {
  const keys = values.map(outcomeKey);
  if (keys.some((value) => !value)) return false;
  const shortest = [...keys].sort((a, b) => a.length - b.length)[0];
  return keys.every((value) => value === shortest || value.startsWith(`${shortest} `));
}

function candidateTuple(candidate: Record<string, unknown>): Omit<MatchedMarketExecutionTuple, 'matchedMarketId'> | null {
  const sides = candidateSides(candidate.strategy);
  const kalshiTicker = text(candidate.kalshiTicker);
  const pmConditionId = text(candidate.pmConditionId);
  const pmTokenId = sides?.pmSide === 'yes' ? text(candidate.pmYesTokenId) : text(candidate.pmNoTokenId);
  if (!sides || !kalshiTicker || !pmConditionId || !pmTokenId) return null;
  return { kalshiTicker, pmConditionId, pmTokenId, ...sides };
}

function tupleMatches(left: Omit<MatchedMarketExecutionTuple, 'matchedMarketId'>, right: MatchedMarketExecutionTuple): boolean {
  return left.kalshiTicker.trim().toUpperCase() === right.kalshiTicker.trim().toUpperCase()
    && normalized(left.pmConditionId) === normalized(right.pmConditionId)
    && left.pmTokenId.trim() === right.pmTokenId.trim()
    && left.kalshiSide === right.kalshiSide
    && left.pmSide === right.pmSide;
}

function settlementConflict(candidate: Record<string, unknown>): string | null {
  const outcomeApy = candidate.outcomeApy;
  if (!outcomeApy || typeof outcomeApy !== 'object') return null;
  const payload = outcomeApy as Record<string, unknown>;
  const kalshi = payload.kalshi as Record<string, unknown> | undefined;
  const polymarket = payload.polymarket as Record<string, unknown> | undefined;
  const kalshiAt = text(kalshi?.contractualAt);
  const pmAt = text(polymarket?.contractualAt);
  if (!kalshiAt || !pmAt) return null;
  const kalshiMs = Date.parse(kalshiAt);
  const pmMs = Date.parse(pmAt);
  if (!Number.isFinite(kalshiMs) || !Number.isFinite(pmMs)) {
    return `settlement timestamps are malformed: Kalshi ${kalshiAt}, Polymarket ${pmAt}`;
  }
  const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
  return Math.abs(kalshiMs - pmMs) > sevenDaysMs
    ? `settlement timestamps conflict: Kalshi ${kalshiAt}, Polymarket ${pmAt}`
    : null;
}

function derivedRelationship(
  matchedMarketId: string,
  scanId: number,
  scannedAt: string,
  candidate: Record<string, unknown>,
  tuple: Omit<MatchedMarketExecutionTuple, 'matchedMarketId'>,
): PropositionRelationshipV2 | { reason: string } {
  const outcome = text(candidate.artist);
  const kalshiOutcome = text(candidate.kalshiOutcomeLabel);
  const pmOutcome = text(candidate.pmOutcomeLabel);
  const kalshiQuestion = text(candidate.kalshiMarketQuestion);
  const pmQuestion = text(candidate.pmMarketQuestion);
  if (!outcome || !kalshiOutcome || !pmOutcome || !kalshiQuestion || !pmQuestion) {
    return { reason: 'selected outcome metadata is incomplete' };
  }
  if (!compatibleOutcomeLabels([outcome, kalshiOutcome, pmOutcome])) {
    return { reason: `selected outcome labels conflict: canonical ${outcome}, Kalshi ${kalshiOutcome}, Polymarket ${pmOutcome}` };
  }
  const settlement = settlementConflict(candidate);
  if (settlement) return { reason: settlement };
  const parentEventId = `matched-market:${matchedMarketId}`;
  const resolutionRuleId = `${parentEventId}:approved-link-v1`;
  const opposite = `not:${outcome}`;
  const evidencePayload = {
    matchedMarketId, scanId, tuple, outcome, kalshiOutcome, pmOutcome, kalshiQuestion, pmQuestion,
    outcomeApy: candidate.outcomeApy ?? null,
  };
  const evidenceRevision = createHash('sha256').update(canonicalJson(evidencePayload)).digest('hex');
  const resolutionRuleRevision = createHash('sha256').update(resolutionRuleId).digest('hex');
  const payout = (side: 'yes' | 'no') => side === 'yes' ? outcome : opposite;
  return {
    schemaVersion: 2,
    state: 'verified_complementary',
    verificationSource: 'manually_verified_ids',
    verifiedAt: scannedAt,
    reviewedBy: [`matched-market-approval:${matchedMarketId}`, 'deterministic-outcome-resolver:v1'],
    reviewedAt: scannedAt,
    reviewTask: `matched-market:${matchedMarketId}`,
    evidenceRevision,
    resolutionRuleRevision,
    evidence: [{ uri: `scan-results/${scanId}`, sha256: evidenceRevision, observedAt: scannedAt }],
    parentEventId,
    resolutionRuleId,
    exhaustivePayoutStates: [outcome, opposite],
    humanLabel: outcome,
    legs: {
      kalshi: {
        platform: 'kalshi', platformMarketId: tuple.kalshiTicker, parentEventId,
        selectedOutcome: outcome, contractSide: tuple.kalshiSide, payoutState: payout(tuple.kalshiSide),
        eventPayoutStates: [outcome, opposite], resolutionRuleId, humanLabel: kalshiOutcome,
        marketQuestion: kalshiQuestion, tokenId: null,
      },
      polymarket: {
        platform: 'polymarket', platformMarketId: tuple.pmConditionId, parentEventId,
        selectedOutcome: outcome, contractSide: tuple.pmSide, payoutState: payout(tuple.pmSide),
        eventPayoutStates: [outcome, opposite], resolutionRuleId, humanLabel: pmOutcome,
        marketQuestion: pmQuestion, tokenId: tuple.pmTokenId,
      },
    },
  };
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

  async function persistVerified(
    input: MatchedMarketMappingInput,
    options: { schemaReady?: boolean } = {},
  ): Promise<{ mappingId: string; revision: string; inserted: boolean }> {
    if (!options.schemaReady) await ensureSchema();
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
    let inserted = false;
    if (!existing.rows.some((row) => String(row.mapping_id) === mappingId)) {
      const insert = await client.execute({
        sql: `INSERT OR IGNORE INTO matched_market_mappings
          (mapping_id,matched_market_id,kalshi_ticker,pm_condition_id,pm_token_id,kalshi_side,pm_side,
           relationship_json,mapping_revision,evidence_revision,resolution_rule_revision,source,created_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        args: [mappingId, marketId, tuple.kalshiTicker, tuple.pmConditionId, tuple.pmTokenId, tuple.kalshiSide, tuple.pmSide,
          JSON.stringify(input.relationship), revision, input.relationship.evidenceRevision,
          input.relationship.resolutionRuleRevision, input.source, new Date().toISOString()],
      });
      inserted = Number(insert.rowsAffected ?? 0) > 0;
      if (inserted) await client.execute({
        sql: `INSERT INTO matched_market_mapping_audit (matched_market_id,mapping_id,classification,reason,recorded_at)
          VALUES (?,?,?,?,?)`,
        args: [marketId, mappingId, 'mapped', `Persisted exact ${tuple.kalshiTicker}/${tuple.pmConditionId}/${tuple.pmTokenId}/${tuple.kalshiSide}/${tuple.pmSide}`, new Date().toISOString()],
      });
    }
    return { mappingId, revision, inserted };
  }

  async function resolve(input: MatchedMarketExecutionTuple): Promise<MatchedMarketMappingResolution> {
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

  async function resolveOrDerive(input: MatchedMarketDerivationInput): Promise<MatchedMarketMappingResolution> {
    const current = await resolve(input);
    if (current.state === 'verified' || current.state === 'invalid') return current;
    const marketId = input.matchedMarketId.trim();
    if (!Number.isSafeInteger(input.sourceScanId) || Number(input.sourceScanId) <= 0) {
      if (current.state === 'mismatch') return current;
      return {
        state: 'invalid', matchedMarketId: marketId,
        reason: `Matched market ${marketId} cannot derive exact tuple ${input.kalshiTicker}/${input.pmConditionId}/${input.pmTokenId}/${input.kalshiSide}/${input.pmSide}: persisted source scan ID is missing`,
      };
    }
    const sourceScanId = Number(input.sourceScanId);
    const scan = await client.execute({
      sql: 'SELECT raw_result,scanned_at FROM scan_results WHERE id=? AND market_id=? LIMIT 1',
      args: [sourceScanId, marketId],
    });
    if (scan.rows.length !== 1) {
      return {
        state: 'invalid', matchedMarketId: marketId,
        reason: `Matched market ${marketId} cannot derive exact tuple from scan ${sourceScanId}: persisted scan identity does not match`,
      };
    }
    let candidates: Record<string, unknown>[];
    try {
      const raw = JSON.parse(String(scan.rows[0].raw_result)) as { allArbs?: unknown };
      candidates = Array.isArray(raw.allArbs)
        ? raw.allArbs.filter((candidate): candidate is Record<string, unknown> => Boolean(candidate) && typeof candidate === 'object')
        : [];
    } catch {
      return {
        state: 'invalid', matchedMarketId: marketId,
        reason: `Matched market ${marketId} cannot derive exact tuple from scan ${sourceScanId}: persisted scan payload is malformed`,
      };
    }
    const exact = candidates.filter((candidate) => {
      const tuple = candidateTuple(candidate);
      return tuple != null && tupleMatches(tuple, input);
    });
    const identifiers = `${input.kalshiTicker}/${input.pmConditionId}/${input.pmTokenId}/${input.kalshiSide}/${input.pmSide}`;
    if (exact.length !== 1) {
      return {
        state: exact.length === 0 ? 'mismatch' : 'invalid', matchedMarketId: marketId,
        reason: `Matched market ${marketId} exact outcome resolution for ${identifiers} is ${exact.length === 0 ? 'not present' : `ambiguous (${exact.length} persisted candidates)`} in scan ${sourceScanId}`,
      };
    }
    const tuple = candidateTuple(exact[0])!;
    const relationship = derivedRelationship(marketId, sourceScanId, String(scan.rows[0].scanned_at), exact[0], tuple);
    if ('reason' in relationship) {
      return {
        state: 'invalid', matchedMarketId: marketId,
        reason: `Matched market ${marketId} exact outcome resolution conflict for ${identifiers} in scan ${sourceScanId}: ${relationship.reason}`,
      };
    }
    await persistVerified(
      { matchedMarketId: marketId, relationship, source: 'matched_market_scan_derivation' },
      { schemaReady: true },
    );
    return resolve(input);
  }

  async function counts() {
    await ensureSchema();
    const result = await client.execute(`SELECT classification,count(*) n FROM matched_market_mapping_audit GROUP BY classification`);
    const counts = { mapped: 0, missing: 0, conflicting: 0, rejected: 0 };
    for (const row of result.rows) counts[String(row.classification) as keyof typeof counts] = Number(row.n);
    return counts;
  }
  return { ensureSchema, persistVerified, resolve, resolveOrDerive, counts };
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

export async function resolveOrDeriveMatchedMarketMapping(input: MatchedMarketDerivationInput): Promise<MatchedMarketMappingResolution> {
  const client = createClient({ url: `file:${DB_PATH}` });
  try { return await createMatchedMarketMappingStore(client).resolveOrDerive(input); }
  finally { client.close(); }
}
