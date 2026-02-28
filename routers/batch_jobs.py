"""
routers/batch_jobs.py — Persistent server-side batch image processing jobs.

Folder-mode (server path scan) creates a persistent job in SQLite that is
processed by a background daemon thread, survives browser disconnects, and can
be cancelled or resumed.

Endpoints:
  POST   /api/batch-jobs              — create job; enumerate folder files
  GET    /api/batch-jobs              — list (admin: all; user: own)
  GET    /api/batch-jobs/{id}         — single job detail
  DELETE /api/batch-jobs/{id}         — delete job + files (own or admin, not while running)
  POST   /api/batch-jobs/{id}/start   — start/resume → SSE polling stream
  POST   /api/batch-jobs/{id}/cancel  — cancel running job
  GET    /api/batch-jobs/{id}/logs    — paginated error/skip log
"""
import json
import logging
import os
import sqlite3
import threading
import time
from datetime import datetime
from typing import Dict, List, Optional

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, UploadFile
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from routers.deps import get_current_user

logger = logging.getLogger(__name__)
router = APIRouter()

IMAGE_EXTENSIONS = {'.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp', '.tiff', '.tif', '.pgm'}

# Global cancel events keyed by job_id
_cancel_events: Dict[int, threading.Event] = {}
_cancel_events_lock = threading.Lock()


# ── Helpers ───────────────────────────────────────────────────────────────────

def _state():
    from fastapi_app import state
    return state


def _connect(db_path: str):
    conn = sqlite3.connect(db_path, timeout=15.0)
    conn.row_factory = sqlite3.Row
    conn.execute('PRAGMA journal_mode=WAL')
    conn.execute('PRAGMA foreign_keys=ON')
    return conn


def _job_row_to_dict(row) -> dict:
    d = dict(row)
    for key in ('tag_ids', 'new_tag_names'):
        if d.get(key):
            try:
                d[key] = json.loads(d[key])
            except Exception:
                d[key] = []
        else:
            d[key] = []
    return d


def _enum_image_files(folder: str, recursive: bool, follow_symlinks: bool) -> List[str]:
    paths = []
    if recursive:
        for root, dirs, files in os.walk(folder, followlinks=follow_symlinks):
            for fn in files:
                if os.path.splitext(fn)[1].lower() in IMAGE_EXTENSIONS:
                    paths.append(os.path.join(root, fn))
    else:
        try:
            for fn in os.listdir(folder):
                if os.path.splitext(fn)[1].lower() in IMAGE_EXTENSIONS:
                    fp = os.path.join(folder, fn)
                    if os.path.isfile(fp):
                        paths.append(fp)
        except OSError:
            pass
    return paths


def _resolve_tags(conn, tag_ids: List[int], new_tag_names: List[str]) -> List[int]:
    """Create any new tags and return the full list of tag IDs."""
    final = list(tag_ids)
    for name in new_tag_names:
        name = name.strip()
        if not name:
            continue
        existing = conn.execute("SELECT id FROM tags WHERE name = ?", (name,)).fetchone()
        if existing:
            final.append(existing['id'])
        else:
            cur = conn.execute("INSERT INTO tags(name) VALUES (?)", (name,))
            final.append(cur.lastrowid)
    # Deduplicate preserving order
    seen = set()
    result = []
    for tid in final:
        if tid not in seen:
            seen.add(tid)
            result.append(tid)
    return result


def _resolve_album(conn, album_id: Optional[int], new_album_name: Optional[str]) -> Optional[int]:
    if album_id:
        return album_id
    if new_album_name:
        name = new_album_name.strip()
        existing = conn.execute("SELECT id FROM albums WHERE name = ?", (name,)).fetchone()
        if existing:
            return existing['id']
        cur = conn.execute("INSERT INTO albums(name) VALUES (?)", (name,))
        return cur.lastrowid
    return None


# ── Background thread ──────────────────────────────────────────────────────────

def _run_batch_job(job_id: int, db_path: str, cancel_event: threading.Event):
    """Process pending files for a batch job in a background thread."""
    logger.info(f"Batch job {job_id}: thread started")
    conn = None
    try:
        conn = _connect(db_path)

        # Mark job as running (covers normal start, resume, and retry-after-cancel/done)
        conn.execute(
            "UPDATE batch_jobs SET status='running', started_at=COALESCE(started_at, datetime('now')) WHERE id=?",
            (job_id,)
        )
        conn.commit()

        # Load job config
        job = conn.execute("SELECT * FROM batch_jobs WHERE id=?", (job_id,)).fetchone()
        if not job:
            logger.error(f"Batch job {job_id}: not found, aborting")
            return

        tag_ids = json.loads(job['tag_ids']) if job['tag_ids'] else []
        album_id = job['album_id']
        visibility = job['visibility'] or 'shared'
        det_params = json.loads(job['det_params']) if job['det_params'] else {}

        # Resolve VLM per owner
        from fastapi_app import state as _state_obj
        from routers.settings import get_effective_vlm_provider
        try:
            owner_conn = _connect(db_path)
            owner_row = owner_conn.execute("SELECT * FROM users WHERE id=?", (job['owner_id'],)).fetchone()
            owner_conn.close()
            if owner_row:
                from permissions import User
                rd = dict(owner_row)
                owner_user = User(
                    id=rd['id'],
                    username=rd['username'],
                    password_hash=rd['password_hash'],
                    role=rd['role'],
                    allowed_folders=json.loads(rd['allowed_folders'] or '[]'),
                    created_at=rd['created_at'],
                    is_active=bool(rd['is_active']),
                    vlm_enabled=rd.get('vlm_enabled'),
                    vlm_provider=rd.get('vlm_provider'),
                    vlm_model=rd.get('vlm_model'),
                    det_model=rd.get('det_model'),
                )
                vlm = get_effective_vlm_provider(owner_user, _state_obj)
            else:
                vlm = None
        except Exception as e:
            logger.warning(f"Batch job {job_id}: could not resolve VLM: {e}")
            vlm = None

        chunk_size = 50
        while not cancel_event.is_set():
            # Fetch next chunk of pending files
            rows = conn.execute(
                "SELECT id, filepath, local_path FROM batch_job_files WHERE job_id=? AND status='pending' LIMIT ?",
                (job_id, chunk_size)
            ).fetchall()
            if not rows:
                break

            for row in rows:
                if cancel_event.is_set():
                    break

                file_id = row['id']
                filepath = row['filepath']
                local_path = row['local_path']

                # Check accessibility
                if not os.path.exists(filepath):
                    conn.execute(
                        "UPDATE batch_job_files SET status='error', error_msg=?, processed_at=datetime('now') WHERE id=?",
                        ('File not accessible', file_id)
                    )
                    conn.execute("UPDATE batch_jobs SET error_count=error_count+1 WHERE id=?", (job_id,))
                    conn.commit()
                    continue

                try:
                    # If the file is in our temporary batch_uploads dir, we should treat it 
                    # similar to upload_local (it might need to be moved to permanent uploads).
                    is_batch_upload = 'batch_uploads' in filepath
                    original_filename = os.path.basename(local_path) if local_path else None
                    
                    result = _state_obj.engine.process_image(
                        filepath, vlm,
                        det_thresh=det_params.get('det_thresh'),
                        min_face_size=det_params.get('min_face_size'),
                        rec_thresh=det_params.get('rec_thresh'),
                        det_model=det_params.get('det_model', 'auto'),
                        original_filename=original_filename
                    )
                    if not result.get('success'):
                        raise RuntimeError(result.get('error', 'Processing failed'))

                    image_id = result['image_id']
                    
                    # If it was a temporary upload, move it to permanent uploads
                    if is_batch_upload:
                        import shutil
                        uploads_dir = os.path.join(os.path.dirname(_state_obj.thumb_dir), 'uploads')
                        os.makedirs(uploads_dir, exist_ok=True)
                        perm_path = os.path.join(uploads_dir, os.path.basename(filepath))
                        try:
                            shutil.move(filepath, perm_path)
                            # Update the image record to point to the new permanent path
                            conn.execute("UPDATE images SET filepath=? WHERE id=?", (perm_path, image_id))
                        except Exception as move_err:
                            logger.warning(f"Batch job {job_id}: could not move {filepath} to permanent storage: {move_err}")

                    # Apply tags
                    for tid in tag_ids:
                        try:
                            conn.execute(
                                "INSERT OR IGNORE INTO image_tags(image_id, tag_id) VALUES (?, ?)",
                                (image_id, tid)
                            )
                        except Exception:
                            pass

                    # Apply album
                    if album_id:
                        try:
                            conn.execute(
                                "INSERT OR IGNORE INTO album_images(album_id, image_id) VALUES (?, ?)",
                                (album_id, image_id)
                            )
                        except Exception:
                            pass

                    # Set owner + visibility on the processed image
                    try:
                        conn.execute(
                            "UPDATE images SET owner_id=COALESCE(owner_id, ?), visibility=?, local_path=COALESCE(local_path, ?) WHERE id=?",
                            (job['owner_id'], visibility, local_path, image_id)
                        )
                    except Exception:
                        pass

                    conn.execute(
                        "UPDATE batch_job_files SET status='done', image_id=?, processed_at=datetime('now') WHERE id=?",
                        (image_id, file_id)
                    )
                    conn.execute("UPDATE batch_jobs SET done_count=done_count+1 WHERE id=?", (job_id,))
                    conn.commit()

                except Exception as e:
                    err_msg = str(e)[:500]
                    logger.warning(f"Batch job {job_id}: error processing {filepath}: {err_msg}")
                    conn.execute(
                        "UPDATE batch_job_files SET status='error', error_msg=?, processed_at=datetime('now') WHERE id=?",
                        (err_msg, file_id)
                    )
                    conn.execute("UPDATE batch_jobs SET error_count=error_count+1 WHERE id=?", (job_id,))
                    conn.commit()

        # Mark final status
        final_status = 'cancelled' if cancel_event.is_set() else 'done'
        conn.execute(
            "UPDATE batch_jobs SET status=?, finished_at=datetime('now') WHERE id=?",
            (final_status, job_id)
        )
        conn.commit()
        logger.info(f"Batch job {job_id}: finished with status={final_status}")

    except Exception as e:
        logger.error(f"Batch job {job_id}: unexpected error: {e}")
        try:
            if conn:
                conn.execute(
                    "UPDATE batch_jobs SET status='error', finished_at=datetime('now') WHERE id=?",
                    (job_id,)
                )
                conn.commit()
        except Exception:
            pass
    finally:
        if conn:
            conn.close()
        with _cancel_events_lock:
            _cancel_events.pop(job_id, None)


# ── Pydantic models ───────────────────────────────────────────────────────────

class BatchFileWithLocalPath(BaseModel):
    filepath: str
    local_path: Optional[str] = None

class CreateBatchJobRequest(BaseModel):
    folder: Optional[str] = None
    filepaths: Optional[List[str]] = None
    batch_files: Optional[List[BatchFileWithLocalPath]] = None
    name: Optional[str] = None
    recursive: bool = True
    follow_symlinks: bool = False
    visibility: str = 'shared'
    det_params: Optional[dict] = None
    tag_ids: List[int] = []
    new_tag_names: List[str] = []
    album_id: Optional[int] = None
    new_album_name: Optional[str] = None


# ── Endpoints ─────────────────────────────────────────────────────────────────

@router.post('/upload-file')
async def upload_batch_file(
    file: UploadFile = File(...),
    local_path: str = Form(...),
    user=Depends(get_current_user),
):
    """
    Upload a single file to a temporary location on the server for a future batch job.
    Returns the server-side path.
    """
    import uuid as _uuid
    s = _state()
    
    suffix = os.path.splitext(file.filename or '.jpg')[1] or '.jpg'
    # Use a 'batch_uploads' directory
    uploads_dir = os.path.join(os.path.dirname(s.thumb_dir), 'batch_uploads')
    os.makedirs(uploads_dir, exist_ok=True)
    
    server_path = os.path.join(uploads_dir, f'{_uuid.uuid4().hex}{suffix}')
    
    content = await file.read()
    with open(server_path, 'wb') as f:
        f.write(content)
        
    return {'server_path': server_path, 'local_path': local_path}


@router.post('')
def create_batch_job(body: CreateBatchJobRequest, user=Depends(get_current_user)):
    """Create a new batch job for a server-side folder or explicit file list."""
    s = _state()
    # Explicitly check for None so that empty lists [] (used for incremental jobs) are allowed.
    if body.folder is None and body.filepaths is None and body.batch_files is None:
        raise HTTPException(status_code=400, detail='Either folder, filepaths, or batch_files must be provided')

    conn = None
    try:
        conn = _connect(s.db_path)

        # Resolve tags + album eagerly so background thread doesn't need to do it
        final_tag_ids = _resolve_tags(conn, body.tag_ids, body.new_tag_names)
        final_album_id = _resolve_album(conn, body.album_id, body.new_album_name)
        conn.commit()

        if body.folder:
            if not os.path.isdir(body.folder):
                raise HTTPException(status_code=400, detail=f'Folder not found: {body.folder}')
            job_name = body.name or os.path.basename(body.folder.rstrip('/'))
            source_path = body.folder
        else:
            job_name = body.name or f"Batch {datetime.now().strftime('%Y-%m-%d %H:%M')}"
            source_path = "explicit-file-list"

        cur = conn.execute(
            """INSERT INTO batch_jobs
               (owner_id, name, status, source_path, recursive, follow_symlinks, visibility,
                det_params, tag_ids, album_id, created_at)
               VALUES (?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, datetime('now'))""",
            (
                user.id, job_name, source_path,
                1 if body.recursive else 0,
                1 if body.follow_symlinks else 0,
                body.visibility,
                json.dumps(body.det_params) if body.det_params else None,
                json.dumps(final_tag_ids),
                final_album_id,
            )
        )
        job_id = cur.lastrowid
        conn.commit()

        # Enumerate or use explicit files
        all_files = []
        if body.folder:
            logger.info(f"Batch job {job_id}: enumerating files in {body.folder}")
            all_files = [(fp, None) for fp in _enum_image_files(body.folder, body.recursive, body.follow_symlinks)]
        elif body.batch_files:
            logger.info(f"Batch job {job_id}: using {len(body.batch_files)} explicit batch_files")
            all_files = [(f.filepath, f.local_path) for f in body.batch_files]
        elif body.filepaths:
            logger.info(f"Batch job {job_id}: using {len(body.filepaths)} explicit filepaths")
            all_files = [(fp, None) for fp in body.filepaths]

        total = len(all_files)

        if all_files:
            batch_size = 1000
            for i in range(0, total, batch_size):
                chunk = all_files[i:i + batch_size]
                conn.executemany(
                    "INSERT INTO batch_job_files(job_id, filepath, local_path, status) VALUES (?, ?, ?, 'pending')",
                    [(job_id, fp, lp) for fp, lp in chunk]
                )
            conn.execute("UPDATE batch_jobs SET total_count=? WHERE id=?", (total, job_id))
            conn.commit()

        logger.info(f"Batch job {job_id}: created with {total} files")
        return {'job_id': job_id, 'total_count': total, 'name': job_name}

    finally:
        if conn:
            conn.close()


@router.post('/{job_id}/add-file')
def add_file_to_batch_job(job_id: int, body: BatchFileWithLocalPath, user=Depends(get_current_user)):
    """Add a single file to an existing batch job record."""
    s = _state()
    conn = None
    try:
        conn = _connect(s.db_path)
        # Verify ownership
        row = conn.execute("SELECT owner_id FROM batch_jobs WHERE id=?", (job_id,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail='Batch job not found')
        if user.role != 'admin' and row['owner_id'] != user.id:
            raise HTTPException(status_code=403, detail='Access denied')

        conn.execute(
            "INSERT INTO batch_job_files(job_id, filepath, local_path, status) VALUES (?, ?, ?, 'pending')",
            (job_id, body.filepath, body.local_path)
        )
        conn.execute("UPDATE batch_jobs SET total_count = total_count + 1 WHERE id = ?", (job_id,))
        conn.commit()
        return {'ok': True}
    finally:
        if conn:
            conn.close()


@router.get('')
def list_batch_jobs(user=Depends(get_current_user)):
    """List batch jobs. Admins see all; other users see only their own."""
    s = _state()
    conn = None
    try:
        conn = _connect(s.db_path)
        if user.role == 'admin':
            rows = conn.execute(
                "SELECT bj.*, u.username FROM batch_jobs bj "
                "LEFT JOIN users u ON u.id = bj.owner_id "
                "ORDER BY bj.created_at DESC"
            ).fetchall()
        else:
            rows = conn.execute(
                "SELECT bj.*, u.username FROM batch_jobs bj "
                "LEFT JOIN users u ON u.id = bj.owner_id "
                "WHERE bj.owner_id = ? ORDER BY bj.created_at DESC",
                (user.id,)
            ).fetchall()
        return [_job_row_to_dict(r) for r in rows]
    finally:
        if conn:
            conn.close()


@router.get('/{job_id}')
def get_batch_job(job_id: int, user=Depends(get_current_user)):
    s = _state()
    conn = None
    try:
        conn = _connect(s.db_path)
        row = conn.execute(
            "SELECT bj.*, u.username FROM batch_jobs bj "
            "LEFT JOIN users u ON u.id = bj.owner_id "
            "WHERE bj.id = ?",
            (job_id,)
        ).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail='Batch job not found')
        job = _job_row_to_dict(row)
        if user.role != 'admin' and job['owner_id'] != user.id:
            raise HTTPException(status_code=403, detail='Access denied')
        return job
    finally:
        if conn:
            conn.close()


@router.delete('/{job_id}')
def delete_batch_job(job_id: int, user=Depends(get_current_user)):
    s = _state()
    conn = None
    try:
        conn = _connect(s.db_path)
        row = conn.execute("SELECT * FROM batch_jobs WHERE id=?", (job_id,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail='Batch job not found')
        if user.role != 'admin' and row['owner_id'] != user.id:
            raise HTTPException(status_code=403, detail='Access denied')
        if row['status'] == 'running':
            raise HTTPException(status_code=409, detail='Cannot delete a running job; cancel it first')
        conn.execute("DELETE FROM batch_jobs WHERE id=?", (job_id,))
        conn.commit()
        return {'ok': True}
    finally:
        if conn:
            conn.close()


@router.post('/{job_id}/cancel')
def cancel_batch_job(job_id: int, user=Depends(get_current_user)):
    s = _state()
    conn = None
    try:
        conn = _connect(s.db_path)
        row = conn.execute("SELECT * FROM batch_jobs WHERE id=?", (job_id,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail='Batch job not found')
        if user.role != 'admin' and row['owner_id'] != user.id:
            raise HTTPException(status_code=403, detail='Access denied')

        with _cancel_events_lock:
            ev = _cancel_events.get(job_id)
        if ev:
            ev.set()

        # If not running, mark cancelled directly
        if row['status'] != 'running':
            conn.execute(
                "UPDATE batch_jobs SET status='cancelled', finished_at=datetime('now') WHERE id=?",
                (job_id,)
            )
            conn.commit()
        return {'ok': True}
    finally:
        if conn:
            conn.close()


@router.post('/{job_id}/start')
def start_batch_job(job_id: int, retry: bool = Query(False), user=Depends(get_current_user)):
    """Start or resume a batch job; returns an SSE stream with progress events."""
    s = _state()
    conn = None
    try:
        conn = _connect(s.db_path)
        row = conn.execute("SELECT * FROM batch_jobs WHERE id=?", (job_id,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail='Batch job not found')
        if user.role != 'admin' and row['owner_id'] != user.id:
            raise HTTPException(status_code=403, detail='Access denied')

        if retry:
            # Reset error files to pending and update job error_count
            cur = conn.execute(
                "UPDATE batch_job_files SET status='pending', error_msg=NULL, processed_at=NULL "
                "WHERE job_id=? AND status='error'",
                (job_id,)
            )
            reset_count = cur.rowcount
            if reset_count > 0:
                conn.execute(
                    "UPDATE batch_jobs SET status='pending', error_count=MAX(0, error_count - ?) WHERE id=?",
                    (reset_count, job_id)
                )
                conn.commit()
                logger.info(f"Batch job {job_id}: reset {reset_count} error files for retry")

        # Refetch job status
        row = conn.execute("SELECT status FROM batch_jobs WHERE id=?", (job_id,)).fetchone()
        if row['status'] in ('done', 'cancelled') and not retry:
            raise HTTPException(status_code=409, detail=f"Job is already {row['status']}")

    finally:
        if conn:
            conn.close()

    # Start background thread if not already running
    with _cancel_events_lock:
        already_running = job_id in _cancel_events
        if not already_running:
            cancel_event = threading.Event()
            _cancel_events[job_id] = cancel_event
            t = threading.Thread(
                target=_run_batch_job,
                args=(job_id, s.db_path, cancel_event),
                daemon=True,
                name=f"batch-job-{job_id}",
            )
            t.start()

    def _sse_gen():
        terminal_statuses = {'done', 'cancelled', 'error'}
        while True:
            try:
                _conn = _connect(s.db_path)
                job_row = _conn.execute(
                    "SELECT * FROM batch_jobs WHERE id=?", (job_id,)
                ).fetchone()
                _conn.close()
                if not job_row:
                    yield f"event: error\ndata: {json.dumps({'message': 'Job not found'})}\n\n"
                    break
                job_dict = _job_row_to_dict(job_row)
                yield f"data: {json.dumps(job_dict)}\n\n"
                if job_dict['status'] in terminal_statuses:
                    break
            except Exception as e:
                yield f"event: error\ndata: {json.dumps({'message': str(e)})}\n\n"
                break
            time.sleep(1)

    return StreamingResponse(
        _sse_gen(),
        media_type='text/event-stream',
        headers={
            'Cache-Control': 'no-cache',
            'X-Accel-Buffering': 'no',
        },
    )


@router.get('/{job_id}/logs')
def get_batch_job_logs(
    job_id: int,
    limit: int = Query(100, ge=1, le=1000),
    offset: int = Query(0, ge=0),
    user=Depends(get_current_user),
):
    """Return paginated error/skip log entries for a batch job."""
    s = _state()
    conn = None
    try:
        conn = _connect(s.db_path)
        row = conn.execute("SELECT owner_id FROM batch_jobs WHERE id=?", (job_id,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail='Batch job not found')
        if user.role != 'admin' and row['owner_id'] != user.id:
            raise HTTPException(status_code=403, detail='Access denied')

        entries = conn.execute(
            "SELECT filepath, status, error_msg, skip_reason, processed_at "
            "FROM batch_job_files "
            "WHERE job_id=? AND status IN ('error', 'skipped') "
            "ORDER BY id LIMIT ? OFFSET ?",
            (job_id, limit, offset)
        ).fetchall()
        total = conn.execute(
            "SELECT COUNT(*) FROM batch_job_files WHERE job_id=? AND status IN ('error', 'skipped')",
            (job_id,)
        ).fetchone()[0]

        return {
            'total': total,
            'offset': offset,
            'limit': limit,
            'entries': [dict(e) for e in entries],
        }
    finally:
        if conn:
            conn.close()
