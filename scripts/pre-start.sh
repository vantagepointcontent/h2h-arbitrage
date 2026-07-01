#!/bin/bash
# pre-start.sh — Kill any lingering process on port 3000 before PM2 starts
# Called by ecosystem.config.js `pre_start` hook
# This prevents EADDRINUSE when PM2 restart doesn't fully release the port

PORT="${1:-3000}"

echo "[pre-start.sh] Checking port ${PORT}..."

# Try fuser first (fast, Linux-native)
if command -v fuser &>/dev/null; then
  fuser -k "${PORT}/tcp" 2>/dev/null && \
    echo "[pre-start.sh] fuser killed process on port ${PORT}" || \
    echo "[pre-start.sh] No process found on port ${PORT} (fuser)"
fi

# Fallback: try lsof + kill (works where fuser isn't available)
if command -v lsof &>/dev/null; then
  PID=$(lsof -ti :"${PORT}" 2>/dev/null)
  if [ -n "$PID" ]; then
    kill -15 "$PID" 2>/dev/null
    sleep 1
    # If still alive, force kill
    kill -9 "$PID" 2>/dev/null || true
    echo "[pre-start.sh] lsof killed PID ${PID} on port ${PORT}"
  fi
fi

# Small delay to let the port fully release
sleep 1
echo "[pre-start.sh] Port ${PORT} ready"