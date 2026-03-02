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

let _db = null;

function getDb() {
  if (_db) return _db;

  const dbPath = process.env.DB_PATH ||
    path.join(__dirname, '..', '..', 'face_recognition.db');

  if (!fs.existsSync(dbPath)) {
    throw new Error(`Database not found: ${dbPath}\nSet DB_PATH env var or place face_recognition.db in the project root.`);
  }

  _db = new Database(dbPath);
  _db.pragma('journal_mode = WAL');
  _db.pragma('foreign_keys = ON');

  console.log(`[db] Opened: ${dbPath}`);
  return _db;
}

function closeDb() {
  if (_db) { _db.close(); _db = null; }
}

module.exports = { getDb, closeDb };
