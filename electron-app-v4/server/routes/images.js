'use strict';

const express = require('express');
const fs      = require('fs');
const path    = require('path');
const sharp   = require('sharp');
const { getDb } = require('../db');
const { requireAuth } = require('../auth');

const router = express.Router();

// ── Thumbnail LRU cache (in-process) ─────────────────────────────────────────

const _thumbCache = new Map();  // `${id}_${size}` → { buf, mtime }
const _CACHE_MAX  = 256;

function _cacheSet(key, buf) {
  if (_thumbCache.size >= _CACHE_MAX) {
    const first = _thumbCache.keys().next().value;
    _thumbCache.delete(first);
  }
  _thumbCache.set(key, buf);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function resolveImagePath(filepath) {
  if (!filepath) return null;
  if (fs.existsSync(filepath)) return filepath;
  // Try relative to DB file location
  const dbDir = path.dirname(process.env.DB_PATH || path.join(__dirname, '..', '..', '..', 'face_recognition.db'));
  const rel = path.join(dbDir, filepath);
  if (fs.existsSync(rel)) return rel;
  return null;
}

function rowToApi(row) {
  if (!row) return null;
  const faces = [];
  // faces are joined separately
  return {
    id:           row.id,
    filename:     row.filename,
    filepath:     row.filepath,
    server_path:  row.filepath,
    origin_path:  row.local_path || row.filepath,
    local_path:   row.local_path,
    file_size:    row.file_size,
    width:        row.width,
    height:       row.height,
    format:       row.format,
    taken_at:     row.taken_at,
    created_at:   row.created_at,
    processed_at: row.processed_at,
    face_count:   row.face_count || 0,
    ai_description: row.ai_description,
    ai_scene_type:  row.ai_scene_type,
    ai_tags:        row.ai_tags ? row.ai_tags.split(',').map(t => t.trim()).filter(Boolean) : [],
    rating:       row.rating || 0,
    flag:         row.flag,
    description:  row.description,
    visibility:   row.visibility || 'shared',
    faces,
    people: [],
  };
}

// ── GET /images ───────────────────────────────────────────────────────────────

router.get('/', requireAuth, (req, res) => {
  const db = getDb();
  const {
    person = '', tag = '', scene = '', folder = '', path: pathQ = '',
    date_from = '', date_to = '', sort = 'newest',
    limit = 200, offset = 0, unidentified = 'false', album = 0,
  } = req.query;

  let where = [];
  const params = [];

  if (person) {
    where.push(`i.id IN (
      SELECT DISTINCT f.image_id FROM faces f
      JOIN face_embeddings fe ON fe.face_id = f.id
      JOIN people p ON fe.person_id = p.id
      WHERE LOWER(p.name) LIKE LOWER(?)
    )`);
    params.push(`%${person}%`);
  }
  if (tag) {
    where.push(`i.id IN (
      SELECT it.image_id FROM image_tags it
      JOIN tags t ON it.tag_id = t.id
      WHERE LOWER(t.name) LIKE LOWER(?)
    )`);
    params.push(`%${tag}%`);
  }
  if (scene) {
    where.push('LOWER(i.ai_scene_type) LIKE LOWER(?)');
    params.push(`%${scene}%`);
  }
  if (folder) {
    where.push('(LOWER(i.filepath) LIKE LOWER(?) OR LOWER(i.local_path) LIKE LOWER(?))');
    params.push(`%${folder}%`, `%${folder}%`);
  }
  if (pathQ) {
    where.push('(LOWER(i.filepath) LIKE LOWER(?) OR LOWER(i.filename) LIKE LOWER(?))');
    params.push(`%${pathQ}%`, `%${pathQ}%`);
  }
  if (date_from) { where.push('i.taken_at >= ?'); params.push(date_from); }
  if (date_to)   { where.push('i.taken_at <= ?'); params.push(date_to); }
  if (unidentified === 'true') {
    where.push(`i.id IN (
      SELECT DISTINCT f.image_id FROM faces f
      LEFT JOIN face_embeddings fe ON fe.face_id = f.id AND fe.person_id IS NOT NULL
      WHERE fe.id IS NULL
    )`);
  }
  if (Number(album) > 0) {
    where.push('i.id IN (SELECT image_id FROM album_images WHERE album_id = ?)');
    params.push(Number(album));
  }

  const whereClause = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const orderBy = sort === 'oldest' ? 'i.created_at ASC'
                : sort === 'taken'  ? 'COALESCE(i.taken_at, i.created_at) DESC'
                : sort === 'name'   ? 'i.filename ASC'
                : 'i.created_at DESC';

  const rows = db.prepare(
    `SELECT i.* FROM images i ${whereClause} ORDER BY ${orderBy} LIMIT ? OFFSET ?`
  ).all(...params, Number(limit), Number(offset));

  const total = db.prepare(`SELECT COUNT(*) AS n FROM images i ${whereClause}`).get(...params).n;

  res.json({ images: rows.map(rowToApi), total });
});

// ── GET /images/:id ───────────────────────────────────────────────────────────

router.get('/:id', requireAuth, (req, res) => {
  const db  = getDb();
  const row = db.prepare('SELECT * FROM images WHERE id = ?').get(Number(req.params.id));
  if (!row) return res.status(404).json({ detail: 'Not found' });
  res.json(rowToApi(row));
});

// ── GET /images/:id/faces ─────────────────────────────────────────────────────

router.get('/:id/faces', requireAuth, (req, res) => {
  const db = getDb();
  const faces = db.prepare(`
    SELECT
      f.id, f.image_id,
      f.bbox_top, f.bbox_right, f.bbox_bottom, f.bbox_left,
      f.detection_confidence,
      fe.id AS emb_id, fe.person_id, fe.recognition_confidence, fe.verified,
      p.name AS person_name
    FROM faces f
    LEFT JOIN face_embeddings fe ON fe.face_id = f.id
    LEFT JOIN people p ON fe.person_id = p.id
    WHERE f.image_id = ?
    ORDER BY f.id
  `).all(Number(req.params.id));

  res.json(faces.map(f => ({
    face_id:            f.id,
    id:                 f.id,
    image_id:           f.image_id,
    // v2-compatible bbox object (normalized 0-1)
    bbox: { top: f.bbox_top, right: f.bbox_right, bottom: f.bbox_bottom, left: f.bbox_left },
    bbox_top:           f.bbox_top,
    bbox_right:         f.bbox_right,
    bbox_bottom:        f.bbox_bottom,
    bbox_left:          f.bbox_left,
    detection_confidence: f.detection_confidence,
    embedding_id:       f.emb_id,
    person_id:          f.person_id,
    person_name:        f.person_name,
    recognition_confidence: f.recognition_confidence,
    verified:           !!f.verified,
  })));
});

// ── GET /images/:id/thumbnail ─────────────────────────────────────────────────

router.get('/:id/thumbnail', requireAuth, async (req, res) => {
  const db    = getDb();
  const id    = Number(req.params.id);
  const size  = Math.max(50, Math.min(1000, Number(req.query.size) || 200));
  const cKey  = `${id}_${size}`;

  // In-process cache
  if (_thumbCache.has(cKey)) {
    res.set('Content-Type', 'image/jpeg');
    res.set('Cache-Control', 'public, max-age=3600');
    return res.send(_thumbCache.get(cKey));
  }

  const row = db.prepare('SELECT filepath, thumbnail_blob FROM images WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ detail: 'Not found' });

  try {
    let src;
    if (row.thumbnail_blob) {
      src = Buffer.from(row.thumbnail_blob);
    } else {
      const p = resolveImagePath(row.filepath);
      if (!p) return res.status(404).json({ detail: 'Image file not found' });
      src = p;
    }
    const buf = await sharp(src).rotate().resize(size, size, { fit: 'inside' }).jpeg({ quality: 80 }).toBuffer();
    _cacheSet(cKey, buf);
    res.set('Content-Type', 'image/jpeg');
    res.set('Cache-Control', 'public, max-age=3600');
    res.send(buf);
  } catch (err) {
    res.status(500).json({ detail: err.message });
  }
});

// ── GET /images/:id/full ──────────────────────────────────────────────────────

router.get('/:id/full', requireAuth, (req, res) => {
  const db  = getDb();
  const row = db.prepare('SELECT filepath FROM images WHERE id = ?').get(Number(req.params.id));
  if (!row) return res.status(404).json({ detail: 'Not found' });
  const p = resolveImagePath(row.filepath);
  if (!p) return res.status(404).json({ detail: 'Image file not found' });
  res.sendFile(p);
});

// ── GET /images/:id/preview ───────────────────────────────────────────────────

router.get('/:id/preview', requireAuth, async (req, res) => {
  const db  = getDb();
  const row = db.prepare('SELECT filepath FROM images WHERE id = ?').get(Number(req.params.id));
  if (!row) return res.status(404).json({ detail: 'Not found' });
  const p = resolveImagePath(row.filepath);
  if (!p) return res.status(404).json({ detail: 'Image file not found' });
  try {
    const buf = await sharp(p).rotate().resize(1200, 1200, { fit: 'inside' }).jpeg({ quality: 90 }).toBuffer();
    res.set('Content-Type', 'image/jpeg');
    res.send(buf);
  } catch {
    res.sendFile(p);
  }
});

// ── GET /images/:id/download ──────────────────────────────────────────────────

router.get('/:id/download', requireAuth, (req, res) => {
  const db  = getDb();
  const row = db.prepare('SELECT filepath, filename FROM images WHERE id = ?').get(Number(req.params.id));
  if (!row) return res.status(404).json({ detail: 'Not found' });
  const p = resolveImagePath(row.filepath);
  if (!p) return res.status(404).json({ detail: 'Image file not found' });
  res.setHeader('Content-Disposition', `attachment; filename="${row.filename}"`);
  res.sendFile(p);
});

// ── GET /images/:id/exif ──────────────────────────────────────────────────────

router.get('/:id/exif', requireAuth, (req, res) => {
  const db  = getDb();
  const row = db.prepare(`
    SELECT taken_at, location_lat, location_lng, location_name,
           camera_make, camera_model, iso, aperture, shutter_speed, focal_length
    FROM images WHERE id = ?
  `).get(Number(req.params.id));
  if (!row) return res.status(404).json({ detail: 'Not found' });
  res.json(row);
});

// ── PATCH /images/:id/metadata ────────────────────────────────────────────────

router.patch('/:id/metadata', requireAuth, (req, res) => {
  const db = getDb();
  const { description = '', scene_type = '', tags_csv = '' } = req.body || {};
  const id = Number(req.params.id);

  db.prepare('UPDATE images SET description=?, ai_scene_type=?, updated_at=CURRENT_TIMESTAMP WHERE id=?')
    .run(description || null, scene_type || null, id);

  // Sync tags
  if (tags_csv !== undefined) {
    const tagNames = tags_csv.split(',').map(t => t.trim()).filter(Boolean);
    db.prepare('DELETE FROM image_tags WHERE image_id=?').run(id);
    for (const name of tagNames) {
      db.prepare('INSERT OR IGNORE INTO tags(name) VALUES(?)').run(name);
      const tag = db.prepare('SELECT id FROM tags WHERE name=?').get(name);
      db.prepare('INSERT OR IGNORE INTO image_tags(image_id, tag_id) VALUES(?,?)').run(id, tag.id);
    }
  }

  res.json({ ok: true });
});

// ── DELETE /images/:id ────────────────────────────────────────────────────────

router.delete('/:id', requireAuth, (req, res) => {
  const db = getDb();
  db.prepare('DELETE FROM images WHERE id=?').run(Number(req.params.id));
  res.json({ ok: true });
});

// ── POST /images/:id/re-detect ────────────────────────────────────────────────
// Responds immediately (200) then runs ONNX inference in background.
// The caller should poll GET /images/:id/faces after a short delay.

router.post('/:id/re-detect', requireAuth, (req, res) => {
  const db  = getDb();
  const id  = Number(req.params.id);
  const row = db.prepare('SELECT * FROM images WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ detail: 'Not found' });

  // Check if using remote v2 backend
  try {
    const { loadFlat } = require('../routes/settings');
    const flat = loadFlat();
    if ((flat.processing_backend || 'local') === 'remote_v2') {
      res.json({ ok: true, pending: true, message: 'routed to remote v2' });
      setImmediate(async () => {
        try {
          const { getRemoteClient } = require('../../core/remote-v2-client');
          const client = getRemoteClient(flat);
          await client.reDetect(id, req.body || {});
          console.log(`[re-detect remote] done: image ${id}`);
        } catch (err) {
          console.error(`[re-detect remote] image ${id}:`, err.message);
        }
      });
      return;
    }
  } catch {}

  const p = resolveImagePath(row.filepath);
  if (!p) return res.status(404).json({ detail: 'Image file not found' });

  // Respond immediately — ONNX inference can take several seconds on CPU
  res.json({ ok: true, pending: true, message: 'reprocessing started' });

  // Run processing in background (off the response cycle)
  setImmediate(async () => {
    try {
      const { processImageIntoDb } = require('../processor');
      // Clear old faces so re-detect starts fresh
      db.prepare('DELETE FROM faces WHERE image_id=?').run(id);
      await processImageIntoDb(p, id, { ...(req.body || {}), force: false });
      console.log(`[re-detect] done: image ${id}`);
    } catch (err) {
      console.error(`[re-detect] image ${id}:`, err.message);
    }
  });
});

// ── POST /images/:id/faces/manual ────────────────────────────────────────────
// Add a manual face bbox (no embedding) for user-drawn annotations.

router.post('/:id/faces/manual', requireAuth, (req, res) => {
  const db  = getDb();
  const id  = Number(req.params.id);
  const row = db.prepare('SELECT id FROM images WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ detail: 'Not found' });

  const { bbox } = req.body || {};
  if (!bbox) return res.status(400).json({ detail: 'bbox required' });

  // bbox can be {top,right,bottom,left} or [left,top,right,bottom]
  let top, right, bottom, left;
  if (Array.isArray(bbox)) {
    [left, top, right, bottom] = bbox;
  } else {
    ({ top, right, bottom, left } = bbox);
  }

  const result = db.prepare(`
    INSERT INTO faces (image_id, bbox_top, bbox_right, bbox_bottom, bbox_left, detection_confidence)
    VALUES (?,?,?,?,?,?)
  `).run(id, top, right, bottom, left, 1.0);

  db.prepare('UPDATE images SET face_count = (SELECT COUNT(*) FROM faces WHERE image_id=?) WHERE id=?').run(id, id);

  res.json({
    ok: true,
    face: {
      face_id: result.lastInsertRowid,
      id:      result.lastInsertRowid,
      image_id: id,
      bbox:    { top, right, bottom, left },
      detection_confidence: 1.0,
      person_id: null, person_name: null, verified: false,
    },
  });
});

// ── POST /images/:id/clear-identifications ────────────────────────────────────

router.post('/:id/clear-identifications', requireAuth, (req, res) => {
  const db = getDb();
  const id = Number(req.params.id);
  db.prepare(`
    UPDATE face_embeddings SET person_id=NULL, recognition_confidence=NULL
    WHERE face_id IN (SELECT id FROM faces WHERE image_id=?)
  `).run(id);
  res.json({ ok: true });
});

// ── POST /images/:id/clear-detections ─────────────────────────────────────────

router.post('/:id/clear-detections', requireAuth, (req, res) => {
  const db = getDb();
  db.prepare('DELETE FROM faces WHERE image_id=?').run(Number(req.params.id));
  db.prepare('UPDATE images SET face_count=0 WHERE id=?').run(Number(req.params.id));
  res.json({ ok: true });
});

// ── DELETE /images/:id/faces/:faceId ─────────────────────────────────────────

router.delete('/:id/faces/:faceId', requireAuth, (req, res) => {
  const db = getDb();
  db.prepare('DELETE FROM faces WHERE id=? AND image_id=?')
    .run(Number(req.params.faceId), Number(req.params.id));
  const cnt = db.prepare('SELECT COUNT(*) AS n FROM faces WHERE image_id=?').get(Number(req.params.id)).n;
  db.prepare('UPDATE images SET face_count=? WHERE id=?').run(cnt, Number(req.params.id));
  res.json({ ok: true });
});

// ── PATCH /images/:id/rating ──────────────────────────────────────────────────

router.patch('/:id/rating', requireAuth, (req, res) => {
  const db = getDb();
  db.prepare('UPDATE images SET rating=?, updated_at=CURRENT_TIMESTAMP WHERE id=?')
    .run(Number(req.body.rating) || 0, Number(req.params.id));
  res.json({ ok: true });
});

// ── PATCH /images/:id/flag ────────────────────────────────────────────────────

router.patch('/:id/flag', requireAuth, (req, res) => {
  const db = getDb();
  db.prepare('UPDATE images SET flag=?, updated_at=CURRENT_TIMESTAMP WHERE id=?')
    .run(req.body.flag || null, Number(req.params.id));
  res.json({ ok: true });
});

// ── POST /images/:id/visibility ───────────────────────────────────────────────

router.post('/:id/visibility', requireAuth, (req, res) => {
  const db = getDb();
  const vis = ['shared', 'private'].includes(req.body.visibility) ? req.body.visibility : 'shared';
  db.prepare('UPDATE images SET visibility=? WHERE id=?').run(vis, Number(req.params.id));
  res.json({ ok: true });
});

// ── POST /images/:id/open ─────────────────────────────────────────────────────

router.post('/:id/open', requireAuth, (req, res) => {
  // Only works in desktop mode
  const { exec } = require('child_process');
  const db  = getDb();
  const row = db.prepare('SELECT filepath FROM images WHERE id=?').get(Number(req.params.id));
  if (!row) return res.status(404).json({ detail: 'Not found' });
  const p = resolveImagePath(row.filepath);
  if (!p) return res.status(200).json({ ok: false, headless: true, path: row.filepath });

  const cmd = process.platform === 'darwin' ? `open "${p}"` : `xdg-open "${p}"`;
  exec(cmd);
  res.json({ ok: true });
});

// ── POST /images/:id/open-folder ─────────────────────────────────────────────

router.post('/:id/open-folder', requireAuth, (req, res) => {
  const { exec } = require('child_process');
  const db  = getDb();
  const row = db.prepare('SELECT filepath FROM images WHERE id=?').get(Number(req.params.id));
  if (!row) return res.status(404).json({ detail: 'Not found' });
  const p = resolveImagePath(row.filepath);
  const dir = p ? path.dirname(p) : path.dirname(row.filepath);

  if (process.platform === 'darwin') exec(`open "${dir}"`);
  else exec(`xdg-open "${dir}"`);
  res.json({ ok: true });
});

// ── POST /images/:id/rename ───────────────────────────────────────────────────

router.post('/:id/rename', requireAuth, (req, res) => {
  const db = getDb();
  const id = Number(req.params.id);
  const { new_filename } = req.body || {};
  if (!new_filename) return res.status(400).json({ detail: 'new_filename required' });

  const row = db.prepare('SELECT filepath FROM images WHERE id=?').get(id);
  if (!row) return res.status(404).json({ detail: 'Not found' });

  const dir     = path.dirname(row.filepath);
  const newPath = path.join(dir, new_filename);
  try {
    fs.renameSync(row.filepath, newPath);
    db.prepare('UPDATE images SET filepath=?, filename=? WHERE id=?').run(newPath, new_filename, id);
    res.json({ ok: true, filepath: newPath });
  } catch (err) {
    res.status(500).json({ detail: err.message });
  }
});

module.exports = router;
