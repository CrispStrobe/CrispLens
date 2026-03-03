'use strict';

const express = require('express');
const { getDb } = require('../db');
const { requireAuth } = require('../auth');

const router = express.Router();

// ── GET /people/embeddings ────────────────────────────────────────────────────
// Returns one representative 512D embedding per known person (base64-encoded).
// Used by clients to build a local search index for offline face recognition.

router.get('/embeddings', requireAuth, (req, res) => {
  const db = getDb();
  // For each person, pick the face with the highest detection_confidence
  const rows = db.prepare(`
    SELECT p.id, p.name, fe.embedding_vector, fe.embedding_dimension
    FROM people p
    JOIN face_embeddings fe ON fe.id = (
      SELECT fe2.id FROM face_embeddings fe2
      JOIN faces f2 ON fe2.face_id = f2.id
      WHERE fe2.person_id = p.id AND f2.image_id != -1
        AND fe2.embedding_vector IS NOT NULL
      ORDER BY f2.detection_confidence DESC
      LIMIT 1
    )
    WHERE fe.embedding_vector IS NOT NULL
    ORDER BY p.name ASC
  `).all();
  res.json(rows.map(r => ({
    id:   r.id,
    name: r.name,
    dim:  r.embedding_dimension ?? 512,
    embedding: Buffer.from(r.embedding_vector).toString('base64'),
  })));
});

// ── GET /people ───────────────────────────────────────────────────────────────

router.get('/', requireAuth, (req, res) => {
  const db = getDb();
  const rows = db.prepare(`
    SELECT p.*,
      COUNT(DISTINCT fe.face_id) AS face_count,
      MAX(i.filepath)            AS sample_image_path,
      MAX(i.id)                  AS sample_image_id
    FROM people p
    LEFT JOIN face_embeddings fe ON fe.person_id = p.id
    LEFT JOIN faces f ON fe.face_id = f.id
    LEFT JOIN images i ON f.image_id = i.id
    GROUP BY p.id
    ORDER BY p.total_appearances DESC, p.name ASC
  `).all();
  res.json(rows);
});

// ── GET /people/:id ───────────────────────────────────────────────────────────

router.get('/:id', requireAuth, (req, res) => {
  const db  = getDb();
  const row = db.prepare('SELECT * FROM people WHERE id = ?').get(Number(req.params.id));
  if (!row) return res.status(404).json({ detail: 'Not found' });

  // Get images this person appears in
  const images = db.prepare(`
    SELECT DISTINCT i.id, i.filename, i.filepath
    FROM images i
    JOIN faces f ON f.image_id = i.id
    JOIN face_embeddings fe ON fe.face_id = f.id
    WHERE fe.person_id = ?
    LIMIT 50
  `).all(Number(req.params.id));

  res.json({ ...row, images });
});

// ── PUT /people/:id (rename) ──────────────────────────────────────────────────

router.put('/:id', requireAuth, (req, res) => {
  const db = getDb();
  const { name } = req.body || {};
  if (!name?.trim()) return res.status(400).json({ detail: 'name required' });

  try {
    db.prepare('UPDATE people SET name=?, updated_at=CURRENT_TIMESTAMP WHERE id=?')
      .run(name.trim(), Number(req.params.id));
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ detail: err.message });
  }
});

// ── DELETE /people/:id ────────────────────────────────────────────────────────

router.delete('/:id', requireAuth, (req, res) => {
  const db = getDb();
  db.prepare('UPDATE face_embeddings SET person_id=NULL WHERE person_id=?').run(Number(req.params.id));
  db.prepare('DELETE FROM people WHERE id=?').run(Number(req.params.id));
  res.json({ ok: true });
});

// ── POST /people/merge ────────────────────────────────────────────────────────

router.post('/merge', requireAuth, (req, res) => {
  const db = getDb();
  const { source_id, target_id } = req.body || {};
  if (!source_id || !target_id) return res.status(400).json({ detail: 'source_id and target_id required' });

  db.prepare('UPDATE face_embeddings SET person_id=? WHERE person_id=?')
    .run(Number(target_id), Number(source_id));
  db.prepare('DELETE FROM people WHERE id=?').run(Number(source_id));
  // Update appearance count
  const cnt = db.prepare('SELECT COUNT(*) AS n FROM face_embeddings WHERE person_id=?').get(Number(target_id)).n;
  db.prepare('UPDATE people SET total_appearances=? WHERE id=?').run(cnt, Number(target_id));
  res.json({ ok: true });
});

// ── POST /people/reassign-face ────────────────────────────────────────────────

router.post('/reassign-face', requireAuth, (req, res) => {
  const db = getDb();
  const { face_id, new_name } = req.body || {};
  if (!face_id || !new_name?.trim()) {
    return res.status(400).json({ detail: 'face_id and new_name required' });
  }

  // Get or create person
  db.prepare('INSERT OR IGNORE INTO people(name) VALUES(?)').run(new_name.trim());
  const person = db.prepare('SELECT id FROM people WHERE name=?').get(new_name.trim());

  db.prepare('UPDATE face_embeddings SET person_id=? WHERE face_id=?')
    .run(person.id, Number(face_id));

  // Update appearance counts
  const cnt = db.prepare('SELECT COUNT(*) AS n FROM face_embeddings WHERE person_id=?').get(person.id).n;
  db.prepare('UPDATE people SET total_appearances=? WHERE id=?').run(cnt, person.id);

  res.json({ ok: true, person_id: person.id });
});

module.exports = router;
