"""
routers/face_cluster.py — Unidentified face listing, clustering, face-crop, batch assign.

Endpoints:
  GET  /api/faces/unidentified          — all faces with no/low-confidence person
  GET  /api/faces/clusters?threshold=0.55 — greedy cosine-similarity clusters
  GET  /api/images/{id}/face-crop?face_id={fid}&size=128 — cropped JPEG for a face
  POST /api/faces/assign-cluster        — assign person to a list of face_ids
"""
import io
import os
import sqlite3
import logging
from typing import Any, Dict, List, Optional

import numpy as np

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import Response
from pydantic import BaseModel

from routers.deps import get_current_user, require_admin_or_mediamanager

logger = logging.getLogger(__name__)
router = APIRouter()


def _state():
    from fastapi_app import state
    return state


def _connect(db_path: str) -> sqlite3.Connection:
    conn = sqlite3.connect(db_path, timeout=10.0)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    return conn


# ── Models ────────────────────────────────────────────────────────────────────

class AssignClusterRequest(BaseModel):
    face_ids: List[int]
    person_name: str


# ── Helpers ───────────────────────────────────────────────────────────────────

def _cosine_similarity(a: np.ndarray, b: np.ndarray) -> float:
    """Cosine similarity between two 1-D vectors (normalised for speed)."""
    norm_a = np.linalg.norm(a)
    norm_b = np.linalg.norm(b)
    if norm_a == 0 or norm_b == 0:
        return 0.0
    return float(np.dot(a, b) / (norm_a * norm_b))


def _load_faces(db_path: str, user=None, unidentified_only: bool = True) -> List[Dict[str, Any]]:
    """Return face records with embedding bytes.

    When *unidentified_only* is True (default) only faces with no confirmed
    person assignment are returned.  When False, all detected faces are
    returned (useful for clustering everything together to spot duplicates or
    group already-identified people for review).

    Only returns faces from images accessible to *user*.  Admins see all.
    """
    conn = None
    try:
        conn = _connect(db_path)

        if user is None or user.role == 'admin':
            access_clause = ""
            params: tuple = ()
        else:
            uid = user.id
            access_clause = """
              AND (i.visibility = 'shared' OR i.visibility IS NULL
                   OR i.owner_id = ?
                   OR EXISTS (
                       SELECT 1 FROM image_shares s
                       WHERE s.image_id = i.id AND s.user_id = ?
                   ))
            """
            params = (uid, uid)

        identity_filter = (
            "AND (fe.person_id IS NULL OR fe.recognition_confidence < 0.5)"
            if unidentified_only else ""
        )

        rows = conn.execute(f"""
            SELECT
                f.id AS face_id,
                f.image_id,
                f.bbox_top, f.bbox_right, f.bbox_bottom, f.bbox_left,
                f.detection_confidence,
                f.face_quality,
                fe.id AS embedding_id,
                fe.embedding_vector,
                fe.person_id,
                p.name AS person_name
            FROM faces f
            JOIN images i ON f.image_id = i.id
            LEFT JOIN face_embeddings fe ON f.id = fe.face_id
            LEFT JOIN people p ON fe.person_id = p.id
            WHERE f.image_id IS NOT NULL
              {identity_filter}
              {access_clause}
            ORDER BY f.face_quality DESC NULLS LAST
        """, params).fetchall()
        return [dict(r) for r in rows]
    finally:
        if conn:
            conn.close()


def _load_unidentified(db_path: str, user=None) -> List[Dict[str, Any]]:
    """Backward-compatible wrapper — returns only unidentified faces."""
    return _load_faces(db_path, user, unidentified_only=True)


# ── Routes ────────────────────────────────────────────────────────────────────

@router.get("/unidentified")
def list_unidentified_faces(
    limit: int = Query(500, ge=1, le=5000),
    user=Depends(get_current_user),
) -> List[Dict[str, Any]]:
    """Return all faces that have no identified person (or very low confidence)."""
    s = _state()
    faces = _load_unidentified(s.db_path, user)[:limit]
    # Strip raw embedding bytes from response
    for f in faces:
        f.pop('embedding_vector', None)
        f['bbox'] = {
            'top':    f.pop('bbox_top'),
            'right':  f.pop('bbox_right'),
            'bottom': f.pop('bbox_bottom'),
            'left':   f.pop('bbox_left'),
        }
    return faces


@router.get("/clusters")
def get_face_clusters(
    threshold: float = Query(0.55, ge=0.0, le=1.0),
    limit: int = Query(500, ge=1, le=5000),
    include_identified: bool = Query(False, description="Include already-identified faces"),
    user=Depends(get_current_user),
) -> List[Dict[str, Any]]:
    """
    Group faces into clusters by embedding cosine similarity.
    By default only unidentified faces are clustered.  Pass
    include_identified=true to cluster ALL faces (useful for reviewing
    existing identifications or spotting mis-identified groups).
    Uses a greedy O(n²) algorithm — suitable for up to ~5000 faces.
    Faces without embeddings are placed each in their own singleton cluster.
    """
    s = _state()
    raw = _load_faces(s.db_path, user, unidentified_only=not include_identified)[:limit]

    # Separate faces with / without embeddings
    with_emb = []
    without_emb = []
    for f in raw:
        emb_bytes = f.get('embedding_vector')
        if emb_bytes:
            try:
                vec = np.frombuffer(emb_bytes, dtype=np.float32).copy()
                with_emb.append((f, vec))
            except Exception:
                without_emb.append(f)
        else:
            without_emb.append(f)

    # Greedy clustering
    clusters: List[List[Dict]] = []
    cluster_centroids: List[np.ndarray] = []

    for face, vec in with_emb:
        best_idx = -1
        best_sim = threshold
        for ci, centroid in enumerate(cluster_centroids):
            sim = _cosine_similarity(vec, centroid)
            if sim > best_sim:
                best_sim = sim
                best_idx = ci

        face_info = {
            'face_id':   face['face_id'],
            'image_id':  face['image_id'],
            'bbox': {
                'top':    face['bbox_top'],
                'right':  face['bbox_right'],
                'bottom': face['bbox_bottom'],
                'left':   face['bbox_left'],
            },
            'face_quality':         face['face_quality'],
            'detection_confidence': face['detection_confidence'],
            'person_name':          face.get('person_name'),  # populated when include_identified=True
        }

        if best_idx >= 0:
            clusters[best_idx].append(face_info)
            # Update centroid: running average
            n = len(clusters[best_idx])
            cluster_centroids[best_idx] = (cluster_centroids[best_idx] * (n - 1) + vec) / n
        else:
            clusters.append([face_info])
            cluster_centroids.append(vec.copy())

    # Add singleton clusters for faces without embeddings
    for face in without_emb:
        clusters.append([{
            'face_id':   face['face_id'],
            'image_id':  face['image_id'],
            'bbox': {
                'top':    face['bbox_top'],
                'right':  face['bbox_right'],
                'bottom': face['bbox_bottom'],
                'left':   face['bbox_left'],
            },
            'face_quality':         face['face_quality'],
            'detection_confidence': face['detection_confidence'],
            'person_name':          face.get('person_name'),   # None for unidentified
        }])

    # Sort by cluster size descending
    clusters.sort(key=lambda c: len(c), reverse=True)

    return [
        {'cluster_id': i, 'size': len(c), 'faces': c}
        for i, c in enumerate(clusters)
    ]


@router.get("/face-crop")
def get_face_crop(
    image_id: int = Query(...),
    face_id:  int = Query(...),
    size:     int = Query(128, ge=32, le=512),
    user=Depends(get_current_user),
) -> Response:
    """Return a square JPEG crop of the specified face region."""
    s = _state()
    from routers.deps import can_access_image
    if not can_access_image(image_id, user, s.db_path):
        raise HTTPException(status_code=403, detail="Access denied")

    try:
        from PIL import Image as PILImage
    except ImportError:
        raise HTTPException(status_code=500, detail="Pillow not installed")

    conn = None
    try:
        conn = _connect(s.db_path)
        face_row = conn.execute(
            "SELECT bbox_top, bbox_right, bbox_bottom, bbox_left FROM faces WHERE id=? AND image_id=?",
            (face_id, image_id)
        ).fetchone()
        if not face_row:
            raise HTTPException(status_code=404, detail="Face not found")

        img_row = conn.execute(
            "SELECT filepath, thumbnail_blob FROM images WHERE id=?",
            (image_id,)
        ).fetchone()
        if not img_row:
            raise HTTPException(status_code=404, detail="Image not found")
    finally:
        if conn:
            conn.close()

    filepath = img_row['filepath']
    try:
        if os.path.exists(filepath):
            img = PILImage.open(filepath)
        else:
            # Fallback for locally-imported images: filepath is the original Mac path
            # which does not exist on the VPS. Crop from the stored thumbnail instead.
            thumb_data = img_row['thumbnail_blob']
            if not thumb_data:
                thumb_path = os.path.join(s.thumb_dir, f'{image_id}_200.jpg')
                if os.path.exists(thumb_path):
                    with open(thumb_path, 'rb') as _tf:
                        thumb_data = _tf.read()
            if not thumb_data:
                raise HTTPException(status_code=404, detail="Image file not found on disk")
            img = PILImage.open(io.BytesIO(thumb_data))
        w, h = img.size

        # bbox is normalised 0-1
        top    = face_row['bbox_top']
        right  = face_row['bbox_right']
        bottom = face_row['bbox_bottom']
        left   = face_row['bbox_left']

        # Convert to pixel coords with a small padding
        pad = 0.08
        x0 = max(0, int((left   - pad) * w))
        y0 = max(0, int((top    - pad) * h))
        x1 = min(w, int((right  + pad) * w))
        y1 = min(h, int((bottom + pad) * h))

        # Square crop
        cw = x1 - x0
        ch = y1 - y0
        if cw > ch:
            diff = cw - ch
            y0 = max(0, y0 - diff // 2)
            y1 = min(h, y1 + diff // 2)
        elif ch > cw:
            diff = ch - cw
            x0 = max(0, x0 - diff // 2)
            x1 = min(w, x1 + diff // 2)

        crop = img.crop((x0, y0, x1, y1)).resize((size, size), PILImage.LANCZOS)
        if crop.mode not in ('RGB', 'L'):
            crop = crop.convert('RGB')

        buf = io.BytesIO()
        crop.save(buf, format='JPEG', quality=85)
        buf.seek(0)
        return Response(content=buf.getvalue(), media_type='image/jpeg')
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Crop failed: {e}")


@router.post("/assign-cluster")
def assign_cluster(body: AssignClusterRequest, _user=Depends(get_current_user)) -> Dict[str, Any]:
    """
    Assign person_name to a list of face_ids.
    Creates or finds the person, then calls reassign_face for each face.
    """
    s = _state()
    if not body.face_ids:
        return {"assigned": 0}
    if not body.person_name.strip():
        raise HTTPException(status_code=400, detail="person_name is required")

    from image_ops import reassign_face
    assigned = 0
    for face_id in body.face_ids:
        ok, _ = reassign_face(s.db_path, face_id, body.person_name.strip())
        if ok:
            assigned += 1

    # Refresh FAISS index
    try:
        s.engine.load_known_faces()
    except Exception:
        pass

    return {"assigned": assigned, "person_name": body.person_name.strip()}
