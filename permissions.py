# permissions.py - Secure user permissions and access control
import sqlite3
from typing import List, Optional, Set
from dataclasses import dataclass
from pathlib import Path
import logging
import re
import hashlib  
import os       

try:
    import bcrypt
    BCRYPT_AVAILABLE = True
except ImportError:
    BCRYPT_AVAILABLE = False
    import hashlib
    logging.warning("bcrypt not available, falling back to PBKDF2. Install bcrypt for better security: pip install bcrypt")

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

@dataclass
class User:
    """User with permissions."""
    id: int
    username: str
    password_hash: str
    role: str  # 'admin' or 'user'
    allowed_folders: List[str]  # Empty list = all folders for admins
    created_at: str
    is_active: bool = True
    # Per-user VLM overrides (NULL = use global default from config.yaml)
    vlm_enabled: Optional[int] = None
    vlm_provider: Optional[str] = None
    vlm_model: Optional[str] = None
    # Per-user detection model override (NULL = use global default from config.yaml)
    det_model: Optional[str] = None


class PermissionManager:
    """Manage user permissions and access control with security best practices."""

    # Constants
    MIN_PASSWORD_LENGTH = 8
    MAX_PASSWORD_LENGTH = 128
    USERNAME_PATTERN = re.compile(r'^[a-zA-Z0-9_-]{3,32}$')
    VALID_ROLES = {'admin', 'user', 'mediamanager'}
    
    def __init__(self, db_path: str):
        self.db_path = db_path
        self.use_bcrypt = BCRYPT_AVAILABLE
        self._init_users_table()
        self._ensure_admin_exists()
    
    def _get_connection(self) -> sqlite3.Connection:
        """Get database connection with proper settings."""
        conn = sqlite3.connect(self.db_path, timeout=10.0)
        conn.execute("PRAGMA foreign_keys = ON")
        conn.execute("PRAGMA journal_mode = WAL")
        return conn
    
    def _init_users_table(self):
        """Initialize users table with proper constraints."""
        try:
            conn = self._get_connection()
            # Recreate table with updated role constraint if it uses the old 2-role check
            conn.executescript("""
                CREATE TABLE IF NOT EXISTS users_v2 (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    username TEXT UNIQUE NOT NULL CHECK(length(username) >= 3 AND length(username) <= 32),
                    password_hash TEXT NOT NULL,
                    role TEXT NOT NULL DEFAULT 'user' CHECK(role IN ('admin', 'user', 'mediamanager')),
                    allowed_folders TEXT,
                    is_active BOOLEAN DEFAULT 1,
                    failed_login_attempts INTEGER DEFAULT 0,
                    last_login TIMESTAMP,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                );
            """)
            # If users table already exists copy data over, then swap
            tables = [r[0] for r in conn.execute(
                "SELECT name FROM sqlite_master WHERE type='table'"
            ).fetchall()]
            if 'users' in tables and 'users_v2' in tables:
                conn.executescript("""
                    INSERT OR IGNORE INTO users_v2
                        SELECT id, username, password_hash, role, allowed_folders,
                               is_active, failed_login_attempts, last_login,
                               created_at, updated_at
                        FROM users;
                    DROP TABLE users;
                    ALTER TABLE users_v2 RENAME TO users;
                """)
            elif 'users_v2' in tables and 'users' not in tables:
                conn.execute("ALTER TABLE users_v2 RENAME TO users")
            
            # Create indexes
            conn.execute("CREATE INDEX IF NOT EXISTS idx_users_username ON users(username)")
            conn.execute("CREATE INDEX IF NOT EXISTS idx_users_role ON users(role)")
            conn.execute("CREATE INDEX IF NOT EXISTS idx_users_active ON users(is_active)")
            
            conn.commit()
            logger.info("Users table initialized successfully")
        except sqlite3.Error as e:
            logger.error(f"Failed to initialize users table: {e}")
            raise
        finally:
            conn.close()
    
    def _ensure_admin_exists(self):
        """Ensure default admin exists."""
        try:
            # Check if admin user exists
            user = self.get_user('admin')
            
            if user:
                logger.info("Admin user already exists")
                return
            
            # Admin doesn't exist, create it with secure default password
            default_password = "admin123"  # 8 characters, meets requirements
            logger.info("Admin user not found, creating...")
            success, message, user_id = self.create_user('admin', default_password, 'admin', [])
            
            if success:
                logger.warning(f"⚠️  Created default admin user with password '{default_password}' - CHANGE THIS IMMEDIATELY!")
            else:
                logger.error(f"Failed to create default admin: {message}")
                
        except Exception as e:
            logger.error(f"Error in _ensure_admin_exists: {e}", exc_info=True)
    
    def _hash_password(self, password: str) -> str:
        """Hash password securely using bcrypt or fallback to PBKDF2."""
        if not password:
            raise ValueError("Password cannot be empty")
        
        if len(password) > self.MAX_PASSWORD_LENGTH:
            raise ValueError(f"Password too long (max {self.MAX_PASSWORD_LENGTH} characters)")
        
        if self.use_bcrypt:
            return bcrypt.hashpw(password.encode('utf-8'), bcrypt.gensalt()).decode('utf-8')
        else:
            # Fallback to PBKDF2 with SHA256
            import os
            salt = os.urandom(32)
            key = hashlib.pbkdf2_hmac('sha256', password.encode('utf-8'), salt, 100000)
            return f"pbkdf2:{salt.hex()}:{key.hex()}"
    
    def _verify_password(self, password: str, password_hash: str) -> bool:
        """Verify password against hash."""
        try:
            if password_hash.startswith('pbkdf2:'):
                # PBKDF2 format: pbkdf2:salt_hex:key_hex
                parts = password_hash.split(':')
                if len(parts) != 3:
                    return False
                salt = bytes.fromhex(parts[1])
                stored_key = bytes.fromhex(parts[2])
                key = hashlib.pbkdf2_hmac('sha256', password.encode('utf-8'), salt, 100000)
                return key == stored_key
            else:
                # bcrypt format
                if self.use_bcrypt:
                    return bcrypt.checkpw(password.encode('utf-8'), password_hash.encode('utf-8'))
                else:
                    logger.error("bcrypt hash found but bcrypt not available")
                    return False
        except Exception as e:
            logger.error(f"Password verification error: {e}")
            return False
    
    def _validate_username(self, username: str) -> tuple[bool, str]:
        """Validate username format."""
        if not username:
            return False, "Username cannot be empty"
        
        if not self.USERNAME_PATTERN.match(username):
            return False, "Username must be 3-32 characters (letters, numbers, underscore, hyphen only)"
        
        # Reserved usernames
        reserved = {'root', 'system', 'null', 'undefined'}
        if username.lower() in reserved:
            return False, "Username is reserved"
        
        return True, "OK"
    
    def _validate_password(self, password: str) -> tuple[bool, str]:
        """Validate password strength."""
        if not password:
            return False, "Password cannot be empty"
        
        if len(password) < self.MIN_PASSWORD_LENGTH:
            return False, f"Password must be at least {self.MIN_PASSWORD_LENGTH} characters"
        
        if len(password) > self.MAX_PASSWORD_LENGTH:
            return False, f"Password must be at most {self.MAX_PASSWORD_LENGTH} characters"
        
        # Check for basic complexity (optional, can be strict)
        has_digit = any(c.isdigit() for c in password)
        has_alpha = any(c.isalpha() for c in password)
        
        if not (has_digit and has_alpha):
            logger.warning("Weak password: should contain both letters and numbers")
        
        return True, "OK"
    
    def _validate_role(self, role: str) -> tuple[bool, str]:
        """Validate role."""
        if role not in self.VALID_ROLES:
            return False, f"Invalid role. Must be one of: {', '.join(self.VALID_ROLES)}"
        return True, "OK"
    
    def _sanitize_folder_paths(self, folders: List[str]) -> List[str]:
        """Sanitize and normalize folder paths."""
        sanitized = []
        for folder in folders:
            try:
                # Resolve and normalize path
                path = Path(folder).resolve()
                
                # Check for path traversal attempts
                if '..' in folder or folder.startswith('/etc') or folder.startswith('/sys'):
                    logger.warning(f"Suspicious folder path rejected: {folder}")
                    continue
                
                sanitized.append(str(path))
            except Exception as e:
                logger.warning(f"Invalid folder path '{folder}': {e}")
                continue
        
        return list(set(sanitized))  # Remove duplicates
    
    def create_user(self, username: str, password: str, role: str, 
                    allowed_folders: List[str]) -> tuple[bool, str, Optional[int]]:
        """
        Create a new user with validation.
        
        Returns:
            (success, message, user_id)
        """
        import json
        
        # Validate inputs
        valid, msg = self._validate_username(username)
        if not valid:
            return False, msg, None
        
        valid, msg = self._validate_password(password)
        if not valid:
            return False, msg, None
        
        valid, msg = self._validate_role(role)
        if not valid:
            return False, msg, None
        
        # Sanitize folders
        allowed_folders = self._sanitize_folder_paths(allowed_folders)
        
        try:
            conn = self._get_connection()
            cursor = conn.cursor()
            
            # Check if user already exists
            cursor.execute("SELECT id FROM users WHERE username = ?", (username,))
            if cursor.fetchone():
                conn.close()
                return False, f"User '{username}' already exists", None
            
            # Create user
            cursor.execute("""
                INSERT INTO users (username, password_hash, role, allowed_folders)
                VALUES (?, ?, ?, ?)
            """, (
                username,
                self._hash_password(password),
                role,
                json.dumps(allowed_folders)
            ))
            
            user_id = cursor.lastrowid
            conn.commit()
            conn.close()
            
            logger.info(f"Created user '{username}' with role '{role}'")
            return True, f"User '{username}' created successfully", user_id
            
        except sqlite3.IntegrityError as e:
            logger.error(f"Database integrity error creating user: {e}")
            return False, "User already exists or database error", None
        except Exception as e:
            logger.error(f"Error creating user: {e}")
            return False, f"Failed to create user: {str(e)}", None
    
    def get_user(self, username: str) -> Optional[User]:
        """Get user by username."""
        import json
        
        if not username:
            return None
        
        try:
            conn = self._get_connection()
            conn.row_factory = sqlite3.Row
            cursor = conn.cursor()
            
            cursor.execute("SELECT * FROM users WHERE username = ? AND is_active = 1", (username,))
            row = cursor.fetchone()
            conn.close()
            
            if row:
                rd = dict(row)
                return User(
                    id=row['id'],
                    username=row['username'],
                    password_hash=row['password_hash'],
                    role=row['role'],
                    allowed_folders=json.loads(row['allowed_folders'] or '[]'),
                    created_at=row['created_at'],
                    is_active=bool(row['is_active']),
                    vlm_enabled=rd.get('vlm_enabled'),
                    vlm_provider=rd.get('vlm_provider'),
                    vlm_model=rd.get('vlm_model'),
                    det_model=rd.get('det_model'),
                )

            return None

        except sqlite3.Error as e:
            logger.error(f"Database error getting user '{username}': {e}")
            return None
        except Exception as e:
            logger.error(f"Error getting user '{username}': {e}")
            return None

    def authenticate(self, username: str, password: str) -> tuple[bool, str, Optional[User]]:
        """
        Authenticate user with rate limiting and lockout.
        
        Returns:
            (success, message, user)
        """
        if not username or not password:
            return False, "Username and password required", None
        
        try:
            user = self.get_user(username)
            if not user:
                logger.warning(f"Failed login attempt for non-existent user: {username}")
                return False, "Invalid username or password", None
            
            # Check failed attempts (simple lockout)
            conn = self._get_connection()
            cursor = conn.cursor()
            cursor.execute("SELECT failed_login_attempts FROM users WHERE username = ?", (username,))
            row = cursor.fetchone()
            
            if row and row[0] >= 5:
                conn.close()
                logger.warning(f"Account locked due to too many failed attempts: {username}")
                return False, "Account temporarily locked. Contact administrator.", None
            
            # Verify password
            if self._verify_password(password, user.password_hash):
                # Success - reset failed attempts and update last login
                cursor.execute("""
                    UPDATE users 
                    SET failed_login_attempts = 0, last_login = CURRENT_TIMESTAMP 
                    WHERE username = ?
                """, (username,))
                conn.commit()
                conn.close()
                
                logger.info(f"Successful login: {username}")
                return True, "Login successful", user
            else:
                # Failed - increment failed attempts
                cursor.execute("""
                    UPDATE users 
                    SET failed_login_attempts = failed_login_attempts + 1 
                    WHERE username = ?
                """, (username,))
                conn.commit()
                conn.close()
                
                logger.warning(f"Failed login attempt for user: {username}")
                return False, "Invalid username or password", None
                
        except Exception as e:
            logger.error(f"Authentication error: {e}")
            return False, "Authentication error", None
    
    def can_access_folder(self, user: User, folder_path: str) -> bool:
        """Check if user can access a folder with path traversal protection."""
        if not user or not user.is_active:
            return False
        
        # Admins can access everything
        if user.role == 'admin':
            return True
        
        try:
            # Normalize and resolve path
            folder_path = str(Path(folder_path).resolve())
            
            # Block dangerous paths
            dangerous_prefixes = ['/etc', '/sys', '/proc', '/root', '/boot']
            if any(folder_path.startswith(prefix) for prefix in dangerous_prefixes):
                logger.warning(f"Blocked access to dangerous path: {folder_path} by user {user.username}")
                return False
            
            # Check if folder is in allowed list or is a subdirectory
            for allowed in user.allowed_folders:
                try:
                    allowed_path = str(Path(allowed).resolve())
                    if folder_path.startswith(allowed_path):
                        return True
                except Exception as e:
                    logger.warning(f"Invalid allowed folder path '{allowed}': {e}")
                    continue
            
            logger.debug(f"User {user.username} denied access to {folder_path}")
            return False
            
        except Exception as e:
            logger.error(f"Error checking folder access: {e}")
            return False
    
    def list_users(self) -> List[User]:
        """List all users (excluding sensitive data)."""
        import json
        
        try:
            conn = self._get_connection()
            conn.row_factory = sqlite3.Row
            cursor = conn.cursor()
            
            cursor.execute("""
                SELECT id, username, password_hash, role, allowed_folders, 
                       created_at, is_active, last_login
                FROM users 
                ORDER BY created_at DESC
            """)
            rows = cursor.fetchall()
            conn.close()
            
            users = []
            for row in rows:
                users.append(User(
                    id=row['id'],
                    username=row['username'],
                    password_hash="***",  # Don't expose actual hash
                    role=row['role'],
                    allowed_folders=json.loads(row['allowed_folders'] or '[]'),
                    created_at=row['created_at'],
                    is_active=bool(row['is_active'])
                ))
            
            return users
        except Exception as e:
            logger.error(f"Error listing users: {e}")
            return []
    
    def update_password(self, username: str, new_password: str) -> tuple[bool, str]:
        """Update user password."""
        valid, msg = self._validate_password(new_password)
        if not valid:
            return False, msg
        
        try:
            conn = self._get_connection()
            cursor = conn.cursor()
            
            cursor.execute("""
                UPDATE users 
                SET password_hash = ?, updated_at = CURRENT_TIMESTAMP 
                WHERE username = ?
            """, (self._hash_password(new_password), username))
            
            if cursor.rowcount == 0:
                conn.close()
                return False, "User not found"
            
            conn.commit()
            conn.close()
            
            logger.info(f"Password updated for user: {username}")
            return True, "Password updated successfully"
            
        except Exception as e:
            logger.error(f"Error updating password: {e}")
            return False, f"Failed to update password: {str(e)}"
    
    def deactivate_user(self, username: str) -> tuple[bool, str]:
        """Deactivate a user (soft delete)."""
        if username == 'admin':
            return False, "Cannot deactivate admin user"
        
        try:
            conn = self._get_connection()
            cursor = conn.cursor()
            
            cursor.execute("""
                UPDATE users 
                SET is_active = 0, updated_at = CURRENT_TIMESTAMP 
                WHERE username = ?
            """, (username,))
            
            if cursor.rowcount == 0:
                conn.close()
                return False, "User not found"
            
            conn.commit()
            conn.close()
            
            logger.info(f"Deactivated user: {username}")
            return True, f"User '{username}' deactivated"
            
        except Exception as e:
            logger.error(f"Error deactivating user: {e}")
            return False, f"Failed to deactivate user: {str(e)}"
    
    def reset_failed_attempts(self, username: str) -> tuple[bool, str]:
        """Reset failed login attempts (unlock account)."""
        try:
            conn = self._get_connection()
            cursor = conn.cursor()

            cursor.execute("""
                UPDATE users
                SET failed_login_attempts = 0
                WHERE username = ?
            """, (username,))

            conn.commit()
            conn.close()

            logger.info(f"Reset failed attempts for user: {username}")
            return True, f"Failed attempts reset for '{username}'"

        except Exception as e:
            logger.error(f"Error resetting failed attempts: {e}")
            return False, str(e)

    def reset_failed_attempts_by_id(self, user_id: int) -> tuple[bool, str]:
        """Reset failed login attempts by user ID."""
        try:
            conn = self._get_connection()
            conn.execute(
                "UPDATE users SET failed_login_attempts = 0 WHERE id = ?",
                (user_id,)
            )
            conn.commit()
            conn.close()
            return True, "Lock reset"
        except Exception as e:
            logger.error(f"Error resetting failed attempts by id: {e}")
            return False, str(e)

    def update_user(self, user_id: int, role: Optional[str] = None,
                    is_active: Optional[bool] = None,
                    password: Optional[str] = None,
                    allowed_folders: Optional[List[str]] = None) -> tuple[bool, str]:
        """Update user fields (admin action). Cannot demote/deactivate the last admin."""
        import json

        if role is not None:
            valid, msg = self._validate_role(role)
            if not valid:
                return False, msg

        if password is not None:
            valid, msg = self._validate_password(password)
            if not valid:
                return False, msg

        try:
            conn = self._get_connection()
            conn.row_factory = sqlite3.Row
            row = conn.execute("SELECT username, role FROM users WHERE id = ?", (user_id,)).fetchone()
            if row is None:
                conn.close()
                return False, "User not found"

            # Protect the last admin: cannot change role away from admin if they're the only one
            if role is not None and role != 'admin' and row['role'] == 'admin':
                admin_count = conn.execute(
                    "SELECT COUNT(*) FROM users WHERE role = 'admin' AND is_active = 1"
                ).fetchone()[0]
                if admin_count <= 1:
                    conn.close()
                    return False, "Cannot demote the last active admin"

            if is_active is not None and not is_active and row['role'] == 'admin':
                admin_count = conn.execute(
                    "SELECT COUNT(*) FROM users WHERE role = 'admin' AND is_active = 1"
                ).fetchone()[0]
                if admin_count <= 1:
                    conn.close()
                    return False, "Cannot deactivate the last active admin"

            sets, vals = [], []
            if role is not None:
                sets.append("role = ?"); vals.append(role)
            if is_active is not None:
                sets.append("is_active = ?"); vals.append(1 if is_active else 0)
            if password is not None:
                sets.append("password_hash = ?"); vals.append(self._hash_password(password))
            if allowed_folders is not None:
                sanitized = self._sanitize_folder_paths(allowed_folders)
                sets.append("allowed_folders = ?"); vals.append(json.dumps(sanitized))

            if not sets:
                conn.close()
                return True, "Nothing to update"

            sets.append("updated_at = CURRENT_TIMESTAMP")
            vals.append(user_id)
            conn.execute(f"UPDATE users SET {', '.join(sets)} WHERE id = ?", vals)
            conn.commit()
            conn.close()
            logger.info(f"Updated user id={user_id}")
            return True, "User updated"
        except Exception as e:
            logger.error(f"Error updating user {user_id}: {e}")
            return False, str(e)

    def delete_user(self, user_id: int) -> tuple[bool, str]:
        """Permanently delete a user (not allowed for the last admin)."""
        try:
            conn = self._get_connection()
            conn.row_factory = sqlite3.Row
            row = conn.execute("SELECT username, role FROM users WHERE id = ?", (user_id,)).fetchone()
            if row is None:
                conn.close()
                return False, "User not found"
            if row['role'] == 'admin':
                admin_count = conn.execute(
                    "SELECT COUNT(*) FROM users WHERE role = 'admin'"
                ).fetchone()[0]
                if admin_count <= 1:
                    conn.close()
                    return False, "Cannot delete the last admin account"
            conn.execute("DELETE FROM users WHERE id = ?", (user_id,))
            conn.commit()
            conn.close()
            logger.info(f"Deleted user '{row['username']}' (id={user_id})")
            return True, f"User '{row['username']}' deleted"
        except Exception as e:
            logger.error(f"Error deleting user {user_id}: {e}")
            return False, str(e)

    def verify_credentials(self, username: str, password: str) -> bool:
        """Check credentials without recording failed attempts (for health-check use only)."""
        try:
            conn = self._get_connection()
            conn.row_factory = sqlite3.Row
            row = conn.execute(
                "SELECT password_hash FROM users WHERE username = ? AND is_active = 1",
                (username,)
            ).fetchone()
            conn.close()
            if row is None:
                return False
            return self._verify_password(password, row['password_hash'])
        except Exception as e:
            logger.error(f"verify_credentials error: {e}")
            return False

    def get_user_by_id(self, user_id: int) -> Optional[User]:
        """Get user by numeric ID."""
        import json
        try:
            conn = self._get_connection()
            conn.row_factory = sqlite3.Row
            row = conn.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
            conn.close()
            if row:
                rd = dict(row)
                return User(
                    id=row['id'],
                    username=row['username'],
                    password_hash=row['password_hash'],
                    role=row['role'],
                    allowed_folders=json.loads(row['allowed_folders'] or '[]'),
                    created_at=row['created_at'],
                    is_active=bool(row['is_active']),
                    vlm_enabled=rd.get('vlm_enabled'),
                    vlm_provider=rd.get('vlm_provider'),
                    vlm_model=rd.get('vlm_model'),
                    det_model=rd.get('det_model'),
                )
            return None
        except Exception as e:
            logger.error(f"get_user_by_id({user_id}): {e}")
            return None