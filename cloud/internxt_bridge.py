"""
cloud/internxt_bridge.py — Bridge to ../internxt-python.

Injects the original repo onto sys.path so that bug-fixes and API updates to
../internxt-python automatically apply here without any duplication.
If the repo is absent it is cloned automatically from GitHub.

Usage:
    from cloud.internxt_bridge import internxt_login, get_internxt_drive

    session = internxt_login(email, password)  # returns {user, token, newToken}
    drive   = get_internxt_drive(session)
    listing = drive.list_folder_with_paths('/')

Dependencies in face_rec env (already present): requests, cryptography
Extra dependency: mnemonic  (add via: pip install mnemonic)
"""
import os
import sys
import subprocess
import logging

logger = logging.getLogger(__name__)

_GITHUB_URL = 'https://github.com/CrispStrobe/internxt-python'

# Candidate locations, checked in order:
#  1. sibling of the app dir  (dev: ~/code/internxt-python)
#  2. legacy sibling name     (dev: ~/code/internxt-cli)
#  3. inside the app dir      (VPS/packaged: /opt/crisp-lens/internxt-python — always writable)
_APP_DIR      = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
_REPO_SIBLING = os.path.abspath(os.path.join(_APP_DIR, '..', 'internxt-python'))
_REPO_LEGACY  = os.path.abspath(os.path.join(_APP_DIR, '..', 'internxt-cli'))
_REPO_LOCAL   = os.path.abspath(os.path.join(_APP_DIR, 'internxt-python'))


_CONFLICTING_MODS = (
    'services', 'services.auth', 'services.drive', 'services.crypto',
    'services.network_utils',
    'config', 'config.config',
)

def _find_repo() -> str | None:
    return next(
        (p for p in (_REPO_SIBLING, _REPO_LEGACY, _REPO_LOCAL) if os.path.isdir(p)),
        None,
    )


def _ensure_path() -> None:
    """Ensure the internxt-cli repo is on sys.path, cloning it if necessary.

    Also flushes any cached modules that belong to a *different* repo (filen-python
    shares the same module names: services.auth, services.drive, …).
    Only one set may be active in sys.modules at a time.
    """
    repo = _find_repo()

    if repo is None:
        # Clone into the app directory — writable by the service user on any deployment
        logger.info('internxt-python not found — cloning from %s into %s', _GITHUB_URL, _REPO_LOCAL)
        try:
            subprocess.run(
                ['git', 'clone', '--depth', '1', _GITHUB_URL, _REPO_LOCAL],
                check=True,
                timeout=120,
                capture_output=True,
            )
            logger.info('internxt-python cloned successfully to %s', _REPO_LOCAL)
            repo = _REPO_LOCAL
        except subprocess.CalledProcessError as e:
            raise ImportError(
                f'git clone internxt-python failed: {e.stderr.decode().strip()}'
            ) from e
        except FileNotFoundError as e:
            raise ImportError('git not found in PATH — install git first') from e
        except subprocess.TimeoutExpired:
            raise ImportError('git clone timed out after 120 s')

    # Flush any cached modules whose __file__ does NOT belong to this repo
    # (handles the case where filen-python modules were loaded under the same names).
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

def internxt_login(email: str, password: str, tfa_code=None) -> dict:
    """
    Authenticate with Internxt. Returns session credentials dict:
      {user: {..., mnemonic, userId, rootFolderId, ...}, token, newToken}

    Uses the auth_service singleton (mirrors the internxt-cli pattern) so that
    credentials are saved to disk — required because DriveService methods call
    self.auth.get_auth_details() (which reads from disk) on every operation.
    """
    _ensure_path()
    from services.auth import auth_service  # noqa: PLC0415  — singleton
    return auth_service.login(email, password, tfa_code)


def get_internxt_drive(session: dict):
    """
    Return an authenticated DriveService singleton from internxt-cli.
    Pass the dict returned by internxt_login().

    Mirrors the CLI's _prepare_client() pattern:
      1. Save credentials to disk so that get_auth_details() inside drive methods
         (called on every list/download/upload) can find them.
      2. Set auth tokens on the api_client singleton directly.
    """
    _ensure_path()
    from services.auth import auth_service  # noqa: PLC0415  — singleton
    from services.drive import drive_service  # noqa: PLC0415  — singleton

    # Save session to disk AND update api_client — just like CLI's _prepare_client().
    auth_service.config.save_user_credentials(session)
    auth_service.api.set_auth_tokens(session.get('token'), session.get('newToken'))
    return drive_service


def list_dir(drive, path: str = '/') -> list:
    """
    Return a normalised list of entries for the given path.
    Each entry: {name, is_dir, uuid, size (files only)}

    IMPORTANT: Internxt stores file name and extension separately
    (plainName='photo', type='jpg').  We reconstruct the full display
    name so that callers can detect image files by extension.
    """
    content = drive.list_folder_with_paths(path)
    result = []
    for f in content.get('folders', []):
        name = (f.get('display_name')
                or f.get('plainName')
                or f.get('name')
                or '?')
        result.append({'name': name, 'is_dir': True,
                       'uuid': f.get('uuid', ''), 'size': None})
    for f in content.get('files', []):
        # list_folder_with_paths already builds display_name = "plainName.type"
        plain = f.get('plainName') or f.get('name') or '?'
        ftype = f.get('type', '')
        name = (f.get('display_name')
                or (f"{plain}.{ftype}" if ftype else plain))
        try:
            size = int(f.get('size', 0))
        except (TypeError, ValueError):
            size = 0
        result.append({'name': name, 'is_dir': False,
                       'uuid': f.get('uuid', ''), 'size': size})
    result.sort(key=lambda e: (not e['is_dir'], e['name'].lower()))
    return result
