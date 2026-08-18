#!/usr/bin/env python3
"""Read-only audit of immutable historical BotTrader cross-platform rows."""
from __future__ import annotations

import json
import sqlite3
import sys
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
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
    position_columns = {row[1] for row in connection.execute("PRAGMA table_info(bot_positions)")}
    execution_columns = {row[1] for row in connection.execute("PRAGMA table_info(executions)")}

    def selected(alias, columns, name):
        return f"{alias}.{name}" if name in columns else f"NULL AS {name}"

    rows = connection.execute(f"""
        SELECT bp.id AS position_id, bp.execution_id, bp.status, bp.opened_at, bp.market_id,
          bp.market_title, bp.kalshi_ticker, bp.pm_condition_id, bp.strategy,
          bp.kalshi_side, bp.pm_side, bp.buy_price_kalshi, bp.buy_price_pm, bp.pm_entry_token_id,
          {selected('bp', position_columns, 'shares_kalshi')},
          {selected('bp', position_columns, 'shares_pm')},
          {selected('bp', position_columns, 'total_cost')},
          {selected('bp', position_columns, 'expected_payout')},
          {selected('bp', position_columns, 'expected_profit')},
          {selected('bp', position_columns, 'fees')},
          {selected('bp', position_columns, 'expected_roi_bps')},
          {selected('bp', position_columns, 'execution_mode')},
          {selected('bp', position_columns, 'entry_record_source')},
          {selected('bp', position_columns, 'entry_recorded_at')},
          {selected('bp', position_columns, 'proposition_relationship_state')},
          {selected('bp', position_columns, 'proposition_relationship_json')},
          e.polymarket_order, e.kalshi_order,
          {selected('e', execution_columns, 'timestamp')} AS execution_timestamp,
          {selected('e', execution_columns, 'arb_id')},
          {selected('e', execution_columns, 'dry_run')},
          {selected('e', execution_columns, 'success')},
          {selected('e', execution_columns, 'result')},
          {selected('e', execution_columns, 'estimated_profit')} AS execution_estimated_profit,
          {selected('e', execution_columns, 'steps')},
          {selected('e', execution_columns, 'source')} AS execution_source,
          {selected('e', execution_columns, 'selection_method')} AS execution_selection_method,
          {selected('e', execution_columns, 'bot_entry_evidence')}
        FROM bot_positions bp
        LEFT JOIN executions e ON e.id = bp.execution_id
        WHERE bp.kalshi_ticker IS NOT NULL AND bp.pm_condition_id IS NOT NULL
        ORDER BY bp.execution_id, bp.id
    """).fetchall()
finally:
    connection.close()


def safe_json(value, fallback):
    try:
        parsed = json.loads(value or "null")
        return parsed if isinstance(parsed, type(fallback)) else fallback
    except (TypeError, json.JSONDecodeError):
        return fallback


def scaled_integer(value, scale):
    if value is None:
        return None
    try:
        return int((Decimal(str(value)) * scale).quantize(Decimal("1"), rounding=ROUND_HALF_UP))
    except (InvalidOperation, TypeError, ValueError):
        return None


def positive_number(value):
    try:
        return Decimal(str(value)) > 0
    except (InvalidOperation, TypeError, ValueError):
        return False


def venue_request(order):
    return {
        "marketId": order.get("marketId"),
        "ticker": order.get("ticker"),
        "side": order.get("side"),
        "outcome": order.get("outcome"),
        "requestedContracts": order.get("contracts"),
        "limitPriceCents": scaled_integer(order.get("price"), Decimal(100)),
        "orderType": order.get("orderType"),
    }


def venue_result(result):
    return {
        "status": result.get("status"),
        "filledContracts": result.get("filledContracts"),
        "reportedFillPriceMicrocents": scaled_integer(result.get("filledPrice"), Decimal(100_000_000)),
        "orderId": result.get("orderId"),
        "venueTimestamp": result.get("timestamp"),
    }


entries = []
for row in rows:
    execution_id = int(row["execution_id"])
    kalshi_ticker = str(row["kalshi_ticker"])
    pm_condition_id = str(row["pm_condition_id"]).lower()
    classification = "unresolved_legacy"
    reason = "Legacy row predates canonical proposition identity; labels and strategy text are not settlement proof."
    evidence = None
    kalshi_order = safe_json(row["kalshi_order"], {})
    polymarket_order = safe_json(row["polymarket_order"], {})
    result = safe_json(row["result"], {})
    steps = safe_json(row["steps"], [])
    kalshi_result = result.get("kalshiResult") if isinstance(result.get("kalshiResult"), dict) else {}
    polymarket_result = result.get("polymarketResult") if isinstance(result.get("polymarketResult"), dict) else {}
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
        reason = "The exact requested contracts are both YES on the Democratic-win proposition. The strategy label says PM Republican, but the immutable condition and token identify PM Democratic YES."
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
    dry_run = row["dry_run"] == 1
    rollback_executed = result.get("rollbackExecuted") is True
    unhedged = result.get("unhedged") is True
    if dry_run:
        exposure_state = "no_executable_exposure"
        exposure_reason = "The immutable execution is paper/dry-run only; no live venue exposure was created."
    elif rollback_executed and not unhedged:
        exposure_state = "closed_by_verified_rollback"
        exposure_reason = "The immutable result records a completed rollback with no unhedged remainder."
    elif any(positive_number(venue.get("filledContracts")) for venue in (kalshi_result, polymarket_result)):
        exposure_state = "executable_exposure_possible"
        exposure_reason = "A live venue result reports a positive fill without proof of a complete safe close."
    else:
        exposure_state = "unknown"
        exposure_reason = "Immutable venue evidence is insufficient to prove whether executable exposure exists."
    severity = (
        "high" if classification == "confirmed_invalid" and exposure_state == "executable_exposure_possible"
        else "warning" if classification in ("confirmed_invalid", "unresolved_legacy")
        else "none"
    )
    scan_times = [
        step.get("metadata", {}).get("scanTime")
        for step in steps
        if isinstance(step, dict) and isinstance(step.get("metadata"), dict) and step.get("metadata", {}).get("scanTime")
    ]
    execution_mode = row["execution_mode"] or ("paper" if dry_run else "live")
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
        "executionEnvelope": {
            "mode": execution_mode,
            "dryRun": dry_run,
            "success": row["success"] == 1,
            "executionTimestamp": row["execution_timestamp"],
            "source": row["execution_source"],
            "executionDurationMs": result.get("executionTimeMs"),
            "requests": {
                "kalshi": venue_request(kalshi_order),
                "polymarket": venue_request(polymarket_order),
            },
            "venueResults": {
                "kalshi": venue_result(kalshi_result),
                "polymarket": venue_result(polymarket_result),
            },
            "rollback": {
                "executed": rollback_executed,
                "unhedged": unhedged,
                "alerts": result.get("alerts") if isinstance(result.get("alerts"), list) else [],
            },
        },
        "matchingProvenance": {
            "arbId": row["arb_id"],
            "executionSource": row["execution_source"],
            "selectionMethod": row["execution_selection_method"],
            "scanTimes": scan_times,
            "persistedStrategyLabelNotEvidence": None if row["strategy"] is None else str(row["strategy"]),
        },
        "calculationEnvelope": {
            "executionEstimatedProfitStoredValue": None if row["execution_estimated_profit"] is None else str(row["execution_estimated_profit"]),
            "persistedPosition": {
                "kalshiEntryPriceCents": int(row["buy_price_kalshi"]),
                "polymarketEntryPriceCents": int(row["buy_price_pm"]),
                "kalshiContracts": row["shares_kalshi"],
                "polymarketContracts": row["shares_pm"],
                "feesCents": row["fees"],
                "totalCostCents": row["total_cost"],
                "expectedPayoutCents": row["expected_payout"],
                "expectedProfitCents": row["expected_profit"],
                "expectedRoiBps": row["expected_roi_bps"],
            },
            "entryEvidenceProvenance": {
                "positionSource": row["entry_record_source"],
                "positionRecordedAt": row["entry_recorded_at"],
                "executionEvidence": safe_json(row["bot_entry_evidence"], None),
            },
        },
        "actualExposure": {
            "state": exposure_state,
            "reason": exposure_reason,
            "derivedPositionStatus": str(row["status"]),
            "safeHandling": (
                "Do not submit a close order. Quarantine the invalid mapping and reconcile the derived paper position administratively."
                if exposure_state == "no_executable_exposure"
                else "Require fresh executable venue revalidation and explicit execution authorization before any close."
            ),
        },
    })

classification_keys = ("confirmed_legitimate", "confirmed_invalid", "unresolved_legacy")
counts = {key: sum(entry["classification"] == key for entry in entries) for key in classification_keys}
open_high = [entry["executionId"] for entry in entries if entry["status"] == "open" and entry["severity"] == "high"]
actual_exposure_counts = {
    state: sum(entry["actualExposure"]["state"] == state for entry in entries)
    for state in ("no_executable_exposure", "closed_by_verified_rollback", "executable_exposure_possible", "unknown")
}
manifest = {
    "schemaVersion": 1,
    "generatedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
    "sourceDatabase": str(DB_PATH),
    "immutableHistoryPolicy": "This audit classifies existing rows without updating executions or positions.",
    "counts": {
        "totalCrossPlatformPositions": len(entries),
        **counts,
        "openHighSeverity": len(open_high),
        "actualExposureStates": actual_exposure_counts,
    },
    "openHighSeverityExecutionIds": open_high,
    "entries": entries,
}
OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
OUTPUT_PATH.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
print(json.dumps({"outputPath": str(OUTPUT_PATH), "counts": manifest["counts"], "openHighSeverityExecutionIds": open_high}))
