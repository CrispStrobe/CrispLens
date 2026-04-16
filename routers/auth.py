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
import time
from collections import defaultdict

from fastapi import APIRouter, Cookie, HTTPException, Request, Response
from pydantic import BaseModel

# True when running behind HTTPS (VPS).  Locally (HTTP) leave unset.
_SECURE_COOKIES = os.environ.get('CRISP_HTTPS_COOKIES', '0').strip() == '1'

# On VPS the Electron app serves the SPA from a local http://127.0.0.1 server and
# calls the remote HTTPS API — a cross-site request.  SameSite=Lax blocks cookies on
# cross-site fetch calls, so we must use SameSite=None (which requires Secure=True).
# Locally the SPA and API share the same 127.0.0.1 origin → Lax is fine.
_SAME_SITE = 'none' if _SECURE_COOKIES else 'lax'

router = APIRouter()

# In-process session store: token → {username, expires_at}
_SESSION_TTL = 60 * 60 * 24 * 30  # 30 days (matches cookie max_age)
_sessions: dict[str, dict] = {}

# Per-IP login rate limiter: IP → list of attempt timestamps
_LOGIN_MAX_ATTEMPTS = 10       # max attempts per window
_LOGIN_WINDOW_SECS  = 15 * 60  # 15-minute window
_login_attempts: dict[str, list] = defaultdict(list)


def _get_session_user(token: str) -> str | None:
    """Return username for session token, or None if expired/missing. Cleans up expired entries."""
    entry = _sessions.get(token)
    if entry is None:
        return None
    if time.time() > entry['expires_at']:
        _sessions.pop(token, None)
        return None
    return entry['username']


def _check_login_rate_limit(ip: str) -> None:
    """Raise 429 if the IP has exceeded the login attempt limit."""
    now = time.time()
    attempts = _login_attempts[ip]
    # Purge old attempts outside the window
    _login_attempts[ip] = [t for t in attempts if now - t < _LOGIN_WINDOW_SECS]
    if len(_login_attempts[ip]) >= _LOGIN_MAX_ATTEMPTS:
        raise HTTPException(
            status_code=429,
            detail="Too many login attempts. Please wait 15 minutes before trying again.",
        )
    _login_attempts[ip].append(now)


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
def login(body: LoginRequest, response: Response, request: Request):
    _check_login_rate_limit(request.client.host if request.client else "unknown")
    s = _state()
    ok, msg, user = s.permissions.authenticate(body.username, body.password)
    if not ok or user is None:
        raise HTTPException(status_code=401, detail="Invalid username or password")

    token = secrets.token_hex(32)
    _sessions[token] = {'username': user.username, 'expires_at': time.time() + _SESSION_TTL}
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
def logout(response: Response, session: str | None = Cookie(None)):
    if session and session in _sessions:
        _sessions.pop(session, None)
    response.delete_cookie("session", path="/", secure=_SECURE_COOKIES, samesite=_SAME_SITE)
    return {"ok": True}


@router.post("/change-password")
def change_password(body: ChangePasswordRequest, session: str | None = Cookie(None)):
    """Allow any authenticated user to change their own password."""
    username = _get_session_user(session) if session else None
    if not username:
        raise HTTPException(status_code=401, detail="Not authenticated")
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


def _require_rate_limit_access(request: Request, session: str | None) -> None:
    """Allow authenticated admins or unauthenticated localhost callers."""
    username = _get_session_user(session) if session else None
    if username:
        s = _state()
        user = s.permissions.get_user(username)
        if not user or user.role != "admin":
            raise HTTPException(status_code=403, detail="Admin access required")
    else:
        client_ip = request.client.host if request.client else None
        if client_ip not in ("127.0.0.1", "::1"):
            raise HTTPException(status_code=403, detail="Localhost access required")


@router.get("/rate-limits")
def list_rate_limits(request: Request, session: str | None = Cookie(None)):
    """Show IPs with active login-attempt records."""
    _require_rate_limit_access(request, session)
    now = time.time()
    result = {}
    for ip, attempts in list(_login_attempts.items()):
        active = [t for t in attempts if now - t < _LOGIN_WINDOW_SECS]
        if active:
            result[ip] = {
                "attempts": len(active),
                "limit": _LOGIN_MAX_ATTEMPTS,
                "blocked": len(active) >= _LOGIN_MAX_ATTEMPTS,
                "oldest": round(now - max(active)),
                "resets_in": round(_LOGIN_WINDOW_SECS - (now - min(active))),
            }
    return {"ok": True, "ips": result}


@router.post("/reset-rate-limit")
def reset_rate_limit(request: Request, ip: str | None = None, session: str | None = Cookie(None)):
    """Clear login rate-limit counters. Admin only.

    If *ip* is given, only that IP is cleared; otherwise all IPs are cleared.
    """
    _require_rate_limit_access(request, session)

    if ip:
        _login_attempts.pop(ip, None)
        return {"ok": True, "cleared": ip}
    else:
        _login_attempts.clear()
        return {"ok": True, "cleared": "all"}


@router.get("/me")
def me(session: str | None = Cookie(None)):
    username = _get_session_user(session) if session else None
    if not username:
        raise HTTPException(status_code=401, detail="Not authenticated")
    s = _state()
    user = s.permissions.get_user(username)
    if user is None:
        raise HTTPException(status_code=401, detail="User not found")
    return {
        "username": user.username,
        "role": user.role,
        "is_active": user.is_active,
    }
