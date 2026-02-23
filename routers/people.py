"""
routers/people.py — People list, detail, rename, merge, delete.
"""
import sqlite3
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from routers.deps import require_admin_or_mediamanager

router = APIRouter()


def _state():
    from fastapi_app import state
    return state


def _connect(db_path: str):
    conn = sqlite3.connect(db_path, timeout=10.0)
    conn.execute("PRAGMA journal_mode = WAL")
    conn.row_factory = sqlite3.Row
    return conn


# ── Models ────────────────────────────────────────────────────────────────────

class RenamePersonRequest(BaseModel):
    name: str

class MergeRequest(BaseModel):
    source_id: int
    target_id: int

class ReassignFaceRequest(BaseModel):
    face_id: int
    new_name: str


# ── Routes ────────────────────────────────────────────────────────────────────

@router.get("")
def list_people() -> List[Dict[str, Any]]:
    s = _state()
    return s.engine.get_all_people()


@router.get("/{person_id}")
def get_person(person_id: int):
    s = _state()
    conn = None
    try:
        conn = _connect(s.db_path)
        row = conn.execute(
            "SELECT id, name, total_appearances, first_seen, last_seen, created_at "
            "FROM people WHERE id = ?", (person_id,)
        ).fetchone()
        if row is None:
            raise HTTPException(status_code=404, detail="Person not found")
        person = dict(row)

        images = conn.execute("""
            SELECT DISTINCT i.id, i.filepath, i.filename, i.taken_at,
                            i.face_count, i.ai_description,
                            fe.recognition_confidence
            FROM images i
            JOIN faces f ON i.id = f.image_id
            JOIN face_embeddings fe ON f.id = fe.face_id
            WHERE fe.person_id = ? AND fe.verified = 1
            ORDER BY i.taken_at DESC
        """, (person_id,)).fetchall()
        person['images'] = [dict(r) for r in images]
        return person
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        if conn:
            conn.close()


@router.put("/{person_id}")
def rename_person(person_id: int, body: RenamePersonRequest, _=Depends(require_admin_or_mediamanager)):
    s = _state()
    conn = None
    try:
        conn = _connect(s.db_path)
        existing = conn.execute("SELECT id FROM people WHERE id = ?", (person_id,)).fetchone()
        if existing is None:
            raise HTTPException(status_code=404, detail="Person not found")
        conn.execute(
            "UPDATE people SET name = ? WHERE id = ?",
            (body.name.strip(), person_id),
        )
        conn.commit()
        return {"ok": True}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        if conn:
            conn.close()


@router.post("/merge")
def merge_people(body: MergeRequest, _=Depends(require_admin_or_mediamanager)):
    """Move all face_embeddings from source_id to target_id, then delete source."""
    s = _state()
    conn = None
    try:
        conn = _connect(s.db_path)
        # Re-assign all embeddings
        conn.execute(
            "UPDATE face_embeddings SET person_id = ? WHERE person_id = ?",
            (body.target_id, body.source_id),
        )
        # Delete source person
        conn.execute("DELETE FROM people WHERE id = ?", (body.source_id,))
        conn.commit()
        return {"ok": True}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        if conn:
            conn.close()


@router.post("/reassign-face")
def do_reassign_face(body: ReassignFaceRequest, _=Depends(require_admin_or_mediamanager)):
    from image_ops import reassign_face
    import logging as _logging
    _log = _logging.getLogger(__name__)
    s = _state()
    ok, msg = reassign_face(s.db_path, body.face_id, body.new_name)
    if not ok:
        raise HTTPException(status_code=400, detail=msg)
    # Immediately rebuild the FAISS index so the next recognition query benefits
    # from this manual correction without waiting for the staleness poll.
    try:
        s.engine._load_faiss_index()
        _log.info(f"FAISS index reloaded after manual reassign (face_id={body.face_id} → '{body.new_name}')")
    except Exception as e:
        _log.warning(f"FAISS reload after reassign failed: {e}")
    return {"ok": True, "message": msg}


@router.delete("/{person_id}")
def delete_person(person_id: int, _=Depends(require_admin_or_mediamanager)):
    """Delete a person (keep images; remove embeddings and person record)."""
    s = _state()
    conn = None
    try:
        conn = _connect(s.db_path)
        existing = conn.execute("SELECT id FROM people WHERE id = ?", (person_id,)).fetchone()
        if existing is None:
            raise HTTPException(status_code=404, detail="Person not found")
        conn.execute("DELETE FROM face_embeddings WHERE person_id = ?", (person_id,))
        conn.execute("DELETE FROM people WHERE id = ?", (person_id,))
        conn.commit()
        return {"ok": True}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        if conn:
            conn.close()
