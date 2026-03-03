'use strict';

const express = require('express');
const path    = require('path');
const fs      = require('fs');
const sharp   = require('sharp');
const { getDb }      = require('../db');
const { requireAuth } = require('../auth');

const router = express.Router();

// ── GET /faces/unidentified ───────────────────────────────────────────────────

router.get('/unidentified', requireAuth, (req, res) => {
  const db    = getDb();
  const limit = Math.min(1000, Number(req.query.limit) || 500);

  const rows = db.prepare(`
    SELECT
      f.id AS face_id,
      f.image_id,
      f.bbox_top, f.bbox_right, f.bbox_bottom, f.bbox_left,
      f.detection_confidence,
      i.filepath, i.filename, i.width, i.height
    FROM faces f
    JOIN images i ON f.image_id = i.id
    LEFT JOIN face_embeddings fe ON fe.face_id = f.id AND fe.person_id IS NOT NULL
    WHERE fe.id IS NULL
    ORDER BY f.detection_confidence DESC
    LIMIT ?
  `).all(limit);

  // Add v2-compatible bbox object to each row
  res.json(rows.map(f => ({
    ...f,
    bbox: { top: f.bbox_top, right: f.bbox_right, bottom: f.bbox_bottom, left: f.bbox_left },
  })));
});

// ── GET /faces/clusters ───────────────────────────────────────────────────────

router.get('/clusters', requireAuth, (req, res) => {
  const db        = getDb();
  const threshold = parseFloat(req.query.threshold) || 0.55;
  const limit     = Math.min(1000, Number(req.query.limit) || 500);
  const inclId    = req.query.include_identified === 'true';

  // Load embeddings
  const rows = db.prepare(`
    SELECT
      fe.id AS emb_id, fe.face_id, fe.person_id, fe.embedding_vector, fe.embedding_dimension,
      f.image_id,
      f.bbox_top, f.bbox_right, f.bbox_bottom, f.bbox_left,
      f.detection_confidence,
      i.filepath, i.width, i.height,
      p.name AS person_name
    FROM face_embeddings fe
    JOIN faces f ON fe.face_id = f.id
    JOIN images i ON f.image_id = i.id
    LEFT JOIN people p ON fe.person_id = p.id
    WHERE fe.embedding_vector IS NOT NULL
      ${inclId ? '' : 'AND fe.person_id IS NULL'}
    ORDER BY fe.id
    LIMIT ?
  `).all(limit);

  if (rows.length === 0) return res.json([]);

  // Decode embeddings
  const vecs = rows.map(r => {
    const blob = r.embedding_vector;
    const dim  = r.embedding_dimension;
    if (!blob || blob.length < dim * 4) return null;
    return new Float32Array(blob.buffer, blob.byteOffset, dim);
  });

  // Cosine similarity brute-force clustering (union-find)
  const parent = rows.map((_, i) => i);
  function find(i) { return parent[i] === i ? i : (parent[i] = find(parent[i])); }
  function union(a, b) { parent[find(a)] = find(b); }

  function dot(a, b) {
    let s = 0;
    for (let i = 0; i < a.length; i++) s += a[i] * b[i];
    return s;
  }

  for (let i = 0; i < rows.length; i++) {
    if (!vecs[i]) continue;
    for (let j = i + 1; j < rows.length; j++) {
      if (!vecs[j]) continue;
      if (dot(vecs[i], vecs[j]) >= threshold) union(i, j);
    }
  }

  // Group by root
  const groups = new Map();
  for (let i = 0; i < rows.length; i++) {
    const root = find(i);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push({
      ...rows[i],
      embedding_vector: undefined,
    });
  }

  const result = [...groups.values()]
    .filter(g => g.length >= 1)
    .sort((a, b) => b.length - a.length)
    .slice(0, 200);

  // Return v2-compatible format: [{cluster_id, size, faces:[...]}]
  res.json(result.map((faces, i) => ({
    cluster_id: i,
    size:       faces.length,
    faces:      faces.map(f => ({
      face_id:             f.face_id,
      image_id:            f.image_id,
      bbox:                { top: f.bbox_top, right: f.bbox_right, bottom: f.bbox_bottom, left: f.bbox_left },
      face_quality:        f.face_quality ?? 1.0,
      detection_confidence: f.detection_confidence,
      person_name:         f.person_name || null,
    })),
  })));
});

// ── GET /faces/face-crop ──────────────────────────────────────────────────────

router.get('/face-crop', requireAuth, async (req, res) => {
  const db      = getDb();
  const imageId = Number(req.query.image_id);
  const faceId  = Number(req.query.face_id);
  const size    = Math.min(512, Number(req.query.size) || 128);

  const face = db.prepare(`
    SELECT f.*, i.filepath, i.width, i.height
    FROM faces f JOIN images i ON f.image_id = i.id
    WHERE f.id = ? AND f.image_id = ?
  `).get(faceId, imageId);

  if (!face) return res.status(404).json({ detail: 'Not found' });

  let p = face.filepath;
  if (!fs.existsSync(p)) {
    const dbDir = path.dirname(process.env.DB_PATH || path.join(__dirname, '..', '..', '..', 'face_recognition.db'));
    p = path.join(dbDir, face.filepath);
    if (!fs.existsSync(p)) return res.status(404).json({ detail: 'Image file not found' });
  }

  try {
    const W = face.width || 1, H = face.height || 1;
    const left   = Math.max(0, Math.round(face.bbox_left   * W));
    const top    = Math.max(0, Math.round(face.bbox_top    * H));
    const right  = Math.min(W, Math.round(face.bbox_right  * W));
    const bottom = Math.min(H, Math.round(face.bbox_bottom * H));

    const buf = await sharp(p)
      .rotate()   // apply EXIF rotation so bbox (display-space) aligns with pixels
      .extract({ left, top, width: Math.max(1, right - left), height: Math.max(1, bottom - top) })
      .resize(size, size, { fit: 'cover' })
      .jpeg({ quality: 85 })
      .toBuffer();

    res.set('Content-Type', 'image/jpeg');
    res.set('Cache-Control', 'public, max-age=600');
    res.send(buf);
  } catch (err) {
    res.status(500).json({ detail: err.message });
  }
});

// ── POST /faces/assign-cluster ────────────────────────────────────────────────

router.post('/assign-cluster', requireAuth, (req, res) => {
  const db = getDb();
  const { face_ids, person_name } = req.body || {};
  if (!face_ids?.length || !person_name?.trim()) {
    return res.status(400).json({ detail: 'face_ids and person_name required' });
  }

  db.prepare('INSERT OR IGNORE INTO people(name) VALUES(?)').run(person_name.trim());
  const person = db.prepare('SELECT id FROM people WHERE name=?').get(person_name.trim());

  const assign = db.prepare('UPDATE face_embeddings SET person_id=? WHERE face_id=?');
  const txn    = db.transaction(() => {
    for (const fid of face_ids) assign.run(person.id, Number(fid));
  });
  txn();

  const cnt = db.prepare('SELECT COUNT(*) AS n FROM face_embeddings WHERE person_id=?').get(person.id).n;
  db.prepare('UPDATE people SET total_appearances=? WHERE id=?').run(cnt, person.id);

  res.json({ ok: true, person_id: person.id });
});

module.exports = router;
