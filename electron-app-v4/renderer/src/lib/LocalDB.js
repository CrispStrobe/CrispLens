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
    thumbnail_blob  BLOB,
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
    face_quality         REAL DEFAULT 1.0,
    FOREIGN KEY (image_id) REFERENCES images(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS face_embeddings (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    face_id             INTEGER NOT NULL UNIQUE,
    person_id           INTEGER,
    embedding_vector    BLOB,
    embedding_dimension INTEGER DEFAULT 512,
    embedding_model     TEXT,
    recognition_confidence REAL,
    verified            INTEGER DEFAULT 0,
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
  -- Default settings for standalone mode
  INSERT OR IGNORE INTO settings (key, value) VALUES ('pref_vlm_enabled', 'false');
  INSERT OR IGNORE INTO settings (key, value) VALUES ('pref_vlm_provider', 'openrouter');
  INSERT OR IGNORE INTO settings (key, value) VALUES ('pref_vlm_model', 'qwen/qwen3-vl-8b-thinking');
  INSERT OR IGNORE INTO settings (key, value) VALUES ('pref_det_model', 'auto');
  INSERT OR IGNORE INTO settings (key, value) VALUES ('pref_det_threshold', '0.5');
  INSERT OR IGNORE INTO settings (key, value) VALUES ('pref_rec_threshold', '0.4');
  INSERT OR IGNORE INTO settings (key, value) VALUES ('pref_det_retries', '1');
  INSERT OR IGNORE INTO settings (key, value) VALUES ('pref_language', 'en');

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

// Force a final IndexedDB flush when the user hides the tab or closes the window.
// jeep-sqlite auto-save handles most cases, but this catches the "fast close" scenario.
if (typeof document !== 'undefined') {
  const _flushOnHide = () => {
    if (sqlite && _db) {
      sqlite.saveToStore(DB_NAME).catch(() => {});
    }
  };
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') _flushOnHide();
  });
  window.addEventListener('pagehide', _flushOnHide);
}

/** Force-reset the initialization state to allow a retry. */
export function resetInit() {
  console.log('[LocalDB] Resetting init state...');
  _initFailed = false;
  _initPromise = null;
  _db = null;
}

/** 
 * Safely restart the engine by closing everything and resetting state.
 * Useful when the engine gets stuck in an inconsistent state.
 */
export async function restartEngine() {
  console.log('[LocalDB] Full engine restart requested...');
  try {
    if (!sqlite) sqlite = new SQLiteConnection(CapacitorSQLite);
    
    // 1. Try to close active connection
    if (_db) {
      try {
        const isOpen = (await _db.isDBOpen()).result;
        if (isOpen) await _db.close();
      } catch (e) { console.warn('[LocalDB] Error closing DB during restart:', e); }
    }
    
    // 2. Try to close connection in the plugin
    try {
      await sqlite.closeConnection(DB_NAME, false);
    } catch (e) { /* often fails if already closed */ }
    
    // 3. Reset internal state
    resetInit();
    
    // 4. Trigger fresh init
    console.log('[LocalDB] Triggering fresh initialization...');
    return await getDB();
  } catch (err) {
    console.error('[LocalDB] Restart engine failed:', err);
    throw err;
  }
}

async function _waitForJeepSqlite() {
  if (window.location.protocol === 'capacitor:') return;
  if (typeof document === 'undefined') {
    console.log('[LocalDB] Running in worker, skipping jeep-sqlite DOM check');
    return;
  }
  
  console.log('[LocalDB] Checking for jeep-sqlite component...');
  const el = document.querySelector('jeep-sqlite');
  if (el && el.shadowRoot) {
    console.log('[LocalDB] jeep-sqlite already ready');
    return;
  }
  
  return new Promise((resolve, reject) => {
    console.log('[LocalDB] Waiting for customElements.whenDefined(jeep-sqlite)...');
    
    // 5 second timeout — standalone mode should be fast or fail fast
    const timeout = setTimeout(() => {
      _initFailed = true;
      console.error('[LocalDB] jeep-sqlite component TIMEOUT (5s)');
      reject(new Error('jeep-sqlite initialization timed out. SQLite WASM failed to load.'));
    }, 5000);

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
    console.warn('[LocalDB] getDB() found _initFailed=true. Clearing flag and retrying fresh init.');
    _initFailed = false;
    _initPromise = null;
  }
  
  if (_db) {
    try {
      console.log('[LocalDB] Checking existing _db connection...');
      const isOpen = (await _db.isDBOpen()).result;
      if (isOpen) return _db;
      console.log('[LocalDB] Existing _db exists but is closed.');
    } catch (e) {
      console.warn('[LocalDB] _db exists but isDBOpen check failed:', e.message);
    }
    _db = null; // Re-create
  }
  
  if (_initPromise) {
    console.log('[LocalDB] getDB() waiting for existing initPromise...');
    return _initPromise;
  }

  console.log('[LocalDB] Creating new initialization promise...');
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
        try {
          _db = await sqlite.createConnection(DB_NAME, false, 'no-encryption', 1, false);
        } catch (createErr) {
          if (createErr.message?.includes('already exists')) {
            console.warn('[LocalDB] Connection already exists despite isConnection=false. Attempting retrieval...');
            _db = await sqlite.retrieveConnection(DB_NAME, false);
          } else {
            throw createErr;
          }
        }
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

      // ── Migration: ensure columns added after initial schema ───────────
      // Runs AFTER Step 8 so tables always exist before ALTER TABLE is attempted.
      // On a fresh DB the SCHEMA already creates all columns; these ALTERs are
      // only needed for existing databases created before the columns were added.
      try {
        console.log('[LocalDB] Starting migrations check...');
        const isWeb = window.location.protocol !== 'capacitor:';

        async function columnExists(table, col) {
          const res = await _db.query(`PRAGMA table_info(${table});`);
          const cols = (res.values || []).map(c => c.name.toLowerCase());
          return cols.includes(col.toLowerCase());
        }

        async function safeAddColumn(table, col, definition) {
          if (!(await columnExists(table, col))) {
            console.log(`[LocalDB] Migrating: adding ${table}.${col}`);
            try {
              await _db.execute(`ALTER TABLE ${table} ADD COLUMN ${col} ${definition};`);
              return true;
            } catch (e) {
              console.error(`[LocalDB] Failed to add column ${table}.${col}:`, e);
              return false;
            }
          }
          return false;
        }

        let changed = false;
        if (await safeAddColumn('images', 'thumbnail_blob', 'BLOB')) changed = true;
        if (await safeAddColumn('faces', 'face_quality', 'REAL DEFAULT 1.0')) changed = true;
        if (await safeAddColumn('face_embeddings', 'verified', 'INTEGER DEFAULT 0')) changed = true;
        if (await safeAddColumn('face_embeddings', 'embedding_model', 'TEXT')) changed = true;
        if (await safeAddColumn('face_embeddings', 'recognition_confidence', 'REAL')) changed = true;

        if (changed && isWeb && sqlite) {
          console.log('[LocalDB] Persisting migrations to WebStore...');
          await sqlite.saveToStore(DB_NAME);
        }
        console.log('[LocalDB] Migrations check complete');
      } catch (migErr) {
        console.error('[LocalDB] Migration process failed:', migErr);
      }

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
  console.log(`[LocalDB] Query: ${sql.slice(0, 50)}...`, params);
  try {
    const db = await getDB();
    const result = await db.query(sql, params);
    console.log(`[LocalDB] Query result count: ${result.values?.length || 0}`);
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
    // auto-save="true" on the jeep-sqlite element handles IndexedDB persistence
    // automatically; this explicit call is a belt-and-suspenders flush for web.
    // We intentionally do NOT throw on saveToStore failure — the in-memory write
    // succeeded and auto-save will persist it; failing here would abort callers.
    const isWeb = window.location.protocol !== 'capacitor:';
    if (isWeb && sqlite) {
      sqlite.saveToStore(DB_NAME).catch(e =>
        console.warn('[LocalDB] saveToStore non-fatal error:', e));
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
      sqlite.saveToStore(DB_NAME).catch(e =>
        console.warn('[LocalDB] saveToStore non-fatal error (execute):', e));
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
 * Estimate the size of the database in MB.
 */
export async function getDatabaseSize() {
  try {
    const isWeb = window.location.protocol !== 'capacitor:';
    if (isWeb) {
      // On Web, we can try to get the size from the IndexedDB
      if ('storage' in navigator && 'estimate' in navigator.storage) {
        const estimate = await navigator.storage.estimate();
        // This is the total usage for the origin, but it's a good hint
        // if the app is mostly the database.
        // For a more precise measure, we'd need to check the specific IDB entry.
        // jeep-sqlite usually stores data in 'keyvaluepairs' store in 'jeepSqliteStore' DB.
      }
      
      // Better way: use the plugin's export method to get the actual data size
      // but that's expensive. 
      // Let's just return 'N/A' or try a simple SQL query if we have a table with blobs.
      const [res] = await query("SELECT page_count * page_size as size FROM pragma_page_count(), pragma_page_size();");
      if (res && res.size) {
        return (res.size / (1024 * 1024)).toFixed(2);
      }
    } else {
      // On Native, we might be able to get the file size via Capacitor Filesystem
      // but we need the path.
    }
  } catch (err) {
    console.warn('[LocalDB] Failed to get DB size:', err);
  }
  return null;
}

/**
 * Export the entire database as a JSON object (compatible with @capacitor-community/sqlite).
 */
export async function exportDatabase() {
  try {
    console.log(`[LocalDB] Exporting ${DB_NAME} to JSON...`);
    const db = await getDB();
    
    // Ensure data is flushed to the web store if on web
    const isWeb = window.location.protocol !== 'capacitor:';
    if (isWeb && sqlite) await sqlite.saveToStore(DB_NAME);

    // In v7, exportToJson is available on the database instance
    const jsonExport = await db.exportToJson('full');
    if (!jsonExport || !jsonExport.export) {
      throw new Error('Export failed: no data returned');
    }
    return jsonExport.export;
  } catch (err) {
    console.error('[LocalDB] Export failed:', err);
    throw err;
  }
}

/**
 * Import a database from a JSON object.
 * WARNING: This will overwrite/merge with existing data.
 */
export async function importDatabase(jsonContent) {
  try {
    console.log(`[LocalDB] Importing database from JSON...`);
    if (!sqlite) sqlite = new SQLiteConnection(CapacitorSQLite);
    
    // The SQLiteConnection.importFromJson wrapper specifically expects a STRING.
    // If we pass an object, it stringifies to "[object Object]", which causes the JSON parse error.
    const jsonStr = typeof jsonContent === 'string' ? jsonContent : JSON.stringify(jsonContent);
    
    // We should close the current connection first
    if (_db) {
      try {
        const isOpen = (await _db.isDBOpen()).result;
        if (isOpen) await _db.close();
      } catch (e) { /* ignore */ }
      try {
        await sqlite.closeConnection(DB_NAME, false);
      } catch (e) { /* ignore */ }
      _db = null;
    }

    // Pass the raw string directly to the wrapper
    const result = await sqlite.importFromJson(jsonStr);
    console.log('[LocalDB] Import successful, changes:', result.changes);
    
    // Re-initialize the connection
    await getDB();
    
    return result;
  } catch (err) {
    console.error('[LocalDB] Import failed:', err);
    throw err;
  }
}

/**
 * Completely reset the database (drop and re-create all tables).
 */
export async function clearDatabase() {
  try {
    console.warn('[LocalDB] Resetting database...');
    
    if (!sqlite) sqlite = new SQLiteConnection(CapacitorSQLite);
    
    // 1. Close connections
    if (_db) {
      try {
        const isOpen = (await _db.isDBOpen()).result;
        if (isOpen) await _db.close();
      } catch (e) { console.warn('[LocalDB] Error closing DB:', e); }
    }
    
    try {
      await sqlite.closeConnection(DB_NAME, false);
    } catch (e) { /* ignore */ }
    
    _db = null;
    resetInit();

    // 2. Delete using the plugin directly (more robust than connection method)
    console.log(`[LocalDB] Deleting database file: ${DB_NAME}`);
    await CapacitorSQLite.deleteDatabase({ database: DB_NAME });
    
    // 3. Re-initialize with the schema
    console.log('[LocalDB] Re-initializing fresh database...');
    await getDB();
    
    return { ok: true };
  } catch (err) {
    console.error('[LocalDB] Reset failed:', err);
    throw err;
  }
}

/**
 * Destructive: Clears EVERYTHING. 
 * LocalStorage, IndexedDB (SQLite), and Service Worker caches.
 */
export async function hardResetApp() {
  console.warn('[LocalDB] HARD RESET requested. Purging all local data.');
  
  // 1. Clear database
  try {
    await clearDatabase();
  } catch (e) { console.error('[LocalDB] Could not clear SQLite during reset:', e); }

  // 2. Clear LocalStorage
  localStorage.clear();
  
  // 3. Clear Caches
  if ('caches' in window) {
    try {
      const names = await caches.keys();
      for (const name of names) await caches.delete(name);
    } catch (e) { console.error('[LocalDB] Could not clear Caches:', e); }
  }

  // 4. Unregister Service Workers
  if ('serviceWorker' in navigator) {
    try {
      const regs = await navigator.serviceWorker.getRegistrations();
      for (const r of regs) await r.unregister();
    } catch (e) { console.error('[LocalDB] Could not unregister SW:', e); }
  }

  console.log('[LocalDB] Hard reset complete. Reloading...');
  window.location.reload();
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
