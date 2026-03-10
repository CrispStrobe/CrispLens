'use strict';

const express = require('express');
const path    = require('path');
const fs      = require('fs');
const { requireAuth } = require('../auth');
const { processImageIntoDb, collectImages, reloadStore } = require('../processor');

const router = express.Router();

// ── SSE helper ────────────────────────────────────────────────────────────────

function sseHeaders(res) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
}

function sseSend(res, data) {
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

// ── POST /process/single ──────────────────────────────────────────────────────

router.post('/single', requireAuth, async (req, res) => {
  const { filepath, force = false, skip_faces = false, skip_vlm = false, rec_thresh = 0.40, det_model = 'auto' } = req.body || {};
  if (!filepath) return res.status(400).json({ detail: 'filepath required' });
  if (!fs.existsSync(filepath)) return res.status(404).json({ detail: 'File not found' });

  try {
    const result = await processImageIntoDb(filepath, null, { force, skip_recognition: skip_faces, skip_vlm, rec_thresh, det_model });
    const db = require('../db').getDb();
    const enriched = db.prepare('SELECT ai_description, ai_scene_type, ai_tags FROM images WHERE id=?').get(result.imageId);
    const tags = enriched?.ai_tags ? enriched.ai_tags.split(',').map(t => t.trim()).filter(Boolean) : [];
    res.json({
      ok: true,
      image_id: result.imageId,
      faces_found: result.facesFound,
      tags,
      vlm: { description: enriched?.ai_description, scene_type: enriched?.ai_scene_type, tags }
    });
  } catch (err) {
    res.status(500).json({ detail: err.message });
  }
});

// ── POST /process/batch — SSE stream ─────────────────────────────────────────

router.post('/batch', requireAuth, async (req, res) => {
  const { folder, recursive = true, force = false, rec_thresh = 0.40, skip_vlm = false,
          det_model = 'auto', det_thresh, min_face_size, max_size } = req.body || {};
  if (!folder) return res.status(400).json({ detail: 'folder required' });
  if (!fs.existsSync(folder)) return res.status(404).json({ detail: 'Folder not found' });

  sseHeaders(res);

  const files = collectImages(folder, recursive);
  sseSend(res, { total: files.length, started: true });

  const db = require('../db').getDb();
  let done = 0, errors = 0;
  for (const fp of files) {
    try {
      const result = await processImageIntoDb(fp, null, { force, rec_thresh, skip_vlm, det_model, det_thresh, min_face_size, max_size });
      const enriched = db.prepare('SELECT ai_description, ai_scene_type, ai_tags FROM images WHERE id=?').get(result.imageId);
      const tags = enriched?.ai_tags ? enriched.ai_tags.split(',').map(t => t.trim()).filter(Boolean) : [];
      done++;
      sseSend(res, {
        index:    done,
        total:    files.length,
        path:     fp,
        image_id: result.imageId,
        result:   {
          faces_detected: result.facesFound,
          people: [],
          scene_type: enriched?.ai_scene_type,
          tags,
          vlm: { description: enriched?.ai_description, scene_type: enriched?.ai_scene_type, tags }
        },
      });
    } catch (err) {
      errors++;
      sseSend(res, { index: done, total: files.length, path: fp, error: err.message });
    }
  }

  sseSend(res, { done: true, total: files.length, errors });
  res.end();
});

// ── POST /process/batch-files — SSE stream (list of file paths) ──────────────

router.post('/batch-files', requireAuth, async (req, res) => {
  const { paths = [], force = false, rec_thresh = 0.40, skip_vlm = false,
          det_model = 'auto', det_thresh, min_face_size, max_size } = req.body || {};
  if (!paths.length) return res.status(400).json({ detail: 'paths required' });

  sseHeaders(res);

  const files = paths.filter(p => fs.existsSync(p));
  sseSend(res, { total: files.length, started: true });

  const db = require('../db').getDb();
  let done = 0, errors = 0;
  for (const fp of files) {
    try {
      const result = await processImageIntoDb(fp, null, { force, rec_thresh, skip_vlm, det_model, det_thresh, min_face_size, max_size });
      const enriched = db.prepare('SELECT ai_description, ai_scene_type, ai_tags FROM images WHERE id=?').get(result.imageId);
      const tags = enriched?.ai_tags ? enriched.ai_tags.split(',').map(t => t.trim()).filter(Boolean) : [];
      done++;
      sseSend(res, {
        index:    done,
        total:    files.length,
        path:     fp,
        image_id: result.imageId,
        result:   {
          faces_detected: result.facesFound,
          people: [],
          scene_type: enriched?.ai_scene_type,
          tags,
          vlm: { description: enriched?.ai_description, scene_type: enriched?.ai_scene_type, tags }
        },
      });
    } catch (err) {
      errors++;
      sseSend(res, { index: done, total: files.length, path: fp, error: err.message });
    }
  }

  sseSend(res, { done: true, total: files.length, errors });
  res.end();
});

// ── POST /process/train — enroll person from image paths ─────────────────────

router.post('/train', requireAuth, async (req, res) => {
  const { person_name, image_paths = [] } = req.body || {};
  if (!person_name?.trim()) return res.status(400).json({ detail: 'person_name required' });
  if (!image_paths.length)  return res.status(400).json({ detail: 'image_paths required' });

  const db = require('../db').getDb();
  db.prepare('INSERT OR IGNORE INTO people(name) VALUES(?)').run(person_name.trim());
  const person = db.prepare('SELECT id FROM people WHERE name=?').get(person_name.trim());

  let enrolled = 0;
  for (const fp of image_paths) {
    if (!fs.existsSync(fp)) continue;
    try {
      const result = await processImageIntoDb(fp, null, { skip_recognition: false, rec_thresh: 0 });
      // Force assign all embeddings to this person
      db.prepare(`
        UPDATE face_embeddings SET person_id=?, recognition_confidence=1.0, verified=1
        WHERE face_id IN (SELECT id FROM faces WHERE image_id=?)
      `).run(person.id, result.imageId);
      enrolled++;
    } catch {}
  }

  const cnt = db.prepare('SELECT COUNT(*) AS n FROM face_embeddings WHERE person_id=?').get(person.id).n;
  db.prepare('UPDATE people SET total_appearances=? WHERE id=?').run(cnt, person.id);

  // Reload recognition store so subsequent processing sees the new embeddings immediately.
  reloadStore();

  res.json({ ok: true, person_id: person.id, enrolled });
});

// ── POST /process/scan-folder ─────────────────────────────────────────────────

router.post('/scan-folder', requireAuth, async (req, res) => {
  const { folder, recursive = true } = req.body || {};
  if (!folder) return res.status(400).json({ detail: 'folder required' });
  if (!fs.existsSync(folder)) return res.status(404).json({ detail: 'Folder not found' });

  const files = collectImages(folder, recursive);
  res.json({ files, count: files.length });
});

module.exports = router;
