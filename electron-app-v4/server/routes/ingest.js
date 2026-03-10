'use strict';

const express = require('express');
const multer  = require('multer');
const path    = require('path');
const fs      = require('fs');
const crypto  = require('crypto');
const { requireAuth } = require('../auth');
const { processImageIntoDb } = require('../processor');
const { getDb } = require('../db');

const router = express.Router();

// ── Upload storage ────────────────────────────────────────────────────────────

const UPLOAD_DIR = process.env.UPLOAD_DIR ||
  path.join(__dirname, '..', '..', '..', 'data', 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: UPLOAD_DIR,
  filename: (req, file, cb) => {
    const ext  = path.extname(file.originalname) || '.jpg';
    const uuid = crypto.randomUUID();
    cb(null, `${uuid}${ext}`);
  },
});
const upload = multer({ storage, limits: { fileSize: 200 * 1024 * 1024 } });

// ── POST /ingest/upload-local ──────────────────────────────────────────────────
// Accepts a multipart file upload + local_path metadata.

router.post('/upload-local', requireAuth, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ detail: 'file required' });

  const local_path    = req.body.local_path    || req.file.originalname;
  const visibility    = req.body.visibility    || 'shared';
  const rec_thresh    = parseFloat(req.body.rec_thresh)    || 0.40;
  const skip_faces    = req.body.skip_faces    === 'true';
  const skip_vlm      = req.body.skip_vlm      === 'true';
  const owner_id      = req.user?.userId || null;
  const det_model     = req.body.det_model     || undefined;
  const det_thresh    = req.body.det_thresh    ? parseFloat(req.body.det_thresh)    : undefined;
  const min_face_size = req.body.min_face_size ? parseInt(req.body.min_face_size)   : undefined;
  const max_size      = req.body.max_size      ? parseInt(req.body.max_size)        : undefined;

  const db = getDb();
  try {
    // ── Duplicate check by file hash ──────────────────────────────────────────
    let uploadedHash = null;
    try {
      const h = crypto.createHash('sha256');
      h.update(fs.readFileSync(req.file.path));
      uploadedHash = h.digest('hex');
    } catch {}

    if (uploadedHash) {
      const dup = db.prepare('SELECT id, owner_id FROM images WHERE file_hash=? LIMIT 1').get(uploadedHash);
      if (dup) {
        // Clean up the redundant upload
        try { fs.unlinkSync(req.file.path); } catch {}
        const sharedDup = (dup.owner_id !== owner_id);
        console.log(`[upload-local] Duplicate hash ${uploadedHash.slice(0, 12)}… → image_id=${dup.id} (shared=${sharedDup})`);
        return res.json({
          ok: true, skipped: true, shared_duplicate: sharedDup,
          image_id: dup.id, face_count: 0, faces_found: 0,
          vlm: { description: null, scene_type: null, tags: [] },
        });
      }
    }

    // Also check by local_path (same source file re-uploaded)
    if (local_path) {
      const dup = db.prepare('SELECT id, owner_id FROM images WHERE local_path=? OR filepath=? LIMIT 1').get(local_path, local_path);
      if (dup) {
        try { fs.unlinkSync(req.file.path); } catch {}
        const sharedDup = (dup.owner_id !== owner_id);
        console.log(`[upload-local] Duplicate local_path ${local_path} → image_id=${dup.id} (shared=${sharedDup})`);
        return res.json({
          ok: true, skipped: true, shared_duplicate: sharedDup,
          image_id: dup.id, face_count: 0, faces_found: 0,
          vlm: { description: null, scene_type: null, tags: [] },
        });
      }
    }
    // ─────────────────────────────────────────────────────────────────────────

    const result = await processImageIntoDb(req.file.path, null, {
      local_path, visibility, rec_thresh,
      skip_recognition: skip_faces,
      skip_vlm,
      owner_id, det_model, det_thresh, min_face_size, max_size,
    });
    const enriched = db.prepare('SELECT ai_description, ai_scene_type, ai_tags FROM images WHERE id=?').get(result.imageId);
    const vlmTags  = enriched?.ai_tags ? enriched.ai_tags.split(',').map(t => t.trim()).filter(Boolean) : [];
    res.json({
      ok: true,
      image_id:    result.imageId,
      face_count:  result.facesFound,
      faces_found: result.facesFound,
      filepath:    req.file.path,
      vlm: { description: enriched?.ai_description || null, scene_type: enriched?.ai_scene_type || null, tags: vlmTags },
    });
  } catch (err) {
    // Clean up uploaded file on failure
    try { fs.unlinkSync(req.file.path); } catch {}
    res.status(500).json({ detail: err.message });
  }
});

// ── POST /ingest/import-processed ─────────────────────────────────────────────
// Mode C: pre-computed embeddings from local Electron node. Stores directly in DB.

router.post('/import-processed', requireAuth, (req, res) => {
  const { filepath, local_path, width, height, format, file_size,
          faces = [], visibility = 'shared',
          description, scene_type, tags = [] } = req.body || {};
  if (!filepath) return res.status(400).json({ detail: 'filepath required' });

  const db       = getDb();
  const filename = path.basename(filepath);
  const owner_id = req.user?.userId || null;

  // Upsert image
  let imageId;
  const existing = db.prepare('SELECT id FROM images WHERE filepath=?').get(filepath);
  if (existing) {
    imageId = existing.id;
    db.prepare(`
      UPDATE images SET 
        width=?, height=?, format=?, file_size=?, local_path=?,
        ai_description = COALESCE(?, ai_description),
        ai_scene_type = COALESCE(?, ai_scene_type),
        updated_at=CURRENT_TIMESTAMP 
      WHERE id=?
    `).run(width, height, format, file_size, local_path, description || null, scene_type || null, imageId);
  } else {
    const r = db.prepare(`
      INSERT INTO images (filepath, filename, file_size, width, height, format, local_path, owner_id, visibility, ai_description, ai_scene_type)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)
    `).run(filepath, filename, file_size, width, height, format, local_path || filepath, owner_id, visibility, description || null, scene_type || null);
    imageId = r.lastInsertRowid;
  }

  // Tags
  if (tags && tags.length > 0) {
    for (const name of tags) {
      db.prepare('INSERT OR IGNORE INTO tags(name) VALUES(?)').run(name);
      const tag = db.prepare('SELECT id FROM tags WHERE name=?').get(name);
      db.prepare('INSERT OR IGNORE INTO image_tags(image_id, tag_id) VALUES(?,?)').run(imageId, tag.id);
    }
  }

  // Load recognition store for person matching
  let store = null;
  try {
    const { VectorStore } = require('../../core/search');
    const dbPath = process.env.DB_PATH ||
      path.join(__dirname, '..', '..', '..', 'face_recognition.db');
    store = new VectorStore(dbPath);
    store.load();
  } catch {}

  // Clear old faces
  db.prepare('DELETE FROM faces WHERE image_id=?').run(imageId);

  let stored = 0;
  for (const face of faces) {
    const faceResult = db.prepare(`
      INSERT INTO faces (image_id, bbox_top, bbox_right, bbox_bottom, bbox_left, detection_confidence)
      VALUES (?,?,?,?,?,?)
    `).run(imageId,
      face.bbox_top || 0, face.bbox_right || 1,
      face.bbox_bottom || 1, face.bbox_left || 0,
      face.score || 0.9);
    const faceId = faceResult.lastInsertRowid;

    if (face.embedding?.length === 512) {
      const embF32 = new Float32Array(face.embedding);
      const embBuf = Buffer.from(embF32.buffer);

      let personId = null, recConf = null;
      if (store && store.vectors.length > 0) {
        const top1 = store.search(embF32, 1)[0];
        if (top1 && top1.similarity >= 0.40) {
          personId = top1.personId;
          recConf  = Math.max(0, Math.min(1, top1.similarity));
        }
      }

      db.prepare(`
        INSERT INTO face_embeddings
          (face_id, person_id, embedding_vector, embedding_dimension, embedding_model, recognition_confidence)
        VALUES (?,?,?,?,?,?)
      `).run(faceId, personId, embBuf, 512, 'w600k_r50', recConf);
      stored++;
    }
  }

  db.prepare('UPDATE images SET face_count=?, processed=1, processed_at=CURRENT_TIMESTAMP WHERE id=?')
    .run(stored, imageId);
  if (store) { try { store.close(); } catch {} }

  res.json({ ok: true, image_id: imageId, faces_stored: stored, face_count: stored });
});

module.exports = router;
