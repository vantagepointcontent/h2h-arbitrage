#!/usr/bin/env python3
"""EdgeFinder DB retention + integrity guard (PERF-P3, CORRUPT-001).

Nightly maintenance for data/edgefinder.db:
  0. Integrity check — abort if DB is corrupt (don't prune a broken DB).
  1. Backup to data/backups/ (keep last 7, rotate older).
  2. Prune scan_results older than RETAIN_DAYS (default 30).
  3. Prune scan_history rows older than RETAIN_DAYS.
  4. Null raw_result on zero-arb rows (belt & braces; scan route already skips them).
  5. WAL checkpoint (TRUNCATE) to keep the -wal file small.
  6. VACUUM on Sundays to reclaim disk.

Safe to run while the app is live: WAL mode + busy_timeout, and VACUUM is
skipped if it can't get the lock. Prints a one-line summary to stdout.
"""
import os
import shutil
import sqlite3
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

DB = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data", "edgefinder.db")
BACKUP_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data", "backups")
RETAIN_DAYS = int(os.environ.get("H2H_RETAIN_DAYS", "30"))
MAX_BACKUPS = int(os.environ.get("H2H_DB_BACKUPS", "7"))


def check_integrity(conn: sqlite3.Connection) -> bool:
    """Run PRAGMA integrity_check. Returns True if OK."""
    result = conn.execute("PRAGMA integrity_check").fetchone()[0]
    return result == "ok"


def rotate_backups() -> None:
    """Keep only the last MAX_BACKUPS backup files, delete older ones."""
    if not os.path.exists(BACKUP_DIR):
        return
    backups = sorted(
        Path(BACKUP_DIR).glob("edgefinder-*.db"),
        key=lambda p: p.stat().st_mtime,
        reverse=True,
    )
    for old in backups[MAX_BACKUPS:]:
        old.unlink()
        print(f"[db-retention] rotated old backup: {old.name}")


def main() -> int:
    if not os.path.exists(DB):
        print(f"[db-retention] DB not found: {DB}")
        return 1

    conn = sqlite3.connect(DB, timeout=30)
    conn.execute("PRAGMA busy_timeout = 30000")

    # Step 0: Integrity check — don't touch a corrupt DB
    if not check_integrity(conn):
        print(f"[db-retention] CORRUPTION DETECTED — skipping all maintenance!")
        print(f"[db-retention] DB is corrupt. Restore from {BACKUP_DIR} manually.")
        conn.close()
        return 2

    # Step 1: Backup before any destructive operations
    os.makedirs(BACKUP_DIR, exist_ok=True)
    ts = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    backup_path = os.path.join(BACKUP_DIR, f"edgefinder-{ts}.db")
    # Checkpoint first so the backup includes WAL contents
    try:
        conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
    except sqlite3.OperationalError:
        pass
    conn.close()  # close before copying to get a clean file
    shutil.copy2(DB, backup_path)
    print(f"[db-retention] backup: {backup_path} ({os.path.getsize(backup_path)/1e6:.1f}MB)")
    rotate_backups()

    # Reconnect for maintenance
    conn = sqlite3.connect(DB, timeout=30)
    conn.execute("PRAGMA busy_timeout = 30000")

    cutoff = (datetime.now(timezone.utc) - timedelta(days=RETAIN_DAYS)).isoformat()
    size_before = os.path.getsize(DB)

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
