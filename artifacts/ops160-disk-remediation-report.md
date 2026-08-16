# OPS-160 Disk Capacity Remediation Report

Generated: 2026-08-16 UTC
Task: `t_67066a47`

## Result

Emergency capacity was restored without deleting the live SQLite database, WAL/SHM, active/review/retry worktrees, active or rollback releases, protected rollback backups, Git recovery objects, or undelivered artifacts.

| Metric | Before | After | Change |
|---|---:|---:|---:|
| Root available bytes | 1,826,287,104 | 20,021,272,576 | +18,194,985,472 |
| Root usage | 98% | 76% | -22 percentage points |
| Root available inodes | 9,663,646 | 9,682,160 | +18,514 |
| Root inode usage | 7% | 7% | healthy |

The acceptance threshold is satisfied: 20.02 GB free is above the 15 GB reserve and filesystem use is below 80%.

## Root cause and growth attribution

The filesystem was not exhausted by one live database. It was the combined effect of several previously unbounded copy-producing paths:

1. Completed/terminal Kanban worktrees retained local `node_modules`, `.next`, and `.builds` caches after their task directories had ceased to be active.
2. Historical Hermes/workspace backups duplicated large worktrees and dependencies.
3. A superseded OPS-146 database snapshot and runtime-evidence tree remained under `data/backup-pre-ops147` even after newer integrity-checked rollback backups existed.
4. Isolated release candidates deliberately retain complete reproducible artifacts but had no disk gate before candidate creation or promotion.
5. Scan retention deleted all old scans uniformly rather than preserving positive-arbitrage evidence while pruning only old zero-arbitrage history.
6. Capacity telemetry, retention audit logs, backups, and delivered artifacts lacked a common bounded policy.
7. Deleted-but-open files had held approximately 2.11 GB during the incident; only the owning safe PM2 processes were restarted to release those descriptors.

Initial high-value categories included approximately 14.48 GB of Hermes backups, 10.26 GB of application data/backups, 7.57 GB of worktrees, 2.97 GB of PM2 logs, 2.47 GB of Git objects, and 2.10 GB of releases. Apparent per-directory sizes overlap because hard-linked `node_modules` trees are used by isolated releases, so the authoritative reconciliation is the root filesystem delta above, not the sum of `du` categories.

Final measured categories:

| Path | Bytes |
|---|---:|
| `/home/scott/.hermes` | 18,292,445,184 |
| `backups` | 4,598,022,144 |
| `data` | 4,250,017,792 |
| `.git` | 1,740,394,496 |
| `.h2h-releases` | 1,316,667,392 |
| `.worktrees` | 989,331,456 |
| `/home/scott/.pm2/logs` | 378,327,040 |
| `artifacts` | 93,843,456 |

## Cleanup decisions and safety gates

- Ran workspace cleanup in dry-run mode before live mode, then ran it repeatedly. The second/third live cycle reclaimed zero bytes and reported zero actual removals after the idempotence accounting fix.
- Removed only terminal/orphan cache paths after Kanban state, Git state, process CWD/open-file, and task-artifact guards passed.
- Ran `git worktree prune --verbose` after on-disk cleanup; 34 stale metadata entries were removed. `git fsck --no-dangling` passed; Git reports zero garbage.
- Pruned superseded OPS-146 snapshot/runtime evidence and one non-active legacy release only after `lsof` returned no owners and active/rollback release symlinks were resolved. Exact manifest: `artifacts/ops160-legacy-archive-prune.json` (2,547,520,722 apparent bytes).
- Preserved `data/backup-pre-ops147/git-lost-found-objects` as recoverable Git evidence.
- Preserved and integrity-checked `backups/bug159-pre-deploy-20260816T123720Z` and `backups/ops157-20260816T115131Z`; both are explicit protected entries in `data/backup-retention-policy.json`.
- Preserved all 27 undelivered entries under `artifacts`; artifact retention requires a `.delivered` receipt before age-based deletion.
- Preserved the active and rollback releases. `release-manager verify-active` passed and `/api/health` reported the same deployed commit/build.
- PM2 logrotate is online with `max_size=10M`, `retain=7`, compression enabled, and dated rotations.

## Durable controls implemented

### Capacity preflight gates

`src/lib/disk-capacity.mjs` now evaluates bytes and inodes against a 15,000,000,000-byte and 100,000-inode reserve plus operation-specific burst budgets.

Enforced paths:

- scan requests: `src/app/api/scan/route.ts` returns HTTP 507 before enqueueing a scan when the reserve would be breached;
- isolated release builds: `scripts/release-manager.mjs` gates before staging/worktree creation;
- release promotion: the same manager gates before promotion mutation;
- SQLite backups: `scripts/safe-sqlite-backup.mjs` sizes the source, gates the projected copy, uses SQLite `VACUUM INTO`, verifies `PRAGMA quick_check`, computes SHA-256, and writes a manifest;
- migrations: package migration commands run `scripts/disk-capacity-check.mjs` first;
- maintenance/retention: `scripts/storage-retention.mjs` runs a maintenance preflight before mutation.

A blocked build test proved the gate fails before creating staging/build output. After remediation, the same canonical isolated build succeeded.

### Retention and rotation

- Scan policy: all positive-arbitrage scans are retained; only zero-arbitrage scans older than at least seven days are deleted. The poller, API path, persistence helper, and bundled DB-maintenance job share the same SQL/policy module.
- Releases: keep the newest bounded set while never deleting active/rollback releases; candidates expire after the existing verified age threshold.
- Worktrees/caches: terminal/orphan paths age out only after Git, process, Kanban, artifact, and uncommitted-change gates pass.
- Backups: 14-day/three-newest bounded policy, with explicit protected rollback names and open-file/live-database refusal.
- Artifacts: 30-day deletion only after a `.delivered` receipt; undelivered artifacts are always preserved.
- Capacity/retention telemetry: JSONL files rotate at fixed byte limits with one bounded previous segment.
- Logs: PM2 logrotate settings above.

### Monitoring and alerts

PM2 now persists:

- `h2h-disk-monitor`: samples every 60 seconds, writes `data/disk-capacity-health.json`, bounded JSONL history/alerts, and Prometheus text metrics in `data/disk-capacity.prom`;
- `h2h-storage-retention`: runs bounded live retention, sleeps as a daemon, and is restarted daily at 03:30 UTC.

Both were started with `--update-env` and the PM2 process list was saved. The live monitor currently reports `warning` at 75.6% utilization, 20.03 GB free, healthy inode usage, and no forecast until at least one hour of monitor-only samples exists. Forecasts intentionally reject sub-hour noise.

## Verification evidence

- Full suite: 226 test files, 1,736 tests passed.
- Focused OPS-160 suite: 12 files, 43 tests passed; final monitor/wiring subset also passed.
- Canonical lint: passed, 430/431 reviewed baseline errors and zero new lint errors.
- TypeScript baseline remains non-zero repository-wide, but filtered output contains zero errors in OPS-160 files.
- Canonical isolated build: succeeded and produced a sealed candidate; build tests/lint/Next targets passed. The pre-remediation build attempt was correctly rejected before writes.
- `build:maintenance`: bundled shared scan-retention logic successfully with esbuild.
- SQLite live and both protected backups: `PRAGMA quick_check=ok`, `PRAGMA foreign_key_check` returned zero rows.
- Git: `git fsck --no-dangling` passed; `git count-objects` reports zero garbage; stale worktree metadata was pruned.
- PM2: app, poller, Ragnar, watcher, valuer, release monitor, disk monitor, and storage retention are online; `pm2 save` succeeded.
- Watcher: restarted from the built artifact using delete/start `--update-env`; `/api/watcher/health` returned HTTP 200, Kalshi connected, Polymarket 1/1, live write errors 0.
- App: `/api/health`, `/api/saved-markets`, and `/api/watcher/health` returned HTTP 200; 488 saved markets remain.
- Natural scans: latest poller cycle persisted 10 successful scans and had 3 bounded failures (two HTTP 500, one timeout), proving scanning/persistence are operating; no ENOSPC or SQLITE_FULL was observed after cleanup.
- Ragnar: health is `healthy`, the latest cycle processed eight decisions, and the durable consumer continued natural progression.
- Release: active commit/build agrees between `/api/health` and `release-manager verify-active`; rollback remains present.
- Backup gate: live-database dry run passed with source size 1,966,518,272 bytes and projected free space 17,798,754,304 bytes, still above reserve.
- Idempotence: repeated live retention cycles reclaimed zero bytes and removed no additional paths after the first safe cleanup.

## Remaining operational observations

- The natural poller health is currently `degraded`, not stopped: the latest cycle had 10 successes and three market-specific failures, with one overdue market. This is already in the dependent OPS-156 lane and is not an ENOSPC failure.
- Existing app logs contain intermittent `SQLITE_BUSY` lifecycle-tracking warnings while scans remain unaffected. SQLite integrity is clean; the dependent OPS-156 production verification should continue watching this contention.
- OPS-160 source changes are intentionally uncommitted because this task did not authorize a commit. PM2 monitoring/retention processes are live from the working tree. Any clean-checkout deployment must first review and commit these files; the dependent release builder itself remains commit-isolated and does not consume uncommitted code.

## Rollback

1. Stop/delete `h2h-disk-monitor` and `h2h-storage-retention`, then `pm2 save`.
2. Revert OPS-160 source/config changes after review; do not restore superseded caches.
3. Leave the protected backup policy and the two validated rollback backups in place.
4. If release behavior regresses, use `node scripts/release-manager.mjs rollback`; active/rollback identities were preserved and verified.
5. Do not lower the 15 GB reserve to force a release. If capacity again falls below reserve after bounded cleanup, add physical storage or move cold evidence to an external durable volume.
