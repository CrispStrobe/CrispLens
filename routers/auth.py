"""
routers/auth.py — Login / logout / current user.

Uses a simple in-process session dict keyed by a random token.
For a single-user desktop app this is sufficient; replace with
proper JWT middleware for a multi-user deployment.

Set CRISP_HTTPS_COOKIES=1 in the service environment when running behind
HTTPS (nginx).  This adds the Secure flag to session cookies so browsers
send them on every request over HTTPS.
"""
import os
import secrets
from typing import Optional

from fastapi import APIRouter, Cookie, HTTPException, Response
from pydantic import BaseModel

# True when running behind HTTPS (VPS).  Locally (HTTP) leave unset.
_SECURE_COOKIES = os.environ.get('CRISP_HTTPS_COOKIES', '0').strip() == '1'

# On VPS the Electron app serves the SPA from a local http://127.0.0.1 server and
# calls the remote HTTPS API — a cross-site request.  SameSite=Lax blocks cookies on
# cross-site fetch calls, so we must use SameSite=None (which requires Secure=True).
# Locally the SPA and API share the same 127.0.0.1 origin → Lax is fine.
_SAME_SITE = 'none' if _SECURE_COOKIES else 'lax'

router = APIRouter()

# In-process session store: token → username
_sessions: dict[str, str] = {}


def _state():
    from fastapi_app import state
    return state


class LoginRequest(BaseModel):
    username: str
    password: str


class ChangePasswordRequest(BaseModel):
    current_password: str
    new_password: str


@router.post("/login")
def login(body: LoginRequest, response: Response):
    s = _state()
    ok, msg, user = s.permissions.authenticate(body.username, body.password)
    if not ok or user is None:
        raise HTTPException(status_code=401, detail=msg)

    token = secrets.token_hex(32)
    _sessions[token] = user.username
    response.set_cookie(
        "session", token,
        httponly=True,
        samesite=_SAME_SITE,
        secure=_SECURE_COOKIES,
        max_age=60 * 60 * 24 * 30,   # 30 days — survives browser restarts
        path="/",
    )
    return {
        "ok": True,
        "username": user.username,
        "role": user.role,
        "token": token,
    }


@router.post("/logout")
def logout(response: Response, session: Optional[str] = Cookie(None)):
    if session and session in _sessions:
        del _sessions[session]
    response.delete_cookie("session", path="/", secure=_SECURE_COOKIES, samesite=_SAME_SITE)
    return {"ok": True}


@router.post("/change-password")
def change_password(body: ChangePasswordRequest, session: Optional[str] = Cookie(None)):
    """Allow any authenticated user to change their own password."""
    if not session or session not in _sessions:
        raise HTTPException(status_code=401, detail="Not authenticated")
    username = _sessions[session]
    s = _state()
    # Verify current password first
    ok, msg, _ = s.permissions.authenticate(username, body.current_password)
    if not ok:
        raise HTTPException(status_code=400, detail="Current password is incorrect")
    if not body.new_password or len(body.new_password) < 4:
        raise HTTPException(status_code=400, detail="New password must be at least 4 characters")
    user = s.permissions.get_user(username)
    if user is None:
        raise HTTPException(status_code=404, detail="User not found")
    ok2, msg2 = s.permissions.update_user(user.id, password=body.new_password)
    if not ok2:
        raise HTTPException(status_code=400, detail=msg2)
    return {"ok": True, "message": "Password changed successfully"}


@router.get("/me")
def me(session: Optional[str] = Cookie(None)):
    if not session or session not in _sessions:
        raise HTTPException(status_code=401, detail="Not authenticated")
    username = _sessions[session]
    s = _state()
    user = s.permissions.get_user(username)
    if user is None:
        raise HTTPException(status_code=401, detail="User not found")
    return {
        "username": user.username,
        "role": user.role,
        "is_active": user.is_active,
    }
