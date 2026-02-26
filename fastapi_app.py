"""
fastapi_app.py — FastAPI backend for face recognition system.

Startup:
    uvicorn fastapi_app:app --reload --port 7865

Environment variables:
    FACE_REC_DATA_DIR   path to data directory (config.yaml, DB, thumbnails)
    FACE_REC_PORT       port to listen on (default: 7865)
    FACE_REC_DB_PATH    absolute path to SQLite DB (overrides config.yaml + DATA_DIR)
    FACE_REC_WORKERS    uvicorn worker count (default: 1)
    CRISP_ADMIN_USER    bootstrap admin username (first-run only)
    CRISP_ADMIN_PASS    bootstrap admin password (first-run only)
"""
import logging
import os
import sys

_DATA_DIR        = os.environ.get('FACE_REC_DATA_DIR', '')
_DB_PATH_OVERRIDE = os.environ.get('FACE_REC_DB_PATH', '')   # absolute path; overrides config.yaml
_THUMB_DIR       = os.path.join(_DATA_DIR, 'thumbnails') if _DATA_DIR else 'thumbnails'
_log_file  = os.path.join(_DATA_DIR, 'face_recognition.log') if _DATA_DIR else 'face_recognition.log'
_log_level_str = os.environ.get('FACE_REC_LOG_LEVEL', 'INFO').upper()
_log_level = getattr(logging, _log_level_str, logging.INFO)

logging.basicConfig(
    level=_log_level,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
    handlers=[
        logging.FileHandler(_log_file),
        logging.StreamHandler(),
    ],
    force=True,
)
logger = logging.getLogger(__name__)

from datetime import datetime
from pathlib import Path
from typing import Optional

import yaml
from fastapi import Depends, FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from face_recognition_core import FaceRecognitionEngine, FaceRecognitionConfig
from permissions import PermissionManager
from api_key_manager import ApiKeyManager
from vlm_providers import create_vlm_provider, VLMConfig
from i18n import i18n

# ─── FastAPI app ──────────────────────────────────────────────────────────────

app = FastAPI(title="CrispLens API", version="2.0.0")

# CORS origins — configurable via CRISP_ALLOWED_ORIGINS (comma-separated list).
# On HTTPS deployments (CRISP_HTTPS_COOKIES=1) a wildcard is a CSRF risk because
# SameSite=none is used.  We therefore restrict to localhost by default on HTTPS.
# On plain HTTP the SameSite=lax cookie flag already blocks cross-site fetch/XHR.
_HTTPS_MODE   = os.environ.get('CRISP_HTTPS_COOKIES', '0').strip() == '1'
_EXTRA_ORIGINS = [
    o.strip()
    for o in os.environ.get('CRISP_ALLOWED_ORIGINS', '').split(',')
    if o.strip()
]
_LOCALHOST_ORIGINS = [
    'http://localhost:7865', 'http://127.0.0.1:7865',
    'http://localhost:5173', 'http://127.0.0.1:5173',
    'http://localhost:7861', 'http://127.0.0.1:7861',
]
_ALLOWED_ORIGINS = list(dict.fromkeys(_LOCALHOST_ORIGINS + _EXTRA_ORIGINS))

if _HTTPS_MODE:
    # On HTTPS: only specific origins — reflect-all with credentials is a CSRF risk
    app.add_middleware(
        CORSMiddleware,
        allow_origins=_ALLOWED_ORIGINS,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )
else:
    # On HTTP (local/Electron desktop): reflect all origins; SameSite=lax blocks CSRF
    app.add_middleware(
        CORSMiddleware,
        allow_origin_regex=r".*",
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

# ─── Auth middleware — all /api/* routes require a valid session ───────────────
# Exemptions: login, logout, health check, i18n strings (needed before login)
_PUBLIC_API_PATHS: set = {
    '/api/auth/login',
    '/api/auth/logout',
    '/api/health',
    '/api/settings/i18n',
}

from starlette.responses import JSONResponse as _JSONResponse

@app.middleware("http")
async def require_auth_middleware(request, call_next):
    path = request.url.path
    # Static Svelte assets and non-API paths are always allowed
    if not path.startswith('/api/'):
        return await call_next(request)
    # CORS preflight — OPTIONS never carry cookies; let CORSMiddleware handle them
    if request.method == 'OPTIONS':
        return await call_next(request)
    # Public API endpoints
    if path in _PUBLIC_API_PATHS:
        return await call_next(request)
    # All other /api/* paths require a valid, non-expired session
    session_token = request.cookies.get('session')
    if session_token:
        # Lazy import to avoid circular import at module load time
        try:
            from routers.auth import _get_session_user
            if _get_session_user(session_token) is not None:
                return await call_next(request)
        except Exception:
            pass
    return _JSONResponse({'detail': 'Authentication required'}, status_code=401)

# ─── Shared application state ─────────────────────────────────────────────────

class AppState:
    engine: Optional[FaceRecognitionEngine] = None
    permissions: Optional[PermissionManager] = None
    api_key_manager: Optional[ApiKeyManager] = None
    _vlm_provider = None
    config: dict = {}
    db_path: str = ''
    thumb_dir: str = _THUMB_DIR
    initialized: bool = False

    @property
    def vlm_provider(self):
        """Lazy-load the VLM provider on first access."""
        if self._vlm_provider is not None:
            return self._vlm_provider
        
        vlm_config = self.config.get('vlm', {})
        if vlm_config.get('enabled', False):
            provider = vlm_config.get('provider', 'anthropic')
            model    = vlm_config.get('model') or None
            api_key  = self.api_key_manager.get_effective_key(provider, None)
            if not api_key:
                api_key = vlm_config.get('api', {}).get('key') or None
            endpoint = vlm_config.get('api', {}).get('endpoint') or None
            
            logger.info(f"Lazy-initializing VLM provider: {provider}")
            self._vlm_provider = create_vlm_provider(
                provider=provider, api_key=api_key,
                endpoint=endpoint, model=model, config=VLMConfig(),
            )
            return self._vlm_provider
        return None

    @vlm_provider.setter
    def vlm_provider(self, value):
        self._vlm_provider = value

state = AppState()


# ─── Admin bootstrap helper ───────────────────────────────────────────────────

def _bootstrap_admin(pm: 'PermissionManager', username: str, password: str) -> None:
    """Create an admin user if no admin account exists yet.

    Called on startup when CRISP_ADMIN_USER / CRISP_ADMIN_PASS env vars are set.
    Safe to call on every startup — silently skips if any admin already exists.
    """
    try:
        import sqlite3 as _sqlite3
        conn = _sqlite3.connect(pm.db_path)
        try:
            row = conn.execute(
                "SELECT id FROM users WHERE role='admin' LIMIT 1"
            ).fetchone()
        finally:
            conn.close()

        if row:
            logger.info("Admin bootstrap: admin account already exists, skipping.")
            return

        success, msg, _ = pm.create_user(username, password, role='admin', allowed_folders=[])
        if success:
            logger.info(f"Admin bootstrap: created admin account '{username}'.")
        else:
            logger.warning(f"Admin bootstrap: create_user failed — {msg}")
    except Exception as exc:
        logger.warning(f"Admin bootstrap failed: {exc}")


@app.on_event("startup")
def startup():
    config_path = os.path.join(_DATA_DIR, 'config.yaml') if _DATA_DIR else 'config.yaml'

    if Path(config_path).exists():
        with open(config_path, 'r') as f:
            config_dict = yaml.safe_load(f) or {}
        logger.info(f"Loaded configuration from {config_path}")
    else:
        config_dict = {}
        logger.warning(f"config.yaml not found at {config_path}, using defaults")

    # Language
    language = config_dict.get('ui', {}).get('language', 'de')
    i18n.set_language(language)

    # DB path — env var wins over config.yaml
    if _DB_PATH_OVERRIDE:
        db_path = _DB_PATH_OVERRIDE
        logger.info(f"Using DB path from FACE_REC_DB_PATH: {db_path}")
    else:
        _default_db = os.path.join(_DATA_DIR, 'face_recognition.db') if _DATA_DIR else 'face_recognition.db'
        db_path = config_dict.get('database', {}).get('path', _default_db)
        if _DATA_DIR and not os.path.isabs(db_path):
            db_path = os.path.join(_DATA_DIR, db_path)
    state.db_path = db_path

    # Thumbnail directory
    state.thumb_dir = _THUMB_DIR

    face_config = FaceRecognitionConfig(config_dict.get('face_recognition', {}))
    # lazy_init=True (set in config): engine object created instantly (DB + FAISS only).
    # The heavy InsightFace model is loaded in the background thread below.
    state.engine = FaceRecognitionEngine(db_path, face_config)
    logger.info("Face recognition engine initialized (model load pending)")

    # ── DB migrations (idempotent — safe to run on every startup) ────────────
    import sqlite3 as _sqlite3
    _mig_conn = _sqlite3.connect(db_path)
    try:
        for _sql in [
            # v2 hybrid columns
            'ALTER TABLE images ADD COLUMN local_path TEXT',
            'CREATE INDEX IF NOT EXISTS idx_images_local_path ON images(local_path)',
            # rating / flag / description UI columns
            'ALTER TABLE images ADD COLUMN rating INTEGER DEFAULT 0',
            'ALTER TABLE images ADD COLUMN flag TEXT',
            'ALTER TABLE images ADD COLUMN description TEXT',
            # pHash for duplicate detection
            'ALTER TABLE images ADD COLUMN phash TEXT',
            'CREATE INDEX IF NOT EXISTS idx_images_phash ON images(phash)',
            # face quality score (used by identify view)
            'ALTER TABLE faces ADD COLUMN face_quality REAL',
            # ── Security v2: image ownership + sharing ────────────────────────
            'ALTER TABLE images ADD COLUMN owner_id INTEGER REFERENCES users(id) ON DELETE SET NULL',
            'ALTER TABLE images ADD COLUMN visibility TEXT DEFAULT \'shared\'',
            'CREATE INDEX IF NOT EXISTS idx_images_owner ON images(owner_id)',
            'CREATE INDEX IF NOT EXISTS idx_images_visibility ON images(visibility)',
            # Per-image explicit sharing
            '''CREATE TABLE IF NOT EXISTS image_shares (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                image_id INTEGER NOT NULL,
                user_id INTEGER NOT NULL,
                shared_by INTEGER NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(image_id, user_id),
                FOREIGN KEY (image_id) REFERENCES images(id) ON DELETE CASCADE,
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
                FOREIGN KEY (shared_by) REFERENCES users(id) ON DELETE CASCADE
            )''',
            # Per-album explicit sharing
            '''CREATE TABLE IF NOT EXISTS album_shares (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                album_id INTEGER NOT NULL,
                user_id INTEGER NOT NULL,
                shared_by INTEGER NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(album_id, user_id),
                FOREIGN KEY (album_id) REFERENCES albums(id) ON DELETE CASCADE,
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
                FOREIGN KEY (shared_by) REFERENCES users(id) ON DELETE CASCADE
            )''',
            # Per-user VLM overrides (NULL = use global default from config.yaml)
            'ALTER TABLE users ADD COLUMN vlm_enabled INTEGER',
            'ALTER TABLE users ADD COLUMN vlm_provider TEXT',
            'ALTER TABLE users ADD COLUMN vlm_model TEXT',
            # Per-user detection model override (NULL = use global default from config.yaml)
            'ALTER TABLE users ADD COLUMN det_model TEXT',
            # Cloud / network drive configurations
            '''CREATE TABLE IF NOT EXISTS cloud_drives (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                type TEXT NOT NULL,
                config_encrypted TEXT NOT NULL DEFAULT '',
                mount_point TEXT,
                scope TEXT NOT NULL DEFAULT 'system',
                owner_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
                allowed_roles TEXT NOT NULL DEFAULT '["admin","medienverwalter"]',
                auto_mount INTEGER NOT NULL DEFAULT 0,
                enabled INTEGER NOT NULL DEFAULT 1,
                is_mounted INTEGER NOT NULL DEFAULT 0,
                last_error TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )''',
        ]:
            try:
                _mig_conn.execute(_sql)
            except _sqlite3.OperationalError:
                pass  # column / index already exists — silently skip
        _mig_conn.commit()

        # ── Schema migration: fix file_hash uniqueness (idempotent) ──────────
        # Old schema had `file_hash TEXT UNIQUE` which prevented different users
        # from storing their own copy of identical content with the hash intact.
        # New schema: plain `file_hash TEXT` + composite partial unique index
        # UNIQUE(file_hash, owner_id) WHERE file_hash IS NOT NULL, which allows
        # different users to each have a row for the same content (with the hash
        # stored), while still preventing same-user hash duplicates at DB level.
        _has_composite_idx = _mig_conn.execute(
            "SELECT name FROM sqlite_master WHERE type='index' "
            "AND name='idx_images_file_hash_owner'"
        ).fetchone()
        if not _has_composite_idx:
            _has_images = _mig_conn.execute(
                "SELECT name FROM sqlite_master WHERE type='table' AND name='images'"
            ).fetchone()
            if _has_images:
                try:
                    # Get actual column list in DB order (includes ALTERed columns)
                    _cols = [r[1] for r in _mig_conn.execute(
                        "PRAGMA table_info(images)"
                    ).fetchall()]
                    _cols_sql = ', '.join(_cols)
                    # Recreate table without the column-level UNIQUE on file_hash
                    _mig_conn.executescript(f"""
                        PRAGMA foreign_keys = OFF;
                        BEGIN;
                        CREATE TABLE images_fix (
                            id               INTEGER PRIMARY KEY AUTOINCREMENT,
                            filepath         TEXT NOT NULL UNIQUE,
                            filename         TEXT NOT NULL,
                            file_hash        TEXT,
                            file_size        INTEGER,
                            width            INTEGER,
                            height           INTEGER,
                            format           TEXT,
                            local_path       TEXT,
                            image_blob       BLOB,
                            thumbnail_blob   BLOB,
                            taken_at         TIMESTAMP,
                            location_lat     REAL,
                            location_lng     REAL,
                            location_name    TEXT,
                            camera_make      TEXT,
                            camera_model     TEXT,
                            iso              INTEGER,
                            aperture         REAL,
                            shutter_speed    TEXT,
                            focal_length     REAL,
                            ai_description   TEXT,
                            ai_scene_type    TEXT,
                            ai_tags          TEXT,
                            ai_confidence    REAL,
                            ai_provider      TEXT,
                            processed        INTEGER DEFAULT 0,
                            processing_error TEXT,
                            face_count       INTEGER DEFAULT 0,
                            metadata_written INTEGER DEFAULT 0,
                            rating           INTEGER DEFAULT 0,
                            flag             TEXT,
                            description      TEXT,
                            phash            TEXT,
                            owner_id         INTEGER REFERENCES users(id) ON DELETE SET NULL,
                            visibility       TEXT DEFAULT 'shared',
                            created_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                            updated_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                            processed_at     TIMESTAMP
                        );
                        INSERT INTO images_fix ({_cols_sql})
                            SELECT {_cols_sql} FROM images;
                        DROP TABLE images;
                        ALTER TABLE images_fix RENAME TO images;
                        CREATE INDEX IF NOT EXISTS idx_images_processed   ON images(processed);
                        CREATE INDEX IF NOT EXISTS idx_images_filename    ON images(filename);
                        CREATE UNIQUE INDEX IF NOT EXISTS idx_images_filepath ON images(filepath);
                        CREATE INDEX IF NOT EXISTS idx_images_file_hash   ON images(file_hash);
                        CREATE INDEX IF NOT EXISTS idx_images_local_path  ON images(local_path);
                        CREATE INDEX IF NOT EXISTS idx_images_taken_at    ON images(taken_at);
                        CREATE INDEX IF NOT EXISTS idx_images_face_count  ON images(face_count DESC);
                        CREATE INDEX IF NOT EXISTS idx_images_scene_type  ON images(ai_scene_type);
                        CREATE INDEX IF NOT EXISTS idx_images_created     ON images(created_at DESC);
                        CREATE INDEX IF NOT EXISTS idx_images_phash       ON images(phash);
                        CREATE INDEX IF NOT EXISTS idx_images_description ON images(ai_description);
                        CREATE INDEX IF NOT EXISTS idx_images_tags        ON images(ai_tags);
                        CREATE INDEX IF NOT EXISTS idx_images_owner       ON images(owner_id);
                        CREATE INDEX IF NOT EXISTS idx_images_visibility  ON images(visibility);
                        CREATE UNIQUE INDEX idx_images_file_hash_owner
                            ON images(file_hash, owner_id)
                            WHERE file_hash IS NOT NULL;
                        COMMIT;
                        PRAGMA foreign_keys = ON;
                    """)
                    logger.info("Schema migration: removed file_hash UNIQUE constraint, "
                                "added composite partial index (file_hash, owner_id)")
                except Exception as _mig_err:
                    logger.error(f"file_hash schema migration failed: {_mig_err}")
                    try:
                        _mig_conn.execute("ROLLBACK")
                    except Exception:
                        pass
    finally:
        _mig_conn.close()

    state.permissions = PermissionManager(db_path)
    logger.info("Permission manager initialized")

    # Bootstrap admin account from env vars (first-run wizard)
    _admin_user = os.environ.get('CRISP_ADMIN_USER', '').strip()
    _admin_pass = os.environ.get('CRISP_ADMIN_PASS', '').strip()
    if _admin_user and _admin_pass:
        _bootstrap_admin(state.permissions, _admin_user, _admin_pass)

    state.api_key_manager = ApiKeyManager(db_path)
    logger.info("API key manager initialized")

    state.config = config_dict
    state.initialized = True
    logger.info("FastAPI app ready")

    # Warm up the model in the background so it's ready when the user first needs it.
    import threading
    def _warm_model():
        try:
            logger.info("Background model warm-up starting…")
            state.engine._ensure_backend()
            logger.info("Background model warm-up complete — face recognition ready")
        except Exception as e:
            logger.error(f"Background model warm-up failed: {e}")
    threading.Thread(target=_warm_model, daemon=True, name="model-warmup").start()

    # Start background watch-folder scanner (time-based polling, no extra deps)
    _start_background_scanner()


# ─── Background watch-folder scanner ─────────────────────────────────────────

def _start_background_scanner():
    import threading
    import time
    from datetime import timedelta

    def _run_auto_scans():
        if not state.initialized:
            return
        from routers.watchfolders import ensure_table, get_new_image_paths, update_scan_stats, count_images
        import sqlite3 as _sqlite3
        ensure_table(state.db_path)
        conn = _sqlite3.connect(state.db_path, timeout=10.0)
        conn.row_factory = _sqlite3.Row
        try:
            rows = conn.execute(
                "SELECT * FROM watch_folders WHERE auto_scan=1"
            ).fetchall()
        finally:
            conn.close()

        now = datetime.utcnow()
        for row in rows:
            folder = dict(row)
            last_scanned = folder.get('last_scanned_at')
            interval_hours = folder.get('scan_interval_hours', 24.0)
            if last_scanned:
                try:
                    last_dt = datetime.fromisoformat(last_scanned)
                    if now < last_dt + timedelta(hours=interval_hours):
                        continue
                except Exception:
                    pass  # unparseable — scan anyway

            logger.info(f"Auto-scan starting: {folder['path']}")
            new_paths = get_new_image_paths(state.db_path, folder['path'], bool(folder['recursive']))
            all_found = count_images(folder['path'], bool(folder['recursive']))
            added = 0
            for path in new_paths:
                try:
                    state.engine.process_image(path, state.vlm_provider)
                    added += 1
                except Exception as e:
                    logger.error(f"Auto-scan process error {path}: {e}")
            update_scan_stats(state.db_path, folder['id'], all_found, added)
            logger.info(f"Auto-scan done: {folder['path']} — {added} new images added")

    def scanner_loop():
        time.sleep(30)  # initial delay to let startup finish
        while True:
            try:
                _run_auto_scans()
            except Exception as e:
                logger.error(f"Background scanner error: {e}")
            time.sleep(60)  # check every minute

    t = threading.Thread(target=scanner_loop, daemon=True, name="watch-folder-scanner")
    t.start()
    logger.info("Background watch-folder scanner thread started")


# ─── Include routers ──────────────────────────────────────────────────────────

from routers import images, people, search, processing, auth, settings, api_keys, filesystem, watchfolders, duplicates, albums, face_cluster, editing, ingest, users, cloud_drives, bfl_edit

app.include_router(images.router,       prefix="/api/images",        tags=["images"])
app.include_router(users.router,        prefix="/api/users",         tags=["users"])
app.include_router(people.router,       prefix="/api/people",        tags=["people"])
app.include_router(search.router,       prefix="/api/search",        tags=["search"])
app.include_router(processing.router,   prefix="/api/process",       tags=["processing"])
app.include_router(auth.router,         prefix="/api/auth",          tags=["auth"])
app.include_router(settings.router,     prefix="/api/settings",      tags=["settings"])
app.include_router(api_keys.router,     prefix="/api/api-keys",      tags=["api-keys"])
app.include_router(filesystem.router,   prefix="/api/filesystem",    tags=["filesystem"])
app.include_router(watchfolders.router, prefix="/api/watchfolders",  tags=["watchfolders"])
app.include_router(duplicates.router,   prefix="/api/duplicates",    tags=["duplicates"])
app.include_router(albums.router,       prefix="/api/albums",        tags=["albums"])
app.include_router(face_cluster.router, prefix="/api/faces",         tags=["face-clusters"])
app.include_router(editing.router,      prefix="/api/edit",          tags=["editing"])
app.include_router(ingest.router,       prefix="/api/ingest",        tags=["ingest"])
app.include_router(cloud_drives.router, prefix="/api/cloud-drives",  tags=["cloud-drives"])
app.include_router(bfl_edit.router,    prefix="/api/bfl",            tags=["bfl"])

# ─── Tags & stats convenience routes ─────────────────────────────────────────

from fastapi.responses import JSONResponse
from image_ops import get_all_tags, get_all_scene_types, SCENE_TYPES
from routers.deps import get_current_user

@app.get("/api/health")
def health():
    """Lightweight liveness probe — always 200, no auth required."""
    return {
        "ok": True,
        "model_ready": state.engine._backend_ready if state.engine else False,
    }


@app.get("/api/settings/i18n")
def get_translations():
    from i18n import TRANSLATIONS, i18n
    lang = i18n.get_language()
    return {
        "lang": lang,
        "translations": TRANSLATIONS.get(lang, TRANSLATIONS['en'])
    }


@app.get("/api/tags")
def list_tags():
    return get_all_tags(state.db_path)

@app.get("/api/tags/stats")
def list_tags_stats():
    import sqlite3
    conn = sqlite3.connect(state.db_path)
    conn.row_factory = sqlite3.Row
    rows = conn.execute("""
        SELECT t.name, COUNT(it.image_id) as count
        FROM tags t
        JOIN image_tags it ON t.id = it.tag_id
        GROUP BY t.id
        ORDER BY count DESC
    """).fetchall()
    conn.close()
    return [dict(r) for r in rows]


@app.get("/api/scene-types")
def list_scene_types():
    return SCENE_TYPES

@app.get("/api/scenes")
def list_scenes_used():
    return get_all_scene_types(state.db_path)

@app.get("/api/stats")
def get_stats():
    if not state.initialized:
        return JSONResponse({"error": "not initialized"}, status_code=503)
    return state.engine.get_statistics()

@app.get("/api/dates/stats")
def list_dates_stats():
    import sqlite3
    conn = sqlite3.connect(state.db_path)
    conn.row_factory = sqlite3.Row
    # Extract YYYY-MM from taken_at or created_at
    rows = conn.execute("""
        SELECT 
            strftime('%Y-%m', COALESCE(taken_at, created_at)) as month,
            COUNT(*) as count
        FROM images
        WHERE processed = 1
        GROUP BY month
        ORDER BY month DESC
    """).fetchall()
    conn.close()
    return [dict(r) for r in rows]


@app.get("/api/folders/stats")
def list_folders_stats(user=Depends(get_current_user)):
    import sqlite3
    from pathlib import Path
    from routers.deps import can_access_image
    conn = sqlite3.connect(state.db_path)
    conn.row_factory = sqlite3.Row
    if user.role == 'admin':
        rows = conn.execute(
            "SELECT id, filepath, local_path FROM images WHERE processed = 1"
        ).fetchall()
    else:
        uid = user.id
        rows = conn.execute("""
            SELECT id, filepath, local_path FROM images
            WHERE processed = 1
              AND (visibility = 'shared' OR visibility IS NULL
                   OR owner_id = ?
                   OR EXISTS (SELECT 1 FROM image_shares s WHERE s.image_id = images.id AND s.user_id = ?))
        """, (uid, uid)).fetchall()
    conn.close()

    folders = {}
    for r in rows:
        # Prefer local_path (original source location) so folders reflect the
        # user's own directory structure, not VPS upload paths.
        src = r['local_path'] or r['filepath']
        dir_path = str(Path(src).parent)
        if dir_path == '.':
            # bare filename — try server filepath for a real directory
            dir_path = str(Path(r['filepath']).parent)
        if dir_path == '.':
            dir_path = '(Uploaded)'
        folders[dir_path] = folders.get(dir_path, 0) + 1

    # Sort: named paths first (alphabetically), then "(Uploaded)" last
    def _sort_key(item):
        k = item[0]
        return (k == '(Uploaded)', k.lower())

    return [{"name": k, "count": v} for k, v in sorted(folders.items(), key=_sort_key)]


# ─── Event grouping ───────────────────────────────────────────────────────────

_events_cache: dict = {}   # (gap_hours, max_image_id) → list

@app.get("/api/events")
def get_events(gap_hours: float = 4.0, limit: int = 200):
    """
    Group images into events by time gap.
    gap_hours: treat images more than N hours apart as separate events (0.1 – 144).
    limit: max number of events to return.
    """
    import sqlite3 as _sqlite3
    from datetime import datetime as _dt

    gap_hours = max(0.1, min(144.0, gap_hours))
    gap_secs  = gap_hours * 3600

    # Cache key: round gap to 2 dp + current max image id to detect new images
    conn = _sqlite3.connect(state.db_path)
    conn.row_factory = _sqlite3.Row
    max_id_row = conn.execute("SELECT MAX(id) as mx FROM images WHERE processed=1").fetchone()
    max_id = max_id_row['mx'] if max_id_row else 0
    cache_key = (round(gap_hours, 2), max_id)

    if cache_key in _events_cache:
        events = _events_cache[cache_key]
    else:
        rows = conn.execute("""
            SELECT id, filepath, filename, taken_at, created_at, face_count, ai_description
            FROM images
            WHERE processed=1 AND COALESCE(taken_at, created_at) IS NOT NULL
            ORDER BY COALESCE(taken_at, created_at) ASC
        """).fetchall()
        conn.close()

        events = []
        current_event = None

        for row in rows:
            d = dict(row)
            ts_str = d.get('taken_at') or d.get('created_at')
            try:
                # Handle both ISO format with and without timezone suffix
                ts_str_clean = ts_str.replace('Z', '+00:00') if ts_str else None
                ts = _dt.fromisoformat(ts_str_clean).timestamp() if ts_str_clean else None
            except Exception:
                ts = None

            if ts is None:
                continue

            if current_event is None or (ts - current_event['_last_ts']) > gap_secs:
                current_event = {
                    'event_id':     len(events),
                    'start':        ts_str,
                    'end':          ts_str,
                    '_last_ts':     ts,
                    '_start_ts':    ts,
                    'count':        0,
                    'cover_image_id': d['id'],
                    'images':       [],
                }
                events.append(current_event)

            current_event['end']      = ts_str
            current_event['_last_ts'] = ts
            current_event['count']   += 1
            if len(current_event['images']) < 12:
                current_event['images'].append({
                    'id':       d['id'],
                    'filename': d['filename'],
                    'face_count': d['face_count'],
                })
            # Prefer image with most faces as cover
            if (d['face_count'] or 0) > 0 and current_event['cover_image_id'] == d['id'] - 1:
                current_event['cover_image_id'] = d['id']

        # Strip internal fields
        for ev in events:
            ev.pop('_last_ts', None)
            ev.pop('_start_ts', None)

        _events_cache[cache_key] = events

    return events[:limit]

# ─── Serve Svelte static build in production ─────────────────────────────────
# In packaged app:  extraResources puts renderer/dist at {resources}/app/renderer/dist
#                   → __file__ is {resources}/app/fastapi_app.py
# In dev (npm start or uvicorn direct): renderer/dist lives inside electron-app-v2/
_svelte_dist = Path(__file__).parent / "renderer" / "dist"          # packaged
if not _svelte_dist.exists():
    _svelte_dist = Path(__file__).parent / "electron-app-v2" / "renderer" / "dist"  # dev
if _svelte_dist.exists():
    app.mount("/", StaticFiles(directory=str(_svelte_dist), html=True), name="static")

# ─── Entry point ─────────────────────────────────────────────────────────────

if __name__ == "__main__":
    import uvicorn
    port = int(os.environ.get('FACE_REC_PORT', 7865))
    uvicorn.run("fastapi_app:app", host="127.0.0.1", port=port, reload=False)
