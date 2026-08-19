-- BUG-170: authoritative per-leg BotTrader settlement ledger.
-- Runtime bootstrap in src/lib/bot-settlement-store.ts must remain DDL-compatible.

CREATE TABLE IF NOT EXISTS bot_position_settlements (
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
);

CREATE TABLE IF NOT EXISTS bot_position_settlement_legs (
  position_id INTEGER NOT NULL,
  venue TEXT NOT NULL CHECK (venue IN ('kalshi', 'polymarket')),
  execution_mode TEXT NOT NULL CHECK (execution_mode IN ('paper', 'live')),
  market_id TEXT,
  outcome_id TEXT,
  side TEXT NOT NULL CHECK (side IN ('yes', 'no')),
  requested_quantity INTEGER NOT NULL,
  filled_quantity INTEGER,
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
);

CREATE INDEX IF NOT EXISTS idx_bot_position_settlements_state
  ON bot_position_settlements(position_state, reconciled_at);
