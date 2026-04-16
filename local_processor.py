#!/usr/bin/env python3
"""
local_processor.py — Electron local InsightFace subprocess.

Reads image paths from stdin (one per line, empty line or EOF = stop).
Outputs one NDJSON line per image to stdout.
All log/debug output goes to stderr so stdout stays clean.

Usage:
    INSIGHTFACE_MODEL=buffalo_l python3 local_processor.py

Environment:
    INSIGHTFACE_MODEL   InsightFace model name (default: buffalo_l)
    USE_COREML          '1' to enable CoreML on macOS (default: 1)
"""

import sys
import os
import json
import hashlib
import io
import base64
import platform
import traceback

# ── Model configuration ────────────────────────────────────────────────────────

MODEL_NAME = os.environ.get('INSIGHTFACE_MODEL', 'buffalo_l')
USE_COREML = os.environ.get('USE_COREML', '1') == '1'

# ── Lazy globals ───────────────────────────────────────────────────────────────

_analyzer = None

def get_analyzer():
    global _analyzer
    if _analyzer is not None:
        return _analyzer

    print(f'[local_processor] Loading InsightFace model: {MODEL_NAME}', file=sys.stderr, flush=True)

    try:
        from insightface.app import FaceAnalysis

        if platform.system() == 'Darwin' and USE_COREML:
            providers = ['CoreMLExecutionProvider', 'CPUExecutionProvider']
        else:
            providers = ['CPUExecutionProvider']

        _analyzer = FaceAnalysis(
            name=MODEL_NAME,
            allowed_modules=['detection', 'recognition'],
            providers=providers,
        )
        _analyzer.prepare(ctx_id=-1, det_size=(640, 640))
        print('[local_processor] Model ready', file=sys.stderr, flush=True)

    except ImportError as e:
        print(f'[local_processor] ERROR: {e}', file=sys.stderr, flush=True)
        print('[local_processor] Install: pip install insightface onnxruntime', file=sys.stderr, flush=True)
        raise

    return _analyzer


# ── Helpers ────────────────────────────────────────────────────────────────────

def compute_sha256(path: str) -> str:
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for chunk in iter(lambda: f.read(65536), b''):
            h.update(chunk)
    return h.hexdigest()


def make_thumbnail(img_rgb, size: int = 200) -> str:
    """Resize image (numpy RGB array) to size×size thumbnail, return base64 JPEG."""
    from PIL import Image
    pil = Image.fromarray(img_rgb)
    pil.thumbnail((size, size), Image.LANCZOS)
    buf = io.BytesIO()
    pil.save(buf, format='JPEG', quality=85)
    return base64.b64encode(buf.getvalue()).decode('ascii')


def extract_exif(path: str) -> dict:
    """Extract basic EXIF data using PIL."""
    result = {}
    try:
        from PIL import Image, ExifTags
        with Image.open(path) as pil:
            raw = pil._getexif() or {}
            tag_map = {v: k for k, v in ExifTags.TAGS.items()}
            wanted = {
                'DateTimeOriginal': 'taken_at',
                'DateTime':         'taken_at',
                'Make':             'camera_make',
                'Model':            'camera_model',
                'ISOSpeedRatings':  'iso',
                'ApertureValue':    'aperture',
                'ShutterSpeedValue':'shutter_speed',
                'FocalLength':      'focal_length',
                'GPSInfo':          'gps',
            }
            for exif_name, our_name in wanted.items():
                tag_id = tag_map.get(exif_name)
                if tag_id and tag_id in raw:
                    val = raw[tag_id]
                    if exif_name == 'GPSInfo':
                        # Skip GPS dict for now — complex to normalise
                        continue
                    if hasattr(val, 'numerator'):  # IFDRational
                        val = float(val)
                    result[our_name] = str(val) if not isinstance(val, (int, float)) else val
    except Exception as e:
        print(f'[local_processor] EXIF error for {path}: {e}', file=sys.stderr)
    return result


def process_image(path: str) -> dict:
    import cv2

    try:
        analyzer = get_analyzer()
    except Exception as e:
        return {'path': path, 'error': f'Model load failed: {e}'}

    try:
        img_bgr = cv2.imread(path)
        if img_bgr is None:
            return {'path': path, 'error': 'Cannot read image (unsupported format or missing file)'}

        h, w = img_bgr.shape[:2]
        img_rgb = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2RGB)

        # Face detection + embedding
        insightface_faces = analyzer.get(img_bgr)

        faces = []
        for face in insightface_faces:
            bbox = face.bbox  # [x1, y1, x2, y2] pixels
            emb  = face.normed_embedding  # 512D float32, already L2-normalized

            # Clamp to [0, 1]
            x1 = max(0.0, float(bbox[0]) / w)
            y1 = max(0.0, float(bbox[1]) / h)
            x2 = min(1.0, float(bbox[2]) / w)
            y2 = min(1.0, float(bbox[3]) / h)

            age    = int(face.age)    if hasattr(face, 'age')    and face.age    is not None else None
            gender = None
            if hasattr(face, 'gender') and face.gender is not None:
                gender = 'male' if int(face.gender) == 1 else 'female'

            faces.append({
                'bbox_left':             x1,
                'bbox_top':              y1,
                'bbox_right':            x2,
                'bbox_bottom':           y2,
                'detection_confidence':  float(face.det_score),
                'embedding':             emb.tolist(),
                'embedding_dimension':   len(emb),
                'age':                   age,
                'gender':                gender,
            })

        thumbnail_b64 = make_thumbnail(img_rgb)
        file_size     = os.path.getsize(path)
        file_hash     = compute_sha256(path)
        exif          = extract_exif(path)
        filename      = os.path.basename(path)

        return {
            'path':          path,
            'filename':      filename,
            'width':         w,
            'height':        h,
            'file_size':     file_size,
            'file_hash':     file_hash,
            'thumbnail_b64': thumbnail_b64,
            'exif':          exif,
            'faces':         faces,
        }

    except Exception as e:
        tb = traceback.format_exc()
        print(f'[local_processor] Error processing {path}:\n{tb}', file=sys.stderr)
        return {'path': path, 'error': str(e)}


# ── Main loop ──────────────────────────────────────────────────────────────────

def main():
    print(f'[local_processor] Started (model={MODEL_NAME})', file=sys.stderr, flush=True)

    for raw_line in sys.stdin:
        path = raw_line.rstrip('\n').rstrip('\r')
        if not path:
            break  # empty line = sentinel

        result = process_image(path)
        # One compact JSON per line, flushed immediately
        print(json.dumps(result, ensure_ascii=False), flush=True)

    print('[local_processor] Done', file=sys.stderr, flush=True)


if __name__ == '__main__':
    main()
