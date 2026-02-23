"""routers/albums.py — Album CRUD and image membership."""
import sqlite3
import logging
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel

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


def _ensure_tables(db_path: str):
    conn = None
    try:
        conn = _connect(db_path)
        conn.executescript("""
            CREATE TABLE IF NOT EXISTS albums (
                id              INTEGER PRIMARY KEY AUTOINCREMENT,
                name            TEXT NOT NULL UNIQUE,
                description     TEXT DEFAULT '',
                cover_image_id  INTEGER,
                created_at      TEXT DEFAULT CURRENT_TIMESTAMP,
                updated_at      TEXT DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE IF NOT EXISTS album_images (
                album_id   INTEGER NOT NULL,
                image_id   INTEGER NOT NULL,
                added_at   TEXT DEFAULT CURRENT_TIMESTAMP,
                sort_order INTEGER DEFAULT 0,
                PRIMARY KEY (album_id, image_id)
            );
            CREATE INDEX IF NOT EXISTS idx_album_images_album ON album_images(album_id);
            CREATE INDEX IF NOT EXISTS idx_album_images_image ON album_images(image_id);
        """)
        conn.commit()
    finally:
        if conn:
            conn.close()


# ── Models ────────────────────────────────────────────────────────────────────

class AlbumCreate(BaseModel):
    name: str
    description: str = ''

class AlbumUpdate(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    cover_image_id: Optional[int] = None

class ImageIds(BaseModel):
    image_ids: List[int]


# ── Routes ────────────────────────────────────────────────────────────────────

@router.get("")
def list_albums() -> List[Dict[str, Any]]:
    s = _state()
    _ensure_tables(s.db_path)
    conn = None
    try:
        conn = _connect(s.db_path)
        rows = conn.execute("""
            SELECT a.id, a.name, a.description, a.cover_image_id,
                   a.created_at, a.updated_at,
                   COUNT(ai.image_id) as image_count
            FROM albums a
            LEFT JOIN album_images ai ON a.id = ai.album_id
            GROUP BY a.id
            ORDER BY a.name COLLATE NOCASE
        """).fetchall()
        return [dict(r) for r in rows]
    finally:
        if conn:
            conn.close()


@router.post("")
def create_album(body: AlbumCreate) -> Dict[str, Any]:
    s = _state()
    _ensure_tables(s.db_path)
    conn = None
    try:
        conn = _connect(s.db_path)
        cur = conn.execute(
            "INSERT INTO albums (name, description) VALUES (?, ?)",
            (body.name.strip(), body.description.strip())
        )
        conn.commit()
        row = conn.execute(
            "SELECT *, 0 as image_count FROM albums WHERE id=?",
            (cur.lastrowid,)
        ).fetchone()
        return dict(row)
    except sqlite3.IntegrityError:
        raise HTTPException(status_code=409, detail=f"Album '{body.name}' already exists")
    finally:
        if conn:
            conn.close()


@router.put("/{album_id}")
def update_album(album_id: int, body: AlbumUpdate) -> Dict[str, Any]:
    s = _state()
    conn = None
    try:
        conn = _connect(s.db_path)
        existing = conn.execute("SELECT id FROM albums WHERE id=?", (album_id,)).fetchone()
        if not existing:
            raise HTTPException(status_code=404, detail="Album not found")
        updates = []
        vals = []
        if body.name is not None:
            updates.append("name=?")
            vals.append(body.name.strip())
        if body.description is not None:
            updates.append("description=?")
            vals.append(body.description.strip())
        if body.cover_image_id is not None:
            updates.append("cover_image_id=?")
            vals.append(body.cover_image_id)
        if updates:
            updates.append("updated_at=CURRENT_TIMESTAMP")
            vals.append(album_id)
            conn.execute(f"UPDATE albums SET {', '.join(updates)} WHERE id=?", vals)
            conn.commit()
        row = conn.execute("""
            SELECT a.*, COUNT(ai.image_id) as image_count
            FROM albums a LEFT JOIN album_images ai ON a.id = ai.album_id
            WHERE a.id=? GROUP BY a.id
        """, (album_id,)).fetchone()
        return dict(row)
    finally:
        if conn:
            conn.close()


@router.delete("/{album_id}")
def delete_album(album_id: int):
    s = _state()
    conn = None
    try:
        conn = _connect(s.db_path)
        r = conn.execute("DELETE FROM albums WHERE id=?", (album_id,))
        conn.commit()
        if r.rowcount == 0:
            raise HTTPException(status_code=404, detail="Album not found")
        return {"deleted": album_id}
    finally:
        if conn:
            conn.close()


@router.get("/{album_id}/images")
def list_album_images(
    album_id: int,
    sort:   str = Query('sort_order'),
    limit:  int = Query(500, ge=1, le=5000),
    offset: int = Query(0, ge=0),
) -> List[Dict[str, Any]]:
    s = _state()
    conn = None
    try:
        conn = _connect(s.db_path)
        album = conn.execute("SELECT id FROM albums WHERE id=?", (album_id,)).fetchone()
        if not album:
            raise HTTPException(status_code=404, detail="Album not found")

        order = "ai.sort_order ASC, ai.added_at ASC"
        if sort == 'newest':
            order = "COALESCE(i.taken_at, i.created_at) DESC"
        elif sort == 'oldest':
            order = "COALESCE(i.taken_at, i.created_at) ASC"

        rows = conn.execute(f"""
            SELECT i.id, i.filepath, i.filename, i.file_size,
                   i.taken_at, i.created_at, i.face_count,
                   i.ai_description, i.ai_scene_type, i.ai_tags,
                   i.width, i.height,
                   ai.sort_order, ai.added_at as album_added_at,
                   (SELECT GROUP_CONCAT(p.name, ', ')
                    FROM face_embeddings fe
                    JOIN faces f2 ON f2.id = fe.face_id
                    JOIN people p ON p.id = fe.person_id
                    WHERE f2.image_id = i.id AND fe.person_id IS NOT NULL
                   ) as people_names
            FROM album_images ai
            JOIN images i ON i.id = ai.image_id
            WHERE ai.album_id = ?
            ORDER BY {order}
            LIMIT ? OFFSET ?
        """, (album_id, limit, offset)).fetchall()
        return [dict(r) for r in rows]
    finally:
        if conn:
            conn.close()


@router.post("/{album_id}/images")
def add_images_to_album(album_id: int, body: ImageIds) -> Dict[str, Any]:
    s = _state()
    conn = None
    try:
        conn = _connect(s.db_path)
        album = conn.execute("SELECT id FROM albums WHERE id=?", (album_id,)).fetchone()
        if not album:
            raise HTTPException(status_code=404, detail="Album not found")
        added = 0
        for image_id in body.image_ids:
            r = conn.execute(
                "INSERT OR IGNORE INTO album_images (album_id, image_id) VALUES (?, ?)",
                (album_id, image_id)
            )
            added += r.rowcount
        conn.commit()
        return {"added": added, "album_id": album_id}
    finally:
        if conn:
            conn.close()


@router.delete("/{album_id}/images")
def remove_images_from_album(album_id: int, body: ImageIds) -> Dict[str, Any]:
    s = _state()
    conn = None
    try:
        conn = _connect(s.db_path)
        removed = 0
        for image_id in body.image_ids:
            r = conn.execute(
                "DELETE FROM album_images WHERE album_id=? AND image_id=?",
                (album_id, image_id)
            )
            removed += r.rowcount
        conn.commit()
        return {"removed": removed, "album_id": album_id}
    finally:
        if conn:
            conn.close()
