"""
routers/admin.py — Admin-only system operations.

  GET  /api/admin/test-stream       — SSE, GET, 0.4 s sleep (KNOWN GOOD)
  GET  /api/admin/test-stream-fast  — SSE, GET, NO sleep    (does burst SSE work?)
  POST /api/admin/test-stream-post  — SSE, POST, 0.4 s sleep (does POST SSE work?)
  GET  /api/admin/test-json         — plain JSONResponse     (does JSON ever arrive?)

  POST /api/admin/update   — stream fix_db.sh output via SSE (sync subprocess)
  GET  /api/admin/logs     — last N lines of app log via SSE
"""
import collections
import logging
import os
import subprocess
import time as _time

from fastapi import APIRouter, Depends
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel

from routers.deps import require_admin

router = APIRouter(prefix="/api/admin", tags=["admin"])
logger = logging.getLogger(__name__)

# Common headers that tell every proxy layer not to buffer this response.
_SSE_HEADERS = {
    "X-Accel-Buffering": "no",   # nginx
    "Cache-Control":     "no-cache",
    "Connection":        "keep-alive",
}
_JSON_HEADERS = {
    "X-Accel-Buffering": "no",
    "Cache-Control":     "no-store",
}


def _sse_response(gen):
    return StreamingResponse(gen, media_type="text/event-stream", headers=_SSE_HEADERS)


# ─────────────────────────── DEBUG TEST ENDPOINTS ────────────────────────────

@router.get("/test-json")
def test_json(admin=Depends(require_admin)):
    """
    Tiny JSONResponse (no streaming).
    If this hangs → Apache buffers ALL non-SSE responses from this VirtualHost.
    """
    logger.info("test-json: returning tiny JSON")
    return JSONResponse(
        content={
            "status": "ok",
            "ts":     _time.strftime('%H:%M:%S'),
            "user":   admin.username,
            "note":   "if you see this, JSON responses work through Apache",
        },
        headers=_JSON_HEADERS,
    )


# ─────────────────────────────── REAL ENDPOINTS ──────────────────────────────

class UpdateRequest(BaseModel):
    fix_db_path: str = ''  # optional override; falls back to config then default


@router.post("/update")
def server_update(body: UpdateRequest, admin=Depends(require_admin)):
    """
    Stream fix_db.sh output. 0.05s sleep per line for responsiveness.
    """
    from fastapi_app import state as _s
    config_path = (_s.config or {}).get('admin', {}).get('fix_db_path', '')
    script = body.fix_db_path.strip() or config_path or '/root/recognize_faces/fix_db.sh'

    def _gen():
        yield f"data: [admin] Script: {script}\n\n"; _time.sleep(0.05)
        try:
            proc = subprocess.Popen(['sudo', 'bash', script], stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
            for raw in iter(proc.stdout.readline, b''):
                yield f"data: {raw.decode('utf-8', errors='replace').rstrip()}\n\n"
                _time.sleep(0.05)
            proc.wait()
            yield f"data: [exit {proc.returncode}]\n\n"; _time.sleep(0.05)
        except Exception as e:
            yield f"data: ERROR: {e}\n\n"

    return _sse_response(_gen())


@router.get("/logs")
def get_server_logs(lines: int = 100, admin=Depends(require_admin)):
    """
    Stream app logs. 0.05s sleep per line for responsiveness.
    """
    import logging as _logging_mod
    from fastapi_app import _log_file as _app_log_file, state as _s
    def _gen():
        h_path = next((h.baseFilename for h in _logging_mod.root.handlers if hasattr(h, 'baseFilename') and h.baseFilename), '')
        c_path = (_s.config or {}).get('logging', {}).get('file', '').strip()
        log_file = next((c for c in [h_path, c_path, _app_log_file, '/opt/crisp-lens/face_recognition.log'] if c and os.path.isfile(c)), None)
        if not log_file:
            yield "data: [ERROR] Log file not found\n\n"; return
        yield f"data: [PATH] {log_file}\n\n"; _time.sleep(0.05)
        try:
            with open(log_file, errors='replace') as fh:
                tail = list(collections.deque(fh, maxlen=lines))
            for ln in tail:
                yield f"data: {ln.rstrip()}\n\n"
                _time.sleep(0.05)
            yield "data: [DONE]\n\n"
        except Exception as e:
            yield f"data: [ERROR] {e}\n\n"

    return _sse_response(_gen())


@router.get("/logs-json")
def get_server_logs_json(lines: int = 100, _=Depends(require_admin)):
    """
    Method 2: Non-streaming JSON response for log retrieval.
    If SSE hangs, this static method should still work through any proxy.
    """
    import logging as _logging_mod
    from fastapi_app import _log_file as _app_log_file, state as _s
    h_path = next((h.baseFilename for h in _logging_mod.root.handlers if hasattr(h, 'baseFilename') and h.baseFilename), '')
    c_path = (_s.config or {}).get('logging', {}).get('file', '').strip()
    log_file = next((c for c in [h_path, c_path, _app_log_file, '/opt/crisp-lens/face_recognition.log'] if c and os.path.isfile(c)), None)
    if not log_file:
        return JSONResponse({"error": "Log file not found"}, status_code=404)
    try:
        with open(log_file, errors='replace') as fh:
            tail = list(collections.deque(fh, maxlen=lines))
        return {"lines": [ln.rstrip() for ln in tail], "path": log_file}
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=500)
