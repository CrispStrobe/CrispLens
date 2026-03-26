#!/usr/bin/env bash
# restart.sh — Kill existing CrispLens v4 server and restart with verbose logs.
set -euo pipefail

PORT="${PORT:-7861}"
DB_PATH="${DB_PATH:-$(dirname "$0")/../face_recognition.db}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "==> CrispLens v4 restart"
echo "    Port:    $PORT"
echo "    DB:      $DB_PATH"

echo "v4.0.$(date +%y%m%d.%H%M) (started $(date +"%Y-%m-%d %H:%M"))" > app_version.txt
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

# ── Locate node (works for nvm, volta, system installs) ──────────────────────
NODE_BIN=""
for _try in \
    "$(command -v node 2>/dev/null)" \
    "$HOME/.nvm/versions/node/$(ls "$HOME/.nvm/versions/node/" 2>/dev/null | sort -V | tail -1)/bin/node" \
    "/usr/local/bin/node" \
    "/usr/bin/node" \
    "$(ls /root/.nvm/versions/node/*/bin/node 2>/dev/null | sort -V | tail -1)" \
    "$(ls /home/*/.nvm/versions/node/*/bin/node 2>/dev/null | sort -V | tail -1)"; do
    if [[ -x "$_try" ]]; then
        NODE_BIN="$_try"
        break
    fi
done

if [[ -z "$NODE_BIN" ]]; then
    # Last resort: source nvm and retry
    NVM_SH="${NVM_DIR:-$HOME/.nvm}/nvm.sh"
    if [[ -f "$NVM_SH" ]]; then
        # shellcheck disable=SC1090
        source "$NVM_SH" --no-use 2>/dev/null
        nvm use --lts 2>/dev/null || nvm use node 2>/dev/null || true
        NODE_BIN="$(command -v node 2>/dev/null)"
    fi
fi

if [[ -z "$NODE_BIN" ]]; then
    echo "ERROR: node not found. Install Node.js or ensure nvm is set up for this user."
    exit 1
fi

echo "==> Using node: $NODE_BIN  ($(\"$NODE_BIN\" --version))"
exec env DEBUG=1 PORT="$PORT" DB_PATH="$DB_PATH" "$NODE_BIN" server.js
