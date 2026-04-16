"""
szenentyp.py — Predefined scene-type tag helpers.

Reads the current list of Szenentyp tags from the tags table (category='Szenentyp')
and builds a VLM prompt fragment that asks the model to pick 0–3 matching entries
from that list (or suggest one new German noun if none fit).

Keep the Szenentyp list in the DB so users can add new entries and they flow
into the prompt on the next call — no code redeploy needed.
"""
from __future__ import annotations

import logging
import sqlite3

logger = logging.getLogger(__name__)

SEED_SZENENTYPEN = (
    'Podium', 'Saal', 'Publikum', 'Rollstuhl',
    'Junge Leute', 'Dialog', 'Ausstellung', 'Vernissage',
)


def list_szenentypen(db_path: str) -> list[str]:
    """Return all tag names with category='Szenentyp', ordered by usage then name."""
    try:
        conn = sqlite3.connect(db_path)
        try:
            rows = conn.execute(
                "SELECT name FROM tags WHERE category='Szenentyp' "
                "ORDER BY usage_count DESC, name ASC"
            ).fetchall()
            return [r[0] for r in rows]
        finally:
            conn.close()
    except sqlite3.Error as e:
        logger.warning(f"Could not read Szenentyp list: {e}")
        return list(SEED_SZENENTYPEN)


def ensure_tag(db_path: str, name: str, category: str = 'Szenentyp',
               color: str = '#4080c0') -> int | None:
    """Return tag id for `name`, creating it with the given category if missing."""
    name = (name or '').strip()
    if not name: return None
    try:
        conn = sqlite3.connect(db_path)
        try:
            conn.execute(
                "INSERT OR IGNORE INTO tags (name, category, color) VALUES (?, ?, ?)",
                (name, category, color),
            )
            conn.commit()
            row = conn.execute("SELECT id FROM tags WHERE name=?", (name,)).fetchone()
            return row[0] if row else None
        finally:
            conn.close()
    except sqlite3.Error as e:
        logger.warning(f"ensure_tag({name}) failed: {e}")
        return None


def build_vlm_prompt(base_prompt: str, db_path: str, language: str = 'de') -> str:
    """
    Append a Szenentyp-selection instruction to the base VLM prompt.

    The VLM is asked to include a `szenentyp` field in its JSON response:
      - 0 to 3 strings drawn from the predefined list, OR
      - a single new German noun if nothing fits.
    Output still mirrors the existing description / scene_type / tags schema.
    """
    szenen = list_szenentypen(db_path) or list(SEED_SZENENTYPEN)
    joined = ', '.join(szenen)
    if language.lower().startswith('de'):
        extra = (
            "\n\nZusätzlich: Wähle 0 bis 3 passende Szenentypen aus dieser Liste: "
            f"[{joined}]. Wenn keiner passt, schlage **einen** neuen deutschen "
            "Substantiv-Kurzbegriff vor. "
            'Ergänze im JSON das Feld "szenentyp": ["...", "..."] (Array).'
        )
    else:
        extra = (
            "\n\nAdditionally: choose 0 to 3 matching Szenentypen from this list: "
            f"[{joined}]. If none fit, suggest **one** new German short noun. "
            'Add a "szenentyp": ["...", "..."] array to the JSON output.'
        )
    return (base_prompt or '') + extra


def apply_to_image(db_path: str, image_id: int, szenentypen: list[str],
                   source: str = 'vlm') -> int:
    """Attach returned Szenentyp strings to an image via image_tags rows."""
    if not image_id or not szenentypen:
        return 0
    applied = 0
    try:
        conn = sqlite3.connect(db_path)
        try:
            for s in szenentypen:
                tid = ensure_tag(db_path, s)
                if not tid: continue
                try:
                    conn.execute(
                        "INSERT OR IGNORE INTO image_tags (image_id, tag_id, source) "
                        "VALUES (?, ?, ?)", (image_id, tid, source),
                    )
                    applied += 1
                except sqlite3.Error as e:
                    logger.debug(f"image_tags insert failed: {e}")
            conn.commit()
        finally:
            conn.close()
    except sqlite3.Error as e:
        logger.warning(f"apply_to_image failed: {e}")
    return applied
