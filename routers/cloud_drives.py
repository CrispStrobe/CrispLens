"""
routers/cloud_drives.py — CRUD + mount/unmount for cloud / network drives.

Endpoints (all require admin or medienverwalter):
  GET    /api/cloud-drives              — list drives visible to current user
  POST   /api/cloud-drives              — create drive
  GET    /api/cloud-drives/{id}         — get single drive
  PUT    /api/cloud-drives/{id}         — update drive
  DELETE /api/cloud-drives/{id}         — delete drive
  POST   /api/cloud-drives/{id}/mount   — mount / connect
  POST   /api/cloud-drives/{id}/unmount — unmount / disconnect
  POST   /api/cloud-drives/test         — test credentials without saving
"""
import json
import logging
import os
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from routers.deps import get_current_user, require_admin_or_mediamanager
from cloud_drive_manager import (
    ensure_table, encrypt_config, decrypt_config,
    mount_drive, unmount_drive, get_drive_status,
    list_dir, make_dir, list_image_files, download_to_temp,
    rename_item, trash_item, delete_item,
    _connect as _db_connect,
    _mount_smb, _mount_sftp, _unmount_path,
)

logger = logging.getLogger(__name__)
router = APIRouter()


def _state():
    from fastapi_app import state
    return state


# ── Models ────────────────────────────────────────────────────────────────────

class DriveCreate(BaseModel):
    name: str
    type: str                             # smb | sftp | filen | internxt
    config: Dict[str, Any]               # plain credentials (will be encrypted)
    mount_point: Optional[str] = None
    scope: str = 'system'                # system | user
    allowed_roles: List[str] = ['admin', 'medienverwalter']
    auto_mount: bool = False
    enabled: bool = True


class DriveUpdate(BaseModel):
    name: Optional[str] = None
    config: Optional[Dict[str, Any]] = None
    mount_point: Optional[str] = None
    scope: Optional[str] = None
    allowed_roles: Optional[List[str]] = None
    auto_mount: Optional[bool] = None
    enabled: Optional[bool] = None


class TestDriveRequest(BaseModel):
    type: str
    config: Dict[str, Any]


class MkdirRequest(BaseModel):
    path: str


class IngestRequest(BaseModel):
    paths: List[str] = ['/']
    recursive: bool = True
    visibility: str = 'shared'


class RenameRequest(BaseModel):
    path: str
    new_name: str


class ItemPathRequest(BaseModel):
    path: str


# ── Helpers ───────────────────────────────────────────────────────────────────

def _user_can_see(drive: Dict[str, Any], user) -> bool:
    """Check whether `user` is allowed to see/use this drive."""
    if user.role == 'admin':
        return True
    try:
        allowed = json.loads(drive.get('allowed_roles') or '[]')
    except Exception:
        allowed = []
    return user.role in allowed


def _row_to_dict(row) -> Dict[str, Any]:
    d = dict(row)
    try:
        d['allowed_roles'] = json.loads(d.get('allowed_roles') or '[]')
    except Exception:
        d['allowed_roles'] = []
    d.pop('config_encrypted', None)   # never expose encrypted token
    return d


# ── Routes ────────────────────────────────────────────────────────────────────

@router.get('')
def list_drives(user=Depends(get_current_user)) -> List[Dict[str, Any]]:
    s = _state()
    ensure_table(s.db_path)
    conn = None
    try:
        conn = _db_connect(s.db_path)
        rows = conn.execute('SELECT * FROM cloud_drives ORDER BY name').fetchall()
    finally:
        if conn:
            conn.close()
    result = []
    for row in rows:
        d = _row_to_dict(row)
        if _user_can_see(dict(row), user):
            result.append(get_drive_status(dict(row)))
    # Strip config from output (get_drive_status already clears it)
    return [_row_to_dict_status(r) for r in result]


def _row_to_dict_status(row: Dict[str, Any]) -> Dict[str, Any]:
    d = dict(row)
    d.pop('config_encrypted', None)
    try:
        d['allowed_roles'] = json.loads(d.get('allowed_roles') or '[]') if isinstance(d.get('allowed_roles'), str) else d.get('allowed_roles', [])
    except Exception:
        d['allowed_roles'] = []
    return d


@router.post('')
def create_drive(body: DriveCreate, _user=Depends(require_admin_or_mediamanager)) -> Dict[str, Any]:
    s = _state()
    ensure_table(s.db_path)
    if body.type not in ('smb', 'sftp', 'filen', 'internxt'):
        raise HTTPException(status_code=400, detail=f'Unknown drive type: {body.type}')
    encrypted = encrypt_config(s.db_path, body.config)
    conn = None
    try:
        conn = _db_connect(s.db_path)
        cur = conn.execute(
            '''INSERT INTO cloud_drives
               (name, type, config_encrypted, mount_point, scope, owner_id, allowed_roles,
                auto_mount, enabled)
               VALUES (?,?,?,?,?,?,?,?,?)''',
            (
                body.name, body.type, encrypted,
                body.mount_point, body.scope,
                getattr(_user, 'id', None),
                json.dumps(body.allowed_roles),
                1 if body.auto_mount else 0,
                1 if body.enabled else 0,
            ),
        )
        conn.commit()
        drive_id = cur.lastrowid
        row = conn.execute('SELECT * FROM cloud_drives WHERE id=?', (drive_id,)).fetchone()
    finally:
        if conn:
            conn.close()
    return _row_to_dict_status(get_drive_status(dict(row)))


@router.get('/{drive_id}')
def get_drive(drive_id: int, user=Depends(get_current_user)) -> Dict[str, Any]:
    s = _state()
    conn = None
    try:
        conn = _db_connect(s.db_path)
        row = conn.execute('SELECT * FROM cloud_drives WHERE id=?', (drive_id,)).fetchone()
    finally:
        if conn:
            conn.close()
    if not row:
        raise HTTPException(status_code=404, detail='Drive not found')
    drive = dict(row)
    if not _user_can_see(drive, user):
        raise HTTPException(status_code=403, detail='Access denied')
    return _row_to_dict_status(get_drive_status(drive))


@router.put('/{drive_id}')
def update_drive(drive_id: int, body: DriveUpdate,
                 _user=Depends(require_admin_or_mediamanager)) -> Dict[str, Any]:
    s = _state()
    conn = None
    try:
        conn = _db_connect(s.db_path)
        row = conn.execute('SELECT * FROM cloud_drives WHERE id=?', (drive_id,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail='Drive not found')

        updates: Dict[str, Any] = {}
        if body.name is not None:
            updates['name'] = body.name
        if body.config is not None:
            updates['config_encrypted'] = encrypt_config(s.db_path, body.config)
        if body.mount_point is not None:
            updates['mount_point'] = body.mount_point
        if body.scope is not None:
            updates['scope'] = body.scope
        if body.allowed_roles is not None:
            updates['allowed_roles'] = json.dumps(body.allowed_roles)
        if body.auto_mount is not None:
            updates['auto_mount'] = 1 if body.auto_mount else 0
        if body.enabled is not None:
            updates['enabled'] = 1 if body.enabled else 0

        if updates:
            updates['updated_at'] = 'CURRENT_TIMESTAMP'
            set_clause = ', '.join(
                f"{k}=CURRENT_TIMESTAMP" if v == 'CURRENT_TIMESTAMP' else f"{k}=?"
                for k, v in updates.items()
            )
            values = [v for v in updates.values() if v != 'CURRENT_TIMESTAMP']
            values.append(drive_id)
            conn.execute(f'UPDATE cloud_drives SET {set_clause} WHERE id=?', values)
            conn.commit()

        row = conn.execute('SELECT * FROM cloud_drives WHERE id=?', (drive_id,)).fetchone()
    finally:
        if conn:
            conn.close()
    return _row_to_dict_status(get_drive_status(dict(row)))


@router.delete('/{drive_id}')
def delete_drive(drive_id: int, _user=Depends(require_admin_or_mediamanager)) -> Dict[str, Any]:
    s = _state()
    conn = None
    try:
        conn = _db_connect(s.db_path)
        row = conn.execute('SELECT * FROM cloud_drives WHERE id=?', (drive_id,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail='Drive not found')
        conn.execute('DELETE FROM cloud_drives WHERE id=?', (drive_id,))
        conn.commit()
    finally:
        if conn:
            conn.close()
    return {'deleted': drive_id}


@router.post('/{drive_id}/mount')
def mount(drive_id: int, _user=Depends(require_admin_or_mediamanager)) -> Dict[str, Any]:
    s = _state()
    ensure_table(s.db_path)
    ok, msg = mount_drive(s.db_path, drive_id)
    if not ok:
        raise HTTPException(status_code=400, detail=msg)
    return {'ok': True, 'message': msg}


@router.post('/{drive_id}/unmount')
def unmount(drive_id: int, _user=Depends(require_admin_or_mediamanager)) -> Dict[str, Any]:
    s = _state()
    ok, msg = unmount_drive(s.db_path, drive_id)
    if not ok:
        raise HTTPException(status_code=400, detail=msg)
    return {'ok': True, 'message': msg}


@router.get('/{drive_id}/browse')
def browse(drive_id: int, path: str = '/',
           user=Depends(get_current_user)) -> Dict[str, Any]:
    """List directory contents at `path` for the given drive.
    Returns {path, entries, parent} matching the filesystem browse format."""
    import json as _json
    from pathlib import PurePosixPath
    s = _state()
    conn = None
    try:
        conn = _db_connect(s.db_path)
        row = conn.execute('SELECT * FROM cloud_drives WHERE id=?', (drive_id,)).fetchone()
    finally:
        if conn:
            conn.close()
    if not row:
        raise HTTPException(status_code=404, detail='Drive not found')
    drive = dict(row)
    try:
        allowed = _json.loads(drive.get('allowed_roles') or '[]')
    except Exception:
        allowed = []
    if user.role != 'admin' and user.role not in allowed:
        raise HTTPException(status_code=403, detail='Access denied')
    try:
        entries = list_dir(s.db_path, drive_id, path)
        norm = path if path else '/'
        parent = str(PurePosixPath(norm).parent) if norm not in ('/', '') else None
        if parent == norm:
            parent = None
        return {'path': norm, 'entries': entries, 'parent': parent,
                'drive_id': drive_id, 'drive_name': drive.get('name', ''),
                'drive_type': drive.get('type', '')}
    except RuntimeError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post('/{drive_id}/mkdir')
def mkdir(drive_id: int, body: MkdirRequest,
          _user=Depends(require_admin_or_mediamanager)) -> Dict[str, Any]:
    """Create a directory at the given path."""
    s = _state()
    try:
        make_dir(s.db_path, drive_id, body.path)
        return {'ok': True, 'path': body.path}
    except RuntimeError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get('/{drive_id}/config')
def get_drive_config(drive_id: int,
                     _user=Depends(require_admin_or_mediamanager)) -> Dict[str, Any]:
    """Return the decrypted credential config for a drive (for pre-filling the edit form)."""
    s = _state()
    conn = None
    try:
        conn = _db_connect(s.db_path)
        row = conn.execute('SELECT * FROM cloud_drives WHERE id=?', (drive_id,)).fetchone()
    finally:
        if conn:
            conn.close()
    if not row:
        raise HTTPException(status_code=404, detail='Drive not found')
    try:
        return decrypt_config(s.db_path, dict(row)['config_encrypted'])
    except Exception as e:
        raise HTTPException(status_code=500, detail=f'Could not decrypt config: {e}')


@router.post('/{drive_id}/ingest')
async def ingest_drive(drive_id: int, body: IngestRequest,
                       user=Depends(get_current_user)):
    """
    Download and process image files from a cloud/network drive.
    Streams SSE events identical to POST /api/filesystem/add.
    """
    s = _state()
    vis = body.visibility if body.visibility in ('shared', 'private') else 'shared'
    owner_id = user.id

    conn = None
    try:
        conn = _db_connect(s.db_path)
        row = conn.execute('SELECT * FROM cloud_drives WHERE id=?', (drive_id,)).fetchone()
    finally:
        if conn:
            conn.close()
    if not row:
        raise HTTPException(status_code=404, detail='Drive not found')
    drive = dict(row)
    if not _user_can_see(drive, user):
        raise HTTPException(status_code=403, detail='Access denied')

    async def event_stream():
        import asyncio
        loop = asyncio.get_event_loop()

        # Collect all image files across requested paths
        all_items: List[Dict[str, Any]] = []
        for path in body.paths:
            try:
                items = await loop.run_in_executor(
                    None,
                    lambda p=path: list_image_files(s.db_path, drive_id, p, body.recursive),
                )
                all_items.extend(items)
            except RuntimeError as e:
                yield f"data: {json.dumps({'error': str(e), 'done': True})}\n\n"
                return

        total = len(all_items)
        yield f"data: {json.dumps({'total': total, 'started': True})}\n\n"

        for i, item in enumerate(all_items):
            tmp_path = None
            is_temp = False
            try:
                local_path, is_temp = await loop.run_in_executor(
                    None,
                    lambda it=item: download_to_temp(s.db_path, drive_id, it),
                )
                if is_temp:
                    tmp_path = local_path

                result = await loop.run_in_executor(
                    None,
                    lambda lp=local_path: s.engine.process_image(lp, s.vlm_provider),
                )
                r = result if isinstance(result, dict) else {}
                image_id = r.get('image_id')
                if image_id:
                    try:
                        conn2 = _db_connect(s.db_path)
                        conn2.execute(
                            'UPDATE images SET owner_id=?, visibility=? WHERE id=?',
                            (owner_id, vis, image_id),
                        )
                        conn2.commit()
                        conn2.close()
                    except Exception as e_upd:
                        logger.warning('Could not set owner/visibility for image %s: %s', image_id, e_upd)

                payload = {
                    'index':  i + 1,
                    'total':  total,
                    'path':   item.get('name', ''),
                    'result': {
                        'faces_detected': r.get('face_count', 0),
                        'vlm':            r.get('vlm_result'),
                    },
                }
            except Exception as e:
                logger.error('ingest error for %s: %s', item.get('name'), e)
                payload = {
                    'index': i + 1,
                    'total': total,
                    'path':  item.get('name', ''),
                    'error': str(e),
                }
            finally:
                if is_temp and tmp_path:
                    try:
                        os.unlink(tmp_path)
                    except OSError:
                        pass

            yield f"data: {json.dumps(payload)}\n\n"

        yield f"data: {json.dumps({'done': True, 'total': total})}\n\n"

    return StreamingResponse(event_stream(), media_type='text/event-stream')


@router.post('/{drive_id}/rename')
def rename_drive_item(drive_id: int, body: RenameRequest,
                      _user=Depends(require_admin_or_mediamanager)) -> Dict[str, Any]:
    """Rename a file or folder on the drive."""
    s = _state()
    try:
        rename_item(s.db_path, drive_id, body.path, body.new_name)
        return {'ok': True, 'path': body.path, 'new_name': body.new_name}
    except (ValueError, RuntimeError) as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post('/{drive_id}/trash')
def trash_drive_item(drive_id: int, body: ItemPathRequest,
                     _user=Depends(require_admin_or_mediamanager)) -> Dict[str, Any]:
    """Move a file or folder to trash (cloud) or delete it (SMB/SFTP)."""
    s = _state()
    try:
        trash_item(s.db_path, drive_id, body.path)
        return {'ok': True, 'path': body.path}
    except RuntimeError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.delete('/{drive_id}/item')
def delete_drive_item(drive_id: int, body: ItemPathRequest,
                      _user=Depends(require_admin_or_mediamanager)) -> Dict[str, Any]:
    """Permanently delete a file or folder on the drive."""
    s = _state()
    try:
        delete_item(s.db_path, drive_id, body.path)
        return {'ok': True, 'path': body.path}
    except RuntimeError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post('/test')
def test_connection(body: TestDriveRequest,
                    _user=Depends(require_admin_or_mediamanager)) -> Dict[str, Any]:
    """Test credentials without saving anything."""
    cfg = body.config

    if body.type == 'smb':
        mp = '/tmp/_crisp_smb_test'
        ok, msg = _mount_smb(cfg, mp)
        if ok:
            _unmount_path(mp)
    elif body.type == 'sftp':
        mp = '/tmp/_crisp_sftp_test'
        ok, msg = _mount_sftp(cfg, mp)
        if ok:
            _unmount_path(mp)
    elif body.type == 'filen':
        try:
            from cloud.filen_bridge import filen_login
            filen_login(cfg['email'], cfg['password'], cfg.get('tfa_code'))
            ok, msg = True, f"Connected as {cfg['email']}"
        except Exception as e:
            ok, msg = False, str(e)
    elif body.type == 'internxt':
        try:
            from cloud.internxt_bridge import internxt_login
            internxt_login(cfg['email'], cfg['password'], cfg.get('tfa_code'))
            ok, msg = True, f"Connected as {cfg['email']}"
        except Exception as e:
            ok, msg = False, str(e)
    else:
        raise HTTPException(status_code=400, detail=f'Unknown type: {body.type}')

    return {'ok': ok, 'message': msg}
