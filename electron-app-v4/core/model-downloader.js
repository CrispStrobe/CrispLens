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

async function ensureModels() {
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

module.exports = { ensureModels, ensureYuNet, ensureFaceLandmarker, BUFFALO_DIR };

if (require.main === module) {
  ensureModels().catch(err => { console.error(err); process.exit(1); });
}
