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

if [[ -t 0 && "${CRISP_YES:-0}" != "1" ]]; then
    read -rp "  Proceed? [y/N]: " _go
    [[ "${_go,,}" == "y" ]] || { echo "  Aborted."; exit 0; }
fi

# =============================================================================
# STEP 0 — Sudoers NOPASSWD + config.yaml fix_db_path (idempotent)
# =============================================================================
# Ensure the service user can call "sudo bash fix_db.sh" without a password.
# The face-rec user is a system account with no shell password, so sudo -S
# always fails unless NOPASSWD is in sudoers.  We write a dedicated drop-in
# file so the main /etc/sudoers is never modified.
step "Ensuring NOPASSWD sudoers entry for ${SVC_USER}"

SUDOERS_FILE="/etc/sudoers.d/crisp-lens"
THIS_SCRIPT_ABS="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"
SUDOERS_LINE="${SVC_USER} ALL=(ALL) NOPASSWD: /bin/bash ${THIS_SCRIPT_ABS}"

_write_sudoers=false
if [[ -f "$SUDOERS_FILE" ]]; then
    if grep -qF "$SUDOERS_LINE" "$SUDOERS_FILE"; then
        info "Sudoers entry already correct"
    else
        _write_sudoers=true
        info "Sudoers entry outdated — updating"
    fi
else
    _write_sudoers=true
fi

if [[ "$_write_sudoers" == true ]]; then
    echo "$SUDOERS_LINE" > "$SUDOERS_FILE"
    chmod 440 "$SUDOERS_FILE"
    if visudo -c -f "$SUDOERS_FILE" &>/dev/null; then
        info "Sudoers drop-in written: ${SUDOERS_FILE}"
        info "  → ${SUDOERS_LINE}"
    else
        warn "Sudoers syntax check failed — removing ${SUDOERS_FILE}"
        rm -f "$SUDOERS_FILE"
    fi
fi

# Also keep config.yaml in sync so the admin UI always knows the script path.
CFG="${INSTALL_DIR}/config.yaml"
if [[ -f "$CFG" ]]; then
    python3 - "$CFG" "admin.fix_db_path" "$THIS_SCRIPT_ABS" <<'PYEOF' 2>/dev/null && \
        info "config.yaml: admin.fix_db_path = ${THIS_SCRIPT_ABS}" || \
        warn "Could not patch admin.fix_db_path in config.yaml"
import sys, re
cfg_path, key, val = sys.argv[1], sys.argv[2], sys.argv[3]
try:
    import yaml
    with open(cfg_path) as fh: data = yaml.safe_load(fh) or {}
    parts = key.split('.')
    node = data
    for p in parts[:-1]: node = node.setdefault(p, {})
    node[parts[-1]] = val
    with open(cfg_path, 'w') as fh:
        yaml.dump(data, fh, default_flow_style=False, allow_unicode=True, sort_keys=False)
except ImportError:
    leaf = key.split('.')[-1]
    text = open(cfg_path).read()
    if re.search(rf'^\s*{re.escape(leaf)}\s*:', text, re.MULTILINE):
        text = re.sub(rf'^(\s*{re.escape(leaf)}\s*:).*$', rf'\g<1> {val}', text, flags=re.MULTILINE)
    else:
        text += f'\n# written by fix_db.sh\nadmin:\n  fix_db_path: {val}\n'
    open(cfg_path, 'w').write(text)
PYEOF
fi

# =============================================================================
# STEP 0b — Git pull (update the repo before syncing to install dir)
# =============================================================================
step "Updating repository  (git pull)  ${REPO_DIR}"

if git -C "$REPO_DIR" rev-parse --is-inside-work-tree &>/dev/null 2>&1; then
    # Remove untracked files in dirs that are now tracked by git (e.g. renderer/dist
    # was previously gitignored on the server but is now committed).  Without this,
    # git pull aborts with "untracked working tree files would be overwritten".
    for _dist_dir in electron-app-v4/renderer/dist electron-app-v2/renderer/dist; do
        _abs="${REPO_DIR}/${_dist_dir}"
        if [[ -d "$_abs" ]] && ! git -C "$REPO_DIR" ls-files --error-unmatch "${_dist_dir}/index.html" &>/dev/null 2>&1; then
            info "Clearing previously-untracked dist dir: ${_dist_dir}"
            rm -rf "$_abs"
        fi
    done

    if git -C "$REPO_DIR" pull 2>&1; then
        info "Repository updated"
    else
        warn "git pull failed — continuing with current version"
    fi
else
    warn "${REPO_DIR} is not a git repository — skipping git pull"
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

        # User curation extended columns
        apply_migration "images.favorite"     "ALTER TABLE images ADD COLUMN favorite BOOLEAN DEFAULT 0;"
        apply_migration "images.creator"      "ALTER TABLE images ADD COLUMN creator TEXT;"
        apply_migration "images.copyright"    "ALTER TABLE images ADD COLUMN copyright TEXT;"

        # Archive / Bildarchiv metadata columns (added 2026-03-26)
        apply_migration "images.bildarchiv_path"      "ALTER TABLE images ADD COLUMN bildarchiv_path TEXT;"
        apply_migration "images.bildauswahl_path"     "ALTER TABLE images ADD COLUMN bildauswahl_path TEXT;"
        apply_migration "images.fachbereich"          "ALTER TABLE images ADD COLUMN fachbereich TEXT;"
        apply_migration "images.veranstaltungsnummer" "ALTER TABLE images ADD COLUMN veranstaltungsnummer TEXT;"
        apply_migration "images.veranstaltungstitel"  "ALTER TABLE images ADD COLUMN veranstaltungstitel TEXT;"
        apply_migration "images.urheber"              "ALTER TABLE images ADD COLUMN urheber TEXT;"
        apply_migration "images.datum_event"          "ALTER TABLE images ADD COLUMN datum_event DATE;"

        # Security / access-control columns (added 2026-02-22)
        apply_migration "images.owner_id"     "ALTER TABLE images ADD COLUMN owner_id INTEGER REFERENCES users(id) ON DELETE SET NULL;"
        apply_migration "images.visibility"   "ALTER TABLE images ADD COLUMN visibility TEXT DEFAULT 'shared';"

        # users table — per-user VLM preferences (added 2026-02-24)
        apply_migration "users.vlm_enabled"   "ALTER TABLE users ADD COLUMN vlm_enabled INTEGER;"
        apply_migration "users.vlm_provider"  "ALTER TABLE users ADD COLUMN vlm_provider TEXT;"
        apply_migration "users.vlm_model"     "ALTER TABLE users ADD COLUMN vlm_model TEXT;"
        # users table — per-user detection model override (added 2026-02-24)
        apply_migration "users.det_model"     "ALTER TABLE users ADD COLUMN det_model TEXT;"

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

        # file_hash composite index (replaces the old column-level UNIQUE constraint)
        # NOTE: The full table-recreation migration (removing the UNIQUE from file_hash)
        # runs automatically in fastapi_app.py on service startup — no manual SQL needed.
        # After the service starts, this index will exist. We just try to create it here
        # for DBs that have already been migrated by the service but haven't had this run.
        apply_migration "idx_images_file_hash_owner" \
            "CREATE UNIQUE INDEX IF NOT EXISTS idx_images_file_hash_owner ON images(file_hash, owner_id) WHERE file_hash IS NOT NULL;"

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

        # cloud_drives table (v2 schema — updated 2026-03-12)
        # Uses config_encrypted (Fernet BLOB) + is_mounted/scope/allowed_roles/auto_mount/enabled
        run_sql "
            CREATE TABLE IF NOT EXISTS cloud_drives (
                id             INTEGER PRIMARY KEY AUTOINCREMENT,
                name           TEXT NOT NULL,
                type           TEXT NOT NULL,
                config_encrypted BLOB NOT NULL DEFAULT '',
                mount_point    TEXT,
                scope          TEXT NOT NULL DEFAULT 'system',
                owner_id       INTEGER REFERENCES users(id) ON DELETE SET NULL,
                allowed_roles  TEXT NOT NULL DEFAULT '[\"admin\",\"medienverwalter\"]',
                auto_mount     INTEGER NOT NULL DEFAULT 0,
                enabled        INTEGER NOT NULL DEFAULT 1,
                is_mounted     INTEGER NOT NULL DEFAULT 0,
                last_error     TEXT,
                created_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
            CREATE INDEX IF NOT EXISTS idx_cloud_drives_owner  ON cloud_drives(owner_id);
            CREATE INDEX IF NOT EXISTS idx_cloud_drives_type   ON cloud_drives(type);
        " 2>/dev/null && info "cloud_drives table ensured" || true

        # cloud_drives migrations: upgrade old schema (config → config_encrypted, status → is_mounted)
        apply_migration "cloud_drives.config_encrypted" \
            "ALTER TABLE cloud_drives ADD COLUMN config_encrypted BLOB NOT NULL DEFAULT '';"
        apply_migration "cloud_drives.scope" \
            "ALTER TABLE cloud_drives ADD COLUMN scope TEXT NOT NULL DEFAULT 'system';"
        apply_migration "cloud_drives.allowed_roles" \
            "ALTER TABLE cloud_drives ADD COLUMN allowed_roles TEXT NOT NULL DEFAULT '[\"admin\",\"medienverwalter\"]';"
        apply_migration "cloud_drives.auto_mount" \
            "ALTER TABLE cloud_drives ADD COLUMN auto_mount INTEGER NOT NULL DEFAULT 0;"
        apply_migration "cloud_drives.enabled" \
            "ALTER TABLE cloud_drives ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1;"
        apply_migration "cloud_drives.is_mounted" \
            "ALTER TABLE cloud_drives ADD COLUMN is_mounted INTEGER NOT NULL DEFAULT 0;"
        apply_migration "cloud_drives.last_error" \
            "ALTER TABLE cloud_drives ADD COLUMN last_error TEXT;"
        apply_migration "cloud_drives.updated_at" \
            "ALTER TABLE cloud_drives ADD COLUMN updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;"
        # v4-compat: token column (plain JSON session token used by v4 Node.js backend)
        apply_migration "cloud_drives.token" \
            "ALTER TABLE cloud_drives ADD COLUMN token TEXT;"

        # batch_jobs + batch_job_files tables (added 2026-02-28)
        run_sql "
            CREATE TABLE IF NOT EXISTS batch_jobs (
                id               INTEGER PRIMARY KEY AUTOINCREMENT,
                owner_id         INTEGER NOT NULL,
                name             TEXT,
                status           TEXT NOT NULL DEFAULT 'pending',
                source_path      TEXT,
                recursive        INTEGER DEFAULT 1,
                follow_symlinks  INTEGER DEFAULT 0,
                visibility       TEXT DEFAULT 'shared',
                det_params       TEXT,
                tag_ids          TEXT,
                new_tag_names    TEXT,
                album_id         INTEGER,
                new_album_name   TEXT,
                total_count      INTEGER DEFAULT 0,
                done_count       INTEGER DEFAULT 0,
                error_count      INTEGER DEFAULT 0,
                skipped_count    INTEGER DEFAULT 0,
                created_at       TEXT DEFAULT (datetime('now')),
                started_at       TEXT,
                finished_at      TEXT
            );
            CREATE TABLE IF NOT EXISTS batch_job_files (
                id           INTEGER PRIMARY KEY AUTOINCREMENT,
                job_id       INTEGER NOT NULL REFERENCES batch_jobs(id) ON DELETE CASCADE,
                filepath     TEXT NOT NULL,
                local_path   TEXT,
                status       TEXT NOT NULL DEFAULT 'pending',
                image_id     INTEGER,
                error_msg    TEXT,
                skip_reason  TEXT,
                processed_at TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_bjf_job_status  ON batch_job_files(job_id, status);
            CREATE INDEX IF NOT EXISTS idx_bj_owner_status ON batch_jobs(owner_id, status);
            UPDATE batch_jobs SET status='paused' WHERE status='running';
        " 2>/dev/null && info "batch_jobs + batch_job_files tables ensured" || true
        # Additive column: local_path on batch_job_files (added later — idempotent)
        apply_migration "batch_job_files.local_path" \
            "ALTER TABLE batch_job_files ADD COLUMN local_path TEXT;"

        info "All migrations complete"
    fi
fi

# Quick sanity check
IMAGES_COLS=$(run_sql "PRAGMA table_info(images);" 2>/dev/null | awk -F'|' '{print $2}' | tr '\n' ' ' || true)
for _col in local_path owner_id visibility phash; do
    if echo "$IMAGES_COLS" | grep -q "$_col"; then
        info "Verified: images.${_col} column exists"
    else
        warn "images.${_col} column NOT found — check DB manually"
    fi
done

USERS_COLS=$(run_sql "PRAGMA table_info(users);" 2>/dev/null | awk -F'|' '{print $2}' | tr '\n' ' ' || true)
for _col in vlm_enabled vlm_provider vlm_model det_model; do
    if echo "$USERS_COLS" | grep -q "$_col"; then
        info "Verified: users.${_col} column exists"
    else
        warn "users.${_col} column NOT found — check DB manually"
    fi
done

# Verify file_hash composite index (created by service on startup after table migration)
FILE_HASH_IDX=$(run_sql "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_images_file_hash_owner';" 2>/dev/null || true)
if [[ -n "$FILE_HASH_IDX" ]]; then
    info "Verified: idx_images_file_hash_owner composite index exists"
else
    warn "idx_images_file_hash_owner not yet present — will be created on first service start"
fi

# =============================================================================
# STEP 3b — Sync pre-built Svelte frontend (renderer/dist/)
# =============================================================================
step "Syncing Svelte frontend (renderer/dist/)"

# Prefer v4 renderer if it exists (v4 Node.js backend), fall back to v2
if [[ -d "${REPO_DIR}/electron-app-v4/renderer/dist" ]]; then
    DIST_SRC="${REPO_DIR}/electron-app-v4/renderer/dist"
    DIST_DST="${INSTALL_DIR}/electron-app-v4/renderer/dist"
elif [[ -d "${REPO_DIR}/electron-app-v2/renderer/dist" ]]; then
    DIST_SRC="${REPO_DIR}/electron-app-v2/renderer/dist"
    DIST_DST="${INSTALL_DIR}/renderer/dist"
else
    DIST_SRC=""
fi

if [[ -n "$DIST_SRC" ]]; then
    mkdir -p "$DIST_DST"
    rsync -a --delete "${DIST_SRC}/" "${DIST_DST}/"
    if id "${SVC_USER}" &>/dev/null; then
        chown -R "${SVC_USER}:${SVC_USER}" "$(dirname "$DIST_DST")"
    fi
    info "Frontend dist synced from ${DIST_SRC}"
else
    warn "renderer/dist/ not found in repo — build it first:"
    warn "  v4: cd electron-app-v4/renderer && npm run build"
    warn "  v2: cd electron-app-v2/renderer && npm run build"
fi

# =============================================================================
# STEP 4 — pip install (update deps if requirements.txt changed)
# =============================================================================
step "Checking Python dependencies"

REQ="${INSTALL_DIR}/requirements.txt"
if [[ -f "$REQ" && -d "$VENV" ]]; then
    _pip() { "${VENV}/bin/pip" "$@"; }
    _pip_as_svc() {
        if id "${SVC_USER}" &>/dev/null; then
            sudo -u "${SVC_USER}" "${VENV}/bin/pip" "$@"
        else
            "${VENV}/bin/pip" "$@"
        fi
    }

    _pip_as_svc install -q -r "$REQ" \
        && info "Dependencies up-to-date" \
        || warn "pip install reported errors — check output"

    # ── Auto-upgrade onnxruntime → onnxruntime-gpu when NVIDIA GPU present ────
    # onnxruntime (CPU-only) will silently fall back to CPU even when ctx_id>=0.
    # onnxruntime-gpu is a drop-in replacement that enables CUDAExecutionProvider.
    if command -v nvidia-smi &>/dev/null && nvidia-smi --query-gpu=name --format=csv,noheader &>/dev/null 2>&1; then
        GPU_NAME=$(nvidia-smi --query-gpu=name --format=csv,noheader 2>/dev/null | head -1)
        info "NVIDIA GPU detected: ${GPU_NAME}"
        INSTALLED_ORT=$("${VENV}/bin/pip" show onnxruntime 2>/dev/null | grep -i "^Name:" | awk '{print $2}' || true)
        if [[ "$INSTALLED_ORT" == "onnxruntime" ]]; then
            info "Upgrading onnxruntime → onnxruntime-gpu for CUDA support"
            _pip_as_svc install -q --upgrade onnxruntime-gpu \
                && info "onnxruntime-gpu installed — CUDAExecutionProvider now available" \
                || warn "onnxruntime-gpu install failed — staying on CPU onnxruntime"
        elif [[ "$INSTALLED_ORT" == "onnxruntime-gpu" ]] || "${VENV}/bin/pip" show onnxruntime-gpu &>/dev/null 2>&1; then
            info "onnxruntime-gpu already installed"
        fi
    else
        info "No NVIDIA GPU detected — using CPU onnxruntime"
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
