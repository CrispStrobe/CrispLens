"""
routers/deps.py — Reusable FastAPI auth dependencies.

Usage in route handlers:
    from routers.deps import get_current_user, require_admin, require_admin_or_mediamanager, can_access_image

    @router.get("/foo")
    def foo(user = Depends(get_current_user)):
        ...
"""
import sqlite3
from typing import Optional

from fastapi import Cookie, Depends, HTTPException


def get_current_user(session: Optional[str] = Cookie(None)):
    """Return the authenticated User or raise 401."""
    from routers.auth import _get_session_user
    from fastapi_app import state

    username = _get_session_user(session) if session else None
    if not username:
        raise HTTPException(status_code=401, detail="Not authenticated")
    user = state.permissions.get_user(username)
    if user is None or not user.is_active:
        raise HTTPException(status_code=401, detail="User inactive or not found")
    return user


def require_admin(user=Depends(get_current_user)):
    """Require the 'admin' role."""
    if user.role != 'admin':
        raise HTTPException(status_code=403, detail="Admin access required")
    return user


def require_admin_or_mediamanager(user=Depends(get_current_user)):
    """Require 'admin' or 'mediamanager' role."""
    if user.role not in ('admin', 'mediamanager'):
        raise HTTPException(status_code=403, detail="Admin or MediaManager access required")
    return user


def can_access_image(image_id: int, user, db_path: str) -> bool:
    """
    Return True if `user` may access image `image_id`.

    Rules:
    - admin: always
    - everyone else:
        shared images (visibility='shared')
        OR images they own (owner_id = user.id)
        OR images explicitly shared with them via image_shares table
    """
    if user.role == 'admin':
        return True

    conn = None
    try:
        conn = sqlite3.connect(db_path, timeout=10.0)
        conn.execute("PRAGMA journal_mode=WAL")
        conn.row_factory = sqlite3.Row

        row = conn.execute(
            "SELECT owner_id, visibility FROM images WHERE id = ?", (image_id,)
        ).fetchone()
        if row is None:
            return False

        if row['visibility'] in ('shared', None):   # NULL = legacy shared (pre-migration rows)
            return True
        if row['owner_id'] == user.id:
            return True

        # Check explicit per-image share
        share = conn.execute(
            "SELECT 1 FROM image_shares WHERE image_id = ? AND user_id = ?",
            (image_id, user.id),
        ).fetchone()
        return share is not None
    except Exception:
        return False
    finally:
        if conn:
            conn.close()


# Provider category constants — used in api_keys router
EU_PROVIDERS = frozenset({'scaleway', 'ollama', 'mistral', 'nebius'})
NON_EU_PROVIDERS = frozenset({'openrouter', 'poe', 'anthropic', 'openai', 'groq', 'bfl'})


def get_allowed_providers(role: str) -> frozenset:
    """Return the set of VLM provider names permitted for a given role."""
    if role in ('admin', 'mediamanager'):
        return EU_PROVIDERS | NON_EU_PROVIDERS
    return EU_PROVIDERS
