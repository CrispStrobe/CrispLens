/**
 * LocalDB.js — @capacitor-community/sqlite wrapper for standalone/local mode.
 */

import { CapacitorSQLite, SQLiteConnection } from '@capacitor-community/sqlite';

const DB_NAME = 'face_recognition';
let   sqlite  = null;
let   _db     = null;

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS images (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    filename        TEXT NOT NULL,
    filepath        TEXT NOT NULL UNIQUE,
    local_path      TEXT,
    file_hash       TEXT,
    file_size       INTEGER,
    width           INTEGER,
    height          INTEGER,
    date_taken      TIMESTAMP,
    date_processed  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    description     TEXT,
    scene_type      TEXT,
    owner_id        INTEGER,
    visibility      TEXT DEFAULT 'shared',
    rating          INTEGER DEFAULT 0,
    flag            TEXT
  );
  CREATE TABLE IF NOT EXISTS people (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    name              TEXT NOT NULL UNIQUE,
    total_appearances INTEGER DEFAULT 0,
    created_at        TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at        TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS faces (
    id                   INTEGER PRIMARY KEY AUTOINCREMENT,
    image_id             INTEGER NOT NULL,
    bbox_x1              REAL,
    bbox_y1              REAL,
    bbox_x2              REAL,
    bbox_y2              REAL,
    detection_confidence REAL,
    FOREIGN KEY (image_id) REFERENCES images(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS face_embeddings (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    face_id             INTEGER NOT NULL UNIQUE,
    person_id           INTEGER,
    embedding_vector    BLOB,
    embedding_dimension INTEGER DEFAULT 512,
    FOREIGN KEY (face_id)   REFERENCES faces(id)  ON DELETE CASCADE,
    FOREIGN KEY (person_id) REFERENCES people(id) ON DELETE SET NULL
  );
  CREATE TABLE IF NOT EXISTS image_tags (
    image_id INTEGER NOT NULL,
    tag      TEXT    NOT NULL,
    PRIMARY KEY (image_id, tag)
  );
  CREATE TABLE IF NOT EXISTS albums (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL UNIQUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS image_albums (
    image_id INTEGER NOT NULL,
    album_id INTEGER NOT NULL,
    PRIMARY KEY (image_id, album_id)
  );
  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT
  );
  CREATE TABLE IF NOT EXISTS users (
    id                    INTEGER PRIMARY KEY AUTOINCREMENT,
    username              TEXT NOT NULL UNIQUE,
    password_hash         TEXT,
    password_salt         TEXT,
    role                  TEXT DEFAULT 'user',
    is_active             INTEGER DEFAULT 1,
    failed_login_attempts INTEGER DEFAULT 0,
    last_login            TIMESTAMP,
    created_at            TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  );
  INSERT OR IGNORE INTO users (id, username, role) VALUES (1, 'Local Admin', 'admin');
`;

// ── Public API ────────────────────────────────────────────────────────────────

let _initPromise = null;
let _initFailed = false;

async function _waitForJeepSqlite() {
  if (window.location.protocol === 'capacitor:') return;
  const el = document.querySelector('jeep-sqlite');
  if (el && el.shadowRoot) return; 
  
  console.log('[LocalDB] Waiting for jeep-sqlite component...');
  return new Promise((resolve, reject) => {
    // 3 second timeout — don't hang the app forever
    const timeout = setTimeout(() => {
      _initFailed = true;
      reject(new Error('jeep-sqlite initialization timed out. Standalone mode will be restricted.'));
    }, 3000);

    customElements.whenDefined('jeep-sqlite').then(() => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

export async function getDB() {
  if (_initFailed) throw new Error('Database initialization previously failed.');
  if (_db && (await _db.isDBOpen()).result) return _db;
  if (_initPromise) return _initPromise;

  _initPromise = (async () => {
    console.log('[LocalDB] Opening face_recognition database...');
    try {
      await _waitForJeepSqlite();
      
      if (!sqlite) {
        sqlite = new SQLiteConnection(CapacitorSQLite);
      }
      
      const isWeb = window.location.protocol !== 'capacitor:';
      if (isWeb) {
        await sqlite.initWebStore();
      }

      const isConn = (await sqlite.isConnection(DB_NAME, false)).result;
      if (isConn) {
        _db = await sqlite.retrieveConnection(DB_NAME, false);
      } else {
        _db = await sqlite.createConnection(DB_NAME, false, 'no-encryption', 1, false);
      }

      const isOpen = (await _db.isDBOpen()).result;
      if (!isOpen) {
        await _db.open();
      }

      await _db.execute(SCHEMA);
      console.log('[LocalDB] Database is ready for queries');
      _initPromise = null; 
      return _db;
    } catch (err) {
      console.error('[LocalDB] Initialization error:', err);
      _initPromise = null; 
      _initFailed = true;
      throw err;
    }
  })();

  return _initPromise;
}

export async function query(sql, params = []) {
  try {
    const db = await getDB();
    const result = await db.query(sql, params);
    return result.values ?? [];
  } catch (err) {
    console.error(`[LocalDB] Query failed: ${sql}`, err);
    return []; // Return empty instead of hanging
  }
}

export async function run(sql, params = []) {
  try {
    const db = await getDB();
    return await db.run(sql, params);
  } catch (err) {
    console.error(`[LocalDB] Run failed: ${sql}`, err);
    throw err;
  }
}

export async function isAvailable() {
  if (_initFailed) return false;
  try {
    const db = await getDB();
    return !!db;
  } catch {
    return false;
  }
}
