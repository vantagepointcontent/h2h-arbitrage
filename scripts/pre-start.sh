#!/bin/bash
# OPS-008: Kill any lingering process on port 3000 before Next.js starts.
# This prevents EADDRINUSE when PM2 restarts the process and the old one
# hasn't fully released the port yet.
PORT=3000
PIDS=$(lsof -t -i:${PORT} 2>/dev/null || true)
if [ -n "$PIDS" ]; then
  echo "[pre-start] Port ${PORT} in use by PID(s): ${PIDS}. Killing..."
  for PID in $PIDS; do
    kill -9 "$PID" 2>/dev/null || true
  done
  sleep 1
  echo "[pre-start] Port ${PORT} cleared."
else
  echo "[pre-start] Port ${PORT} is free."
fi