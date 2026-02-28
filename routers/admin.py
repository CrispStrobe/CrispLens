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
from fastapi.responses import JSONResponse, Response, StreamingResponse
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
    GET SSE with NO sleep (burst) — 6 lines, ~300 bytes total.
    Works because the response is tiny (fits in one TCP segment).
    """
    def _gen():
        logger.info("test-stream-fast: starting burst of 6 lines")
        for i in range(1, 6):
            logger.debug("test-stream-fast yield %d", i)
            yield f"data: [GET/fast] line {i} — {_time.strftime('%H:%M:%S')}\n\n"
        yield "data: ✓ GET/fast stream complete\n\n"
        logger.info("test-stream-fast: generator exhausted")

    return _sse_response(_gen())


@router.get("/test-stream-large")
def test_stream_large(admin=Depends(require_admin)):
    """
    GET SSE — 300 dummy lines, NO sleep.
    If this hangs too → the problem is response SIZE (Apache flushpackets needs
    real time-gaps; large bursts don't get flushed).
    If this works → the problem is specific to the /logs content.
    """
    def _gen():
        logger.info("test-stream-large: starting 300-line burst")
        for i in range(1, 301):
            yield f"data: [large] line {i:03d} of 300 — {_time.strftime('%H:%M:%S')}\n\n"
        yield "data: ✓ large burst complete\n\n"
        logger.info("test-stream-large: done")

    return _sse_response(_gen())


@router.post("/test-stream-post")
def test_stream_post(admin=Depends(require_admin)):
    """
    POST SSE with 0.4 s sleep.
    If this works but POST /update hangs → the issue is specific to the update
    endpoint (subprocess I/O or nested generator pattern).
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
    Stream the output of: sudo bash <fix_db_path>

    Uses a sync generator so Starlette runs it in a thread-pool worker via
    iterate_in_threadpool — identical pattern to the known-good test endpoints.
    The fix_db.sh script skips the interactive prompt automatically when stdin
    is not a terminal (DEVNULL), so no CRISP_YES env var trickery is needed.

    Requires sudoers: face-rec ALL=(ALL) NOPASSWD: /bin/bash /path/to/fix_db.sh
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

    def _gen():
        logger.info("admin.server_update: starting SSE stream for script: %s", script)
        
        # Small sleeps between every yield so Apache's flushpackets=on
        # sees real chunk gaps and flushes each event to the browser.
        yield f"data: [admin] Script:       {script}\n\n";  _time.sleep(0.05)
        yield f"data: [admin] Requested by: {admin.username}\n\n"; _time.sleep(0.05)
        yield f"data: [admin] Running:      sudo bash {script}\n\n"; _time.sleep(0.05)

        try:
            logger.info("admin.server_update: launching subprocess: sudo bash %s", script)
            proc = subprocess.Popen(
                ['sudo', 'bash', script],
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
            )

            line_count = 0
            for raw in iter(proc.stdout.readline, b''):
                stripped = raw.decode('utf-8', errors='replace').rstrip()
                # Log to server console for visibility
                if line_count % 20 == 0:
                    logger.info("admin.server_update: streaming line %d: %s", line_count, stripped[:80])
                else:
                    logger.debug("admin.server_update stdout[%d]: %s", line_count, stripped)
                
                line_count += 1
                yield f"data: {stripped}\n\n"
                _time.sleep(0.02)   # flush each line through Apache before the next

            proc.wait()
            rc = proc.returncode
            logger.info(
                "admin.server_update: DONE  exit_code=%d  lines_streamed=%d", rc, line_count
            )

            yield f"data: [exit {rc}]\n\n";  _time.sleep(0.05)

            # -15 = SIGTERM from the service restarting itself mid-run — treat as success
            if rc in (0, -15):
                logger.info("admin.server_update: Success (rc=%d)", rc)
                yield "data: ✓ Update complete — server will restart momentarily.\n\n"
            else:
                logger.warning("admin.server_update: Script failed with code %d", rc)
                yield f"data: ✗ Script exited with code {rc}.\n\n"

        except FileNotFoundError as exc:
            logger.error("admin.server_update: sudo not found — %s", exc)
            yield f"data: ✗ Could not launch sudo: {exc}\n\n"
        except Exception as exc:
            logger.error("admin.server_update: unexpected error: %s", exc, exc_info=True)
            yield f"data: ERROR: {exc}\n\n"
        
        logger.info("admin.server_update: generator finishing")

    return _sse_response(_gen())


@router.get("/logs")
def get_server_logs(lines: int = 300, _=Depends(require_admin)):
    """
    Return the last N lines of the Python app log as an SSE stream.
    Now uses StreamingResponse with small sleeps to ensure Apache flushpackets=on
    works reliably, matching the 'test-stream' baseline.
    """
    import logging as _logging_mod
    from fastapi_app import _log_file as _app_log_file, state as _s

    logger.info("admin.get_server_logs: request for %d lines", lines)

    def _gen():
        # ── Locate log file ───────────────────────────────────────────────────
        handler_path = ''
        for h in _logging_mod.root.handlers:
            if hasattr(h, 'baseFilename') and h.baseFilename:
                handler_path = h.baseFilename
                break

        config_path = (_s.config or {}).get('logging', {}).get('file', '').strip()
        candidates = []
        for c in [handler_path, config_path, _app_log_file]:
            if c and c not in candidates:
                candidates.append(c)
        candidates += [
            '/opt/crisp-lens/face_recognition.log',
            'face_recognition.log',
            '/var/log/face_recognition.log',
            '/var/log/face-rec/face_recognition.log',
            os.path.expanduser('~/face_recognition.log'),
        ]
        
        seen, unique = set(), []
        for c in candidates:
            if c and c not in seen:
                seen.add(c)
                unique.append(c)

        log_file = None
        for candidate in unique:
            if os.path.isfile(candidate):
                log_file = candidate
                break

        if not log_file:
            tried = ', '.join(unique[:5])
            logger.warning("admin.get_server_logs: not found; tried: %s", tried)
            yield f"data: [ERROR]Log file not found. Tried: {tried}\n\n"
            return

        yield f"data: [PATH]{log_file}\n\n"
        _time.sleep(0.05)

        try:
            logger.info("admin.get_server_logs: reading %d lines from %s", lines, log_file)
            with open(log_file, 'r', errors='replace') as fh:
                tail = list(collections.deque(fh, maxlen=lines))
            
            logger.info("admin.get_server_logs: streaming %d lines", len(tail))
            for i, ln in enumerate(tail):
                # High verbosity: log every 50 lines to server console
                if i % 50 == 0:
                    logger.debug("admin.get_server_logs: streaming line %d/%d", i, len(tail))
                
                yield f"data: {ln.rstrip()}\n\n"
                # Crucial for Apache: tiny sleep between lines to force a flush
                _time.sleep(0.01)

            yield "data: [DONE]\n\n"
            logger.info("admin.get_server_logs: stream complete")

        except Exception as exc:
            logger.error("admin.get_server_logs: error: %s", exc, exc_info=True)
            yield f"data: [ERROR]{exc}\n\n"

    return _sse_response(_gen())
