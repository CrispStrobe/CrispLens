"""
routers/processing.py — Single image + batch SSE processing, training.
"""
import json
import logging
from pathlib import Path
from typing import List, Optional

from fastapi import APIRouter, HTTPException, Depends
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from folder_training import FolderTrainer
from routers.deps import get_current_user
from routers.settings import get_effective_vlm_provider

logger = logging.getLogger(__name__)
router = APIRouter()

IMAGE_EXTENSIONS = {'.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp', '.tiff', '.tif', '.pgm'}


def _state():
    from fastapi_app import state
    return state

def _state_with_engine():
    """Return state, raising 503 if the face recognition model isn't loaded yet."""
    from fastapi_app import state
    if not state.engine._backend_ready:
        raise HTTPException(
            status_code=503,
            detail="Face recognition model is still loading. Please wait a moment and try again.",
        )
    return state


# ── Models ────────────────────────────────────────────────────────────────────

class SingleRequest(BaseModel):
    filepath:   str
    force:      bool = False
    skip_faces: bool = False   # True = re-run VLM only
    skip_vlm:   bool = False   # True = re-run face detection only
    det_model:  str  = 'auto'  # 'auto'|'retinaface'|'scrfd'|'yunet'|'mediapipe'

class BatchRequest(BaseModel):
    folder:    str
    recursive: bool = True

class BatchFilesRequest(BaseModel):
    paths: List[str]   # explicit list of absolute file paths

class TrainRequest(BaseModel):
    person_name:  str
    image_paths:  List[str]

class FolderTrainRequest(BaseModel):
    folder: str

class ScanFolderRequest(BaseModel):
    folder:    str
    recursive: bool = True


# ── Helpers ───────────────────────────────────────────────────────────────────

def _get_image_paths(folder: str, recursive: bool) -> List[str]:
    base = Path(folder)
    if not base.exists():
        return []
    pattern = '**/*' if recursive else '*'
    return [
        str(p) for p in base.glob(pattern)
        if p.is_file() and p.suffix.lower() in IMAGE_EXTENSIONS
    ]


# ── Routes ────────────────────────────────────────────────────────────────────

@router.post("/single")
def process_single(body: SingleRequest, user=Depends(get_current_user)):
    s = _state_with_engine()
    if not Path(body.filepath).exists():
        raise HTTPException(status_code=404, detail="File not found")
    try:
        vlm = get_effective_vlm_provider(user, s)
        result = s.engine.process_image(
            body.filepath, vlm, force=body.force,
            skip_faces=body.skip_faces, skip_vlm=body.skip_vlm,
            det_model=body.det_model,
        )
        return {"ok": True, "result": result}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


def _build_payload(i, total, path, result=None, error=None):
    if error:
        return {'index': i, 'total': total, 'path': path, 'error': str(error)}
    return {
        'index': i,
        'total': total,
        'path': path,
        'image_id': result.get('image_id'),
        'result': {
            'faces_detected': result.get('face_count', 0),
            'people': result.get('people', []),
            'scene_type': result.get('scene_type', ''),
            'vlm': result.get('vlm_result'),
        },
    }


async def _stream_paths(paths, s, vlm_provider):
    """Shared SSE generator: process a list of paths and yield SSE events."""
    import asyncio
    total = len(paths)
    loop = asyncio.get_event_loop()
    yield f"data: {json.dumps({'total': total, 'started': True})}\n\n"
    for i, path in enumerate(paths, 1):
        try:
            result = await loop.run_in_executor(
                None, lambda p=path: s.engine.process_image(p, vlm_provider)
            )
            payload = _build_payload(i, total, path, result=result)
        except Exception as e:
            logger.error(f"Error processing {path}: {e}")
            payload = _build_payload(i, total, path, error=e)
        yield f"data: {json.dumps(payload)}\n\n"
    yield f"data: {json.dumps({'done': True, 'total': total})}\n\n"


@router.post("/scan-folder")
def scan_folder(body: ScanFolderRequest):
    """Return list of image paths in a folder (no processing)."""
    paths = _get_image_paths(body.folder, body.recursive)
    return {"paths": paths, "count": len(paths)}


@router.post("/batch")
async def process_batch(body: BatchRequest, user=Depends(get_current_user)):
    s = _state_with_engine()
    paths = _get_image_paths(body.folder, body.recursive)
    vlm = get_effective_vlm_provider(user, s)
    return StreamingResponse(_stream_paths(paths, s, vlm), media_type="text/event-stream")


@router.post("/batch-files")
async def process_batch_files(body: BatchFilesRequest, user=Depends(get_current_user)):
    """Process an explicit list of file paths (multi-file drop)."""
    s = _state_with_engine()
    paths = [
        p for p in body.paths
        if Path(p).is_file() and Path(p).suffix.lower() in IMAGE_EXTENSIONS
    ]
    vlm = get_effective_vlm_provider(user, s)
    return StreamingResponse(_stream_paths(paths, s, vlm), media_type="text/event-stream")


@router.post("/train")
def train_person(body: TrainRequest):
    s = _state_with_engine()
    missing = [p for p in body.image_paths if not Path(p).exists()]
    if missing:
        raise HTTPException(status_code=400, detail=f"Files not found: {missing[:5]}")
    try:
        ok, msg, info = s.engine.train_person(body.person_name, body.image_paths)
        return {"ok": ok, "message": msg, "info": info}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/train/folder")
def train_from_folder(body: FolderTrainRequest):
    s = _state_with_engine()
    try:
        person_map = FolderTrainer.scan_training_folder(body.folder)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    results = {}
    for person_name, image_paths in person_map.items():
        try:
            ok, msg, info = s.engine.train_person(person_name, image_paths)
            results[person_name] = {"ok": ok, "message": msg, "count": len(image_paths)}
        except Exception as e:
            results[person_name] = {"ok": False, "message": str(e), "count": 0}

    return {"results": results, "people_count": len(results)}
