#!/usr/bin/env python3
"""
EdgeFinder DB Retention — prune old scan_results + aggregate into daily summary.
Run daily via cron.
"""
import sqlite3
import os
import sys
from datetime import datetime, timedelta

DB_PATH = os.path.expanduser("~/h2h-arbitrage/data/edgefinder.db")
RETENTION_DAYS = 30
VERBOSE = "--verbose" in sys.argv or "-v" in sys.argv

def log(msg):
    if VERBOSE:
        print(msg, flush=True)

def main():
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()

    # 1. Create aggregation table if not exists
    c.execute("""
        CREATE TABLE IF NOT EXISTS scan_daily_summary (
            date TEXT NOT NULL,
            market_id TEXT NOT NULL,
            scan_count INTEGER DEFAULT 0,
            arb_count INTEGER DEFAULT 0,
            best_roi REAL DEFAULT 0,
            best_profit REAL DEFAULT 0,
            PRIMARY KEY (date, market_id)
        )
    """)

    # 2. Aggregate rows older than retention period into daily summary
    cutoff = (datetime.utcnow() - timedelta(days=RETENTION_DAYS)).isoformat()
    log(f"Cutoff date: {cutoff}")

    # Get distinct date/market pairs to aggregate
    rows_to_aggregate = c.execute("""
        SELECT DATE(scanned_at) as date, market_id,
               COUNT(*) as scan_count,
               SUM(CASE WHEN positive_arb_count > 0 THEN 1 ELSE 0 END) as arb_count,
               MAX(best_roi_pct) as best_roi,
               MAX(best_profit) as best_profit
        FROM scan_results
        WHERE scanned_at < ?
        GROUP BY DATE(scanned_at), market_id
    """, (cutoff,)).fetchall()

    log(f"Aggregating {len(rows_to_aggregate)} date/market pairs...")

    for date, market_id, scan_count, arb_count, best_roi, best_profit in rows_to_aggregate:
        c.execute("""
            INSERT INTO scan_daily_summary (date, market_id, scan_count, arb_count, best_roi, best_profit)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(date, market_id) DO UPDATE SET
                scan_count = scan_count + excluded.scan_count,
                arb_count = arb_count + excluded.arb_count,
                best_roi = MAX(best_roi, excluded.best_roi),
                best_profit = MAX(best_profit, excluded.best_profit)
        """, (date, market_id, scan_count, arb_count, best_roi or 0, best_profit or 0))

    # 3. Delete old rows
    c.execute("SELECT COUNT(*) FROM scan_results WHERE scanned_at < ?", (cutoff,))
    to_delete = c.fetchone()[0]
    log(f"Deleting {to_delete} old scan_results rows...")

    c.execute("DELETE FROM scan_results WHERE scanned_at < ?", (cutoff,))

    # 4. VACUUM to reclaim space (must be outside transaction)
    conn.commit()
    conn.isolation_level = None
    log("VACUUM...")
    c.execute("VACUUM")

    # 5. Report
    c.execute("SELECT COUNT(*) FROM scan_results")
    remaining = c.fetchone()[0]
    c.execute("SELECT COUNT(*) FROM scan_daily_summary")
    summary_count = c.fetchone()[0]

    db_size = os.path.getsize(DB_PATH) / (1024 * 1024)

    conn.commit()
    conn.close()

    result = {
        "deleted": to_delete,
        "remaining_rows": remaining,
        "summary_rows": summary_count,
        "db_size_mb": round(db_size, 1),
        "cutoff": cutoff,
    }
    print(f"OK: pruned {to_delete} rows, {remaining} remaining, {summary_count} daily summaries, DB={db_size:.1f}MB")

if __name__ == "__main__":
    main()