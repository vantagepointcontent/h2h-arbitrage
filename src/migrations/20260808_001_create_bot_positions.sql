-- Migration: Create bot_positions table
-- Created: 2026-08-08
-- Description: FEAT-043 — BotTrader position tracking

-- Enable foreign keys for this connection
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS bot_positions (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  execution_id    INTEGER NOT NULL REFERENCES executions(id),
  execution_mode  TEXT    NOT NULL CHECK (execution_mode IN ('paper', 'live')),
  market_id       TEXT,
  market_title    TEXT    NOT NULL,
  kalshi_ticker   TEXT,
  pm_condition_id TEXT,
  strategy        TEXT,
  proposition_relationship_json TEXT,
  proposition_relationship_state TEXT NOT NULL DEFAULT 'unknown',
  proposition_relationship_warning TEXT,
  kalshi_market_question TEXT,
  pm_market_question TEXT,
  kalshi_outcome_label TEXT,
  pm_outcome_label TEXT,
  outcome_identity_status TEXT NOT NULL DEFAULT 'unresolved' CHECK (outcome_identity_status IN ('verified', 'unresolved')),
  outcome_identity_source TEXT,
  outcome_identity_recorded_at TEXT,
  outcome_identity_failure_reason TEXT,
  relationship_validity TEXT NOT NULL DEFAULT 'unresolved_relationship',
  exposure_identity_status TEXT NOT NULL DEFAULT 'unrecoverable',
  legacy_exposure_verdict_json TEXT,
  legacy_exposure_revision TEXT,
  legacy_exposure_run_id TEXT,
  kalshi_side     TEXT    NOT NULL CHECK (kalshi_side IN ('yes', 'no')),
  pm_side         TEXT    NOT NULL CHECK (pm_side IN ('yes', 'no')),
  buy_price_kalshi INTEGER NOT NULL,
  buy_price_pm    INTEGER NOT NULL,
  shares_kalshi   INTEGER NOT NULL,
  shares_pm       INTEGER NOT NULL,
  live_shares_kalshi INTEGER NOT NULL,
  live_shares_pm INTEGER NOT NULL,
  live_principal INTEGER NOT NULL,
  live_fees      INTEGER NOT NULL,
  live_cost      INTEGER NOT NULL,
  total_cost      INTEGER NOT NULL,
  total_cost_microusd INTEGER,
  entry_cost_status TEXT NOT NULL DEFAULT 'unavailable' CHECK (entry_cost_status IN ('available', 'unavailable')),
  entry_cost_failure_reason TEXT,
  kalshi_entry_gross_microcents INTEGER,
  pm_entry_gross_microcents INTEGER,
  entry_cost_rounding_delta_microcents INTEGER,
  kalshi_entry_fill_count INTEGER,
  pm_entry_fill_count INTEGER,
  kalshi_entry_fills_json TEXT,
  pm_entry_fills_json TEXT,
  expected_payout INTEGER NOT NULL,
  expected_profit INTEGER NOT NULL,
  fees            INTEGER NOT NULL DEFAULT 0,
  category        TEXT,
  pm_theta        REAL,
  kalshi_entry_fee_type TEXT,
  kalshi_entry_fee_multiplier_ppm INTEGER,
  kalshi_entry_fee_source TEXT,
  kalshi_entry_fee_observed_at TEXT,
  kalshi_entry_fee_version TEXT,
  pm_entry_token_id TEXT,
  pm_entry_fee_rate_bps INTEGER,
  pm_entry_fees_enabled INTEGER,
  pm_entry_fee_exponent INTEGER,
  pm_entry_fee_taker_only INTEGER,
  pm_entry_fee_rebate_rate_ppm INTEGER,
  pm_entry_order_base_fee_bps INTEGER,
  pm_entry_order_fee_source TEXT,
  pm_entry_order_fee_version TEXT,
  pm_entry_fee_source TEXT,
  pm_entry_fee_observed_at TEXT,
  pm_entry_fee_version TEXT,
  kalshi_entry_fee INTEGER NOT NULL DEFAULT 0,
  kalshi_entry_calculated_fee INTEGER NOT NULL DEFAULT 0,
  kalshi_entry_charged_fee INTEGER,
  pm_entry_fee    INTEGER NOT NULL DEFAULT 0,
  pm_entry_fee_microusd INTEGER,
  kalshi_exit_fee_type TEXT,
  kalshi_exit_fee_multiplier_ppm INTEGER,
  kalshi_exit_fee_source TEXT,
  kalshi_exit_fee_observed_at TEXT,
  kalshi_exit_fee_version TEXT,
  pm_exit_token_id TEXT,
  pm_exit_fee_rate_bps INTEGER,
  pm_exit_fees_enabled INTEGER,
  pm_exit_fee_exponent INTEGER,
  pm_exit_fee_taker_only INTEGER,
  pm_exit_fee_rebate_rate_ppm INTEGER,
  pm_exit_order_base_fee_bps INTEGER,
  pm_exit_order_fee_source TEXT,
  pm_exit_order_fee_version TEXT,
  pm_exit_fee_source TEXT,
  pm_exit_fee_observed_at TEXT,
  pm_exit_fee_version TEXT,
  entry_fee_unallocated INTEGER NOT NULL DEFAULT 0,
  entry_record_version INTEGER,
  entry_record_source TEXT,
  entry_recorded_at TEXT,
  entry_arb_profit_snapshot_json TEXT,
  status          TEXT    NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'settled', 'closed')),
  opened_at       TEXT    NOT NULL,
  expiry_date     TEXT,
  settled_at      TEXT,
  closed_at       TEXT,
  current_price_kalshi INTEGER,
  current_price_pm     INTEGER,
  current_value        INTEGER,
  unrealized_pnl       INTEGER,
  unrealized_roi_pct   INTEGER,
  last_valuation_at    TEXT,
  realized_pnl_before_settlement INTEGER,
  realized_pnl         INTEGER,
  settlement_side      TEXT CHECK (settlement_side IN ('kalshi', 'pm') OR settlement_side IS NULL),
  selection_method TEXT CHECK (selection_method IN ('roi', 'apy', 'hybrid') OR selection_method IS NULL),
  resolution_source TEXT,
  resolution_verified_at TEXT,
  resolution_outcome TEXT CHECK (resolution_outcome IN ('yes', 'no') OR resolution_outcome IS NULL),
  resolution_payout INTEGER,
  resolution_validation_status TEXT NOT NULL DEFAULT 'pending'
);

-- Reservation table for pre-execution duplicate prevention
CREATE TABLE IF NOT EXISTS bot_position_reservations (
  pair_key        TEXT    NOT NULL,
  execution_mode  TEXT    NOT NULL CHECK (execution_mode IN ('paper', 'live')),
  reserved_at     TEXT    NOT NULL,
  exposure_at_risk INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (pair_key, execution_mode)
);

-- Indexes for query performance
CREATE INDEX IF NOT EXISTS idx_bot_positions_status     ON bot_positions(status, opened_at DESC);
CREATE INDEX IF NOT EXISTS idx_bot_positions_execution  ON bot_positions(execution_id);

-- Legacy ledgers may already contain duplicate open positions. Preserve them
-- for reconciliation while preventing the duplicate set from growing.
DROP INDEX IF EXISTS idx_bot_positions_open_pair;
CREATE TRIGGER IF NOT EXISTS bot_positions_open_pair_insert_guard
  BEFORE INSERT ON bot_positions
  WHEN NEW.status = 'open' AND NEW.kalshi_ticker IS NOT NULL AND NEW.pm_condition_id IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM bot_positions
      WHERE status = 'open' AND execution_mode = NEW.execution_mode
        AND lower(kalshi_ticker) = lower(NEW.kalshi_ticker)
        AND lower(pm_condition_id) = lower(NEW.pm_condition_id)
    )
  BEGIN SELECT RAISE(ABORT, 'An open bot position already exists for this market pair'); END;
CREATE TRIGGER IF NOT EXISTS bot_positions_open_pair_update_guard
  BEFORE UPDATE OF status, kalshi_ticker, pm_condition_id, execution_mode ON bot_positions
  WHEN NEW.status = 'open' AND NEW.kalshi_ticker IS NOT NULL AND NEW.pm_condition_id IS NOT NULL
    AND (OLD.status IS NOT NEW.status OR OLD.execution_mode IS NOT NEW.execution_mode
      OR lower(OLD.kalshi_ticker) IS NOT lower(NEW.kalshi_ticker)
      OR lower(OLD.pm_condition_id) IS NOT lower(NEW.pm_condition_id))
    AND EXISTS (
      SELECT 1 FROM bot_positions
      WHERE id != OLD.id AND status = 'open' AND execution_mode = NEW.execution_mode
        AND lower(kalshi_ticker) = lower(NEW.kalshi_ticker)
        AND lower(pm_condition_id) = lower(NEW.pm_condition_id)
    )
  BEGIN SELECT RAISE(ABORT, 'An open bot position already exists for this market pair'); END;
