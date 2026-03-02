'use strict';

const express = require('express');
const { getDb }       = require('../db');
const { requireAuth }  = require('../auth');
const { VectorStore }  = require('../../core/search');

const router = express.Router();

// Lazy-loaded VectorStore (rebuilt when endpoint is first called or reset)
let _store     = null;
let _storeTime = 0;
const STORE_TTL_MS = 60_000;  // rebuild index if >60s old

function getStore() {
  const now = Date.now();
  if (_store && now - _storeTime < STORE_TTL_MS) return _store;
  if (_store) { try { _store.close(); } catch {} }
  const dbPath = process.env.DB_PATH ||
    require('path').join(__dirname, '..', '..', '..', 'face_recognition.db');
  _store = new VectorStore(dbPath);
  _store.load();
  _storeTime = now;
  return _store;
}

// ── GET /search?q=<name>&limit=50 ────────────────────────────────────────────
// Text search: find images by person name / description / tag / filename.

router.get('/', requireAuth, (req, res) => {
  const db    = getDb();
  const q     = (req.query.q || '').trim();
  const limit = Math.min(200, Number(req.query.limit) || 50);
  if (!q) return res.json([]);

  const pat = `%${q}%`;
  const rows = db.prepare(`
    SELECT DISTINCT i.id, i.filename, i.filepath, i.face_count, i.created_at
    FROM images i
    LEFT JOIN faces f ON f.image_id = i.id
    LEFT JOIN face_embeddings fe ON fe.face_id = f.id
    LEFT JOIN people p ON fe.person_id = p.id
    LEFT JOIN image_tags it ON it.image_id = i.id
    LEFT JOIN tags t ON it.tag_id = t.id
    WHERE LOWER(p.name) LIKE LOWER(?)
       OR LOWER(i.filename) LIKE LOWER(?)
       OR LOWER(i.ai_description) LIKE LOWER(?)
       OR LOWER(i.ai_tags) LIKE LOWER(?)
       OR LOWER(t.name) LIKE LOWER(?)
    ORDER BY i.created_at DESC
    LIMIT ?
  `).all(pat, pat, pat, pat, pat, limit);

  res.json(rows);
});

// ── POST /search/face — vector similarity search ───────────────────────────────
// Body: { embedding: number[] }  (512D L2-normalized ArcFace vector)

router.post('/face', requireAuth, (req, res) => {
  const { embedding, k = 10, threshold = 0.3 } = req.body || {};
  if (!Array.isArray(embedding) || embedding.length !== 512) {
    return res.status(400).json({ detail: 'embedding must be a 512-element float array' });
  }

  const store   = getStore();
  const vec     = new Float32Array(embedding);
  const results = store.search(vec, Number(k))
    .filter(r => r.similarity >= Number(threshold));

  res.json(results);
});

module.exports = router;
