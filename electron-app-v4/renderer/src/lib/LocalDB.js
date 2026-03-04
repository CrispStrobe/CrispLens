/**
 * LocalDB.js — @capacitor-community/sqlite wrapper for standalone/local mode.
 *
 * Provides the same face_recognition schema as the server's SQLite DB.
 * Used only when db_mode='local' (Capacitor without a remote server).
 */

import { CapacitorSQLite, SQLiteConnection } from '@capacitor-community/sqlite';

const DB_NAME = 'face_recognition';
const sqlite  = new SQLiteConnection(CapacitorSQLite);
let   _db     = null;

// ── Schema — mirrors server/db.js CREATE TABLE IF NOT EXISTS statements ────────

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
`;

// ── Public API ────────────────────────────────────────────────────────────────

let _initPromise = null;

export async function getDB() {
  if (_db) return _db;
  if (_initPromise) return _initPromise;

  _initPromise = (async () => {
    console.log('[LocalDB] Initializing database...');
    try {
      const isConn = (await sqlite.isConnection(DB_NAME, false)).result;
      console.log(`[LocalDB] Connection exists: ${isConn}`);

      if (isConn) {
        console.log('[LocalDB] Retrieving existing connection...');
        _db = await sqlite.retrieveConnection(DB_NAME, false);
      } else {
        console.log('[LocalDB] Creating new connection...');
        _db = await sqlite.createConnection(DB_NAME, false, 'no-encryption', 1, false);
      }

      console.log('[LocalDB] Checking if DB is open...');
      const isOpen = (await _db.isDBOpen()).result;
      console.log(`[LocalDB] DB open: ${isOpen}`);

      if (!isOpen) {
        console.log('[LocalDB] Opening DB...');
        await _db.open();
      }

      console.log('[LocalDB] Executing schema...');
      await _db.execute(SCHEMA);
      console.log('[LocalDB] Database ready.');
      return _db;
    } catch (err) {
      console.error('[LocalDB] Initialization error:', err);
      _initPromise = null;
      throw err;
    }
  })();

  return _initPromise;
}

export async function query(sql, params = []) {
  const db = await getDB();
  const result = await db.query(sql, params);
  return result.values ?? [];
}

export async function run(sql, params = []) {
  const db = await getDB();
  return db.run(sql, params);
}

export async function isAvailable() {
  try {
    const r = await sqlite.checkConnectionsConsistency();
    return true;
  } catch {
    return false;
  }
}
