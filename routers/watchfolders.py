"""
routers/watchfolders.py — Watch folder CRUD and manual/scheduled scan via SSE.
"""
import json
import logging
import sqlite3
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from routers.deps import require_admin_or_mediamanager

logger = logging.getLogger(__name__)
router = APIRouter()

IMAGE_EXTENSIONS = {'.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp', '.tiff', '.tif', '.pgm'}


def _state():
    from fastapi_app import state
    return state


def _connect(db_path: str):
    conn = sqlite3.connect(db_path, timeout=10.0)
    conn.execute("PRAGMA journal_mode = WAL")
    conn.row_factory = sqlite3.Row
    return conn


def ensure_table(db_path: str):
    """Create watch_folders table if it doesn't exist."""
    conn = None
    try:
        conn = _connect(db_path)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS watch_folders (
                id                   INTEGER PRIMARY KEY AUTOINCREMENT,
                path                 TEXT    NOT NULL UNIQUE,
                recursive            INTEGER DEFAULT 1,
                auto_scan            INTEGER DEFAULT 0,
                scan_interval_hours  REAL    DEFAULT 24.0,
                last_scanned_at      TEXT,
                files_found          INTEGER DEFAULT 0,
                files_added          INTEGER DEFAULT 0,
                created_at           TEXT    DEFAULT CURRENT_TIMESTAMP
            )
        """)
        conn.commit()
    finally:
        if conn:
            conn.close()


def count_images(folder_path: str, recursive: bool) -> int:
    base = Path(folder_path)
    if not base.exists():
        return 0
    pattern = '**/*' if recursive else '*'
    return sum(
        1 for p in base.glob(pattern)
        if p.is_file() and p.suffix.lower() in IMAGE_EXTENSIONS
    )


def get_new_image_paths(db_path: str, folder_path: str, recursive: bool) -> List[str]:
    """Return image paths in folder that are not yet processed in the DB."""
    base = Path(folder_path)
    if not base.exists():
        return []
    pattern = '**/*' if recursive else '*'
    all_paths = [
        str(p) for p in base.glob(pattern)
        if p.is_file() and p.suffix.lower() in IMAGE_EXTENSIONS
    ]
    if not all_paths:
        return []
    conn = None
    try:
        conn = _connect(db_path)
        placeholders = ','.join('?' * len(all_paths))
        already_done = set(
            row[0] for row in conn.execute(
                f"SELECT filepath FROM images WHERE filepath IN ({placeholders}) AND processed=1",
                all_paths
            ).fetchall()
        )
        return [p for p in all_paths if p not in already_done]
    finally:
        if conn:
            conn.close()


def update_scan_stats(db_path: str, folder_id: int, files_found: int, files_added: int):
    conn = None
    try:
        conn = _connect(db_path)
        conn.execute("""
            UPDATE watch_folders
            SET last_scanned_at = ?,
                files_found     = ?,
                files_added     = files_added + ?
            WHERE id = ?
        """, (datetime.utcnow().isoformat(), files_found, files_added, folder_id))
        conn.commit()
    except Exception as e:
        logger.error(f"update_scan_stats: {e}")
    finally:
        if conn:
            conn.close()


# ── Pydantic models ───────────────────────────────────────────────────────────

class WatchFolderCreate(BaseModel):
    path:                str
    recursive:           bool  = True
    auto_scan:           bool  = False
    scan_interval_hours: float = 24.0

class WatchFolderUpdate(BaseModel):
    recursive:           Optional[bool]  = None
    auto_scan:           Optional[bool]  = None
    scan_interval_hours: Optional[float] = None


# ── Routes ────────────────────────────────────────────────────────────────────

@router.get("")
def list_watch_folders() -> List[Dict[str, Any]]:
    s = _state()
    ensure_table(s.db_path)
    conn = None
    try:
        conn = _connect(s.db_path)
        rows = conn.execute(
            "SELECT * FROM watch_folders ORDER BY created_at DESC"
        ).fetchall()
        return [dict(r) for r in rows]
    finally:
        if conn:
            conn.close()


@router.post("")
def add_watch_folder(body: WatchFolderCreate, _=Depends(require_admin_or_mediamanager)):
    s = _state()
    ensure_table(s.db_path)
    resolved = str(Path(body.path).resolve())
    if not Path(resolved).exists():
        raise HTTPException(status_code=404, detail=f"Path not found: {body.path}")
    if not Path(resolved).is_dir():
        raise HTTPException(status_code=400, detail=f"Not a directory: {body.path}")
    conn = None
    try:
        conn = _connect(s.db_path)
        conn.execute("""
            INSERT INTO watch_folders (path, recursive, auto_scan, scan_interval_hours)
            VALUES (?, ?, ?, ?)
        """, (resolved, int(body.recursive), int(body.auto_scan), body.scan_interval_hours))
        conn.commit()
        row = conn.execute(
            "SELECT * FROM watch_folders WHERE path=?", (resolved,)
        ).fetchone()
        return dict(row)
    except sqlite3.IntegrityError:
        raise HTTPException(status_code=409, detail="Folder is already being watched")
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        if conn:
            conn.close()


@router.put("/{folder_id}")
def update_watch_folder(folder_id: int, body: WatchFolderUpdate, _=Depends(require_admin_or_mediamanager)):
    s = _state()
    ensure_table(s.db_path)
    conn = None
    try:
        conn = _connect(s.db_path)
        if conn.execute(
            "SELECT id FROM watch_folders WHERE id=?", (folder_id,)
        ).fetchone() is None:
            raise HTTPException(status_code=404, detail="Watch folder not found")
        sets, params = [], []
        if body.recursive is not None:
            sets.append("recursive=?");           params.append(int(body.recursive))
        if body.auto_scan is not None:
            sets.append("auto_scan=?");           params.append(int(body.auto_scan))
        if body.scan_interval_hours is not None:
            sets.append("scan_interval_hours=?"); params.append(body.scan_interval_hours)
        if sets:
            params.append(folder_id)
            conn.execute(f"UPDATE watch_folders SET {', '.join(sets)} WHERE id=?", params)  # nosec B608 — sets contains only hardcoded column=? literals, never user input
            conn.commit()
        row = conn.execute(
            "SELECT * FROM watch_folders WHERE id=?", (folder_id,)
        ).fetchone()
        return dict(row)
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        if conn:
            conn.close()


@router.delete("/{folder_id}")
def delete_watch_folder(folder_id: int, _=Depends(require_admin_or_mediamanager)):
    s = _state()
    ensure_table(s.db_path)
    conn = None
    try:
        conn = _connect(s.db_path)
        if conn.execute(
            "SELECT id FROM watch_folders WHERE id=?", (folder_id,)
        ).fetchone() is None:
            raise HTTPException(status_code=404, detail="Watch folder not found")
        conn.execute("DELETE FROM watch_folders WHERE id=?", (folder_id,))
        conn.commit()
        return {"ok": True}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        if conn:
            conn.close()


@router.post("/{folder_id}/scan")
async def scan_watch_folder(folder_id: int, _=Depends(require_admin_or_mediamanager)):
    """
    SSE stream: find new image files in the watch folder that are not yet in
    the DB, run them through the full recognition + VLM pipeline, and update
    the scan statistics.
    """
    s = _state()
    ensure_table(s.db_path)

    conn = None
    try:
        conn = _connect(s.db_path)
        row = conn.execute(
            "SELECT * FROM watch_folders WHERE id=?", (folder_id,)
        ).fetchone()
        if row is None:
            raise HTTPException(status_code=404, detail="Watch folder not found")
        folder_data = dict(row)
    except HTTPException:
        raise
    finally:
        if conn:
            conn.close()

    new_paths  = get_new_image_paths(s.db_path, folder_data['path'], bool(folder_data['recursive']))
    all_found  = count_images(folder_data['path'], bool(folder_data['recursive']))
    total      = len(new_paths)

    async def event_stream():
        yield f"data: {json.dumps({'total': total, 'all_found': all_found, 'started': True})}\n\n"
        added = 0
        errors = 0
        for i, path in enumerate(new_paths):
            try:
                result = s.engine.process_image(path, s.vlm_provider)
                added += 1
                # Set origin_path = server_path for watch-folder scanned files
                image_id = result.get('image_id') if isinstance(result, dict) else None
                if image_id:
                    try:
                        conn_lp = _connect(s.db_path)
                        conn_lp.execute(
                            'UPDATE images SET local_path = filepath WHERE id = ? AND local_path IS NULL',
                            (image_id,),
                        )
                        conn_lp.commit()
                        conn_lp.close()
                    except Exception as e_lp:
                        logger.warning(f"watchfolder: could not set local_path for {path}: {e_lp}")
                payload = {
                    'index':  i + 1,
                    'total':  total,
                    'path':   path,
                    'result': {'faces_detected': result.get('face_count', 0)},
                }
            except Exception as e:
                errors += 1
                logger.error(f"scan_watch_folder error {path}: {e}")
                payload = {
                    'index': i + 1,
                    'total': total,
                    'path':  path,
                    'error': str(e),
                }
            yield f"data: {json.dumps(payload)}\n\n"

        update_scan_stats(s.db_path, folder_id, all_found, added)
        yield f"data: {json.dumps({'done': True, 'total': total, 'added': added, 'errors': errors})}\n\n"

    return StreamingResponse(event_stream(), media_type="text/event-stream")
