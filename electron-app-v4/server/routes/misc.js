'use strict';

/**
 * misc.js — Tags, Albums, Stats, Events, Filesystem, Watch Folders,
 *            Batch Jobs, Duplicates, Scene-types, API-keys stubs.
 */

const express = require('express');
const path    = require('path');
const fs      = require('fs');
const crypto  = require('crypto');
const sharp   = require('sharp');
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
  const images  = db.prepare('SELECT COUNT(*) AS n FROM images').get().n;
  const faces   = db.prepare('SELECT COUNT(*) AS n FROM faces').get().n;
  const people  = db.prepare('SELECT COUNT(*) AS n FROM people').get().n;
  let albums = 0;
  try { albums = db.prepare('SELECT COUNT(*) AS n FROM albums').get().n; } catch {}
  res.json({
    images, faces, people, albums,
    // v2-compatible aliases that StatusBar reads
    total_images: images, total_faces: faces, total_people: people, total_albums: albums,
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
  send({ started: true, total: files.length, all_found: files.length });

  let done = 0, errors = 0;
  for (const fp of files) {
    try {
      const r = await processImageIntoDb(fp, null, {});
      done++;
      send({ index: done, total: files.length, path: fp, image_id: r.imageId,
             result: { faces_detected: r.facesFound } });
    } catch (err) {
      errors++;
      send({ index: done, total: files.length, path: fp, error: err.message });
    }
  }

  db.prepare('UPDATE watch_folders SET last_scanned=CURRENT_TIMESTAMP WHERE id=?').run(wf.id);
  send({ done: true, added: done, errors, total: files.length });
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
  send({ started: true, total: files.length });

  let done = 0, errors = 0;
  for (const fp of files) {
    try {
      const r = await processImageIntoDb(fp, null, { visibility });
      done++;
      send({ index: done, total: files.length, path: fp, image_id: r.imageId,
             result: { faces_detected: r.facesFound } });
    } catch (err) {
      errors++;
      send({ index: done, total: files.length, path: fp, error: err.message });
    }
  }

  send({ done: true, total: files.length, errors });
  res.end();
});

// ─────────────────────────────────────────────────────────────────────────────
// DUPLICATES
// ─────────────────────────────────────────────────────────────────────────────

// ── pHash helpers (difference hash via sharp) ─────────────────────────────────

async function computeDHash(filepath) {
  // Resize to 9×8 grayscale; compare each pixel to its right neighbour → 64-bit hash
  const { data } = await sharp(filepath)
    .resize(9, 8, { fit: 'fill' })
    .grayscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  let bits = 0n;
  for (let row = 0; row < 8; row++) {
    for (let col = 0; col < 8; col++) {
      const i = row * 9 + col;
      bits = (bits << 1n) | (data[i] > data[i + 1] ? 1n : 0n);
    }
  }
  return bits.toString(16).padStart(16, '0');
}

function hammingDistance(h1, h2) {
  let xor = BigInt('0x' + h1) ^ BigInt('0x' + h2);
  let d = 0;
  while (xor > 0n) { d += Number(xor & 1n); xor >>= 1n; }
  return d;
}

// ── Helper: full image row for duplicate groups ───────────────────────────────

function dupImageRow(db, id) {
  return db.prepare(
    'SELECT id, filename, filepath, local_path, file_size, face_count, created_at, taken_at FROM images WHERE id=?'
  ).get(Number(id));
}

// ── Helper: cascade-delete an image and optionally merge its faces ─────────────

function deleteImageCascade(db, keepId, deleteId, action, mergeFaces) {
  if (mergeFaces && keepId) {
    // Reassign faces from deleted image to the kept one before deleting
    db.prepare('UPDATE faces SET image_id=? WHERE image_id=?').run(Number(keepId), Number(deleteId));
  } else {
    db.prepare('DELETE FROM face_embeddings WHERE face_id IN (SELECT id FROM faces WHERE image_id=?)').run(Number(deleteId));
    db.prepare('DELETE FROM faces WHERE image_id=?').run(Number(deleteId));
  }
  db.prepare('DELETE FROM image_tags WHERE image_id=?').run(Number(deleteId));
  try { db.prepare('DELETE FROM album_images WHERE image_id=?').run(Number(deleteId)); } catch {}
  if (action === 'delete_file') {
    const row = db.prepare('SELECT filepath FROM images WHERE id=?').get(Number(deleteId));
    if (row?.filepath) try { fs.unlinkSync(row.filepath); } catch {}
  }
  db.prepare('DELETE FROM images WHERE id=?').run(Number(deleteId));
  // Update face_count of kept image after potential face merge
  if (keepId && mergeFaces) {
    const fc = db.prepare('SELECT COUNT(*) AS n FROM faces WHERE image_id=?').get(Number(keepId))?.n ?? 0;
    db.prepare('UPDATE images SET face_count=? WHERE id=?').run(fc, Number(keepId));
  }
}

// ── Stats ─────────────────────────────────────────────────────────────────────

router.get('/duplicates/stats', requireAuth, (req, res) => {
  const db = getDb();
  try {
    const total       = db.prepare('SELECT COUNT(*) AS n FROM images').get().n;
    const hashMissing = db.prepare('SELECT COUNT(*) AS n FROM images WHERE file_hash IS NULL').get().n;

    const hashGroups = db.prepare(`
      SELECT COUNT(*) AS n FROM (
        SELECT file_hash FROM images WHERE file_hash IS NOT NULL
        GROUP BY file_hash HAVING COUNT(*) > 1
      )
    `).get().n;

    const nameSizeGroups = db.prepare(`
      SELECT COUNT(*) AS n FROM (
        SELECT filename, file_size FROM images
        WHERE filename IS NOT NULL AND file_size IS NOT NULL
        GROUP BY filename, file_size HAVING COUNT(*) > 1
      )
    `).get().n;

    // Wasted bytes: all duplicate rows except the one we'd keep (lowest id per group)
    const wasted = db.prepare(`
      SELECT COALESCE(SUM(i.file_size), 0) AS total
      FROM images i
      INNER JOIN (
        SELECT file_hash, MIN(id) AS keep_id
        FROM images WHERE file_hash IS NOT NULL
        GROUP BY file_hash HAVING COUNT(*) > 1
      ) grp ON i.file_hash = grp.file_hash AND i.id != grp.keep_id
    `).get().total || 0;

    // pHash availability
    const hasPHash = db.pragma('table_info(images)').some(c => c.name === 'phash');
    const phashMissing = hasPHash
      ? db.prepare('SELECT COUNT(*) AS n FROM images WHERE phash IS NULL').get().n
      : total;

    res.json({
      total,
      hash_missing:      hashMissing,
      hash_groups:       hashGroups,
      name_size_groups:  nameSizeGroups,
      visual_groups:     0,          // computed lazily when groups endpoint is called
      visual_available:  hasPHash,
      phash_available:   hasPHash,
      phash_missing:     phashMissing,
      wasted_bytes:      wasted,
    });
  } catch (e) {
    console.error('[duplicates/stats]', e);
    res.json({ total: 0, hash_missing: 0, hash_groups: 0, name_size_groups: 0,
               visual_groups: 0, visual_available: false, phash_available: false,
               phash_missing: 0, wasted_bytes: 0 });
  }
});

// ── Groups ────────────────────────────────────────────────────────────────────

router.get('/duplicates/groups', requireAuth, (req, res) => {
  const db        = getDb();
  const method    = req.query.method || 'hash';
  const threshold = parseInt(req.query.threshold ?? '8', 10);

  if (method === 'name_size') {
    const groups = db.prepare(`
      SELECT filename, file_size, COUNT(*) AS count, GROUP_CONCAT(id) AS ids
      FROM images WHERE filename IS NOT NULL AND file_size IS NOT NULL
      GROUP BY filename, file_size HAVING count > 1
    `).all();
    return res.json(groups.map(g => ({
      key:    `${g.filename}::${g.file_size}`,
      count:  g.count,
      method: 'name_size',
      images: g.ids.split(',').map(id => dupImageRow(db, id)).filter(Boolean),
    })));
  }

  if (method === 'visual') {
    const hasPHash = db.pragma('table_info(images)').some(c => c.name === 'phash');
    if (!hasPHash) return res.json([]);
    const rows = db.prepare(
      'SELECT id, filename, filepath, local_path, file_size, face_count, created_at, taken_at, phash FROM images WHERE phash IS NOT NULL'
    ).all();
    // O(n²) cluster — acceptable for typical library sizes (<50 k images)
    const assigned = new Set();
    const result   = [];
    for (let i = 0; i < rows.length; i++) {
      if (assigned.has(i)) continue;
      const group = [i];
      for (let j = i + 1; j < rows.length; j++) {
        if (!assigned.has(j) && hammingDistance(rows[i].phash, rows[j].phash) <= threshold) {
          group.push(j);
          assigned.add(j);
        }
      }
      if (group.length > 1) {
        assigned.add(i);
        result.push({
          key:    rows[i].phash,
          count:  group.length,
          method: 'visual',
          images: group.map(idx => {
            const { phash: _, ...rest } = rows[idx];
            return rest;
          }),
        });
      }
    }
    return res.json(result);
  }

  // Default: hash
  const groups = db.prepare(`
    SELECT file_hash, COUNT(*) AS count, GROUP_CONCAT(id) AS ids
    FROM images WHERE file_hash IS NOT NULL
    GROUP BY file_hash HAVING count > 1
  `).all();
  res.json(groups.map(g => ({
    key:    g.file_hash,
    count:  g.count,
    method: 'hash',
    images: g.ids.split(',').map(id => dupImageRow(db, id)).filter(Boolean),
  })));
});

// ── Resolve ───────────────────────────────────────────────────────────────────

router.post('/duplicates/resolve', requireAuth, (req, res) => {
  const db = getDb();
  const { keep_id, delete_ids = [], action = 'db_only', merge_faces = true } = req.body || {};
  if (!keep_id) return res.status(400).json({ detail: 'keep_id required' });

  const tx = db.transaction(() => {
    for (const did of delete_ids) {
      deleteImageCascade(db, keep_id, did, action, merge_faces);
    }
  });
  tx();
  res.json({ ok: true, deleted_ids: delete_ids, merged_count: merge_faces ? delete_ids.length : 0 });
});

router.post('/duplicates/resolve-batch', requireAuth, (req, res) => {
  const db = getDb();
  const { groups = [], action = 'db_only', merge_faces = true } = req.body || {};
  let resolved = 0;
  const tx = db.transaction(() => {
    for (const g of groups) {
      const { keep_id, delete_ids = [] } = g;
      for (const did of delete_ids) {
        deleteImageCascade(db, keep_id, did, action, merge_faces);
        resolved++;
      }
    }
  });
  tx();
  res.json({ ok: true, resolved, total_resolved: resolved });
});

// ── Scan hashes (SHA-256) ─────────────────────────────────────────────────────

router.post('/duplicates/scan-hashes', requireAuth, async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.flushHeaders();

  const send = data => res.write(`data: ${JSON.stringify(data)}\n\n`);
  const db   = getDb();
  const rows = db.prepare('SELECT id, filepath FROM images WHERE file_hash IS NULL').all();
  send({ started: true, total: rows.length });

  let done = 0;
  for (const row of rows) {
    try {
      const buf  = fs.readFileSync(row.filepath);
      const hash = require('crypto').createHash('sha256').update(buf).digest('hex');
      db.prepare('UPDATE images SET file_hash=? WHERE id=?').run(hash, row.id);
    } catch {}
    done++;
    send({ index: done, total: rows.length });
  }
  send({ done: true, total: rows.length });
  res.end();
});

// ── Scan pHash (dHash via sharp) ──────────────────────────────────────────────

router.post('/duplicates/scan-phash', requireAuth, async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.flushHeaders();

  const send = data => res.write(`data: ${JSON.stringify(data)}\n\n`);
  const db   = getDb();

  // Ensure phash column exists
  const hasPHash = db.pragma('table_info(images)').some(c => c.name === 'phash');
  if (!hasPHash) {
    try { db.prepare('ALTER TABLE images ADD COLUMN phash TEXT').run(); } catch {}
  }

  const rows = db.prepare('SELECT id, filepath FROM images WHERE phash IS NULL').all();
  send({ available: true, started: true, total: rows.length });

  let done = 0;
  for (const row of rows) {
    try {
      const h = await computeDHash(row.filepath);
      db.prepare('UPDATE images SET phash=? WHERE id=?').run(h, row.id);
    } catch {}
    done++;
    send({ index: done, total: rows.length });
  }
  send({ done: true, total: rows.length });
  res.end();
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
  // Accept 'folder' as alias for 'source_path' (ProcessView sends 'folder')
  const { name, source_path: _sp, folder, recursive = true, visibility = 'shared',
          det_params, tag_ids, new_tag_names, album_id, new_album_name } = req.body || {};
  const source_path = _sp || folder || null;

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

  // Enumerate files from folder
  const { collectImages } = require('../processor');
  if (source_path) {
    const files = collectImages(source_path, !!recursive);
    const ins = db.prepare('INSERT INTO batch_job_files(job_id, filepath) VALUES(?,?)');
    const txn = db.transaction(() => { for (const fp of files) ins.run(jobId, fp); });
    txn();
    db.prepare('UPDATE batch_jobs SET total_count=? WHERE id=?').run(files.length, jobId);
  }

  res.json({ id: jobId, job_id: jobId, status: 'pending' });
});

// POST /batch-jobs/upload-file — stage a file for later batch processing
// Returns { server_path } pointing to the saved file in the upload dir.
router.post('/batch-jobs/upload-file', requireAuth, (() => {
  const multer = require('multer');
  const STAGE_DIR = process.env.UPLOAD_DIR ||
    path.join(__dirname, '..', '..', '..', 'data', 'uploads');
  fs.mkdirSync(STAGE_DIR, { recursive: true });
  const storage = multer.diskStorage({
    destination: STAGE_DIR,
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname) || '.jpg';
      cb(null, `${crypto.randomUUID()}${ext}`);
    },
  });
  const upload = multer({ storage, limits: { fileSize: 200 * 1024 * 1024 } });
  return [upload.single('file'), (req, res) => {
    if (!req.file) return res.status(400).json({ detail: 'file required' });
    res.json({ server_path: req.file.path, ok: true });
  }];
})());

// POST /batch-jobs/:id/add-file — add an already-staged file to a batch job
router.post('/batch-jobs/:id/add-file', requireAuth, (req, res) => {
  const db = getDb();
  ensureBatchTables(db);
  const jobId = Number(req.params.id);
  const job   = db.prepare('SELECT id FROM batch_jobs WHERE id=?').get(jobId);
  if (!job) return res.status(404).json({ detail: 'Job not found' });
  const { filepath, local_path } = req.body || {};
  if (!filepath) return res.status(400).json({ detail: 'filepath required' });
  db.prepare('INSERT INTO batch_job_files(job_id, filepath) VALUES(?,?)').run(jobId, filepath);
  db.prepare('UPDATE batch_jobs SET total_count=total_count+1 WHERE id=?').run(jobId);
  res.json({ ok: true });
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

  const det_params = (() => { try { return job.det_params ? JSON.parse(job.det_params) : {}; } catch { return {}; } })();

  for (const f of files) {
    if (cancelled) break;
    try {
      const r = await processImageIntoDb(f.filepath, null, {
        visibility: job.visibility || 'shared',
        ...det_params,   // det_model, det_thresh, rec_thresh, min_face_size, max_size, skip_faces, skip_vlm
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
  google:      { display_name: 'Google Gemini',         is_eu: false },
};

// Known models per provider
const _MODELS = {
  anthropic:  ['claude-3-5-sonnet-20241022', 'claude-3-haiku-20240307', 'claude-opus-4-6'],
  openai:     ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo'],
  groq:       ['meta-llama/llama-4-scout-17b-16e-instruct', 'llama-3.2-11b-vision-preview'],
  openrouter: ['anthropic/claude-3.5-sonnet', 'google/gemini-2.0-flash-001', 'openai/gpt-4o'],
  mistral:    ['pixtral-large-latest', 'pixtral-12b-2409'],
  nebius:     ['Qwen/Qwen2-VL-72B-Instruct', 'Qwen/Qwen2.5-VL-72B-Instruct'],
  scaleway:   ['llama-3.2-11b-vision-instruct', 'pixtral-12b-2409-v2'],
  bfl:        ['flux-kontext-pro', 'flux-pro-1.1', 'flux-dev'],
  ollama:     ['llava', 'llava-llama3', 'llava:13b', 'moondream'],
  google:     ['gemini-1.5-flash', 'gemini-1.5-pro'],
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
// EDITING
// ─────────────────────────────────────────────────────────────────────────────

// Resolve a DB filepath to an actual path on disk
function resolveImgPath(filepath) {
  if (!filepath) return null;
  if (fs.existsSync(filepath)) return filepath;
  const dbDir = path.dirname(process.env.DB_PATH || path.join(__dirname, '..', '..', '..', 'face_recognition.db'));
  const rel = path.join(dbDir, filepath);
  if (fs.existsSync(rel)) return rel;
  return null;
}

router.get('/edit/formats', requireAuth, (req, res) => {
  res.json({ formats: ['jpeg', 'png', 'webp'] });
});

router.post('/edit/crop', requireAuth, async (req, res) => {
  const { image_id, x, y, width, height, save_as = 'replace' } = req.body || {};
  const db  = getDb();
  const row = db.prepare('SELECT * FROM images WHERE id=?').get(Number(image_id));
  if (!row) return res.status(404).json({ detail: 'Not found' });

  const src = resolveImgPath(row.filepath);
  if (!src) return res.status(404).json({ detail: 'Image file not found' });

  const cw = Math.max(1, Math.round(width));
  const ch = Math.max(1, Math.round(height));
  const cx = Math.max(0, Math.round(x));
  const cy = Math.max(0, Math.round(y));

  try {
    const meta = await sharp(src).metadata();
    const safeW = Math.min(cw, (meta.width  || 9999) - cx);
    const safeH = Math.min(ch, (meta.height || 9999) - cy);
    if (safeW < 1 || safeH < 1) return res.status(400).json({ detail: 'Crop area out of bounds' });

    const buf = await sharp(src).rotate().extract({ left: cx, top: cy, width: safeW, height: safeH }).toBuffer();

    if (save_as === 'replace') {
      await sharp(buf).toFile(src);
      db.prepare('UPDATE images SET width=?,height=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(safeW, safeH, Number(image_id));
      res.json({ ok: true, image_id: Number(image_id), width: safeW, height: safeH });
    } else {
      // new_file: save alongside original with a unique filename
      const ext  = path.extname(src);
      const base = src.slice(0, -ext.length);
      let dest = `${base}_crop${ext}`;
      let n = 1;
      while (fs.existsSync(dest) || db.prepare('SELECT 1 FROM images WHERE filepath=?').get(dest)) {
        dest = `${base}_crop${n++}${ext}`;
      }
      await sharp(buf).toFile(dest);
      const fname = path.basename(dest);
      const ins = db.prepare(`INSERT INTO images (filepath,filename,file_size,width,height,format,local_path,visibility)
        VALUES (?,?,?,?,?,?,?,?)`);
      const fsize = fs.statSync(dest).size;
      const r = ins.run(dest, fname, fsize, safeW, safeH, row.format || 'jpeg', dest, row.visibility || 'shared');
      res.json({ ok: true, image_id: r.lastInsertRowid, width: safeW, height: safeH });
    }
  } catch (err) {
    res.status(500).json({ detail: err.message });
  }
});

// ── POST /edit/rotate ─────────────────────────────────────────────────────────

router.patch('/images/:id/rotate', requireAuth, async (req, res) => {
  const db  = getDb();
  const id  = Number(req.params.id);
  const { direction = 'cw90' } = req.body || {};
  const row = db.prepare('SELECT * FROM images WHERE id=?').get(id);
  if (!row) return res.status(404).json({ detail: 'Not found' });

  const src = resolveImgPath(row.filepath);
  if (!src) return res.status(404).json({ detail: 'Image file not found' });

  try {
    const rotMap = { cw90: 90, ccw90: 270, '180': 180, flip_h: 0, flip_v: 0 };
    const deg = rotMap[direction] ?? 0;
    let pipeline = sharp(src).rotate();  // auto EXIF first

    if (direction === 'flip_h') pipeline = pipeline.flop();
    else if (direction === 'flip_v') pipeline = pipeline.flip();
    else pipeline = pipeline.rotate(deg);

    const buf  = await pipeline.toBuffer();
    const meta = await sharp(buf).metadata();
    await sharp(buf).toFile(src);
    db.prepare('UPDATE images SET width=?,height=?,updated_at=CURRENT_TIMESTAMP WHERE id=?')
      .run(meta.width, meta.height, id);
    res.json({ ok: true, width: meta.width, height: meta.height });
  } catch (err) {
    res.status(500).json({ detail: err.message });
  }
});

// ── POST /edit/adjust ─────────────────────────────────────────────────────────

router.post('/edit/adjust', requireAuth, async (req, res) => {
  const db = getDb();
  const {
    image_id, brightness = 1, contrast = 1, saturation = 1, sharpness = 1,
    warmth = 0, save_as = 'replace', suffix = '_adjusted',
    black_in = 0, white_in = 255, gamma_mid = 1, black_out = 0, white_out = 255,
  } = req.body || {};

  const row = db.prepare('SELECT * FROM images WHERE id=?').get(Number(image_id));
  if (!row) return res.status(404).json({ detail: 'Not found' });
  const src = resolveImgPath(row.filepath);
  if (!src) return res.status(404).json({ detail: 'Image file not found' });

  try {
    let pipeline = sharp(src).rotate();

    // Levels: map [black_in..white_in] → [black_out..white_out]
    if (black_in !== 0 || white_in !== 255 || black_out !== 0 || white_out !== 255) {
      const inScale  = 255 / Math.max(1, white_in  - black_in);
      const outScale = (white_out - black_out) / 255;
      // Normalize → gamma → scale output
      pipeline = pipeline.linear(inScale * outScale, -(black_in * inScale * outScale) + black_out);
    }

    // Brightness / contrast via linear: pixel * a + b
    if (brightness !== 1 || contrast !== 1) {
      const a = contrast * brightness;
      const b = 127 * (1 - contrast);
      pipeline = pipeline.linear(a, b);
    }

    // Saturation via modulate
    if (saturation !== 1 || warmth !== 0) {
      pipeline = pipeline.modulate({ saturation });
      if (warmth !== 0) {
        // warmth: tint R up / B down (or vice versa)
        const wFactor = 1 + Math.abs(warmth) * 0.3;
        if (warmth > 0) pipeline = pipeline.tint({ r: 255, g: 220, b: 180 });
        else            pipeline = pipeline.tint({ r: 180, g: 220, b: 255 });
      }
    }

    if (sharpness !== 1 && sharpness > 1) {
      pipeline = pipeline.sharpen({ sigma: (sharpness - 1) * 2 });
    }

    const buf = await pipeline.toBuffer();

    if (save_as === 'replace') {
      await sharp(buf).toFile(src);
      res.json({ ok: true, image_id: Number(image_id) });
    } else {
      const ext  = path.extname(src);
      const base = src.slice(0, -ext.length);
      const dest = `${base}${suffix || '_adjusted'}${ext}`;
      await sharp(buf).toFile(dest);
      const fname = path.basename(dest);
      const fsize = fs.statSync(dest).size;
      const meta  = await sharp(dest).metadata();
      const r = db.prepare(`INSERT OR IGNORE INTO images (filepath,filename,file_size,width,height,format,local_path,visibility)
        VALUES (?,?,?,?,?,?,?,?)`).run(dest, fname, fsize, meta.width, meta.height, row.format||'jpeg', dest, row.visibility||'shared');
      res.json({ ok: true, image_id: r.lastInsertRowid || Number(image_id) });
    }
  } catch (err) {
    res.status(500).json({ detail: err.message });
  }
});

module.exports = router;
