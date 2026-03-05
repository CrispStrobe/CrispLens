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
const { getRemoteClient }          = require('../core/remote-v2-client');

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
  const detOpts = {
    det_model:     opts.det_model             || 'auto',
    det_thresh:    parseFloat(opts.det_thresh) || 0.5,
    min_face_size: parseInt(opts.min_face_size)|| 0,
    max_size:      parseInt(opts.max_size)     || 0,
    visibility:    opts.visibility             || 'shared',
  };

  // ── Remote v2 routing ──────────────────────────────────────────────────────
  try {
    const { loadFlat } = require('./routes/settings');
    const flat = loadFlat();
    const backend = flat.processing_backend || 'local';
    if (backend === 'remote_v2' || backend === 'remote_v4') {
      const client = getRemoteClient(flat);
      const mode   = flat.remote_v2_mode || 'upload_bytes';
      if (mode === 'local_infer') {
        // Run ONNX detection+embedding here; send only 512D vectors to remote DB
        const engine   = await getEngine();
        const faceData = await engine.extractFaceData(imagePath, detOpts);
        console.log(`[processor/${backend}/local_infer] ${path.basename(imagePath)}: ${faceData.faces.length} face(s) → POST import-processed`);
        return await client.importProcessed(faceData);
      }
      // upload_bytes: send full image to remote server for inference
      return await client.processFilepath(imagePath, opts);
    }
  } catch (err) {
    if (err.message && err.message.includes('remote_v')) throw err; // propagate config errors
    // If settings module not loaded yet, fall through to local
    console.warn('[processor] Remote backend check failed, using local:', err.message);
  }
  // ── Local processing ───────────────────────────────────────────────────────
  const db      = getDb();
  const engine  = await getEngine();

  const meta    = await readImageMeta(imagePath);
  const imageId = existingImageId || upsertImage(db, imagePath, meta, opts);

  // Clear old faces if force re-detect
  if (opts.force) {
    db.prepare('DELETE FROM faces WHERE image_id=?').run(imageId);
  }

  const t0 = Date.now();
  const faces = await engine.processImage(imagePath, detOpts);
  const elapsed = Date.now() - t0;
  console.log(`[processor] ${path.basename(imagePath)}: ${faces.length} face(s) in ${elapsed}ms  (${meta.width}×${meta.height}) det_model=${detOpts.det_model}`);

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

  // ── VLM Enrichment ─────────────────────────────────────────────────────────
  console.log(`[processor] VLM check for image ${imageId}: skip_vlm=${!!opts.skip_vlm}`);
  if (!opts.skip_vlm) {
    try {
      const { loadFlat } = require('./routes/settings');
      const flat = loadFlat();
      console.log(`[processor] VLM config: enabled=${flat.vlm_enabled}, provider=${flat.vlm_provider}`);
      
      if (flat.vlm_enabled && flat.vlm_provider) {
        console.log(`[processor] Starting VLM enrichment for image ${imageId} (${flat.vlm_provider})...`);
        const { vlmClient } = require('../core/vlm-providers');

        // Load keys from v4 api_keys table (plaintext)
        const keyRows = db.prepare('SELECT provider, key_value FROM api_keys ORDER BY scope DESC').all();
        const keys = {};
        for (const r of keyRows) keys[r.provider] = r.key_value;

        // Warn clearly if the key for the configured provider is missing
        if (!keys[flat.vlm_provider]) {
          console.warn(`[processor] VLM key for '${flat.vlm_provider}' not found in api_keys table. ` +
            `If you migrated from the Python backend, please re-enter the API key in Settings → API Keys.`);
        }

        vlmClient.setKeys(keys);

        const vlmPrompt = opts.vlm_prompt || 'Describe this image in detail.';
        const vlmResult = await vlmClient.enrichImage(imagePath, flat.vlm_provider, flat.vlm_model, vlmPrompt);
        console.log(`[processor] VLM success for image ${imageId}`);

        db.prepare(`
          UPDATE images SET ai_description=?, ai_scene_type=? WHERE id=?
        `).run(vlmResult.description || null, vlmResult.scene_type || null, imageId);

        // Store tags
        if (vlmResult.tags && vlmResult.tags.length > 0) {
          for (const name of vlmResult.tags) {
            db.prepare('INSERT OR IGNORE INTO tags(name) VALUES(?)').run(name);
            const tag = db.prepare('SELECT id FROM tags WHERE name=?').get(name);
            db.prepare('INSERT OR IGNORE INTO image_tags(image_id, tag_id) VALUES(?,?)').run(imageId, tag.id);
          }
        }
      }
    } catch (vlmErr) {
      console.error(`[processor] VLM enrichment failed for image ${imageId}:`, vlmErr.message, vlmErr.stack);
    }
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
