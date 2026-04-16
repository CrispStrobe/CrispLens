#!/usr/bin/env bash
# Manage login rate-limits.
#
# Usage:
#   ./reset_login_rate_limit.sh list           # show IPs with active rate limits
#   ./reset_login_rate_limit.sh reset          # clear ALL rate limits
#   ./reset_login_rate_limit.sh reset 1.2.3.4  # clear a specific IP
#
# The script calls the local API endpoint which only accepts requests
# from localhost (127.0.0.1 / ::1) without authentication.

set -euo pipefail

API_BASE="${CRISP_API_BASE:-http://127.0.0.1:7865}"
CMD="${1:-list}"

case "$CMD" in
    list|ls|status)
        echo "Active rate limits:"
        curl -s "${API_BASE}/api/auth/rate-limits" | python3 -m json.tool
        ;;
    reset|clear)
        IP="${2:-}"
        if [ -n "$IP" ]; then
            echo "Clearing rate limit for IP: $IP"
            curl -s -X POST "${API_BASE}/api/auth/reset-rate-limit?ip=${IP}" | python3 -m json.tool
        else
            echo "Clearing ALL rate limits"
            curl -s -X POST "${API_BASE}/api/auth/reset-rate-limit" | python3 -m json.tool
        fi
        ;;
    *)
        echo "Usage: $0 {list|reset [IP]}"
        exit 1
        ;;
esac
