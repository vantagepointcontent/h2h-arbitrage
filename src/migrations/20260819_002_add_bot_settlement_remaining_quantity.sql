-- BUG-170 follow-up: retain original fills separately from surviving settlement exposure.
ALTER TABLE bot_position_settlement_legs ADD COLUMN remaining_quantity INTEGER;
