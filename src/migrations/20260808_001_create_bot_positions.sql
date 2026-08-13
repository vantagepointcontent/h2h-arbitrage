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
  expected_payout INTEGER NOT NULL,
  expected_profit INTEGER NOT NULL,
  fees            INTEGER NOT NULL DEFAULT 0,
  category        TEXT,
  pm_theta        REAL,
  kalshi_entry_fee INTEGER NOT NULL DEFAULT 0,
  pm_entry_fee    INTEGER NOT NULL DEFAULT 0,
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

-- Unique index: prevent duplicate open positions for same market pair
DROP INDEX IF EXISTS idx_bot_positions_open_pair;
CREATE UNIQUE INDEX IF NOT EXISTS idx_bot_positions_open_pair
  ON bot_positions(lower(kalshi_ticker), lower(pm_condition_id), execution_mode)
  WHERE status = 'open';
