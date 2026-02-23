#!/usr/bin/env bash
# =============================================================================
# fix_db.sh — Post-git-pull sync + DB repair for CrispLens VPS installs
#
# Run this after "git pull" in the repo directory when the service lives in
# a separate install directory (e.g. /opt/crisp-lens) managed by deploy-v2.sh.
#
# What it does:
#   1. Syncs Python/SQL/config source files from the repo to the install dir
#   2. Initialises the DB from schema_complete.sql if no tables exist yet
#   3. Applies ALTER TABLE migrations for existing DBs (idempotent)
#   4. Fixes ownership of install dir files
#   5. Restarts the systemd service
#
# Usage:
#   sudo bash fix_db.sh [options]
#
# Options / env vars (all optional):
#   CRISP_REPO_DIR      git repo directory         (default: directory of this script)
#   CRISP_INSTALL_DIR   install directory           (default: /opt/crisp-lens)
#   CRISP_SVC_NAME      systemd service name        (default: face-rec)
#   CRISP_SVC_USER      service user                (default: face-rec)
#   CRISP_YES=1         skip confirmation prompt
#
# =============================================================================
set -euo pipefail

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
BLUE='\033[0;34m'; BOLD='\033[1m'; DIM='\033[2m'; NC='\033[0m'

info()  { echo -e "  ${GREEN}✔${NC}  $*"; }
warn()  { echo -e "  ${YELLOW}⚠${NC}  $*"; }
step()  { echo -e "\n${BOLD}${BLUE}▶  $*${NC}"; }
die()   { echo -e "  ${RED}✘${NC}  $*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "Run as root:  sudo bash fix_db.sh"

# ── Defaults ──────────────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="${CRISP_REPO_DIR:-$SCRIPT_DIR}"
INSTALL_DIR="${CRISP_INSTALL_DIR:-/opt/crisp-lens}"
SVC_NAME="${CRISP_SVC_NAME:-face-rec}"
SVC_USER="${CRISP_SVC_USER:-face-rec}"
DB="${INSTALL_DIR}/face_recognition.db"
SCHEMA="${INSTALL_DIR}/schema_complete.sql"
VENV="${INSTALL_DIR}/venv"

echo
echo -e "${BOLD}${BLUE}╔══════════════════════════════════════════════════════════════╗${NC}"
echo -e "${BOLD}${BLUE}║      CrispLens — fix_db.sh — Post-pull sync & DB repair      ║${NC}"
echo -e "${BOLD}${BLUE}╚══════════════════════════════════════════════════════════════╝${NC}"
echo
echo -e "  Repo dir    : ${REPO_DIR}"
echo -e "  Install dir : ${INSTALL_DIR}"
echo -e "  Service     : ${SVC_NAME}  (user: ${SVC_USER})"
echo -e "  Database    : ${DB}"
echo

[[ -d "$REPO_DIR"    ]] || die "Repo dir not found: ${REPO_DIR}"
[[ -d "$INSTALL_DIR" ]] || die "Install dir not found: ${INSTALL_DIR} — run deploy-v2.sh first"

if [[ "${CRISP_YES:-0}" != "1" ]]; then
    read -rp "  Proceed? [y/N]: " _go
    [[ "${_go,,}" == "y" ]] || { echo "  Aborted."; exit 0; }
fi

# =============================================================================
# STEP 1 — Sync Python / SQL / config files (skip data dirs + venv)
# =============================================================================
step "Syncing source files  ${REPO_DIR} → ${INSTALL_DIR}"

rsync -a --checksum \
    --exclude='venv/' \
    --exclude='node_modules/' \
    --exclude='*.db' --exclude='*.db-wal' --exclude='*.db-shm' \
    --exclude='*.index' \
    --exclude='.api_secret_key' \
    --exclude='__pycache__/' --exclude='*.pyc' --exclude='*.pyo' \
    --exclude='uploads/' --exclude='training_data/' \
    --exclude='logs/' --exclude='backups/' --exclude='exports/' \
    --exclude='thumbnails/' --exclude='face_crops/' --exclude='datasets/' \
    --exclude='.git/' \
    "${REPO_DIR}/" "${INSTALL_DIR}/"

info "Source files synced"

# =============================================================================
# STEP 2 — Fix ownership
# =============================================================================
step "Fixing ownership (${SVC_USER})"

if id "${SVC_USER}" &>/dev/null; then
    chown -R "${SVC_USER}:${SVC_USER}" "${INSTALL_DIR}"
    info "Ownership set to ${SVC_USER}"
else
    warn "User '${SVC_USER}' not found — skipping chown"
fi

# =============================================================================
# STEP 3 — DB initialisation / migration
# =============================================================================
step "Database: ${DB}"

# Locate sqlite3
SQLITE3=""
for _s in sqlite3 /usr/bin/sqlite3; do
    command -v "$_s" &>/dev/null && { SQLITE3="$_s"; break; }
done
[[ -n "$SQLITE3" ]] || die "sqlite3 not found — install it: apt-get install sqlite3"

# ── Helper: run SQL as service user ───────────────────────────────────────────
run_sql() {
    if id "${SVC_USER}" &>/dev/null; then
        sudo -u "${SVC_USER}" "$SQLITE3" "$DB" "$@"
    else
        "$SQLITE3" "$DB" "$@"
    fi
}

if [[ ! -f "$DB" ]]; then
    # ── Fresh DB — apply full schema ──────────────────────────────────────────
    echo -e "  ${DIM}Database not found — creating from schema_complete.sql${NC}"
    SCHEMA="${INSTALL_DIR}/schema_complete.sql"
    if [[ -f "$SCHEMA" ]]; then
        if id "${SVC_USER}" &>/dev/null; then
            sudo -u "${SVC_USER}" "$SQLITE3" "$DB" < "$SCHEMA"
        else
            "$SQLITE3" "$DB" < "$SCHEMA"
        fi
        info "Database created from schema_complete.sql"
    else
        warn "schema_complete.sql not found — DB will be initialised on first service start"
    fi
else
    # ── Existing DB — check if images table exists ────────────────────────────
    TABLES=$(run_sql "SELECT name FROM sqlite_master WHERE type='table' AND name='images';" 2>/dev/null || true)

    if [[ -z "$TABLES" ]]; then
        # DB file exists but is empty — apply full schema
        echo -e "  ${DIM}DB exists but has no tables — applying schema_complete.sql${NC}"
        SCHEMA="${INSTALL_DIR}/schema_complete.sql"
        if [[ -f "$SCHEMA" ]]; then
            run_sql < "$SCHEMA" || die "Schema application failed"
            info "Schema applied to existing (empty) database"
        else
            warn "schema_complete.sql not found — DB will be initialised on first service start"
        fi
    else
        # ── Existing DB with tables — run ALTER TABLE migrations (idempotent) ──
        echo -e "  ${DIM}Existing DB detected — running column migrations${NC}"

        apply_migration() {
            local desc="$1"; local sql="$2"
            if run_sql "$sql" 2>/dev/null; then
                info "Migration applied: ${desc}"
            else
                echo -e "  ${DIM}  (already exists, skipped): ${desc}${NC}"
            fi
        }

        # images table — v2 columns
        apply_migration "images.local_path"   "ALTER TABLE images ADD COLUMN local_path TEXT;"
        apply_migration "images.rating"       "ALTER TABLE images ADD COLUMN rating INTEGER DEFAULT 0;"
        apply_migration "images.flag"         "ALTER TABLE images ADD COLUMN flag TEXT;"
        apply_migration "images.description"  "ALTER TABLE images ADD COLUMN description TEXT;"
        apply_migration "images.phash"        "ALTER TABLE images ADD COLUMN phash TEXT;"
        apply_migration "images.star_rating"  "ALTER TABLE images ADD COLUMN star_rating INTEGER DEFAULT 0;"
        apply_migration "images.color_flag"   "ALTER TABLE images ADD COLUMN color_flag TEXT;"

        # Security / access-control columns (added 2026-02-22)
        apply_migration "images.owner_id"     "ALTER TABLE images ADD COLUMN owner_id INTEGER REFERENCES users(id) ON DELETE SET NULL;"
        apply_migration "images.visibility"   "ALTER TABLE images ADD COLUMN visibility TEXT DEFAULT 'shared';"

        # faces table
        apply_migration "faces.face_quality"  "ALTER TABLE faces ADD COLUMN face_quality REAL DEFAULT 1.0;"

        # Indexes (CREATE INDEX IF NOT EXISTS is idempotent)
        apply_migration "idx_images_local_path" \
            "CREATE INDEX IF NOT EXISTS idx_images_local_path ON images(local_path);"
        apply_migration "idx_images_phash" \
            "CREATE INDEX IF NOT EXISTS idx_images_phash ON images(phash);"
        apply_migration "idx_images_owner" \
            "CREATE INDEX IF NOT EXISTS idx_images_owner ON images(owner_id);"
        apply_migration "idx_images_visibility" \
            "CREATE INDEX IF NOT EXISTS idx_images_visibility ON images(visibility);"

        # watch_folders table (added in watchfolders router)
        run_sql "
            CREATE TABLE IF NOT EXISTS watch_folders (
                id        INTEGER PRIMARY KEY AUTOINCREMENT,
                path      TEXT NOT NULL UNIQUE,
                recursive INTEGER DEFAULT 1,
                auto_scan INTEGER DEFAULT 0,
                interval_minutes INTEGER DEFAULT 60,
                last_scan TIMESTAMP,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
            CREATE INDEX IF NOT EXISTS idx_watch_folders_path ON watch_folders(path);
        " 2>/dev/null && info "watch_folders table ensured" || true

        # image_shares + album_shares tables (added 2026-02-22)
        run_sql "
            CREATE TABLE IF NOT EXISTS image_shares (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                image_id   INTEGER NOT NULL,
                user_id    INTEGER NOT NULL,
                shared_by  INTEGER NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(image_id, user_id),
                FOREIGN KEY (image_id)  REFERENCES images(id)  ON DELETE CASCADE,
                FOREIGN KEY (user_id)   REFERENCES users(id)   ON DELETE CASCADE,
                FOREIGN KEY (shared_by) REFERENCES users(id)   ON DELETE CASCADE
            );
            CREATE INDEX IF NOT EXISTS idx_image_shares_image ON image_shares(image_id);
            CREATE INDEX IF NOT EXISTS idx_image_shares_user  ON image_shares(user_id);
        " 2>/dev/null && info "image_shares table ensured" || true

        run_sql "
            CREATE TABLE IF NOT EXISTS album_shares (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                album_id   INTEGER NOT NULL,
                user_id    INTEGER NOT NULL,
                shared_by  INTEGER NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(album_id, user_id),
                FOREIGN KEY (album_id)  REFERENCES albums(id)  ON DELETE CASCADE,
                FOREIGN KEY (user_id)   REFERENCES users(id)   ON DELETE CASCADE,
                FOREIGN KEY (shared_by) REFERENCES users(id)   ON DELETE CASCADE
            );
            CREATE INDEX IF NOT EXISTS idx_album_shares_album ON album_shares(album_id);
            CREATE INDEX IF NOT EXISTS idx_album_shares_user  ON album_shares(user_id);
        " 2>/dev/null && info "album_shares table ensured" || true

        info "All migrations complete"
    fi
fi

# Quick sanity check
IMAGES_COLS=$(run_sql "PRAGMA table_info(images);" 2>/dev/null | awk -F'|' '{print $2}' | tr '\n' ' ' || true)
for _col in local_path owner_id visibility; do
    if echo "$IMAGES_COLS" | grep -q "$_col"; then
        info "Verified: images.${_col} column exists"
    else
        warn "images.${_col} column NOT found — check DB manually"
    fi
done

# =============================================================================
# STEP 3b — Sync pre-built Svelte frontend (renderer/dist/)
# =============================================================================
step "Syncing Svelte frontend (renderer/dist/)"

DIST_SRC="${REPO_DIR}/electron-app-v2/renderer/dist"
DIST_DST="${INSTALL_DIR}/renderer/dist"

if [[ -d "$DIST_SRC" ]]; then
    mkdir -p "$DIST_DST"
    rsync -a --delete "${DIST_SRC}/" "${DIST_DST}/"
    if id "${SVC_USER}" &>/dev/null; then
        chown -R "${SVC_USER}:${SVC_USER}" "${INSTALL_DIR}/renderer"
    fi
    info "Frontend dist synced"
else
    warn "renderer/dist/ not found in repo — build it first: cd electron-app-v2/renderer && npm run build"
fi

# =============================================================================
# STEP 4 — pip install (update deps if requirements.txt changed)
# =============================================================================
step "Checking Python dependencies"

REQ="${INSTALL_DIR}/requirements.txt"
if [[ -f "$REQ" && -d "$VENV" ]]; then
    if id "${SVC_USER}" &>/dev/null; then
        sudo -u "${SVC_USER}" "${VENV}/bin/pip" install -q -r "$REQ" \
            && info "Dependencies up-to-date" \
            || warn "pip install reported errors — check output"
    else
        "${VENV}/bin/pip" install -q -r "$REQ" \
            && info "Dependencies up-to-date" \
            || warn "pip install reported errors"
    fi
else
    warn "venv or requirements.txt not found — skipping pip"
fi

# =============================================================================
# STEP 5 — Restart service
# =============================================================================
step "Restarting service: ${SVC_NAME}"

if systemctl list-unit-files "${SVC_NAME}.service" &>/dev/null \
        && systemctl list-unit-files "${SVC_NAME}.service" | grep -q "${SVC_NAME}"; then
    systemctl restart "${SVC_NAME}"
    sleep 4
    if systemctl is-active --quiet "${SVC_NAME}"; then
        info "Service '${SVC_NAME}' is running"
    else
        echo -e "  ${RED}Service failed to start — last 30 log lines:${NC}"
        journalctl -u "${SVC_NAME}" -n 30 --no-pager
        die "Fix the error above, then:  systemctl start ${SVC_NAME}"
    fi
else
    warn "systemd service '${SVC_NAME}' not found — start it manually"
fi

# =============================================================================
# DONE
# =============================================================================
echo
echo -e "  ${BOLD}${GREEN}Done!${NC}  Files synced, DB ready, service restarted."
echo
echo -e "  ${DIM}Live logs:  journalctl -u ${SVC_NAME} -f${NC}"
echo -e "  ${DIM}Health:     curl -s http://127.0.0.1:\$(systemctl show -p Environment ${SVC_NAME} | grep -o 'FACE_REC_PORT=[0-9]*' | cut -d= -f2)/api/health${NC}"
echo
