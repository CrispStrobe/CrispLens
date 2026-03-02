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

  _path = getDbPath();

  if (!fs.existsSync(_path)) {
    throw new Error(`Database not found: ${_path}\nSet DB_PATH env var or place face_recognition.db in the project root.`);
  }

  _db = new Database(_path);
  _db.pragma('journal_mode = WAL');
  _db.pragma('foreign_keys = ON');

  // Ensure api_keys table exists (v4-native, may not be in v2 schema)
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
  `);

  console.log(`[db] Opened: ${_path}`);
  return _db;
}

function closeDb() {
  if (_db) { _db.close(); _db = null; _path = null; }
}

module.exports = { getDb, closeDb, getDbPath };
