#!/usr/bin/env bash
# restart.sh — Kill existing CrispLens v4 server and restart with verbose logs.
set -euo pipefail

PORT="${PORT:-7861}"
DB_PATH="${DB_PATH:-$(dirname "$0")/../face_recognition.db}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "==> CrispLens v4 restart"
echo "    Port:    $PORT"
echo "    DB:      $DB_PATH"

echo "v4.0.260307.1006 (started 2026-03-07 10:06)" > app_version.txt
# ── Kill any process holding the port ────────────────────────────────────────
OLD_PID=$(lsof -ti tcp:"$PORT" 2>/dev/null || true)
if [ -n "$OLD_PID" ]; then
  echo "==> Killing old server (PID $OLD_PID) on port $PORT ..."
  kill -TERM $OLD_PID 2>/dev/null || true
  sleep 1
  # Force-kill if still running
  if kill -0 $OLD_PID 2>/dev/null; then
    echo "==> Force-killing PID $OLD_PID ..."
    kill -9 $OLD_PID 2>/dev/null || true
    sleep 0.5
  fi
  echo "==> Old server stopped."
else
  echo "==> No existing server on port $PORT."
fi

# ── Start fresh ───────────────────────────────────────────────────────────────
echo "==> Starting server with DEBUG=1 ..."
echo ""

cd "$SCRIPT_DIR"
exec env DEBUG=1 PORT="$PORT" DB_PATH="$DB_PATH" node server.js
