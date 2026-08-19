import path from 'node:path';
import { createClient, type Client } from '@libsql/client';
import type { BotPosition } from './bot-positions';
import type {
  ReconciledSettlementLeg,
  SettlementCreditState,
  SettlementExposureState,
  SettlementLegLifecycleState,
  SettlementLifecycleResult,
  SettlementPositionState,
  SettlementSide,
  SettlementVenue,
} from './bot-settlement';

export type BotPositionWithSettlement = BotPosition & {
  settlementState: SettlementPositionState;
  settlementLegs: ReconciledSettlementLeg[];
  settlementGrossProceedsCents: number | null;
  settlementNetProceedsCents: number | null;
  settlementFailureReason: string | null;
  settlementCashAvailableAt: string | null;
  settlementReconciledAt: string | null;
  realizedRoiBps: number | null;
};

function asNullableString(value: unknown): string | null {
  return value == null ? null : String(value);
}

function asNullableNumber(value: unknown): number | null {
  return value == null ? null : Number(value);
}

function parseFillIds(value: unknown): string[] {
  if (typeof value !== 'string') return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) && parsed.every((item) => typeof item === 'string') ? parsed : [];
  } catch {
    return [];
  }
}

function legRemainingQuantity(leg: ReconciledSettlementLeg): number | null {
  return leg.remainingQuantity === undefined ? leg.filledQuantity : leg.remainingQuantity;
}

function rowToLeg(row: Record<string, unknown>): ReconciledSettlementLeg {
  return {
    venue: String(row.venue) as SettlementVenue,
    marketId: asNullableString(row.market_id),
    outcomeId: asNullableString(row.outcome_id),
    side: String(row.side) as SettlementSide,
    requestedQuantity: Number(row.requested_quantity),
    filledQuantity: asNullableNumber(row.filled_quantity),
    remainingQuantity: asNullableNumber(row.remaining_quantity) ?? asNullableNumber(row.filled_quantity),
    orderId: asNullableString(row.order_id),
    fillIds: parseFillIds(row.fill_ids_json),
    exposureState: String(row.exposure_state) as SettlementExposureState,
    mode: row.execution_mode === 'live' ? 'live' : 'paper',
    lifecycleState: String(row.lifecycle_state) as SettlementLegLifecycleState,
    resolutionWinningSide: asNullableString(row.resolution_winning_side) as SettlementSide | null,
    resolutionDetectedAt: asNullableString(row.resolution_detected_at),
    resolutionSource: asNullableString(row.resolution_source),
    resolutionSourceVersion: asNullableString(row.resolution_source_version),
    payoutEntitlementCents: asNullableNumber(row.payout_entitlement_cents),
    settlementFeeCents: asNullableNumber(row.settlement_fee_cents),
    netSettlementProceedsCents: asNullableNumber(row.net_settlement_proceeds_cents),
    creditState: String(row.credit_state) as SettlementCreditState,
    cashAvailableAt: asNullableString(row.cash_available_at),
    failureReason: asNullableString(row.failure_reason),
    reconciledAt: asNullableString(row.reconciled_at),
  };
}

export class BotSettlementStore {
  private readonly client: Client;
  private schemaReady: Promise<void> | null = null;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(dbUrl = `file:${path.join(process.cwd(), 'data', 'edgefinder.db')}`) {
    this.client = createClient({ url: dbUrl });
  }

  private ensureSchema(): Promise<void> {
    if (!this.schemaReady) this.schemaReady = this.createSchema();
    return this.schemaReady;
  }

  private async createSchema(): Promise<void> {
    await this.client.execute('PRAGMA busy_timeout = 30000');
    await this.client.execute(`CREATE TABLE IF NOT EXISTS bot_position_settlements (
      position_id INTEGER PRIMARY KEY,
      position_state TEXT NOT NULL CHECK (position_state IN (
        'open', 'partially_settled', 'settlement_pending', 'settlement_unresolved', 'settled'
      )),
      gross_settlement_proceeds_cents INTEGER,
      net_settlement_proceeds_cents INTEGER,
      realized_pnl_cents INTEGER,
      realized_roi_bps INTEGER,
      cash_available_at TEXT,
      failure_reason TEXT,
      reconciled_at TEXT NOT NULL
    )`);
    await this.client.execute(`CREATE TABLE IF NOT EXISTS bot_position_settlement_legs (
      position_id INTEGER NOT NULL,
      venue TEXT NOT NULL CHECK (venue IN ('kalshi', 'polymarket')),
      execution_mode TEXT NOT NULL CHECK (execution_mode IN ('paper', 'live')),
      market_id TEXT,
      outcome_id TEXT,
      side TEXT NOT NULL CHECK (side IN ('yes', 'no')),
      requested_quantity INTEGER NOT NULL,
      filled_quantity INTEGER,
      remaining_quantity INTEGER,
      order_id TEXT,
      fill_ids_json TEXT NOT NULL,
      exposure_state TEXT NOT NULL,
      lifecycle_state TEXT NOT NULL,
      resolution_winning_side TEXT CHECK (resolution_winning_side IN ('yes', 'no') OR resolution_winning_side IS NULL),
      resolution_detected_at TEXT,
      resolution_source TEXT,
      resolution_source_version TEXT,
      payout_entitlement_cents INTEGER,
      settlement_fee_cents INTEGER,
      net_settlement_proceeds_cents INTEGER,
      credit_state TEXT NOT NULL,
      cash_available_at TEXT,
      failure_reason TEXT,
      reconciled_at TEXT,
      PRIMARY KEY (position_id, venue)
    )`);
    const legColumns = await this.client.execute('PRAGMA table_info(bot_position_settlement_legs)');
    if (!legColumns.rows.some((row) => String(row.name) === 'remaining_quantity')) {
      await this.client.execute('ALTER TABLE bot_position_settlement_legs ADD COLUMN remaining_quantity INTEGER');
    }
    await this.client.execute('CREATE INDEX IF NOT EXISTS idx_bot_position_settlements_state ON bot_position_settlements(position_state, reconciled_at)');
  }

  persist(positionId: number, result: SettlementLifecycleResult): Promise<boolean> {
    const operation = this.writeQueue.then(() => this.persistNow(positionId, result));
    this.writeQueue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  private async persistNow(positionId: number, result: SettlementLifecycleResult): Promise<boolean> {
    await this.ensureSchema();
    if (!Number.isSafeInteger(positionId) || positionId < 0 || result.legs.length !== 2) {
      throw new Error('Malformed settlement ledger write');
    }
    const transaction = await this.client.transaction('write');
    try {
      const existing = await transaction.execute({
        sql: 'SELECT position_state, reconciled_at FROM bot_position_settlements WHERE position_id = ?',
        args: [positionId],
      });
      const existingAt = existing.rows[0]?.reconciled_at;
      const existingState = existing.rows[0]?.position_state == null
        ? null
        : String(existing.rows[0].position_state) as SettlementPositionState;
      const terminalDowngrade = existingState === 'settlement_unresolved'
        ? result.positionState !== 'settlement_unresolved'
        : existingState === 'settled'
          ? result.positionState !== 'settled' && result.positionState !== 'settlement_unresolved'
          : (existingState === 'partially_settled' || existingState === 'settlement_pending')
            && result.positionState === 'open';
      if ((existingAt != null && String(existingAt) >= result.reconciledAt) || terminalDowngrade) {
        await transaction.rollback();
        return false;
      }
      await transaction.execute({
        sql: `INSERT INTO bot_position_settlements (
          position_id, position_state, gross_settlement_proceeds_cents,
          net_settlement_proceeds_cents, realized_pnl_cents, realized_roi_bps,
          cash_available_at, failure_reason, reconciled_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(position_id) DO UPDATE SET
          position_state = excluded.position_state,
          gross_settlement_proceeds_cents = excluded.gross_settlement_proceeds_cents,
          net_settlement_proceeds_cents = excluded.net_settlement_proceeds_cents,
          realized_pnl_cents = excluded.realized_pnl_cents,
          realized_roi_bps = excluded.realized_roi_bps,
          cash_available_at = excluded.cash_available_at,
          failure_reason = excluded.failure_reason,
          reconciled_at = excluded.reconciled_at`,
        args: [
          positionId, result.positionState, result.grossSettlementProceedsCents,
          result.netSettlementProceedsCents, result.realizedPnlCents, result.realizedRoiBps,
          result.cashAvailableAt, result.failureReason, result.reconciledAt,
        ],
      });
      for (const leg of result.legs) {
        await transaction.execute({
          sql: `INSERT INTO bot_position_settlement_legs (
            position_id, venue, execution_mode, market_id, outcome_id, side,
            requested_quantity, filled_quantity, remaining_quantity, order_id, fill_ids_json,
            exposure_state, lifecycle_state, resolution_winning_side,
            resolution_detected_at, resolution_source, resolution_source_version,
            payout_entitlement_cents, settlement_fee_cents, net_settlement_proceeds_cents,
            credit_state, cash_available_at, failure_reason, reconciled_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(position_id, venue) DO UPDATE SET
            execution_mode = excluded.execution_mode, market_id = excluded.market_id,
            outcome_id = excluded.outcome_id, side = excluded.side,
            requested_quantity = excluded.requested_quantity, filled_quantity = excluded.filled_quantity,
            remaining_quantity = excluded.remaining_quantity,
            order_id = excluded.order_id, fill_ids_json = excluded.fill_ids_json,
            exposure_state = excluded.exposure_state, lifecycle_state = excluded.lifecycle_state,
            resolution_winning_side = excluded.resolution_winning_side,
            resolution_detected_at = excluded.resolution_detected_at,
            resolution_source = excluded.resolution_source,
            resolution_source_version = excluded.resolution_source_version,
            payout_entitlement_cents = excluded.payout_entitlement_cents,
            settlement_fee_cents = excluded.settlement_fee_cents,
            net_settlement_proceeds_cents = excluded.net_settlement_proceeds_cents,
            credit_state = excluded.credit_state, cash_available_at = excluded.cash_available_at,
            failure_reason = excluded.failure_reason, reconciled_at = excluded.reconciled_at`,
          args: [
            positionId, leg.venue, leg.mode, leg.marketId, leg.outcomeId, leg.side,
            leg.requestedQuantity, leg.filledQuantity, legRemainingQuantity(leg),
            leg.orderId, JSON.stringify(leg.fillIds),
            leg.exposureState, leg.lifecycleState, leg.resolutionWinningSide,
            leg.resolutionDetectedAt, leg.resolutionSource, leg.resolutionSourceVersion,
            leg.payoutEntitlementCents, leg.settlementFeeCents, leg.netSettlementProceedsCents,
            leg.creditState, leg.cashAvailableAt, leg.failureReason, leg.reconciledAt,
          ],
        });
      }
      await transaction.commit();
      return true;
    } catch (error) {
      await transaction.rollback().catch(() => undefined);
      throw error;
    } finally {
      transaction.close();
    }
  }

  async getByPositionIds(positionIds: number[]): Promise<Map<number, SettlementLifecycleResult>> {
    await this.ensureSchema();
    const ids = [...new Set(positionIds.filter((id) => Number.isSafeInteger(id) && id >= 0))];
    if (ids.length === 0) return new Map();
    if (ids.length > 1000) throw new Error('Settlement ledger reads are limited to 1000 positions');
    const placeholders = ids.map(() => '?').join(',');
    const [summaries, legs] = await Promise.all([
      this.client.execute({ sql: `SELECT * FROM bot_position_settlements WHERE position_id IN (${placeholders})`, args: ids }),
      this.client.execute({ sql: `SELECT * FROM bot_position_settlement_legs WHERE position_id IN (${placeholders}) ORDER BY position_id, venue`, args: ids }),
    ]);
    const legsByPosition = new Map<number, ReconciledSettlementLeg[]>();
    for (const row of legs.rows) {
      const positionId = Number(row.position_id);
      legsByPosition.set(positionId, [...(legsByPosition.get(positionId) ?? []), rowToLeg(row as Record<string, unknown>)]);
    }
    return new Map(summaries.rows.map((row) => {
      const positionId = Number(row.position_id);
      return [positionId, {
        positionState: String(row.position_state) as SettlementPositionState,
        legs: legsByPosition.get(positionId) ?? [],
        grossSettlementProceedsCents: asNullableNumber(row.gross_settlement_proceeds_cents),
        netSettlementProceedsCents: asNullableNumber(row.net_settlement_proceeds_cents),
        realizedPnlCents: asNullableNumber(row.realized_pnl_cents),
        realizedRoiBps: asNullableNumber(row.realized_roi_bps),
        cashAvailableAt: asNullableString(row.cash_available_at),
        failureReason: asNullableString(row.failure_reason),
        reconciledAt: String(row.reconciled_at),
      } satisfies SettlementLifecycleResult];
    }));
  }

  async countRows(): Promise<{ positions: number; legs: number }> {
    await this.ensureSchema();
    const [positions, legs] = await Promise.all([
      this.client.execute('SELECT COUNT(*) AS count FROM bot_position_settlements'),
      this.client.execute('SELECT COUNT(*) AS count FROM bot_position_settlement_legs'),
    ]);
    return { positions: Number(positions.rows[0].count), legs: Number(legs.rows[0].count) };
  }

  close(): void {
    this.client.close();
  }
}

function terminalProceeds(result: SettlementLifecycleResult): number {
  return result.legs.reduce((sum, leg) => sum
    + (leg.lifecycleState === 'reconciled' ? leg.netSettlementProceedsCents ?? 0 : 0), 0);
}

export function applySettlementProjection(
  position: BotPosition,
  result: SettlementLifecycleResult | undefined,
): BotPositionWithSettlement {
  const base = {
    ...position,
    settlementState: result?.positionState ?? 'open',
    settlementLegs: result?.legs ?? [],
    settlementGrossProceedsCents: result?.grossSettlementProceedsCents ?? null,
    settlementNetProceedsCents: result?.netSettlementProceedsCents ?? null,
    settlementFailureReason: result?.failureReason ?? null,
    settlementCashAvailableAt: result?.cashAvailableAt ?? null,
    settlementReconciledAt: result?.reconciledAt ?? null,
    realizedRoiBps: result?.realizedRoiBps ?? null,
  } satisfies BotPositionWithSettlement;
  if (!result || result.positionState === 'open') return base;
  if (result.positionState === 'settlement_unresolved' || result.positionState === 'settlement_pending') {
    return {
      ...base,
      currentValueCents: null,
      unrealizedPnlCents: null,
      unrealizedRoiBps: null,
      realizedPnlCents: null,
      valuationStatus: 'unavailable',
      valuationFailureReason: result.failureReason,
      resolutionValidationStatus: result.positionState === 'settlement_unresolved' ? 'invalid' : 'pending',
    };
  }
  if (result.positionState === 'partially_settled') {
    const openValue = result.legs.reduce((sum, leg) => {
      if (leg.lifecycleState !== 'open') return sum;
      const price = leg.venue === 'kalshi' ? position.currentPriceKalshiCents : position.currentPricePmCents;
      const quantity = legRemainingQuantity(leg);
      return price == null || quantity == null ? Number.NaN : sum + price * quantity;
    }, 0);
    const currentValueCents = Number.isSafeInteger(openValue) ? terminalProceeds(result) + openValue : null;
    const unrealizedPnlCents = currentValueCents == null ? null : currentValueCents - position.totalCostCents;
    return {
      ...base,
      currentValueCents,
      unrealizedPnlCents,
      unrealizedRoiBps: unrealizedPnlCents == null || position.totalCostCents <= 0
        ? null : Math.round(unrealizedPnlCents * 10_000 / position.totalCostCents),
      valuationFailureReason: currentValueCents == null ? 'Partially settled — unresolved leg mark unavailable' : null,
    };
  }
  const kalshiResolution = result.legs.find((leg) => leg.venue === 'kalshi');
  return {
    ...base,
    status: 'settled',
    settledAt: result.reconciledAt,
    currentValueCents: null,
    unrealizedPnlCents: null,
    unrealizedRoiBps: null,
    realizedPnlCents: result.realizedPnlCents,
    settlementSide: result.legs.find((leg) => (leg.payoutEntitlementCents ?? 0) > 0)?.venue === 'kalshi' ? 'kalshi' : 'pm',
    resolutionSource: result.legs.map((leg) => leg.resolutionSource).filter(Boolean).join('+'),
    resolutionVerifiedAt: result.reconciledAt,
    resolutionOutcome: kalshiResolution?.resolutionWinningSide ?? null,
    resolutionPayoutCents: result.netSettlementProceedsCents,
    resolutionValidationStatus: 'verified',
    valuationFailureReason: null,
  };
}

let defaultStore: BotSettlementStore | null = null;
function store(): BotSettlementStore {
  if (!defaultStore) defaultStore = new BotSettlementStore();
  return defaultStore;
}

export async function enrichBotPositionsWithSettlementLedger<T extends BotPosition>(positions: T[]): Promise<Array<T & BotPositionWithSettlement>> {
  const settlements = await store().getByPositionIds(positions.map((position) => position.id));
  return positions.map((position) => applySettlementProjection(position, settlements.get(position.id)) as T & BotPositionWithSettlement);
}
