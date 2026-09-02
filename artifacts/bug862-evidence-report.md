# BUG-862 timestamp-aligned affected-candidate evidence

Generated: 2026-09-02T08:48:01.004Z
Candidates: 500; scans: 308; markets: 57

## Classification
- venue-minimum-only rejection: 500

## Root cause
quoteOneShareFromTopAsk applied Polymarket minimumOrderSize before walking canonical one-share depth, producing below_minimum_order with no VWAP even when the authoritative top ask had >=1 share. BotTrader persistence then discarded the non-executable quote as generic unavailable.

Historical rows retain null provider/raw-level fields where the old producer did not persist them; the report does not fabricate those values.
