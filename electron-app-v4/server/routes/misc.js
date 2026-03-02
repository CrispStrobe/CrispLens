'use strict';

/**
 * misc.js — Tags, Albums, Stats, Events, Filesystem, Watch Folders,
 *            Batch Jobs, Duplicates, Scene-types, API-keys stubs.
 */

const express = require('express');
const path    = require('path');
const fs      = require('fs');
const crypto  = require('crypto');
const { getDb }      = require('../db');
const { requireAuth, requireAdmin } = require('../auth');

const router = express.Router();

// ─────────────────────────────────────────────────────────────────────────────
// HEALTH
// ─────────────────────────────────────────────────────────────────────────────

router.get('/health', (req, res) => {
  res.json({ ok: true, version: '4.0.0', backend: 'node-js' });
});

// ─────────────────────────────────────────────────────────────────────────────
// STATS
// ─────────────────────────────────────────────────────────────────────────────

router.get('/stats', requireAuth, (req, res) => {
  const db = getDb();
  res.json({
    images:  db.prepare('SELECT COUNT(*) AS n FROM images').get().n,
    faces:   db.prepare('SELECT COUNT(*) AS n FROM faces').get().n,
    people:  db.prepare('SELECT COUNT(*) AS n FROM people').get().n,
    albums:  db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='albums'").get().n
             ? db.prepare('SELECT COUNT(*) AS n FROM albums').get().n : 0,
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// TAGS
// ─────────────────────────────────────────────────────────────────────────────

router.get('/tags', requireAuth, (req, res) => {
  const db = getDb();
  res.json(db.prepare('SELECT * FROM tags ORDER BY usage_count DESC, name ASC').all());
});

router.get('/tags/stats', requireAuth, (req, res) => {
  const db = getDb();
  res.json(db.prepare(`
    SELECT t.id, t.name, t.color, COUNT(it.image_id) AS count
    FROM tags t LEFT JOIN image_tags it ON it.tag_id = t.id
    GROUP BY t.id ORDER BY count DESC
  `).all());
});

router.post('/tags', requireAuth, (req, res) => {
  const db = getDb();
  const { name, color } = req.body || {};
  if (!name?.trim()) return res.status(400).json({ detail: 'name required' });
  try {
    const r = db.prepare('INSERT INTO tags(name, color) VALUES(?,?)').run(name.trim(), color || null);
    res.json({ id: r.lastInsertRowid, name: name.trim() });
  } catch (err) {
    res.status(400).json({ detail: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// SCENE TYPES
// ─────────────────────────────────────────────────────────────────────────────

router.get('/scene-types', requireAuth, (req, res) => {
  const db   = getDb();
  const rows = db.prepare(`
    SELECT ai_scene_type AS type, COUNT(*) AS count FROM images
    WHERE ai_scene_type IS NOT NULL GROUP BY ai_scene_type ORDER BY count DESC
  `).all();
  res.json(rows);
});

// ─────────────────────────────────────────────────────────────────────────────
// DATES STATS
// ─────────────────────────────────────────────────────────────────────────────

router.get('/dates/stats', requireAuth, (req, res) => {
  const db = getDb();
  const rows = db.prepare(`
    SELECT strftime('%Y-%m', COALESCE(taken_at, created_at)) AS month,
           COUNT(*) AS count
    FROM images
    WHERE COALESCE(taken_at, created_at) IS NOT NULL
    GROUP BY month ORDER BY month DESC
  `).all();
  res.json(rows);
});

// ─────────────────────────────────────────────────────────────────────────────
// FOLDERS STATS
// ─────────────────────────────────────────────────────────────────────────────

router.get('/folders/stats', requireAuth, (req, res) => {
  const db   = getDb();
  const rows = db.prepare('SELECT filepath FROM images').all();
  const counts = {};
  for (const r of rows) {
    const dir = path.dirname(r.filepath);
    counts[dir] = (counts[dir] || 0) + 1;
  }
  const result = Object.entries(counts)
    .map(([folder, count]) => ({ name: folder, count }))  // `name` matches FoldersView.svelte
    .sort((a, b) => b.count - a.count);
  res.json(result);
});

// ─────────────────────────────────────────────────────────────────────────────
// EVENTS
// ─────────────────────────────────────────────────────────────────────────────

router.get('/events', requireAuth, (req, res) => {
  const db       = getDb();
  const gapHours = parseFloat(req.query.gap_hours) || 4;
  const limit    = Math.min(500, Number(req.query.limit) || 200);

  const rows = db.prepare(`
    SELECT id, filename, filepath,
           COALESCE(taken_at, created_at) AS ts
    FROM images
    WHERE COALESCE(taken_at, created_at) IS NOT NULL
    ORDER BY ts ASC
    LIMIT ?
  `).all(limit);

  if (!rows.length) return res.json([]);

  // Group into events by time gap
  const events = [];
  let cur = { start: rows[0].ts, end: rows[0].ts, images: [rows[0]] };
  for (let i = 1; i < rows.length; i++) {
    const prev = new Date(rows[i - 1].ts).getTime();
    const curr = new Date(rows[i].ts).getTime();
    if ((curr - prev) > gapHours * 3600 * 1000) {
      events.push(cur);
      cur = { start: rows[i].ts, end: rows[i].ts, images: [rows[i]] };
    } else {
      cur.end = rows[i].ts;
      cur.images.push(rows[i]);
    }
  }
  events.push(cur);

  res.json(events.reverse().map((e, idx) => ({
    id:     idx,
    start:  e.start,
    end:    e.end,
    count:  e.images.length,
    cover:  e.images[0],
  })));
});

// ─────────────────────────────────────────────────────────────────────────────
// ALBUMS
// ─────────────────────────────────────────────────────────────────────────────

function ensureAlbumsTable(db) {
  db.prepare(`CREATE TABLE IF NOT EXISTS albums (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    description TEXT,
    cover_image_id INTEGER,
    owner_id INTEGER,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`).run();
  db.prepare(`CREATE TABLE IF NOT EXISTS album_images (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    album_id INTEGER NOT NULL,
    image_id INTEGER NOT NULL,
    sort_order INTEGER DEFAULT 0,
    added_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(album_id, image_id),
    FOREIGN KEY(album_id) REFERENCES albums(id) ON DELETE CASCADE,
    FOREIGN KEY(image_id) REFERENCES images(id) ON DELETE CASCADE
  )`).run();
}

router.get('/albums', requireAuth, (req, res) => {
  const db = getDb();
  ensureAlbumsTable(db);
  const albums = db.prepare(`
    SELECT a.*, COUNT(ai.image_id) AS image_count
    FROM albums a LEFT JOIN album_images ai ON ai.album_id = a.id
    GROUP BY a.id ORDER BY a.name
  `).all();
  res.json(albums);
});

router.post('/albums', requireAuth, (req, res) => {
  const db = getDb();
  ensureAlbumsTable(db);
  const { name, description = '' } = req.body || {};
  if (!name?.trim()) return res.status(400).json({ detail: 'name required' });
  try {
    const r = db.prepare('INSERT INTO albums(name, description, owner_id) VALUES(?,?,?)')
      .run(name.trim(), description, req.user?.userId || null);
    res.json({ id: r.lastInsertRowid, name: name.trim() });
  } catch (err) { res.status(400).json({ detail: err.message }); }
});

router.put('/albums/:id', requireAuth, (req, res) => {
  const db = getDb();
  ensureAlbumsTable(db);
  const { name, description } = req.body || {};
  db.prepare('UPDATE albums SET name=COALESCE(?,name), description=COALESCE(?,description) WHERE id=?')
    .run(name || null, description ?? null, Number(req.params.id));
  res.json({ ok: true });
});

router.delete('/albums/:id', requireAuth, (req, res) => {
  const db = getDb();
  ensureAlbumsTable(db);
  db.prepare('DELETE FROM albums WHERE id=?').run(Number(req.params.id));
  res.json({ ok: true });
});

router.get('/albums/:id/images', requireAuth, (req, res) => {
  const db = getDb();
  ensureAlbumsTable(db);
  const rows = db.prepare(`
    SELECT i.* FROM images i
    JOIN album_images ai ON ai.image_id = i.id
    WHERE ai.album_id = ?
    ORDER BY ai.sort_order, ai.added_at
  `).all(Number(req.params.id));
  res.json({ images: rows });
});

router.post('/albums/:id/images', requireAuth, (req, res) => {
  const db = getDb();
  ensureAlbumsTable(db);
  const { image_ids = [] } = req.body || {};
  const ins = db.prepare('INSERT OR IGNORE INTO album_images(album_id, image_id) VALUES(?,?)');
  const txn = db.transaction(() => { for (const iid of image_ids) ins.run(Number(req.params.id), iid); });
  txn();
  res.json({ ok: true });
});

router.delete('/albums/:id/images', requireAuth, (req, res) => {
  const db = getDb();
  ensureAlbumsTable(db);
  const { image_ids = [] } = req.body || {};
  const del = db.prepare('DELETE FROM album_images WHERE album_id=? AND image_id=?');
  const txn = db.transaction(() => { for (const iid of image_ids) del.run(Number(req.params.id), iid); });
  txn();
  res.json({ ok: true });
});

// ─────────────────────────────────────────────────────────────────────────────
// WATCH FOLDERS
// ─────────────────────────────────────────────────────────────────────────────

function ensureWatchTable(db) {
  db.prepare(`CREATE TABLE IF NOT EXISTS watch_folders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    path TEXT NOT NULL UNIQUE,
    recursive INTEGER DEFAULT 1,
    auto_scan INTEGER DEFAULT 0,
    scan_interval INTEGER DEFAULT 3600,
    last_scanned TIMESTAMP,
    enabled INTEGER DEFAULT 1,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`).run();
}

router.get('/watchfolders', requireAuth, (req, res) => {
  const db = getDb();
  ensureWatchTable(db);
  res.json(db.prepare('SELECT * FROM watch_folders ORDER BY path').all());
});

router.post('/watchfolders', requireAuth, (req, res) => {
  const db = getDb();
  ensureWatchTable(db);
  const { path: p, recursive = true, auto_scan = false, scan_interval = 3600 } = req.body || {};
  if (!p) return res.status(400).json({ detail: 'path required' });
  try {
    const r = db.prepare('INSERT INTO watch_folders(path, recursive, auto_scan, scan_interval) VALUES(?,?,?,?)')
      .run(p, recursive ? 1 : 0, auto_scan ? 1 : 0, scan_interval);
    res.json({ id: r.lastInsertRowid, path: p });
  } catch (err) { res.status(400).json({ detail: err.message }); }
});

router.put('/watchfolders/:id', requireAuth, (req, res) => {
  const db = getDb();
  const { recursive, auto_scan, scan_interval, enabled } = req.body || {};
  db.prepare('UPDATE watch_folders SET recursive=COALESCE(?,recursive), auto_scan=COALESCE(?,auto_scan), scan_interval=COALESCE(?,scan_interval), enabled=COALESCE(?,enabled) WHERE id=?')
    .run(recursive != null ? (recursive ? 1 : 0) : null,
         auto_scan  != null ? (auto_scan  ? 1 : 0) : null,
         scan_interval ?? null, enabled != null ? (enabled ? 1 : 0) : null,
         Number(req.params.id));
  res.json({ ok: true });
});

router.delete('/watchfolders/:id', requireAuth, (req, res) => {
  const db = getDb();
  ensureWatchTable(db);
  db.prepare('DELETE FROM watch_folders WHERE id=?').run(Number(req.params.id));
  res.json({ ok: true });
});

router.post('/watchfolders/:id/scan', requireAuth, async (req, res) => {
  const db  = getDb();
  ensureWatchTable(db);
  const wf  = db.prepare('SELECT * FROM watch_folders WHERE id=?').get(Number(req.params.id));
  if (!wf)  return res.status(404).json({ detail: 'Not found' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.flushHeaders();

  const send = data => res.write(`data: ${JSON.stringify(data)}\n\n`);

  const { collectImages, processImageIntoDb } = require('../processor');
  const files = collectImages(wf.path, !!wf.recursive);
  send({ type: 'start', total: files.length });

  let done = 0, errors = 0;
  for (const fp of files) {
    try {
      const r = await processImageIntoDb(fp, null, {});
      done++;
      send({ type: 'progress', file: fp, image_id: r.imageId, done, total: files.length });
    } catch (err) {
      errors++;
      send({ type: 'error', file: fp, error: err.message, done, total: files.length });
    }
  }

  db.prepare('UPDATE watch_folders SET last_scanned=CURRENT_TIMESTAMP WHERE id=?').run(wf.id);
  send({ type: 'done', done, errors, total: files.length });
  res.end();
});

// ─────────────────────────────────────────────────────────────────────────────
// FILESYSTEM BROWSER
// ─────────────────────────────────────────────────────────────────────────────

const IMAGE_EXTS = new Set(['.jpg','.jpeg','.png','.webp','.heic','.heif','.gif','.tiff','.tif','.bmp','.avif']);

router.get('/filesystem/browse', requireAuth, (req, res) => {
  const p = req.query.path || '/';
  try {
    const db      = getDb();
    const entries = fs.readdirSync(p, { withFileTypes: true });

    const result = entries.map(e => {
      const entryPath = path.join(p, e.name);
      const isDir     = e.isDirectory();
      const ext       = path.extname(e.name).toLowerCase();
      const isImage   = IMAGE_EXTS.has(ext);

      let extra = {};
      if (!isDir && isImage) {
        const row = db.prepare('SELECT id FROM images WHERE filepath = ?').get(entryPath);
        extra = { in_db: !!row, image_id: row?.id ?? null };
      } else if (isDir) {
        let sub = [];
        try { sub = fs.readdirSync(entryPath, { withFileTypes: true }); } catch {}
        const imgFiles = sub.filter(de => !de.isDirectory() && IMAGE_EXTS.has(path.extname(de.name).toLowerCase()));
        const total_files = imgFiles.length;
        let db_count = 0;
        if (total_files > 0) {
          const fps = imgFiles.map(de => path.join(entryPath, de.name));
          const ph  = fps.map(() => '?').join(',');
          db_count  = db.prepare(`SELECT COUNT(*) AS n FROM images WHERE filepath IN (${ph})`).get(...fps).n;
        }
        extra = { db_count, total_files };
      }
      return { name: e.name, path: entryPath, is_dir: isDir, ...extra };
    }).sort((a, b) => (b.is_dir - a.is_dir) || a.name.localeCompare(b.name));

    res.json({ path: p, entries: result });
  } catch (err) {
    res.status(400).json({ detail: err.message });
  }
});

router.post('/filesystem/add', requireAuth, async (req, res) => {
  const { paths = [], recursive = true, visibility = 'shared' } = req.body || {};

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.flushHeaders();

  const send = data => res.write(`data: ${JSON.stringify(data)}\n\n`);
  const { collectImages, processImageIntoDb } = require('../processor');

  const files = [];
  for (const p of paths) {
    if (fs.existsSync(p)) files.push(...collectImages(p, recursive));
  }
  send({ type: 'start', total: files.length });

  let done = 0, errors = 0;
  for (const fp of files) {
    try {
      const r = await processImageIntoDb(fp, null, { visibility });
      done++;
      send({ type: 'progress', file: fp, image_id: r.imageId, done, total: files.length });
    } catch (err) {
      errors++;
      send({ type: 'error', file: fp, error: err.message, done, total: files.length });
    }
  }

  send({ type: 'done', done, errors, total: files.length });
  res.end();
});

// ─────────────────────────────────────────────────────────────────────────────
// DUPLICATES
// ─────────────────────────────────────────────────────────────────────────────

router.get('/duplicates/stats', requireAuth, (req, res) => {
  const db = getDb();
  try {
    const total      = db.prepare('SELECT COUNT(*) AS n FROM images').get().n;
    const hashMissing = db.prepare('SELECT COUNT(*) AS n FROM images WHERE file_hash IS NULL').get().n;
    res.json({ total, hash_missing: hashMissing, phash_available: false });
  } catch { res.json({ total: 0, hash_missing: 0 }); }
});

router.get('/duplicates/groups', requireAuth, (req, res) => {
  const db     = getDb();
  const method = req.query.method || 'hash';

  if (method === 'hash') {
    const groups = db.prepare(`
      SELECT file_hash, COUNT(*) AS count, GROUP_CONCAT(id) AS ids
      FROM images WHERE file_hash IS NOT NULL
      GROUP BY file_hash HAVING count > 1
    `).all();

    const result = groups.map(g => ({
      key:    g.file_hash,
      count:  g.count,
      images: g.ids.split(',').map(id => {
        const img = db.prepare('SELECT id, filename, filepath, file_size FROM images WHERE id=?').get(Number(id));
        return img;
      }).filter(Boolean),
    }));
    res.json(result);
  } else {
    res.json([]);
  }
});

router.post('/duplicates/resolve', requireAuth, (req, res) => {
  const db = getDb();
  const { keep_id, delete_ids = [], action = 'db_only' } = req.body || {};
  if (!keep_id) return res.status(400).json({ detail: 'keep_id required' });

  for (const did of delete_ids) {
    if (action === 'delete_file') {
      const row = db.prepare('SELECT filepath FROM images WHERE id=?').get(Number(did));
      if (row) try { fs.unlinkSync(row.filepath); } catch {}
    }
    db.prepare('DELETE FROM images WHERE id=?').run(Number(did));
  }
  res.json({ ok: true });
});

router.post('/duplicates/resolve-batch', requireAuth, (req, res) => {
  const db = getDb();
  const { groups = [], action = 'db_only' } = req.body || {};
  let resolved = 0;
  for (const g of groups) {
    const { keep_id, delete_ids = [] } = g;
    for (const did of delete_ids) {
      if (action === 'delete_file') {
        const row = db.prepare('SELECT filepath FROM images WHERE id=?').get(Number(did));
        if (row) try { fs.unlinkSync(row.filepath); } catch {}
      }
      db.prepare('DELETE FROM images WHERE id=?').run(Number(did));
      resolved++;
    }
  }
  res.json({ ok: true, resolved });
});

router.post('/duplicates/scan-hashes', requireAuth, async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.flushHeaders();

  const send = data => res.write(`data: ${JSON.stringify(data)}\n\n`);
  const db   = getDb();
  const rows = db.prepare('SELECT id, filepath FROM images WHERE file_hash IS NULL').all();
  send({ type: 'start', total: rows.length });

  const crypto2 = require('crypto');
  let done = 0;
  for (const row of rows) {
    try {
      const buf  = fs.readFileSync(row.filepath);
      const hash = crypto2.createHash('md5').update(buf).digest('hex');
      db.prepare('UPDATE images SET file_hash=? WHERE id=?').run(hash, row.id);
      done++;
      send({ done, total: rows.length });
    } catch {
      done++;
    }
  }
  send({ type: 'done', done, total: rows.length });
  res.end();
});

router.post('/duplicates/scan-phash', requireAuth, (req, res) => {
  res.json({ available: false, error: 'pHash scanning not yet implemented in Node.js backend' });
});

router.post('/duplicates/cleanup-script', requireAuth, (req, res) => {
  const { files = [], format = 'bash', action = 'trash' } = req.body || {};
  let content = '';
  if (format === 'json') {
    content = JSON.stringify(files, null, 2);
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', 'attachment; filename="crisp_cleanup.json"');
  } else if (format === 'powershell') {
    content = files.map(f => `Remove-Item -Path "${f.origin_path || f.server_path}"`).join('\n');
    res.setHeader('Content-Type', 'text/plain');
    res.setHeader('Content-Disposition', 'attachment; filename="crisp_cleanup.ps1"');
  } else {
    content = '#!/bin/bash\n' + files.map(f => `rm "${f.origin_path || f.server_path}"`).join('\n');
    res.setHeader('Content-Type', 'text/plain');
    res.setHeader('Content-Disposition', 'attachment; filename="crisp_cleanup.sh"');
  }
  res.send(content);
});

// ─────────────────────────────────────────────────────────────────────────────
// BATCH JOBS (minimal working implementation)
// ─────────────────────────────────────────────────────────────────────────────

function ensureBatchTables(db) {
  db.prepare(`CREATE TABLE IF NOT EXISTS batch_jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_id INTEGER,
    name TEXT,
    status TEXT DEFAULT 'pending',
    source_path TEXT,
    recursive INTEGER DEFAULT 1,
    follow_symlinks INTEGER DEFAULT 0,
    visibility TEXT DEFAULT 'shared',
    det_params TEXT,
    tag_ids TEXT,
    new_tag_names TEXT,
    album_id INTEGER,
    new_album_name TEXT,
    total_count INTEGER DEFAULT 0,
    done_count INTEGER DEFAULT 0,
    error_count INTEGER DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    started_at TIMESTAMP,
    completed_at TIMESTAMP
  )`).run();
  db.prepare(`CREATE TABLE IF NOT EXISTS batch_job_files (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id INTEGER NOT NULL,
    filepath TEXT NOT NULL,
    status TEXT DEFAULT 'pending',
    error_msg TEXT,
    image_id INTEGER,
    processed_at TIMESTAMP,
    FOREIGN KEY(job_id) REFERENCES batch_jobs(id) ON DELETE CASCADE
  )`).run();
}

router.get('/batch-jobs', requireAuth, (req, res) => {
  const db = getDb();
  ensureBatchTables(db);
  res.json(db.prepare('SELECT * FROM batch_jobs ORDER BY created_at DESC').all());
});

router.post('/batch-jobs', requireAuth, (req, res) => {
  const db = getDb();
  ensureBatchTables(db);
  const { name, source_path, recursive = true, visibility = 'shared',
          det_params, tag_ids, new_tag_names, album_id, new_album_name } = req.body || {};

  const r = db.prepare(`
    INSERT INTO batch_jobs (owner_id, name, status, source_path, recursive, visibility,
      det_params, tag_ids, new_tag_names, album_id, new_album_name)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    req.user?.userId || null, name || source_path, 'pending',
    source_path, recursive ? 1 : 0, visibility,
    det_params ? JSON.stringify(det_params) : null,
    tag_ids    ? JSON.stringify(tag_ids)    : null,
    new_tag_names ? JSON.stringify(new_tag_names) : null,
    album_id || null, new_album_name || null,
  );
  const jobId = r.lastInsertRowid;

  // Enumerate files
  const { collectImages } = require('../processor');
  if (source_path) {
    const files = collectImages(source_path, !!recursive);
    const ins = db.prepare('INSERT INTO batch_job_files(job_id, filepath) VALUES(?,?)');
    const txn = db.transaction(() => { for (const fp of files) ins.run(jobId, fp); });
    txn();
    db.prepare('UPDATE batch_jobs SET total_count=? WHERE id=?').run(files.length, jobId);
  }

  res.json({ id: jobId, status: 'pending' });
});

router.get('/batch-jobs/:id', requireAuth, (req, res) => {
  const db = getDb();
  ensureBatchTables(db);
  const job = db.prepare('SELECT * FROM batch_jobs WHERE id=?').get(Number(req.params.id));
  if (!job) return res.status(404).json({ detail: 'Not found' });
  res.json(job);
});

router.delete('/batch-jobs/:id', requireAuth, (req, res) => {
  const db = getDb();
  ensureBatchTables(db);
  db.prepare('DELETE FROM batch_jobs WHERE id=?').run(Number(req.params.id));
  res.json({ ok: true });
});

router.post('/batch-jobs/:id/cancel', requireAuth, (req, res) => {
  const db = getDb();
  ensureBatchTables(db);
  db.prepare("UPDATE batch_jobs SET status='cancelled' WHERE id=?").run(Number(req.params.id));
  res.json({ ok: true });
});

router.get('/batch-jobs/:id/logs', requireAuth, (req, res) => {
  const db = getDb();
  ensureBatchTables(db);
  const limit  = Math.min(500, Number(req.query.limit) || 100);
  const offset = Number(req.query.offset) || 0;
  const files  = db.prepare('SELECT * FROM batch_job_files WHERE job_id=? LIMIT ? OFFSET ?')
    .all(Number(req.params.id), limit, offset);
  const total  = db.prepare('SELECT COUNT(*) AS n FROM batch_job_files WHERE job_id=?')
    .get(Number(req.params.id)).n;
  res.json({ files, total });
});

// Track active batch job cancellation
const _batchCancelFlags = new Map();

router.post('/batch-jobs/:id/start', requireAuth, async (req, res) => {
  const db    = getDb();
  ensureBatchTables(db);
  const jobId = Number(req.params.id);
  const job   = db.prepare('SELECT * FROM batch_jobs WHERE id=?').get(jobId);
  if (!job) return res.status(404).json({ detail: 'Not found' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.flushHeaders();

  const send = data => res.write(`data: ${JSON.stringify(data)}\n\n`);

  // Set cancel flag
  let cancelled = false;
  _batchCancelFlags.set(jobId, () => { cancelled = true; });

  db.prepare("UPDATE batch_jobs SET status='running', started_at=CURRENT_TIMESTAMP WHERE id=?").run(jobId);

  const files = db.prepare("SELECT * FROM batch_job_files WHERE job_id=? AND status='pending'").all(jobId);
  const total = db.prepare('SELECT COUNT(*) AS n FROM batch_job_files WHERE job_id=?').get(jobId).n;

  send({ status: 'running', total_count: total, done_count: job.done_count, error_count: job.error_count });

  const { processImageIntoDb } = require('../processor');

  for (const f of files) {
    if (cancelled) break;
    try {
      const r = await processImageIntoDb(f.filepath, null, {
        visibility: job.visibility || 'shared',
      });
      db.prepare("UPDATE batch_job_files SET status='done', image_id=?, processed_at=CURRENT_TIMESTAMP WHERE id=?")
        .run(r.imageId, f.id);
      db.prepare('UPDATE batch_jobs SET done_count=done_count+1 WHERE id=?').run(jobId);
    } catch (err) {
      db.prepare("UPDATE batch_job_files SET status='error', error_msg=? WHERE id=?")
        .run(err.message, f.id);
      db.prepare('UPDATE batch_jobs SET error_count=error_count+1 WHERE id=?').run(jobId);
    }

    const updated = db.prepare('SELECT * FROM batch_jobs WHERE id=?').get(jobId);
    send(updated);
  }

  _batchCancelFlags.delete(jobId);
  const finalStatus = cancelled ? 'paused' : 'completed';
  db.prepare(`UPDATE batch_jobs SET status=?, completed_at=CURRENT_TIMESTAMP WHERE id=?`)
    .run(finalStatus, jobId);
  send({ ...db.prepare('SELECT * FROM batch_jobs WHERE id=?').get(jobId), done: true });
  res.end();
});

// ─────────────────────────────────────────────────────────────────────────────
// API KEYS
// ─────────────────────────────────────────────────────────────────────────────

// All known VLM providers — matches v2 Python backend
const _PROVIDERS = {
  anthropic:   { display_name: 'Anthropic (Claude)',    is_eu: false },
  openai:      { display_name: 'OpenAI (GPT-4 Vision)', is_eu: false },
  groq:        { display_name: 'Groq (fast inference)', is_eu: false },
  openrouter:  { display_name: 'OpenRouter',            is_eu: false },
  mistral:     { display_name: 'Mistral (EU)',          is_eu: true  },
  nebius:      { display_name: 'Nebius (EU)',           is_eu: true  },
  scaleway:    { display_name: 'Scaleway (EU)',         is_eu: true  },
  bfl:         { display_name: 'Black Forest Labs (EU)',is_eu: true  },
  ollama:      { display_name: 'Ollama (local)',        is_eu: true  },
};

// Known models per provider
const _MODELS = {
  anthropic:  ['claude-opus-4-6', 'claude-sonnet-4-6', 'claude-haiku-4-5-20251001'],
  openai:     ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo'],
  groq:       ['meta-llama/llama-4-scout-17b-16e-instruct', 'llama-3.2-11b-vision-preview'],
  openrouter: ['google/gemini-2.0-flash-001', 'anthropic/claude-sonnet-4-6', 'openai/gpt-4o'],
  mistral:    ['pixtral-large-latest', 'pixtral-12b-2409'],
  nebius:     ['Qwen/Qwen2-VL-72B-Instruct', 'Qwen/Qwen2.5-VL-72B-Instruct'],
  scaleway:   ['llama-3.2-11b-vision-instruct', 'pixtral-12b-2409-v2'],
  bfl:        ['flux-kontext-pro', 'flux-pro-1.1', 'flux-dev'],
  ollama:     ['llava', 'llava-llama3', 'llava:13b', 'moondream'],
};

// GET /api-keys/providers — returns flat object keyed by provider id
router.get('/api-keys/providers', requireAuth, (req, res) => {
  res.json(_PROVIDERS);
});

// GET /api-keys/status — per-provider { has_system_key, has_user_key }
// Reads from both v4 api_keys table and v2 provider_api_keys table.
router.get('/api-keys/status', requireAuth, (req, res) => {
  let db; try { db = getDb(); } catch { return res.json({}); }
  const out = {};
  for (const prov of Object.keys(_PROVIDERS))
    out[prov] = { has_system_key: false, has_user_key: false };

  // v4 table
  for (const r of db.prepare('SELECT provider, scope, owner_id FROM api_keys').all()) {
    if (!out[r.provider]) out[r.provider] = { has_system_key: false, has_user_key: false };
    if (r.scope === 'system' && r.owner_id == null) out[r.provider].has_system_key = true;
    if (r.scope === 'user') out[r.provider].has_user_key = true;
  }

  // v2 table (provider_api_keys) — mark keys that exist there too
  try {
    for (const r of db.prepare('SELECT provider, scope FROM provider_api_keys').all()) {
      if (!out[r.provider]) out[r.provider] = { has_system_key: false, has_user_key: false };
      if (r.scope === 'system') out[r.provider].has_system_key = true;
      if (r.scope === 'user')   out[r.provider].has_user_key   = true;
    }
  } catch { /* table may not exist in fresh v4 DBs */ }

  res.json(out);
});

// GET /api-keys/models/:provider
router.get('/api-keys/models/:provider', requireAuth, (req, res) => {
  const models = _MODELS[req.params.provider] || [];
  res.json({ models });
});

// POST /api-keys  { provider, key_value, scope: 'system'|'user' }
router.post('/api-keys', requireAuth, (req, res) => {
  const { provider, key_value, scope = 'system' } = req.body || {};
  if (!provider || !key_value) return res.status(400).json({ detail: 'provider and key_value required' });
  // Only admin can set system keys
  if (scope === 'system' && req.user.role !== 'admin')
    return res.status(403).json({ detail: 'Admin only for system keys' });
  let db; try { db = getDb(); } catch (err) { return res.status(500).json({ detail: err.message }); }
  const ownerId = scope === 'user' ? (req.user.userId ?? null) : null;
  db.prepare(`
    INSERT INTO api_keys(provider, scope, owner_id, key_value)
    VALUES(?, ?, ?, ?)
    ON CONFLICT(provider, scope, owner_id) DO UPDATE SET key_value=excluded.key_value
  `).run(provider, scope, ownerId, key_value);
  res.json({ ok: true });
});

// DELETE /api-keys/:provider?scope=system|user
router.delete('/api-keys/:provider', requireAuth, (req, res) => {
  const scope    = req.query.scope || 'system';
  const provider = req.params.provider;
  if (scope === 'system' && req.user.role !== 'admin')
    return res.status(403).json({ detail: 'Admin only for system keys' });
  let db; try { db = getDb(); } catch (err) { return res.status(500).json({ detail: err.message }); }
  const ownerId = scope === 'user' ? (req.user.userId ?? null) : null;
  db.prepare('DELETE FROM api_keys WHERE provider=? AND scope=? AND owner_id IS ?')
    .run(provider, scope, ownerId);
  res.json({ ok: true });
});

// POST /api-keys/test/:provider — quick connectivity test
router.post('/api-keys/test/:provider', requireAuth, async (req, res) => {
  const provider = req.params.provider;
  let db; try { db = getDb(); } catch { return res.json({ ok: false, error: 'DB unavailable' }); }
  const row = db.prepare(
    'SELECT key_value FROM api_keys WHERE provider=? ORDER BY scope DESC LIMIT 1'
  ).get(provider);
  if (!row) return res.json({ ok: false, error: 'No API key stored for this provider' });
  // Simple ping: just confirm we have a key
  res.json({ ok: true, message: `Key found for ${provider}` });
});

// ─────────────────────────────────────────────────────────────────────────────
// USERS (admin)
// ─────────────────────────────────────────────────────────────────────────────

router.get('/users', requireAdmin, (req, res) => {
  let db; try { db = getDb(); } catch { return res.json([]); }
  try {
    const users = db.prepare('SELECT id, username, role, created_at FROM users ORDER BY username').all();
    res.json(users);
  } catch { res.json([]); }
});

router.post('/users', requireAdmin, (req, res) => {
  res.status(501).json({ detail: 'User creation not yet implemented' });
});

// ─────────────────────────────────────────────────────────────────────────────
// ADMIN (stubs)
// ─────────────────────────────────────────────────────────────────────────────

router.get('/admin/test-json', requireAdmin, (req, res) => {
  res.json({ ok: true });
});

router.post('/admin/update', requireAdmin, (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.flushHeaders();
  res.write(`data: {"line": "Update not available in Node.js backend"}\n\n`);
  res.write(`data: {"done": true}\n\n`);
  res.end();
});

router.get('/admin/logs', requireAdmin, (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.flushHeaders();
  res.write(`data: [PATH]/dev/null\n\n`);
  res.write(`data: [DONE]\n\n`);
  res.end();
});

router.get('/admin/logs-json', requireAdmin, (req, res) => {
  res.json({ lines: [], path: null });
});

// ─────────────────────────────────────────────────────────────────────────────
// CLOUD DRIVES (stubs)
// ─────────────────────────────────────────────────────────────────────────────

router.get('/cloud-drives', requireAuth, (req, res) => res.json([]));

// ─────────────────────────────────────────────────────────────────────────────
// EDITING (stubs)
// ─────────────────────────────────────────────────────────────────────────────

router.get('/edit/formats', requireAuth, (req, res) => {
  res.json({ formats: ['jpeg', 'png', 'webp'] });
});

router.post('/edit/crop', requireAuth, async (req, res) => {
  const sharp = require('sharp');
  const { image_id, x, y, width, height } = req.body || {};
  const db  = getDb();
  const row = db.prepare('SELECT filepath FROM images WHERE id=?').get(Number(image_id));
  if (!row) return res.status(404).json({ detail: 'Not found' });

  try {
    const buf = await sharp(row.filepath).extract({
      left: Math.round(x), top: Math.round(y),
      width: Math.round(width), height: Math.round(height),
    }).toBuffer();
    db.prepare('UPDATE images SET image_blob=? WHERE id=?').run(buf, Number(image_id));
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ detail: err.message });
  }
});

module.exports = router;
