# api_key_manager.py - Encrypted API key storage for VLM providers
import sqlite3
import os
import logging
from pathlib import Path

logger = logging.getLogger(__name__)

try:
    from cryptography.fernet import Fernet
    FERNET_AVAILABLE = True
except ImportError:
    FERNET_AVAILABLE = False
    logger.warning("cryptography not available - install: pip install cryptography")

# ============================================================================
# PROVIDER REGISTRY
# ============================================================================

PROVIDER_CONFIGS: dict[str, dict] = {
    'anthropic': {
        'display_name': 'Anthropic (Claude)',
        'base_url': None,
        'models_endpoint': None,       # Hardcoded list; no public endpoint
        'default_model': 'claude-3-5-sonnet-20241022',
        'requires_key': True,
    },
    'openai': {
        'display_name': 'OpenAI (GPT-4)',
        'base_url': 'https://api.openai.com/v1',
        'models_endpoint': 'https://api.openai.com/v1/models',
        'default_model': 'gpt-4o',
        'requires_key': True,
    },
    'nebius': {
        'display_name': 'Nebius AI',
        'base_url': 'https://api.tokenfactory.nebius.com/v1',
        'models_endpoint': 'https://api.tokenfactory.nebius.com/v1/models',
        'default_model': 'Qwen/Qwen2-VL-72B-Instruct',
        'requires_key': True,
    },
    'scaleway': {
        'display_name': 'Scaleway Generative APIs',
        'base_url': 'https://api.scaleway.ai/v1',
        'models_endpoint': 'https://api.scaleway.ai/v1/models',
        'default_model': 'pixtral-12b-2409',
        'requires_key': True,
    },
    'openrouter': {
        'display_name': 'OpenRouter',
        'base_url': 'https://openrouter.ai/api/v1',
        'models_endpoint': 'https://openrouter.ai/api/v1/models',  # Public - no auth needed
        'default_model': 'anthropic/claude-3.5-sonnet',
        'requires_key': True,
    },
    'mistral': {
        'display_name': 'Mistral AI',
        'default_vlm_max_size': 900,
        'base_url': 'https://api.mistral.ai/v1',
        'models_endpoint': 'https://api.mistral.ai/v1/models',
        'default_model': 'pixtral-large-latest',
        'requires_key': True,
    },
    'groq': {
        'display_name': 'Groq',
        'default_vlm_max_size': 1024,
        'base_url': 'https://api.groq.com/openai/v1',
        'models_endpoint': 'https://api.groq.com/openai/v1/models',
        'default_model': 'llama-3.2-11b-vision-preview',
        'requires_key': True,
    },
    'poe': {
        'display_name': 'Poe (Quora)',
        'base_url': 'https://api.poe.com/v1',
        'models_endpoint': 'https://api.poe.com/v1/models',
        'default_model': 'claude-3-5-sonnet',
        'requires_key': True,
    },
    'ollama': {
        'display_name': 'Ollama (Local)',
        'base_url': 'http://localhost:11434',
        'models_endpoint': 'http://localhost:11434/api/tags',
        'default_model': 'llava',
        'requires_key': False,
    },
    'bfl': {
        'display_name': 'BFL (FLUX Image Editing)',
        'base_url': 'https://api.bfl.ai',
        'models_endpoint': None,
        'default_model': None,
        'requires_key': True,
    },
}


# ============================================================================
# API KEY MANAGER
# ============================================================================

class ApiKeyManager:
    """
    Encrypted API key storage with role-based access control.

    Security model:
    - Keys are encrypted at rest using Fernet (AES-128-CBC + HMAC-SHA256).
    - System keys: set by admins, used by all users who have no personal key.
    - User keys: set by individual users, override the system key.
    - get_effective_key() is the only way to retrieve plaintext (internal use only).
    - get_key_status() returns only masked previews (safe for UI display).
    """

    _SECRET_KEY_FILENAME = '.api_secret_key'

    def __init__(self, db_path: str):
        self.db_path = db_path
        # Key file lives next to the database so it survives cwd changes
        self._key_path = Path(db_path).resolve().parent / self._SECRET_KEY_FILENAME
        self._fernet = self._init_encryption()
        self._init_table()
        self._log_startup_key_status()

    # ------------------------------------------------------------------
    # Encryption helpers
    # ------------------------------------------------------------------

    def _init_encryption(self):
        """Load or generate the Fernet encryption key."""
        if not FERNET_AVAILABLE:
            logger.warning("Fernet not available - API keys stored with base64 only (less secure)")
            return None

        if self._key_path.exists():
            try:
                key = self._key_path.read_bytes()
                fernet = Fernet(key)
                logger.info(f"Loaded existing API encryption key from {self._key_path}")
                return fernet
            except Exception as e:
                logger.warning(f"Existing key file {self._key_path} unreadable ({e}), generating new key — "
                               f"previously stored API keys cannot be decrypted and must be re-entered")

        key = Fernet.generate_key()
        try:
            self._key_path.write_bytes(key)
            os.chmod(str(self._key_path), 0o600)
            logger.info(f"Generated new API encryption key at {self._key_path}")
        except Exception as e:
            logger.warning(f"Could not persist encryption key to {self._key_path}: {e} — key is in-memory only; "
                           f"API keys will need to be re-entered after restart")

        return Fernet(key)

    def _log_startup_key_status(self):
        """Log which providers have keys stored in the DB at startup, and whether they decrypt OK."""
        try:
            conn = self._get_connection()
            cursor = conn.execute(
                "SELECT provider, scope, username, encrypted_key FROM provider_api_keys ORDER BY provider, scope"
            )
            rows = cursor.fetchall()
            conn.close()
            if not rows:
                logger.info("API key store: no keys found in database (all providers need keys entered in Settings)")
                return
            logger.info(f"API key store: found {len(rows)} stored key(s) in database (key file: {self._key_path}):")
            bad = 0
            for provider, scope, username, encrypted_key in rows:
                display = PROVIDER_CONFIGS.get(provider, {}).get('display_name', provider)
                tag = f"[{scope}] {display} ({provider})"
                if scope == 'user':
                    tag += f" — user: {username}"
                # Try to decrypt to verify the key is valid with current encryption key
                try:
                    plaintext = self._decrypt(encrypted_key)
                    masked = f"****{plaintext[-4:]}" if len(plaintext) > 4 else "****"
                    logger.info(f"  ✅ {tag}, key preview: {masked}")
                except Exception:
                    logger.warning(f"  ❌ {tag} — CANNOT DECRYPT (encryption key changed?); "
                                   f"please re-enter this key in Settings → API Key Management")
                    bad += 1
            if bad:
                logger.warning(f"API key store: {bad} key(s) cannot be decrypted — "
                               f"they were encrypted with a different key. Re-enter them in Settings.")
        except Exception as e:
            logger.warning(f"Could not read API key status at startup: {e}")

    def _encrypt(self, plaintext: str) -> bytes:
        if self._fernet:
            return self._fernet.encrypt(plaintext.encode('utf-8'))
        import base64
        return base64.b64encode(plaintext.encode('utf-8'))

    def _decrypt(self, ciphertext: bytes) -> str:
        if self._fernet:
            return self._fernet.decrypt(ciphertext).decode('utf-8')
        import base64
        return base64.b64decode(ciphertext).decode('utf-8')

    # ------------------------------------------------------------------
    # Database helpers
    # ------------------------------------------------------------------

    def _get_connection(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.db_path, timeout=10.0)
        conn.execute("PRAGMA journal_mode = WAL")
        return conn

    def _init_table(self):
        """
        Create provider_api_keys table.

        Two separate partial unique indexes handle system vs user scope:
          - (provider) is unique for scope='system'  (one system key per provider)
          - (provider, username) is unique for scope='user'  (one user key per provider)
        This avoids the NULL uniqueness ambiguity in UNIQUE constraints.
        """
        conn = self._get_connection()
        try:
            conn.execute("""
                CREATE TABLE IF NOT EXISTS provider_api_keys (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    provider  TEXT NOT NULL,
                    scope     TEXT NOT NULL CHECK(scope IN ('system', 'user')),
                    username  TEXT NOT NULL DEFAULT '',
                    encrypted_key BLOB NOT NULL,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            """)
            # Partial unique indexes instead of a compound UNIQUE constraint
            conn.execute("""
                CREATE UNIQUE INDEX IF NOT EXISTS idx_apikey_system
                ON provider_api_keys(provider)
                WHERE scope = 'system'
            """)
            conn.execute("""
                CREATE UNIQUE INDEX IF NOT EXISTS idx_apikey_user
                ON provider_api_keys(provider, username)
                WHERE scope = 'user'
            """)
            conn.commit()
            logger.debug("provider_api_keys table ready")
        except Exception as e:
            logger.error(f"Failed to init provider_api_keys table: {e}")
            raise
        finally:
            conn.close()

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def set_system_key(self, provider: str, api_key: str) -> tuple[bool, str]:
        """
        Store a system-wide API key.
        Caller is responsible for enforcing admin-only access.
        """
        if provider not in PROVIDER_CONFIGS:
            return False, f"Unknown provider: {provider}"
        if not api_key or not api_key.strip():
            return False, "API key cannot be empty"

        encrypted = self._encrypt(api_key.strip())
        conn = self._get_connection()
        try:
            # Upsert: delete existing then insert (SQLite < 3.24 doesn't support ON CONFLICT with partial indexes)
            conn.execute(
                "DELETE FROM provider_api_keys WHERE provider = ? AND scope = 'system'",
                (provider,)
            )
            conn.execute(
                "INSERT INTO provider_api_keys (provider, scope, username, encrypted_key) VALUES (?, 'system', '', ?)",
                (provider, encrypted)
            )
            conn.commit()
            name = PROVIDER_CONFIGS[provider]['display_name']
            masked = f"****{api_key.strip()[-4:]}" if len(api_key.strip()) > 4 else "****"
            logger.info(f"System API key saved for provider: {provider} ({name}), key preview: {masked}, "
                        f"stored encrypted in {self.db_path}")
            return True, f"System key saved for {name}"
        except Exception as e:
            logger.error(f"Failed to save system key for {provider}: {e}")
            return False, f"Failed to save key: {str(e)}"
        finally:
            conn.close()

    def set_user_key(self, provider: str, api_key: str, username: str) -> tuple[bool, str]:
        """Store a personal API key for a specific user."""
        if provider not in PROVIDER_CONFIGS:
            return False, f"Unknown provider: {provider}"
        if not api_key or not api_key.strip():
            return False, "API key cannot be empty"
        if not username:
            return False, "Username required"

        encrypted = self._encrypt(api_key.strip())
        conn = self._get_connection()
        try:
            conn.execute(
                "DELETE FROM provider_api_keys WHERE provider = ? AND scope = 'user' AND username = ?",
                (provider, username)
            )
            conn.execute(
                "INSERT INTO provider_api_keys (provider, scope, username, encrypted_key) VALUES (?, 'user', ?, ?)",
                (provider, username, encrypted)
            )
            conn.commit()
            name = PROVIDER_CONFIGS[provider]['display_name']
            masked = f"****{api_key.strip()[-4:]}" if len(api_key.strip()) > 4 else "****"
            logger.info(f"Personal API key saved for user '{username}' / provider: {provider} ({name}), "
                        f"key preview: {masked}, stored encrypted in {self.db_path}")
            return True, f"Personal key saved for {name}"
        except Exception as e:
            logger.error(f"Failed to save user key for {username}/{provider}: {e}")
            return False, f"Failed to save key: {str(e)}"
        finally:
            conn.close()

    def get_effective_key(self, provider: str, username: str | None) -> str | None:
        """
        Retrieve the effective plaintext API key for a provider.
        User key takes precedence over system key.
        Returns None if no key is stored.
        """
        conn = self._get_connection()
        try:
            # 1. User key takes priority
            if username:
                cursor = conn.execute(
                    "SELECT encrypted_key FROM provider_api_keys WHERE provider = ? AND scope = 'user' AND username = ?",
                    (provider, username)
                )
                row = cursor.fetchone()
                if row:
                    return self._decrypt(row[0])

            # 2. System key fallback
            cursor = conn.execute(
                "SELECT encrypted_key FROM provider_api_keys WHERE provider = ? AND scope = 'system'",
                (provider,)
            )
            row = cursor.fetchone()
            if row:
                return self._decrypt(row[0])

            return None
        except Exception as e:
            logger.error(f"Failed to retrieve key for {provider}/{username}: {e} — "
                         f"the encryption key may have changed; please re-enter the API key in Settings")
            return None
        finally:
            conn.close()

    def delete_system_key(self, provider: str) -> tuple[bool, str]:
        """Delete the system-wide API key for a provider. Caller enforces admin access."""
        conn = self._get_connection()
        try:
            cursor = conn.execute(
                "DELETE FROM provider_api_keys WHERE provider = ? AND scope = 'system'",
                (provider,)
            )
            conn.commit()
            if cursor.rowcount > 0:
                logger.info(f"System key deleted for {provider}")
                return True, f"System key deleted for {provider}"
            return False, f"No system key found for {provider}"
        except Exception as e:
            return False, f"Failed to delete key: {str(e)}"
        finally:
            conn.close()

    def delete_user_key(self, provider: str, username: str) -> tuple[bool, str]:
        """Delete a user's personal API key."""
        conn = self._get_connection()
        try:
            cursor = conn.execute(
                "DELETE FROM provider_api_keys WHERE provider = ? AND scope = 'user' AND username = ?",
                (provider, username)
            )
            conn.commit()
            if cursor.rowcount > 0:
                logger.info(f"User key deleted for {username}/{provider}")
                return True, f"Personal key deleted for {provider}"
            return False, f"No personal key found for {provider}"
        except Exception as e:
            return False, f"Failed to delete key: {str(e)}"
        finally:
            conn.close()

    def _mask_key(self, encrypted: bytes) -> str:
        """Return a safe masked preview (e.g. '****ab12') without exposing the key."""
        try:
            plaintext = self._decrypt(encrypted)
            if len(plaintext) <= 8:
                return '****'
            return f"****{plaintext[-4:]}"
        except Exception:
            return "****"

    def get_key_status(self, provider: str, username: str | None = None) -> dict:
        """
        Return masked key status for UI display.
        Never exposes plaintext keys.

        Returns:
            {
                'system': {'exists': bool, 'preview': str | None},
                'user':   {'exists': bool, 'preview': str | None},
            }
        """
        conn = self._get_connection()
        try:
            result = {
                'system': {'exists': False, 'preview': None},
                'user':   {'exists': False, 'preview': None},
            }

            cursor = conn.execute(
                "SELECT encrypted_key FROM provider_api_keys WHERE provider = ? AND scope = 'system'",
                (provider,)
            )
            row = cursor.fetchone()
            if row:
                result['system'] = {'exists': True, 'preview': self._mask_key(row[0])}

            if username:
                cursor = conn.execute(
                    "SELECT encrypted_key FROM provider_api_keys WHERE provider = ? AND scope = 'user' AND username = ?",
                    (provider, username)
                )
                row = cursor.fetchone()
                if row:
                    result['user'] = {'exists': True, 'preview': self._mask_key(row[0])}

            return result
        except Exception as e:
            logger.error(f"Failed to get key status for {provider}: {e}")
            return {'system': {'exists': False, 'preview': None}, 'user': {'exists': False, 'preview': None}}
        finally:
            conn.close()

    def get_all_key_statuses(self, username: str | None = None) -> dict[str, dict]:
        """Return key status for all registered providers."""
        return {p: self.get_key_status(p, username) for p in PROVIDER_CONFIGS}
