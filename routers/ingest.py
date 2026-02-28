"""
routers/ingest.py — Hybrid local/remote ingest endpoints.

Two modes:
  POST /api/ingest/upload-local
      Accepts a full image file (multipart) + the original local path.
      VPS does face detection + embedding (normal pipeline), records local_path.

  POST /api/ingest/import-processed
      Accepts thumbnail + pre-computed embeddings from Electron local processing.
      VPS does FAISS person-matching only (no detection).
"""
import base64
import logging
import os
from datetime import datetime
from typing import List, Optional

import numpy as np
from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from pydantic import BaseModel

from routers.deps import get_current_user
from routers.settings import get_effective_vlm_provider

logger = logging.getLogger(__name__)
router = APIRouter()


# ── Helpers ───────────────────────────────────────────────────────────────────

def _state_with_engine():
    """Return app state, blocking until the face recognition backend is ready.

    The model warms up in a background thread at startup.  If a request arrives
    before warm-up completes this function waits (up to 120 s) rather than
    immediately returning 503, so non-admin users who upload right after server
    start are not rejected spuriously.
    """
    from fastapi_app import state
    try:
        state.engine._ensure_backend()
    except Exception as e:
        raise HTTPException(
            status_code=503,
            detail=f'Face recognition model failed to initialize: {e}',
        )
    return state


def _connect(db_path: str):
    import sqlite3
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    conn.execute('PRAGMA journal_mode=WAL')
    conn.execute('PRAGMA foreign_keys=ON')
    return conn


# ── Pydantic models ───────────────────────────────────────────────────────────

class FaceData(BaseModel):
    bbox_left:            float
    bbox_top:             float
    bbox_right:           float
    bbox_bottom:          float
    detection_confidence: float
    embedding:            List[float]   # 512 L2-normalised floats
    embedding_dimension:  int
    age:                  Optional[int]   = None
    gender:               Optional[str]   = None  # 'male' | 'female'


class ImportProcessedRequest(BaseModel):
    local_path:   str
    filename:     str
    width:        int
    height:       int
    thumbnail_b64: str
    file_hash:    Optional[str]  = None
    file_size:    Optional[int]  = None
    exif_data:    Optional[dict] = None
    local_model:  str            = 'buffalo_l'
    faces:        List[FaceData] = []
    visibility:   str            = 'shared'


# ── upload-local ──────────────────────────────────────────────────────────────

@router.post('/upload-local')
async def upload_local(
    file:           UploadFile     = File(...),
    local_path:     str            = Form(...),
    visibility:     str            = Form('shared'),
    det_thresh:     Optional[float] = Form(None),
    min_face_size:  Optional[int]   = Form(None),
    rec_thresh:     Optional[float] = Form(None),
    det_model:      str             = Form('auto'),
    max_size:       int             = Form(0),
    tag_ids:        str             = Form(''),        # JSON array of existing tag IDs
    new_tag_names:  str             = Form(''),        # JSON array of new tag names to create
    album_id:       Optional[int]   = Form(None),
    new_album_name: Optional[str]   = Form(None),
    user=Depends(get_current_user),
):
    """
    Upload a full image from the local machine.
    VPS processes it normally (face detection + embedding) and records the
    original local_path so the Electron app can open the full-res file later.

    The file is saved permanently to uploads/ so that thumbnail generation
    and full-image serving work after the request completes.
    """
    import asyncio
    import uuid as _uuid

    # Run the (potentially blocking) engine readiness check in a thread pool so
    # that the asyncio event loop is not blocked while the model warms up.
    loop = asyncio.get_event_loop()
    try:
        s = await asyncio.wait_for(
            loop.run_in_executor(None, _state_with_engine),
            timeout=120.0,
        )
    except asyncio.TimeoutError:
        raise HTTPException(
            status_code=503,
            detail='Face recognition model did not become ready within 120 s.',
        )

    suffix = os.path.splitext(file.filename or '.jpg')[1] or '.jpg'

    # Save to a permanent location so the filepath stored in the DB remains valid
    uploads_dir = os.path.join(os.path.dirname(s.thumb_dir), 'uploads')
    os.makedirs(uploads_dir, exist_ok=True)
    perm_path = os.path.join(uploads_dir, f'{_uuid.uuid4().hex}{suffix}')

    data = await file.read()

    # Optionally downscale before saving to limit server storage usage
    max_dim = (s.config or {}).get('storage', {}).get('upload_max_dimension', 0)
    if max_dim and max_dim > 0:
        try:
            from PIL import Image as _PILImage
            import io as _io
            img_obj = _PILImage.open(_io.BytesIO(data))
            if max(img_obj.width, img_obj.height) > max_dim:
                img_obj.thumbnail((max_dim, max_dim), _PILImage.LANCZOS)
                buf = _io.BytesIO()
                fmt = img_obj.format or 'JPEG'
                img_obj.save(buf, format=fmt)
                data = buf.getvalue()
        except Exception:
            pass  # fall back to original if PIL fails

    # ── Same-user duplicate check (before writing to disk) ───────────────────
    import hashlib as _hashlib
    file_hash = _hashlib.sha256(data).hexdigest()
    _dedup_conn = _connect(s.db_path)
    try:
        # Match same-user rows OR unowned rows with the same content
        _dup = _dedup_conn.execute(
            "SELECT id, face_count FROM images"
            " WHERE file_hash = ? AND (owner_id = ? OR owner_id IS NULL) AND processed = 1 LIMIT 1",
            (file_hash, user.id),
        ).fetchone()
    finally:
        _dedup_conn.close()
    if _dup:
        return {'image_id': _dup['id'], 'face_count': _dup['face_count'], 'skipped': True}

    # Check for cross-user shared duplicate (same content, another user uploaded as shared)
    _dedup_conn2 = _connect(s.db_path)
    try:
        _shared = _dedup_conn2.execute(
            "SELECT id, face_count FROM images"
            " WHERE file_hash = ? AND owner_id != ? AND visibility = 'shared' AND processed = 1 LIMIT 1",
            (file_hash, user.id),
        ).fetchone()
    finally:
        _dedup_conn2.close()
    if _shared:
        # Record local_path for the uploading user if not already set
        logger.info('upload_local: shared_duplicate detected image_id=%s, saving local_path=%r for user %s',
                    _shared['id'], local_path, user.id)
        try:
            _lp_conn = _connect(s.db_path)
            _lp_conn.execute(
                "UPDATE images SET local_path = COALESCE(local_path, ?) WHERE id = ?",
                (local_path, _shared['id']),
            )
            _lp_conn.commit()
            _lp_conn.close()
        except Exception:
            pass
        return {'image_id': _shared['id'], 'face_count': _shared['face_count'],
                'skipped': True, 'shared_duplicate': True}

    # ── Exempt-path skip-copy ─────────────────────────────────────────────────
    # If the uploading client is on the same machine as the server and the file
    # is already on a server-accessible path (e.g. /mnt/…), skip writing a copy
    # to uploads/ and point the DB record at the original path instead.
    _exempt = (s.config or {}).get('storage', {}).get('copy_exempt_paths', ['/mnt'])
    _is_exempt = bool(
        local_path
        and os.path.isfile(local_path)
        and any(
            os.path.normpath(local_path).startswith(os.path.normpath(p) + os.sep)
            or os.path.normpath(local_path) == os.path.normpath(p)
            for p in _exempt
        )
    )
    if _is_exempt:
        perm_path = local_path   # use source path directly — no copy
        logger.info('upload_local: exempt path — skipping copy, using %r as filepath', perm_path)
    else:
        with open(perm_path, 'wb') as fh:
            fh.write(data)

    try:
        # Normal VPS processing (filepath stored in DB = perm_path — stays on disk)
        vlm = get_effective_vlm_provider(user, s)
        result = await _run_in_executor(s, perm_path, vlm,
                                        det_thresh=det_thresh, min_face_size=min_face_size,
                                        rec_thresh=rec_thresh, det_model=det_model, max_size=max_size)

        if not result.get('success'):
            try:
                os.unlink(perm_path)
            except OSError:
                pass
            raise HTTPException(status_code=422, detail=result.get('error', 'Processing failed'))

        image_id = result['image_id']

        # Record original local path and ownership — only when image has no owner yet or is ours
        conn = None
        try:
            conn = _connect(s.db_path)
            vis = visibility if visibility in ('shared', 'private') else 'shared'
            cur_row = conn.execute("SELECT owner_id FROM images WHERE id = ?", (image_id,)).fetchone()
            cur_owner = cur_row['owner_id'] if cur_row else None
            if cur_owner is None or cur_owner == user.id:
                conn.execute(
                    'UPDATE images SET local_path = ?, owner_id = ?, visibility = ? WHERE id = ?',
                    (local_path, user.id, vis, image_id),
                )
                conn.commit()
                logger.info('upload_local: saved image_id=%s | local_path=%r | owner_id=%s | visibility=%s',
                            image_id, local_path, user.id, vis)
            else:
                logger.info('upload_local: image_id=%s already owned by owner_id=%s, skipping local_path update (local_path=%r)',
                            image_id, cur_owner, local_path)

            # Apply tags + album if provided
            try:
                import json as _json
                _tag_ids = _json.loads(tag_ids) if tag_ids else []
            except Exception:
                _tag_ids = []
            try:
                _new_tag_names = _json.loads(new_tag_names) if new_tag_names else []
            except Exception:
                _new_tag_names = []

            # Create new tags
            for _name in _new_tag_names:
                _name = _name.strip()
                if not _name:
                    continue
                _existing = conn.execute("SELECT id FROM tags WHERE name=?", (_name,)).fetchone()
                if _existing:
                    _tag_ids.append(_existing['id'])
                else:
                    _cur = conn.execute("INSERT INTO tags(name) VALUES (?)", (_name,))
                    _tag_ids.append(_cur.lastrowid)

            # Apply tags to image
            for _tid in _tag_ids:
                try:
                    conn.execute(
                        "INSERT OR IGNORE INTO image_tags(image_id, tag_id) VALUES (?, ?)",
                        (image_id, _tid)
                    )
                except Exception:
                    pass

            # Resolve + apply album
            _album_id = album_id
            if new_album_name:
                _album_name = new_album_name.strip()
                _existing_album = conn.execute("SELECT id FROM albums WHERE name=?", (_album_name,)).fetchone()
                if _existing_album:
                    _album_id = _existing_album['id']
                else:
                    _album_cur = conn.execute("INSERT INTO albums(name) VALUES (?)", (_album_name,))
                    _album_id = _album_cur.lastrowid
            if _album_id:
                try:
                    conn.execute(
                        "INSERT OR IGNORE INTO album_images(album_id, image_id) VALUES (?, ?)",
                        (_album_id, image_id)
                    )
                except Exception:
                    pass

            conn.commit()

            # Write thumbnail blob to disk so GET /api/images/{id}/thumbnail works
            thumb_row = conn.execute(
                'SELECT thumbnail_blob FROM images WHERE id = ?', (image_id,)
            ).fetchone()
            if thumb_row and thumb_row['thumbnail_blob']:
                os.makedirs(s.thumb_dir, exist_ok=True)
                thumb_path = os.path.join(s.thumb_dir, f'{image_id}_200.jpg')
                with open(thumb_path, 'wb') as tf:
                    tf.write(thumb_row['thumbnail_blob'])
        finally:
            if conn:
                conn.close()

        return {
            'image_id':   image_id,
            'face_count': result.get('face_count', 0),
            'skipped':    False,
        }
    except HTTPException:
        raise
    except Exception:
        if not _is_exempt:
            try:
                os.unlink(perm_path)
            except OSError:
                pass
        raise


async def _run_in_executor(s, path: str, vlm_provider=None,
                           det_thresh=None, min_face_size=None, rec_thresh=None,
                           det_model='auto', max_size=0):
    import asyncio
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(
        None,
        lambda: s.engine.process_image(
            path, vlm_provider,
            det_thresh=det_thresh, min_face_size=min_face_size, rec_thresh=rec_thresh,
            det_model=det_model, max_size=max_size,
        ),
    )


# ── import-processed ──────────────────────────────────────────────────────────

@router.post('/import-processed')
def import_processed(body: ImportProcessedRequest, user=Depends(get_current_user)):
    """
    Accept a pre-processed image from Electron (thumbnail + face embeddings).
    VPS runs FAISS person-matching against the known-person index but skips
    face detection entirely — the Mac already did that locally.
    """
    s = _state_with_engine()
    conn = None

    try:
        conn = _connect(s.db_path)

        # ── 1. Dedup check ────────────────────────────────────────────────────
        existing = conn.execute(
            '''SELECT id FROM images
               WHERE local_path = ?
                  OR (file_hash IS NOT NULL AND file_hash = ? AND file_hash != '')
               LIMIT 1''',
            (body.local_path, body.file_hash or ''),
        ).fetchone()

        if existing:
            return {'image_id': existing['id'], 'face_count': 0, 'people': [], 'skipped': True}

        # ── 2. Decode thumbnail ────────────────────────────────────────────────
        try:
            thumb_bytes = base64.b64decode(body.thumbnail_b64)
        except Exception as e:
            raise HTTPException(status_code=422, detail=f'Invalid thumbnail_b64: {e}')

        # ── 3. Insert image record ─────────────────────────────────────────────
        exif    = body.exif_data or {}
        taken_at = exif.get('taken_at')
        now     = datetime.utcnow().isoformat()

        vis = body.visibility if body.visibility in ('shared', 'private') else 'shared'
        cursor = conn.execute(
            '''INSERT INTO images (
                   filepath, filename, local_path,
                   file_hash, file_size,
                   width, height, format,
                   thumbnail_blob,
                   taken_at,
                   camera_make, camera_model,
                   iso, aperture, shutter_speed, focal_length,
                   processed, face_count, processed_at,
                   owner_id, visibility,
                   created_at, updated_at
               ) VALUES (
                   ?, ?, ?,
                   ?, ?,
                   ?, ?, 'JPEG',
                   ?,
                   ?,
                   ?, ?,
                   ?, ?, ?, ?,
                   1, ?, ?,
                   ?, ?,
                   ?, ?
               )''',
            (
                body.local_path, body.filename, body.local_path,
                body.file_hash, body.file_size,
                body.width, body.height,
                thumb_bytes,
                taken_at,
                exif.get('camera_make'), exif.get('camera_model'),
                exif.get('iso'), exif.get('aperture'),
                exif.get('shutter_speed'), exif.get('focal_length'),
                len(body.faces), now,
                user.id, vis,
                now, now,
            ),
        )
        image_id = cursor.lastrowid
        logger.info('import_processed: inserted image_id=%s | local_path=%r | owner_id=%s | visibility=%s | faces=%s',
                    image_id, body.local_path, user.id, vis, len(body.faces))

        # ── 4. Save thumbnail to disk for fast serving ─────────────────────────
        thumb_path = os.path.join(s.thumb_dir, f'{image_id}_200.jpg')
        try:
            os.makedirs(s.thumb_dir, exist_ok=True)
            with open(thumb_path, 'wb') as f:
                f.write(thumb_bytes)
        except OSError as e:
            logger.warning('Could not write thumbnail to disk: %s', e)

        # ── 5. Insert faces + embeddings, run FAISS matching ───────────────────
        from face_recognition_core import Face, BoundingBox

        matched_people: List[str] = []

        for fd in body.faces:
            # Face record
            face_cursor = conn.execute(
                '''INSERT INTO faces (
                       image_id,
                       bbox_top, bbox_right, bbox_bottom, bbox_left,
                       detection_confidence,
                       estimated_age, estimated_gender
                   ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)''',
                (
                    image_id,
                    fd.bbox_top, fd.bbox_right, fd.bbox_bottom, fd.bbox_left,
                    fd.detection_confidence,
                    fd.age, fd.gender,
                ),
            )
            face_id = face_cursor.lastrowid

            # Build Face object for FAISS matching
            embedding = np.array(fd.embedding, dtype=np.float32)
            face_obj  = Face(
                bbox=BoundingBox(
                    top=fd.bbox_top, right=fd.bbox_right,
                    bottom=fd.bbox_bottom, left=fd.bbox_left,
                ),
                detection_confidence=fd.detection_confidence,
                embedding=embedding,
            )

            # FAISS person matching
            person_id  = None
            confidence = 0.0
            verified   = False

            try:
                recognitions = s.engine.recognize_face(face_obj)
                if recognitions:
                    best = recognitions[0]
                    if best.person_id is not None and best.confidence >= s.engine.config.recognition_threshold:
                        person_id  = best.person_id
                        confidence = best.confidence
                        verified   = False   # auto-match, not manually verified
                        if best.person_name:
                            matched_people.append(best.person_name)
            except Exception as e:
                logger.warning('FAISS matching failed for face %s: %s', face_id, e)

            # Embedding record
            conn.execute(
                '''INSERT INTO face_embeddings (
                       face_id, person_id,
                       embedding_vector, embedding_dimension,
                       recognition_confidence, verified,
                       embedding_model
                   ) VALUES (?, ?, ?, ?, ?, ?, ?)''',
                (
                    face_id, person_id,
                    embedding.tobytes(), fd.embedding_dimension,
                    confidence, verified,
                    body.local_model,
                ),
            )

        conn.commit()

        # ── 6. Reload FAISS index so new embeddings are searchable ─────────────
        try:
            s.engine._load_faiss_index()
        except Exception as e:
            logger.warning('FAISS reload failed: %s', e)

        return {
            'image_id':   image_id,
            'face_count': len(body.faces),
            'people':     list(dict.fromkeys(matched_people)),  # unique, order-preserving
            'skipped':    False,
        }

    finally:
        if conn:
            conn.close()
