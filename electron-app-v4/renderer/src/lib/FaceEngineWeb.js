/* FACE_ENGINE_WEB_VERSION: v4.0.260307.1006 */
/**
 * FaceEngineWeb.js — browser-compatible face engine for PWA / mobile (Capacitor)
 *
 * Drop-in browser replacement for the Node.js face-engine.js.
 * Uses the SAME buffalo_l ONNX models (det_10g.onnx + w600k_r50.onnx) but
 * through onnxruntime-web (WASM) + HTML5 Canvas instead of onnxruntime-node + sharp.
 *
 * Produces bit-identical 512D ArcFace embeddings to the server engine because:
 *   1. Same ONNX model weights (downloaded from the connected server at /models/)
 *   2. Same 5-point similarity transform (Umeyama) for face alignment
 *   3. Same preprocessing: SCRFD uses (px-127.5)/128 RGB; ArcFace uses BGR
 *   4. Same L2 normalisation of 512D output
 *
 * Optional: MediaPipe FaceDetector (`det_model='mediapipe'`) for GPU-accelerated
 * detection on mobile. Landmarks are remapped to the 5-point ArcFace template
 * so embeddings remain compatible with server-enrolled vectors.
 *
 * Optional: voy-search (WASM HNSW) for fully-offline vector search when the
 * device has a locally cached copy of enrolled embeddings.
 */

import * as ort from 'onnxruntime-web';

// Configure onnxruntime-web paths for WASM and worker scripts
// We copy the entire dist folder to /ort-wasm/ in vite.config.js
// Use self.location.origin because window is not defined in Workers
const wasmBase = (typeof self !== 'undefined' ? self.location.origin : '') + '/ort-wasm/';
console.log(`[FaceEngineWeb] Setting wasmPaths to: ${wasmBase}`);
ort.env.wasm.wasmPaths = wasmBase;

// Disable proxy (workers) to avoid MIME type 'text/html' errors in some browsers/PWA setups
ort.env.wasm.numThreads = 1;
ort.env.wasm.proxy = false;

// ── User-configurable ORT backend prefs (from localStorage) ──────────────────
// These are read once at module load time. SIMD must be set before any WASM
// session is compiled; executionProviders are applied per InferenceSession.
const _ls = typeof localStorage !== 'undefined' ? localStorage : null;
const _ortPrefs = {
  simd:   _ls?.getItem('pref_ort_use_simd')   === 'true',
  webgl:  _ls?.getItem('pref_ort_use_webgl')  !== 'false', // default true
  webgpu: _ls?.getItem('pref_ort_use_webgpu') === 'true',
};
console.log(`[FaceEngineWeb] ORT prefs: simd=${_ortPrefs.simd} webgl=${_ortPrefs.webgl} webgpu=${_ortPrefs.webgpu}`);
ort.env.wasm.simd = _ortPrefs.simd;

/** Build execution provider list for a new InferenceSession. */
function _getOrtProviders() {
  const isAndroid = typeof navigator !== 'undefined' && /Android/i.test(navigator.userAgent);
  const providers = [];
  // WebGPU: desktop browsers only; experimental
  if (_ortPrefs.webgpu && !isAndroid) providers.push('webgpu');
  // WebGL: stable on desktop, avoid on Android (driver crashes with large models)
  if (_ortPrefs.webgl && !isAndroid) providers.push('webgl');
  providers.push('wasm'); // always keep WASM as final fallback
  return providers;
}

// Trace onnxruntime-web backend selection
const _originalCreate = ort.InferenceSession.create;
ort.InferenceSession.create = async function(modelData, options) {
  console.log('[FaceEngineWeb] InferenceSession.create called', { 
    options, 
    wasmPaths: ort.env.wasm.wasmPaths,
    proxy: ort.env.wasm.proxy 
  });
  try {
    const session = await _originalCreate.apply(this, arguments);
    console.log('[FaceEngineWeb] InferenceSession.create SUCCESS');
    return session;
  } catch (err) {
    console.error('[FaceEngineWeb] InferenceSession.create FAILED:', err);
    throw err;
  }
};


// ── Constants ─────────────────────────────────────────────────────────────────

const SCRFD_SIZE   = 640;
const ARCFACE_SIZE = 112;
const NUM_ANCHORS  = 2;    // buffalo_l det_10g.onnx: 2 anchors per feature map cell
const NMS_THRESH   = 0.4;

// ArcFace canonical 5-point template (left-eye, right-eye, nose, left-mouth, right-mouth)
const ARC_DST = [
  [38.2946, 51.6963],
  [73.5318, 51.5014],
  [56.0252, 71.7366],
  [41.5493, 92.3655],
  [70.7299, 92.2041],
];

// MediaPipe FaceLandmarker → 5 ArcFace landmark indices (from 478-point mesh)
// These correspond to: left-eye, right-eye, nose-tip, left-mouth, right-mouth
const MP_LANDMARK_IDX = [33, 263, 1, 61, 291];

// Cache name for ONNX model files in the browser Cache API
const MODEL_CACHE_NAME = 'crisplens-onnx-models-v1';

// ── Similarity transform (Umeyama) ───────────────────────────────────────────

/**
 * Compute optimal similarity transform (scale + rotation + translation)
 * mapping `src` 2D points → `dst` 2D points in a least-squares sense.
 * Matches skimage.transform.SimilarityTransform / face-align.js exactly.
 *
 * Returns { a, b, tx, ty } where forward map is:
 *   xd = a*xs - b*ys + tx
 *   yd = b*xs + a*ys + ty
 */
function similarityTransform(src, dst) {
  const n = src.length;
  let scx = 0, scy = 0, dcx = 0, dcy = 0;
  for (let i = 0; i < n; i++) {
    scx += src[i][0]; scy += src[i][1];
    dcx += dst[i][0]; dcy += dst[i][1];
  }
  scx /= n; scy /= n; dcx /= n; dcy /= n;

  let num_a = 0, num_b = 0, denom = 0;
  for (let i = 0; i < n; i++) {
    const xs = src[i][0] - scx, ys = src[i][1] - scy;
    const xd = dst[i][0] - dcx, yd = dst[i][1] - dcy;
    num_a += xs * xd + ys * yd;
    num_b += xs * yd - ys * xd;
    denom += xs * xs + ys * ys;
  }
  const a  = num_a / denom;
  const b  = num_b / denom;
  const tx = dcx - a * scx + b * scy;
  const ty = dcy - b * scx - a * scy;
  return { a, b, tx, ty };
}

// ── NMS ───────────────────────────────────────────────────────────────────────

function iou(a, b) {
  const ix = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]));
  const iy = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
  const inter = ix * iy;
  const ua = (a[2]-a[0])*(a[3]-a[1]) + (b[2]-b[0])*(b[3]-b[1]) - inter;
  return ua > 0 ? inter / ua : 0;
}

function applyNMS(faces, thresh = NMS_THRESH) {
  const sorted = [...faces].sort((a, b) => b.score - a.score);
  const keep = [];
  const suppressed = new Uint8Array(sorted.length);
  for (let i = 0; i < sorted.length; i++) {
    if (suppressed[i]) continue;
    keep.push(sorted[i]);
    for (let j = i + 1; j < sorted.length; j++) {
      if (!suppressed[j] && iou(sorted[i].bbox, sorted[j].bbox) > thresh) {
        suppressed[j] = 1;
      }
    }
  }
  return keep;
}

// ── SCRFD output decoder ───────────────────────────────────────────────────────

/**
 * Decode 9 SCRFD output tensors into face proposals.
 * Matches face-engine.js decodeOutputs() exactly.
 *
 * invScale = max(origW, origH) / SCRFD_SIZE  converts 640-space → original pixels.
 */
function decodeSCRFD(outputs, outputNames, invScale, detThresh) {
  const strides = [8, 16, 32];
  const faces   = [];

  for (let si = 0; si < strides.length; si++) {
    const stride  = strides[si];
    const feat    = SCRFD_SIZE / stride;
    const spatial = feat * feat;

    const scores = outputs[outputNames[si    ]].data;  // nTotal × 1 (post-sigmoid)
    const bboxes = outputs[outputNames[si + 3]].data;  // nTotal × 4 (stride units)
    const kps    = outputs[outputNames[si + 6]].data;  // nTotal × 10 (stride units)

    for (let idx = 0; idx < spatial; idx++) {
      const row = Math.floor(idx / feat);
      const col = idx % feat;
      const cx  = col * stride;   // anchor centre in 640-space (matches InsightFace Python)
      const cy  = row * stride;

      for (let a = 0; a < NUM_ANCHORS; a++) {
        const ai = idx * NUM_ANCHORS + a;
        if (scores[ai] < detThresh) continue;

        const bi = ai * 4;
        const x1 = (cx - bboxes[bi    ] * stride) * invScale;
        const y1 = (cy - bboxes[bi + 1] * stride) * invScale;
        const x2 = (cx + bboxes[bi + 2] * stride) * invScale;
        const y2 = (cy + bboxes[bi + 3] * stride) * invScale;

        const ki = ai * 10;
        const landmarks = [];
        for (let kp = 0; kp < 5; kp++) {
          landmarks.push([
            (cx + kps[ki + kp * 2    ] * stride) * invScale,
            (cy + kps[ki + kp * 2 + 1] * stride) * invScale,
          ]);
        }
        faces.push({ bbox: [x1, y1, x2, y2], score: scores[ai], landmarks });
      }
    }
  }
  return faces;
}

// ── L2 normalise ─────────────────────────────────────────────────────────────

function l2normalize(vec) {
  let norm = 0;
  for (let i = 0; i < vec.length; i++) norm += vec[i] * vec[i];
  norm = Math.sqrt(norm);
  return norm > 0 ? vec.map(v => v / norm) : vec;
}

// ── Blob → base64 ────────────────────────────────────────────────────────────

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload  = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

// ── Main engine class ─────────────────────────────────────────────────────────

console.log("%c[FaceEngineWeb] Module Loaded | Version: v4.0.260307.1006", "color: #60c060; font-weight: bold");
export class FaceEngineWeb {
  constructor() {
    this._detSession  = null;
    this._recSession  = null;
    this._mpDetector  = null;   // MediaPipe FaceDetector (lazy)
    this._mpLandmarker = null;  // MediaPipe FaceLandmarker (lazy)
    this.modelBaseUrl = '/models';
    this.onProgress   = null;  // optional progress callback(msg: string)
  }

  setModelBaseUrl(url) {
    this.modelBaseUrl = url.replace(/\/$/, '');
  }

  _progress(msg) {
    if (this.onProgress) this.onProgress(msg);
  }

  // ── Model loading + Cache API ───────────────────────────────────────────────

  async _fetchModelCached(filename) {
    // Use a canonical key (just the filename) so models downloaded from a server
    // are reusable in standalone/local mode regardless of base URL changes.
    const canonicalKey = `http://onnx-model.local/${filename}`;
    const fetchUrl = `${this.modelBaseUrl}/${filename}`;
    
    // Direct download fallbacks (Hugging Face LFS mirrors)
    const fallbackUrls = {
      'det_10g.onnx':  'https://huggingface.co/lithiumice/insightface/resolve/main/models/buffalo_l/det_10g.onnx',
      'w600k_r50.onnx': 'https://huggingface.co/lithiumice/insightface/resolve/main/models/buffalo_l/w600k_r50.onnx',
      'face_detection_yunet_2023mar.onnx': 'https://github.com/opencv/opencv_zoo/raw/main/models/face_detection_yunet/face_detection_yunet_2023mar.onnx'
    };
    const fallbackUrl = fallbackUrls[filename];

    if ('caches' in globalThis) {
      const cache = await caches.open(MODEL_CACHE_NAME);
      // Check canonical key first
      let resp = await cache.match(canonicalKey);
      if (!resp) {
        // Also check legacy full-URL key (backward compat with previously cached models)
        resp = await cache.match(fetchUrl);
      }
      if (!resp) {
        this._progress(`Downloading ${filename}…`);
        try {
          console.log(`[FaceEngineWeb] Fetching ${filename} from ${fetchUrl}`);
          resp = await fetch(fetchUrl);
          
          // CRITICAL: Manual MIME type check to fail early with clear message
          const ct = resp.headers.get('content-type') || '';
          if (ct.includes('text/html')) {
            console.error(`[FaceEngineWeb] Server returned HTML for ${fetchUrl} - likely SPA fallback error.`);
            throw new Error(`Server returned HTML instead of ${filename}. Check server MIME type config.`);
          }
          
          if (!resp.ok) throw new Error(`Server fetch failed: ${resp.status}`);
        } catch (e) {
          if (fallbackUrl) {
            console.log(`[FaceEngineWeb] Primary fetch failed for ${filename}, trying fallback: ${fallbackUrl}`);
            this._progress(`Server fetch failed, trying direct download for ${filename}…`);
            resp = await fetch(fallbackUrl);
            if (!resp.ok) throw new Error(`Model download failed from both server and mirror: ${resp.status}`);
          } else {
            throw new Error(`Model download failed: ${e.message}`);
          }
        }
        
        // Store under canonical key. Clone first so we can still use the response.
        // We use cache.put(..., resp.clone()) immediately so we don't hold the whole 170MB in RAM.
        console.log(`[FaceEngineWeb] Storing ${filename} in Cache API...`);
        await cache.put(canonicalKey, resp.clone());
      }
      return resp.arrayBuffer();
    }
    // Fallback: plain fetch (no caching)
    this._progress(`Fetching ${filename}…`);
    try {
      const resp = await fetch(fetchUrl);
      if (resp.ok) return resp.arrayBuffer();
    } catch (e) {}
    if (fallbackUrl) {
      const resp = await fetch(fallbackUrl);
      if (resp.ok) return resp.arrayBuffer();
    }
    throw new Error(`Model fetch failed: ${filename}`);
  }

  /** Pre-download both ONNX models and store in Cache API. Call from SettingsView. */
  async downloadModels(onProgress) {
    const files = ['det_10g.onnx', 'w600k_r50.onnx'];
    const results = {};
    for (const file of files) {
      onProgress?.(`Downloading ${file}…`);
      try {
        await this._fetchModelCached(file);
        results[file] = 'ok';
      } catch (e) {
        results[file] = e.message;
      }
    }
    return results;
  }

  /** Manually release all AI models from memory. */
  async releaseModels() {
    console.log('[FaceEngineWeb] Releasing all models from memory...');
    try {
      if (this._detSession) { await this._detSession.release(); this._detSession = null; }
      if (this._recSession) { await this._recSession.release(); this._recSession = null; }
      if (this._mpLandmarker) { await this._mpLandmarker.close(); this._mpLandmarker = null; }
      if (this._mpDetector) { this._mpDetector = null; }
      console.log('[FaceEngineWeb] Release complete.');
    } catch (err) {
      console.warn('[FaceEngineWeb] Error during model release:', err);
    }
  }

  /** Check which models are cached without fetching. */
  async getModelCacheStatus() {
    if (!('caches' in globalThis)) return { det_10g: false, w600k_r50: false };
    const cache = await caches.open(MODEL_CACHE_NAME);
    const keys = await cache.keys();
    const keyStrings = keys.map(r => r.url || String(r));
    const hasDet = keyStrings.some(k => k.includes('det_10g'));
    const hasRec = keyStrings.some(k => k.includes('w600k_r50'));
    return { det_10g: hasDet, w600k_r50: hasRec };
  }

  async _initDetector() {
    if (this._detSession) return;
    this._progress('Loading SCRFD detector…');
    // Prefer quantized INT8 model (~4 MB) over full float32 (~16 MB) if available
    const buf = await this._fetchModelCached('det_10g_int8.onnx').catch(() => this._fetchModelCached('det_10g.onnx'));
    
    const providers = _getOrtProviders();
    console.log(`[FaceEngineWeb] Initializing Detector | providers=${providers}`);

    this._detSession = await ort.InferenceSession.create(buf, {
      executionProviders: providers,
      graphOptimizationLevel: 'all',
      enableCpuMemArena: true,
      enableMemPattern: true,
    });
    this._progress('Detector ready');
  }

  async _initRecognizer() {
    if (this._recSession) return;
    this._progress('Loading ArcFace recognizer…');
    // Prefer quantized INT8 model (~42 MB) over full float32 (~166 MB) if available
    const buf = await this._fetchModelCached('w600k_r50_int8.onnx').catch(() => this._fetchModelCached('w600k_r50.onnx'));
    
    const providers = _getOrtProviders();
    console.log(`[FaceEngineWeb] Initializing Recognizer | providers=${providers}`);

    this._recSession = await ort.InferenceSession.create(buf, {
      executionProviders: providers,
      graphOptimizationLevel: 'all',
      enableCpuMemArena: true,
      enableMemPattern: true,
    });
    this._progress('Recognizer ready');
  }

  // ── Image loading ───────────────────────────────────────────────────────────

  /** Load a File/Blob/URL into a resolved HTMLImageElement */
  async _loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload  = () => resolve(img);
      img.onerror = reject;
      if (src instanceof Blob) {
        img.src = URL.createObjectURL(src);
      } else {
        img.src = src;
      }
    });
  }

  // ── Canvas helpers ──────────────────────────────────────────────────────────

  /**
   * Letterbox img to SCRFD_SIZE × SCRFD_SIZE (top-left, black padding).
   * Returns { canvas, invScale } where invScale converts 640-space → original pixels.
   */
  _letterbox(img) {
    const W = img.naturalWidth  || img.width;
    const H = img.naturalHeight || img.height;
    
    // Safety check for mobile: if original is HUGE, we pre-scale it once here to save memory
    // during the .getImageData() and tensor conversion steps.
    const isMobile = /Android|iPhone|iPad/i.test(navigator.userAgent);
    const MAX_PRE_SCALE = isMobile ? 1600 : 4000;
    
    let source = img;
    let currentW = W;
    let currentH = H;
    
    if (Math.max(W, H) > MAX_PRE_SCALE) {
      const scale = MAX_PRE_SCALE / Math.max(W, H);
      currentW = Math.round(W * scale);
      currentH = Math.round(H * scale);
      console.log(`[FaceEngineWeb] Pre-scaling HUGE image for safety: ${W}x${H} -> ${currentW}x${currentH}`);
      const preCanvas = new OffscreenCanvas(currentW, currentH);
      preCanvas.getContext('2d').drawImage(img, 0, 0, currentW, currentH);
      source = preCanvas;
    }

    const scale    = Math.min(SCRFD_SIZE / currentW, SCRFD_SIZE / currentH);
    const newW     = Math.round(currentW * scale);
    const newH     = Math.round(currentH * scale);
    
    // invScale must still map back to the ORIGINAL dimensions
    const invScale = Math.max(W, H) / SCRFD_SIZE;

    const canvas = new OffscreenCanvas(SCRFD_SIZE, SCRFD_SIZE);
    const ctx    = canvas.getContext('2d');
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, SCRFD_SIZE, SCRFD_SIZE);
    ctx.drawImage(source, 0, 0, newW, newH);

    return { canvas, invScale };
  }

  /**
   * Build SCRFD input tensor from letterbox canvas.
   * Preprocessing: (pixel − 127.5) / 128.0, RGB channel order, NCHW float32.
   */
  _canvasToSCRFDTensor(canvas) {
    const ctx  = canvas.getContext('2d');
    const px   = SCRFD_SIZE * SCRFD_SIZE;
    const rgba = ctx.getImageData(0, 0, SCRFD_SIZE, SCRFD_SIZE).data;
    const f32  = new Float32Array(3 * px);
    for (let i = 0; i < px; i++) {
      f32[i      ] = (rgba[i * 4    ] - 127.5) / 128.0;  // R — channel 0
      f32[i + px ] = (rgba[i * 4 + 1] - 127.5) / 128.0;  // G — channel 1
      f32[i + px*2] = (rgba[i * 4 + 2] - 127.5) / 128.0; // B — channel 2
    }
    return new ort.Tensor('float32', f32, [1, 3, SCRFD_SIZE, SCRFD_SIZE]);
  }

  /**
   * Extract a 112×112 ArcFace-aligned face crop using a canvas affine transform.
   *
   * The forward similarity transform M maps source landmarks → ARC_DST positions.
   * Applying M to the canvas context and drawing the source image places each
   * source pixel at its transformed position in the 112×112 output canvas.
   *
   * Canvas setTransform(a_c, b_c, c_c, d_c, e_c, f_c) applies:
   *   x' = a_c*x + c_c*y + e_c
   *   y' = b_c*x + d_c*y + f_c
   *
   * Our forward map: xd = a*xs − b*ys + tx, yd = b*xs + a*ys + ty
   *   → setTransform(a, b, -b, a, tx, ty)
   */
  _cropFace(img, landmarks) {
    const { a, b, tx, ty } = similarityTransform(landmarks, ARC_DST);
    const canvas = new OffscreenCanvas(ARCFACE_SIZE, ARCFACE_SIZE);
    const ctx    = canvas.getContext('2d');
    ctx.setTransform(a, b, -b, a, tx, ty);
    ctx.drawImage(img, 0, 0);
    ctx.resetTransform();
    return canvas;
  }

  /**
   * Build ArcFace input tensor from 112×112 face crop canvas.
   * Preprocessing: (pixel − 127.5) / 128.0, BGR channel order (model trained w/ OpenCV).
   * Matches face-engine.js buildArcFaceInput() exactly.
   */
  _faceCanvasToArcFaceTensor(canvas) {
    const ctx  = canvas.getContext('2d');
    const sp   = ARCFACE_SIZE * ARCFACE_SIZE;
    const rgba = ctx.getImageData(0, 0, ARCFACE_SIZE, ARCFACE_SIZE).data;
    const f32  = new Float32Array(3 * sp);
    for (let i = 0; i < sp; i++) {
      f32[i      ] = (rgba[i * 4 + 2] - 127.5) / 128.0;  // B — channel 0
      f32[i + sp ] = (rgba[i * 4 + 1] - 127.5) / 128.0;  // G — channel 1
      f32[i + sp*2] = (rgba[i * 4    ] - 127.5) / 128.0;  // R — channel 2
    }
    return new ort.Tensor('float32', f32, [1, 3, ARCFACE_SIZE, ARCFACE_SIZE]);
  }

  // ── SCRFD detection ─────────────────────────────────────────────────────────

  async detectFaces(img, opts = {}) {
    const detThresh  = opts.det_thresh    ?? 0.5;
    const minFaceSize = opts.min_face_size ?? 0;
    const detModel    = opts.det_model    || 'auto';

    const W = img.naturalWidth  || img.width;
    const H = img.naturalHeight || img.height;
    console.log(`[FaceEngineWeb] detectFaces START | model=${detModel} | thresh=${detThresh} | minSize=${minFaceSize}`);
    console.log(`[FaceEngineWeb] Input Image: ${W}x${H} | src=${img.src.slice(0, 100)}...`);

    if (W < 50 || H < 50) {
      console.warn(`[FaceEngineWeb] WARNING: Image dimensions are very small (${W}x${H}). Detection might fail.`);
    }

    await this._initDetector();
    
    const { canvas, invScale } = this._letterbox(img);
    console.log(`[FaceEngineWeb] Letterbox complete. invScale=${invScale.toFixed(4)} (640 -> original)`);
    
    const inputTensor = this._canvasToSCRFDTensor(canvas);
    console.log(`[FaceEngineWeb] Input Tensor created. Shape:`, inputTensor.dims);

    let faces;
    try {
      console.log('[FaceEngineWeb] Running SCRFD ONNX session...');
      const start = performance.now();
      const results = await this._detSession.run({
        [this._detSession.inputNames[0]]: inputTensor,
      });
      const duration = performance.now() - start;
      console.log(`[FaceEngineWeb] SCRFD Session RUN complete in ${duration.toFixed(1)}ms`);

      const outputNames = this._detSession.outputNames;
      console.log(`[FaceEngineWeb] Model Output Names:`, outputNames);

      // Log some raw scores if possible to see if the model is producing anything
      const topScoreName = outputNames[0]; // usually score_8
      const topScores = results[topScoreName].data;
      let maxScore = 0;
      for (let i = 0; i < topScores.length; i++) if (topScores[i] > maxScore) maxScore = topScores[i];
      console.log(`[FaceEngineWeb] Max raw score in ${topScoreName}: ${maxScore.toFixed(4)}`);

      faces = decodeSCRFD(results, outputNames, invScale, detThresh);
      console.log(`[FaceEngineWeb] decodeSCRFD found ${faces.length} candidates above threshold ${detThresh}`);

      if (faces.length > 0) {
        faces.forEach((f, i) => {
          const [x1, y1, x2, y2] = f.bbox;
          console.log(`[FaceEngineWeb]   Candidate ${i+1}: score=${f.score.toFixed(4)} | bbox=[${Math.round(x1)}, ${Math.round(y1)}, ${Math.round(x2)}, ${Math.round(y2)}] | size=${Math.round(x2-x1)}x${Math.round(y2-y1)}`);
        });
      }

      // Dispose output tensors — WASM heap is not GC'd, must be freed explicitly
      for (const t of Object.values(results)) t.dispose?.();
    } finally {
      // Always dispose input tensor, even if session.run() throws
      inputTensor.dispose();
    }

    faces = applyNMS(faces);
    console.log(`[FaceEngineWeb] After NMS: ${faces.length} faces remain`);

    if (minFaceSize > 0) {
      const beforeFilter = faces.length;
      faces = faces.filter(f => {
        const [x1, y1, x2, y2] = f.bbox;
        return Math.min(x2 - x1, y2 - y1) >= minFaceSize;
      });
      console.log(`[FaceEngineWeb] After size filter (> ${minFaceSize}px): ${faces.length} remain (removed ${beforeFilter - faces.length})`);
    }

    return { faces, imageWidth: W, imageHeight: H };
  }

  async detectFacesYuNet(img, opts = {}) {
    console.log('[FaceEngineWeb] detectFacesYuNet (placeholder) called');
    // For now, fall back to SCRFD as YuNet implementation for Web is more complex 
    // due to different preprocessing and output format.
    return this.detectFaces(img, opts);
  }

  // ── MediaPipe detection (optional, GPU-accelerated on mobile) ───────────────

  async _initMediaPipe() {
    if (this._mpLandmarker) return;
    this._progress('Loading MediaPipe FaceLandmarker…');
    const { FaceLandmarker, FilesetResolver } = await import('@mediapipe/tasks-vision');
    // Use locally-served WASM files (copied to /mediapipe/ by vite-plugin-static-copy).
    // This avoids hitting cdn.jsdelivr.net, enabling offline / LAN-only use.
    const vision = await FilesetResolver.forVisionTasks('/mediapipe/');
    // Prefer the model served by the connected API server (cached after first fetch).
    // Fall back to Google's CDN if the server doesn't have the file yet.
    const localTaskUrl  = '/models/face_landmarker.task';
    const cdnTaskUrl    = 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';
    let modelAssetPath  = cdnTaskUrl;
    try {
      const probe = await fetch(localTaskUrl, { method: 'HEAD' });
      if (probe.ok) modelAssetPath = localTaskUrl;
    } catch { /* server unreachable — use CDN */ }
    console.log(`[FaceEngineWeb] MediaPipe model source: ${modelAssetPath === localTaskUrl ? 'local server' : 'CDN'}`);
    this._mpLandmarker = await FaceLandmarker.createFromOptions(vision, {
      baseOptions: {
        modelAssetPath,
        delegate: 'GPU',
      },
      outputFaceBlendshapes: false,
      runningMode: 'IMAGE',
      numFaces: 20,
    });
    this._progress('MediaPipe ready');
  }

  /**
   * Detect faces with MediaPipe FaceLandmarker.
   * Returns same shape as detectFaces(): { faces, imageWidth, imageHeight }
   *
   * Landmark remapping: from the 478-point MediaPipe mesh we extract the 5 points
   * that correspond to the ArcFace canonical positions (left-eye, right-eye, nose,
   * left-mouth, right-mouth) using MP_LANDMARK_IDX = [33, 263, 1, 61, 291].
   */
  async detectFacesMediaPipe(img, opts = {}) {
    console.log('[FaceEngineWeb] detectFacesMediaPipe START');
    await this._initMediaPipe();
    const W = img.naturalWidth  || img.width;
    const H = img.naturalHeight || img.height;

    const mpResults = this._mpLandmarker.detect(img);
    const faces = [];

    for (let fi = 0; fi < mpResults.faceLandmarks.length; fi++) {
      const lms = mpResults.faceLandmarks[fi];

      // 5 ArcFace-compatible landmarks (pixel coordinates)
      const landmarks = MP_LANDMARK_IDX.map(idx => [lms[idx].x * W, lms[idx].y * H]);

      // Bounding box from all 478 landmarks
      let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
      for (const lm of lms) {
        x1 = Math.min(x1, lm.x * W); y1 = Math.min(y1, lm.y * H);
        x2 = Math.max(x2, lm.x * W); y2 = Math.max(y2, lm.y * H);
      }

      // Confidence from detection result if available, else 1.0
      const score = mpResults.faceDetections?.[fi]?.categories?.[0]?.score ?? 1.0;
      faces.push({ bbox: [x1, y1, x2, y2], score, landmarks });
    }

    console.log(`[FaceEngineWeb] detectFacesMediaPipe found ${faces.length} faces`);
    return { faces, imageWidth: W, imageHeight: H };
  }

  // ── ArcFace embedding ────────────────────────────────────────────────────────

  async embedFace(img, landmarks) {
    await this._initRecognizer();
    const faceCanvas = this._cropFace(img, landmarks);
    const inputTensor = this._faceCanvasToArcFaceTensor(faceCanvas);
    try {
      const result = await this._recSession.run({
        [this._recSession.inputNames[0]]: inputTensor,
      });
      const raw = Array.from(result[this._recSession.outputNames[0]].data);
      // Dispose output tensors — WASM heap is not GC'd, must be freed explicitly
      for (const t of Object.values(result)) t.dispose?.();
      return l2normalize(raw);
    } finally {
      inputTensor.dispose();
    }
  }

  // ── Full pipeline ────────────────────────────────────────────────────────────

  /**
   * Process a File/Blob through the full detection + embedding pipeline.
   * Returns a payload compatible with POST /api/ingest/import-processed.
   *
   * opts:
   *   det_thresh    number  (default 0.5)
   *   min_face_size number  (default 0)
   *   det_model     string  'auto' | 'mediapipe'  (default 'auto' → SCRFD)
   *   visibility    string  (default 'shared')
   *   onProgress    fn(msg) progress callback
   */
  async processFile(file, opts = {}) {
    console.log(`[FaceEngineWeb] processFile START | file=${file.name} | size=${file.size} | type=${file.type}`);
    if (opts.onProgress) this.onProgress = opts.onProgress;

    const img = await this._loadImage(file);
    const W   = img.naturalWidth  || img.width;
    const H   = img.naturalHeight || img.height;
    console.log(`[FaceEngineWeb] processFile loaded image: ${W}x${H}`);

    // ── Detection ──────────────────────────────────────────────────────────────
    this._progress('Detecting faces…');
    let detection;
    const runDetection = async (currentOpts) => {
      const model = currentOpts.det_model || 'auto';
      if (model === 'mediapipe') {
        return await this.detectFacesMediaPipe(img, currentOpts);
      } else if (model === 'yunet') {
        return await this.detectFacesYuNet(img, currentOpts);
      } else {
        return await this.detectFaces(img, currentOpts);
      }
    };

    console.log(`[FaceEngineWeb] processFile: invoking initial detection (model=${opts.det_model || 'auto'})`);
    detection = await runDetection(opts);
    
    // Retry logic if 0 faces found and fallback is enabled
    if (detection.faces.length === 0 && (opts.det_model || 'auto') !== 'none') {
      const retries = opts.max_retries ?? 1;
      let currentThresh = opts.det_thresh ?? 0.5;
      let currentMinSize = opts.min_face_size ?? 0;

      for (let i = 0; i < retries; i++) {
        currentThresh = Math.max(0.1, currentThresh - 0.15);
        currentMinSize = Math.max(0, Math.min(20, currentMinSize - 20)); // Don't drop below 0, but be aggressive for retries
        console.log(`[FaceEngineWeb] 0 faces found. Retry ${i + 1}/${retries} with thresh=${currentThresh.toFixed(2)}, minSize=${currentMinSize}`);
        
        this._progress(`Retrying detection (${i + 1}/${retries})…`);
        const retryDetection = await runDetection({
          ...opts,
          det_thresh: currentThresh,
          min_face_size: currentMinSize
        });

        if (retryDetection.faces.length > 0) {
          console.log(`[FaceEngineWeb] Retry ${i + 1} SUCCESS: found ${retryDetection.faces.length} faces`);
          detection = retryDetection;
          break;
        }
      }
    }

    const { faces } = detection;
    console.log(`[FaceEngineWeb] processFile: detection complete. Final face count: ${faces.length}`);
    this._progress(`${faces.length} face(s) found — computing embeddings…`);

    // ── Embedding ──────────────────────────────────────────────────────────────
    const facePayloads = [];
    for (let fi = 0; fi < faces.length; fi++) {
      this._progress(`Embedding face ${fi + 1}/${faces.length}…`);
      const embedding = await this.embedFace(img, faces[fi].landmarks);
      const [x1, y1, x2, y2] = faces[fi].bbox;
      facePayloads.push({
        bbox_left:            Math.max(0, x1 / W),
        bbox_top:             Math.max(0, y1 / H),
        bbox_right:           Math.min(1, x2 / W),
        bbox_bottom:          Math.min(1, y2 / H),
        detection_confidence: faces[fi].score,
        embedding:            embedding,
        embedding_dimension:  embedding.length,
      });
    }

    console.log(`[FaceEngineWeb] processFile: embedding complete for ${faces.length} faces`);

    // ── Thumbnail ──────────────────────────────────────────────────────────────
    const THUMB = opts.thumb_size || 200;
    console.log(`[FaceEngineWeb] Generating ${THUMB}px thumbnail...`);
    const tW = Math.round(THUMB * W / Math.max(W, H));
    const tH = Math.round(THUMB * H / Math.max(W, H));
    const thumbCanvas = new OffscreenCanvas(tW, tH);
    thumbCanvas.getContext('2d').drawImage(img, 0, 0, tW, tH);
    const thumbBlob   = await thumbCanvas.convertToBlob({ type: 'image/jpeg', quality: 0.75 });
    const thumbData64 = await blobToBase64(thumbBlob);
    const thumbnail_b64 = thumbData64.replace(/^data:[^;]+;base64,/, '');

    // ── SHA-256 hash ───────────────────────────────────────────────────────────
    const fileBuffer = await file.arrayBuffer();
    const hashBuffer = await crypto.subtle.digest('SHA-256', fileBuffer);
    const file_hash  = Array.from(new Uint8Array(hashBuffer))
      .map(b => b.toString(16).padStart(2, '0')).join('');

    // ── VLM Enrichment (Standalone mode) ──────────────────────────────────────
    let vlmResult = null;
    console.error('[FaceEngineWeb] VLM PRE-CHECK:', { 
      vlm_enabled: opts.vlm_enabled, 
      vlm_enabled_type: typeof opts.vlm_enabled,
      provider: opts.vlm_provider, 
      has_keys: !!opts.vlm_keys
    });

    if (opts.vlm_enabled === true || opts.vlm_enabled === 'true') {
      console.error('[FaceEngineWeb] VLM IS ENABLED, checking provider...');
      if (!opts.vlm_provider) {
        console.error('[FaceEngineWeb] VLM enabled but no provider specified. Skipping.');
        this._progress('VLM skipped (no provider)');
      } else {
        try {
          this._progress('AI Enrichment (VLM)…');
          console.error('[FaceEngineWeb] Starting VLM enrichment process...');
          const vlmMod = await import('./VlmWeb.js');
          const vlmClientWeb = vlmMod.vlmClientWeb ?? vlmMod.default;
          if (!vlmClientWeb || typeof vlmClientWeb.setKeys !== 'function') {
            throw new Error('VlmWeb module failed to provide vlmClientWeb instance (tree-shaking issue?)');
          }

          let keys = opts.vlm_keys;
          if (!keys) {
            console.error('[FaceEngineWeb] No VLM keys passed to processFile. VLM might fail if keys are needed.');
            keys = {};
          }
          
          vlmClientWeb.setKeys(keys);
          
          const prompt = opts.vlm_prompt || 'Describe this image in detail.';
          const provider = opts.vlm_provider || 'anthropic';
          const model = opts.vlm_model || '';
          
          console.error(`[FaceEngineWeb] Calling vlmClientWeb.enrichImage | provider=${provider} | model=${model || '(default)'}`);
          if (!vlmClientWeb) {
            throw new Error("vlmClientWeb is not initialized or imported correctly");
          }
          vlmResult = await vlmClientWeb.enrichImage(file, provider, model, prompt, opts.vlm_max_size || 0);
          console.error('[FaceEngineWeb] VLM enrichment SUCCESS:', vlmResult);
          this._progress('AI Enrichment done');
        } catch (e) {
          console.error('[FaceEngineWeb] VLM enrichment CRITICAL FAILURE:', e);
          this._progress(`AI Enrichment failed (${opts.vlm_provider}): ${e.message}`);
        }
      }
    } else {
      console.error('[FaceEngineWeb] VLM enrichment SKIPPED (vlm_enabled is false/falsy)');
    }

    this._progress('Done');

    return {
      local_path:    file.name,
      filename:      file.name,
      width:         W,
      height:        H,
      file_size:     file.size,
      file_hash,
      thumbnail_b64,
      local_model:   'buffalo_l',
      faces:         facePayloads,
      visibility:    opts.visibility || 'shared',
      description:   vlmResult?.description || null,
      scene_type:    vlmResult?.scene_type || null,
      tags:          vlmResult?.tags || [],
    };
  }
}

// ── Voy-search helper (optional local HNSW index) ────────────────────────────

/**
 * Build a voy-search index from enrolled person embeddings fetched from the API.
 * Useful for fully-offline recognition after a one-time sync.
 *
 * Usage:
 *   const index = await buildVoyIndex(people);
 *   const matches = index.search(queryEmbedding, k);  // → [{ id, title, score }]
 *
 * @param {Array<{ id, name, embedding: number[] }>} people
 */
export async function buildVoyIndex(people) {
  const { Voy } = await import('voy-search');
  const embeddings = people.map(p => ({
    id:         String(p.id),
    title:      p.name,
    url:        '',
    embeddings: p.embedding,
  }));
  return new Voy({ embeddings });
}

// ── Singleton ────────────────────────────────────────────────────────────────

export const faceEngineWeb = new FaceEngineWeb();
export default faceEngineWeb;
