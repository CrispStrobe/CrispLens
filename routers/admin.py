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
def server_update(body: UpdateRequest, _=Depends(require_admin)):
    """
    Stream the output of: CRISP_YES=1 sudo -S bash <fix_db_path>
    The root password is piped to sudo's stdin and discarded immediately.
    Output is streamed as SSE (text/event-stream).
    """
    from fastapi_app import state as _s
    config_path = (_s.config or {}).get('admin', {}).get('fix_db_path', '')
    script = body.fix_db_path or config_path or '/root/CrispLense/fix_db.sh'

    if not os.path.isfile(script):
        raise HTTPException(
            status_code=400,
            detail=f"fix_db.sh not found at: {script}. Set admin.fix_db_path in config.",
        )

    # Capture password in local variable; clear body reference as soon as possible
    password = body.root_password
    if not password:
        raise HTTPException(status_code=400, detail="root_password is required")

    def _stream():
        env = os.environ.copy()
        env['CRISP_YES'] = '1'   # skip the interactive confirmation in fix_db.sh
        try:
            proc = subprocess.Popen(
                ['sudo', '-S', 'bash', script],
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                env=env,
                text=True,
                bufsize=1,
            )
            # Write password to sudo stdin then close immediately
            try:
                proc.stdin.write(password + '\n')
                proc.stdin.flush()
                proc.stdin.close()
            except BrokenPipeError:
                pass

            for line in iter(proc.stdout.readline, ''):
                yield f"data: {line.rstrip()}\n\n"

            proc.wait()
            rc = proc.returncode
            yield f"data: [exit {rc}]\n\n"
            if rc == 0:
                yield "data: ✓ Update complete — server will restart momentarily.\n\n"
            else:
                yield f"data: ✗ Script exited with code {rc}.\n\n"
        except Exception as exc:
            logger.error("server_update stream error: %s", exc)
            yield f"data: ERROR: {exc}\n\n"

    return StreamingResponse(_stream(), media_type="text/event-stream")


@router.get("/logs")
def get_server_logs(lines: int = 200, _=Depends(require_admin)):
    """Return the last N lines of the Python application log file."""
    from fastapi_app import state as _s, _DATA_DIR
    log_file = (_s.config or {}).get('logging', {}).get('file', '')
    if not log_file:
        log_file = (
            os.path.join(_DATA_DIR, 'face_recognition.log')
            if _DATA_DIR
            else 'face_recognition.log'
        )
    if not os.path.isfile(log_file):
        return {"lines": [], "path": log_file, "error": "Log file not found"}
    try:
        with open(log_file, 'r', errors='replace') as fh:
            tail = list(collections.deque(fh, maxlen=lines))
        return {"lines": [l.rstrip() for l in tail], "path": log_file}
    except Exception as exc:
        return {"lines": [], "path": log_file, "error": str(exc)}
