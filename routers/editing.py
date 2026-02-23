"""
routers/editing.py — Image crop, rotate, convert, and batch-convert.

Endpoints:
  POST /api/edit/crop          — crop a single image
  POST /api/edit/rotate        — rotate/flip a single image (alias for PATCH /images/{id}/rotate)
  POST /api/edit/convert       — convert/resize one or more images (small batches)
  POST /api/edit/convert-batch — SSE streaming batch convert
  GET  /api/edit/formats       — list supported output formats
"""
import glob
import io
import json
import os
import sqlite3
import logging
from pathlib import Path
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

logger = logging.getLogger(__name__)
router = APIRouter()

SUPPORTED_FORMATS = {
    'jpeg': {'ext': '.jpg', 'mime': 'image/jpeg', 'quality': True},
    'png':  {'ext': '.png', 'mime': 'image/png',  'quality': False},
    'webp': {'ext': '.webp','mime': 'image/webp', 'quality': True},
    'tiff': {'ext': '.tiff','mime': 'image/tiff', 'quality': False},
}


def _state():
    from fastapi_app import state
    return state


def _connect(db_path: str) -> sqlite3.Connection:
    conn = sqlite3.connect(db_path, timeout=10.0)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    return conn


def _get_pil():
    try:
        from PIL import Image
        return Image
    except ImportError:
        raise HTTPException(status_code=500, detail="Pillow is not installed")


def _delete_thumbnails(thumb_dir: str, image_id: int):
    for f in glob.glob(os.path.join(thumb_dir, f"{image_id}_*.jpg")):
        try:
            os.remove(f)
        except OSError:
            pass


# ── Models ────────────────────────────────────────────────────────────────────

class CropRequest(BaseModel):
    image_id: int
    x: int
    y: int
    width: int
    height: int
    save_as: str = 'replace'        # 'replace' | 'new_file'
    new_filename: Optional[str] = None

class ConvertRequest(BaseModel):
    image_ids: List[int]
    output_format: str = 'jpeg'     # jpeg | png | webp | tiff
    quality: int = 85               # JPEG/WebP only
    resize_mode: str = 'none'       # none | fit | exact
    max_width: Optional[int] = None
    max_height: Optional[int] = None
    save_as: str = 'new_file'       # replace | new_file | output_folder
    output_folder: Optional[str] = None
    suffix: str = '_converted'


# ── Routes ────────────────────────────────────────────────────────────────────

@router.get("/formats")
def list_formats():
    return [
        {'id': k, 'label': k.upper(), 'quality_option': v['quality']}
        for k, v in SUPPORTED_FORMATS.items()
    ]


@router.post("/crop")
def crop_image(body: CropRequest) -> Dict[str, Any]:
    """Crop an image to the given pixel rectangle."""
    PILImage = _get_pil()
    s = _state()

    conn = None
    try:
        conn = _connect(s.db_path)
        row = conn.execute("SELECT filepath, filename FROM images WHERE id=?", (body.image_id,)).fetchone()
    finally:
        if conn:
            conn.close()

    if not row:
        raise HTTPException(status_code=404, detail="Image not found")
    filepath = row['filepath']
    if not os.path.exists(filepath):
        raise HTTPException(status_code=404, detail="File not found on disk")

    try:
        img = PILImage.open(filepath)
        fmt = img.format or 'JPEG'
        box = (body.x, body.y, body.x + body.width, body.y + body.height)
        cropped = img.crop(box)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Crop failed: {e}")

    if body.save_as == 'replace':
        out_path = filepath
        result_id = body.image_id
    else:
        # Derive output filename
        p = Path(filepath)
        base = body.new_filename if body.new_filename else f"{p.stem}_cropped{p.suffix}"
        out_path = str(p.parent / base)
        result_id = None

    save_kwargs = {}
    if fmt == 'JPEG':
        save_kwargs['quality'] = 92
    try:
        cropped.save(out_path, format=fmt, **save_kwargs)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Save failed: {e}")

    w, h = cropped.size
    conn = None
    try:
        conn = _connect(s.db_path)
        if body.save_as == 'replace':
            conn.execute("UPDATE images SET width=?, height=? WHERE id=?", (w, h, body.image_id))
            conn.commit()
            _delete_thumbnails(s.thumb_dir, body.image_id)
        else:
            # Insert new image record
            cur = conn.execute(
                """INSERT OR IGNORE INTO images (filepath, filename, width, height, processed)
                   VALUES (?, ?, ?, ?, 0)""",
                (out_path, Path(out_path).name, w, h)
            )
            conn.commit()
            result_id = cur.lastrowid
    finally:
        if conn:
            conn.close()

    return {"ok": True, "image_id": result_id, "filepath": out_path, "width": w, "height": h}


def _do_convert_one(PILImage, filepath: str, out_path: str, body: ConvertRequest):
    """Convert/resize a single image. Returns (out_path, width, height)."""
    img = PILImage.open(filepath)
    if img.mode not in ('RGB', 'RGBA', 'L'):
        img = img.convert('RGB')

    if body.resize_mode == 'fit' and body.max_width and body.max_height:
        img.thumbnail((body.max_width, body.max_height), PILImage.LANCZOS)
    elif body.resize_mode == 'exact' and body.max_width and body.max_height:
        img = img.resize((body.max_width, body.max_height), PILImage.LANCZOS)

    fmt_info = SUPPORTED_FORMATS[body.output_format]
    save_kwargs = {}
    if fmt_info['quality'] and body.quality:
        save_kwargs['quality'] = body.quality
    if body.output_format == 'png' and img.mode == 'RGBA':
        pass  # keep RGBA for PNG
    elif img.mode == 'RGBA' and body.output_format != 'png':
        img = img.convert('RGB')

    img.save(out_path, format=body.output_format.upper(), **save_kwargs)
    w, h = img.size
    return w, h


def _build_out_path(filepath: str, body: ConvertRequest) -> str:
    fmt_info = SUPPORTED_FORMATS[body.output_format]
    p = Path(filepath)
    stem = p.stem + (body.suffix if body.save_as == 'new_file' else '')
    new_name = stem + fmt_info['ext']

    if body.save_as == 'output_folder' and body.output_folder:
        os.makedirs(body.output_folder, exist_ok=True)
        return str(Path(body.output_folder) / new_name)
    else:
        return str(p.parent / new_name)


@router.post("/convert")
def convert_images(body: ConvertRequest) -> Dict[str, Any]:
    """Convert/resize one or more images (synchronous, up to 50 images)."""
    if body.output_format not in SUPPORTED_FORMATS:
        raise HTTPException(status_code=400, detail=f"Unsupported format: {body.output_format}")
    if len(body.image_ids) > 50:
        raise HTTPException(status_code=400, detail="Use /convert-batch for > 50 images")

    PILImage = _get_pil()
    s = _state()
    results = []

    for image_id in body.image_ids:
        conn = None
        try:
            conn = _connect(s.db_path)
            row = conn.execute("SELECT filepath FROM images WHERE id=?", (image_id,)).fetchone()
        finally:
            if conn:
                conn.close()

        if not row or not os.path.exists(row['filepath']):
            results.append({"image_id": image_id, "ok": False, "error": "File not found"})
            continue

        filepath = row['filepath']
        out_path = filepath if body.save_as == 'replace' else _build_out_path(filepath, body)
        try:
            w, h = _do_convert_one(PILImage, filepath, out_path, body)
            if body.save_as == 'replace':
                _delete_thumbnails(s.thumb_dir, image_id)
            results.append({"image_id": image_id, "ok": True, "filepath": out_path, "width": w, "height": h})
        except Exception as e:
            results.append({"image_id": image_id, "ok": False, "error": str(e)})

    return {"results": results, "total": len(results), "ok": sum(1 for r in results if r['ok'])}


@router.post("/convert-batch")
def convert_batch(body: ConvertRequest):
    """Stream batch convert via SSE. Returns text/event-stream."""
    if body.output_format not in SUPPORTED_FORMATS:
        raise HTTPException(status_code=400, detail=f"Unsupported format: {body.output_format}")
    PILImage = _get_pil()
    s = _state()

    def generate():
        total = len(body.image_ids)
        done = 0
        ok = 0
        for image_id in body.image_ids:
            conn = None
            try:
                conn = _connect(s.db_path)
                row = conn.execute("SELECT filepath FROM images WHERE id=?", (image_id,)).fetchone()
            finally:
                if conn:
                    conn.close()

            if not row or not os.path.exists(row['filepath']):
                done += 1
                payload = json.dumps({'index': done, 'total': total, 'image_id': image_id, 'ok': False, 'error': 'not found'})
                yield f"data: {payload}\n\n"
                continue

            filepath = row['filepath']
            out_path = filepath if body.save_as == 'replace' else _build_out_path(filepath, body)
            try:
                w, h = _do_convert_one(PILImage, filepath, out_path, body)
                if body.save_as == 'replace':
                    _delete_thumbnails(s.thumb_dir, image_id)
                done += 1
                ok += 1
                payload = json.dumps({'index': done, 'total': total, 'image_id': image_id, 'ok': True, 'filepath': out_path})
            except Exception as e:
                done += 1
                payload = json.dumps({'index': done, 'total': total, 'image_id': image_id, 'ok': False, 'error': str(e)})
            yield f"data: {payload}\n\n"

        yield f"data: {json.dumps({'done': True, 'total': total, 'ok': ok})}\n\n"

    return StreamingResponse(generate(), media_type="text/event-stream")
