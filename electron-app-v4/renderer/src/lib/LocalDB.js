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
  
  console.log('[LocalDB] Checking for jeep-sqlite component...');
  const el = document.querySelector('jeep-sqlite');
  if (el && el.shadowRoot) {
    console.log('[LocalDB] jeep-sqlite already ready');
    return;
  }
  
  return new Promise((resolve, reject) => {
    console.log('[LocalDB] Waiting for customElements.whenDefined(jeep-sqlite)...');
    
    // 3 second timeout — standalone mode should be fast or fail fast
    const timeout = setTimeout(() => {
      _initFailed = true;
      console.error('[LocalDB] jeep-sqlite component TIMEOUT');
      reject(new Error('jeep-sqlite initialization timed out. SQLite WASM failed to load.'));
    }, 3000);

    // Listen for global errors that might indicate WASM LinkError
    const errorListener = (event) => {
      if (event.message && (event.message.includes('LinkError') || event.message.includes('wasm'))) {
        console.error('[LocalDB] Detected WASM error during initialization:', event.message);
        _initFailed = true;
        clearTimeout(timeout);
        window.removeEventListener('error', errorListener);
        reject(new Error(`SQLite WASM Error: ${event.message}`));
      }
    };
    window.addEventListener('error', errorListener);

    customElements.whenDefined('jeep-sqlite').then(async () => {
      console.log('[LocalDB] jeep-sqlite defined, checking shadowRoot...');
      
      let attempts = 0;
      const checkShadow = setInterval(() => {
        const jeep = document.querySelector('jeep-sqlite');
        if (jeep && jeep.shadowRoot) {
          console.log('[LocalDB] jeep-sqlite shadowRoot found');
          clearTimeout(timeout);
          clearInterval(checkShadow);
          window.removeEventListener('error', errorListener);
          resolve();
        }
        if (++attempts > 10) { // 1 second of checking shadowRoot
          clearTimeout(timeout);
          clearInterval(checkShadow);
          window.removeEventListener('error', errorListener);
          console.warn('[LocalDB] jeep-sqlite shadowRoot missing after 1s');
          resolve(); // Try anyway
        }
      }, 100);
    });
  });
}

export async function getDB() {
  if (_initFailed) {
    console.error('[LocalDB] getDB() called but initialization previously failed.');
    throw new Error('Database initialization previously failed.');
  }
  
  if (_db) {
    try {
      const isOpen = (await _db.isDBOpen()).result;
      if (isOpen) return _db;
    } catch (e) {
      console.warn('[LocalDB] _db instance exists but isDBOpen check failed:', e.message);
      _db = null; // Re-create
    }
  }
  
  if (_initPromise) {
    console.log('[LocalDB] getDB() returning existing initPromise');
    return _initPromise;
  }

  _initPromise = (async () => {
    console.log('[LocalDB] Opening face_recognition database...');
    try {
      console.log('[LocalDB] Step 1: Waiting for jeep-sqlite...');
      await _waitForJeepSqlite();
      
      console.log('[LocalDB] Step 2: Creating SQLiteConnection...');
      if (!sqlite) {
        sqlite = new SQLiteConnection(CapacitorSQLite);
      }
      
      const isWeb = window.location.protocol !== 'capacitor:';
      if (isWeb) {
        console.log('[LocalDB] Step 3: Initializing WebStore (indexedDB)...');
        await sqlite.initWebStore();
        console.log('[LocalDB] WebStore initialized');
      }

      console.log(`[LocalDB] Step 4: Checking for connection: ${DB_NAME}`);
      const isConn = (await sqlite.isConnection(DB_NAME, false)).result;
      console.log(`[LocalDB] Connection exists: ${isConn}`);
      
      if (isConn) {
        console.log('[LocalDB] Step 5a: Retrieving existing connection...');
        _db = await sqlite.retrieveConnection(DB_NAME, false);
      } else {
        console.log('[LocalDB] Step 5b: Creating new connection...');
        _db = await sqlite.createConnection(DB_NAME, false, 'no-encryption', 1, false);
      }

      console.log('[LocalDB] Step 6: Checking if DB is open...');
      const isOpen = (await _db.isDBOpen()).result;
      console.log(`[LocalDB] DB is open: ${isOpen}`);
      
      if (!isOpen) {
        console.log('[LocalDB] Step 7: Opening database...');
        await _db.open();
        console.log('[LocalDB] Database opened');
      }

      console.log('[LocalDB] Step 8: Executing schema...');
      await _db.execute(SCHEMA);
      console.log('[LocalDB] Step 9: Database is ready for queries');
      _initPromise = null; 
      return _db;
    } catch (err) {
      console.error('[LocalDB] CRITICAL Initialization error at some step:', err);
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
    const result = await db.run(sql, params);
    
    // On Web, we MUST save to store to persist in IndexedDB
    const isWeb = window.location.protocol !== 'capacitor:';
    if (isWeb && sqlite) {
      console.log(`[LocalDB] Saving ${DB_NAME} to WebStore...`);
      await sqlite.saveToStore(DB_NAME);
    }
    
    return result;
  } catch (err) {
    console.error(`[LocalDB] Run failed: ${sql}`, err);
    throw err;
  }
}

export async function execute(sql) {
  try {
    const db = await getDB();
    const result = await db.execute(sql);
    
    const isWeb = window.location.protocol !== 'capacitor:';
    if (isWeb && sqlite) {
      console.log(`[LocalDB] Saving ${DB_NAME} to WebStore (after execute)...`);
      await sqlite.saveToStore(DB_NAME);
    }
    
    return result;
  } catch (err) {
    console.error(`[LocalDB] Execute failed`, err);
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

/** 
 * Diagnostic: Run a simple SQL test to prove the engine works.
 */
export async function testStandaloneDB() {
  console.log('[LocalDB] Running diagnostic test...');
  try {
    const db = await getDB();
    
    // 1. Create temp table
    console.log('[LocalDB] Test: creating table...');
    await db.execute('CREATE TABLE IF NOT EXISTS _test_diag (id INTEGER PRIMARY KEY, val TEXT);');
    
    // 2. Insert row
    console.log('[LocalDB] Test: inserting row...');
    const ts = new Date().toISOString();
    await db.run('INSERT INTO _test_diag (val) VALUES (?);', [ts]);
    
    // 3. Query row
    console.log('[LocalDB] Test: querying row...');
    const res = await db.query('SELECT * FROM _test_diag ORDER BY id DESC LIMIT 1;');
    
    if (res.values && res.values.length > 0 && res.values[0].val === ts) {
      console.log('[LocalDB] Diagnostic test PASSED');
      return { ok: true, message: 'SQLite engine is working correctly (Read/Write OK)' };
    } else {
      throw new Error('Database read/write verification failed');
    }
  } catch (err) {
    console.error('[LocalDB] Diagnostic test FAILED:', err);
    return { ok: false, error: err.message };
  }
}
