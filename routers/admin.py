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
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from routers.deps import require_admin

router = APIRouter(prefix="/api/admin", tags=["admin"])
logger = logging.getLogger(__name__)


class UpdateRequest(BaseModel):
    root_password: str   # used once via sudo -S stdin, never logged or stored
    fix_db_path:   str = ''  # optional override; falls back to config then default


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

    if not body.root_password:
        raise HTTPException(status_code=400, detail="root_password is required")

    # Capture password; keep reference only until proc.stdin.close()
    password = body.root_password

    logger.info("admin.server_update: requested by admin=%s script=%s", admin.username, script)

    def _stream():
        yield f"data: [admin] Executing: sudo -S bash {script}\n\n"
        yield f"data: [admin] Requested by: {admin.username}\n\n"

        env = os.environ.copy()
        env['CRISP_YES'] = '1'   # skip the interactive confirmation in fix_db.sh

        try:
            logger.info("admin.server_update: launching subprocess sudo bash %s", script)
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
                logger.warning("admin.server_update: BrokenPipeError writing to stdin (sudo may have rejected pw)")
                yield "data: [warn] stdin pipe closed early — sudo may have rejected the password\n\n"

            line_count = 0
            for line in iter(proc.stdout.readline, ''):
                stripped = line.rstrip()
                if stripped:
                    logger.debug("admin.server_update output: %s", stripped)
                    line_count += 1
                yield f"data: {stripped}\n\n"

            proc.wait()
            rc = proc.returncode
            logger.info("admin.server_update: script finished exit_code=%d lines=%d", rc, line_count)
            yield f"data: [exit {rc}]\n\n"
            if rc == 0:
                yield "data: ✓ Update complete — server will restart momentarily.\n\n"
            else:
                yield f"data: ✗ Script exited with code {rc}.\n\n"

        except FileNotFoundError as exc:
            logger.error("admin.server_update: sudo not found — %s", exc)
            yield f"data: ✗ Could not launch sudo: {exc}\n\n"
        except Exception as exc:
            logger.error("admin.server_update: unexpected error: %s", exc, exc_info=True)
            yield f"data: ERROR: {exc}\n\n"

    return StreamingResponse(_stream(), media_type="text/event-stream")


@router.get("/logs")
def get_server_logs(lines: int = 200, _=Depends(require_admin)):
    """Return the last N lines of the Python application log file."""
    import logging as _logging_mod
    from fastapi_app import _log_file as _app_log_file, state as _s

    # 1) Most reliable: read path from the root logger's FileHandler (it's already open)
    handler_path = ''
    for h in _logging_mod.root.handlers:
        if hasattr(h, 'baseFilename') and h.baseFilename:
            handler_path = h.baseFilename
            logger.debug("admin.get_server_logs: handler_path=%s", handler_path)
            break

    # 2) Config file override
    config_path = (_s.config or {}).get('logging', {}).get('file', '').strip()

    # Build candidate list: handler path first (most reliable), then others
    candidates = []
    for c in [handler_path, config_path, _app_log_file]:
        if c and c not in candidates:
            candidates.append(c)

    # Absolute fallback locations
    candidates += [
        '/var/log/face_recognition.log',
        '/var/log/face-rec/face_recognition.log',
        os.path.expanduser('~/face_recognition.log'),
        'face_recognition.log',
    ]
    # Deduplicate while preserving order
    seen = set()
    unique = []
    for c in candidates:
        if c and c not in seen:
            seen.add(c)
            unique.append(c)

    logger.info("admin.get_server_logs: searching for log file, candidates=%s", unique[:4])

    log_file = None
    for candidate in unique:
        logger.debug("admin.get_server_logs: checking path %s", candidate)
        if os.path.isfile(candidate):
            log_file = candidate
            logger.info("admin.get_server_logs: found log file at %s", log_file)
            break

    if not log_file:
        tried = ', '.join(unique[:4])
        logger.warning("admin.get_server_logs: no log file found, tried: %s", tried)
        return {
            "lines": [],
            "path": unique[0] if unique else '',
            "error": f"Log file not found. Tried: {tried}",
        }

    try:
        logger.info("admin.get_server_logs: reading last %d lines from %s", lines, log_file)
        with open(log_file, 'r', errors='replace') as fh:
            tail = list(collections.deque(fh, maxlen=lines))
        result_lines = [l.rstrip() for l in tail]
        logger.info("admin.get_server_logs: returning %d lines", len(result_lines))
        return {"lines": result_lines, "path": log_file}
    except Exception as exc:
        logger.error("admin.get_server_logs: error reading %s: %s", log_file, exc, exc_info=True)
        return {"lines": [], "path": log_file, "error": str(exc)}
