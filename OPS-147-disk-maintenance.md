# OPS-147 Disk Maintenance

## Preventive controls configured
- PM2 logrotate: max_size=10M, retain=7, compress=true, rotate daily at midnight
- Hermes cron `h2h-disk-maintenance`: Sundays 03:00, runs `scripts/disk-maintenance.sh`
- Hermes cron `h2h-disk-metrics`: every hour, records `data/disk-metrics.jsonl`
- Disk alert thresholds: usage >=80% OR free <15GB

## Retention policy
- Positive-arbitrage scans: retained indefinitely (no automatic deletion)
- Zero-arbitrage scans: eligible for deletion after 7 days
- `.next` caches in worktrees/workspaces: removed after 3 days if not open
- npm cache: cleaned if >1GB
- `/tmp` stale DB copies / temp worktrees: removed after 1-3 days

## Manual rollback
- Pre-cleanup backups: `data/backup-pre-ops147/`
- Git lost-found objects moved to: `data/backup-pre-ops147/git-lost-found-objects/`
- Original data backup: removed after verifying `backup-pre-ops147` integrity
