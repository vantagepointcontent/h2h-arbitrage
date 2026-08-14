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
  source: string | null;
  observedAt: string | null;
  ageMs: number | null;
}

export interface PriceSnapshotInput {
  platform: PriceSnapshotPlatform;
  marketId: string;
  side: PriceSnapshotSide;
  tokenId: string | null;
  priceCents: number | null;
  source: 'saved-market-full-scan' | 'saved-market-quick-refresh';
  observedAt: string;
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
        PRIMARY KEY (platform, market_id, side)
      )`);
      await db().execute('CREATE INDEX IF NOT EXISTS idx_platform_price_snapshot_token ON platform_price_snapshots(platform, token_id, side)');
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

function priceToCents(price: unknown): number | null {
  if (typeof price !== 'number' || !Number.isFinite(price) || price <= 0 || price > 1) return null;
  const cents = Math.round(price * 100);
  return Number.isSafeInteger(cents) && cents >= 1 && cents <= 100 ? cents : null;
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
): PriceSnapshotInput[] {
  const snapshots = new Map<string, PriceSnapshotInput>();
  for (const outcome of outcomes) {
    if (outcome.kalshi?.ticker) {
      for (const side of ['yes', 'no'] as const) {
        const input: PriceSnapshotInput = {
          platform: 'kalshi', marketId: outcome.kalshi.ticker, side, tokenId: null,
          priceCents: priceToCents(side === 'yes' ? outcome.kalshi.yesAsk : outcome.kalshi.noAsk),
          source, observedAt: observedAt.kalshi,
        };
        snapshots.set(currentPriceSnapshotKey(input), input);
      }
    }
    if (outcome.polymarket?.conditionId) {
      const tokens = pmTokens(outcome.polymarket);
      for (const side of ['yes', 'no'] as const) {
        const input: PriceSnapshotInput = {
          platform: 'polymarket', marketId: outcome.polymarket.conditionId, side, tokenId: tokens[side],
          priceCents: priceToCents(side === 'yes' ? outcome.polymarket.yesPrice : outcome.polymarket.noPrice),
          source, observedAt: observedAt.polymarket,
        };
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
    const statements = valid.slice(offset, offset + READ_CHUNK_SIZE).map((input) => ({
      sql: `INSERT INTO platform_price_snapshots
        (platform, market_id, side, token_id, price_cents, snapshot_status, source, observed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(platform, market_id, side) DO UPDATE SET
          token_id = COALESCE(excluded.token_id, platform_price_snapshots.token_id),
          price_cents = excluded.price_cents,
          snapshot_status = excluded.snapshot_status,
          source = excluded.source,
          observed_at = excluded.observed_at
        WHERE excluded.observed_at > platform_price_snapshots.observed_at`,
      args: [input.platform, normalized(input.marketId), input.side,
        input.tokenId ? normalized(input.tokenId) : null, input.priceCents,
        input.priceCents == null ? 'unavailable' : 'available', input.source, input.observedAt],
    }));
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
  snapshot_status: string;
  source: string;
  observed_at: string;
}

function unavailable(status: PriceSnapshotStatus): PersistedPriceSnapshot {
  return { status, priceCents: null, source: null, observedAt: null, ageMs: null };
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
    return true;
  });

  const rows: SnapshotRow[] = [];
  for (let offset = 0; offset < valid.length; offset += READ_CHUNK_SIZE) {
    const chunk = valid.slice(offset, offset + READ_CHUNK_SIZE);
    const clauses = chunk.map(() => '(platform = ? AND (market_id = ? OR token_id = ?))').join(' OR ');
    const args = chunk.flatMap(([, request]) => [request.platform, normalized(request.marketId!), normalized(request.tokenId ?? request.marketId!)]);
    metrics.readBatches += 1;
    const response = await db().execute({ sql: `SELECT * FROM platform_price_snapshots WHERE ${clauses}`, args });
    rows.push(...response.rows as unknown as SnapshotRow[]);
  }

  for (const [key, request] of valid) {
    const marketId = normalized(request.marketId!);
    const tokenId = request.tokenId ? normalized(request.tokenId) : null;
    const candidates = rows.filter((row) => row.platform === request.platform
      && (normalized(row.market_id) === marketId || (row.token_id != null && normalized(row.token_id) === marketId)));
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
    if (exact.snapshot_status !== 'available' || !Number.isSafeInteger(priceCents) || priceCents! < 1 || priceCents! > 100) {
      result.set(key, { status: 'unavailable', priceCents: null, source: String(exact.source), observedAt: String(exact.observed_at), ageMs });
      continue;
    }
    result.set(key, {
      status: ageMs != null && ageMs > STALE_AFTER_MS ? 'stale' : 'available',
      priceCents, source: String(exact.source), observedAt: String(exact.observed_at), ageMs,
    });
  }
  return result;
}
