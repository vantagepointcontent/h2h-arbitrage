#!/usr/bin/env python3
"""Read-only audit of immutable historical BotTrader cross-platform rows."""
from __future__ import annotations

import json
import sqlite3
import sys
from datetime import datetime, timezone
from pathlib import Path

DB_PATH = Path(sys.argv[1] if len(sys.argv) > 1 else "data/edgefinder.db").resolve()
OUTPUT_PATH = Path(sys.argv[2] if len(sys.argv) > 2 else "data/audits/bot-proposition-audit-v1.json").resolve()
KNOWN = {
    "execution_id": 128,
    "kalshi_ticker": "KXHOUSERACE-FL26-26-D",
    "pm_condition_id": "0xe25b0be3d538078068d0bf2fd311bfbda4b07be31bee8ac4cdf1a0999d2bf328",
    "pm_yes_token_id": "68490275142290425531406410186500399331308254159595156607764183181531392837189",
}

connection = sqlite3.connect(f"file:{DB_PATH}?mode=ro", uri=True)
connection.row_factory = sqlite3.Row
connection.execute("PRAGMA query_only = ON")
try:
    columns = {row[1] for row in connection.execute("PRAGMA table_info(bot_positions)")}
    relationship_state = "bp.proposition_relationship_state" if "proposition_relationship_state" in columns else "NULL AS proposition_relationship_state"
    relationship_json = "bp.proposition_relationship_json" if "proposition_relationship_json" in columns else "NULL AS proposition_relationship_json"
    rows = connection.execute(f"""
        SELECT bp.id AS position_id, bp.execution_id, bp.status, bp.opened_at, bp.market_id,
          bp.market_title, bp.kalshi_ticker, bp.pm_condition_id, bp.strategy,
          bp.kalshi_side, bp.pm_side, bp.buy_price_kalshi, bp.buy_price_pm, bp.pm_entry_token_id,
          {relationship_state}, {relationship_json}, e.polymarket_order, e.kalshi_order
        FROM bot_positions bp
        LEFT JOIN executions e ON e.id = bp.execution_id
        WHERE bp.kalshi_ticker IS NOT NULL AND bp.pm_condition_id IS NOT NULL
        ORDER BY bp.execution_id, bp.id
    """).fetchall()
finally:
    connection.close()

entries = []
for row in rows:
    execution_id = int(row["execution_id"])
    kalshi_ticker = str(row["kalshi_ticker"])
    pm_condition_id = str(row["pm_condition_id"]).lower()
    classification = "unresolved_legacy"
    reason = "Legacy row predates canonical proposition identity; labels and strategy text are not settlement proof."
    evidence = None
    try:
        kalshi_order = json.loads(row["kalshi_order"] or "null") or {}
        polymarket_order = json.loads(row["polymarket_order"] or "null") or {}
    except (TypeError, json.JSONDecodeError):
        kalshi_order = {}
        polymarket_order = {}
    if (
        execution_id == KNOWN["execution_id"]
        and kalshi_ticker == KNOWN["kalshi_ticker"]
        and pm_condition_id == KNOWN["pm_condition_id"]
        and row["kalshi_side"] == "yes"
        and row["pm_side"] == "yes"
        and kalshi_order.get("outcome") == "yes"
        and polymarket_order.get("outcome") == "yes"
        and str(polymarket_order.get("marketId")) == KNOWN["pm_yes_token_id"]
    ):
        classification = "confirmed_invalid"
        reason = "Both executed legs are YES on the Democratic-win proposition. The strategy label says PM Republican, but the immutable condition and token identify PM Democratic YES."
        evidence = {
            "auditedAt": "2026-08-17T13:50:00.000Z",
            "parentEvent": "2026 FL-26 U.S. House election winner party",
            "exhaustivePayoutStates": ["democratic", "republican"],
            "kalshi": {
                "marketId": KNOWN["kalshi_ticker"],
                "question": "Will Democratic win the House race for FL-26?",
                "side": "yes",
                "payoutState": "democratic",
                "rules": "Resolves Yes if the House member sworn in for FL-26 for the term beginning in 2027 is a member of the Democratic Party.",
                "source": f"https://api.elections.kalshi.com/trade-api/v2/markets/{KNOWN['kalshi_ticker']}",
            },
            "polymarket": {
                "conditionId": KNOWN["pm_condition_id"],
                "tokenId": KNOWN["pm_yes_token_id"],
                "question": "Will the Democratic Party win the FL-26 House seat?",
                "side": "yes",
                "payoutState": "democratic",
                "source": f"https://gamma-api.polymarket.com/markets?condition_ids={KNOWN['pm_condition_id']}",
            },
        }
    elif "same-platform yes+yes" in str(row["strategy"] or "").lower():
        classification = "confirmed_invalid"
        reason = "Persisted strategy is same-direction exposure and cannot prove an exhaustive hedge."
    severity = "high" if classification == "confirmed_invalid" and row["status"] == "open" else "warning" if classification == "unresolved_legacy" else "none"
    entries.append({
        "positionId": int(row["position_id"]),
        "executionId": execution_id,
        "status": str(row["status"]),
        "openedAt": str(row["opened_at"]),
        "marketId": None if row["market_id"] is None else str(row["market_id"]),
        "marketTitle": str(row["market_title"]),
        "kalshiTicker": kalshi_ticker,
        "pmConditionId": pm_condition_id,
        "strategy": None if row["strategy"] is None else str(row["strategy"]),
        "kalshiSide": str(row["kalshi_side"]),
        "pmSide": str(row["pm_side"]),
        "buyPriceKalshiCents": int(row["buy_price_kalshi"]),
        "buyPricePmCents": int(row["buy_price_pm"]),
        "pmEntryTokenId": row["pm_entry_token_id"],
        "classification": classification,
        "severity": severity,
        "reason": reason,
        "evidence": evidence,
    })

classification_keys = ("confirmed_legitimate", "confirmed_invalid", "unresolved_legacy")
counts = {key: sum(entry["classification"] == key for entry in entries) for key in classification_keys}
open_high = [entry["executionId"] for entry in entries if entry["status"] == "open" and entry["severity"] == "high"]
manifest = {
    "schemaVersion": 1,
    "generatedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
    "sourceDatabase": str(DB_PATH),
    "immutableHistoryPolicy": "This audit classifies existing rows without updating executions or positions.",
    "counts": {"totalCrossPlatformPositions": len(entries), **counts, "openHighSeverity": len(open_high)},
    "openHighSeverityExecutionIds": open_high,
    "entries": entries,
}
OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
OUTPUT_PATH.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
print(json.dumps({"outputPath": str(OUTPUT_PATH), "counts": manifest["counts"], "openHighSeverityExecutionIds": open_high}))
