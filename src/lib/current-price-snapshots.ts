import path from 'node:path';
import { createClient, type Client } from '@libsql/client';
import type { UnifiedOutcome } from './matcher';

export type PriceSnapshotPlatform = 'kalshi' | 'polymarket';
export type PriceSnapshotSide = 'yes' | 'no';
export type PriceSnapshotStatus = 'available' | 'stale' | 'unavailable' | 'missing_identifier' | 'side_mismatch' | 'never_saved';

export interface PriceSnapshotRequest {
  platform: PriceSnapshotPlatform;
  marketId: string | null;
  side: PriceSnapshotSide;
  tokenId: string | null;
}

export interface PersistedPriceSnapshot {
  status: PriceSnapshotStatus;
  priceCents: number | null;
  /** Last-scanned outcome price in millionths of one cent. */
  priceMicrocents?: number | null;
  source: string | null;
  observedAt: string | null;
  ageMs: number | null;
  executableDepthMicros?: number | null;
  failureReason?: string | null;
  /** Why the newest scan could not replace the retained indicative mark. */
  markFailureReason?: string | null;
}

export interface PriceSnapshotInput {
  platform: PriceSnapshotPlatform;
  marketId: string;
  side: PriceSnapshotSide;
  tokenId: string | null;
  priceCents: number | null;
  /** Last-scanned outcome price in millionths of one cent. */
  priceMicrocents?: number | null;
  executableDepthMicros: number | null;
  failureReason: string | null;
  markFailureReason?: string | null;
  source: 'saved-market-full-scan' | 'saved-market-quick-refresh';
  observedAt: string;
  /** Request observation/start time, separate from successful quote observation. */
  attemptedAt?: string;
  /** Monotonic saved-market scan generation reserved before upstream work. */
  publicationGeneration?: number;
  /** Saved-market identity that scopes publicationGeneration comparisons. */
  publicationScope?: string | null;
}

const SQLITE_PATH = process.env.H2H_SQLITE_PATH || path.join(process.cwd(), 'data', 'edgefinder.db');
const STALE_AFTER_MS = 15 * 60_000;
const READ_CHUNK_SIZE = 200;
let client: Client | null = null;
let schemaReady: Promise<void> | null = null;
let metrics = { readBatches: 0, writeBatches: 0, lastRequestedLegs: 0, lastUniqueLegs: 0 };

export function getCurrentPriceSnapshotMetrics(reset = false) {
  const snapshot = { ...metrics };
  if (reset) metrics = { readBatches: 0, writeBatches: 0, lastRequestedLegs: 0, lastUniqueLegs: 0 };
  return snapshot;
}

function db(): Client {
  if (!client) client = createClient({ url: `file:${SQLITE_PATH}` });
  return client;
}

async function ensureSchema(): Promise<void> {
  if (!schemaReady) {
    schemaReady = (async () => {
      // Disposable full-scan workers each own a connection. Configure the
      // SQLite writer wait before schema verification or snapshot upserts so
      // a concurrent WAL writer does not fail an otherwise durable scan.
      await db().execute('PRAGMA busy_timeout = 5000');
      await db().execute(`CREATE TABLE IF NOT EXISTS platform_price_snapshots (
        platform TEXT NOT NULL,
        market_id TEXT NOT NULL,
        side TEXT NOT NULL,
        token_id TEXT,
        price_cents INTEGER,
        snapshot_status TEXT NOT NULL,
        source TEXT NOT NULL,
        observed_at TEXT NOT NULL,
        publication_generation INTEGER NOT NULL DEFAULT 0,
        publication_scope TEXT,
        PRIMARY KEY (platform, market_id, side)
      )`);
      await db().execute('CREATE INDEX IF NOT EXISTS idx_platform_price_snapshot_token ON platform_price_snapshots(platform, token_id, side)');
      const info = await db().execute('PRAGMA table_info(platform_price_snapshots)');
      const columns = new Set(info.rows.map((row) => String(row.name)));
      if (!columns.has('executable_depth_micros')) {
        await db().execute('ALTER TABLE platform_price_snapshots ADD COLUMN executable_depth_micros INTEGER');
      }
      if (!columns.has('attempted_at')) {
        await db().execute('ALTER TABLE platform_price_snapshots ADD COLUMN attempted_at TEXT');
      }
      if (!columns.has('failure_reason')) {
        await db().execute('ALTER TABLE platform_price_snapshots ADD COLUMN failure_reason TEXT');
      }
      if (!columns.has('price_microcents')) {
        await db().execute('ALTER TABLE platform_price_snapshots ADD COLUMN price_microcents INTEGER');
        await db().execute(`UPDATE platform_price_snapshots
          SET price_microcents = price_cents * 1000000
          WHERE price_cents IS NOT NULL AND price_microcents IS NULL`);
      }
      if (!columns.has('mark_failure_reason')) {
        await db().execute('ALTER TABLE platform_price_snapshots ADD COLUMN mark_failure_reason TEXT');
      }
      if (!columns.has('publication_generation')) {
        await db().execute('ALTER TABLE platform_price_snapshots ADD COLUMN publication_generation INTEGER NOT NULL DEFAULT 0');
      }
      if (!columns.has('publication_scope')) {
        await db().execute('ALTER TABLE platform_price_snapshots ADD COLUMN publication_scope TEXT');
      }
    })().catch((error) => {
      schemaReady = null;
      throw error;
    });
  }
  await schemaReady;
}

function normalized(value: string): string {
  return value.trim().toLowerCase();
}

export function currentPriceSnapshotKey(request: PriceSnapshotRequest): string {
  return `${request.platform}|${request.marketId ? normalized(request.marketId) : ''}|${request.side}|${request.tokenId ? normalized(request.tokenId) : ''}`;
}

function scannedPrice(price: unknown): Pick<PriceSnapshotInput, 'priceCents' | 'priceMicrocents'> {
  if (typeof price !== 'number' || !Number.isFinite(price) || price < 0 || price > 1) {
    return { priceCents: null, priceMicrocents: null };
  }
  const priceMicrocents = Math.round(price * 100_000_000);
  const priceCents = Math.round(priceMicrocents / 1_000_000);
  return Number.isSafeInteger(priceMicrocents) && priceMicrocents >= 0 && priceMicrocents <= 100_000_000
    ? { priceCents, priceMicrocents }
    : { priceCents: null, priceMicrocents: null };
}

function depthToMicros(depth: unknown): number | null {
  const value = typeof depth === 'string' && /^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(depth)
    ? Number(depth)
    : typeof depth === 'number' ? depth : Number.NaN;
  const micros = Math.round(value * 1_000_000);
  return Number.isFinite(value) && value >= 0 && Number.isSafeInteger(micros) ? micros : null;
}

function executableEvidence(
  platform: PriceSnapshotPlatform,
  side: PriceSnapshotSide,
  bid: unknown,
  depth: unknown,
): Pick<PriceSnapshotInput, 'executableDepthMicros' | 'failureReason'> {
  const { priceCents } = scannedPrice(bid);
  const executableDepthMicros = depthToMicros(depth);
  const label = `${platform === 'kalshi' ? 'Kalshi' : 'Polymarket'} ${side.toUpperCase()}`;
  let failureReason: string | null = null;
  if (priceCents == null) failureReason = `${label} executable bid unavailable`;
  else if (executableDepthMicros == null) failureReason = `${label} executable depth unavailable`;
  else if (executableDepthMicros < 1_000_000) {
    failureReason = `${label} executable depth ${executableDepthMicros / 1_000_000} is below one share`;
  }
  return { executableDepthMicros, failureReason };
}

function pmTokens(outcome: NonNullable<UnifiedOutcome['polymarket']>): { yes: string | null; no: string | null } {
  return {
    yes: typeof outcome.yesTokenId === 'string' && outcome.yesTokenId.trim() ? outcome.yesTokenId : null,
    no: typeof outcome.noTokenId === 'string' && outcome.noTokenId.trim() ? outcome.noTokenId : null,
  };
}

export function snapshotInputsFromOutcomes(
  outcomes: UnifiedOutcome[],
  observedAt: { kalshi: string; polymarket: string },
  source: PriceSnapshotInput['source'],
  publication?: { attemptedAt?: string; generation?: number; scope?: string | null },
): PriceSnapshotInput[] {
  const snapshots = new Map<string, PriceSnapshotInput>();
  for (const outcome of outcomes) {
    if (outcome.kalshi?.ticker) {
      for (const side of ['yes', 'no'] as const) {
        const input: PriceSnapshotInput = {
          platform: 'kalshi', marketId: outcome.kalshi.ticker, side, tokenId: null,
          ...scannedPrice(side === 'yes' ? outcome.kalshi.yesAsk : outcome.kalshi.noAsk),
          ...executableEvidence('kalshi', side,
            side === 'yes' ? outcome.kalshi.yesBid : outcome.kalshi.noBid,
            side === 'yes' ? outcome.kalshi.yesBidDepth : outcome.kalshi.noBidDepth),
          source, observedAt: observedAt.kalshi,
          attemptedAt: publication?.attemptedAt,
          publicationGeneration: publication?.generation,
          publicationScope: publication?.scope,
        };
        input.markFailureReason = input.priceMicrocents == null
          ? `Kalshi ${side.toUpperCase()} last-scanned price unavailable`
          : null;
        snapshots.set(currentPriceSnapshotKey(input), input);
      }
    }
    if (outcome.polymarket?.conditionId) {
      const tokens = pmTokens(outcome.polymarket);
      for (const side of ['yes', 'no'] as const) {
        const input: PriceSnapshotInput = {
          platform: 'polymarket', marketId: outcome.polymarket.conditionId, side, tokenId: tokens[side],
          ...scannedPrice(side === 'yes' ? outcome.polymarket.yesPrice : outcome.polymarket.noPrice),
          ...executableEvidence('polymarket', side,
            side === 'yes' ? outcome.polymarket.yesBid : outcome.polymarket.noBid,
            side === 'yes' ? outcome.polymarket.yesBidDepth : outcome.polymarket.noBidDepth),
          source, observedAt: outcome.polymarket.quoteObservedAt ?? observedAt.polymarket,
          attemptedAt: publication?.attemptedAt,
          publicationGeneration: publication?.generation,
          publicationScope: publication?.scope,
        };
        input.markFailureReason = input.priceMicrocents == null
          ? `Polymarket ${side.toUpperCase()} last-scanned price unavailable`
          : null;
        snapshots.set(currentPriceSnapshotKey(input), input);
      }
    }
  }
  return [...snapshots.values()];
}

export async function persistPlatformPriceSnapshots(inputs: PriceSnapshotInput[]): Promise<{ attempted: number; applied: number }> {
  await ensureSchema();
  const valid = inputs.filter((input) => input.marketId.trim() && Number.isFinite(Date.parse(input.observedAt)));
  let applied = 0;
  for (let offset = 0; offset < valid.length; offset += READ_CHUNK_SIZE) {
    const statements = valid.slice(offset, offset + READ_CHUNK_SIZE).map((input) => {
      const exactIdentityAvailable = input.platform === 'kalshi' || Boolean(input.tokenId?.trim());
      const indicativePriceAvailable = input.priceMicrocents != null || input.priceCents != null;
      const publicationGeneration = Number.isSafeInteger(input.publicationGeneration)
        && (input.publicationGeneration ?? 0) >= 0 ? input.publicationGeneration! : 0;
      const attemptedAt = input.attemptedAt && Number.isFinite(Date.parse(input.attemptedAt))
        ? input.attemptedAt : input.observedAt;
      const publicationScope = input.publicationScope?.trim()
        ? normalized(input.publicationScope) : null;
      return {
        sql: `INSERT INTO platform_price_snapshots
        (platform, market_id, side, token_id, price_cents, price_microcents, executable_depth_micros,
         snapshot_status, source, observed_at, attempted_at, failure_reason, mark_failure_reason,
         publication_generation, publication_scope)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(platform, market_id, side) DO UPDATE SET
          token_id = COALESCE(excluded.token_id, platform_price_snapshots.token_id),
          price_cents = CASE WHEN excluded.snapshot_status = 'available'
            THEN excluded.price_cents ELSE platform_price_snapshots.price_cents END,
          price_microcents = CASE WHEN excluded.snapshot_status = 'available'
            THEN excluded.price_microcents ELSE platform_price_snapshots.price_microcents END,
          executable_depth_micros = excluded.executable_depth_micros,
          snapshot_status = CASE WHEN excluded.snapshot_status = 'available'
            THEN 'available' ELSE platform_price_snapshots.snapshot_status END,
          source = CASE WHEN excluded.snapshot_status = 'available' THEN excluded.source ELSE platform_price_snapshots.source END,
          observed_at = CASE WHEN excluded.snapshot_status = 'available' THEN excluded.observed_at ELSE platform_price_snapshots.observed_at END,
          attempted_at = excluded.attempted_at,
          failure_reason = excluded.failure_reason,
          mark_failure_reason = excluded.mark_failure_reason,
          publication_generation = excluded.publication_generation,
          publication_scope = excluded.publication_scope
        WHERE excluded.attempted_at > COALESCE(platform_price_snapshots.attempted_at, platform_price_snapshots.observed_at)
          OR (excluded.attempted_at = COALESCE(platform_price_snapshots.attempted_at, platform_price_snapshots.observed_at)
            AND excluded.publication_scope IS NOT NULL
            AND excluded.publication_scope = platform_price_snapshots.publication_scope
            AND excluded.publication_generation > COALESCE(platform_price_snapshots.publication_generation, 0))`,
        args: [input.platform, normalized(input.marketId), input.side,
          input.tokenId ? normalized(input.tokenId) : null, input.priceCents,
          input.priceMicrocents ?? (input.priceCents == null ? null : input.priceCents * 1_000_000),
          input.executableDepthMicros,
          indicativePriceAvailable && exactIdentityAvailable ? 'available' : 'unavailable',
          input.source, input.observedAt, attemptedAt, input.failureReason,
          input.markFailureReason ?? (!exactIdentityAvailable
            ? 'Polymarket exact outcome token unavailable'
            : !indicativePriceAvailable ? 'Last-scanned price unavailable' : null),
          publicationGeneration, publicationScope],
      };
    });
    metrics.writeBatches += 1;
    const results = await db().batch(statements, 'write');
    applied += results.reduce((sum, result) => sum + Number(result.rowsAffected ?? 0), 0);
  }
  return { attempted: valid.length, applied };
}

interface SnapshotRow {
  platform: string;
  market_id: string;
  side: string;
  token_id: string | null;
  price_cents: number | null;
  price_microcents: number | null;
  snapshot_status: string;
  source: string;
  observed_at: string;
  attempted_at: string | null;
  executable_depth_micros: number | null;
  failure_reason: string | null;
  mark_failure_reason: string | null;
}

function unavailable(status: PriceSnapshotStatus): PersistedPriceSnapshot {
  return {
    status, priceCents: null, priceMicrocents: null, source: null, observedAt: null, ageMs: null,
    executableDepthMicros: null, failureReason: null, markFailureReason: null,
  };
}

export async function getPersistedCurrentPriceBatch(
  requests: PriceSnapshotRequest[],
  now = Date.now(),
): Promise<Map<string, PersistedPriceSnapshot>> {
  await ensureSchema();
  const unique = new Map(requests.map((request) => [currentPriceSnapshotKey(request), request]));
  metrics.lastRequestedLegs = requests.length;
  metrics.lastUniqueLegs = unique.size;
  const result = new Map<string, PersistedPriceSnapshot>();
  const valid = [...unique.entries()].filter(([, request]) => {
    if (!request.marketId?.trim()) {
      result.set(currentPriceSnapshotKey(request), unavailable('missing_identifier'));
      return false;
    }
    // Polymarket parent + side is not an immutable held contract identity.
    // A later scan may replace that side with another token under the same
    // event, so valuation must always carry the execution-time token.
    if (request.platform === 'polymarket' && !request.tokenId?.trim()) {
      result.set(currentPriceSnapshotKey(request), unavailable('missing_identifier'));
      return false;
    }
    return true;
  });

  const rows: SnapshotRow[] = [];
  for (let offset = 0; offset < valid.length; offset += READ_CHUNK_SIZE) {
    const chunk = valid.slice(offset, offset + READ_CHUNK_SIZE);
    const clauses = chunk.map(() => '(platform = ? AND market_id = ?)').join(' OR ');
    const args = chunk.flatMap(([, request]) => [request.platform, normalized(request.marketId!)]);
    metrics.readBatches += 1;
    const response = await db().execute({ sql: `SELECT * FROM platform_price_snapshots WHERE ${clauses}`, args });
    rows.push(...response.rows as unknown as SnapshotRow[]);
  }

  for (const [key, request] of valid) {
    const marketId = normalized(request.marketId!);
    const tokenId = request.tokenId ? normalized(request.tokenId) : null;
    const candidates = rows.filter((row) => row.platform === request.platform
      && normalized(row.market_id) === marketId);
    if (candidates.length === 0) {
      result.set(key, unavailable('never_saved'));
      continue;
    }
    const exact = candidates.find((row) => row.side === request.side
      && (tokenId == null || (row.token_id != null && normalized(row.token_id) === tokenId)));
    if (!exact) {
      result.set(key, unavailable('side_mismatch'));
      continue;
    }
    const observedMs = Date.parse(String(exact.observed_at));
    const ageMs = Number.isFinite(observedMs) ? Math.max(0, now - observedMs) : null;
    const priceCents = exact.price_cents == null ? null : Number(exact.price_cents);
    const priceMicrocents = exact.price_microcents == null
      ? (priceCents == null ? null : priceCents * 1_000_000)
      : Number(exact.price_microcents);
    const executableDepthMicros = exact.executable_depth_micros == null ? null : Number(exact.executable_depth_micros);
    const failureReason = exact.failure_reason == null ? null : String(exact.failure_reason);
    const markFailureReason = exact.mark_failure_reason == null ? null : String(exact.mark_failure_reason);
    const attemptedMs = exact.attempted_at == null ? observedMs : Date.parse(String(exact.attempted_at));
    const retainedAfterNewerFailure = Number.isFinite(attemptedMs) && Number.isFinite(observedMs)
      && attemptedMs > observedMs;
    if (exact.snapshot_status !== 'available'
      || !Number.isSafeInteger(priceCents) || priceCents! < 0 || priceCents! > 100
      || !Number.isSafeInteger(priceMicrocents) || priceMicrocents! < 0 || priceMicrocents! > 100_000_000) {
      result.set(key, {
        status: 'unavailable', priceCents, priceMicrocents, source: String(exact.source), observedAt: String(exact.observed_at), ageMs,
        executableDepthMicros, failureReason, markFailureReason,
      });
      continue;
    }
    result.set(key, {
      status: retainedAfterNewerFailure || (ageMs != null && ageMs > STALE_AFTER_MS) ? 'stale' : 'available',
      priceCents, priceMicrocents, source: String(exact.source), observedAt: String(exact.observed_at), ageMs,
      executableDepthMicros, failureReason, markFailureReason,
    });
  }
  return result;
}
