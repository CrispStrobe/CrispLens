'use strict';

/**
 * processor.js — Core face detection + embedding + DB write.
 *
 * Used by /process and /ingest routes.
 */

const path  = require('path');
const fs    = require('fs');
const sharp = require('sharp');
const crypto = require('crypto');

const { FaceEngine, findModelDir } = require('../core/face-engine');
const { VectorStore }              = require('../core/search');
const { getDb }                    = require('./db');

let _engine = null;

async function getEngine() {
  if (_engine && _engine.initialized) return _engine;
  const modelDir = findModelDir();
  if (!modelDir) throw new Error('Models not found. Run: node core/model-downloader.js');
  _engine = new FaceEngine(modelDir);
  await _engine.init();
  return _engine;
}

// ── File hash ─────────────────────────────────────────────────────────────────

function fileHash(p) {
  const h = crypto.createHash('md5');
  h.update(fs.readFileSync(p));
  return h.digest('hex');
}

// ── Image metadata ────────────────────────────────────────────────────────────

async function readImageMeta(p) {
  const meta = await sharp(p).metadata();
  const stat = fs.statSync(p);
  // Use display-space dimensions (swap for EXIF orientations 5-8 which rotate 90°/270°)
  let width  = meta.width  || 0;
  let height = meta.height || 0;
  if (meta.orientation && meta.orientation >= 5) { [width, height] = [height, width]; }
  return {
    width, height,
    format:    meta.format || path.extname(p).slice(1),
    file_size: stat.size,
  };
}

// ── Store or update image in DB ───────────────────────────────────────────────

function upsertImage(db, filepath, meta, opts = {}) {
  const filename   = path.basename(filepath);
  const { width, height, format, file_size } = meta;
  const local_path = opts.local_path || null;
  const owner_id   = opts.owner_id   || null;
  const visibility = opts.visibility || 'shared';

  let hash = null;
  try { hash = fileHash(filepath); } catch {}

  const existing = db.prepare('SELECT id FROM images WHERE filepath=?').get(filepath);
  if (existing) {
    db.prepare(`
      UPDATE images SET width=?, height=?, format=?, file_size=?,
        processed=0, updated_at=CURRENT_TIMESTAMP WHERE id=?
    `).run(width, height, format, file_size, existing.id);
    return existing.id;
  }

  let result;
  try {
    result = db.prepare(`
      INSERT INTO images (filepath, filename, file_hash, file_size, width, height, format,
        local_path, owner_id, visibility)
      VALUES (?,?,?,?,?,?,?,?,?,?)
    `).run(filepath, filename, hash, file_size, width, height, format,
           local_path, owner_id, visibility);
  } catch (err) {
    if (err.message && err.message.includes('UNIQUE constraint failed: images.file_hash')) {
      // Duplicate file content — return existing image id
      const dup = db.prepare('SELECT id FROM images WHERE file_hash=?').get(hash);
      if (dup) return dup.id;
    }
    throw err;
  }
  return result.lastInsertRowid;
}

// ── Process one image and write faces+embeddings to DB ───────────────────────

async function processImageIntoDb(imagePath, existingImageId, opts = {}) {
  const db      = getDb();
  const engine  = await getEngine();

  const meta    = await readImageMeta(imagePath);
  const imageId = existingImageId || upsertImage(db, imagePath, meta, opts);

  // Clear old faces if force re-detect
  if (opts.force) {
    db.prepare('DELETE FROM faces WHERE image_id=?').run(imageId);
  }

  const t0 = Date.now();
  const faces = await engine.processImage(imagePath);
  const elapsed = Date.now() - t0;
  console.log(`[processor] ${path.basename(imagePath)}: ${faces.length} face(s) in ${elapsed}ms  (${meta.width}×${meta.height})`);

  const recThresh = parseFloat(opts.rec_thresh) || 0.40;

  // Load recognition store for person matching
  let store = null;
  if (!opts.skip_recognition) {
    try {
      const dbPath = process.env.DB_PATH ||
        path.join(__dirname, '..', '..', 'face_recognition.db');
      store = new VectorStore(dbPath);
      store.load();
    } catch {}
  }

  let facesStored = 0;

  for (const face of faces) {
    const W = meta.width, H = meta.height;
    const [x1, y1, x2, y2] = face.bbox;

    const faceResult = db.prepare(`
      INSERT INTO faces (image_id, bbox_top, bbox_right, bbox_bottom, bbox_left, detection_confidence)
      VALUES (?,?,?,?,?,?)
    `).run(
      imageId,
      y1 / H, x2 / W, y2 / H, x1 / W,
      face.score,
    );
    const faceId = faceResult.lastInsertRowid;

    // Store embedding
    const embBuf = Buffer.from(face.embedding.buffer,
      face.embedding.byteOffset, face.embedding.byteLength);

    let personId = null, recConf = null;
    if (store && store.vectors.length > 0) {
      const top1 = store.search(face.embedding, 1)[0];
      if (top1 && top1.similarity >= recThresh) {
        personId = top1.personId;
        recConf  = top1.similarity;
      }
    }

    db.prepare(`
      INSERT INTO face_embeddings
        (face_id, person_id, embedding_vector, embedding_dimension, embedding_model,
         recognition_confidence)
      VALUES (?,?,?,?,?,?)
    `).run(faceId, personId, embBuf, 512, 'w600k_r50', recConf);

    if (process.env.DEBUG) {
      console.log(`  face ${faceId}: score=${face.score.toFixed(3)}  bbox=[${[x1,y1,x2,y2].map(v=>Math.round(v)).join(',')}]  person=${personId||'?'}  conf=${recConf?.toFixed(2)||'n/a'}`);
    }
    facesStored++;
  }

  db.prepare(`
    UPDATE images SET face_count=?, processed=1, processed_at=CURRENT_TIMESTAMP WHERE id=?
  `).run(facesStored, imageId);

  if (store) { try { store.close(); } catch {} }

  return { imageId, facesFound: facesStored, meta };
}

// ── Scan a folder for images ──────────────────────────────────────────────────

const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.tiff', '.heic', '.heif', '.avif']);

function collectImages(dirOrFile, recursive = true, followSymlinks = false) {
  const results = [];
  function walk(p) {
    let stat;
    try { stat = followSymlinks ? fs.statSync(p) : fs.lstatSync(p); } catch { return; }
    if (stat.isSymbolicLink()) return;
    if (stat.isFile()) {
      if (IMAGE_EXTS.has(path.extname(p).toLowerCase())) results.push(p);
      return;
    }
    if (!stat.isDirectory()) return;
    let entries;
    try { entries = fs.readdirSync(p); } catch { return; }
    for (const e of entries) {
      const sub = path.join(p, e);
      const sStat = followSymlinks ? fs.statSync(sub) : fs.lstatSync(sub);
      if (sStat.isDirectory() && recursive) walk(sub);
      else if (sStat.isFile() && IMAGE_EXTS.has(path.extname(sub).toLowerCase())) results.push(sub);
    }
  }
  walk(dirOrFile);
  return results;
}

// Pre-warm: load ONNX models into memory so first real request is fast.
async function warmEngine() {
  try {
    await getEngine();
    console.log('[processor] Engine pre-warmed.');
  } catch (err) {
    console.warn('[processor] Engine pre-warm skipped:', err.message);
  }
}

module.exports = { processImageIntoDb, upsertImage, readImageMeta, collectImages, warmEngine };
