"""
image_ops.py — Image metadata read/write operations.

All public functions accept explicit parameters (db_path, image_id, …)
rather than relying on global state.  This makes them trivial to expose
as FastAPI / REST endpoints in Phase B without any refactoring.

Phase-B API mapping (for reference):
  get_image_record(db_path, id)            → GET   /api/images/{id}
  update_image_metadata(db_path, id, …)   → PATCH  /api/images/{id}/metadata
  rename_image(db_path, id, name)          → POST   /api/images/{id}/rename
  browse_images_filtered(db_path, …)      → GET   /api/images?<filters>
  get_all_tags(db_path)                    → GET   /api/tags
  get_all_scene_types(db_path)             → GET   /api/scenes
  get_all_person_names(db_path)            → GET   /api/people
  get_or_create_thumbnail(id, path, dir)   → GET   /api/images/{id}/thumbnail
  read_exif(filepath)                      → GET   /api/images/{id}/exif
"""

import io
import json
import logging
import os
import sqlite3
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

logger = logging.getLogger(__name__)

try:
    from PIL import Image
    from PIL.ExifTags import GPSTAGS, TAGS
    PIL_AVAILABLE = True
except ImportError:
    PIL_AVAILABLE = False

# Scene types understood by the VLM prompt; used to populate dropdowns.
SCENE_TYPES = [
    '', 'indoor', 'outdoor', 'portrait', 'group',
    'landscape', 'event', 'nature', 'urban', 'other',
]


# ─────────────────────────────────────────────────────────────────────────────
# EXIF helpers
# ─────────────────────────────────────────────────────────────────────────────

def _rational_to_float(val) -> Optional[float]:
    """Convert IFDRational / (num, denom) tuple / plain number to float."""
    try:
        if hasattr(val, 'numerator'):
            return float(val.numerator) / float(val.denominator) if val.denominator else None
        if isinstance(val, tuple) and len(val) == 2:
            return float(val[0]) / float(val[1]) if val[1] else None
        return float(val)
    except Exception:
        return None


def _format_shutter(val) -> Optional[str]:
    f = _rational_to_float(val)
    if f is None:
        return None
    if f >= 1:
        return f"{f:.1f} s"
    denom = round(1 / f)
    return f"1/{denom} s"


def _parse_gps_coord(vals, ref: str) -> Optional[float]:
    try:
        d = _rational_to_float(vals[0])
        m = _rational_to_float(vals[1])
        s = _rational_to_float(vals[2])
        if None in (d, m, s):
            return None
        dec = d + m / 60 + s / 3600
        if ref in ('S', 'W'):
            dec = -dec
        return round(dec, 6)
    except Exception:
        return None


def read_exif(filepath: str) -> Dict[str, Any]:
    """
    Read EXIF metadata from an image file using Pillow.

    Returns a dict with well-known keys plus:
      _all   – dict of all human-readable tags (strings, safe to JSON-encode)
      _error – error message string if reading failed

    Phase-B API: GET /api/images/{id}/exif
    """
    result: Dict[str, Any] = {}
    if not PIL_AVAILABLE:
        result['_error'] = 'Pillow not installed'
        return result
    try:
        with Image.open(filepath) as img:
            result['width']  = img.width
            result['height'] = img.height
            result['format'] = img.format or Path(filepath).suffix.upper().lstrip('.')
            result['mode']   = img.mode

            exif = img.getexif()
            if not exif:
                return result

            raw: Dict[str, Any] = {}
            for tag_id, value in exif.items():
                raw[TAGS.get(tag_id, str(tag_id))] = value

            result['date_taken']   = (raw.get('DateTimeOriginal')
                                      or raw.get('DateTime')
                                      or raw.get('DateTimeDigitized'))
            result['camera_make']  = str(raw.get('Make',  '')).strip() or None
            result['camera_model'] = str(raw.get('Model', '')).strip() or None
            result['software']     = str(raw.get('Software', '')).strip() or None
            result['artist']       = str(raw.get('Artist',   '')).strip() or None
            result['copyright']    = str(raw.get('Copyright',''))  .strip() or None
            result['orientation']  = raw.get('Orientation')
            result['image_description'] = (
                str(raw.get('ImageDescription') or raw.get('UserComment') or '').strip() or None
            )

            iso = raw.get('ISOSpeedRatings') or raw.get('PhotographicSensitivity')
            result['iso'] = int(iso) if iso else None

            fl = _rational_to_float(raw.get('FocalLength'))
            result['focal_length_mm'] = round(fl, 1) if fl is not None else None

            fn = _rational_to_float(raw.get('FNumber'))
            result['aperture_f'] = round(fn, 1) if fn is not None else None

            result['shutter_speed'] = _format_shutter(raw.get('ExposureTime'))

            exp_bias = _rational_to_float(raw.get('ExposureBiasValue'))
            result['exposure_bias'] = round(exp_bias, 2) if exp_bias is not None else None

            result['flash'] = raw.get('Flash')
            result['white_balance'] = raw.get('WhiteBalance')

            # GPS
            gps_ifd = exif.get_ifd(0x8825)
            if gps_ifd:
                gps: Dict[str, Any] = {}
                for tag_id, value in gps_ifd.items():
                    gps[GPSTAGS.get(tag_id, str(tag_id))] = value
                lat = _parse_gps_coord(
                    gps.get('GPSLatitude',  []),
                    gps.get('GPSLatitudeRef',  'N'),
                )
                lng = _parse_gps_coord(
                    gps.get('GPSLongitude', []),
                    gps.get('GPSLongitudeRef', 'E'),
                )
                if lat is not None and lng is not None:
                    result['gps_lat'] = lat
                    result['gps_lng'] = lng
                result['gps_altitude'] = _rational_to_float(gps.get('GPSAltitude'))

            # Safe full dump (skip bytes / MakerNote)
            result['_all'] = {
                k: str(v)
                for k, v in raw.items()
                if not isinstance(v, (bytes, bytearray)) and k != 'MakerNote'
            }
    except Exception as e:
        result['_error'] = str(e)
    return result


def format_exif_as_markdown(exif: Dict[str, Any]) -> str:
    """
    Render EXIF dict as a two-column markdown table.
    Returns a plain italic message if no data is available.
    """
    if '_error' in exif:
        return f"_EXIF read error: {exif['_error']}_"

    rows: List[str] = []

    def add(label: str, val: Any):
        if val is not None and str(val).strip() not in ('', 'None'):
            rows.append(f"| {label} | {val} |")

    w, h = exif.get('width'), exif.get('height')
    add("Dimensions",    f"{w} × {h} px" if w and h else None)
    add("Format",        exif.get('format'))
    add("Date taken",    exif.get('date_taken'))

    cam = ' '.join(filter(None, [exif.get('camera_make'), exif.get('camera_model')]))
    add("Camera",        cam or None)
    add("ISO",           exif.get('iso'))
    add("Aperture",      f"f/{exif.get('aperture_f')}" if exif.get('aperture_f') else None)
    add("Shutter",       exif.get('shutter_speed'))
    add("Focal length",  f"{exif.get('focal_length_mm')} mm" if exif.get('focal_length_mm') else None)
    add("Exposure bias", f"{exif.get('exposure_bias')} EV" if exif.get('exposure_bias') is not None else None)

    if exif.get('gps_lat') is not None:
        add("GPS", f"{exif['gps_lat']}, {exif['gps_lng']}")
    if exif.get('gps_altitude') is not None:
        add("Altitude", f"{round(exif['gps_altitude'])} m")

    add("Software",    exif.get('software'))
    add("Artist",      exif.get('artist'))
    add("Copyright",   exif.get('copyright'))
    add("Description", exif.get('image_description'))

    if not rows:
        return "_No EXIF data found in this file._"
    return "| Field | Value |\n|---|---|\n" + "\n".join(rows)


# ─────────────────────────────────────────────────────────────────────────────
# Database helpers
# ─────────────────────────────────────────────────────────────────────────────

def _connect(db_path: str, timeout: float = 5.0) -> sqlite3.Connection:
    conn = sqlite3.connect(db_path, timeout=timeout)
    conn.execute("PRAGMA journal_mode = WAL")
    conn.row_factory = sqlite3.Row
    return conn


# ─────────────────────────────────────────────────────────────────────────────
# Image record
# ─────────────────────────────────────────────────────────────────────────────

def get_image_record(db_path: str, image_id: int) -> Optional[Dict[str, Any]]:
    """
    Return the full DB record for one image, augmented with:
      detected_people  – list of {name, conf} dicts
      db_tags          – list of {name, confidence, source} from image_tags table
      ai_tags_list     – parsed list[str] from images.ai_tags JSON

    Phase-B API: GET /api/images/{image_id}
    """
    try:
        conn = _connect(db_path)
        # Explicitly list columns to avoid large BLOBs in the metadata JSON
        columns = [
            "id", "filepath", "filename", "file_hash", "file_size",
            "width", "height", "format", "taken_at", "location_lat",
            "location_lng", "location_name", "camera_make", "camera_model",
            "iso", "aperture", "shutter_speed", "focal_length",
            "ai_description", "ai_scene_type", "ai_tags", "ai_confidence",
            "ai_provider", "processed", "processing_error", "face_count",
            "metadata_written", "created_at", "updated_at", "processed_at",
            "local_path", "owner_id", "visibility",
        ]
        col_str = ", ".join(columns)
        row = conn.execute(f"SELECT {col_str} FROM images WHERE id = ?", (image_id,)).fetchone()
        if row is None:
            conn.close()
            return None
        record = dict(row)
        record['server_path'] = record.get('filepath')
        record['origin_path'] = record.get('local_path')

        people_rows = conn.execute("""
            SELECT 
                f.id as face_id,
                p.id as person_id,
                p.name, 
                fe.recognition_confidence as conf,
                f.bbox_top, f.bbox_right, f.bbox_bottom, f.bbox_left
            FROM faces f
            LEFT JOIN face_embeddings fe ON f.id = fe.face_id
            LEFT JOIN people p ON fe.person_id = p.id
            WHERE f.image_id = ?
            ORDER BY f.id
        """, (image_id,)).fetchall()
        record['detected_people'] = [dict(r) for r in people_rows]

        tag_rows = conn.execute("""
            SELECT t.name, it.confidence, it.source
            FROM image_tags it
            JOIN tags t ON it.tag_id = t.id
            WHERE it.image_id = ?
            ORDER BY it.confidence DESC
        """, (image_id,)).fetchall()
        record['db_tags'] = [dict(r) for r in tag_rows]
        conn.close()

        ai_raw = record.get('ai_tags') or ''
        try:
            parsed = json.loads(ai_raw)
            record['ai_tags_list'] = parsed if isinstance(parsed, list) else []
        except Exception:
            record['ai_tags_list'] = [t.strip() for t in ai_raw.split(',') if t.strip()]

        return record
    except Exception as e:
        logger.error(f"get_image_record({image_id}): {e}", exc_info=True)
        return None


# ─────────────────────────────────────────────────────────────────────────────
# Lookup helpers (for populating filter dropdowns)
# ─────────────────────────────────────────────────────────────────────────────

def get_all_tags(db_path: str) -> List[str]:
    """Return all tag names ordered by usage count. Phase-B: GET /api/tags"""
    try:
        conn = _connect(db_path)
        rows = conn.execute(
            "SELECT name FROM tags ORDER BY usage_count DESC, name"
        ).fetchall()
        conn.close()
        return [r['name'] for r in rows]
    except Exception:
        return []


def get_all_scene_types(db_path: str) -> List[str]:
    """Return all distinct scene types present in the images table."""
    try:
        conn = _connect(db_path)
        rows = conn.execute(
            "SELECT DISTINCT ai_scene_type FROM images "
            "WHERE ai_scene_type IS NOT NULL AND ai_scene_type != '' "
            "ORDER BY ai_scene_type"
        ).fetchall()
        conn.close()
        return [r['ai_scene_type'] for r in rows]
    except Exception:
        return []


def get_all_person_names(db_path: str) -> List[str]:
    """Return all person names. Phase-B: GET /api/people"""
    try:
        conn = _connect(db_path)
        rows = conn.execute("SELECT name FROM people ORDER BY name").fetchall()
        conn.close()
        return [r['name'] for r in rows]
    except Exception:
        return []


# ─────────────────────────────────────────────────────────────────────────────
# Metadata write
# ─────────────────────────────────────────────────────────────────────────────

def _sync_tags_to_table(
    conn: sqlite3.Connection,
    image_id: int,
    tags: List[str],
    source: str = 'manual',
) -> None:
    """
    Upsert tags into tags + image_tags tables.
    Existing tags with the same source are replaced; other sources untouched.
    """
    conn.execute(
        "DELETE FROM image_tags WHERE image_id = ? AND source = ?",
        (image_id, source),
    )
    for raw in tags:
        name = raw.strip().lower()
        if not name:
            continue
        conn.execute("INSERT OR IGNORE INTO tags (name) VALUES (?)", (name,))
        tag_id = conn.execute(
            "SELECT id FROM tags WHERE name = ?", (name,)
        ).fetchone()['id']
        conn.execute(
            "INSERT OR IGNORE INTO image_tags (image_id, tag_id, confidence, source) "
            "VALUES (?, ?, 1.0, ?)",
            (image_id, tag_id, source),
        )


def update_image_metadata(
    db_path: str,
    image_id: int,
    description: str,
    scene_type: str,
    tags_csv: str,
) -> Tuple[bool, str]:
    """
    Persist description, scene type, and tags for an image.
    Tags are written to both images.ai_tags (JSON) and the image_tags table.

    Phase-B API: PATCH /api/images/{image_id}/metadata
    """
    tags = [t.strip() for t in tags_csv.split(',') if t.strip()]
    try:
        conn = _connect(db_path, timeout=10.0)
        conn.execute("""
            UPDATE images
            SET ai_description = ?,
                ai_scene_type  = ?,
                ai_tags        = ?,
                updated_at     = CURRENT_TIMESTAMP
            WHERE id = ?
        """, (
            description.strip() or None,
            scene_type.strip() or None,
            json.dumps(tags),
            image_id,
        ))
        _sync_tags_to_table(conn, image_id, tags, source='manual')
        conn.commit()
        conn.close()
        return True, f"✅ Saved — {len(tags)} tag(s)"
    except Exception as e:
        logger.error(f"update_image_metadata({image_id}): {e}", exc_info=True)
        return False, f"❌ {e}"


def reassign_face(
    db_path: str,
    face_id: int,
    new_person_name: str,
) -> Tuple[bool, str]:
    """
    Manually reassign a face detection to a different person.
    Creates the person if they don't exist.
    """
    new_person_name = new_person_name.strip()
    if not new_person_name:
        return False, "❌ Person name cannot be empty"
    
    try:
        conn = _connect(db_path, timeout=10.0)
        
        # 1. Ensure person exists
        conn.execute("INSERT OR IGNORE INTO people (name) VALUES (?)", (new_person_name,))
        person_id = conn.execute(
            "SELECT id FROM people WHERE name = ?", (new_person_name,)
        ).fetchone()['id']
        
        # 2. Update (or insert) face_embeddings table
        rows_before = conn.execute(
            "SELECT COUNT(*) as cnt FROM face_embeddings WHERE face_id=?", (face_id,)
        ).fetchone()['cnt']

        if rows_before > 0:
            conn.execute("""
                UPDATE face_embeddings
                SET person_id = ?,
                    verified = 1,
                    recognition_confidence = 1.0,
                    verification_method = 'manual'
                WHERE face_id = ?
            """, (person_id, face_id))
            affected = conn.execute("SELECT changes() as n").fetchone()['n']
        else:
            # No embedding row yet (face was stored without a detected embedding).
            # Insert a placeholder so the person_id is recorded in the DB.
            # embedding_vector stays NULL — _load_faiss_index skips NULL-embedding rows,
            # so this won't contribute to recognition, but it keeps the UI consistent.
            conn.execute("""
                INSERT INTO face_embeddings
                    (face_id, person_id, verified, recognition_confidence, verification_method)
                VALUES (?, ?, 1, 1.0, 'manual')
            """, (face_id, person_id))
            affected = 1
            logger.warning(
                f"reassign_face: face_id={face_id} had no embedding_vector — "
                f"person_id recorded but this face won't contribute to FAISS recognition"
            )

        conn.commit()
        conn.close()

        logger.info(
            f"reassign_face: face_id={face_id} → person '{new_person_name}' (id={person_id}); "
            f"rows_before={rows_before}, rows_updated={affected}; "
            f"verified=1, confidence=1.0, method='manual'"
        )
        return True, f"✅ Reassigned to '{new_person_name}'"
    except Exception as e:
        logger.error(f"reassign_face({face_id}, {new_person_name!r}): {e}", exc_info=True)
        return False, f"❌ {e}"


def delete_face(
    db_path: str,
    face_id: int,
) -> Tuple[bool, str]:
    """
    Remove a face detection and its embeddings from the database.
    Also updates the face_count in the images table.
    """
    try:
        conn = _connect(db_path, timeout=10.0)
        # Get image_id first to update count later
        row = conn.execute("SELECT image_id FROM faces WHERE id = ?", (face_id,)).fetchone()
        if not row:
            conn.close()
            return False, "❌ Face not found"
        image_id = row['image_id']

        conn.execute("DELETE FROM face_embeddings WHERE face_id = ?", (face_id,))
        conn.execute("DELETE FROM faces WHERE id = ?", (face_id,))
        
        # Update face_count for the image
        new_count = conn.execute("SELECT COUNT(*) FROM faces WHERE image_id = ?", (image_id,)).fetchone()[0]
        conn.execute("UPDATE images SET face_count = ? WHERE id = ?", (new_count, image_id))
        
        conn.commit()
        conn.close()
        return True, "✅ Face removed"
    except Exception as e:
        logger.error(f"delete_face({face_id}): {e}", exc_info=True)
        return False, f"❌ {e}"


def re_detect_faces(
    db_path: str,
    image_id: int,
    det_thresh: float = 0.7,
    min_face_size: int = 40,
    rec_thresh: float = 0.4,
    engine: Optional[Any] = None,
    vlm_provider: Optional[Any] = None,
    det_model: str = 'auto',
) -> Tuple[bool, str, Any]:
    """
    Clear existing faces for an image and re-run detection with new parameters.
    Reuses the existing engine if provided to avoid model reload.
    """
    from face_recognition_core import FaceRecognitionEngine, FaceRecognitionConfig
    try:
        # 1. Get image path
        conn = _connect(db_path)
        row = conn.execute("SELECT filepath FROM images WHERE id = ?", (image_id,)).fetchone()
        if not row:
            conn.close()
            return False, "❌ Image not found", None
        filepath = row['filepath']
        conn.close()

        # 2. Setup engine (use provided or create temporary)
        if engine is None:
            config = FaceRecognitionConfig()
            config.detection_threshold = det_thresh
            config.min_face_size = min_face_size
            config.recognition_threshold = rec_thresh
            engine = FaceRecognitionEngine(db_path, config)

        # 3. Clear old faces
        conn = _connect(db_path, timeout=10.0)
        conn.execute("DELETE FROM face_embeddings WHERE face_id IN (SELECT id FROM faces WHERE image_id = ?)", (image_id,))
        conn.execute("DELETE FROM faces WHERE image_id = ?", (image_id,))
        conn.commit()
        conn.close()

        # 4. Re-run process_image with force=True and overrides
        result = engine.process_image(
            filepath,
            vlm_provider=vlm_provider,
            force=True,
            det_thresh=det_thresh,
            min_face_size=min_face_size,
            rec_thresh=rec_thresh,
            det_model=det_model,
        )
        
        if result.get('success'):
            return True, f"✅ Re-detected {result.get('face_count', 0)} faces", result
        else:
            return False, f"❌ Detection failed: {result.get('error')}", None

    except Exception as e:
        logger.error(f"re_detect_faces({image_id}): {e}", exc_info=True)
        return False, f"❌ {e}", None


# ─────────────────────────────────────────────────────────────────────────────
# File rename
# ─────────────────────────────────────────────────────────────────────────────

def rename_image(
    db_path: str,
    image_id: int,
    new_filename: str,
) -> Tuple[bool, str]:
    """
    Rename an image file on disk and update filepath/filename in the DB.
    Directory is preserved; only the basename changes.
    If new_filename has no extension the original extension is kept.

    Phase-B API: POST /api/images/{image_id}/rename
    """
    new_filename = new_filename.strip()
    if not new_filename:
        return False, "❌ New filename cannot be empty"
    try:
        conn = _connect(db_path, timeout=10.0)
        row = conn.execute(
            "SELECT filepath, filename FROM images WHERE id = ?", (image_id,)
        ).fetchone()
        if row is None:
            conn.close()
            return False, "❌ Image not found in database"

        old_path = row['filepath']
        old_name = row['filename']
        directory = Path(old_path).parent

        if '.' not in new_filename:
            new_filename += Path(old_path).suffix

        new_path = str(directory / new_filename)

        if Path(new_path).exists() and os.path.abspath(new_path) != os.path.abspath(old_path):
            conn.close()
            return False, f"❌ '{new_filename}' already exists in that folder"

        if Path(old_path).exists():
            os.rename(old_path, new_path)

        conn.execute(
            "UPDATE images SET filepath = ?, filename = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
            (new_path, new_filename, image_id),
        )
        conn.commit()
        conn.close()
        return True, f"✅ Renamed '{old_name}' → '{new_filename}'"
    except Exception as e:
        logger.error(f"rename_image({image_id}, {new_filename!r}): {e}", exc_info=True)
        return False, f"❌ {e}"


# ─────────────────────────────────────────────────────────────────────────────
# Thumbnails
# ─────────────────────────────────────────────────────────────────────────────

def get_or_create_thumbnail(
    image_id: int,
    filepath: str,
    thumb_dir: str,
    size: int = 400,
) -> Optional[str]:
    """
    Return the path to a JPEG thumbnail, creating it on disk if needed.
    Files are named  <image_id>_<size>.jpg  inside thumb_dir.
    Returns None if Pillow is unavailable or the source file cannot be opened.

    Phase-B API: GET /api/images/{image_id}/thumbnail?size={size}
    """
    if not PIL_AVAILABLE:
        return None

    thumb_path = Path(thumb_dir) / f"{image_id}_{size}.jpg"
    if thumb_path.exists():
        return str(thumb_path)

    try:
        from PIL import ImageOps as _ImageOps
        Path(thumb_dir).mkdir(parents=True, exist_ok=True)
        with Image.open(filepath) as img:
            img = _ImageOps.exif_transpose(img)   # bake EXIF rotation before resizing
            img.thumbnail((size, size), Image.LANCZOS)
            if img.mode not in ('RGB', 'L'):
                img = img.convert('RGB')
            img.save(str(thumb_path), 'JPEG', quality=82, optimize=True)
        return str(thumb_path)
    except Exception as e:
        logger.debug(f"Thumbnail creation failed for {filepath}: {e}")
        return None


def load_thumbnail_pil(
    image_id: int,
    filepath: str,
    thumb_dir: str,
    size: int = 400,
) -> Optional[Any]:
    """
    Return the thumbnail as a PIL Image (RGB).
    Falls back to a resized version of the original if thumbnail creation fails.
    Returns None on complete failure.
    """
    if not PIL_AVAILABLE:
        return None

    thumb_path = get_or_create_thumbnail(image_id, filepath, thumb_dir, size)

    if thumb_path:
        try:
            return Image.open(thumb_path).convert('RGB')
        except Exception:
            pass

    # Fallback: resize original in memory
    try:
        with Image.open(filepath) as img:
            img.thumbnail((size, size), Image.LANCZOS)
            return img.convert('RGB').copy()
    except Exception as e:
        logger.debug(f"load_thumbnail_pil fallback failed for {filepath}: {e}")
        return None


# ─────────────────────────────────────────────────────────────────────────────
# Filtered browse
# ─────────────────────────────────────────────────────────────────────────────

_rating_cols_migrated: set = set()

def _ensure_rating_cols(db_path: str):
    """Idempotent migration: add star_rating and color_flag columns to images."""
    if db_path in _rating_cols_migrated:
        return
    conn = None
    try:
        conn = _connect(db_path)
        for sql in [
            "ALTER TABLE images ADD COLUMN star_rating INTEGER DEFAULT 0",
            "ALTER TABLE images ADD COLUMN color_flag TEXT",
        ]:
            try:
                conn.execute(sql)
            except Exception:
                pass  # column already exists
        conn.commit()
        _rating_cols_migrated.add(db_path)
    finally:
        if conn:
            conn.close()


def browse_images_filtered(
    db_path: str,
    person:          str = '',
    tag:             str = '',
    scene_type:      str = '',
    folder:          str = '',
    path:            str = '',
    date_from:       str = '',
    date_to:         str = '',
    sort_by:         str = 'newest',
    limit:           int = 100,
    unidentified:    bool = False,
    album_id:        int = 0,
    current_user_id: int = None,
    is_admin:        bool = False,
) -> List[Dict[str, Any]]:
    """
    Return a list of image record dicts matching the given filters.

    sort_by values:
      newest          – by created_at DESC
      oldest          – by created_at ASC
      date_taken_desc – by taken_at DESC (EXIF date)
      date_taken_asc  – by taken_at ASC
      most_faces      – by face_count DESC
      fewest_faces    – by face_count ASC
      filename_az     – alphabetical ASC
      filename_za     – alphabetical DESC

    Phase-B API: GET /api/images?person=&tag=&scene=&from=&to=&sort=&limit=
    """
    _ensure_rating_cols(db_path)

    sort_map = {
        'newest':          'i.created_at DESC',
        'oldest':          'i.created_at ASC',
        'date_taken_desc': 'i.taken_at DESC',
        'date_taken_asc':  'i.taken_at ASC',
        'most_faces':      'i.face_count DESC',
        'fewest_faces':    'i.face_count ASC',
        'filename_az':     'i.filename ASC',
        'filename_za':     'i.filename DESC',
    }
    order = sort_map.get(sort_by, 'i.created_at DESC')

    wheres = ["i.processed = 1", "i.filepath != '__training__'"]
    params: List[Any] = []

    if person.strip():
        wheres.append("""
            i.id IN (
                SELECT f.image_id FROM faces f
                JOIN face_embeddings fe ON f.id = fe.face_id
                JOIN people p ON fe.person_id = p.id
                WHERE p.name LIKE ?
            )
        """)
        params.append(f'%{person.strip()}%')

    if tag.strip():
        wheres.append("""
            (i.ai_tags LIKE ?
             OR i.id IN (
                 SELECT it.image_id FROM image_tags it
                 JOIN tags t ON it.tag_id = t.id
                 WHERE t.name LIKE ?
             ))
        """)
        params.extend([f'%{tag.strip()}%', f'%{tag.strip()}%'])

    if scene_type.strip() and scene_type.strip().lower() not in ('', 'all'):
        wheres.append("i.ai_scene_type = ?")
        params.append(scene_type.strip())

    if folder.strip():
        f = folder.strip()
        if f == '.':
            # "." folder = images with no parent directory (bare filename or ./name)
            # Matches what str(Path(src).parent) == "." produces in the stats endpoint.
            wheres.append("""(
                (i.local_path IS NOT NULL AND (
                    (i.local_path NOT LIKE '%/%') OR
                    (i.local_path LIKE './%' AND i.local_path NOT LIKE './%/%')
                ))
                OR (i.local_path IS NULL AND (
                    (i.filepath NOT LIKE '%/%') OR
                    (i.filepath LIKE './%' AND i.filepath NOT LIKE './%/%')
                ))
            )""")
        else:
            wheres.append("(i.filepath LIKE ? OR i.local_path LIKE ?)")
            params.extend([f'{f}%', f'{f}%'])

    if path.strip():
        wheres.append("(i.filepath LIKE ? OR i.filename LIKE ?)")
        params.extend([f'%{path.strip()}%', f'%{path.strip()}%'])

    if date_from.strip():
        wheres.append(
            "(i.taken_at >= ? OR (i.taken_at IS NULL AND i.created_at >= ?))"
        )
        params.extend([date_from.strip(), date_from.strip()])

    if date_to.strip():
        wheres.append(
            "(i.taken_at <= ? OR (i.taken_at IS NULL AND i.created_at <= ?))"
        )
        params.extend([date_to.strip(), date_to.strip()])

    if unidentified:
        wheres.append("""
            i.face_count > 0
            AND i.id IN (
                SELECT DISTINCT f.image_id FROM faces f
                LEFT JOIN face_embeddings fe ON f.id = fe.face_id
                WHERE fe.person_id IS NULL OR fe.recognition_confidence < 0.5
            )
        """)

    if album_id > 0:
        wheres.append("i.id IN (SELECT image_id FROM album_images WHERE album_id=?)")
        params.append(album_id)

    if not is_admin:
        uid = current_user_id or 0
        wheres.append("""
            (
                i.visibility = 'shared'
                OR i.visibility IS NULL
                OR i.owner_id = ?
                OR EXISTS (SELECT 1 FROM image_shares s WHERE s.image_id = i.id AND s.user_id = ?)
            )
        """)
        params.extend([uid, uid])

    where_sql = ' AND '.join(wheres)
    sql = f"""
        SELECT
            i.id, i.filepath, i.filename, i.face_count,
            i.ai_description, i.ai_scene_type, i.ai_tags,
            i.taken_at, i.created_at,
            i.width, i.height, i.camera_make, i.camera_model,
            i.iso, i.aperture, i.shutter_speed, i.focal_length,
            i.star_rating, i.color_flag, i.local_path,
            i.owner_id, i.visibility,
            GROUP_CONCAT(DISTINCT p.name) AS people_names
        FROM images i
        LEFT JOIN faces f   ON i.id = f.image_id
        LEFT JOIN face_embeddings fe
                            ON f.id = fe.face_id AND fe.verified = 1
        LEFT JOIN people p  ON fe.person_id = p.id
        WHERE {where_sql}
        GROUP BY i.id
        ORDER BY {order}
        LIMIT ?
    """
    params.append(limit)

    try:
        conn = _connect(db_path)
        rows = conn.execute(sql, params).fetchall()
        conn.close()
        results = []
        for r in rows:
            d = dict(r)
            d['server_path'] = d.get('filepath')
            d['origin_path'] = d.get('local_path')
            # Parse ai_tags into a list for convenience
            raw_tags = d.get('ai_tags') or ''
            try:
                d['ai_tags_list'] = json.loads(raw_tags)
            except Exception:
                d['ai_tags_list'] = [t.strip() for t in raw_tags.split(',') if t.strip()]
            results.append(d)
        return results
    except Exception as e:
        logger.error(f"browse_images_filtered: {e}", exc_info=True)
        return []
