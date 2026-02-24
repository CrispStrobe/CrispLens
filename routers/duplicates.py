"""
routers/duplicates.py — Duplicate image detection and management.

Detection methods (layered):
  name_size — same filename + file_size (fast, no extra data needed)
  hash      — same SHA256 file_hash (byte-for-byte identical)
  visual    — similar pHash (requires imagehash + PIL)

Resolution actions:
  delete_file — remove DB record + delete file from disk
  db_only     — remove DB record only (file stays on disk)
  symlink     — replace duplicate file with a symlink to the kept file
"""
import json
import logging
import os
import sqlite3
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import datetime

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import JSONResponse, Response, StreamingResponse
from pydantic import BaseModel

from routers.deps import require_admin_or_mediamanager

logger = logging.getLogger(__name__)
router = APIRouter()

# ── pHash availability ────────────────────────────────────────────────────────

try:
    import imagehash
    from PIL import Image as _PILImage
    PHASH_AVAILABLE = True
except ImportError:
    PHASH_AVAILABLE = False


# ── Helpers ───────────────────────────────────────────────────────────────────

def _state():
    from fastapi_app import state
    return state


def _connect(db_path: str):
    conn = sqlite3.connect(db_path, timeout=10.0)
    conn.execute("PRAGMA journal_mode = WAL")
    conn.row_factory = sqlite3.Row
    return conn


def _ensure_phash_column(db_path: str):
    """Add phash column if it doesn't exist (idempotent migration)."""
    conn = None
    try:
        conn = _connect(db_path)
        try:
            conn.execute("ALTER TABLE images ADD COLUMN phash TEXT")
            conn.execute("CREATE INDEX IF NOT EXISTS idx_images_phash ON images(phash)")
            conn.commit()
        except sqlite3.OperationalError:
            pass  # column already exists
    finally:
        if conn:
            conn.close()


def _image_details(conn, image_id: int) -> Optional[Dict]:
    """Load key fields for one image."""
    row = conn.execute("""
        SELECT id, filepath, filename, file_hash, file_size, face_count,
               taken_at, created_at, width, height, phash, local_path
        FROM images WHERE id=?
    """, (image_id,)).fetchone()
    if row is None:
        return None
    d = dict(row)
    d['server_path'] = d['filepath']
    d['origin_path'] = d['local_path']
    return d


def _bbox_iou(a_top, a_right, a_bottom, a_left,
              b_top, b_right, b_bottom, b_left) -> float:
    """Intersection over Union for normalised bboxes."""
    ix1 = max(a_left,   b_left)
    iy1 = max(a_top,    b_top)
    ix2 = min(a_right,  b_right)
    iy2 = min(a_bottom, b_bottom)
    if ix2 <= ix1 or iy2 <= iy1:
        return 0.0
    inter = (ix2 - ix1) * (iy2 - iy1)
    area_a = (a_right - a_left) * (a_bottom - a_top)
    area_b = (b_right - b_left) * (b_bottom - b_top)
    union = area_a + area_b - inter
    return inter / union if union > 0 else 0.0


def _merge_faces(conn, keep_id: int, delete_ids: List[int]):
    """
    Carry verified person assignments from the deleted images' faces over to
    the best-matching face in the kept image (by bbox IOU >= 0.3).
    """
    if not delete_ids:
        return

    # Fetch kept-image faces
    kept_faces = conn.execute("""
        SELECT f.id as face_id, f.bbox_top, f.bbox_right, f.bbox_bottom, f.bbox_left,
               fe.person_id
        FROM faces f
        LEFT JOIN face_embeddings fe ON f.id = fe.face_id
        WHERE f.image_id = ?
    """, (keep_id,)).fetchall()

    if not kept_faces:
        return

    # Fetch verified person assignments from deleted images
    ph = ','.join('?' * len(delete_ids))
    src_faces = conn.execute(f"""
        SELECT f.id as face_id, f.bbox_top, f.bbox_right, f.bbox_bottom, f.bbox_left,
               fe.id as emb_id, fe.person_id
        FROM faces f
        JOIN face_embeddings fe ON f.id = fe.face_id
        WHERE f.image_id IN ({ph})
          AND fe.verified = 1
          AND fe.person_id IS NOT NULL
    """, delete_ids).fetchall()

    for src in src_faces:
        best_iou = 0.0
        best_kept = None
        for kf in kept_faces:
            iou = _bbox_iou(
                src['bbox_top'], src['bbox_right'], src['bbox_bottom'], src['bbox_left'],
                kf['bbox_top'],  kf['bbox_right'],  kf['bbox_bottom'],  kf['bbox_left'],
            )
            if iou > best_iou:
                best_iou = iou
                best_kept = kf

        if best_kept and best_iou >= 0.3 and best_kept['person_id'] is None:
            conn.execute("""
                UPDATE face_embeddings
                SET person_id = ?, verified = 1, recognition_confidence = 1.0,
                    verification_method = 'merged_duplicate'
                WHERE face_id = ?
            """, (src['person_id'], best_kept['face_id']))


def _delete_image_record(conn, image_id: int):
    """Cascade-delete an image and all its face/embedding records."""
    conn.execute("DELETE FROM image_tags WHERE image_id=?",    (image_id,))
    conn.execute("DELETE FROM face_embeddings WHERE face_id IN "
                 "(SELECT id FROM faces WHERE image_id=?)",    (image_id,))
    conn.execute("DELETE FROM faces WHERE image_id=?",         (image_id,))
    conn.execute("DELETE FROM images WHERE id=?",              (image_id,))


def _do_resolve(db_path: str, keep_id: int, delete_ids: List[int],
                action: str, merge_faces: bool) -> Dict[str, Any]:
    """Core resolution logic. Returns summary dict."""
    conn = None
    errors = []
    try:
        conn = _connect(db_path)

        # Load filepaths before deleting
        ph = ','.join('?' * len(delete_ids))
        rows = conn.execute(
            f"SELECT id, filepath FROM images WHERE id IN ({ph})", delete_ids
        ).fetchall()
        dup_paths = {r['id']: r['filepath'] for r in rows}

        kept_row = conn.execute(
            "SELECT filepath FROM images WHERE id=?", (keep_id,)
        ).fetchone()
        if kept_row is None:
            raise HTTPException(status_code=404, detail=f"Keep image {keep_id} not found")
        kept_path = kept_row['filepath']

        # Face merge before deleting records
        if merge_faces:
            _merge_faces(conn, keep_id, delete_ids)

        # Delete DB records first (before touching filesystem)
        for did in delete_ids:
            _delete_image_record(conn, did)
        conn.commit()

        # Filesystem actions
        for did, dup_path in dup_paths.items():
            if not dup_path or not Path(dup_path).exists():
                continue
            try:
                if action == 'delete_file':
                    os.remove(dup_path)
                elif action == 'symlink':
                    os.remove(dup_path)
                    os.symlink(os.path.abspath(kept_path), dup_path)
                # db_only: no filesystem change
            except Exception as e:
                errors.append(f"{dup_path}: {e}")
                logger.warning(f"resolve fs action '{action}' failed for {dup_path}: {e}")

        return {
            "ok": True,
            "keep_id": keep_id,
            "deleted": list(dup_paths.keys()),
            "action": action,
            "errors": errors,
        }
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        if conn:
            conn.close()


def _hamming(h1: str, h2: str) -> int:
    """Hamming distance between two hex pHash strings."""
    try:
        return bin(int(h1, 16) ^ int(h2, 16)).count('1')
    except Exception:
        return 64


# ── Pydantic models ───────────────────────────────────────────────────────────

class ResolveRequest(BaseModel):
    keep_id:     int
    delete_ids:  List[int]
    action:      str = 'delete_file'   # 'delete_file' | 'db_only' | 'symlink'
    merge_faces: bool = True

class BatchGroupItem(BaseModel):
    keep_id:    int
    delete_ids: List[int]

class ResolveBatchRequest(BaseModel):
    groups:      List[BatchGroupItem]
    action:      str  = 'delete_file'
    merge_faces: bool = True

class CleanupScriptRequest(BaseModel):
    # Each entry is {origin_path, server_path, filename} — paths collected in the
    # frontend before resolve (DB records are deleted by then, so no ID lookup possible).
    files:  List[Dict[str, Any]]
    format: str = 'bash'   # 'bash' | 'powershell' | 'json'


# ── Routes ────────────────────────────────────────────────────────────────────

@router.get("/stats")
def get_stats():
    """Return duplicate counts per method + phash availability."""
    s = _state()
    _ensure_phash_column(s.db_path)
    conn = None
    try:
        conn = _connect(s.db_path)

        # name+size groups
        ns_count = conn.execute("""
            SELECT COUNT(*) FROM (
                SELECT filename, file_size FROM images
                WHERE processed=1 AND filename!='' AND file_size IS NOT NULL
                GROUP BY filename, file_size HAVING COUNT(*) > 1
            )
        """).fetchone()[0]

        # hash groups
        hash_count = conn.execute("""
            SELECT COUNT(*) FROM (
                SELECT file_hash FROM images
                WHERE processed=1 AND file_hash IS NOT NULL AND file_hash!=''
                GROUP BY file_hash HAVING COUNT(*) > 1
            )
        """).fetchone()[0]

        # wasted bytes (sum of file_size for all but the kept row in hash groups)
        wasted_row = conn.execute("""
            SELECT SUM(dup_size) FROM (
                SELECT i.file_size as dup_size
                FROM images i
                WHERE i.processed=1 AND i.file_hash IS NOT NULL AND i.file_hash!=''
                  AND i.file_hash IN (
                    SELECT file_hash FROM images
                    WHERE processed=1 AND file_hash IS NOT NULL AND file_hash!=''
                    GROUP BY file_hash HAVING COUNT(*) > 1
                  )
                  AND i.id NOT IN (
                    SELECT MIN(id) FROM images
                    WHERE processed=1 AND file_hash IS NOT NULL AND file_hash!=''
                    GROUP BY file_hash
                  )
            )
        """).fetchone()[0] or 0

        # How many images are missing file_hash (need scan-hashes)
        hash_missing = conn.execute(
            "SELECT COUNT(*) FROM images WHERE processed=1 AND (file_hash IS NULL OR file_hash='')"
        ).fetchone()[0]

        # phash: how many images need scanning
        phash_missing = conn.execute(
            "SELECT COUNT(*) FROM images WHERE processed=1 AND phash IS NULL"
        ).fetchone()[0]

        phash_groups = 0
        if PHASH_AVAILABLE:
            # Count distinct phash groups (already hashed images only)
            phash_groups = conn.execute("""
                SELECT COUNT(*) FROM (
                    SELECT phash FROM images
                    WHERE processed=1 AND phash IS NOT NULL AND phash!=''
                    GROUP BY phash HAVING COUNT(*) > 1
                )
            """).fetchone()[0]

        return {
            "name_size_groups": ns_count,
            "hash_groups":      hash_count,
            "visual_groups":    phash_groups,
            "wasted_bytes":     wasted_row,
            "hash_missing":     hash_missing,
            "phash_available":  PHASH_AVAILABLE,
            "phash_missing":    phash_missing,
        }
    finally:
        if conn:
            conn.close()


@router.get("/groups")
def get_groups(
    method:    str = Query('hash'),      # name_size | hash | visual
    threshold: int = Query(8, ge=0, le=64),
) -> List[Dict[str, Any]]:
    """Return duplicate groups. Each group has a list of image detail dicts."""
    s = _state()
    _ensure_phash_column(s.db_path)
    conn = None
    try:
        conn = _connect(s.db_path)

        if method == 'name_size':
            raw = conn.execute("""
                SELECT filename, file_size, GROUP_CONCAT(id) as ids, COUNT(*) as cnt
                FROM images
                WHERE processed=1 AND filename!='' AND file_size IS NOT NULL
                GROUP BY filename, file_size
                HAVING cnt > 1
                ORDER BY cnt DESC, file_size DESC
                LIMIT 500
            """).fetchall()
            groups = []
            for row in raw:
                ids = [int(i) for i in row['ids'].split(',')]
                images = [d for d in (_image_details(conn, i) for i in ids) if d]
                groups.append({
                    'key':        f"{row['filename']}|{row['file_size']}",
                    'method':     'name_size',
                    'similarity': 'Same name + size',
                    'images':     images,
                })
            return groups

        elif method == 'hash':
            raw = conn.execute("""
                SELECT file_hash, GROUP_CONCAT(id) as ids, COUNT(*) as cnt
                FROM images
                WHERE processed=1 AND file_hash IS NOT NULL AND file_hash!=''
                GROUP BY file_hash
                HAVING cnt > 1
                ORDER BY cnt DESC
                LIMIT 500
            """).fetchall()
            groups = []
            for row in raw:
                ids = [int(i) for i in row['ids'].split(',')]
                images = [d for d in (_image_details(conn, i) for i in ids) if d]
                groups.append({
                    'key':        row['file_hash'][:16],
                    'method':     'hash',
                    'similarity': 'Exact (SHA256)',
                    'images':     images,
                })
            return groups

        elif method == 'visual':
            if not PHASH_AVAILABLE:
                raise HTTPException(status_code=422, detail="imagehash not installed")

            rows = conn.execute("""
                SELECT id, phash FROM images
                WHERE processed=1 AND phash IS NOT NULL AND phash!=''
                ORDER BY id
            """).fetchall()

            # Greedy grouping by hamming distance
            ungrouped = [(r['id'], r['phash']) for r in rows]
            groups_raw: List[List[int]] = []
            assigned: set = set()

            for i, (id_a, hash_a) in enumerate(ungrouped):
                if id_a in assigned:
                    continue
                group = [id_a]
                for id_b, hash_b in ungrouped[i+1:]:
                    if id_b in assigned:
                        continue
                    if _hamming(hash_a, hash_b) <= threshold:
                        group.append(id_b)
                if len(group) > 1:
                    assigned.update(group)
                    groups_raw.append(group)

            groups = []
            for grp_ids in groups_raw[:500]:
                images = [d for d in (_image_details(conn, i) for i in grp_ids) if d]
                groups.append({
                    'key':        str(grp_ids[0]),
                    'method':     'visual',
                    'similarity': f'Visual (≤{threshold} bit distance)',
                    'images':     images,
                })
            return groups

        else:
            raise HTTPException(status_code=400, detail=f"Unknown method: {method}")

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        if conn:
            conn.close()


@router.post("/scan-hashes")
async def scan_hashes(_=Depends(require_admin_or_mediamanager)):
    """
    SSE: compute SHA-256 file_hash for all processed images that don't have one.

    Rows with file_hash = NULL or '' can arise from:
    - Files added before hash computation was implemented
    - Legacy cross-user same-content uploads (before the schema migration fixed the
      UNIQUE constraint; after the migration these rows should get their hashes filled in)

    Only fills hashes for files that are readable on disk.
    """
    import hashlib as _hashlib

    s = _state()
    conn_r = _connect(s.db_path)
    rows = conn_r.execute("""
        SELECT id, filepath FROM images
        WHERE processed=1 AND (file_hash IS NULL OR file_hash='')
        ORDER BY id
    """).fetchall()
    conn_r.close()

    todo = [(r['id'], r['filepath']) for r in rows]
    total = len(todo)

    async def event_stream():
        import asyncio
        loop = asyncio.get_event_loop()
        yield f"data: {json.dumps({'total': total, 'started': True})}\n\n"
        done = 0
        for image_id, filepath in todo:
            try:
                # Compute hash in a thread pool executor so we don't block the event loop
                def _compute(p=filepath, iid=image_id):
                    sha256 = _hashlib.sha256()
                    with open(p, 'rb') as fh:
                        while chunk := fh.read(65536):
                            sha256.update(chunk)
                    return sha256.hexdigest()

                h = await loop.run_in_executor(None, _compute)
                conn_w = _connect(s.db_path)
                try:
                    conn_w.execute(
                        "UPDATE images SET file_hash=? WHERE id=?", (h, image_id)
                    )
                    conn_w.commit()
                except Exception as _upd_err:
                    logger.warning(f"scan-hashes: could not store hash for {filepath}: {_upd_err}")
                finally:
                    conn_w.close()
                done += 1
                yield f"data: {json.dumps({'index': done, 'total': total, 'path': filepath})}\n\n"
            except Exception as e:
                logger.warning(f"scan-hashes error {filepath}: {e}")
                yield f"data: {json.dumps({'index': done, 'total': total, 'path': filepath, 'error': str(e)})}\n\n"
        yield f"data: {json.dumps({'done': True, 'total': total, 'computed': done})}\n\n"

    return StreamingResponse(event_stream(), media_type="text/event-stream")


@router.post("/scan-phash")
async def scan_phash(_=Depends(require_admin_or_mediamanager)):
    """SSE: compute pHash for all processed images that don't have one yet."""
    if not PHASH_AVAILABLE:
        return JSONResponse({"available": False, "error": "imagehash not installed"})

    s = _state()
    _ensure_phash_column(s.db_path)

    conn_r = _connect(s.db_path)
    rows = conn_r.execute("""
        SELECT id, filepath FROM images
        WHERE processed=1 AND phash IS NULL
        ORDER BY id
    """).fetchall()
    conn_r.close()

    todo = [(r['id'], r['filepath']) for r in rows]
    total = len(todo)

    async def event_stream():
        yield f"data: {json.dumps({'total': total, 'started': True})}\n\n"
        done = 0
        for image_id, filepath in todo:
            try:
                with _PILImage.open(filepath) as img:
                    h = str(imagehash.phash(img))
                conn_w = _connect(s.db_path)
                conn_w.execute("UPDATE images SET phash=? WHERE id=?", (h, image_id))
                conn_w.commit()
                conn_w.close()
                done += 1
                payload = {'index': done, 'total': total, 'path': filepath}
            except Exception as e:
                logger.warning(f"phash scan error {filepath}: {e}")
                payload = {'index': done, 'total': total, 'path': filepath, 'error': str(e)}
            yield f"data: {json.dumps(payload)}\n\n"
        yield f"data: {json.dumps({'done': True, 'total': total, 'computed': done})}\n\n"

    return StreamingResponse(event_stream(), media_type="text/event-stream")


@router.post("/resolve")
def resolve_duplicate(body: ResolveRequest, _=Depends(require_admin_or_mediamanager)):
    """Resolve a single duplicate group."""
    s = _state()
    if body.keep_id in body.delete_ids:
        raise HTTPException(status_code=400, detail="keep_id must not appear in delete_ids")
    valid_actions = {'delete_file', 'db_only', 'symlink'}
    if body.action not in valid_actions:
        raise HTTPException(status_code=400, detail=f"action must be one of {valid_actions}")
    return _do_resolve(s.db_path, body.keep_id, body.delete_ids, body.action, body.merge_faces)


@router.post("/cleanup-script")
def cleanup_script(body: CleanupScriptRequest, _=Depends(require_admin_or_mediamanager)):
    """
    Generate a downloadable script to remove origin files on the source machine.
    Only includes files where origin_path is set and differs from server_path
    (same-path means the server already deleted it via delete_file action).
    Formats: bash (.sh) | powershell (.ps1) | json
    """
    now = datetime.datetime.utcnow().isoformat(timespec='seconds') + 'Z'

    # Filter to files that need separate local cleanup
    to_remove = [
        f for f in body.files
        if f.get('origin_path') and f.get('origin_path') != f.get('server_path')
    ]

    if body.format == 'json':
        import json as _json
        content = _json.dumps({
            'version':   1,
            'action':    'trash_files',
            'generated': now,
            'files': [
                {
                    'origin_path': f['origin_path'],
                    'server_path': f.get('server_path', ''),
                    'filename':    f.get('filename', ''),
                    'reason':      'duplicate_resolved',
                }
                for f in to_remove
            ],
        }, indent=2)
        media_type   = 'application/json'
        ext          = 'json'

    elif body.format == 'powershell':
        lines = [
            '# CrispLens duplicate cleanup script',
            f'# Generated: {now}',
            '# Sends origin files to the Windows Recycle Bin.',
            '# Review carefully before running!',
            '',
            'Add-Type -AssemblyName Microsoft.VisualBasic',
            '',
        ]
        for f in to_remove:
            p = f['origin_path'].replace("'", "''")
            lines.append(f"# {f.get('filename', '')}  (server copy: {f.get('server_path', '')})")
            lines.append(
                f"[Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile("
                f"'{p}', 'OnlyErrorDialogs', 'SendToRecycleBin')"
            )
            lines.append('')
        lines.append("Write-Host 'Done. Check Recycle Bin.'")
        content    = '\r\n'.join(lines)
        media_type = 'text/plain'
        ext        = 'ps1'

    else:  # bash (default)
        lines = [
            '#!/usr/bin/env bash',
            '# CrispLens duplicate cleanup script',
            f'# Generated: {now}',
            '# Moves origin files to Trash / deletes them on the source machine.',
            '# Review carefully before running!',
            '',
            'set -euo pipefail',
            '',
            '# _trash: uses trash-cli if available, macOS ~/.Trash fallback, else rm',
            '_trash() {',
            '  if command -v trash &>/dev/null; then',
            "    trash -- \"$1\"",
            "  elif [[ \"$(uname)\" == 'Darwin' ]]; then",
            "    mv -- \"$1\" ~/.Trash/",
            '  else',
            "    rm -- \"$1\"",
            '  fi',
            '}',
            '',
        ]
        for f in to_remove:
            p = f['origin_path'].replace("'", "'\\''")
            lines.append(f"# {f.get('filename', '')}  (server copy: {f.get('server_path', '')})")
            lines.append(f"_trash '{p}'")
            lines.append('')
        lines.append("echo 'Done. Check Trash before emptying.'")
        content    = '\n'.join(lines)
        media_type = 'text/plain'
        ext        = 'sh'

    return Response(
        content=content,
        media_type=media_type,
        headers={'Content-Disposition': f'attachment; filename="crisp_cleanup.{ext}"'},
    )


@router.post("/resolve-batch")
def resolve_batch(body: ResolveBatchRequest, _=Depends(require_admin_or_mediamanager)):
    """Resolve multiple duplicate groups in one call."""
    s = _state()
    valid_actions = {'delete_file', 'db_only', 'symlink'}
    if body.action not in valid_actions:
        raise HTTPException(status_code=400, detail=f"action must be one of {valid_actions}")

    results = []
    for grp in body.groups:
        try:
            r = _do_resolve(s.db_path, grp.keep_id, grp.delete_ids, body.action, body.merge_faces)
            results.append(r)
        except Exception as e:
            results.append({"ok": False, "keep_id": grp.keep_id, "error": str(e)})
    return {"results": results, "total": len(results)}
