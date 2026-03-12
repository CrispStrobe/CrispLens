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

const ort    = require('onnxruntime-node');
const sharp  = require('sharp');
const fs     = require('fs');
const path   = require('path');
const https  = require('https');
const http   = require('http');
const os     = require('os');
const crypto = require('crypto');
const { warpToArcFace }  = require('./face-align');
const { ensureYuNet }    = require('./model-downloader');

sharp.cache(false);

// ── Build ONNX execution providers from server settings ──────────────────────
// Reads ort_use_coreml / ort_use_cuda / ort_use_directml from settings DB.
// Always falls back to 'cpu' as the last provider.
function _buildExecProviders(forceProviders = null) {
  if (forceProviders) return forceProviders;
  try {
    const { loadFlat } = require('../server/routes/settings');
    const flat = loadFlat();
    const providers = [];
    if (flat.ort_use_cuda)     providers.push('cuda');
    if (flat.ort_use_coreml)   providers.push('coreml');
    if (flat.ort_use_directml) providers.push('directml');
    providers.push('cpu');
    return providers;
  } catch {
    return ['cpu'];
  }
}

// ── Model locations ──────────────────────────────────────────────────────────

// buffalo_l ships with InsightFace Python — reuse if already downloaded.
const INSIGHTFACE_MODEL_DIR = path.join(os.homedir(), '.insightface', 'models', 'buffalo_l');

// Fallback: local models/ dir next to this package
const LOCAL_MODEL_DIR = path.join(__dirname, '..', 'models', 'buffalo_l');

// Explicit override via environment variable
const ENV_MODEL_DIR = process.env.FACE_REC_MODELS_DIR;

function findModelDir() {
  const dirs = [];
  if (ENV_MODEL_DIR) {
    dirs.push(ENV_MODEL_DIR);
    if (!ENV_MODEL_DIR.endsWith('buffalo_l')) dirs.push(path.join(ENV_MODEL_DIR, 'buffalo_l'));
  }
  // In production Electron builds, also check USER_DATA_PATH (set by electron-main.js)
  // so models downloaded to the writable userData dir are found even if LOCAL_MODEL_DIR
  // points inside the read-only app bundle.
  if (process.env.USER_DATA_PATH) {
    dirs.push(path.join(process.env.USER_DATA_PATH, 'models', 'buffalo_l'));
  }
  dirs.push(INSIGHTFACE_MODEL_DIR, LOCAL_MODEL_DIR);

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
function decodeOutputs(detOutputs, outputNames, invScale, scoreThresh = 0.5) {
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
        if (score < scoreThresh) continue;

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
 * ArcFace (w600k_r50) was trained with OpenCV BGR channel order, so we feed
 * channels as [B, G, R] even though Sharp gives us RGB bytes.
 */
function buildArcFaceInput(rgbBuf) {
  const spatial = 112 * 112;
  const f32 = new Float32Array(3 * spatial);
  for (let i = 0; i < spatial; i++) {
    f32[i            ] = (rgbBuf[i * 3 + 2] - 127.5) / 128.0;  // B (channel 0)
    f32[i + spatial  ] = (rgbBuf[i * 3 + 1] - 127.5) / 128.0;  // G (channel 1)
    f32[i + spatial*2] = (rgbBuf[i * 3    ] - 127.5) / 128.0;  // R (channel 2)
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
    this.modelDir        = modelDir || findModelDir();
    this.detModel        = null;     // SCRFD (det_10g.onnx)
    this.recModel        = null;     // ArcFace (w600k_r50.onnx)
    this.yunetModel      = null;     // YuNet (lazy-loaded on first use)
    this.yunetOutputNames = null;
    this.initialized     = false;
    this._outputNames    = null;     // cached SCRFD output names
    this.currentProviders = ['cpu'];
  }

  async init(providers = null) {
    if (this.initialized && !providers) return;

    if (!this.modelDir || !fs.existsSync(path.join(this.modelDir, 'det_10g.onnx'))) {
      throw new Error('buffalo_l models not found');
    }

    let execProviders = providers;
    if (!execProviders) {
      try {
        // Only require settings if needed
        const { loadFlat } = require('../server/routes/settings');
        const flat = loadFlat();
        execProviders = [];
        if (flat.ort_use_cuda)     execProviders.push('cuda');
        if (flat.ort_use_coreml)   execProviders.push('coreml');
        if (flat.ort_use_directml) execProviders.push('directml');
        execProviders.push('cpu');
      } catch (e) {
        execProviders = ['cpu'];
      }
    }
    
    this.currentProviders = execProviders;
    const opts = {
      executionProviders: execProviders,
      intraOpNumThreads:  4,
      interOpNumThreads:  1,
    };

    console.log(`[FaceEngine] Loading models with providers: ${execProviders.join(',')}`);
    this.detModel = await ort.InferenceSession.create(path.join(this.modelDir, 'det_10g.onnx'), opts);
    this.recModel = await ort.InferenceSession.create(path.join(this.modelDir, 'w600k_r50.onnx'), opts);
    
    if (!this.detModel || !this.recModel) {
      throw new Error('Failed to create InferenceSession (null returned)');
    }
    
    this._outputNames = this.detModel.outputNames;
    this.initialized = true;
    console.log('[FaceEngine] Models ready.');
    console.log('[FaceEngine] Detection output names:', this._outputNames.join(', '));
  }

  /** Lazy-load YuNet ONNX model (downloads if not present). */
  async initYuNet(providers = null) {
    if (this.yunetModel) return;
    const yunetPath = require('path').join(this.modelDir, 'face_detection_yunet_2023mar.onnx');
    if (!fs.existsSync(yunetPath)) await ensureYuNet(this.modelDir);
    this.yunetModel = await ort.InferenceSession.create(yunetPath, {
      executionProviders: providers || this.currentProviders || ['cpu'],
      intraOpNumThreads:  2,
      interOpNumThreads:  1,
    });
    this.yunetOutputNames = this.yunetModel.outputNames;
    console.log('[FaceEngine] YuNet ready. Output names:', this.yunetOutputNames.join(', '));
  }

  /**
   * Detect all faces in `imagePath` using SCRFD (det_10g.onnx).
   *
   * @param {string} imagePath
   * @param {object} opts
   * @param {number} [opts.det_thresh=0.5]    Score threshold (0-1)
   * @param {number} [opts.min_face_size=0]   Minimum face short-side in px (0=no filter)
   * @param {number} [opts.max_size=0]        Downscale image to this long-edge before detection
   * Returns { faces, imageWidth, imageHeight }
   */
  async detectFaces(imagePath, opts = {}) {
    if (!this.initialized) await this.init();

    const detThresh   = parseFloat(opts.det_thresh)   || 0.5;
    const minFaceSize = parseInt(opts.min_face_size)  || 0;
    const maxSize     = parseInt(opts.max_size)        || 0;

    const img  = sharp(imagePath);
    const meta = await img.metadata();

    // Use display-space dimensions (swap for EXIF orientations 5-8 which rotate 90°/270°)
    const origW = meta.width, origH = meta.height;
    let W = origW, H = origH;
    if (meta.orientation && meta.orientation >= 5) { [W, H] = [H, W]; }

    // Apply EXIF rotation; optionally downscale to max_size before letterboxing.
    // invScale is computed from ORIGINAL dims — correct even with max_size pre-scale
    // because: invScale(preSized→640) * invScale(orig→preSized) = max(origW,origH)/640
    let pipeline = img.clone().rotate();
    if (maxSize > 0 && Math.max(W, H) > maxSize) {
      pipeline = pipeline.resize(maxSize, maxSize, { fit: 'inside', withoutEnlargement: true });
    }

    // Letterbox to 640×640 (top-left placement, matching InsightFace)
    const { data: detBuf } = await pipeline
      .resize(640, 640, {
        fit:        'contain',
        background: { r: 0, g: 0, b: 0 },
        position:   'northwest',
      })
      .raw()
      .toBuffer({ resolveWithObject: true });

    // SCRFD: NCHW float32, (pixel - 127.5) / 128.0, RGB channel order
    const f32 = new Float32Array(3 * 640 * 640);
    const px  = 640 * 640;
    for (let i = 0; i < px; i++) {
      f32[i       ] = (detBuf[i * 3    ] - 127.5) / 128.0;
      f32[i + px  ] = (detBuf[i * 3 + 1] - 127.5) / 128.0;
      f32[i + px*2] = (detBuf[i * 3 + 2] - 127.5) / 128.0;
    }

    const detOutputs = await this.detModel.run({
      [this.detModel.inputNames[0]]: new ort.Tensor('float32', f32, [1, 3, 640, 640]),
    });

    // invScale: multiply 640-space coords → original pixel coords
    const invScale = Math.max(W, H) / 640;
    const raw = decodeOutputs(detOutputs, this._outputNames, invScale, detThresh);
    let faces = applyNMS(raw);

    // Filter by minimum face size (short-side in px)
    if (minFaceSize > 0) {
      faces = faces.filter(f => {
        const [x1, y1, x2, y2] = f.bbox;
        return Math.min(x2 - x1, y2 - y1) >= minFaceSize;
      });
    }

    if (process.env.DEBUG) {
      console.log(`[FaceEngine/SCRFD] ${faces.length} face(s) (${raw.length} raw), image ${W}x${H}, thresh=${detThresh}`);
      for (const f of faces) {
        const [x1, y1, x2, y2] = f.bbox;
        console.log(`  score=${f.score.toFixed(3)}  bbox=[${[x1,y1,x2,y2].map(v=>Math.round(v)).join(',')}]  size=${Math.round(x2-x1)}x${Math.round(y2-y1)}px`);
      }
    }

    return { faces, imageWidth: W, imageHeight: H };
  }

  /**
   * Detect faces using YuNet (face_detection_yunet_2023mar.onnx).
   * YuNet is a lightweight (370KB) alternative to SCRFD. The ONNX model
   * includes built-in NMS and outputs post-NMS detections directly.
   *
   * Input normalization: BGR float32, subtract mean [104, 117, 123] (no /128).
   * Output tensor: [1, N, 15] — [x_tl, y_tl, w, h, kp0x, kp0y, ..., kp4x, kp4y, score]
   * Keypoint order matches InsightFace: right_eye, left_eye, nose, mouth_right, mouth_left.
   */
  async detectFacesYuNet(imagePath, opts = {}) {
    await this.initYuNet();

    const DET_SIZE    = 640;
    const detThresh   = parseFloat(opts.det_thresh)   || 0.5;
    const minFaceSize = parseInt(opts.min_face_size)  || 0;
    const maxSize     = parseInt(opts.max_size)        || 0;

    const img  = sharp(imagePath);
    const meta = await img.metadata();

    let W = meta.width, H = meta.height;
    if (meta.orientation && meta.orientation >= 5) { [W, H] = [H, W]; }

    let pipeline = img.clone().rotate();
    if (maxSize > 0 && Math.max(W, H) > maxSize) {
      pipeline = pipeline.resize(maxSize, maxSize, { fit: 'inside', withoutEnlargement: true });
    }

    const { data: detBuf } = await pipeline
      .resize(DET_SIZE, DET_SIZE, {
        fit:        'contain',
        background: { r: 0, g: 0, b: 0 },
        position:   'northwest',
      })
      .raw()
      .toBuffer({ resolveWithObject: true });

    // YuNet: BGR NCHW float32, subtract mean [104, 117, 123]
    const f32 = new Float32Array(3 * DET_SIZE * DET_SIZE);
    const px  = DET_SIZE * DET_SIZE;
    for (let i = 0; i < px; i++) {
      f32[i       ] = detBuf[i * 3 + 2] - 104.0;  // B
      f32[i + px  ] = detBuf[i * 3 + 1] - 117.0;  // G
      f32[i + px*2] = detBuf[i * 3    ] - 123.0;  // R
    }

    const outputs = await this.yunetModel.run({
      [this.yunetModel.inputNames[0]]: new ort.Tensor('float32', f32, [1, 3, DET_SIZE, DET_SIZE]),
    });

    const outData = outputs[this.yunetOutputNames[0]].data;   // Float32Array
    const dims    = outputs[this.yunetOutputNames[0]].dims;

    // Expect [1, N, 15] or [N, 15] — determine total detections
    const N = dims.length === 3 ? dims[1] : (dims.length === 2 ? dims[0] : outData.length / 15);

    // invScale: 640-space → original image coords (same formula as SCRFD)
    const invScale = Math.max(W, H) / DET_SIZE;

    const faces = [];
    for (let i = 0; i < N; i++) {
      const base  = i * 15;
      const score = outData[base + 14];
      if (score < detThresh || score <= 0) continue;

      // YuNet: [x_tl, y_tl, width, height, kp0x, kp0y, ..., kp4x, kp4y, score]
      const x1 = outData[base    ] * invScale;
      const y1 = outData[base + 1] * invScale;
      const x2 = (outData[base] + outData[base + 2]) * invScale;
      const y2 = (outData[base + 1] + outData[base + 3]) * invScale;

      if (minFaceSize > 0 && Math.min(x2 - x1, y2 - y1) < minFaceSize) continue;

      // 5 keypoints
      const landmarks = [];
      for (let k = 0; k < 5; k++) {
        landmarks.push([
          outData[base + 4 + k * 2    ] * invScale,
          outData[base + 4 + k * 2 + 1] * invScale,
        ]);
      }

      faces.push({ bbox: [x1, y1, x2, y2], score, landmarks });
    }

    // Safety NMS pass (model should include NMS, but just in case)
    const finalFaces = applyNMS(faces);

    if (process.env.DEBUG) {
      console.log(`[FaceEngine/YuNet] ${finalFaces.length} face(s), image ${W}x${H}, thresh=${detThresh}`);
      for (const f of finalFaces) {
        const [x1, y1, x2, y2] = f.bbox;
        console.log(`  score=${f.score.toFixed(3)}  bbox=[${[x1,y1,x2,y2].map(v=>Math.round(v)).join(',')}]`);
      }
    }

    return { faces: finalFaces, imageWidth: W, imageHeight: H };
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
    if (!this.initialized) await this.init();

    // Read the source image as raw RGB (apply EXIF rotation so landmarks align).
    // Use flatten() to composite any transparency on white — no-op for JPEGs.
    // Avoid ensureAlpha(0) which premultiplies all pixels by 0 (corrupts image).
    const srcBuf = await sharp(imagePath)
      .rotate()                              // apply EXIF auto-rotation
      .flatten({ background: '#ffffff' })    // composite alpha on white, no-op for JPEG
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
   * @param {string} imagePath
   * @param {object} opts
   * @param {string} [opts.det_model='auto']  'auto'|'scrfd' → SCRFD, 'yunet' → YuNet
   * @param {number} [opts.det_thresh=0.5]    Detection confidence threshold
   * @param {number} [opts.min_face_size=0]   Minimum face short-side in px
   * @param {number} [opts.max_size=0]        Pre-downscale long-edge before detection
   * Returns array of { bbox, score, landmarks, embedding:Float32Array<512> }
   */
  async processImage(imagePath, opts = {}) {
    const detModel = (opts.det_model || 'auto').toLowerCase();
    let detection;
    if (detModel === 'yunet') {
      detection = await this.detectFacesYuNet(imagePath, opts);
    } else {
      detection = await this.detectFaces(imagePath, opts);
    }
    const { faces, imageWidth, imageHeight } = detection;

    const results = [];
    for (const face of faces) {
      const embedding = await this.embedFace(
        imagePath, face.landmarks, imageWidth, imageHeight
      );
      results.push({ ...face, embedding });
    }
    return results;
  }

  /**
   * Run detection+embedding locally, return data in import-processed format.
   * Does NOT write to DB. For local_infer → remote_store mode:
   * v4 runs ONNX detection+embedding, sends only 512D vectors + thumbnail to
   * a remote server's POST /api/ingest/import-processed endpoint.
   *
   * Return format matches what v2's import-processed endpoint expects.
   */
  async extractFaceData(imagePath, opts = {}) {
    // Detection + embedding
    const detModel = (opts.det_model || 'auto').toLowerCase();
    let detection;
    if (detModel === 'yunet') {
      detection = await this.detectFacesYuNet(imagePath, opts);
    } else {
      detection = await this.detectFaces(imagePath, opts);
    }
    const { faces: detFaces, imageWidth: W, imageHeight: H } = detection;

    const facesWithEmb = [];
    for (const face of detFaces) {
      const embedding = await this.embedFace(imagePath, face.landmarks, W, H);
      facesWithEmb.push({ ...face, embedding });
    }

    // Thumbnail: 200px JPEG, base64-encoded
    const thumbBuf = await sharp(imagePath)
      .rotate()
      .resize(200, 200, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 75 })
      .toBuffer();

    // File hash (sha256) and size — read file once
    const rawBuf    = fs.readFileSync(imagePath);
    const file_hash = crypto.createHash('sha256').update(rawBuf).digest('hex');

    // Normalise bboxes to [0,1] and convert Float32Array embedding to plain array
    const faces = facesWithEmb.map(f => {
      const [x1, y1, x2, y2] = f.bbox;
      return {
        bbox_left:            Math.max(0, x1 / W),
        bbox_top:             Math.max(0, y1 / H),
        bbox_right:           Math.min(1, x2 / W),
        bbox_bottom:          Math.min(1, y2 / H),
        detection_confidence: f.score,
        embedding:            Array.from(f.embedding),
        embedding_dimension:  f.embedding.length,
      };
    });

    return {
      local_path:    imagePath,
      filename:      path.basename(imagePath),
      width:         W,
      height:        H,
      file_size:     rawBuf.length,
      file_hash,
      thumbnail_b64: thumbBuf.toString('base64'),
      local_model:   'buffalo_l',
      faces,
      visibility:    opts.visibility || 'shared',
    };
  }
}

module.exports = { FaceEngine, findModelDir, l2Normalize };
