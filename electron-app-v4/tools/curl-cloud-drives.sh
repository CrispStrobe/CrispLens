#!/usr/bin/env bash
# tools/curl-cloud-drives.sh — Debug cloud drives API via curl.
# Usage: ./tools/curl-cloud-drives.sh [base_url] [user] [pass]
#
# Examples:
#   ./tools/curl-cloud-drives.sh
#   ./tools/curl-cloud-drives.sh http://localhost:7861 admin admin

set -e
BASE="${1:-http://localhost:7861}"
USER="${2:-admin}"
PASS="${3:-admin}"
COOKIE_JAR=$(mktemp /tmp/crisp-cookies.XXXXXX)
trap "rm -f $COOKIE_JAR" EXIT

C() { curl -s -b "$COOKIE_JAR" -c "$COOKIE_JAR" "$@"; }
HR() { echo -e "\n\033[1;34m─── $1 ───\033[0m"; }
JSON() { python3 -c "import json,sys; d=json.load(sys.stdin); print(json.dumps(d, indent=2, ensure_ascii=False))" 2>/dev/null || cat; }

HR "1. Login to v4 server"
C -X POST "$BASE/api/auth/login" \
  -H "Content-Type: application/json" \
  -d "{\"username\":\"$USER\",\"password\":\"$PASS\"}" | JSON

HR "2. GET /api/cloud-drives (list all)"
C "$BASE/api/cloud-drives" | JSON

HR "3. DB direct check (if server is local)"
echo "Running node query on DB..."
cd "$(dirname "$0")/.." && node -e "
const db = require('better-sqlite3')('./../face_recognition.db');
try {
  const rows = db.prepare('SELECT id,name,type,is_mounted,owner_id,created_at,config FROM cloud_drives').all();
  console.log('Rows in cloud_drives:', rows.length);
  rows.forEach(r => {
    const cfg = JSON.parse(r.config || '{}');
    const safe = {...r, config: {...cfg, password: cfg.password ? '[***]' : undefined}};
    console.log(JSON.stringify(safe, null, 2));
  });
} catch(e) {
  if (e.message.includes('no such table')) console.log('Table cloud_drives does not exist yet.');
  else console.error('DB error:', e.message);
}
db.close();
" 2>&1

HR "4. POST /api/cloud-drives/test (Internxt)"
echo "Enter Internxt email/password in the payload below (edit script to change):"
C -X POST "$BASE/api/cloud-drives/test" \
  -H "Content-Type: application/json" \
  -d '{
    "type": "internxt",
    "config": {
      "email": "cstr@mailbox.org",
      "password": "GreenINxt!",
      "tfa_code": ""
    }
  }' | JSON

HR "5. POST /api/cloud-drives (create drive)"
C -X POST "$BASE/api/cloud-drives" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "My Internxt",
    "type": "internxt",
    "config": {
      "email": "cstr@mailbox.org",
      "password": "GreenINxt!",
      "tfa_code": ""
    }
  }' | JSON

HR "6. GET /api/cloud-drives (after create)"
C "$BASE/api/cloud-drives" | JSON

HR "Done. Cookie jar: $COOKIE_JAR (cleaned up on exit)"
