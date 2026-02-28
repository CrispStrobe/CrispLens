"""
routers/admin.py — Admin-only system operations.

  GET  /api/admin/test-stream       — SSE, GET, 0.4 s sleep (KNOWN GOOD)
  GET  /api/admin/test-stream-fast  — SSE, GET, NO sleep    (does burst SSE work?)
  POST /api/admin/test-stream-post  — SSE, POST, 0.4 s sleep (does POST SSE work?)
  GET  /api/admin/test-json         — plain JSONResponse     (does JSON ever arrive?)

  POST /api/admin/update   — stream fix_db.sh output via SSE
  GET  /api/admin/logs     — last N lines of app log via SSE (avoids JSONResponse hang)
"""
import collections
import logging
import os
import subprocess
import time as _time

from fastapi import APIRouter, Depends, HTTPException
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

@router.get("/test-stream")
def test_stream(admin=Depends(require_admin)):
    """
    KNOWN GOOD: GET SSE with 0.4 s sleep between lines.
    If this works but the others don't, use the results to narrow down the cause.
    """
    def _gen():
        for i in range(1, 6):
            msg = f"data: [GET/sleep] line {i} — {_time.strftime('%H:%M:%S')} user={admin.username}\n\n"
            logger.debug("test-stream yield %d", i)
            yield msg
            _time.sleep(0.4)
        yield "data: ✓ GET/sleep stream complete\n\n"

    return _sse_response(_gen())


@router.get("/test-stream-fast")
def test_stream_fast(admin=Depends(require_admin)):
    """
    GET SSE with NO sleep (burst).
    EXPECTED: if this hangs but /test-stream works → TCP/Nagle coalescing is
    the root cause. The fix is to add micro-sleeps to the update generator.
    """
    def _gen():
        logger.info("test-stream-fast: starting burst of 6 lines")
        for i in range(1, 6):
            logger.debug("test-stream-fast yield %d", i)
            yield f"data: [GET/fast] line {i} — {_time.strftime('%H:%M:%S')}\n\n"
        yield "data: ✓ GET/fast stream complete\n\n"
        logger.info("test-stream-fast: generator exhausted")

    return _sse_response(_gen())


@router.post("/test-stream-post")
def test_stream_post(admin=Depends(require_admin)):
    """
    POST SSE with 0.4 s sleep.
    EXPECTED: if this hangs but GET /test-stream works → Apache treats POST
    response bodies differently (may buffer until backend closes connection).
    The fix is proxy-nokeepalive + disablereuse for /api/admin.
    """
    def _gen():
        logger.info("test-stream-post: starting POST SSE stream")
        for i in range(1, 4):
            logger.debug("test-stream-post yield %d", i)
            yield f"data: [POST/sleep] line {i} — {_time.strftime('%H:%M:%S')}\n\n"
            _time.sleep(0.4)
        yield "data: ✓ POST/sleep stream complete\n\n"
        logger.info("test-stream-post: done")

    return _sse_response(_gen())


@router.get("/test-json")
def test_json(admin=Depends(require_admin)):
    """
    Tiny JSONResponse (no streaming).
    EXPECTED: if this hangs → Apache buffers ALL non-SSE responses from this
    VirtualHost. Confirm mod_deflate is loaded and <Location /api> no-gzip
    is inside the VirtualHost block.
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
    # root_password removed: sudoers must have NOPASSWD: for the script.
    # sudo -S with a service-account password never works (no shell password).
    # The admin web-UI login is the security gate.


@router.post("/update")
def server_update(body: UpdateRequest, admin=Depends(require_admin)):
    """
    Stream the output of: CRISP_YES=1 sudo bash <fix_db_path>
    Requires sudoers: face-rec ALL=(ALL) NOPASSWD: /bin/bash /root/recognize_faces/fix_db.sh

    Micro-sleeps (20 ms) between every yield prevent TCP/Nagle coalescing
    that otherwise causes Apache to buffer all chunks and never forward them.
    """
    from fastapi_app import state as _s

    config_path = (_s.config or {}).get('admin', {}).get('fix_db_path', '')
    script = body.fix_db_path.strip() or config_path or '/root/recognize_faces/fix_db.sh'

    logger.info(
        "admin.server_update: admin=%s  script=%s  fix_db_path_from_body=%r  config_path=%r",
        admin.username, script,
        body.fix_db_path or '(empty)',
        config_path or '(not set in config)',
    )

    def _stream():
        def _emit(msg):
            logger.debug("admin.server_update emit: %s", msg[:80])
            yield f"data: {msg}\n\n"
            _time.sleep(0.02)   # 20 ms — forces separate TCP packet per chunk

        yield from _emit(f"[admin] Script:       {script}")
        yield from _emit(f"[admin] Requested by: {admin.username}")
        yield from _emit(f"[admin] Running:      sudo bash {script}")

        env = os.environ.copy()
        env['CRISP_YES'] = '1'

        try:
            logger.info("admin.server_update: launching subprocess: sudo bash %s", script)
            proc = subprocess.Popen(
                ['sudo', 'bash', script],   # NOPASSWD — no -S, no stdin password
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                env=env,
                text=True,
                bufsize=1,
            )

            line_count = 0
            for line in iter(proc.stdout.readline, ''):
                stripped = line.rstrip()
                logger.debug("admin.server_update stdout[%d]: %s", line_count, stripped)
                line_count += 1
                yield from _emit(stripped)

            proc.wait()
            rc = proc.returncode
            logger.info("admin.server_update: DONE  exit_code=%d  lines_streamed=%d", rc, line_count)
            yield from _emit(f"[exit {rc}]")
            if rc == 0:
                yield from _emit("✓ Update complete — server will restart momentarily.")
            else:
                yield from _emit(f"✗ Script exited with code {rc}.")

        except FileNotFoundError as exc:
            logger.error("admin.server_update: sudo not found — %s", exc)
            yield from _emit(f"✗ Could not launch sudo: {exc}")
        except Exception as exc:
            logger.error("admin.server_update: unexpected error: %s", exc, exc_info=True)
            yield from _emit(f"ERROR: {exc}")

    return _sse_response(_stream())


@router.get("/logs")
def get_server_logs(lines: int = 200, _=Depends(require_admin)):
    """
    Stream the last N lines of the Python app log as SSE.

    Converted from JSONResponse to StreamingResponse because JSONResponse body
    is buffered by Apache and never forwarded to the browser in this setup.
    SSE (text/event-stream) is handled correctly by Apache's mod_proxy_http
    with flushpackets=on.

    Protocol:
      data: [PATH]/path/to/logfile     ← first event, log file location
      data: <log line text>            ← one event per line
      data: [DONE]                     ← final event
      data: [ERROR]<message>           ← only if something went wrong
    """
    import logging as _logging_mod
    from fastapi_app import _log_file as _app_log_file, state as _s

    # ── Locate log file (same logic as before) ────────────────────────────────
    handler_path = ''
    for h in _logging_mod.root.handlers:
        if hasattr(h, 'baseFilename') and h.baseFilename:
            handler_path = h.baseFilename
            logger.info("admin.get_server_logs: FileHandler path = %s", handler_path)
            break

    config_path = (_s.config or {}).get('logging', {}).get('file', '').strip()

    candidates = []
    for c in [handler_path, config_path, _app_log_file]:
        if c and c not in candidates:
            candidates.append(c)
    candidates += [
        '/var/log/face_recognition.log',
        '/var/log/face-rec/face_recognition.log',
        '/opt/crisp-lens/face_recognition.log',
        os.path.expanduser('~/face_recognition.log'),
        'face_recognition.log',
    ]
    seen, unique = set(), []
    for c in candidates:
        if c and c not in seen:
            seen.add(c)
            unique.append(c)

    logger.info("admin.get_server_logs: searching %d candidates, first 5 = %s",
                len(unique), unique[:5])

    log_file = None
    for candidate in unique:
        if os.path.isfile(candidate):
            log_file = candidate
            logger.info("admin.get_server_logs: FOUND %s", log_file)
            break

    def _stream():
        if not log_file:
            tried = ', '.join(unique[:5])
            logger.warning("admin.get_server_logs: not found; tried: %s", tried)
            yield f"data: [ERROR]Log file not found. Tried: {tried}\n\n"
            return

        try:
            logger.info("admin.get_server_logs: reading last %d lines from %s", lines, log_file)
            with open(log_file, 'r', errors='replace') as fh:
                tail = list(collections.deque(fh, maxlen=lines))
            logger.info("admin.get_server_logs: streaming %d lines", len(tail))
            yield f"data: [PATH]{log_file}\n\n"
            for ln in tail:
                yield f"data: {ln.rstrip()}\n\n"
            yield "data: [DONE]\n\n"
            logger.info("admin.get_server_logs: stream complete")
        except Exception as exc:
            logger.error("admin.get_server_logs: error: %s", exc, exc_info=True)
            yield f"data: [ERROR]{exc}\n\n"

    return _sse_response(_stream())
