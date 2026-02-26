"""
routers/bfl_edit.py — AI image editing via BFL (Black Forest Labs) API.

Endpoints:
  POST /api/bfl/outpaint  — extend image borders with FLUX.1 Fill [pro]
  POST /api/bfl/inpaint   — fill a masked region with FLUX.1 Fill [pro]
  POST /api/bfl/edit      — text-driven image editing with FLUX.2
"""
import base64
import io
import logging
import os
import sqlite3
import time
from pathlib import Path
from typing import Optional

import requests as _req
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from routers.deps import get_current_user, can_access_image
from routers.editing import _register_converted_file

logger = logging.getLogger(__name__)
router = APIRouter()

BFL_API_BASE  = "https://api.bfl.ai/v1"
FILL_ENDPOINT = "/flux-pro-1.0-fill"          # outpaint + inpaint
EDIT_MODELS   = ["flux-2-pro", "flux-2-max", "flux-2-flex", "flux-2-klein-4b", "flux-2-klein-9b"]


def _state():
    from fastapi_app import state
    return state


# ── Helpers ───────────────────────────────────────────────────────────────────

def _get_bfl_key(user, s) -> str:
    key = s.api_key_manager.get_effective_key("bfl", user.username)
    if not key:
        key = os.environ.get("BFL_API_KEY")
    if not key:
        raise HTTPException(
            status_code=400,
            detail="BFL API key not configured — add it in Settings → API Keys",
        )
    return key


def _get_image_info(db_path: str, image_id: int) -> Optional[dict]:
    conn = None
    try:
        conn = sqlite3.connect(db_path, timeout=10.0)
        conn.row_factory = sqlite3.Row
        row = conn.execute(
            "SELECT filepath, filename, width, height, owner_id FROM images WHERE id=?",
            (image_id,),
        ).fetchone()
        return dict(row) if row else None
    finally:
        if conn:
            conn.close()


def _img_to_b64(img_pil, fmt: str = "PNG") -> str:
    buf = io.BytesIO()
    img_pil.save(buf, format=fmt)
    return base64.b64encode(buf.getvalue()).decode()


def _bfl_submit(api_key: str, endpoint: str, payload: dict) -> tuple:
    """Submit a BFL job. Returns (request_id, polling_url)."""
    r = _req.post(
        BFL_API_BASE + endpoint,
        json=payload,
        headers={"x-key": api_key, "Content-Type": "application/json"},
        timeout=30,
    )
    if not r.ok:
        raise HTTPException(
            status_code=502,
            detail=f"BFL submit error {r.status_code}: {r.text[:300]}",
        )
    data = r.json()
    request_id  = data.get("id") or data.get("request_id")
    polling_url = data.get("polling_url") or f"{BFL_API_BASE}/get_result?id={request_id}"
    return request_id, polling_url


def _bfl_poll(api_key: str, polling_url: str, timeout: int = 180) -> str:
    """Poll until status == 'Ready'. Returns the sample URL."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        time.sleep(1.5)
        r = _req.get(polling_url, headers={"x-key": api_key}, timeout=15)
        if not r.ok:
            raise HTTPException(
                status_code=502,
                detail=f"BFL poll error {r.status_code}: {r.text[:300]}",
            )
        data   = r.json()
        status = data.get("status", "")
        if status == "Ready":
            result = data.get("result", {})
            sample = result.get("sample") if isinstance(result, dict) else data.get("sample")
            if not sample:
                raise HTTPException(status_code=502, detail="BFL result missing sample URL")
            return sample
        if status in ("Error", "Failed"):
            raise HTTPException(
                status_code=502,
                detail=f"BFL job failed: {data.get('error', status)}",
            )
    raise HTTPException(status_code=504, detail="BFL job timed out after 180 seconds")


def _download_result(url: str) -> bytes:
    r = _req.get(url, timeout=60)
    if not r.ok:
        raise HTTPException(
            status_code=502,
            detail=f"Failed to download BFL result: {r.status_code}",
        )
    return r.content


def _build_bfl_out_path(filepath: str, suffix: str) -> str:
    """Build output path preserving directory, replacing extension with .jpg."""
    p = Path(filepath)
    return str(p.parent / (p.stem + suffix + ".jpg"))


def _save_and_register(s, data: bytes, out_path: str, image_id: int,
                       save_as: str, user_id: int) -> int:
    """Write result bytes, update/register in DB. Returns new_image_id."""
    with open(out_path, "wb") as f:
        f.write(data)

    from PIL import Image
    with Image.open(out_path) as img:
        w, h = img.size

    if save_as == "replace":
        conn = None
        try:
            conn = sqlite3.connect(s.db_path, timeout=10.0)
            conn.execute("UPDATE images SET width=?, height=? WHERE id=?", (w, h, image_id))
            conn.commit()
        finally:
            if conn:
                conn.close()
        return image_id
    else:
        new_id = _register_converted_file(s.db_path, out_path, w, h, user_id)
        return new_id


def _round16(v: int) -> int:
    """Round down to nearest multiple of 16 (BFL requirement)."""
    return max(16, (v // 16) * 16)


# ── Pydantic models ───────────────────────────────────────────────────────────

class OutpaintRequest(BaseModel):
    image_id:   int
    add_top:    int = 0
    add_bottom: int = 0
    add_left:   int = 0
    add_right:  int = 0
    prompt:     str = ""
    save_as:    str = "new_file"
    suffix:     str = "_outpainted"


class InpaintRequest(BaseModel):
    image_id: int
    prompt:   str
    mask_x:   int = 0
    mask_y:   int = 0
    mask_w:   int = 0
    mask_h:   int = 0
    save_as:  str = "new_file"
    suffix:   str = "_inpainted"


class AIEditRequest(BaseModel):
    image_id: int
    prompt:   str
    model:    str           = "flux-2-pro"
    save_as:  str           = "new_file"
    suffix:   str           = "_edited"
    seed:     Optional[int] = None


# ── Routes ────────────────────────────────────────────────────────────────────

@router.post("/outpaint")
def outpaint_image(body: OutpaintRequest, user=Depends(get_current_user)):
    """Extend image borders using FLUX.1 Fill [pro]."""
    from PIL import Image, ImageDraw
    s = _state()

    if not can_access_image(body.image_id, user, s.db_path):
        raise HTTPException(status_code=403, detail="Access denied")

    api_key = _get_bfl_key(user, s)
    info = _get_image_info(s.db_path, body.image_id)
    if not info:
        raise HTTPException(status_code=404, detail="Image not found")
    if not os.path.exists(info["filepath"]):
        raise HTTPException(status_code=404, detail="File not found on disk")

    try:
        orig   = Image.open(info["filepath"]).convert("RGB")
        orig_w, orig_h = orig.size
        new_w  = _round16(orig_w + body.add_left + body.add_right)
        new_h  = _round16(orig_h + body.add_top  + body.add_bottom)

        # Padded canvas: black background, original pasted at offset
        canvas = Image.new("RGB", (new_w, new_h), (0, 0, 0))
        canvas.paste(orig, (body.add_left, body.add_top))
        image_b64 = _img_to_b64(canvas, "PNG")

        # Mask: white = fill, black = preserve original
        mask = Image.new("L", (new_w, new_h), 255)   # all white = fill everything
        draw = ImageDraw.Draw(mask)
        draw.rectangle(
            [body.add_left, body.add_top,
             body.add_left + orig_w - 1, body.add_top + orig_h - 1],
            fill=0,                                    # black = keep original
        )
        mask_b64 = _img_to_b64(mask, "PNG")
    except Exception as e:
        logger.error("Outpaint prep failed for image %d: %s", body.image_id, e, exc_info=True)
        raise HTTPException(status_code=500, detail="Image preparation failed")

    prompt = body.prompt.strip() or (
        "Extend the image naturally to fill the surrounding area, "
        "maintaining the original composition, style, and lighting."
    )
    payload = {
        "image":         image_b64,
        "mask":          mask_b64,
        "prompt":        prompt,
        "steps":         50,
        "guidance":      30,
        "output_format": "jpeg",
        "width":         new_w,
        "height":        new_h,
    }

    _, polling_url = _bfl_submit(api_key, FILL_ENDPOINT, payload)
    sample_url     = _bfl_poll(api_key, polling_url)
    result_bytes   = _download_result(sample_url)

    out_path = info["filepath"] if body.save_as == "replace" else _build_bfl_out_path(info["filepath"], body.suffix)
    new_id   = _save_and_register(s, result_bytes, out_path, body.image_id, body.save_as, user.id)

    from PIL import Image as _PIL
    with _PIL.open(out_path) as img:
        w, h = img.size

    return {"ok": True, "image_id": body.image_id, "new_image_id": new_id,
            "filepath": out_path, "width": w, "height": h}


@router.post("/inpaint")
def inpaint_image(body: InpaintRequest, user=Depends(get_current_user)):
    """Fill a masked rectangular region using FLUX.1 Fill [pro]."""
    from PIL import Image, ImageDraw
    s = _state()

    if not can_access_image(body.image_id, user, s.db_path):
        raise HTTPException(status_code=403, detail="Access denied")

    api_key = _get_bfl_key(user, s)
    info = _get_image_info(s.db_path, body.image_id)
    if not info:
        raise HTTPException(status_code=404, detail="Image not found")
    if not os.path.exists(info["filepath"]):
        raise HTTPException(status_code=404, detail="File not found on disk")

    try:
        orig    = Image.open(info["filepath"]).convert("RGB")
        img_w, img_h = orig.size
        # Round to multiples of 16
        new_w   = _round16(img_w)
        new_h   = _round16(img_h)
        if new_w != img_w or new_h != img_h:
            orig = orig.resize((new_w, new_h), Image.LANCZOS)

        image_b64 = _img_to_b64(orig, "PNG")

        # Mask: black = preserve, white = fill
        mask = Image.new("L", (new_w, new_h), 0)     # all black = preserve all
        if body.mask_w > 0 and body.mask_h > 0:
            draw = ImageDraw.Draw(mask)
            draw.rectangle(
                [body.mask_x, body.mask_y,
                 body.mask_x + body.mask_w - 1, body.mask_y + body.mask_h - 1],
                fill=255,                              # white = fill this region
            )
        mask_b64 = _img_to_b64(mask, "PNG")
    except Exception as e:
        logger.error("Inpaint prep failed for image %d: %s", body.image_id, e, exc_info=True)
        raise HTTPException(status_code=500, detail="Image preparation failed")

    payload = {
        "image":         image_b64,
        "mask":          mask_b64,
        "prompt":        body.prompt,
        "steps":         50,
        "guidance":      30,
        "output_format": "jpeg",
        "width":         new_w,
        "height":        new_h,
    }

    _, polling_url = _bfl_submit(api_key, FILL_ENDPOINT, payload)
    sample_url     = _bfl_poll(api_key, polling_url)
    result_bytes   = _download_result(sample_url)

    out_path = info["filepath"] if body.save_as == "replace" else _build_bfl_out_path(info["filepath"], body.suffix)
    new_id   = _save_and_register(s, result_bytes, out_path, body.image_id, body.save_as, user.id)

    from PIL import Image as _PIL
    with _PIL.open(out_path) as img:
        w, h = img.size

    return {"ok": True, "image_id": body.image_id, "new_image_id": new_id,
            "filepath": out_path, "width": w, "height": h}


@router.post("/edit")
def ai_edit_image(body: AIEditRequest, user=Depends(get_current_user)):
    """Text-driven image editing using FLUX.2."""
    from PIL import Image
    s = _state()

    if body.model not in EDIT_MODELS:
        raise HTTPException(
            status_code=400,
            detail=f"Unknown model: {body.model}. Valid: {EDIT_MODELS}",
        )
    if not can_access_image(body.image_id, user, s.db_path):
        raise HTTPException(status_code=403, detail="Access denied")

    api_key = _get_bfl_key(user, s)
    info = _get_image_info(s.db_path, body.image_id)
    if not info:
        raise HTTPException(status_code=404, detail="Image not found")
    if not os.path.exists(info["filepath"]):
        raise HTTPException(status_code=404, detail="File not found on disk")

    try:
        img       = Image.open(info["filepath"]).convert("RGB")
        image_b64 = _img_to_b64(img, "JPEG")
    except Exception as e:
        logger.error("AI edit prep failed for image %d: %s", body.image_id, e, exc_info=True)
        raise HTTPException(status_code=500, detail="Image preparation failed")

    payload: dict = {"prompt": body.prompt, "input_image": image_b64}
    if body.seed is not None:
        payload["seed"] = body.seed

    _, polling_url = _bfl_submit(api_key, f"/{body.model}", payload)
    sample_url     = _bfl_poll(api_key, polling_url)
    result_bytes   = _download_result(sample_url)

    out_path = info["filepath"] if body.save_as == "replace" else _build_bfl_out_path(info["filepath"], body.suffix)
    new_id   = _save_and_register(s, result_bytes, out_path, body.image_id, body.save_as, user.id)

    from PIL import Image as _PIL
    with _PIL.open(out_path) as img_out:
        w, h = img_out.size

    return {"ok": True, "image_id": body.image_id, "new_image_id": new_id,
            "filepath": out_path, "width": w, "height": h}
