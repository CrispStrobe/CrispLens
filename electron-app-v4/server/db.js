'use strict';

/**
 * db.js — SQLite singleton.
 *
 * Usage:
 *   const db = require('./db');
 *   const rows = db.prepare('SELECT …').all();
 */

const Database = require('better-sqlite3');
const path     = require('path');
const fs       = require('fs');

let _db   = null;
let _path = null;

function getDbPath() {
  if (_path) return _path;
  return process.env.DB_PATH ||
    path.join(__dirname, '..', '..', 'face_recognition.db');
}

function getDb() {
  if (_db) return _db;

  console.log('[db] Initializing database connection...');
  _path = getDbPath();
  console.log(`[db] Target path: ${_path}`);

  if (!fs.existsSync(_path)) {
    console.error(`[db] Database file NOT FOUND at: ${_path}`);
    throw new Error(`Database not found: ${_path}\nSet DB_PATH env var or place face_recognition.db in the project root.`);
  }

  try {
    console.log('[db] Opening better-sqlite3 session...');
    _db = new Database(_path, { verbose: (msg) => { if (process.env.DEBUG_SQL) console.log(`[sql] ${msg}`); } });
    console.log('[db] Session opened.');
    
    _db.pragma('journal_mode = WAL');
    _db.pragma('foreign_keys = ON');
    _db.pragma('busy_timeout = 5000'); // don't hang forever if locked
    console.log('[db] Pragmas set (WAL, FK, timeout=5s).');

    // ── Create v4-native tables if missing ──────────────────────────────────────
    console.log('[db] Ensuring v4-native tables exist...');
    _db.exec(`
      CREATE TABLE IF NOT EXISTS api_keys (
        provider  TEXT NOT NULL,
        scope     TEXT NOT NULL DEFAULT 'system',
        owner_id  INTEGER,
        key_value TEXT NOT NULL,
        PRIMARY KEY (provider, scope, owner_id)
      );
      CREATE TABLE IF NOT EXISTS settings (
        key        TEXT PRIMARY KEY,
        value      TEXT,
        value_type TEXT DEFAULT 'string'
      );
      CREATE TABLE IF NOT EXISTS watch_folders (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        path           TEXT NOT NULL UNIQUE,
        recursive      INTEGER DEFAULT 1,
        auto_scan      INTEGER DEFAULT 0,
        scan_interval  INTEGER DEFAULT 3600,
        last_scanned   TIMESTAMP,
        enabled        INTEGER DEFAULT 1,
        created_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS batch_jobs (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        owner_id       INTEGER,
        name           TEXT,
        status         TEXT DEFAULT 'pending',
        source_path    TEXT,
        recursive      INTEGER DEFAULT 1,
        follow_symlinks INTEGER DEFAULT 0,
        visibility     TEXT DEFAULT 'shared',
        det_params     TEXT,
        tag_ids        TEXT,
        new_tag_names  TEXT,
        album_id       INTEGER,
        new_album_name TEXT,
        total_count    INTEGER DEFAULT 0,
        done_count     INTEGER DEFAULT 0,
        error_count    INTEGER DEFAULT 0,
        created_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        started_at     TIMESTAMP,
        completed_at   TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS batch_job_files (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id      INTEGER NOT NULL,
        filepath    TEXT NOT NULL,
        status      TEXT DEFAULT 'pending',
        error_msg   TEXT,
        image_id    INTEGER,
        processed_at TIMESTAMP,
        FOREIGN KEY(job_id) REFERENCES batch_jobs(id) ON DELETE CASCADE
      );
    `);
    console.log('[db] v4-native tables OK.');

    // ── Migrate v2 images table — add columns v4 code expects ────────────────
    console.log('[db] Checking for v2 -> v4 migrations...');
    const imgCols = new Set(_db.pragma('table_info(images)').map(c => c.name));
    const imgMigrations = [
      ['owner_id',        'ALTER TABLE images ADD COLUMN owner_id INTEGER'],
      ['visibility',      "ALTER TABLE images ADD COLUMN visibility TEXT DEFAULT 'shared'"],
      ['rating',          'ALTER TABLE images ADD COLUMN rating INTEGER DEFAULT 0'],
      ['flag',            'ALTER TABLE images ADD COLUMN flag TEXT'],
      ['description',     'ALTER TABLE images ADD COLUMN description TEXT'],
      ['ai_description',  'ALTER TABLE images ADD COLUMN ai_description TEXT'],
      ['ai_scene_type',   'ALTER TABLE images ADD COLUMN ai_scene_type TEXT'],
      ['ai_tags',         'ALTER TABLE images ADD COLUMN ai_tags TEXT'],
    ];
    for (const [col, sql] of imgMigrations) {
      if (!imgCols.has(col)) {
        console.log(`[db] Migrating: ${col}`);
        _db.exec(sql);
      }
    }
    console.log('[db] Migrations OK.');

    console.log(`[db] Successfully opened and ready: ${_path}`);
    return _db;
  } catch (err) {
    console.error(`[db] FAILED to open database: ${err.message}`);
    _db = null;
    throw err;
  }
}

function closeDb() {
  if (_db) { _db.close(); _db = null; _path = null; }
}

module.exports = { getDb, closeDb, getDbPath };
