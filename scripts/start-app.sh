#!/bin/bash
# OPS-158: PM2 only starts a complete, verified, atomically promoted release.
set -euo pipefail
PORT=3000
REPO_ROOT=/home/scott/h2h-arbitrage
cd "$REPO_ROOT"

IDENTITY=$(node scripts/release-manager.mjs verify-active)
export DEPLOY_COMMIT
export H2H_BUILD_ID
DEPLOY_COMMIT=$(node -e 'const fs=require("fs"); const v=JSON.parse(fs.readFileSync(0,"utf8")); process.stdout.write(v.commit)' <<<"$IDENTITY")
H2H_BUILD_ID=$(node -e 'const fs=require("fs"); const v=JSON.parse(fs.readFileSync(0,"utf8")); process.stdout.write(v.buildId)' <<<"$IDENTITY")
export H2H_NEXT_DIST_DIR=.h2h-releases/active/.next

PIDS=$(lsof -t -i:${PORT} 2>/dev/null || true)
if [ -n "$PIDS" ]; then
  echo "[pre-start] Port ${PORT} in use by PID(s): ${PIDS}. Killing..."
  for PID in $PIDS; do
    kill -9 "$PID" 2>/dev/null || true
  done
  sleep 1
  echo "[pre-start] Port ${PORT} cleared."
fi

echo "[pre-start] Starting Next.js on port ${PORT}..."
exec node --env-file-if-exists=.env.local ./node_modules/next/dist/bin/next start -p 3000 -H 0.0.0.0