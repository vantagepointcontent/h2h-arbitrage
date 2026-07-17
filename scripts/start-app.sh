#!/bin/bash
# OPS-008: Wrapper script for PM2 — kills any lingering process on port 3000
# before starting Next.js. Prevents EADDRINUSE on restart.
set -e
PORT=3000
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
cd /home/scott/h2h-arbitrage
exec ./node_modules/next/dist/bin/next start -p 3000 -H 0.0.0.0