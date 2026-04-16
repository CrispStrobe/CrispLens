"""
routers/archive.py — Bildarchiv / Bildauswahl workflow for the Python FastAPI backend.

Endpoints mirror electron-app-v4/server/routes/archive.js.

POST /api/archive/organize       — organize image(s) to Bildarchiv or Bildauswahl
POST /api/archive/bildauswahl    — shorthand for Bildauswahl
POST /api/archive/rename-batch   — rename/re-sort archived images
POST /api/archive/write-exif     — write EXIF metadata via exiftool
GET  /api/archive/config         — get archive config
PUT  /api/archive/config         — update archive config (admin)
GET  /api/archive/choices        — existing field values for autocomplete
GET  /api/archive/resolve-path/{image_id}  — get best available path
GET  /api/archive/exiftool-status          — check if exiftool is available
"""

import json
import logging
import os
import re
import shutil
import sqlite3
import subprocess
import time
from datetime import datetime
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from routers.deps import get_current_user, require_admin


def _state():
    from fastapi_app import state  # pylint: disable=import-outside-toplevel
    return state


def _db_path() -> str:
    return _state().db_path

logger = logging.getLogger(__name__)
DEBUG = os.environ.get("DEBUG", "0") != "0"

def dbg(*args):
    """Log debug message if DEBUG env var is set."""
    if DEBUG:
        logger.debug("[archive] %s", " ".join(str(a) for a in args))

router = APIRouter()

# Whitelisted column names — never derived from user input
_ARCHIVE_PATH_COL: dict[str, str] = {
    "bildarchiv": "bildarchiv_path",
    "bildauswahl": "bildauswahl_path",
}
_CHOICES_FIELDS = ("fachbereich", "veranstaltungsnummer", "veranstaltungstitel", "urheber")

# ─── Default config ───────────────────────────────────────────────────────────

DEFAULT_FIELDS = [
    {"id": "fachbereich", "label": "Fachbereich", "type": "select",
     "choices": ["DIR", "ÖFA", "GES", "GUS", "HOH", "INZ", "IRD", "MMN", "NUT", "KUN", "RSP", "SUG"],
     "allow_custom": False, "required": False, "order": 1},
    {"id": "veranstaltungsnummer", "label": "Veranstaltungsnummer", "type": "text",
     "choices": [], "allow_custom": True, "required": False, "order": 2},
    {"id": "datum", "label": "Datum", "type": "date",
     "choices": [], "allow_custom": True, "required": False, "order": 3},
    {"id": "veranstaltungstitel", "label": "Veranstaltungstitel", "type": "text",
     "choices": [], "allow_custom": True, "required": False, "order": 4},
    {"id": "urheber", "label": "Urheber", "type": "text",
     "choices": [], "allow_custom": True, "required": False, "order": 5},
]

DEFAULT_EXIF_MAPPING = {
    "fachbereich":          ["Copyright"],
    "veranstaltungsnummer": [],
    "veranstaltungstitel":  [],
    "urheber":              ["Copyright", "XPCopyright"],
    "datum":                ["DateTimeOriginal", "CreateDate"],
}

DEFAULT_CONFIG = {
    "version": 1,
    "fields": DEFAULT_FIELDS,
    "bildarchiv": {
        "base_path": "/mnt/bildarchiv",
        "folder_template": "{fachbereich}/{year}/{veranstaltungstitel}",
        "filename_template": "{fachbereich}_{veranstaltungsnummer}_{year}_{month}_{description}_{counter}",
        "default_action": "copy",
        "create_jpg": False,
    },
    "bildauswahl": {
        "base_path": "/mnt/bildauswahl",
        "folder_template": "{fachbereich}/{year}/{veranstaltungstitel}",
        "filename_template": "{fachbereich}_{veranstaltungsnummer}_{year}_{month}_{names}_{counter}",
        "default_action": "copy",
        "create_jpg": False,
    },
    "exif_mapping": DEFAULT_EXIF_MAPPING,
}

# ─── DB helpers ───────────────────────────────────────────────────────────────

def _get_conn(db_path: str) -> sqlite3.Connection:
    conn = sqlite3.connect(db_path, timeout=10)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn

def _load_archive_config(conn: sqlite3.Connection) -> dict:
    try:
        # Ensure table exists
        conn.execute("""CREATE TABLE IF NOT EXISTS archive_config (
            key TEXT PRIMARY KEY, value TEXT, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )""")
        conn.commit()
        row = conn.execute("SELECT value FROM archive_config WHERE key='config'").fetchone()
        if row and row["value"]:
            stored = json.loads(row["value"])
            merged = {
                **DEFAULT_CONFIG,
                **stored,
                "bildarchiv":  {**DEFAULT_CONFIG["bildarchiv"],  **(stored.get("bildarchiv") or {})},
                "bildauswahl": {**DEFAULT_CONFIG["bildauswahl"], **(stored.get("bildauswahl") or {})},
                "exif_mapping": {**DEFAULT_CONFIG["exif_mapping"], **(stored.get("exif_mapping") or {})},
                "fields": stored.get("fields") or DEFAULT_CONFIG["fields"],
            }
            return merged
    except (sqlite3.Error, json.JSONDecodeError, KeyError, TypeError) as e:
        logger.error("[archive] _load_archive_config error: %s", e)
    return dict(DEFAULT_CONFIG)

def _save_archive_config(conn: sqlite3.Connection, config: dict):
    value = json.dumps({**config, "version": config.get("version", 1)})
    conn.execute("""
        INSERT INTO archive_config(key, value, updated_at) VALUES('config', ?, CURRENT_TIMESTAMP)
        ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at
    """, (value,))
    conn.commit()

# ─── Path / filename building ─────────────────────────────────────────────────

def _sanitize(s: str) -> str:
    if not s:
        return ""
    s = re.sub(r'[\\/:*?"<>|]', '_', s)
    s = re.sub(r'\s+', '_', s)
    s = re.sub(r'__+', '_', s)
    return s.strip('_')

def _year_month(date_val: str | None) -> tuple:
    if not date_val:
        now = datetime.now()
        return str(now.year), f"{now.month:02d}"
    try:
        for fmt in ('%Y-%m-%d', '%Y-%m-%dT%H:%M:%S', '%Y:%m:%d %H:%M:%S', '%Y-%m-%d %H:%M:%S'):
            try:
                d = datetime.strptime(date_val[:len(fmt)], fmt)
                return str(d.year), f"{d.month:02d}"
            except ValueError:
                continue
    except (TypeError, AttributeError):
        pass  # non-string or unexpected date_val type — fall through to now()
    now = datetime.now()
    return str(now.year), f"{now.month:02d}"

def _expand_template(template: str, tpl_vars: dict) -> str:
    def replacer(m):
        key = m.group(1)
        val = tpl_vars.get(key)
        return str(val) if val is not None and val != '' else ''
    return re.sub(r'\{([^}]+)\}', replacer, template)

def _build_folder_path(section_cfg: dict, meta: dict) -> str:
    year, month = _year_month(meta.get("datum"))
    tpl_vars = {
        "fachbereich":          _sanitize(meta.get("fachbereich") or ""),
        "veranstaltungstitel":  _sanitize(meta.get("veranstaltungstitel") or ""),
        "veranstaltungsnummer": _sanitize(meta.get("veranstaltungsnummer") or ""),
        "year": year, "month": month,
    }
    folder_rel = _expand_template(section_cfg["folder_template"], tpl_vars)
    # Remove empty segments
    folder_clean = "/".join(s for s in folder_rel.split("/") if s.strip())
    result = os.path.join(section_cfg["base_path"], folder_clean)
    dbg("_build_folder_path:", result)
    return result

def _build_filename(filename_tpl: str, meta: dict, dest_dir: str, ext: str) -> tuple:
    year, month = _year_month(meta.get("datum"))
    base_vars = {
        "fachbereich":          _sanitize(meta.get("fachbereich") or ""),
        "veranstaltungstitel":  _sanitize(meta.get("veranstaltungstitel") or ""),
        "veranstaltungsnummer": _sanitize(meta.get("veranstaltungsnummer") or ""),
        "description":          _sanitize(meta.get("description") or meta.get("names") or ""),
        "names":                _sanitize(meta.get("names") or meta.get("description") or ""),
        "year": year, "month": month,
    }
    for counter in range(1, 10000):
        counter_str = f"{counter:03d}"
        tpl_vars = {**base_vars, "counter": counter_str}
        raw_name = _expand_template(filename_tpl, tpl_vars)
        raw_name = "_".join(s for s in raw_name.split("_") if s.strip())
        raw_name = re.sub(r'__+', '_', raw_name)
        filename = raw_name + ext.lower()
        full_path = os.path.join(dest_dir, filename)
        if not os.path.exists(full_path):
            dbg(f"_build_filename: free slot {filename} counter={counter}")
            return filename, full_path, counter
    # Fallback
    ts = int(time.time())
    filename = f"archive_{ts}{ext}"
    return filename, os.path.join(dest_dir, filename), ts

def _get_person_names(conn: sqlite3.Connection, image_id: int) -> str:
    try:
        rows = conn.execute("""
            SELECT DISTINCT p.name FROM faces f
            JOIN face_embeddings fe ON fe.face_id = f.id
            JOIN people p ON p.id = fe.person_id
            WHERE f.image_id = ? AND fe.person_id IS NOT NULL AND p.name IS NOT NULL
            ORDER BY p.name
        """, (image_id,)).fetchall()
        if not rows:
            return ""
        last_names = [r["name"].strip().split()[-1] for r in rows]
        return "_".join(last_names)
    except sqlite3.Error as e:
        logger.error("[archive] _get_person_names error: %s", e)
        return ""

# ─── File ops ────────────────────────────────────────────────────────────────

def _organize_file_sync(source_path: str, dest_path: str, action: str) -> dict:
    dbg(f"_organize_file: {action} {source_path} → {dest_path}")
    if action == "leave":
        return {"ok": True, "action": action, "dest_path": source_path}
    if not os.path.exists(source_path):
        return {"ok": False, "action": action, "dest_path": None, "error": f"Source not found: {source_path}"}
    try:
        os.makedirs(os.path.dirname(dest_path), exist_ok=True)
        if action == "copy":
            shutil.copy2(source_path, dest_path)
            logger.info("[archive] Copied: %s → %s", source_path, dest_path)
        elif action == "move":
            shutil.move(source_path, dest_path)
            logger.info("[archive] Moved: %s → %s", source_path, dest_path)
        else:
            return {"ok": False, "action": action, "dest_path": None, "error": f"Unknown action: {action}"}
        return {"ok": True, "action": action, "dest_path": dest_path}
    except (OSError, shutil.Error) as e:
        logger.error("[archive] _organize_file error: %s", e)
        return {"ok": False, "action": action, "dest_path": None, "error": str(e)}

# ─── ExifTool ─────────────────────────────────────────────────────────────────

# Use a list as a mutable container so _check_exiftool avoids `global`
_exiftool_state: list[bool | None] = [None]

def _check_exiftool() -> bool:
    if _exiftool_state[0] is not None:
        return _exiftool_state[0]
    try:
        result = subprocess.run(["exiftool", "-ver"], capture_output=True, timeout=5, check=False)
        _exiftool_state[0] = result.returncode == 0
    except (OSError, subprocess.TimeoutExpired):
        _exiftool_state[0] = False
    if _exiftool_state[0]:
        logger.info("[archive] exiftool is available")
    else:
        logger.warning("[archive] exiftool not found — EXIF writing skipped")
    return _exiftool_state[0]

def _write_exif(file_path: str, fields: dict, exif_mapping: dict) -> dict:
    dbg(f"_write_exif: {file_path} fields={list(fields.keys())}")
    if not os.path.exists(file_path):
        return {"ok": False, "skipped": False, "reason": f"File not found: {file_path}", "tags": {}}
    if not _check_exiftool():
        return {"ok": True, "skipped": True, "reason": "exiftool not installed", "tags": {}}

    args = ["exiftool", "-overwrite_original", "-charset", "UTF8"]
    tags_written = {}

    for field_id, tag_names in exif_mapping.items():
        value = fields.get(field_id)
        if value is None or value == "":
            continue
        for tag_name in (tag_names if isinstance(tag_names, list) else [tag_names]):
            if "#" in tag_name:
                continue  # Skip positional array tags
            args.append(f"-{tag_name}={value}")
            tags_written[tag_name] = str(value)

    # Build XPSubject from combined parts
    xp_parts = [fields.get("fachbereich") or "", fields.get("veranstaltungsnummer") or "", fields.get("veranstaltungstitel") or ""]
    xp_parts = [p for p in xp_parts if p]
    if xp_parts:
        xp_val = "_".join(xp_parts)
        args.extend([f"-XPSubject={xp_val}", f"-Subject={xp_val}"])
        tags_written["XPSubject"] = xp_val

    args.append(file_path)
    dbg("exiftool args:", args[:-1])

    try:
        result = subprocess.run(args, capture_output=True, text=True, timeout=30, check=False)
        if result.stderr.strip():
            logger.warning("[archive] exiftool stderr: %s", result.stderr.strip())
        logger.info("[archive] _write_exif OK: %s tags=%s", file_path, list(tags_written.keys()))
        return {"ok": True, "skipped": False, "reason": "", "tags": tags_written}
    except (OSError, subprocess.TimeoutExpired) as e:
        logger.error("[archive] _write_exif error: %s", e)
        return {"ok": False, "skipped": False, "reason": str(e), "tags": tags_written}

# ─── Organize pipeline ────────────────────────────────────────────────────────

def _organize_image(conn: sqlite3.Connection, image_id: int, archive_cfg: dict,  # pylint: disable=too-many-locals,too-many-positional-arguments,too-many-arguments
                    meta: dict, archive_type: str, action: str, write_exif: bool) -> dict:
    logger.info("[archive] _organize_image: id=%s type=%s action=%s", image_id, archive_type, action)
    try:
        row = conn.execute(
            "SELECT filepath, local_path, filename FROM images WHERE id=?", (image_id,)
        ).fetchone()
        if not row:
            raise ValueError(f"Image {image_id} not found")

        source_path = None
        for p in [row["filepath"], row["local_path"]]:
            if p and os.path.exists(p):
                source_path = p
                break

        if not source_path and action != "leave":
            raise ValueError(f"No accessible file for image {image_id}")

        person_names = _get_person_names(conn, image_id)
        section_cfg = archive_cfg[archive_type]
        dest_dir = _build_folder_path(section_cfg, meta)
        ext = os.path.splitext(source_path or row["filename"] or ".jpg")[1] or ".jpg"

        meta_with_names = {**meta, "names": meta.get("names") or person_names, "description": meta.get("description") or person_names}
        filename, dest_path, _counter = _build_filename(section_cfg["filename_template"], meta_with_names, dest_dir, ext)

        file_result = {"ok": True, "dest_path": source_path}
        if action != "leave" and source_path:
            file_result = _organize_file_sync(source_path, dest_path, action)
            if not file_result["ok"]:
                raise ValueError(file_result["error"])

        final_path = file_result["dest_path"] or dest_path
        exif_result = {"ok": True, "skipped": True, "reason": "Not requested", "tags": {}}
        if write_exif and final_path and os.path.exists(final_path):
            exif_result = _write_exif(final_path, meta, archive_cfg.get("exif_mapping", {}))

        # Update DB — path_col comes from a whitelisted dict, never user input
        path_col = _ARCHIVE_PATH_COL[archive_type]  # KeyError if invalid archive_type
        sql = (
            f"UPDATE images SET {path_col}=?,"  # noqa: S608 — column from whitelist
            " fachbereich=COALESCE(?,fachbereich),"
            " veranstaltungsnummer=COALESCE(?,veranstaltungsnummer),"
            " veranstaltungstitel=COALESCE(?,veranstaltungstitel),"
            " urheber=COALESCE(?,urheber),"
            " datum_event=COALESCE(?,datum_event),"
            " updated_at=CURRENT_TIMESTAMP WHERE id=?"
        )
        try:
            conn.execute(sql, (
                final_path,
                meta.get("fachbereich"), meta.get("veranstaltungsnummer"),
                meta.get("veranstaltungstitel"), meta.get("urheber"),
                meta.get("datum"), image_id,
            ))
            conn.commit()
        except sqlite3.Error as db_err:
            logger.warning("[archive] DB update failed (possibly missing columns): %s", db_err)

        logger.info("[archive] _organize_image OK: id=%s → %s", image_id, final_path)
        return {"ok": True, "dest_path": final_path, "filename": filename, "exif": exif_result}

    except (ValueError, OSError, KeyError, sqlite3.Error) as e:
        logger.error("[archive] _organize_image FAILED id=%s: %s", image_id, e)
        return {"ok": False, "dest_path": None, "error": str(e), "exif": None}

# ─── Pydantic models ──────────────────────────────────────────────────────────

class ArchiveMeta(BaseModel):
    fachbereich: str | None = None
    veranstaltungsnummer: str | None = None
    veranstaltungstitel: str | None = None
    urheber: str | None = None
    datum: str | None = None
    description: str | None = None
    names: str | None = None

class OrganizeRequest(BaseModel):
    image_ids: list[int]
    meta: ArchiveMeta | None = None
    action: str = "copy"
    archive_type: str = "bildarchiv"
    write_exif: bool = False

class BildauswahlRequest(BaseModel):
    image_ids: list[int]
    meta: ArchiveMeta | None = None
    action: str = "copy"
    write_exif: bool = False

class RenameBatchRequest(BaseModel):
    image_ids: list[int]
    meta: ArchiveMeta | None = None
    archive_type: str = "bildarchiv"
    rename_file: bool = False

class WriteExifRequest(BaseModel):
    image_ids: list[int]
    fields: dict[str, Any] | None = None

# ─── Endpoints ────────────────────────────────────────────────────────────────

@router.get("/config")
def get_config(db_path: str = Depends(_db_path), _user=Depends(get_current_user)):
    """Return current archive configuration."""
    logger.info("[archive-routes] GET /config")
    conn = _get_conn(db_path)
    try:
        cfg = _load_archive_config(conn)
        return {"ok": True, "config": cfg}
    finally:
        conn.close()

@router.put("/config")
def put_config(body: dict, db_path: str = Depends(_db_path), _user=Depends(require_admin)):
    """Update archive configuration."""
    logger.info("[archive-routes] PUT /config keys=%s", list(body.keys()))
    if body.get("fields") and len(body["fields"]) > 10:
        raise HTTPException(status_code=400, detail="Maximum 10 custom fields allowed")
    conn = _get_conn(db_path)
    try:
        existing = _load_archive_config(conn)
        merged = {
            **existing, **body,
            "bildarchiv":  {**existing["bildarchiv"],  **(body.get("bildarchiv") or {})},
            "bildauswahl": {**existing["bildauswahl"], **(body.get("bildauswahl") or {})},
            "exif_mapping": {**existing["exif_mapping"], **(body.get("exif_mapping") or {})},
            "fields": body.get("fields") or existing["fields"],
        }
        _save_archive_config(conn, merged)
        return {"ok": True, "config": merged}
    finally:
        conn.close()

@router.get("/choices")
def get_choices(db_path: str = Depends(_db_path), _user=Depends(get_current_user)):
    """Return available choices for archive metadata fields."""
    logger.info("[archive-routes] GET /choices")
    conn = _get_conn(db_path)
    try:
        choices = {}
        # _CHOICES_FIELDS is a module-level tuple of hardcoded safe column names
        for field in _CHOICES_FIELDS:
            col = field  # confirmed member of whitelist
            sql = (
                f"SELECT DISTINCT {col} as val FROM images"  # noqa: S608 — col from whitelist
                f" WHERE {col} IS NOT NULL AND {col} != '' ORDER BY {col}"
            )
            try:
                rows = conn.execute(sql).fetchall()
                choices[field] = [r["val"] for r in rows]
            except sqlite3.Error:
                choices[field] = []
        return {"ok": True, "choices": choices}
    finally:
        conn.close()

@router.post("/organize")
def organize(body: OrganizeRequest, db_path: str = Depends(_db_path), _user=Depends(get_current_user)):
    """Organize images into bildarchiv by copying/moving and updating metadata."""
    logger.info("[archive-routes] POST /organize ids=%s action=%s type=%s", body.image_ids, body.action, body.archive_type)
    if body.action not in ("copy", "move", "leave"):
        raise HTTPException(status_code=400, detail="action must be copy | move | leave")
    if body.archive_type not in ("bildarchiv", "bildauswahl"):
        raise HTTPException(status_code=400, detail="archive_type must be bildarchiv | bildauswahl")
    conn = _get_conn(db_path)
    try:
        archive_cfg = _load_archive_config(conn)
        meta = body.meta.dict() if body.meta else {}
        results = [
            {"image_id": iid, **_organize_image(conn, iid, archive_cfg, meta, body.archive_type, body.action, body.write_exif)}
            for iid in body.image_ids
        ]
        success_count = sum(1 for r in results if r.get("ok"))
        return {"ok": True, "results": results, "success_count": success_count, "error_count": len(results) - success_count}
    finally:
        conn.close()

@router.post("/bildauswahl")
def bildauswahl(body: BildauswahlRequest, db_path: str = Depends(_db_path), _user=Depends(get_current_user)):
    """Organize images into bildauswahl archive."""
    logger.info("[archive-routes] POST /bildauswahl ids=%s action=%s", body.image_ids, body.action)
    if body.action not in ("copy", "move", "leave"):
        raise HTTPException(status_code=400, detail="action must be copy | move | leave")
    conn = _get_conn(db_path)
    try:
        archive_cfg = _load_archive_config(conn)
        meta = body.meta.dict() if body.meta else {}
        results = [
            {"image_id": iid, **_organize_image(conn, iid, archive_cfg, meta, "bildauswahl", body.action, body.write_exif)}
            for iid in body.image_ids
        ]
        success_count = sum(1 for r in results if r.get("ok"))
        return {"ok": True, "results": results, "success_count": success_count, "error_count": len(results) - success_count}
    finally:
        conn.close()

@router.post("/rename-batch")
def rename_batch(body: RenameBatchRequest, db_path: str = Depends(_db_path), _user=Depends(get_current_user)):  # pylint: disable=too-many-locals
    """Rename files in batch using archive path template."""
    logger.info("[archive-routes] POST /rename-batch ids=%s type=%s rename_file=%s", body.image_ids, body.archive_type, body.rename_file)
    if body.archive_type not in _ARCHIVE_PATH_COL:
        raise HTTPException(status_code=400, detail="archive_type must be bildarchiv | bildauswahl")
    conn = _get_conn(db_path)
    try:
        archive_cfg = _load_archive_config(conn)
        meta = body.meta.dict() if body.meta else {}
        results = []
        path_col = _ARCHIVE_PATH_COL[body.archive_type]  # from whitelist
        for iid in body.image_ids:
            try:
                sql_sel = (
                    f"SELECT {path_col}, filepath, local_path, filename FROM images WHERE id=?"  # noqa: S608
                )
                row = conn.execute(sql_sel, (iid,)).fetchone()
                if not row:
                    results.append({"image_id": iid, "ok": False, "error": "Not found"})
                    continue
                existing_path = row[path_col]
                person_names = _get_person_names(conn, iid)
                meta_with_names = {
                    **meta,
                    "names": meta.get("names") or person_names,
                    "description": meta.get("description") or person_names,
                }

                new_path = existing_path
                if body.rename_file and existing_path and os.path.exists(existing_path):
                    section_cfg = archive_cfg[body.archive_type]
                    ext = os.path.splitext(existing_path)[1] or ".jpg"
                    dest_dir = _build_folder_path(section_cfg, meta)
                    os.makedirs(dest_dir, exist_ok=True)
                    _fname, full_path, _ = _build_filename(section_cfg["filename_template"], meta_with_names, dest_dir, ext)
                    if full_path != existing_path:
                        shutil.move(existing_path, full_path)
                        new_path = full_path
                        sql_upd = f"UPDATE images SET {path_col}=?, updated_at=CURRENT_TIMESTAMP WHERE id=?"  # noqa: S608
                        conn.execute(sql_upd, (new_path, iid))

                conn.execute("""
                    UPDATE images SET
                        fachbereich=COALESCE(?,fachbereich), veranstaltungsnummer=COALESCE(?,veranstaltungsnummer),
                        veranstaltungstitel=COALESCE(?,veranstaltungstitel), urheber=COALESCE(?,urheber),
                        datum_event=COALESCE(?,datum_event), updated_at=CURRENT_TIMESTAMP WHERE id=?
                """, (meta.get("fachbereich"), meta.get("veranstaltungsnummer"), meta.get("veranstaltungstitel"),
                      meta.get("urheber"), meta.get("datum"), iid))
                conn.commit()
                results.append({"image_id": iid, "ok": True, "old_path": existing_path, "new_path": new_path})
            except (OSError, sqlite3.Error, shutil.Error, KeyError, ValueError) as e:
                logger.error("[archive] rename_batch error id=%s: %s", iid, e)
                results.append({"image_id": iid, "ok": False, "error": str(e)})
        return {"ok": True, "results": results, "success_count": sum(1 for r in results if r.get("ok"))}
    finally:
        conn.close()

@router.post("/write-exif")
def write_exif_endpoint(body: WriteExifRequest, db_path: str = Depends(_db_path), _user=Depends(get_current_user)):
    """Write archive metadata to image EXIF using exiftool."""
    logger.info("[archive-routes] POST /write-exif ids=%s", body.image_ids)
    exif_available = _check_exiftool()
    conn = _get_conn(db_path)
    try:
        archive_cfg = _load_archive_config(conn)
        results = []
        for iid in body.image_ids:
            row = conn.execute(
                "SELECT filepath, local_path, bildarchiv_path, bildauswahl_path FROM images WHERE id=?", (iid,)
            ).fetchone()
            if not row:
                results.append({"image_id": iid, "ok": False, "error": "Not found"})
                continue
            target_path = next(
                (p for p in [row.get("bildarchiv_path"), row.get("bildauswahl_path"), row.get("filepath"), row.get("local_path")]
                 if p and os.path.exists(p)), None
            )
            if not target_path:
                results.append({"image_id": iid, "ok": False, "skipped": True, "reason": "No accessible file"})
                continue
            r = _write_exif(target_path, body.fields or {}, archive_cfg.get("exif_mapping", {}))
            results.append({"image_id": iid, "path": target_path, **r})
        return {"ok": True, "exiftool_available": exif_available, "results": results}
    finally:
        conn.close()

@router.get("/resolve-path/{image_id}")
def resolve_path(image_id: int, db_path: str = Depends(_db_path), _user=Depends(get_current_user)):
    """Resolve the archive destination path for a given image."""
    logger.info("[archive-routes] GET /resolve-path/%s", image_id)
    conn = _get_conn(db_path)
    try:
        row = conn.execute(
            "SELECT filepath, local_path, bildarchiv_path, bildauswahl_path FROM images WHERE id=?", (image_id,)
        ).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Image not found")
        for source, p in [("bildarchiv", row.get("bildarchiv_path")), ("bildauswahl", row.get("bildauswahl_path")),
                           ("original", row.get("filepath")), ("original", row.get("local_path"))]:
            if p and os.path.exists(p):
                return {"ok": True, "path": p, "source": source}
        raise HTTPException(status_code=404, detail="No accessible file for this image")
    finally:
        conn.close()

@router.get("/exiftool-status")
def exiftool_status(_user=Depends(get_current_user)):
    """Return exiftool availability status."""
    available = _check_exiftool()
    return {"ok": True, "available": available}
