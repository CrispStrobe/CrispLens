'use strict';

/**
 * recover-images.js — Extract deleted image rows from SQLite free pages
 *
 * After a hard-reset, image rows are deleted but their data remains
 * physically in the database file's free pages. This script:
 *   1. Opens the DB file as raw binary
 *   2. Scans ALL pages (including free-list pages) for recognizable image records
 *   3. Re-inserts found records into the images table
 *
 * Usage: node tools/recover-images.js [path/to/face_recognition.db]
 */

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

const DB_PATH = process.argv[2] ||
  path.join(__dirname, '..', '..', 'face_recognition.db');

if (!fs.existsSync(DB_PATH)) {
  console.error('DB not found:', DB_PATH);
  process.exit(1);
}

// ── Read page size from DB header ─────────────────────────────────────────────
const header = Buffer.alloc(100);
const fd = fs.openSync(DB_PATH, 'r');
fs.readSync(fd, header, 0, 100, 0);
fs.closeSync(fd);

const PAGE_SIZE = header.readUInt16BE(16) || 4096;
const FILE_SIZE = fs.statSync(DB_PATH).size;
const PAGE_COUNT = Math.floor(FILE_SIZE / PAGE_SIZE);
console.log(`DB: ${DB_PATH}`);
console.log(`Page size: ${PAGE_SIZE}  Total pages: ${PAGE_COUNT}  File: ${(FILE_SIZE/1024/1024).toFixed(1)}MB`);

// ── Read all pages ─────────────────────────────────────────────────────────────
const dbBuf = fs.readFileSync(DB_PATH);

// ── Also read WAL file if present ─────────────────────────────────────────────
const WAL_PATH = DB_PATH + '-wal';
let walBuf = null;
if (fs.existsSync(WAL_PATH)) {
  walBuf = fs.readFileSync(WAL_PATH);
  console.log(`WAL: ${WAL_PATH}  (${(walBuf.length/1024/1024).toFixed(1)}MB)`);
}

// ── Extract all strings from raw bytes ────────────────────────────────────────
function extractStrings(buf, minLen = 8) {
  const results = [];
  let start = -1;
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i];
    const printable = (b >= 0x20 && b < 0x7f);
    if (printable) {
      if (start === -1) start = i;
    } else {
      if (start !== -1 && i - start >= minLen) {
        results.push({ offset: start, str: buf.slice(start, i).toString('ascii') });
      }
      start = -1;
    }
  }
  return results;
}

// ── Parse image records from string sequences ─────────────────────────────────
// SQLite stores row data as a sequence of values separated by binary varints.
// The extractable text will appear as adjacent strings in the raw bytes.
// We look for patterns like: <uuid>.jpg\0<uuid>.jpg\0<sha256>\0...\0<local_path>\0

const IMAGE_PATH_RE = /^(\/[^\0]{4,300}\.(jpg|jpeg|png|webp|heic|heif|gif|bmp))$/i;
const HASH_RE = /^[0-9a-f]{64}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}/;

function parseImageRecords(buf, source) {
  const strings = extractStrings(buf, 8);
  const records = [];
  let i = 0;

  while (i < strings.length) {
    const s = strings[i];

    // Look for a server filepath (UUID-style in uploads/)
    if (IMAGE_PATH_RE.test(s.str)) {
      const filepath = s.str;
      let filename   = null;
      let file_hash  = null;
      let local_path = null;
      let ai_desc    = null;
      let scene_type = null;
      let taken_at   = null;

      // Scan forward up to 20 entries for related fields
      for (let j = i + 1; j < Math.min(i + 25, strings.length); j++) {
        const t = strings[j].str;
        if (t === filepath) continue;  // skip duplicate
        if (!filename && IMAGE_PATH_RE.test(t) && path.basename(t) === path.basename(filepath)) {
          filename = path.basename(filepath);
        } else if (!filename && /^[0-9a-f-]{36}\.(jpg|jpeg|png|webp|heic)$/i.test(t)) {
          filename = t;
        } else if (!file_hash && HASH_RE.test(t)) {
          file_hash = t;
        } else if (!local_path && IMAGE_PATH_RE.test(t) && t !== filepath) {
          local_path = t;
        } else if (!taken_at && DATE_RE.test(t)) {
          taken_at = t.slice(0, 19);
        } else if (!ai_desc && t.length > 30 && /[A-Z]/.test(t[0]) && t.includes(' ')) {
          ai_desc = t;
        } else if (!scene_type && ['portrait','indoor','outdoor','group','landscape','event','nature','urban','conference','presentation','other'].includes(t.toLowerCase())) {
          scene_type = t.toLowerCase();
        }
      }

      if (!filename) filename = path.basename(filepath);

      records.push({ filepath, filename, file_hash, local_path, ai_desc, scene_type, taken_at, source });
      i += 2;  // skip past this match
      continue;
    }
    i++;
  }
  return records;
}

// ── Deduplicate by filepath ────────────────────────────────────────────────────
const allRecords = new Map();

const dbRecords  = parseImageRecords(dbBuf, 'db');
const walRecords = walBuf ? parseImageRecords(walBuf, 'wal') : [];

for (const r of [...dbRecords, ...walRecords]) {
  if (!allRecords.has(r.filepath)) {
    allRecords.set(r.filepath, r);
  } else {
    // Merge: keep more complete record
    const existing = allRecords.get(r.filepath);
    if (r.ai_desc && !existing.ai_desc) existing.ai_desc = r.ai_desc;
    if (r.local_path && !existing.local_path) existing.local_path = r.local_path;
    if (r.file_hash && !existing.file_hash) existing.file_hash = r.file_hash;
    if (r.taken_at && !existing.taken_at) existing.taken_at = r.taken_at;
    if (r.scene_type && !existing.scene_type) existing.scene_type = r.scene_type;
  }
}

console.log(`\nFound ${allRecords.size} distinct image records in free pages.`);

if (allRecords.size === 0) {
  console.log('No recoverable records found. Data may have been overwritten.');
  process.exit(0);
}

// ── Check which files still exist ─────────────────────────────────────────────
let existCount = 0, missingCount = 0;
for (const [, r] of allRecords) {
  const fileExists = fs.existsSync(r.filepath) || fs.existsSync(r.local_path || '');
  r.file_exists = fileExists;
  if (fileExists) existCount++; else missingCount++;
}

console.log(`Files on disk: ${existCount} found, ${missingCount} missing`);

// ── Re-insert into DB ──────────────────────────────────────────────────────────
const Database = require('better-sqlite3');
const db = new Database(DB_PATH);

// Verify images table is empty (don't double-insert on second run)
const currentCount = db.prepare('SELECT COUNT(*) AS n FROM images').get().n;
if (currentCount > 0) {
  console.log(`\nimages table already has ${currentCount} rows — aborting to avoid duplicates.`);
  console.log('To force recovery, DELETE FROM images first, then run this script.');
  db.close();
  process.exit(0);
}

const insert = db.prepare(`
  INSERT OR IGNORE INTO images
    (filepath, filename, file_hash, local_path, visibility,
     ai_description, ai_scene_type, taken_at,
     processed, processed_at, created_at)
  VALUES (?,?,?,?,?, ?,?,?, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
`);

let inserted = 0;
const insertAll = db.transaction(() => {
  for (const [, r] of allRecords) {
    try {
      const res = insert.run(
        r.filepath, r.filename, r.file_hash || null, r.local_path || null, 'shared',
        r.ai_desc || null, r.scene_type || null, r.taken_at || null,
      );
      if (res.changes) inserted++;
    } catch (e) {
      console.warn(`  Skip ${r.filename}: ${e.message}`);
    }
  }
});
insertAll();

console.log(`\n✓ Re-inserted ${inserted} image records into images table.`);
console.log(`  NOTE: Face detection data (bboxes, embeddings) is NOT recovered.`);
console.log(`  Re-run batch processing on the images folder to restore face data.`);
console.log(`  AI descriptions that were in the free pages HAVE been preserved.`);

db.close();
