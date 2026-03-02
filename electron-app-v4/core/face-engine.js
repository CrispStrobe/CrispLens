'use strict';

/**
 * face-engine.js
 *
 * Pure Node.js face detection + ArcFace embedding using buffalo_l ONNX models.
 *
 * Detection model:  det_10g.onnx  (SCRFD-10GF)
 * Recognition model: w600k_r50.onnx (ArcFace ResNet50, 512D output)
 *
 * Produces the SAME 512D vectors as Python InsightFace because:
 *   1. Same ONNX model weights
 *   2. Same 5-point similarity transform alignment (face-align.js)
 *   3. Same preprocessing: (pixel - 127.5) / 128.0, CHW layout
 *   4. Same L2 normalization of the 512D output
 */

const ort   = require('onnxruntime-node');
const sharp = require('sharp');
const fs    = require('fs');
const path  = require('path');
const https = require('https');
const http  = require('http');
const os    = require('os');
const { warpToArcFace } = require('./face-align');

sharp.cache(false);

// ── Model locations ──────────────────────────────────────────────────────────

// buffalo_l ships with InsightFace Python — reuse if already downloaded.
const INSIGHTFACE_MODEL_DIR = path.join(os.homedir(), '.insightface', 'models', 'buffalo_l');

// Fallback: local models/ dir next to this package
const LOCAL_MODEL_DIR = path.join(__dirname, '..', 'models', 'buffalo_l');

function findModelDir() {
  const dirs = [INSIGHTFACE_MODEL_DIR, LOCAL_MODEL_DIR];
  for (const d of dirs) {
    if (
      fs.existsSync(path.join(d, 'det_10g.onnx')) &&
      fs.existsSync(path.join(d, 'w600k_r50.onnx'))
    ) {
      return d;
    }
  }
  return null;
}

// ── SCRFD decode helpers ─────────────────────────────────────────────────────

const NMS_THRESHOLD   = 0.4;
const SCORE_THRESHOLD = 0.5;
const NUM_ANCHORS     = 2;  // buffalo_l det_10g uses 2 anchors per feature map cell

/**
 * Decode raw SCRFD output tensors into face proposals.
 *
 * The 9 output tensors from det_10g.onnx are ordered as:
 *   stride-8  → [scores, bboxes, kps]
 *   stride-16 → [scores, bboxes, kps]
 *   stride-32 → [scores, bboxes, kps]
 *
 * Scores  shape: [n_anchors, 1]    → flat length = feat*feat*2
 * Bboxes  shape: [n_anchors, 4]    → flat length = feat*feat*2*4  (in stride units)
 * Kps     shape: [n_anchors, 10]   → flat length = feat*feat*2*10 (in stride units)
 *
 * IMPORTANT: bbox/kps values are in STRIDE UNITS (not pixels).
 * Must multiply by stride to get 640-space pixel distances — same as InsightFace Python:
 *   bbox_preds = net_outs[idx+fmc] * stride
 *   kps_preds  = net_outs[idx+fmc*2] * stride
 *
 * `invScale = max(origW, origH) / 640` converts back to original pixels.
 */
function decodeOutputs(detOutputs, outputNames, invScale) {
  const strides = [8, 16, 32];
  const faces = [];

  // buffalo_l det_10g.onnx output layout (9 tensors):
  //   indices 0,1,2 → scores  at strides [8,16,32]   (len: 12800, 3200, 800)
  //   indices 3,4,5 → bboxes  at strides [8,16,32]   (len: 51200,12800,3200)
  //   indices 6,7,8 → kps     at strides [8,16,32]   (len:128000,32000,8000)
  // Scores are post-sigmoid (already in [0,1]).
  for (let si = 0; si < strides.length; si++) {
    const stride  = strides[si];
    const feat    = 640 / stride;           // feature map side length
    const spatial = feat * feat;
    const nTotal  = spatial * NUM_ANCHORS;  // total anchors for this stride

    const scores = detOutputs[outputNames[si    ]].data;  // length: nTotal
    const bboxes = detOutputs[outputNames[si + 3]].data;  // length: nTotal*4 (stride units)
    const kps    = detOutputs[outputNames[si + 6]].data;  // length: nTotal*10 (stride units)

    for (let idx = 0; idx < spatial; idx++) {
      const row = Math.floor(idx / feat);
      const col = idx % feat;

      for (let a = 0; a < NUM_ANCHORS; a++) {
        const ai = idx * NUM_ANCHORS + a;   // anchor index (0..nTotal-1)
        const score = scores[ai];
        if (score < SCORE_THRESHOLD) continue;

        // Anchor center in 640-space pixels
        const cx = col * stride;
        const cy = row * stride;

        // BBox distances: raw values are in stride units → multiply by stride → 640-space pixels
        // This matches InsightFace Python: bbox_preds = net_outs[idx+fmc] * stride
        const bi = ai * 4;
        const x1 = (cx - bboxes[bi    ] * stride) * invScale;
        const y1 = (cy - bboxes[bi + 1] * stride) * invScale;
        const x2 = (cx + bboxes[bi + 2] * stride) * invScale;
        const y2 = (cy + bboxes[bi + 3] * stride) * invScale;

        // 5-point keypoints: also in stride units → multiply by stride
        // This matches InsightFace Python: kps_preds = net_outs[idx+fmc*2] * stride
        const ki = ai * 10;
        const landmarks = [];
        for (let kp = 0; kp < 5; kp++) {
          landmarks.push([
            (cx + kps[ki + kp * 2    ] * stride) * invScale,
            (cy + kps[ki + kp * 2 + 1] * stride) * invScale,
          ]);
        }

        faces.push({ bbox: [x1, y1, x2, y2], score, landmarks });
      }
    }
  }
  return faces;
}

function applyNMS(faces) {
  const sorted  = faces.slice().sort((a, b) => b.score - a.score);
  const keep    = [];
  const removed = new Set();

  for (let i = 0; i < sorted.length; i++) {
    if (removed.has(i)) continue;
    keep.push(sorted[i]);
    if (keep.length >= 50) break;  // cap to avoid degenerate images

    const [ax1, ay1, ax2, ay2] = sorted[i].bbox;
    const aArea = (ax2 - ax1) * (ay2 - ay1);

    for (let j = i + 1; j < sorted.length; j++) {
      if (removed.has(j)) continue;
      const [bx1, by1, bx2, by2] = sorted[j].bbox;
      const bArea = (bx2 - bx1) * (by2 - by1);

      const ix1 = Math.max(ax1, bx1);
      const iy1 = Math.max(ay1, by1);
      const ix2 = Math.min(ax2, bx2);
      const iy2 = Math.min(ay2, by2);
      const inter = Math.max(0, ix2 - ix1) * Math.max(0, iy2 - iy1);
      const iou   = inter / (aArea + bArea - inter);

      if (iou > NMS_THRESHOLD) removed.add(j);
    }
  }
  return keep;
}

// ── ArcFace preprocessing ────────────────────────────────────────────────────

/**
 * Convert a 112×112 RGB Buffer (HWC, uint8) into a CHW float32 tensor with
 * the exact normalization used by InsightFace:
 *   input = (pixel - 127.5) / 128.0
 */
function buildArcFaceInput(rgbBuf) {
  const spatial = 112 * 112;
  const f32 = new Float32Array(3 * spatial);
  for (let i = 0; i < spatial; i++) {
    f32[i            ] = (rgbBuf[i * 3    ] - 127.5) / 128.0;  // R
    f32[i + spatial  ] = (rgbBuf[i * 3 + 1] - 127.5) / 128.0;  // G
    f32[i + spatial*2] = (rgbBuf[i * 3 + 2] - 127.5) / 128.0;  // B
  }
  return f32;
}

/**
 * L2-normalize a Float32Array in-place.
 */
function l2Normalize(vec) {
  let sqSum = 0;
  for (let i = 0; i < vec.length; i++) sqSum += vec[i] * vec[i];
  const norm = Math.sqrt(sqSum) || 1;
  for (let i = 0; i < vec.length; i++) vec[i] /= norm;
  return vec;
}

// ── FaceEngine class ─────────────────────────────────────────────────────────

class FaceEngine {
  constructor(modelDir) {
    this.modelDir     = modelDir || findModelDir();
    this.detModel     = null;
    this.recModel     = null;
    this.initialized  = false;
    this._outputNames = null;  // cached after first detection
  }

  async init() {
    if (this.initialized) return;

    if (!this.modelDir || !fs.existsSync(path.join(this.modelDir, 'det_10g.onnx'))) {
      throw new Error(
        `buffalo_l models not found.\n` +
        `Run 'node core/model-downloader.js' to download them, or install\n` +
        `InsightFace (Python) which will place them in ~/.insightface/models/buffalo_l/`
      );
    }

    const opts = {
      executionProviders: ['cpu'],
      intraOpNumThreads:  4,
      interOpNumThreads:  1,
    };

    console.log(`[FaceEngine] Loading models from: ${this.modelDir}`);
    this.detModel = await ort.InferenceSession.create(
      path.join(this.modelDir, 'det_10g.onnx'), opts
    );
    this.recModel = await ort.InferenceSession.create(
      path.join(this.modelDir, 'w600k_r50.onnx'), opts
    );

    // Cache output names — expected order for buffalo_l det_10g.onnx:
    // [score_8, score_16, score_32, bbox_8, bbox_16, bbox_32, kps_8, kps_16, kps_32]
    this._outputNames = this.detModel.outputNames;
    if (this._outputNames.length !== 9) {
      throw new Error(`Expected 9 detection outputs, got ${this._outputNames.length}`);
    }

    this.initialized = true;
    console.log('[FaceEngine] Models ready.');
    console.log('[FaceEngine] Detection output names:', this._outputNames.join(', '));
  }

  /**
   * Detect all faces in `imagePath`.
   *
   * Returns array of { bbox:[x1,y1,x2,y2], score, landmarks:[[x,y]*5] }
   * in original image pixel coordinates (display-space, after EXIF rotation).
   */
  async detectFaces(imagePath) {
    await this.init();

    const img  = sharp(imagePath);
    const meta = await img.metadata();

    // Use display-space dimensions (swap for EXIF orientations 5-8 which rotate 90°/270°)
    let W = meta.width, H = meta.height;
    if (meta.orientation && meta.orientation >= 5) { [W, H] = [H, W]; }

    // Apply EXIF rotation before letterboxing so detection runs in display coordinate space.
    // This ensures bboxes align with how the image is displayed in the browser.
    // Letterbox to 640×640 (top-left placement, matching InsightFace)
    const { data: detBuf } = await img.clone()
      .rotate()   // apply EXIF auto-rotation (no-op if already upright)
      .resize(640, 640, {
        fit:        'contain',
        background: { r: 0, g: 0, b: 0 },
        position:   'northwest',   // top-left, same as InsightFace padding
      })
      .raw()
      .toBuffer({ resolveWithObject: true });

    // NCHW float32 with (pixel - 127.5) / 128.0
    const f32 = new Float32Array(3 * 640 * 640);
    const px  = 640 * 640;
    for (let i = 0; i < px; i++) {
      f32[i      ] = (detBuf[i * 3    ] - 127.5) / 128.0;
      f32[i + px ] = (detBuf[i * 3 + 1] - 127.5) / 128.0;
      f32[i + px*2] = (detBuf[i * 3 + 2] - 127.5) / 128.0;
    }

    const detOutputs = await this.detModel.run({
      [this.detModel.inputNames[0]]: new ort.Tensor('float32', f32, [1, 3, 640, 640]),
    });

    // invScale: multiply 640-space coords → original pixel coords
    // InsightFace uses det_scale = 640 / max(W,H), so invScale = max(W,H)/640
    const invScale = Math.max(W, H) / 640;
    const raw   = decodeOutputs(detOutputs, this._outputNames, invScale);
    const faces = applyNMS(raw);

    if (process.env.DEBUG) {
      console.log(`[FaceEngine] detect: ${faces.length} face(s) after NMS (${raw.length} raw proposals), image ${W}x${H}`);
      for (const f of faces) {
        const [x1, y1, x2, y2] = f.bbox;
        console.log(`  score=${f.score.toFixed(3)}  bbox=[${Math.round(x1)},${Math.round(y1)},${Math.round(x2)},${Math.round(y2)}]  size=${Math.round(x2-x1)}x${Math.round(y2-y1)}px`);
      }
    }

    return { faces, imageWidth: W, imageHeight: H };
  }

  /**
   * Compute the ArcFace 512D embedding for a single detected face.
   *
   * `imagePath`  – path to the source image
   * `landmarks`  – 5 [x,y] points in original image pixel coordinates
   * `imageWidth`, `imageHeight` – dimensions of the original image
   *
   * Returns a Float32Array of length 512, L2-normalized.
   */
  async embedFace(imagePath, landmarks, imageWidth, imageHeight) {
    await this.init();

    // Read the source image as raw RGB (apply EXIF rotation so landmarks align)
    const srcBuf = await sharp(imagePath)
      .rotate()           // apply EXIF auto-rotation
      .ensureAlpha(0)     // strip alpha if present (keeps RGB order)
      .removeAlpha()      // ensure 3-channel
      .raw()
      .toBuffer();

    // Warp to 112×112 using 5-point similarity transform
    const aligned = warpToArcFace(srcBuf, imageWidth, imageHeight, landmarks);

    // Build float32 CHW tensor
    const f32 = buildArcFaceInput(aligned);

    const recOutputs = await this.recModel.run({
      [this.recModel.inputNames[0]]: new ort.Tensor('float32', f32, [1, 3, 112, 112]),
    });

    const raw = Float32Array.from(recOutputs[this.recModel.outputNames[0]].data);
    return l2Normalize(raw);
  }

  /**
   * Full pipeline: detect all faces in an image and return their embeddings.
   *
   * Returns array of { bbox, score, landmarks, embedding:Float32Array<512> }
   */
  async processImage(imagePath) {
    const { faces, imageWidth, imageHeight } = await this.detectFaces(imagePath);

    const results = [];
    for (const face of faces) {
      const embedding = await this.embedFace(
        imagePath, face.landmarks, imageWidth, imageHeight
      );
      results.push({ ...face, embedding });
    }
    return results;
  }
}

module.exports = { FaceEngine, findModelDir, l2Normalize };
