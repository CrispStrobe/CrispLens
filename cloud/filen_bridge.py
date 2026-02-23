"""
cloud/filen_bridge.py — Bridge to ../filen-python.

Injects the original repo onto sys.path so that bug-fixes and API updates to
../filen-python automatically apply here without any duplication.
If the repo is absent it is cloned automatically from GitHub.

Usage:
    from cloud.filen_bridge import filen_login, get_filen_drive

    session = filen_login(email, password)   # returns {apiKey, masterKeys, ...}
    drive   = get_filen_drive(session)
    items   = drive.list_folders(session['baseFolderUUID'])

Dependencies in face_rec env: requests, cryptography  (already present)
"""
import os
import sys
import subprocess
import logging

logger = logging.getLogger(__name__)

_GITHUB_URL = 'https://github.com/CrispStrobe/filen-python'

# Candidate locations, checked in order:
#  1. sibling of the app dir  (dev: ~/code/filen-python)
#  2. inside the app dir      (VPS/packaged: /opt/crisp-lens/filen-python — always writable)
_APP_DIR      = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
_REPO_SIBLING = os.path.abspath(os.path.join(_APP_DIR, '..', 'filen-python'))
_REPO_LOCAL   = os.path.abspath(os.path.join(_APP_DIR, 'filen-python'))


_CONFLICTING_MODS = (
    'services', 'services.auth', 'services.drive', 'services.api',
    'services.crypto', 'services.network_utils',
    'config', 'config.config',
)

def _find_repo() -> str | None:
    return next((p for p in (_REPO_SIBLING, _REPO_LOCAL) if os.path.isdir(p)), None)


def _ensure_path() -> None:
    """Ensure the filen-python repo is on sys.path, cloning it if necessary.

    Also flushes any cached modules that belong to a *different* repo so that
    filen-python's versions of services.auth / services.drive / … are used.
    Filen and internxt-cli share identical module names — we must ensure only
    one set is active at a time.
    """
    repo = _find_repo()

    if repo is None:
        # Clone into the app directory — writable by the service user on any deployment
        logger.info('filen-python not found — cloning from %s into %s', _GITHUB_URL, _REPO_LOCAL)
        try:
            subprocess.run(
                ['git', 'clone', '--depth', '1', _GITHUB_URL, _REPO_LOCAL],
                check=True,
                timeout=120,
                capture_output=True,
            )
            logger.info('filen-python cloned successfully to %s', _REPO_LOCAL)
            repo = _REPO_LOCAL
        except subprocess.CalledProcessError as e:
            raise ImportError(
                f'git clone filen-python failed: {e.stderr.decode().strip()}'
            ) from e
        except FileNotFoundError as e:
            raise ImportError('git not found in PATH — install git first') from e
        except subprocess.TimeoutExpired:
            raise ImportError('git clone timed out after 120 s')

    # Flush any cached modules whose __file__ does NOT belong to this repo.
    # This handles the case where internxt-cli modules were loaded earlier under
    # the same names (services.auth, services.drive, …).
    for mod_name in list(sys.modules):
        if mod_name in _CONFLICTING_MODS or any(
            mod_name.startswith(p + '.') for p in _CONFLICTING_MODS
        ):
            mod_file = getattr(sys.modules.get(mod_name), '__file__', '') or ''
            if mod_file and repo not in mod_file:
                del sys.modules[mod_name]

    # Keep this repo at the front of sys.path so its modules win
    if repo in sys.path:
        sys.path.remove(repo)
    sys.path.insert(0, repo)


# ── Public helpers ────────────────────────────────────────────────────────────

def filen_login(email: str, password: str, tfa_code=None) -> dict:
    """
    Authenticate with Filen. Returns session credentials dict:
      {email, apiKey, masterKeys, baseFolderUUID, userId}
    Raises ValueError on bad credentials; ValueError('2FA_REQUIRED:…') when 2FA needed.

    Uses the auth_service singleton (mirrors the filen-python CLI pattern) so that
    credentials are also saved to disk — required for get_credentials() inside drive ops.
    """
    _ensure_path()
    from services.auth import auth_service  # noqa: PLC0415  — singleton
    return auth_service.login(email, password, tfa_code)


def get_filen_drive(session: dict):
    """
    Return an authenticated DriveService singleton from filen-python.
    Pass the dict returned by filen_login().

    Mirrors the CLI's _prepare_client() pattern:
      1. Save credentials to disk (so get_credentials() works if called internally).
      2. Call set_credentials() on the drive_service singleton to set master_keys
         and update the shared api_client auth token.
    """
    _ensure_path()
    from services.auth import auth_service   # noqa: PLC0415  — singleton
    from services.drive import drive_service  # noqa: PLC0415  — singleton

    # Save session to disk so any internal get_credentials() call succeeds.
    auth_service.config.save_credentials(session)

    # Update master_keys + api_client auth on the singleton.
    drive_service.set_credentials(session)
    return drive_service


def list_dir(drive, folder_uuid: str) -> list:
    """
    Return a normalised list of entries for the given folder UUID.
    Each entry: {name, is_dir, uuid, size}
    """
    folders = drive.list_folders(folder_uuid, use_cache=False)
    files   = drive.list_files(folder_uuid,   use_cache=False)
    result = []
    for f in folders:
        result.append({'name': f.get('name', '?'), 'is_dir': True,
                       'uuid': f.get('uuid', ''), 'size': None})
    for f in files:
        result.append({'name': f.get('name', '?'), 'is_dir': False,
                       'uuid': f.get('uuid', ''), 'size': f.get('size', 0)})
    result.sort(key=lambda e: (not e['is_dir'], e['name'].lower()))
    return result


def resolve_path(drive, path: str) -> dict:
    """Resolve a slash-delimited path; returns metadata dict with 'uuid'."""
    return drive.resolve_path(path)
