-- Migration: Create bot_positions table
-- Created: 2026-08-08
-- Description: FEAT-043 — BotTrader position tracking

-- Enable foreign keys for this connection
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS bot_positions (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  execution_id    INTEGER NOT NULL REFERENCES executions(id),
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
  total_cost      INTEGER NOT NULL,
  expected_payout INTEGER NOT NULL,
  expected_profit INTEGER NOT NULL,
  fees            INTEGER NOT NULL DEFAULT 0,
  status          TEXT    NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'settled', 'closed')),
  opened_at       TEXT    NOT NULL,
  expiry_date     TEXT,
  settled_at      TEXT,
  current_price_kalshi INTEGER,
  current_price_pm     INTEGER,
  current_value        INTEGER,
  unrealized_pnl       INTEGER,
  unrealized_roi_pct   INTEGER,
  last_valuation_at    TEXT,
  realized_pnl         INTEGER,
  settlement_side      TEXT CHECK (settlement_side IN ('kalshi', 'pm') OR settlement_side IS NULL)
);

-- Reservation table for pre-execution duplicate prevention
CREATE TABLE IF NOT EXISTS bot_position_reservations (
  pair_key        TEXT PRIMARY KEY,
  reserved_at     TEXT    NOT NULL,
  exposure_at_risk INTEGER NOT NULL DEFAULT 0
);

-- Indexes for query performance
CREATE INDEX IF NOT EXISTS idx_bot_positions_status     ON bot_positions(status, opened_at DESC);
CREATE INDEX IF NOT EXISTS idx_bot_positions_execution  ON bot_positions(execution_id);

-- Unique index: prevent duplicate open positions for same market pair
DROP INDEX IF EXISTS idx_bot_positions_open_pair;
CREATE UNIQUE INDEX IF NOT EXISTS idx_bot_positions_open_pair
  ON bot_positions(lower(kalshi_ticker), lower(pm_condition_id))
  WHERE status = 'open';
