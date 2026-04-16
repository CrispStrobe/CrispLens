"""
routers/users.py — User management CRUD (admin-only).

Endpoints:
    GET    /api/users                   list all users
    POST   /api/users                   create user
    PATCH  /api/users/{user_id}         update role / active / password / folders
    DELETE /api/users/{user_id}         delete user
    POST   /api/users/{user_id}/reset-lock  reset failed-login counter
"""
import logging

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from routers.deps import require_admin

logger = logging.getLogger(__name__)
router = APIRouter()


def _state():
    from fastapi_app import state
    return state


# ── Pydantic models ───────────────────────────────────────────────────────────

class CreateUserRequest(BaseModel):
    username: str
    password: str
    role: str = 'user'              # 'admin' | 'user' | 'mediamanager'
    allowed_folders: list[str] = []


class PatchUserRequest(BaseModel):
    role:            str | None        = None
    is_active:       bool | None       = None
    password:        str | None        = None
    allowed_folders: list[str] | None  = None


# ── Routes ────────────────────────────────────────────────────────────────────

@router.get("")
def list_users(_admin=Depends(require_admin)):
    s = _state()
    users = s.permissions.list_users()
    result = []
    for u in users:
        # Fetch last_login + failed_login_attempts separately (not in User dataclass)
        import sqlite3
        conn = sqlite3.connect(s.db_path, timeout=10.0)
        conn.row_factory = sqlite3.Row
        row = conn.execute(
            "SELECT last_login, failed_login_attempts FROM users WHERE id = ?", (u.id,)
        ).fetchone()
        conn.close()
        result.append({
            "id":                    u.id,
            "username":              u.username,
            "role":                  u.role,
            "is_active":             u.is_active,
            "allowed_folders":       u.allowed_folders,
            "created_at":            u.created_at,
            "last_login":            row["last_login"] if row else None,
            "failed_login_attempts": row["failed_login_attempts"] if row else 0,
        })
    return result


@router.post("")
def create_user(body: CreateUserRequest, _admin=Depends(require_admin)):
    s = _state()
    ok, msg, user_id = s.permissions.create_user(
        body.username, body.password, body.role, body.allowed_folders
    )
    if not ok:
        raise HTTPException(status_code=400, detail=msg)
    return {"ok": True, "user_id": user_id, "message": msg}


@router.patch("/{user_id}")
def patch_user(user_id: int, body: PatchUserRequest, admin=Depends(require_admin)):
    s = _state()
    # Prevent admin from modifying themselves if it would lock them out
    if admin.id == user_id and body.is_active is False:
        raise HTTPException(status_code=400, detail="Cannot deactivate your own account")
    if admin.id == user_id and body.role is not None and body.role != 'admin':
        raise HTTPException(status_code=400, detail="Cannot demote your own account")

    ok, msg = s.permissions.update_user(
        user_id,
        role=body.role,
        is_active=body.is_active,
        password=body.password,
        allowed_folders=body.allowed_folders,
    )
    if not ok:
        raise HTTPException(status_code=400, detail=msg)
    return {"ok": True, "message": msg}


@router.delete("/{user_id}")
def delete_user(user_id: int, admin=Depends(require_admin)):
    s = _state()
    if admin.id == user_id:
        raise HTTPException(status_code=400, detail="Cannot delete your own account")
    ok, msg = s.permissions.delete_user(user_id)
    if not ok:
        raise HTTPException(status_code=400, detail=msg)
    return {"ok": True, "message": msg}


@router.post("/{user_id}/reset-lock")
def reset_lock(user_id: int, _admin=Depends(require_admin)):
    s = _state()
    ok, msg = s.permissions.reset_failed_attempts_by_id(user_id)
    if not ok:
        raise HTTPException(status_code=400, detail=msg)
    return {"ok": True, "message": msg}
