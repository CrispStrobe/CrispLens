"""
routers/admin.py — Admin-only system operations.

  POST /api/admin/update   — stream git pull + fix_db.sh output via SSE
  GET  /api/admin/logs     — last N lines of the Python application log
"""
import collections
import logging
import os
import subprocess

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel

from routers.deps import require_admin

router = APIRouter(prefix="/api/admin", tags=["admin"])
logger = logging.getLogger(__name__)


class UpdateRequest(BaseModel):
    root_password: str   # used once via sudo -S stdin, never logged or stored
    fix_db_path:   str = ''  # optional override; falls back to config then default


@router.get("/test-stream")
def test_stream(admin=Depends(require_admin)):
    """
    Pure-Python SSE stream — no subprocess, no sudo.
    Yields 6 lines with 0.4 s gaps so we can confirm whether
    SSE chunks arrive in the browser incrementally or all at once.
    """
    import time as _time

    def _stream():
        for i in range(1, 6):
            yield f"data: line {i} — {_time.strftime('%H:%M:%S')} (admin={admin.username})\n\n"
            _time.sleep(0.4)
        yield "data: ✓ stream complete\n\n"

    return StreamingResponse(
        _stream(),
        media_type="text/event-stream",
        headers={
            "X-Accel-Buffering": "no",
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
        },
    )


@router.post("/update")
def server_update(body: UpdateRequest, admin=Depends(require_admin)):
    """
    Stream the output of: CRISP_YES=1 sudo -S bash <fix_db_path>
    The root password is piped to sudo's stdin and discarded immediately.
    Output is streamed as SSE (text/event-stream).

    NOTE: We intentionally skip the os.path.isfile() pre-check because the
    application process (face-rec user) typically has no read permission on
    /root/. sudo + bash will report a clear error if the script is missing.
    """
    from fastapi_app import state as _s

    config_path = (_s.config or {}).get('admin', {}).get('fix_db_path', '')
    script = body.fix_db_path.strip() or config_path or '/root/CrispLense/fix_db.sh'

    # ── Verbose diagnostics (sanitised: password length only) ───────────────
    pw_len = len(body.root_password) if body.root_password else 0
    logger.info(
        "admin.server_update: admin=%s  script=%s  pw_len=%d  fix_db_path_from_body=%r  config_path=%r",
        admin.username, script, pw_len,
        body.fix_db_path or '(empty)',
        config_path or '(not set in config)',
    )

    if not body.root_password:
        logger.warning("admin.server_update: rejected — root_password is empty")
        raise HTTPException(status_code=400, detail="root_password is required")

    # Capture password; keep reference only until proc.stdin.close()
    password = body.root_password

    def _stream():
        yield f"data: [admin] Script: {script}\n\n"
        yield f"data: [admin] Requested by: {admin.username}\n\n"
        yield f"data: [admin] Running: sudo -S bash {script}\n\n"

        env = os.environ.copy()
        env['CRISP_YES'] = '1'   # skip the interactive confirmation in fix_db.sh

        try:
            logger.info("admin.server_update: launching subprocess: sudo -S bash %s", script)
            proc = subprocess.Popen(
                ['sudo', '-S', 'bash', script],
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                env=env,
                text=True,
                bufsize=1,
            )
            # Write password to sudo stdin then close immediately so sudo can proceed
            try:
                proc.stdin.write(password + '\n')
                proc.stdin.flush()
                proc.stdin.close()
            except BrokenPipeError:
                logger.warning(
                    "admin.server_update: BrokenPipeError writing to stdin — "
                    "sudo may have rejected the password immediately"
                )
                yield "data: [warn] stdin pipe closed early — check the root password\n\n"

            line_count = 0
            for line in iter(proc.stdout.readline, ''):
                stripped = line.rstrip()
                logger.debug("admin.server_update output[%d]: %s", line_count, stripped)
                line_count += 1
                yield f"data: {stripped}\n\n"

            proc.wait()
            rc = proc.returncode
            logger.info(
                "admin.server_update: DONE  exit_code=%d  lines_streamed=%d",
                rc, line_count
            )
            yield f"data: [exit {rc}]\n\n"
            if rc == 0:
                yield "data: ✓ Update complete — server will restart momentarily.\n\n"
            else:
                yield f"data: ✗ Script exited with code {rc}.\n\n"

        except FileNotFoundError as exc:
            logger.error("admin.server_update: sudo binary not found — %s", exc)
            yield f"data: ✗ Could not launch sudo: {exc}\n\n"
        except Exception as exc:
            logger.error("admin.server_update: unexpected error: %s", exc, exc_info=True)
            yield f"data: ERROR: {exc}\n\n"

    return StreamingResponse(
        _stream(),
        media_type="text/event-stream",
        headers={
            # Tell nginx NOT to buffer this response — without this the browser's
            # ReadableStream never receives chunks and hangs indefinitely.
            "X-Accel-Buffering": "no",
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
        },
    )


@router.get("/logs")
def get_server_logs(lines: int = 200, _=Depends(require_admin)):
    """Return the last N lines of the Python application log file."""
    import logging as _logging_mod
    from fastapi_app import _log_file as _app_log_file, state as _s

    # ── Step 1: most reliable — read path from the already-open FileHandler ──
    handler_path = ''
    for h in _logging_mod.root.handlers:
        if hasattr(h, 'baseFilename') and h.baseFilename:
            handler_path = h.baseFilename
            logger.info("admin.get_server_logs: FileHandler path = %s", handler_path)
            break
    if not handler_path:
        logger.warning("admin.get_server_logs: no FileHandler found on root logger")

    # ── Step 2: config override ───────────────────────────────────────────────
    config_path = (_s.config or {}).get('logging', {}).get('file', '').strip()

    # ── Build candidate list (handler path is first and most reliable) ────────
    candidates = []
    for c in [handler_path, config_path, _app_log_file]:
        if c and c not in candidates:
            candidates.append(c)

    # Absolute fallback locations
    candidates += [
        '/var/log/face_recognition.log',
        '/var/log/face-rec/face_recognition.log',
        '/opt/crisp-lens/face_recognition.log',
        os.path.expanduser('~/face_recognition.log'),
        'face_recognition.log',
    ]
    # Deduplicate while preserving order
    seen, unique = set(), []
    for c in candidates:
        if c and c not in seen:
            seen.add(c)
            unique.append(c)

    logger.info(
        "admin.get_server_logs: searching %d candidates, first 5 = %s",
        len(unique), unique[:5]
    )

    log_file = None
    for candidate in unique:
        exists = os.path.isfile(candidate)
        logger.debug("admin.get_server_logs:   %s  exists=%s", candidate, exists)
        if exists:
            log_file = candidate
            logger.info("admin.get_server_logs: FOUND log file at %s", log_file)
            break

    # Tell nginx never to buffer this response — without this the browser's fetch()
    # keeps waiting for the body even though uvicorn has already sent it.
    _NO_BUF = {"X-Accel-Buffering": "no", "Cache-Control": "no-store"}

    if not log_file:
        tried = ', '.join(unique[:5])
        logger.warning("admin.get_server_logs: log file not found; tried: %s", tried)
        return JSONResponse(
            content={
                "lines": [],
                "path": unique[0] if unique else '(none)',
                "error": f"Log file not found. Tried paths: {tried}",
            },
            headers=_NO_BUF,
        )

    try:
        logger.info("admin.get_server_logs: reading last %d lines from %s", lines, log_file)
        with open(log_file, 'r', errors='replace') as fh:
            tail = list(collections.deque(fh, maxlen=lines))
        result = [l.rstrip() for l in tail]
        logger.info("admin.get_server_logs: returning %d lines", len(result))
        return JSONResponse(content={"lines": result, "path": log_file}, headers=_NO_BUF)
    except Exception as exc:
        logger.error("admin.get_server_logs: error reading %s: %s", log_file, exc, exc_info=True)
        return JSONResponse(content={"lines": [], "path": log_file, "error": str(exc)}, headers=_NO_BUF)
