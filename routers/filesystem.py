"""
routers/filesystem.py — Filesystem browse and add-to-DB pipeline.
"""
import json
import logging
import os
import sqlite3
from pathlib import Path
from typing import Any, Dict, List

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from routers.deps import get_current_user

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


class AddRequest(BaseModel):
    paths:      List[str]
    recursive:  bool = True
    visibility: str  = 'shared'


def _collect_image_paths(paths: List[str], recursive: bool) -> List[str]:
    result = []
    for p in paths:
        pp = Path(p)
        if pp.is_file() and pp.suffix.lower() in IMAGE_EXTENSIONS:
            result.append(str(pp))
        elif pp.is_dir():
            pattern = '**/*' if recursive else '*'
            result.extend(
                str(f) for f in pp.glob(pattern)
                if f.is_file() and f.suffix.lower() in IMAGE_EXTENSIONS
            )
    return result


def _check_path_allowed(path: Path, user) -> None:
    """
    Raise 403 if a non-admin user tries to browse a path outside their allowed folders.
    Admins and mediamanagers can browse anywhere on the server.
    Regular users are restricted to FACE_REC_DATA_DIR and their explicit allowed_folders.
    """
    if user.role in ('admin', 'mediamanager'):
        return
    allowed_roots: list[Path] = []
    data_dir = os.environ.get('FACE_REC_DATA_DIR', '')
    if data_dir:
        allowed_roots.append(Path(data_dir).resolve())
    for folder in (user.allowed_folders or []):
        allowed_roots.append(Path(folder).resolve())
    if not allowed_roots:
        raise HTTPException(status_code=403, detail="No accessible paths configured for your account")
    resolved = path.resolve()
    if not any(resolved == r or str(resolved).startswith(str(r) + os.sep) for r in allowed_roots):
        raise HTTPException(status_code=403, detail="Access to this path is not permitted")


@router.get("/browse")
def browse_filesystem(path: str = Query(''), user=Depends(get_current_user)) -> Dict[str, Any]:
    """
    List a directory with DB-status for each image file and subdirectory.

    Returns:
      {
        path: str,
        parent: str | null,
        entries: [
          { name, path, is_dir: true,  total_files, db_count } |
          { name, path, is_dir: false, in_db, image_id }
        ]
      }
    """
    s = _state()

    if not path:
        # Default to the data/install dir so VPS users land in a useful place.
        # Fall back to home dir if the env var is not set.
        path = os.environ.get('FACE_REC_DATA_DIR') or os.path.expanduser('~')

    target = Path(path)
    if not target.exists():
        raise HTTPException(status_code=404, detail=f"Path not found: {path}")
    if not target.is_dir():
        raise HTTPException(status_code=400, detail=f"Not a directory: {path}")
    _check_path_allowed(target, user)

    conn = None
    try:
        conn = _connect(s.db_path)
        entries = []

        try:
            scan_iter = sorted(
                os.scandir(path),
                key=lambda e: (not e.is_dir(follow_symlinks=False), e.name.lower())
            )
        except PermissionError:
            raise HTTPException(status_code=403, detail=f"Permission denied: {path}")

        for entry in scan_iter:
            if entry.name.startswith('.'):
                continue

            try:
                if entry.is_dir(follow_symlinks=False):
                    # Count image files in this dir (non-recursive, shallow check)
                    try:
                        dir_images = [
                            f for f in os.scandir(entry.path)
                            if f.is_file() and Path(f.name).suffix.lower() in IMAGE_EXTENSIONS
                        ]
                        total = len(dir_images)
                        if total > 0:
                            img_paths = [f.path for f in dir_images]
                            placeholders = ','.join('?' * len(img_paths))
                            row = conn.execute(
                                f"SELECT COUNT(*) as cnt FROM images "
                                f"WHERE filepath IN ({placeholders}) AND processed=1",
                                img_paths
                            ).fetchone()
                            db_count = row['cnt'] if row else 0
                        else:
                            db_count = 0
                    except PermissionError:
                        total = 0
                        db_count = 0

                    entries.append({
                        'name':        entry.name,
                        'path':        entry.path,
                        'is_dir':      True,
                        'total_files': total,
                        'db_count':    db_count,
                    })

                elif entry.is_file() and Path(entry.name).suffix.lower() in IMAGE_EXTENSIONS:
                    row = conn.execute(
                        "SELECT id FROM images WHERE filepath=?", (entry.path,)
                    ).fetchone()
                    entries.append({
                        'name':     entry.name,
                        'path':     entry.path,
                        'is_dir':   False,
                        'in_db':    row is not None,
                        'image_id': row['id'] if row else None,
                    })
            except OSError:
                continue

        parent = str(target.parent) if str(target.parent) != str(target) else None
        return {'path': str(target), 'parent': parent, 'entries': entries}

    except HTTPException:
        raise
    except Exception as e:
        logger.error("browse_filesystem error for path %s: %s", path, e, exc_info=True)
        raise HTTPException(status_code=500, detail="Failed to list directory")
    finally:
        if conn:
            conn.close()


@router.post("/add")
async def add_to_db(body: AddRequest, user=Depends(get_current_user)):
    """
    Add selected filesystem paths (files or directories) to the DB.
    Streams SSE events like /api/process/batch.
    Sets owner_id and visibility on each inserted image record.
    """
    s = _state()
    all_paths = _collect_image_paths(body.paths, body.recursive)
    total = len(all_paths)
    vis = body.visibility if body.visibility in ('shared', 'private') else 'shared'
    owner_id = user.id

    async def event_stream():
        import asyncio
        loop = asyncio.get_event_loop()
        yield f"data: {json.dumps({'total': total, 'started': True})}\n\n"
        skipped = 0
        errors = 0
        added = 0
        for i, path in enumerate(all_paths):
            # Pre-check: skip paths already in DB to avoid re-processing
            try:
                _ck = _connect(s.db_path)
                _existing = _ck.execute(
                    "SELECT id FROM images WHERE filepath = ?", (path,)
                ).fetchone()
                _ck.close()
            except Exception:
                _existing = None
            if _existing:
                skipped += 1
                yield f"data: {json.dumps({'index': i + 1, 'total': total, 'path': path, 'skipped': True})}\n\n"
                continue

            try:
                # Run blocking process_image in a thread so SSE frames flush between images
                result = await loop.run_in_executor(
                    None, lambda p=path: s.engine.process_image(p, s.vlm_provider)
                )
                r = result if isinstance(result, dict) else {}
                image_id = r.get('image_id')
                if image_id:
                    try:
                        conn = _connect(s.db_path)
                        conn.execute(
                            'UPDATE images SET owner_id = ?, visibility = ? WHERE id = ?',
                            (owner_id, vis, image_id),
                        )
                        conn.commit()
                        conn.close()
                    except Exception as e_upd:
                        logger.warning(f"Could not set owner/visibility for image {image_id}: {e_upd}")
                    # Set origin_path = server_path for files added directly from the server FS
                    try:
                        conn2 = _connect(s.db_path)
                        conn2.execute(
                            'UPDATE images SET local_path = filepath WHERE id = ? AND local_path IS NULL',
                            (image_id,),
                        )
                        conn2.commit()
                        conn2.close()
                    except Exception as e_lp:
                        logger.warning(f"Could not set local_path for image {image_id}: {e_lp}")
                added += 1
                payload = {
                    'index':  i + 1,
                    'total':  total,
                    'path':   path,
                    'result': {
                        'faces_detected': r.get('face_count', 0),
                        'vlm':            r.get('vlm_result'),
                    },
                }
            except Exception as e:
                errors += 1
                logger.error(f"add_to_db error {path}: {e}")
                payload = {
                    'index': i + 1,
                    'total': total,
                    'path':  path,
                    'error': str(e),
                }
            yield f"data: {json.dumps(payload)}\n\n"
        yield f"data: {json.dumps({'done': True, 'total': total, 'added': added, 'skipped': skipped, 'errors': errors})}\n\n"

    return StreamingResponse(event_stream(), media_type="text/event-stream")
