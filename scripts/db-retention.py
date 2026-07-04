#!/usr/bin/env python3
"""EdgeFinder DB retention (PERF-P3).

Nightly maintenance for data/edgefinder.db:
  1. Prune scan_results older than RETAIN_DAYS (default 30).
  2. Prune scan_history rows older than RETAIN_DAYS.
  3. Null raw_result on zero-arb rows (belt & braces; scan route already skips them).
  4. WAL checkpoint (TRUNCATE) to keep the -wal file small.
  5. VACUUM on Sundays to reclaim disk.

Safe to run while the app is live: WAL mode + busy_timeout, and VACUUM is
skipped if it can't get the lock. Prints a one-line summary to stdout.
"""
import os
import sqlite3
import sys
from datetime import datetime, timedelta, timezone

DB = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data", "edgefinder.db")
RETAIN_DAYS = int(os.environ.get("H2H_RETAIN_DAYS", "30"))


def main() -> int:
    if not os.path.exists(DB):
        print(f"[db-retention] DB not found: {DB}")
        return 1

    cutoff = (datetime.now(timezone.utc) - timedelta(days=RETAIN_DAYS)).isoformat()
    size_before = os.path.getsize(DB)

    conn = sqlite3.connect(DB, timeout=30)
    conn.execute("PRAGMA busy_timeout = 30000")

    pruned_scans = conn.execute(
        "DELETE FROM scan_results WHERE scanned_at < ?", (cutoff,)
    ).rowcount
    try:
        pruned_hist = conn.execute(
            "DELETE FROM scan_history WHERE scan_timestamp < ?", (cutoff,)
        ).rowcount
    except sqlite3.OperationalError:
        pruned_hist = 0
    nulled_raw = conn.execute(
        "UPDATE scan_results SET raw_result = NULL WHERE positive_arb_count = 0 AND raw_result IS NOT NULL"
    ).rowcount
    conn.commit()

    # Keep WAL small
    try:
        conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
    except sqlite3.OperationalError as e:
        print(f"[db-retention] checkpoint skipped: {e}")

    vacuumed = False
    if datetime.now(timezone.utc).weekday() == 6:  # Sunday
        try:
            conn.execute("VACUUM")
            vacuumed = True
        except sqlite3.OperationalError as e:
            print(f"[db-retention] VACUUM skipped: {e}")

    conn.close()
    size_after = os.path.getsize(DB)
    wal = f"{os.path.getsize(DB + '-wal') / 1e6:.1f}MB" if os.path.exists(DB + "-wal") else "0"
    print(
        f"[db-retention] pruned {pruned_scans} scan_results + {pruned_hist} scan_history (>{RETAIN_DAYS}d), "
        f"nulled {nulled_raw} raw blobs, vacuum={vacuumed}, "
        f"db {size_before/1e6:.1f}MB -> {size_after/1e6:.1f}MB, wal {wal}"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
