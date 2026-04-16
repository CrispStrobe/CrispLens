"""
cloud_drive_manager.py — Unified mount/connect/browse manager for cloud and network drives.

Supported types:
  smb      — SMB/CIFS network share  (OS-level mount via mount_smbfs / mount.cifs)
  sftp     — SFTP filesystem          (OS-level mount via sshfs)
  filen    — Filen encrypted cloud    (bridge to ../filen-python)
  internxt — Internxt encrypted cloud (bridge to ../internxt-cli)

Credentials are stored Fernet-encrypted in the cloud_drives DB table.
Active cloud sessions are cached in _sessions (in-memory, cleared on restart).
"""
import json
import logging
import os
import platform
import sqlite3
import subprocess
import time
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

# ── In-memory session cache ───────────────────────────────────────────────────
# { drive_id: { 'session': <credentials dict>, 'expires_at': <unix ts> } }
_sessions: dict[int, dict[str, Any]] = {}
_SESSION_TTL = 23 * 3600   # 23 hours


# ── Fernet encryption helper ──────────────────────────────────────────────────

def _get_fernet(db_path: str):
    """Return a Fernet instance using the app's secret key (shared with ApiKeyManager)."""
    secret_file = os.path.join(os.path.dirname(db_path), '.api_secret_key')
    if not os.path.exists(secret_file):
        secret_file = '.api_secret_key'
    from cryptography.fernet import Fernet
    if os.path.exists(secret_file):
        with open(secret_file, 'rb') as f:
            key = f.read().strip()
    else:
        key = Fernet.generate_key()
        with open(secret_file, 'wb') as f:
            f.write(key)
        os.chmod(secret_file, 0o600)
    return Fernet(key)


def encrypt_config(db_path: str, config: dict[str, Any]) -> str:
    return _get_fernet(db_path).encrypt(json.dumps(config).encode()).decode()


def decrypt_config(db_path: str, token: str) -> dict[str, Any]:
    return json.loads(_get_fernet(db_path).decrypt(token.encode()).decode())


# ── DB helpers ────────────────────────────────────────────────────────────────

def _connect(db_path: str) -> sqlite3.Connection:
    conn = sqlite3.connect(db_path, timeout=10.0)
    conn.row_factory = sqlite3.Row
    conn.execute('PRAGMA journal_mode=WAL')
    return conn


def ensure_table(db_path: str) -> None:
    conn = None
    try:
        conn = _connect(db_path)
        conn.execute('''
            CREATE TABLE IF NOT EXISTS cloud_drives (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                type TEXT NOT NULL,
                config_encrypted TEXT NOT NULL DEFAULT '',
                mount_point TEXT,
                scope TEXT NOT NULL DEFAULT 'system',
                owner_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
                allowed_roles TEXT NOT NULL DEFAULT '["admin","medienverwalter"]',
                auto_mount INTEGER NOT NULL DEFAULT 0,
                enabled INTEGER NOT NULL DEFAULT 1,
                is_mounted INTEGER NOT NULL DEFAULT 0,
                last_error TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        ''')
        conn.commit()
    finally:
        if conn:
            conn.close()


# ── SMB / CIFS ────────────────────────────────────────────────────────────────

def _mount_smb(cfg: dict[str, Any], mount_point: str) -> tuple[bool, str]:
    from drive_mount import DriveMount
    return DriveMount.mount_smb(
        server=cfg['server'],
        share=cfg['share'],
        mount_point=mount_point,
        username=cfg['username'],
        password=cfg['password'],
        domain=cfg.get('domain', ''),
        read_only=cfg.get('read_only', False),
    )


# ── SFTP (sshfs) ─────────────────────────────────────────────────────────────

def _mount_sftp(cfg: dict[str, Any], mount_point: str) -> tuple[bool, str]:
    server = cfg.get('server', '')
    port = cfg.get('port', 22)
    username = cfg.get('username', '')
    remote_path = cfg.get('remote_path', '/')
    password = cfg.get('password', '')
    ssh_key = cfg.get('ssh_key', '')

    if not server or not username:
        return False, 'server and username are required for SFTP'

    Path(mount_point).mkdir(parents=True, exist_ok=True)

    try:
        result = subprocess.run(['mount'], capture_output=True, text=True, timeout=5)
        if mount_point in result.stdout:
            return True, f'Already mounted at {mount_point}'
    except Exception:
        pass

    cmd = ['sshfs', f'{username}@{server}:{remote_path}', mount_point,
           '-p', str(port), '-o', 'StrictHostKeyChecking=no']
    if ssh_key:
        cmd.extend(['-o', f'IdentityFile={ssh_key}'])
    elif password:
        cmd = ['sshpass', '-p', password] + cmd

    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
        if result.returncode == 0:
            return True, f'Mounted {server}:{remote_path} at {mount_point}'
        err = result.stderr.strip() or result.stdout.strip()
        return False, f'sshfs failed: {err}'
    except FileNotFoundError:
        return False, 'sshfs not installed (brew install sshfs / apt install sshfs)'
    except subprocess.TimeoutExpired:
        return False, 'SFTP mount timeout'
    except Exception as e:
        return False, f'SFTP mount error: {e}'


def _unmount_path(mount_point: str, force: bool = False) -> tuple[bool, str]:
    system = platform.system()
    try:
        if system == 'Darwin':
            cmd = ['umount'] + (['-f'] if force else []) + [mount_point]
        else:
            cmd = ['sudo', 'umount'] + (['-f'] if force else []) + [mount_point]
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=15)
        if result.returncode == 0:
            return True, f'Unmounted {mount_point}'
        err = result.stderr.strip() or result.stdout.strip()
        return False, f'Unmount failed: {err}'
    except subprocess.TimeoutExpired:
        return False, 'Unmount timeout'
    except Exception as e:
        return False, f'Unmount error: {e}'


def _is_mounted(mount_point: str) -> bool:
    try:
        result = subprocess.run(['mount'], capture_output=True, text=True, timeout=5)
        resolved = str(Path(mount_point).resolve())
        for line in result.stdout.splitlines():
            if resolved in line or mount_point in line:
                return True
        return False
    except Exception:
        return False


# ── Cloud session helpers ─────────────────────────────────────────────────────

def _get_cached_session(drive_id: int) -> dict[str, Any] | None:
    entry = _sessions.get(drive_id)
    if entry and entry['expires_at'] > time.time():
        return entry['session']
    _sessions.pop(drive_id, None)
    return None


def _cache_session(drive_id: int, session: dict[str, Any]) -> None:
    _sessions[drive_id] = {'session': session, 'expires_at': time.time() + _SESSION_TTL}


def _connect_filen(cfg: dict[str, Any], drive_id: int) -> tuple[bool, str]:
    """Authenticate with Filen and cache the session."""
    # Use cached session if still valid
    if _get_cached_session(drive_id):
        return True, 'Already connected (session cached)'
    try:
        from cloud.filen_bridge import filen_login
        session = filen_login(cfg['email'], cfg['password'], cfg.get('tfa_code'))
        _cache_session(drive_id, session)
        return True, f"Connected as {session['email']} (root: {session.get('baseFolderUUID', '')[:8]}…)"
    except ValueError as e:
        return False, str(e)
    except Exception as e:
        return False, f'Filen connection error: {e}'


def _connect_internxt(cfg: dict[str, Any], drive_id: int) -> tuple[bool, str]:
    """Authenticate with Internxt and cache the session."""
    if _get_cached_session(drive_id):
        return True, 'Already connected (session cached)'
    try:
        from cloud.internxt_bridge import internxt_login
        session = internxt_login(cfg['email'], cfg['password'], cfg.get('tfa_code'))
        _cache_session(drive_id, session)
        user = session.get('user', {})
        return True, f"Connected as {user.get('email', cfg['email'])}"
    except ValueError as e:
        return False, str(e)
    except Exception as e:
        return False, f'Internxt connection error: {e}'


# ── Public API — mount / unmount ──────────────────────────────────────────────

def mount_drive(db_path: str, drive_id: int) -> tuple[bool, str]:
    """Mount / connect a drive by ID. Updates is_mounted and last_error in DB."""
    conn = None
    try:
        conn = _connect(db_path)
        row = conn.execute('SELECT * FROM cloud_drives WHERE id=?', (drive_id,)).fetchone()
    finally:
        if conn:
            conn.close()

    if not row:
        return False, 'Drive not found'

    drive = dict(row)
    cfg = decrypt_config(db_path, drive['config_encrypted'])
    dtype = drive['type']
    mount_point = drive.get('mount_point') or ''

    try:
        if dtype == 'smb':
            ok, msg = _mount_smb(cfg, mount_point) if mount_point else (False, 'Mount point required for SMB')
        elif dtype == 'sftp':
            ok, msg = _mount_sftp(cfg, mount_point) if mount_point else (False, 'Mount point required for SFTP')
        elif dtype == 'filen':
            ok, msg = _connect_filen(cfg, drive_id)
        elif dtype == 'internxt':
            ok, msg = _connect_internxt(cfg, drive_id)
        else:
            ok, msg = False, f'Unknown drive type: {dtype}'
    except Exception as e:
        ok, msg = False, str(e)

    _update_mount_status(db_path, drive_id, ok, None if ok else msg)
    return ok, msg


def unmount_drive(db_path: str, drive_id: int) -> tuple[bool, str]:
    """Unmount / disconnect a drive by ID."""
    conn = None
    try:
        conn = _connect(db_path)
        row = conn.execute('SELECT * FROM cloud_drives WHERE id=?', (drive_id,)).fetchone()
    finally:
        if conn:
            conn.close()

    if not row:
        return False, 'Drive not found'

    drive = dict(row)
    dtype = drive['type']
    mount_point = drive.get('mount_point') or ''

    if dtype in ('smb', 'sftp'):
        ok, msg = _unmount_path(mount_point) if mount_point else (True, 'No mount point set')
    else:
        _sessions.pop(drive_id, None)
        ok, msg = True, 'Disconnected'

    if ok:
        _update_mount_status(db_path, drive_id, False, None)
    return ok, msg


def get_drive_status(drive: dict[str, Any]) -> dict[str, Any]:
    """Return live mount/connection status for a drive row dict."""
    dtype = drive.get('type', '')
    drive_id = drive.get('id')
    mount_point = drive.get('mount_point') or ''

    if dtype in ('smb', 'sftp') and mount_point:
        is_live = _is_mounted(mount_point)
    elif dtype in ('filen', 'internxt'):
        is_live = bool(_get_cached_session(drive_id)) if drive_id else bool(drive.get('is_mounted'))
    else:
        is_live = bool(drive.get('is_mounted'))

    return {**drive, 'is_mounted': is_live, 'config_encrypted': None}


# ── Public API — file operations ──────────────────────────────────────────────

IMAGE_EXTENSIONS = {'.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp', '.tiff', '.tif', '.pgm'}
VIDEO_EXTENSIONS = {'.mp4', '.mov', '.mkv', '.avi', '.webm', '.m4v', '.mpg', '.mpeg'}
MEDIA_EXTENSIONS = IMAGE_EXTENSIONS | VIDEO_EXTENSIONS


def _get_drive(db_path: str, drive_id: int) -> dict[str, Any]:
    """Return drive row dict. Raises RuntimeError if not found."""
    conn = None
    try:
        conn = _connect(db_path)
        row = conn.execute('SELECT * FROM cloud_drives WHERE id=?', (drive_id,)).fetchone()
    finally:
        if conn:
            conn.close()
    if not row:
        raise RuntimeError('Drive not found')
    return dict(row)


def _get_session_or_raise(db_path: str, drive_id: int) -> tuple[dict[str, Any], dict[str, Any]]:
    """Return (drive_row, session_credentials). Raises RuntimeError if not connected."""
    drive = _get_drive(db_path, drive_id)
    session = _get_cached_session(drive_id)
    if session is None:
        raise RuntimeError('Drive is not connected. Mount it first.')
    return drive, session


def list_dir(db_path: str, drive_id: int, path: str = '/') -> list[dict[str, Any]]:
    """
    List directory contents for SMB/SFTP (os.listdir) or Filen/Internxt (API).
    Returns list of {name, is_dir, size, path}.
    SMB/SFTP do not require a cached session — they use the OS mount point.
    """
    drive = _get_drive(db_path, drive_id)
    dtype = drive['type']

    if dtype in ('smb', 'sftp'):
        mount_point = drive.get('mount_point', '')
        if not mount_point:
            raise RuntimeError('No mount point configured for this drive')
        if not _is_mounted(mount_point):
            raise RuntimeError('Drive is not mounted. Mount it first.')
        full_path = os.path.join(mount_point, path.lstrip('/'))
        entries = []
        try:
            for entry in os.scandir(full_path):
                entries.append({
                    'name': entry.name,
                    'is_dir': entry.is_dir(),
                    'size': entry.stat().st_size if entry.is_file() else None,
                    'path': os.path.join(path, entry.name),
                })
        except PermissionError as e:
            raise RuntimeError(f'Permission denied: {e}')  # noqa: B904
        entries.sort(key=lambda e: (not e['is_dir'], e['name'].lower()))
        return entries

    # Filen / Internxt require an active session; auto-reconnect if session was
    # lost after a server restart but the drive was marked connected in the DB.
    session = _get_cached_session(drive_id)
    if session is None:
        if drive.get('is_mounted'):
            ok, msg = mount_drive(db_path, drive_id)
            if ok:
                session = _get_cached_session(drive_id)
            if session is None:
                raise RuntimeError(f'Auto-reconnect failed: {msg}')
        else:
            raise RuntimeError('Drive is not connected. Mount it first.')

    if dtype == 'filen':
        from cloud.filen_bridge import get_filen_drive, list_dir as filen_list, resolve_path
        drive_svc = get_filen_drive(session)
        if path in ('/', ''):
            folder_uuid = session.get('baseFolderUUID', '')
        else:
            meta = resolve_path(drive_svc, path)
            folder_uuid = meta.get('uuid', '')
        items = filen_list(drive_svc, folder_uuid)
        for item in items:
            item['path'] = f"{path.rstrip('/')}/{item['name']}"
        return items

    elif dtype == 'internxt':
        from cloud.internxt_bridge import get_internxt_drive, list_dir as internxt_list
        drive_svc = get_internxt_drive(session)
        items = internxt_list(drive_svc, path or '/')
        for item in items:
            item['path'] = f"{path.rstrip('/')}/{item['name']}"
        return items

    raise RuntimeError(f'Unsupported drive type: {dtype}')


def list_image_files(db_path: str, drive_id: int, path: str,
                     recursive: bool = True) -> list[dict[str, Any]]:
    """
    Return a flat list of image file entries under 'path'.
    'path' may be a directory (walked) or a single image file.
    Each entry: {name, is_dir:False, uuid (cloud types), path, size}.
    """
    drive = _get_drive(db_path, drive_id)
    dtype = drive['type']
    result = []

    def _try_single_file(cur_path: str) -> None:
        """Resolve cur_path as a single image file and append to result."""
        ext = os.path.splitext(cur_path)[1].lower()
        if ext not in IMAGE_EXTENSIONS:
            return

        if dtype in ('smb', 'sftp'):
            mount_point = drive.get('mount_point', '')
            abs_path = os.path.join(mount_point, cur_path.lstrip('/'))
            if os.path.isfile(abs_path):
                result.append({
                    'name': os.path.basename(cur_path),
                    'is_dir': False,
                    'size': os.path.getsize(abs_path),
                    'path': cur_path,
                })
            return

        session = _get_cached_session(drive_id)
        if session is None:
            return

        if dtype == 'internxt':
            try:
                from cloud.internxt_bridge import get_internxt_drive, get_file_item
                drv = get_internxt_drive(session)
                item = get_file_item(drv, cur_path)
                if item:
                    result.append(item)
            except Exception as exc:
                logger.debug('list_image_files: internxt file resolve %s: %s', cur_path, exc)
        elif dtype == 'filen':
            try:
                from cloud.filen_bridge import get_filen_drive, get_file_item
                drv = get_filen_drive(session)
                item = get_file_item(drv, cur_path)
                if item:
                    result.append(item)
            except Exception as exc:
                logger.debug('list_image_files: filen file resolve %s: %s', cur_path, exc)

    def _walk(cur_path: str) -> None:
        try:
            entries = list_dir(db_path, drive_id, cur_path)
        except Exception:
            # list_dir failed — cur_path is likely a single file, not a directory
            _try_single_file(cur_path)
            return
        # For cloud drives: an empty listing where the path has an image extension
        # means the path resolved to a file UUID (not a folder).  Filen returns []
        # in this case instead of raising.
        if not entries and dtype in ('filen', 'internxt'):
            ext = os.path.splitext(cur_path)[1].lower()
            if ext in IMAGE_EXTENSIONS:
                _try_single_file(cur_path)
                return
        for e in entries:
            if e['is_dir']:
                if recursive:
                    _walk(e['path'])
            else:
                ext = os.path.splitext(e['name'])[1].lower()
                if ext in IMAGE_EXTENSIONS:
                    result.append(e)

    _walk(path)
    return result


def download_to_temp(db_path: str, drive_id: int,
                     item: dict[str, Any]) -> tuple[str, bool]:
    """
    Resolve an item to a local path the processing engine can read.

    SMB/SFTP: files are already on the local filesystem; returns (abs_path, False).
    Filen/Internxt: download to a temp file; returns (tmp_path, True).
    The caller is responsible for deleting the temp file when is_temp=True.
    """
    drive = _get_drive(db_path, drive_id)
    dtype = drive['type']

    if dtype in ('smb', 'sftp'):
        mount_point = drive.get('mount_point', '')
        abs_path = os.path.join(mount_point, item['path'].lstrip('/'))
        return abs_path, False

    # Cloud types — need session; auto-reconnect if session was lost
    session = _get_cached_session(drive_id)
    if session is None:
        if drive.get('is_mounted'):
            ok, msg = mount_drive(db_path, drive_id)
            if ok:
                session = _get_cached_session(drive_id)
            if session is None:
                raise RuntimeError(f'Auto-reconnect failed: {msg}')
        else:
            raise RuntimeError('Drive is not connected. Mount it first.')

    import tempfile
    suffix = os.path.splitext(item.get('name', 'file'))[1] or '.jpg'
    fd, tmp_path = tempfile.mkstemp(suffix=suffix)
    os.close(fd)

    try:
        if dtype == 'filen':
            from cloud.filen_bridge import get_filen_drive
            drive_svc = get_filen_drive(session)
            drive_svc.download_file(item['uuid'], tmp_path, quiet=True)
        elif dtype == 'internxt':
            from cloud.internxt_bridge import get_internxt_drive
            drive_svc = get_internxt_drive(session)
            drive_svc.download_file(item['uuid'], tmp_path)
        else:
            raise RuntimeError(f'Unsupported drive type: {dtype}')
        return tmp_path, True
    except Exception:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
        raise


def make_dir(db_path: str, drive_id: int, path: str) -> bool:
    """Create a directory. Returns True on success."""
    drive = _get_drive(db_path, drive_id)
    dtype = drive['type']

    if dtype in ('smb', 'sftp'):
        mount_point = drive.get('mount_point', '')
        full_path = os.path.join(mount_point, path.lstrip('/'))
        os.makedirs(full_path, exist_ok=True)
        return True

    session = _get_cached_session(drive_id)
    if session is None:
        raise RuntimeError('Drive is not connected. Mount it first.')

    if dtype == 'filen':
        from cloud.filen_bridge import get_filen_drive, resolve_path
        drive_svc = get_filen_drive(session)
        parent_path, name = path.rsplit('/', 1)
        parent_meta = resolve_path(drive_svc, parent_path or '/')
        drive_svc.create_folder(name, parent_meta['uuid'])
        return True

    elif dtype == 'internxt':
        from cloud.internxt_bridge import get_internxt_drive
        from cloud.internxt_bridge import _ensure_path
        _ensure_path()
        drive_svc = get_internxt_drive(session)
        # resolve parent
        parent_path, name = path.rsplit('/', 1)
        parent_meta = drive_svc.resolve_path(parent_path or '/')
        drive_svc.api.create_folder({'plainName': name,
                                     'parentFolderUuid': parent_meta['uuid']})
        return True

    raise RuntimeError(f'Unsupported drive type: {dtype}')


def rename_item(db_path: str, drive_id: int, path: str, new_name: str) -> bool:
    """
    Rename a file or folder at 'path' to 'new_name' (basename only, no slashes).
    Returns True on success.
    """
    if '/' in new_name or '\\' in new_name:
        raise ValueError('new_name must be a simple name without path separators')

    drive = _get_drive(db_path, drive_id)
    dtype = drive['type']

    if dtype in ('smb', 'sftp'):
        mount_point = drive.get('mount_point', '')
        old_abs = os.path.join(mount_point, path.lstrip('/'))
        new_abs = os.path.join(os.path.dirname(old_abs), new_name)
        os.rename(old_abs, new_abs)
        return True

    session = _get_cached_session(drive_id)
    if session is None:
        raise RuntimeError('Drive is not connected. Mount it first.')

    if dtype == 'internxt':
        from cloud.internxt_bridge import get_internxt_drive
        drv = get_internxt_drive(session)
        resolved = drv.resolve_path(path)
        if resolved['type'] == 'file':
            drv.rename_file(resolved['uuid'], new_name)
        else:
            drv.rename_folder(resolved['uuid'], new_name)
        return True

    if dtype == 'filen':
        from cloud.filen_bridge import get_filen_drive, resolve_path
        drv = get_filen_drive(session)
        meta = resolve_path(drv, path)
        uuid = meta.get('uuid', '')
        # Try file rename, fall back to folder rename
        try:
            drv.rename_file(uuid, new_name)
        except Exception:
            drv.rename_folder(uuid, new_name)
        return True

    raise RuntimeError(f'Unsupported drive type: {dtype}')


def trash_item(db_path: str, drive_id: int, path: str) -> bool:
    """
    Move a file or folder to the cloud trash.
    For SMB/SFTP, physically deletes the file (trash not available for network drives).
    Returns True on success.
    """
    drive = _get_drive(db_path, drive_id)
    dtype = drive['type']

    if dtype in ('smb', 'sftp'):
        mount_point = drive.get('mount_point', '')
        abs_path = os.path.join(mount_point, path.lstrip('/'))
        if os.path.isdir(abs_path):
            import shutil
            shutil.rmtree(abs_path)
        else:
            os.remove(abs_path)
        return True

    session = _get_cached_session(drive_id)
    if session is None:
        raise RuntimeError('Drive is not connected. Mount it first.')

    if dtype == 'internxt':
        from cloud.internxt_bridge import get_internxt_drive
        drv = get_internxt_drive(session)
        drv.trash_by_path(path)
        return True

    if dtype == 'filen':
        from cloud.filen_bridge import get_filen_drive, resolve_path
        drv = get_filen_drive(session)
        meta = resolve_path(drv, path)
        uuid = meta.get('uuid', '')
        try:
            drv.trash_file(uuid)
        except Exception:
            drv.trash_folder(uuid)
        return True

    raise RuntimeError(f'Unsupported drive type: {dtype}')


def delete_item(db_path: str, drive_id: int, path: str) -> bool:
    """
    Permanently delete a file or folder.
    Returns True on success.
    """
    drive = _get_drive(db_path, drive_id)
    dtype = drive['type']

    if dtype in ('smb', 'sftp'):
        mount_point = drive.get('mount_point', '')
        abs_path = os.path.join(mount_point, path.lstrip('/'))
        if os.path.isdir(abs_path):
            import shutil
            shutil.rmtree(abs_path)
        else:
            os.remove(abs_path)
        return True

    session = _get_cached_session(drive_id)
    if session is None:
        raise RuntimeError('Drive is not connected. Mount it first.')

    if dtype == 'internxt':
        from cloud.internxt_bridge import get_internxt_drive
        drv = get_internxt_drive(session)
        drv.delete_permanently_by_path(path)
        return True

    if dtype == 'filen':
        from cloud.filen_bridge import get_filen_drive, resolve_path
        drv = get_filen_drive(session)
        meta = resolve_path(drv, path)
        uuid = meta.get('uuid', '')
        try:
            drv.delete_permanently_file(uuid)
        except Exception:
            drv.delete_permanently_folder(uuid)
        return True

    raise RuntimeError(f'Unsupported drive type: {dtype}')


# ── DB update helper ──────────────────────────────────────────────────────────

def _update_mount_status(db_path: str, drive_id: int, is_mounted: bool,
                          last_error: str | None) -> None:
    conn = None
    try:
        conn = _connect(db_path)
        conn.execute(
            'UPDATE cloud_drives SET is_mounted=?, last_error=?, '
            'updated_at=CURRENT_TIMESTAMP WHERE id=?',
            (1 if is_mounted else 0, last_error, drive_id),
        )
        conn.commit()
    finally:
        if conn:
            conn.close()
