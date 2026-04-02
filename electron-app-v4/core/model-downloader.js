'use strict';

/**
 * model-downloader.js
 *
 * Downloads buffalo_l ONNX models if they are not already present.
 * Models are saved to  <project>/models/buffalo_l/
 *
 * Source: InsightFace official GitHub release.
 */

const fs    = require('fs');
const path  = require('path');
const https = require('https');
const AdmZip = require('adm-zip');

// In production Electron builds __dirname is inside the non-writable app bundle.
// Prefer USER_DATA_PATH (set by electron-main.js) or fall back to ~/.crisplens.
const os = require('os');
const _dataDir = process.env.USER_DATA_PATH || path.join(os.homedir(), '.crisplens');
const MODELS_DIR   = process.env.FACE_REC_MODELS_DIR
  ? path.dirname(process.env.FACE_REC_MODELS_DIR)
  : (fs.existsSync(path.join(__dirname, '..', 'models', 'buffalo_l', 'det_10g.onnx'))
      ? path.join(__dirname, '..', 'models')   // dev: models already next to package
      : path.join(_dataDir, 'models'));
const BUFFALO_DIR  = path.join(MODELS_DIR, 'buffalo_l');
const REQUIRED     = ['det_10g.onnx', 'w600k_r50.onnx'];
const BUFFALO_URL  = 'https://github.com/deepinsight/insightface/releases/download/v0.7/buffalo_l.zip';

function allExist() {
  return REQUIRED.every(f => fs.existsSync(path.join(BUFFALO_DIR, f)));
}

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    const proto = url.startsWith('https') ? https : require('http');

    const req = proto.get(url, res => {
      // Follow redirects
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        file.close();
        fs.unlinkSync(dest);
        return download(res.headers.location, dest).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }

      const total = parseInt(res.headers['content-length'] || '0', 10);
      let done = 0;
      res.on('data', chunk => {
        done += chunk.length;
        if (total) {
          process.stdout.write(`\r  ${(done / 1024 / 1024).toFixed(1)} / ${(total / 1024 / 1024).toFixed(1)} MB`);
        }
      });
      res.pipe(file);
      file.on('finish', () => { file.close(); console.log(); resolve(); });
    });

    req.on('error', err => { fs.unlink(dest, () => {}); reject(err); });
    file.on('error', err => { fs.unlink(dest, () => {}); reject(err); });
  });
}

// ── Non-commercial license info ───────────────────────────────────────────────
// InsightFace buffalo_l (det_10g.onnx + w600k_r50.onnx) is released under
// InsightFace's non-commercial research license:
//   https://github.com/deepinsight/insightface/tree/master/model_zoo
// Commercial use requires a separate license from the InsightFace team.
// The ArcFace algorithm is also subject to patent protection.
// YuNet (face_detection_yunet_2023mar.onnx) is Apache 2.0 — free for all use.

const NC_LICENSE_TEXT = `InsightFace buffalo_l models (det_10g.onnx, w600k_r50.onnx)
are released for non-commercial research use only.
See: https://github.com/deepinsight/insightface/tree/master/model_zoo
Commercial use requires a separate agreement with the InsightFace team.`;

/**
 * Download buffalo_l only if:
 *   (a) models already exist on disk (no license prompt needed for existing installs), OR
 *   (b) opts.ncAccepted === true (user has explicitly accepted the NC license)
 *
 * Throws { code: 'NC_LICENSE_REQUIRED' } if models are absent and license not accepted.
 */
async function ensureModels({ ncAccepted = false } = {}) {
  // Try the InsightFace Python cache first (no download needed)
  const insightDir = path.join(os.homedir(), '.insightface', 'models', 'buffalo_l');
  if (REQUIRED.every(f => fs.existsSync(path.join(insightDir, f)))) {
    console.log(`[models] Using existing InsightFace models from: ${insightDir}`);
    return insightDir;
  }

  if (allExist()) {
    console.log(`[models] Models already present at: ${BUFFALO_DIR}`);
    return BUFFALO_DIR;
  }

  // Models not on disk — require explicit NC license acceptance before downloading.
  if (!ncAccepted) {
    const err = new Error(
      'NC license acceptance required before downloading InsightFace buffalo_l models.\n' +
      NC_LICENSE_TEXT
    );
    err.code = 'NC_LICENSE_REQUIRED';
    throw err;
  }

  console.log('[models] Downloading buffalo_l ONNX models...');
  fs.mkdirSync(MODELS_DIR, { recursive: true });
  const zipPath = path.join(MODELS_DIR, 'buffalo_l.zip');

  await download(BUFFALO_URL, zipPath);

  console.log('[models] Extracting...');
  const zip = new AdmZip(zipPath);

  // Some zip layouts put files directly; others nest under buffalo_l/
  const entries = zip.getEntries();
  const nested  = entries.some(e => e.entryName.startsWith('buffalo_l/'));

  if (nested) {
    zip.extractAllTo(MODELS_DIR, true);
  } else {
    fs.mkdirSync(BUFFALO_DIR, { recursive: true });
    zip.extractAllTo(BUFFALO_DIR, true);
  }

  fs.unlinkSync(zipPath);
  console.log(`[models] Done. Models at: ${BUFFALO_DIR}`);
  return BUFFALO_DIR;
}

// ── YuNet face detection model ────────────────────────────────────────────────

const YUNET_URL  = 'https://github.com/opencv/opencv_zoo/raw/main/models/face_detection_yunet/face_detection_yunet_2023mar.onnx';
const YUNET_FILE = 'face_detection_yunet_2023mar.onnx';

/**
 * Download the YuNet ONNX model into the given modelDir (same dir as buffalo_l).
 * No-op if already present. Returns the full path to the model file.
 */
async function ensureYuNet(modelDir) {
  const dest = path.join(modelDir, YUNET_FILE);
  if (fs.existsSync(dest)) return dest;

  console.log('[models] Downloading YuNet face detection model (~370KB)...');
  fs.mkdirSync(modelDir, { recursive: true });
  await download(YUNET_URL, dest);
  console.log(`[models] YuNet ready at: ${dest}`);
  return dest;
}

// ── SFace face recognition model (OpenCV Zoo, Apache 2.0) ───────────────────
// Commercially-free 128-D embedding alternative to InsightFace ArcFace.
// Pairs with YuNet for a fully Apache-2.0 detection+recognition pipeline.

const SFACE_URL  = 'https://github.com/opencv/opencv_zoo/raw/main/models/face_recognition_sface/face_recognition_sface_2021dec.onnx';
const SFACE_FILE = 'face_recognition_sface_2021dec.onnx';

/**
 * Download the SFace ONNX model into modelDir.
 * No-op if already present. Returns the full path to the model file.
 * License: Apache 2.0 — no NC restrictions, commercial use allowed.
 */
async function ensureSFace(modelDir) {
  const dest = path.join(modelDir, SFACE_FILE);
  if (fs.existsSync(dest)) return dest;

  console.log('[models] Downloading SFace recognition model (~37 MB, Apache 2.0)...');
  fs.mkdirSync(modelDir, { recursive: true });
  await download(SFACE_URL, dest);
  console.log(`[models] SFace ready at: ${dest}`);
  return dest;
}

// ── AuraFace-v1 face recognition model (fal.ai, Apache 2.0) ──────────────────
// ResNet100 backbone, 512-D ArcFace-style embeddings, commercially permissive.
// Same preprocessing as buffalo_l ArcFace — drop-in schema-compatible (512-D),
// but embeddings from different models are NOT interchangeable (different vector
// spaces). Reprocessing all images is required when switching from buffalo_l.
// Source: https://huggingface.co/fal/AuraFace-v1

const AURAFACE_URL  = 'https://huggingface.co/fal/AuraFace-v1/resolve/main/glintr100.onnx';
const AURAFACE_FILE = 'glintr100.onnx';

/**
 * Download the AuraFace-v1 ONNX model (glintr100.onnx) into modelDir.
 * No-op if already present. Returns the full path to the model file.
 * License: Apache 2.0 — commercial use allowed.
 */
async function ensureAuraFace(modelDir) {
  const dest = path.join(modelDir, AURAFACE_FILE);
  if (fs.existsSync(dest)) return dest;

  console.log('[models] Downloading AuraFace-v1 glintr100.onnx (~250 MB, Apache 2.0)...');
  fs.mkdirSync(modelDir, { recursive: true });
  await download(AURAFACE_URL, dest);
  console.log(`[models] AuraFace-v1 ready at: ${dest}`);
  return dest;
}

// ── MediaPipe FaceLandmarker task model ───────────────────────────────────────

const LANDMARKER_URL  = 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';
const LANDMARKER_FILE = 'face_landmarker.task';

/**
 * Download the MediaPipe FaceLandmarker task model into modelDir.
 * No-op if already present. Returns the full path.
 */
async function ensureFaceLandmarker(modelDir) {
  const dest = path.join(modelDir, LANDMARKER_FILE);
  if (fs.existsSync(dest)) return dest;

  console.log('[models] Downloading face_landmarker.task (~25 MB)...');
  fs.mkdirSync(modelDir, { recursive: true });
  await download(LANDMARKER_URL, dest);
  console.log(`[models] FaceLandmarker ready at: ${dest}`);
  return dest;
}

module.exports = { ensureModels, ensureYuNet, ensureSFace, ensureAuraFace, ensureFaceLandmarker, BUFFALO_DIR, NC_LICENSE_TEXT };

if (require.main === module) {
  // CLI usage: node model-downloader.js --accept-nc
  const acceptNc = process.argv.includes('--accept-nc');
  ensureModels({ ncAccepted: acceptNc }).catch(err => {
    if (err.code === 'NC_LICENSE_REQUIRED') {
      console.error('\n[models] Cannot download: InsightFace buffalo_l requires non-commercial license acceptance.');
      console.error('[models] Re-run with --accept-nc flag to confirm non-commercial use:\n');
      console.error('  node core/model-downloader.js --accept-nc\n');
      console.error(NC_LICENSE_TEXT);
    } else {
      console.error(err);
    }
    process.exit(1);
  });
}
