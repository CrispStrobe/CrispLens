#!/usr/bin/env python3
"""Quick fix for admin user."""

import sqlite3
import hashlib
import os

def create_admin():
    """Create admin user with proper setup."""
    db_path = "face_recognition.db"
    
    # Simple PBKDF2 hash for "admin123"
    password = "admin123"
    salt = os.urandom(32)
    key = hashlib.pbkdf2_hmac('sha256', password.encode('utf-8'), salt, 100000)
    password_hash = f"pbkdf2:{salt.hex()}:{key.hex()}"
    
    try:
        conn = sqlite3.connect(db_path)
        cursor = conn.cursor()
        
        # Delete existing admin
        cursor.execute("DELETE FROM users WHERE username = 'admin'")
        
        # Create new admin
        cursor.execute("""
            INSERT INTO users (username, password_hash, role, allowed_folders, is_active, failed_login_attempts)
            VALUES ('admin', ?, 'admin', '[]', 1, 0)
        """, (password_hash,))
        
        conn.commit()
        conn.close()
        
        print("✅ Admin user created!")
        print("   Username: admin")
        print("   Password: admin123")
        print("   ⚠️  CHANGE THIS IMMEDIATELY AFTER LOGIN!")
        
    except Exception as e:
        print(f"❌ Error: {e}")
        import traceback
        traceback.print_exc()

if __name__ == "__main__":
    create_admin()