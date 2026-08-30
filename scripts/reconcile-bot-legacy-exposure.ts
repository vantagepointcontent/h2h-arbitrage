/// <reference types="node" />

/**
 * BUG-172 forensic census and revision-fenced legacy exposure reconciliation.
 *
 * Dry-run (default): npm run reconcile:bot-legacy-exposure
 * Apply:             npm run reconcile:bot-legacy-exposure -- --apply
 * Alternate DB:      npm run reconcile:bot-legacy-exposure -- --db=/absolute/path.db
 * Explicit report:   --output=/absolute/path.json
 *
 * This process reads only persisted SQLite/audit/registry evidence. It imports no
 * venue adapter and performs no HTTP requests.
 */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createClient, type Client, type InValue } from '@libsql/client';
import auditManifest from '../data/audits/bot-proposition-audit-v1.json';
import {
  applyLegacyExposureReconciliation,
  classifyLegacyExposure,
  legacyExposureEvidenceRevision,
  type LegacyExposurePositionEvidence,
  type LegacyExposureReconciliationDecision,
  type RelationshipValidity,
} from '../src/lib/bot-legacy-exposure-reconciliation';
import {
  historicalAuditLegMetadata,
  historicalAuditPmEntryToken,
  historicalPropositionAudit,
} from '../src/lib/bot-proposition-audit';
import { validatePropositionRelationship, type PropositionRelationship } from '../src/lib/proposition-identity';

const SCHEMA: Record<string, string> = {
  relationship_validity: "TEXT NOT NULL DEFAULT 'unresolved_relationship'",
  exposure_identity_status: "TEXT NOT NULL DEFAULT 'unrecoverable'",
  legacy_exposure_verdict_json: 'TEXT',
  legacy_exposure_revision: 'TEXT',
  legacy_exposure_run_id: 'TEXT',
};

type Row = Record<string, unknown>;
type Snapshot = {
  platform: 'kalshi' | 'polymarket'; marketId: string; side: 'yes' | 'no'; tokenId: string | null;
  priceCents: number | null; priceMicrocents: number | null; status: string; source: string;
  observedAt: string; attemptedAt: string | null; failureReason: string | null; markFailureReason: string | null;
};
type CensusRow = {
  positionId: number;
  after: ReturnType<typeof classifyLegacyExposure>;
  before: ReturnType<typeof classifyLegacyExposure> | null;
  valuationEligible: boolean;
  currentExactSnapshots: { kalshi: Snapshot | null; polymarket: Snapshot | null };
  correlated: Awaited<ReturnType<typeof queryCorrelatedEvidence>>;
  [key: string]: unknown;
};

function option(prefix: string): string | null {
  const value = process.argv.slice(2).find((arg) => arg.startsWith(prefix));
  return value ? value.slice(prefix.length) : null;
}

function parseJson(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function exactString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function lower(value: string | null): string {
  return value?.toLowerCase() ?? '';
}

async function findMatchedMarketRelationship(client: Client, input: {
  matchedMarketId: string | null;
  kalshiTicker: string | null;
  pmConditionId: string | null;
  pmTokenId: string;
  kalshiSide: 'yes' | 'no';
  pmSide: 'yes' | 'no';
}): Promise<PropositionRelationship | null> {
  if (!input.matchedMarketId || !input.kalshiTicker || !input.pmConditionId) return null;
  const result = await client.execute({
    sql: `SELECT relationship_json FROM matched_market_mappings WHERE matched_market_id=?
      AND kalshi_ticker=? AND pm_condition_id=? AND pm_token_id=? AND kalshi_side=? AND pm_side=? LIMIT 1`,
    args: [input.matchedMarketId, input.kalshiTicker.trim().toUpperCase(), input.pmConditionId.trim().toLowerCase(),
      input.pmTokenId.trim(), input.kalshiSide, input.pmSide],
  });
  if (!result.rows[0]) return null;
  try {
    const relationship = JSON.parse(String(result.rows[0].relationship_json)) as PropositionRelationship;
    return validatePropositionRelationship(relationship).valid && relationship.schemaVersion === 2
      ? relationship : null;
  } catch {
    return null;
  }
}

function sha256(value: unknown): string {
  return createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
}

function sqliteLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function snapshotKey(platform: string, marketId: string | null, side: string, tokenId: string | null): string {
  return `${platform}|${lower(marketId)}|${side}|${lower(tokenId)}`;
}

function mapSnapshot(row: Row): Snapshot {
  return {
    platform: String(row.platform) as Snapshot['platform'], marketId: String(row.market_id),
    side: String(row.side) as Snapshot['side'], tokenId: exactString(row.token_id),
    priceCents: row.price_cents == null ? null : Number(row.price_cents),
    priceMicrocents: row.price_microcents == null ? null : Number(row.price_microcents),
    status: String(row.snapshot_status), source: String(row.source), observedAt: String(row.observed_at),
    attemptedAt: exactString(row.attempted_at), failureReason: exactString(row.failure_reason),
    markFailureReason: exactString(row.mark_failure_reason),
  };
}

function availableMark(snapshot: Snapshot | null): boolean {
  return snapshot != null
    && (snapshot.status === 'available' || snapshot.status === 'stale')
    && ((Number.isSafeInteger(snapshot.priceMicrocents) && snapshot.priceMicrocents! >= 0)
      || (Number.isSafeInteger(snapshot.priceCents) && snapshot.priceCents! >= 0))
    && Number.isFinite(Date.parse(snapshot.observedAt));
}

async function columns(client: Client): Promise<Set<string>> {
  const result = await client.execute('PRAGMA table_info(bot_positions)');
  return new Set(result.rows.map((row) => String(row.name)));
}

function selectColumn(existing: Set<string>, name: string): string {
  return existing.has(name) ? name : `NULL AS ${name}`;
}

async function prepareSchema(client: Client): Promise<void> {
  const existing = await columns(client);
  for (const [name, definition] of Object.entries(SCHEMA)) {
    if (!existing.has(name)) await client.execute(`ALTER TABLE bot_positions ADD COLUMN ${name} ${definition}`);
  }
}

async function queryCorrelatedEvidence(client: Client, position: Row, execution: Row | null) {
  const executionId = Number(position.execution_id);
  const marketId = String(position.market_id);
  const timestamp = exactString(execution?.timestamp) ?? String(position.opened_at);
  const [scan, decisions, actions, marketActionSummary, messages, recovery] = await Promise.all([
    client.execute({ sql: `SELECT id, market_id, scanned_at, raw_result, calculation_envelope,
      kalshi_url, polymarket_url, arb_type, arb_valid, arb_invalidation_reason, scan_status
      FROM scan_results WHERE market_id = ? AND scanned_at <= ? ORDER BY scanned_at DESC LIMIT 1`, args: [marketId, timestamp] }),
    client.execute({ sql: `SELECT scan_id, candidate_index, state, reason_code, reason, details, final_result, updated_at
      FROM bot_opportunity_decisions WHERE execution_id = ? ORDER BY updated_at DESC`, args: [executionId] }),
    client.execute({ sql: `SELECT id, timestamp, step, action, response_status, error_reason, request_payload,
      response_payload, alert_metadata, qualification_outcome FROM bot_action_log
      WHERE trade_id = ? ORDER BY timestamp`, args: [String(executionId)] }),
    client.execute({ sql: `SELECT COUNT(*) AS count, MIN(timestamp) AS first_at, MAX(timestamp) AS last_at
      FROM bot_action_log WHERE market_id = ?`, args: [marketId] }),
    client.execute({ sql: `SELECT id, timestamp, message_type, status, error_reason, telegram_message_id
      FROM bot_trader_messages WHERE trade_id = ? ORDER BY timestamp`, args: [String(executionId)] }),
    client.execute({ sql: `SELECT d.id, d.run_id, d.verdict, d.reason, d.source_ids_json, d.source_hashes_json,
      d.before_status, d.after_status, d.decided_at, e.source_table, e.source_row_id, e.source_sha256
      FROM bot_entry_recovery_decisions d LEFT JOIN bot_entry_recovery_evidence e ON e.id = d.evidence_id
      WHERE d.position_id = ? ORDER BY d.decided_at`, args: [Number(position.id)] }),
  ]);
  const compact = (rows: readonly Row[]) => rows.map((row) => ({ ...row, rowSha256: sha256(row) }));
  return {
    executionTimeScan: scan.rows[0] ? { ...scan.rows[0], rowSha256: sha256(scan.rows[0]) } : null,
    opportunityDecisions: compact(decisions.rows as unknown as Row[]),
    actionLog: compact(actions.rows as unknown as Row[]),
    marketActionSummary: marketActionSummary.rows[0] ?? { count: 0, first_at: null, last_at: null },
    alertsAndMessages: compact(messages.rows as unknown as Row[]),
    entryRecovery: compact(recovery.rows as unknown as Row[]),
  };
}

function relationshipAuthority(
  position: Row,
  canonical: PropositionRelationship | null,
  audit: ReturnType<typeof historicalPropositionAudit>,
  auditRevision: string,
): LegacyExposurePositionEvidence['relationshipAuthority'] {
  if (canonical) return {
    verdict: 'verified_complementary', source: 'matched-market-mapping-v1',
    sourceRevision: legacyExposureEvidenceRevision(canonical), capturedAt: canonical.verifiedAt,
    kalshiMarketQuestion: canonical.legs.kalshi.marketQuestion,
    pmMarketQuestion: canonical.legs.polymarket.marketQuestion,
    kalshiOutcomeLabel: canonical.legs.kalshi.payoutState,
    pmOutcomeLabel: canonical.legs.polymarket.payoutState,
  };
  const labels = historicalAuditLegMetadata(audit);
  if (audit?.classification === 'confirmed_invalid' && labels) return {
    verdict: 'confirmed_invalid', source: 'bot-proposition-audit-v1', sourceRevision: auditRevision,
    capturedAt: exactString((audit.evidence as { auditedAt?: unknown } | undefined)?.auditedAt)
      ?? String(auditManifest.generatedAt),
    ...labels,
  };
  const storedState = exactString(position.proposition_relationship_state);
  if (storedState === 'invalid_metadata' || storedState === 'non_exhaustive') return {
    verdict: 'non_exhaustive_conflicting', source: 'persisted-proposition-relationship-state',
    sourceRevision: legacyExposureEvidenceRevision({
      state: storedState, json: position.proposition_relationship_json,
      warning: position.proposition_relationship_warning,
    }), capturedAt: String(position.opened_at),
    kalshiMarketQuestion: null, pmMarketQuestion: null, kalshiOutcomeLabel: null, pmOutcomeLabel: null,
  };
  return null;
}

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  const dbPath = path.resolve(option('--db=') ?? process.env.H2H_SQLITE_PATH ?? 'data/edgefinder.db');
  if (!existsSync(dbPath)) throw new Error(`SQLite database does not exist: ${dbPath}`);
  const stamp = new Date().toISOString().replaceAll(':', '-');
  const outputPath = path.resolve(option('--output=') ?? `artifacts/bug172-forensic-census-${apply ? 'apply' : 'dry-run'}-${stamp}.json`);
  const backupPath = apply ? path.resolve(option('--backup=') ?? `backups/bug172-preapply-${stamp}.db`) : null;
  const auditRevision = `sha256:${sha256(JSON.stringify(auditManifest))}`;
  const client = createClient({ url: `file:${dbPath}` });
  try {
    await client.execute('PRAGMA busy_timeout = 30000');
    const existing = await columns(client);
    const result = await client.execute(`SELECT bp.*, e.timestamp AS execution_timestamp, e.dry_run, e.success AS execution_success,
      e.kalshi_order, e.polymarket_order, e.result AS execution_result, e.steps AS execution_steps,
      e.arb_id, e.strategy AS execution_strategy, e.source AS execution_source,
      e.selection_method AS execution_selection_method, e.bot_entry_evidence,
      e.proposition_relationship AS execution_proposition_relationship,
      e.calculation_envelope AS execution_calculation_envelope,
      ${selectColumn(existing, 'relationship_validity')}, ${selectColumn(existing, 'exposure_identity_status')},
      ${selectColumn(existing, 'legacy_exposure_verdict_json')}, ${selectColumn(existing, 'legacy_exposure_revision')},
      ${selectColumn(existing, 'legacy_exposure_run_id')}
      FROM bot_positions bp LEFT JOIN executions e ON e.id = bp.execution_id ORDER BY bp.id`);
    const snapshotRows = await client.execute(`SELECT platform, market_id, side, token_id, price_cents,
      price_microcents, snapshot_status, source, observed_at, attempted_at, failure_reason, mark_failure_reason
      FROM platform_price_snapshots WHERE platform IN ('kalshi', 'polymarket')`);
    const snapshots = (snapshotRows.rows as unknown as Row[]).map(mapSnapshot);
    const snapshotMap = new Map(snapshots.map((snapshot) => [
      snapshotKey(snapshot.platform, snapshot.marketId, snapshot.side, snapshot.tokenId), snapshot,
    ]));
    const pmBindings = new Map<string, Snapshot[]>();
    for (const snapshot of snapshots.filter((item) => item.platform === 'polymarket' && item.tokenId)) {
      const key = `${lower(snapshot.marketId)}|${snapshot.side}`;
      pmBindings.set(key, [...(pmBindings.get(key) ?? []), snapshot]);
    }

    const decisions: LegacyExposureReconciliationDecision[] = [];
    const census: CensusRow[] = [];
    let conflicts = 0;
    let newlyValued = 0;
    for (const position of result.rows as unknown as Row[]) {
      const kalshiOrder = parseJson(position.kalshi_order);
      const polymarketOrder = parseJson(position.polymarket_order);
      const executionResult = parseJson(position.execution_result);
      const persistedToken = exactString(position.pm_entry_token_id);
      const requestedToken = exactString(polymarketOrder?.marketId);
      const pmMarket = exactString(position.pm_condition_id);
      const pmSide = String(position.pm_side) as 'yes' | 'no';
      const bindingCandidates = (pmBindings.get(`${lower(pmMarket)}|${pmSide}`) ?? [])
        .filter((snapshot) => snapshot.tokenId === persistedToken || snapshot.tokenId === requestedToken);
      const audit = historicalPropositionAudit(Number(position.execution_id), {
        positionId: Number(position.id), openedAt: String(position.opened_at),
        kalshiTicker: exactString(position.kalshi_ticker), pmConditionId: pmMarket,
        pmTokenId: persistedToken, kalshiSide: String(position.kalshi_side), pmSide,
      });
      const auditToken = historicalAuditPmEntryToken(audit);
      if (auditToken && pmMarket && !bindingCandidates.some((snapshot) => snapshot.tokenId === auditToken)) {
        bindingCandidates.push({
          platform: 'polymarket', marketId: pmMarket, side: pmSide, tokenId: auditToken,
          priceCents: null, priceMicrocents: null, status: 'unavailable', source: 'bot-proposition-audit-v1',
          observedAt: String(auditManifest.generatedAt), attemptedAt: null, failureReason: null, markFailureReason: null,
        });
      }
      const candidateTokens = [...new Set(bindingCandidates.map((snapshot) => snapshot.tokenId).filter(Boolean))] as string[];
      const canonicalCandidates = (await Promise.all(
        [...new Set([persistedToken, ...candidateTokens].filter((token): token is string => Boolean(token)))]
          .map((token) => findMatchedMarketRelationship(client, {
            matchedMarketId: exactString(position.market_id),
            kalshiTicker: exactString(position.kalshi_ticker), pmConditionId: pmMarket, pmTokenId: token,
            kalshiSide: String(position.kalshi_side) as 'yes' | 'no', pmSide,
          })),
      )).filter((value): value is PropositionRelationship => value != null);
      const canonical = canonicalCandidates.length === 1 ? canonicalCandidates[0] : null;
      let relation = relationshipAuthority(position, canonical, audit, auditRevision);
      if (candidateTokens.length > 1 || canonicalCandidates.length > 1) {
        conflicts += 1;
        relation = {
          verdict: 'non_exhaustive_conflicting', source: 'bug172-token-binding-conflict',
          sourceRevision: legacyExposureEvidenceRevision(candidateTokens), capturedAt: stamp,
          kalshiMarketQuestion: null, pmMarketQuestion: null, kalshiOutcomeLabel: null, pmOutcomeLabel: null,
        };
      }
      const binding = candidateTokens.length === 1
        ? bindingCandidates.find((snapshot) => snapshot.tokenId === candidateTokens[0]) ?? null : null;
      const pmTokenAuthority = binding && pmMarket ? {
        tokenId: binding.tokenId!, marketId: pmMarket, side: pmSide,
        source: binding.source, sourceRevision: legacyExposureEvidenceRevision(binding), capturedAt: binding.observedAt,
      } : null;
      const normalizedExecution: LegacyExposurePositionEvidence['execution'] = position.execution_timestamp == null ? null : {
        id: Number(position.execution_id), timestamp: String(position.execution_timestamp),
        dryRun: Boolean(position.dry_run), success: Boolean(position.execution_success),
        kalshiOrder: kalshiOrder as NonNullable<LegacyExposurePositionEvidence['execution']>['kalshiOrder'],
        polymarketOrder: polymarketOrder as NonNullable<LegacyExposurePositionEvidence['execution']>['polymarketOrder'],
        result: executionResult as NonNullable<LegacyExposurePositionEvidence['execution']>['result'],
      };
      const input: LegacyExposurePositionEvidence = {
        position: {
          id: Number(position.id), executionId: Number(position.execution_id),
          executionMode: position.execution_mode === 'live' ? 'live' : 'paper', status: String(position.status),
          openedAt: String(position.opened_at), kalshiTicker: exactString(position.kalshi_ticker),
          pmConditionId: pmMarket, pmEntryTokenId: persistedToken,
          kalshiSide: String(position.kalshi_side) as 'yes' | 'no', pmSide,
          sharesKalshi: Number(position.shares_kalshi), sharesPm: Number(position.shares_pm),
          outcomeIdentityStatus: position.outcome_identity_status === 'verified' ? 'verified' : 'unresolved',
          propositionRelationshipState: exactString(position.proposition_relationship_state) ?? 'unknown',
          legacyExposureRevision: exactString(position.legacy_exposure_revision),
        },
        execution: normalizedExecution, relationshipAuthority: relation, pmTokenAuthority,
        nonAuthoritativeContext: {
          marketTitle: position.market_title, strategy: position.execution_strategy ?? position.strategy,
          selectionMethod: position.execution_selection_method ?? position.selection_method,
          calculationEnvelope: parseJson(position.execution_calculation_envelope),
        },
      };
      const after = classifyLegacyExposure(input);
      let before = null;
      try { before = position.legacy_exposure_verdict_json ? JSON.parse(String(position.legacy_exposure_verdict_json)) : null; } catch { before = null; }
      const changed = exactString(position.legacy_exposure_revision) !== after.revision
        || JSON.stringify(before) !== JSON.stringify(after);
      if (changed) decisions.push({
        positionId: Number(position.id), expectedRevision: exactString(position.legacy_exposure_revision), before, after,
      });
      const kalshiSnapshot = snapshotMap.get(snapshotKey('kalshi', exactString(position.kalshi_ticker), String(position.kalshi_side), null)) ?? null;
      const pmSnapshot = after.exactLegs.polymarket.tokenId
        ? snapshotMap.get(snapshotKey('polymarket', pmMarket, pmSide, after.exactLegs.polymarket.tokenId)) ?? null : null;
      const valuationEligible = after.exposureIdentity === 'exact_held_legs_proven'
        && availableMark(kalshiSnapshot) && availableMark(pmSnapshot);
      if (valuationEligible && before?.exposureIdentity !== 'exact_held_legs_proven') newlyValued += 1;
      const correlated = await queryCorrelatedEvidence(client, position, position.execution_timestamp == null ? null : position);
      census.push({
        positionId: Number(position.id), executionId: Number(position.execution_id),
        executionMode: input.position.executionMode, simulated: input.position.executionMode === 'paper',
        status: input.position.status, requestedQuantity: {
          kalshi: kalshiOrder?.contracts ?? kalshiOrder?.size ?? null,
          polymarket: polymarketOrder?.contracts ?? polymarketOrder?.size ?? null,
        },
        filledQuantity: {
          kalshi: (executionResult?.kalshiResult as Row | undefined)?.filledContracts ?? null,
          polymarket: (executionResult?.polymarketResult as Row | undefined)?.filledContracts ?? null,
        },
        orderIds: {
          kalshi: (executionResult?.kalshiResult as Row | undefined)?.orderId ?? null,
          polymarket: (executionResult?.polymarketResult as Row | undefined)?.orderId ?? null,
        },
        cancellationRollback: {
          success: position.execution_success, rollbackExecuted: executionResult?.rollbackExecuted ?? null,
          unhedged: executionResult?.unhedged ?? null,
          kalshiStatus: (executionResult?.kalshiResult as Row | undefined)?.status ?? null,
          polymarketStatus: (executionResult?.polymarketResult as Row | undefined)?.status ?? null,
        },
        exactIdentifiers: after.exactLegs,
        relationshipAuthority: relation,
        pmTokenAuthority,
        currentExactSnapshots: { kalshi: kalshiSnapshot, polymarket: pmSnapshot },
        valuationEligible, before, after, changed,
        immutableExecution: normalizedExecution,
        executionArtifacts: {
          arbId: position.arb_id, source: position.execution_source,
          steps: parseJson(position.execution_steps), botEntryEvidence: parseJson(position.bot_entry_evidence),
          propositionRelationship: parseJson(position.execution_proposition_relationship),
          calculationEnvelope: parseJson(position.execution_calculation_envelope),
        },
        correlated,
      });
    }

    const count = (relationship: RelationshipValidity) => census.filter((row) => row.after.relationshipValidity === relationship).length;
    const exposureCount = (identity: string) => census.filter((row) => row.after.exposureIdentity === identity).length;
    const counts = {
      total: census.length,
      verifiedComplementary: count('verified_complementary'), confirmedInvalid: count('confirmed_invalid'),
      exactExposureWithUnresolvedRelationship: census.filter((row) => row.after.relationshipValidity === 'unresolved_relationship'
        && row.after.exposureIdentity === 'exact_held_legs_proven').length,
      nonExhaustiveConflicting: count('non_exhaustive_conflicting'),
      exactHeldLegsProven: exposureCount('exact_held_legs_proven'), partialIdentity: exposureCount('partially_proven'),
      noFillRolledBack: exposureCount('no_fill_rolled_back'), unrecoverable: exposureCount('unrecoverable'),
      newlyValued, stillUnavailable: census.filter((row) => !row.valuationEligible).length,
      excludedFromVerifiedTotals: census.filter((row) => row.after.excludedFromVerifiedTotals).length,
      conflicts, plannedChanges: decisions.length,
    };
    const sourceRevision = legacyExposureEvidenceRevision({
      auditRevision, positions: census.map((row) => ({ id: row.positionId, before: row.before, after: row.after,
        snapshots: row.currentExactSnapshots, correlated: row.correlated })),
    });
    const runId = `bug172:${sourceRevision}`;
    let applied = 0;
    if (apply && decisions.length > 0) {
      await mkdir(path.dirname(backupPath!), { recursive: true });
      if (existsSync(backupPath!)) throw new Error(`Refusing to overwrite backup: ${backupPath}`);
      // VACUUM INTO is a transactionally consistent SQLite backup even while
      // the source runs in WAL mode. Reconciliation cannot begin until this
      // rollback point exists.
      await client.execute(`VACUUM INTO ${sqliteLiteral(backupPath!)}`);
      const transaction = await client.transaction('write');
      try {
        const txColumns = await transaction.execute('PRAGMA table_info(bot_positions)');
        const names = new Set(txColumns.rows.map((row) => String(row.name)));
        for (const [name, definition] of Object.entries(SCHEMA)) {
          if (!names.has(name)) await transaction.execute(`ALTER TABLE bot_positions ADD COLUMN ${name} ${definition}`);
        }
        const result = await applyLegacyExposureReconciliation(decisions, {
          execute: async (statement) => transaction.execute({ sql: statement.sql, args: statement.args as InValue[] }),
        }, runId);
        applied = result.applied;
        await transaction.commit();
      } catch (error) {
        if (!transaction.closed) await transaction.rollback();
        throw error;
      } finally {
        transaction.close();
      }
      const integrity = await client.execute('PRAGMA integrity_check');
      if (String(integrity.rows[0]?.integrity_check) !== 'ok') throw new Error('SQLite integrity_check failed after apply');
    } else if (apply) {
      await prepareSchema(client);
    }

    const report = {
      schemaVersion: 1, task: 'BUG-172', mode: apply ? 'apply' : 'dry-run', generatedAt: new Date().toISOString(),
      dbPath, sourceRevision, runId, auditRevision, counts, applied,
      zeroVenueCalls: true,
      mutationScope: ['relationship_validity', 'exposure_identity_status', 'legacy_exposure_verdict_json',
        'legacy_exposure_revision', 'legacy_exposure_run_id',
        'human labels only from canonical/fingerprinted authority'],
      immutableFieldsPreserved: ['execution orders/results/fills', 'shares', 'Buy Cost', 'entry fees', 'settlement ledger'],
      rollbackPlan: backupPath ? {
        backupPath, procedure: 'Stop affected writers, retain current DB as evidence, atomically restore this pre-apply SQLite backup, restart services, and rerun PRAGMA integrity_check.',
      } : { procedure: 'Dry-run made no database mutation; no rollback is required.' },
      perPosition: census,
    };
    await mkdir(path.dirname(outputPath), { recursive: true });
    const temporary = `${outputPath}.tmp-${process.pid}`;
    await writeFile(temporary, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, outputPath);
    console.log(JSON.stringify({ mode: report.mode, outputPath, sourceRevision, counts, applied, backupPath }, null, 2));
  } finally {
    client.close();
  }
}

await main();
