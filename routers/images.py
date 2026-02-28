"""
routers/images.py — Image browse, detail, thumbnail, full, patch, rename, delete.
"""
import hashlib
import os
import sqlite3
import subprocess
import logging
import threading
from collections import OrderedDict
from pathlib import Path
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Cookie, Depends, HTTPException, Query
from fastapi.responses import FileResponse, JSONResponse, Response
from pydantic import BaseModel

from image_ops import (
    browse_images_filtered,
    get_image_record,
    get_or_create_thumbnail,
    read_exif,
    rename_image,
    update_image_metadata,
)
from routers.deps import can_access_image, get_current_user, require_admin_or_mediamanager

# HTTP cache headers — 1 day browser cache, stale-while-revalidate for background refresh.
_THUMB_CACHE = {'Cache-Control': 'public, max-age=86400, stale-while-revalidate=3600'}
from routers.settings import get_effective_vlm_provider


# ── In-process thumbnail memory cache ────────────────────────────────────────
# Stores JPEG bytes keyed by (image_id, size). Avoids repeated disk reads and
# DB queries (get_image_record) for frequently accessed thumbnails.
# Bounded by total byte size; evicts least-recently-used entries when full.
_THUMB_CACHE_MAX_BYTES = 256 * 1024 * 1024   # 256 MB default


class _ThumbCache:
    """Thread-safe, byte-size-bounded LRU cache for thumbnail JPEG bytes."""

    def __init__(self, max_bytes: int = _THUMB_CACHE_MAX_BYTES):
        self._data: OrderedDict = OrderedDict()   # (image_id, size) → (bytes, etag)
        self._total = 0
        self._max = max_bytes
        self._lock = threading.Lock()

    def get(self, key: tuple):
        """Return (bytes, etag) on hit, None on miss."""
        with self._lock:
            if key in self._data:
                self._data.move_to_end(key)
                return self._data[key]
            return None

    def put(self, key: tuple, data: bytes) -> str:
        """Store bytes, evict LRU entries if over budget. Returns the ETag."""
        etag = hashlib.md5(data, usedforsecurity=False).hexdigest()
        with self._lock:
            if key in self._data:
                self._total -= len(self._data[key][0])
            self._data[key] = (data, etag)
            self._data.move_to_end(key)
            self._total += len(data)
            while self._total > self._max and self._data:
                _, (evicted, _) = self._data.popitem(last=False)
                self._total -= len(evicted)
        return etag

    def invalidate(self, image_id: int):
        """Remove all cached sizes for a given image (call on delete/replace)."""
        with self._lock:
            keys = [k for k in self._data if k[0] == image_id]
            for k in keys:
                self._total -= len(self._data[k][0])
                del self._data[k]

    def stats(self) -> dict:
        with self._lock:
            return {'entries': len(self._data), 'size_mb': round(self._total / 1_048_576, 1)}

_thumb_mem = _ThumbCache()

logger = logging.getLogger(__name__)
router = APIRouter()


def _state():
    from fastapi_app import state
    return state


def _check_modify(image_id: int, user, db_path: str):
    """Raise 403 if user can't modify this image.
    Allow: admin/mediamanager, owner, unowned (NULL), or visibility='shared'.
    Block: another user's private image.
    """
    if user.role in ('admin', 'mediamanager'):
        return
    conn = sqlite3.connect(db_path, timeout=5.0)
    try:
        row = conn.execute(
            "SELECT owner_id, visibility FROM images WHERE id=?", (image_id,)
        ).fetchone()
        if row is None:
            raise HTTPException(status_code=404, detail="Image not found")
        owner_id, visibility = row[0], row[1]
        # Allow: unowned (NULL owner), owned by this user, or visibility='shared'
        if owner_id is None or owner_id == user.id or visibility == 'shared':
            return
        raise HTTPException(status_code=403, detail="You don't have permission to modify this image")
    finally:
        conn.close()


# ── Models ────────────────────────────────────────────────────────────────────

class MetadataPatch(BaseModel):
    description: str = ''
    scene_type:  str = ''
    tags_csv:    str = ''

class RenameRequest(BaseModel):
    new_filename: str

class RatingPatch(BaseModel):
    rating: int  # 0–5

class FlagPatch(BaseModel):
    flag: Optional[str] = None  # 'pick' | 'delete' | null

class RotateRequest(BaseModel):
    direction: str  # 'cw' | 'ccw' | 'flip_h' | 'flip_v'

class ReDetectRequest(BaseModel):
    det_thresh:    float = 0.5
    min_face_size: int   = 20
    rec_thresh:    float = 0.4
    skip_vlm:      bool  = True   # default: re-detect faces only, don't re-run VLM
    det_model:     str   = 'auto' # 'auto'|'retinaface'|'scrfd'|'yunet'|'mediapipe'
    max_size:      int   = 0      # 0 = no resize; >0 = max long-edge pixels before detection

class ManualAddFaceRequest(BaseModel):
    bbox: Dict[str, float]  # top, right, bottom, left
    rec_thresh: Optional[float] = None


# ── Routes ────────────────────────────────────────────────────────────────────

@router.get("")
def list_images(
    person:       str  = Query(''),
    tag:          str  = Query(''),
    scene:        str  = Query(''),
    folder:       str  = Query(''),
    path:         str  = Query(''),
    date_from:    str  = Query(''),
    date_to:      str  = Query(''),
    sort:         str  = Query('newest'),
    limit:        int  = Query(200, ge=1, le=5000),
    offset:       int  = Query(0, ge=0),
    unidentified: bool = Query(False),
    album:        int  = Query(0),
    user=Depends(get_current_user),
) -> List[Dict[str, Any]]:
    s = _state()
    rows = browse_images_filtered(
        db_path=s.db_path,
        person=person,
        tag=tag,
        scene_type=scene,
        folder=folder,
        path=path,
        date_from=date_from,
        date_to=date_to,
        sort_by=sort,
        limit=limit + offset,
        unidentified=unidentified,
        album_id=album,
        current_user_id=user.id,
        is_admin=(user.role == 'admin'),
    )
    return rows[offset:]


@router.get("/{image_id}")
def get_image(image_id: int, user=Depends(get_current_user)):
    s = _state()
    if not can_access_image(image_id, user, s.db_path):
        raise HTTPException(status_code=403, detail="Access denied")
    rec = get_image_record(s.db_path, image_id)
    if rec is None:
        raise HTTPException(status_code=404, detail="Image not found")
    return rec


@router.get("/{image_id}/faces")
def get_image_faces(image_id: int, user=Depends(get_current_user)) -> List[Dict[str, Any]]:
    """Return all detected faces for an image with bbox and identity info."""
    s = _state()
    if not can_access_image(image_id, user, s.db_path):
        raise HTTPException(status_code=403, detail="Access denied")
    conn = None
    try:
        conn = sqlite3.connect(s.db_path, timeout=10.0)
        conn.execute("PRAGMA journal_mode = WAL")
        conn.row_factory = sqlite3.Row
        img = conn.execute("SELECT id FROM images WHERE id=?", (image_id,)).fetchone()
        if img is None:
            raise HTTPException(status_code=404, detail="Image not found")
        rows = conn.execute("""
            SELECT
                f.id as face_id,
                f.bbox_top, f.bbox_right, f.bbox_bottom, f.bbox_left,
                f.detection_confidence, f.face_quality,
                f.estimated_age, f.estimated_gender,
                fe.id as embedding_id,
                fe.person_id,
                p.name as person_name,
                fe.recognition_confidence,
                fe.verified
            FROM faces f
            LEFT JOIN face_embeddings fe ON f.id = fe.face_id
            LEFT JOIN people p ON fe.person_id = p.id
            WHERE f.image_id = ?
            ORDER BY f.bbox_left
        """, (image_id,)).fetchall()
        result = []
        for r in rows:
            d = dict(r)
            d['bbox'] = {
                'top':    d.pop('bbox_top'),
                'right':  d.pop('bbox_right'),
                'bottom': d.pop('bbox_bottom'),
                'left':   d.pop('bbox_left'),
            }
            result.append(d)
        return result
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        if conn:
            conn.close()


def _thumb_response(data: bytes, etag: str) -> Response:
    return Response(
        content=data,
        media_type="image/jpeg",
        headers={**_THUMB_CACHE, 'ETag': f'"{etag}"'},
    )


@router.get("/{image_id}/thumbnail")
def get_thumbnail(image_id: int, size: int = Query(200, ge=50, le=1000),
                  user=Depends(get_current_user)):
    s = _state()
    if not can_access_image(image_id, user, s.db_path):
        raise HTTPException(status_code=403, detail="Access denied")

    # ── Memory cache hit: skip DB lookup + disk I/O entirely ──────────────────
    cache_key = (image_id, size)
    cached = _thumb_mem.get(cache_key)
    if cached:
        return _thumb_response(*cached)

    # ── Cache miss: resolve image record and serve ─────────────────────────────
    rec = get_image_record(s.db_path, image_id)
    if rec is None:
        raise HTTPException(status_code=404, detail="Image not found")

    filepath = rec.get('filepath', '')

    # 1. Disk-cached thumbnail file
    thumb_path = Path(s.thumb_dir) / f"{image_id}_{size}.jpg"
    if thumb_path.exists():
        data = thumb_path.read_bytes()
        etag = _thumb_mem.put(cache_key, data)
        return _thumb_response(data, etag)

    # 2. Generate thumbnail from source file
    if filepath and Path(filepath).exists():
        thumb = get_or_create_thumbnail(image_id, filepath, s.thumb_dir, size)
        if thumb and Path(thumb).exists():
            data = Path(thumb).read_bytes()
            etag = _thumb_mem.put(cache_key, data)
            return _thumb_response(data, etag)
        # Source exists but thumbnail generation failed — serve original (not cached)
        return FileResponse(filepath, headers=_THUMB_CACHE)

    # 3. Fallback: thumbnail_blob stored in DB (remote/cloud images)
    conn = sqlite3.connect(s.db_path, timeout=10.0)
    conn.row_factory = sqlite3.Row
    blob_row = conn.execute(
        "SELECT thumbnail_blob FROM images WHERE id = ?", (image_id,)
    ).fetchone()
    conn.close()
    if blob_row and blob_row['thumbnail_blob']:
        data = bytes(blob_row['thumbnail_blob'])
        etag = _thumb_mem.put(cache_key, data)
        return _thumb_response(data, etag)

    raise HTTPException(status_code=404, detail="Thumbnail not available")


@router.get("/{image_id}/full")
def get_full(image_id: int, user=Depends(get_current_user)):
    s = _state()
    if not can_access_image(image_id, user, s.db_path):
        raise HTTPException(status_code=403, detail="Access denied")
    rec = get_image_record(s.db_path, image_id)
    if rec is None:
        raise HTTPException(status_code=404, detail="Image not found")
    filepath = rec.get('filepath', '')
    if not filepath or not Path(filepath).exists():
        raise HTTPException(status_code=404, detail="Image file not found on disk")
    return FileResponse(filepath)


@router.get("/{image_id}/download")
def download_image(image_id: int, user=Depends(get_current_user)):
    """Force-download the original image file with Content-Disposition: attachment."""
    s = _state()
    if not can_access_image(image_id, user, s.db_path):
        raise HTTPException(status_code=403, detail="Access denied")
    rec = get_image_record(s.db_path, image_id)
    if rec is None:
        raise HTTPException(status_code=404, detail="Image not found")
    filepath = rec.get('filepath', '')
    if not filepath or not Path(filepath).exists():
        raise HTTPException(status_code=404, detail="Image file not found on disk")
    filename = rec.get('filename') or Path(filepath).name
    return FileResponse(filepath, filename=filename, headers={
        'Content-Disposition': f'attachment; filename="{filename}"'
    })


@router.get("/{image_id}/preview")
def get_preview(image_id: int, user=Depends(get_current_user)):
    """Return a web-friendly JPEG version of the full image for display."""
    s = _state()
    if not can_access_image(image_id, user, s.db_path):
        raise HTTPException(status_code=403, detail="Access denied")
    logger.debug(f"Preview requested for image {image_id}")
    from image_ops import PIL_AVAILABLE
    if not PIL_AVAILABLE:
        logger.warning("PIL not available, falling back to full file")
        return get_full(image_id, user=user)
    
    s = _state()
    rec = get_image_record(s.db_path, image_id)
    if rec is None:
        logger.error(f"Image {image_id} not found in DB")
        raise HTTPException(status_code=404, detail="Image not found")
    
    filepath = rec.get('filepath', '')
    logger.debug(f"Image {image_id} filepath: {filepath}")
    if not filepath or not Path(filepath).exists():
        logger.error(f"Image {image_id} file not found on disk: {filepath}")
        raise HTTPException(status_code=404, detail="Image file not found on disk")

    # Always serve as JPEG with EXIF orientation baked in.
    # Serving the raw JPEG file directly would rely on browser EXIF support which
    # is inconsistent; baking the rotation ensures every client sees the correct
    # orientation and bbox coordinates stay aligned.
    from PIL import Image, ImageOps
    import io
    ext = Path(filepath).suffix.lower()
    try:
        logger.debug(f"Generating oriented preview for {ext}...")
        with Image.open(filepath) as img:
            img = ImageOps.exif_transpose(img)   # bake EXIF rotation
            if img.mode not in ('RGB', 'L'):
                img = img.convert('RGB')
            buf = io.BytesIO()
            img.save(buf, format='JPEG', quality=90)
            buf.seek(0)
            from fastapi.responses import Response
            logger.debug(f"Preview ready, {buf.getbuffer().nbytes} bytes")
            return Response(content=buf.getvalue(), media_type="image/jpeg")
    except Exception as e:
        logger.error(f"Preview conversion failed for {filepath}: {e}", exc_info=True)
        return FileResponse(filepath)


@router.get("/{image_id}/exif")
def get_exif(image_id: int, user=Depends(get_current_user)):
    s = _state()
    if not can_access_image(image_id, user, s.db_path):
        raise HTTPException(status_code=403, detail="Access denied")
    rec = get_image_record(s.db_path, image_id)
    if rec is None:
        raise HTTPException(status_code=404, detail="Image not found")
    filepath = rec.get('filepath', '')
    if not filepath:
        raise HTTPException(status_code=404, detail="No filepath")
    return read_exif(filepath)


@router.patch("/{image_id}/metadata")
def patch_metadata(image_id: int, body: MetadataPatch, user=Depends(get_current_user)):
    s = _state()
    _check_modify(image_id, user, s.db_path)
    ok, msg = update_image_metadata(
        db_path=s.db_path,
        image_id=image_id,
        description=body.description,
        scene_type=body.scene_type,
        tags_csv=body.tags_csv,
    )
    if not ok:
        raise HTTPException(status_code=400, detail=msg)
    return {"ok": True, "message": msg}


@router.post("/{image_id}/rename")
def do_rename(image_id: int, body: RenameRequest, user=Depends(get_current_user)):
    s = _state()
    _check_modify(image_id, user, s.db_path)
    ok, msg = rename_image(s.db_path, image_id, body.new_filename)
    if not ok:
        raise HTTPException(status_code=400, detail=msg)
    return {"ok": True, "message": msg}


@router.delete("/{image_id}")
def delete_image(image_id: int, user=Depends(get_current_user)):
    s = _state()
    _check_modify(image_id, user, s.db_path)
    rec = get_image_record(s.db_path, image_id)
    if rec is None:
        raise HTTPException(status_code=404, detail="Image not found")

    filepath = rec.get('filepath', '')
    conn = None
    try:
        if filepath and Path(filepath).exists():
            os.remove(filepath)

        conn = sqlite3.connect(s.db_path, timeout=10.0)
        conn.execute("PRAGMA journal_mode = WAL")
        conn.execute("PRAGMA foreign_keys = ON")  # cascade face_embeddings on face delete
        conn.execute("DELETE FROM image_tags WHERE image_id = ?", (image_id,))
        conn.execute("DELETE FROM faces WHERE image_id = ?", (image_id,))
        conn.execute("DELETE FROM images WHERE id = ?", (image_id,))
        conn.commit()
        _thumb_mem.invalidate(image_id)
        return {"ok": True}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        if conn:
            conn.close()


def _has_display() -> bool:
    """Return True if a GUI/display environment is available on this server."""
    import platform
    plat = platform.system()
    if plat == 'Darwin' or plat == 'Windows':
        return True
    # Linux: check DISPLAY (X11) or WAYLAND_DISPLAY
    return bool(os.environ.get('DISPLAY') or os.environ.get('WAYLAND_DISPLAY'))


@router.post("/{image_id}/open")
def open_in_os(image_id: int, _=Depends(get_current_user)):
    """Open image file in the default OS application.
    On headless servers returns ok=False with the server path so the frontend
    can display it or offer a download instead."""
    s = _state()
    rec = get_image_record(s.db_path, image_id)
    if rec is None:
        raise HTTPException(status_code=404, detail="Image not found")
    filepath = rec.get('filepath', '')
    if not filepath or not Path(filepath).exists():
        raise HTTPException(status_code=404, detail="File not found")
    if not _has_display():
        return {"ok": False, "headless": True, "path": filepath}
    try:
        import platform
        if platform.system() == 'Darwin':
            subprocess.Popen(['open', filepath])
        elif platform.system() == 'Windows':
            os.startfile(filepath)
        else:
            subprocess.Popen(['xdg-open', filepath])
        return {"ok": True, "path": filepath}
    except Exception as e:
        logger.warning("open_in_os failed for %s: %s", filepath, e)
        return {"ok": False, "headless": True, "path": filepath}


@router.post("/{image_id}/open-folder")
def open_folder_in_os(image_id: int, _=Depends(get_current_user)):
    """Open the directory containing the image in the OS file manager.
    On headless servers returns ok=False with the directory path so the
    frontend can display it (e.g. copy to clipboard or show a tooltip)."""
    s = _state()
    rec = get_image_record(s.db_path, image_id)
    if rec is None:
        raise HTTPException(status_code=404, detail="Image not found")
    filepath = rec.get('filepath', '')
    if not filepath or not Path(filepath).exists():
        raise HTTPException(status_code=404, detail="File not found")

    dir_path = str(Path(filepath).parent)
    if not _has_display():
        return {"ok": False, "headless": True, "path": dir_path}
    try:
        import platform
        if platform.system() == 'Darwin':
            subprocess.Popen(['open', dir_path])
        elif platform.system() == 'Windows':
            os.startfile(dir_path)
        else:
            subprocess.Popen(['xdg-open', dir_path])
        return {"ok": True, "path": dir_path}
    except Exception as e:
        logger.warning("open_folder_in_os failed for %s: %s", dir_path, e)
        return {"ok": False, "headless": True, "path": dir_path}


@router.patch("/{image_id}/rating")
def patch_rating(image_id: int, body: RatingPatch, _=Depends(get_current_user)):
    """Set star rating (0 = clear, 1–5 = stars)."""
    if not (0 <= body.rating <= 5):
        raise HTTPException(status_code=400, detail="rating must be 0–5")
    s = _state()
    from image_ops import _ensure_rating_cols
    _ensure_rating_cols(s.db_path)
    conn = None
    try:
        conn = sqlite3.connect(s.db_path, timeout=10.0)
        conn.execute("PRAGMA journal_mode = WAL")
        r = conn.execute(
            "UPDATE images SET star_rating=? WHERE id=?",
            (body.rating, image_id)
        )
        conn.commit()
        if r.rowcount == 0:
            raise HTTPException(status_code=404, detail="Image not found")
        return {"ok": True, "image_id": image_id, "star_rating": body.rating}
    finally:
        if conn:
            conn.close()


@router.patch("/{image_id}/flag")
def patch_flag(image_id: int, body: FlagPatch, _=Depends(get_current_user)):
    """Set color flag: 'pick', 'delete', or null to clear."""
    if body.flag not in (None, 'pick', 'delete'):
        raise HTTPException(status_code=400, detail="flag must be 'pick', 'delete', or null")
    s = _state()
    from image_ops import _ensure_rating_cols
    _ensure_rating_cols(s.db_path)
    conn = None
    try:
        conn = sqlite3.connect(s.db_path, timeout=10.0)
        conn.execute("PRAGMA journal_mode = WAL")
        r = conn.execute(
            "UPDATE images SET color_flag=? WHERE id=?",
            (body.flag, image_id)
        )
        conn.commit()
        if r.rowcount == 0:
            raise HTTPException(status_code=404, detail="Image not found")
        return {"ok": True, "image_id": image_id, "color_flag": body.flag}
    finally:
        if conn:
            conn.close()


@router.patch("/{image_id}/rotate")
def rotate_image(image_id: int, body: RotateRequest, user=Depends(get_current_user)):
    """Rotate or flip an image in-place using PIL. Deletes cached thumbnails."""
    if body.direction not in ('cw', 'ccw', 'flip_h', 'flip_v'):
        raise HTTPException(status_code=400, detail="direction must be cw|ccw|flip_h|flip_v")
    s = _state()
    _check_modify(image_id, user, s.db_path)
    rec = get_image_record(s.db_path, image_id)
    if rec is None:
        raise HTTPException(status_code=404, detail="Image not found")
    filepath = rec.get('filepath', '')
    if not filepath or not Path(filepath).exists():
        raise HTTPException(status_code=404, detail="File not found on disk")

    try:
        from PIL import Image as PILImage
    except ImportError:
        raise HTTPException(status_code=500, detail="Pillow not installed")

    try:
        img = PILImage.open(filepath)
        # Preserve format
        fmt = img.format or 'JPEG'
        if body.direction == 'cw':
            rotated = img.rotate(-90, expand=True)
        elif body.direction == 'ccw':
            rotated = img.rotate(90, expand=True)
        elif body.direction == 'flip_h':
            rotated = img.transpose(PILImage.FLIP_LEFT_RIGHT)
        else:  # flip_v
            rotated = img.transpose(PILImage.FLIP_TOP_BOTTOM)

        save_kwargs = {}
        if fmt == 'JPEG':
            save_kwargs['quality'] = 92
        rotated.save(filepath, format=fmt, **save_kwargs)
        new_w, new_h = rotated.size
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Rotation failed: {e}")

    # Update DB dimensions
    conn = None
    try:
        conn = sqlite3.connect(s.db_path, timeout=10.0)
        conn.execute("PRAGMA journal_mode = WAL")
        conn.execute(
            "UPDATE images SET width=?, height=? WHERE id=?",
            (new_w, new_h, image_id)
        )
        conn.commit()
    finally:
        if conn:
            conn.close()

    # Delete cached thumbnails
    import glob
    for thumb in glob.glob(os.path.join(s.thumb_dir, f"{image_id}_*.jpg")):
        try:
            os.remove(thumb)
        except OSError:
            pass

    return {"ok": True, "image_id": image_id, "width": new_w, "height": new_h}


@router.delete("/{image_id}/faces/{face_id}")
def do_delete_face(image_id: int, face_id: int, user=Depends(get_current_user)):
    from image_ops import delete_face
    s = _state()
    _check_modify(image_id, user, s.db_path)
    ok, msg = delete_face(s.db_path, face_id)
    if not ok:
        raise HTTPException(status_code=400, detail=msg)
    return {"ok": True, "message": msg}


@router.post("/{image_id}/re-detect")
def do_re_detect(image_id: int, body: ReDetectRequest, user=Depends(get_current_user)):
    from image_ops import re_detect_faces
    import sqlite3 as _sqlite3
    s = _state()
    _check_modify(image_id, user, s.db_path)

    # "none" = VLM-only: run VLM enrichment without touching face data
    if body.det_model == 'none':
        vlm_prov = get_effective_vlm_provider(user, s)
        if not vlm_prov:
            raise HTTPException(status_code=400, detail="VLM provider not configured — add in Settings")
        conn = _sqlite3.connect(s.db_path, timeout=5.0)
        conn.row_factory = _sqlite3.Row
        row = conn.execute("SELECT filepath FROM images WHERE id=?", (image_id,)).fetchone()
        conn.close()
        if not row:
            raise HTTPException(status_code=404, detail="Image not found")
        result = s.engine.process_image(row['filepath'], vlm_provider=vlm_prov,
                                        skip_faces=True, force=True)
        return {"ok": True, "message": "VLM enrichment complete", "result": result}

    vlm_prov = None if body.skip_vlm else get_effective_vlm_provider(user, s)
    ok, msg, result = re_detect_faces(
        s.db_path, image_id,
        det_thresh=body.det_thresh,
        min_face_size=body.min_face_size,
        rec_thresh=body.rec_thresh,
        engine=s.engine,
        vlm_provider=vlm_prov,
        det_model=body.det_model,
        max_size=body.max_size,
    )
    if not ok:
        raise HTTPException(status_code=400, detail=msg)
    return {"ok": True, "message": msg, "result": result}


@router.post("/{image_id}/clear-identifications")
def clear_identifications(image_id: int, user=Depends(get_current_user)):
    """Reset all person assignments for this image (keep face detections, wipe person_id)."""
    s = _state()
    _check_modify(image_id, user, s.db_path)
    conn = None
    try:
        import sqlite3 as _sqlite3
        conn = _sqlite3.connect(s.db_path, timeout=10.0)
        conn.execute("PRAGMA journal_mode = WAL")
        conn.execute("""
            UPDATE face_embeddings
            SET person_id = NULL,
                verified = 0,
                recognition_confidence = 0.0,
                verification_method = NULL
            WHERE face_id IN (SELECT id FROM faces WHERE image_id = ?)
        """, (image_id,))
        affected = conn.execute("SELECT changes() as n").fetchone()[0]
        conn.commit()
        # Reload FAISS so removed assignments don't remain in memory
        try:
            s.engine._load_faiss_index()
        except Exception:
            pass
        return {"ok": True, "cleared": affected}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        if conn:
            conn.close()


@router.post("/{image_id}/clear-detections")
def clear_detections(image_id: int, user=Depends(get_current_user)):
    """Delete ALL face detection rows for this image (boxes + embeddings gone)."""
    s = _state()
    _check_modify(image_id, user, s.db_path)
    conn = None
    try:
        import sqlite3 as _sqlite3
        conn = _sqlite3.connect(s.db_path, timeout=10.0)
        conn.execute("PRAGMA journal_mode = WAL")
        conn.execute("PRAGMA foreign_keys = ON")
        conn.execute("DELETE FROM faces WHERE image_id = ?", (image_id,))
        deleted = conn.execute("SELECT changes() as n").fetchone()[0]
        conn.execute(
            "UPDATE images SET face_count = 0, processed = 0 WHERE id = ?", (image_id,)
        )
        conn.commit()
        try:
            s.engine._load_faiss_index()
        except Exception:
            pass
        return {"ok": True, "deleted": deleted}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        if conn:
            conn.close()


@router.post("/{image_id}/faces/manual")
def do_manual_add_face(image_id: int, body: ManualAddFaceRequest, user=Depends(get_current_user)):
    s = _state()
    _check_modify(image_id, user, s.db_path)
    res = s.engine.add_manual_face(image_id, body.bbox, rec_thresh=body.rec_thresh)
    if not res.get('success'):
        raise HTTPException(status_code=400, detail=res.get('error'))
    return res


# ── Image visibility + sharing ─────────────────────────────────────────────────

class VisibilityRequest(BaseModel):
    visibility: str  # 'shared' | 'private'


class ShareRequest(BaseModel):
    user_ids: List[int]


@router.post("/{image_id}/visibility")
def set_visibility(image_id: int, body: VisibilityRequest, user=Depends(get_current_user)):
    """Change visibility of an image. Only the owner or an admin may do this."""
    if body.visibility not in ('shared', 'private'):
        raise HTTPException(status_code=400, detail="visibility must be 'shared' or 'private'")
    s = _state()
    conn = None
    try:
        conn = sqlite3.connect(s.db_path, timeout=10.0)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL")
        row = conn.execute("SELECT owner_id FROM images WHERE id = ?", (image_id,)).fetchone()
        if row is None:
            raise HTTPException(status_code=404, detail="Image not found")
        if user.role != 'admin' and row['owner_id'] != user.id:
            raise HTTPException(status_code=403, detail="Only the owner or admin can change visibility")
        conn.execute("UPDATE images SET visibility = ? WHERE id = ?", (body.visibility, image_id))
        conn.commit()
        return {"ok": True, "image_id": image_id, "visibility": body.visibility}
    finally:
        if conn:
            conn.close()


@router.get("/{image_id}/shares")
def get_shares(image_id: int, user=Depends(get_current_user)):
    """List users this image is explicitly shared with."""
    if not can_access_image(image_id, user, _state().db_path):
        raise HTTPException(status_code=403, detail="Access denied")
    s = _state()
    conn = None
    try:
        conn = sqlite3.connect(s.db_path, timeout=10.0)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL")
        rows = conn.execute("""
            SELECT s.user_id, u.username, s.shared_by, sb.username as shared_by_name, s.created_at
            FROM image_shares s
            JOIN users u  ON s.user_id   = u.id
            JOIN users sb ON s.shared_by = sb.id
            WHERE s.image_id = ?
        """, (image_id,)).fetchall()
        return [dict(r) for r in rows]
    finally:
        if conn:
            conn.close()


@router.post("/{image_id}/share")
def share_image(image_id: int, body: ShareRequest, user=Depends(get_current_user)):
    """Share a private image with specific users. Owner or admin only."""
    s = _state()
    conn = None
    try:
        conn = sqlite3.connect(s.db_path, timeout=10.0)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL")
        row = conn.execute("SELECT owner_id FROM images WHERE id = ?", (image_id,)).fetchone()
        if row is None:
            raise HTTPException(status_code=404, detail="Image not found")
        if user.role != 'admin' and row['owner_id'] != user.id:
            raise HTTPException(status_code=403, detail="Only the owner or admin can share")
        added = 0
        for uid in body.user_ids:
            try:
                conn.execute(
                    "INSERT OR IGNORE INTO image_shares (image_id, user_id, shared_by) VALUES (?, ?, ?)",
                    (image_id, uid, user.id),
                )
                added += 1
            except Exception:
                pass
        conn.commit()
        return {"ok": True, "added": added}
    finally:
        if conn:
            conn.close()


@router.delete("/{image_id}/share/{target_user_id}")
def unshare_image(image_id: int, target_user_id: int, user=Depends(get_current_user)):
    """Remove an explicit share. Owner, admin, or the share recipient may remove."""
    s = _state()
    conn = None
    try:
        conn = sqlite3.connect(s.db_path, timeout=10.0)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL")
        row = conn.execute("SELECT owner_id FROM images WHERE id = ?", (image_id,)).fetchone()
        if row is None:
            raise HTTPException(status_code=404, detail="Image not found")
        # Allow: owner, admin, or the recipient themselves
        if user.role != 'admin' and row['owner_id'] != user.id and target_user_id != user.id:
            raise HTTPException(status_code=403, detail="Not authorized to remove this share")
        conn.execute(
            "DELETE FROM image_shares WHERE image_id = ? AND user_id = ?",
            (image_id, target_user_id),
        )
        conn.commit()
        return {"ok": True}
    finally:
        if conn:
            conn.close()
