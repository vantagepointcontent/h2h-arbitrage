#!/usr/bin/env bash
set -euo pipefail
cd /home/scott/h2h-arbitrage
# Lifecycle-driven cleanup: prune caches of terminal worktrees and scratch spaces.
node scripts/workspace-cleanup.mjs --live --mode sweep --log data/workspace-cleanup.jsonl --metrics data/workspace-cleanup-metrics.jsonl
# Periodic full-worktree reconciliation fallback (only already-safe/done candidates).
node scripts/workspace-cleanup.mjs --live --mode lifecycle --log data/workspace-cleanup.jsonl --metrics data/workspace-cleanup-metrics.jsonl
