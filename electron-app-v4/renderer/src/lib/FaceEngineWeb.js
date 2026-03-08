/* FACE_ENGINE_WEB_VERSION: v4.0.260307.1200 */
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
function _getOrtProviders(forceProvider = null) {
  if (forceProvider) return [forceProvider];
  const isAndroid = typeof navigator !== 'undefined' && /Android/i.test(navigator.userAgent);
  const providers = [];
  if (_ortPrefs.webgpu && !isAndroid) providers.push('webgpu');
  if (_ortPrefs.webgl && !isAndroid) providers.push('webgl');
  providers.push('wasm');
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
// ── Memory Tracking ──────────────────────────────────────────────────────────

function getMemoryUsage() {
  if (typeof performance !== 'undefined' && performance.memory) {
    return (performance.memory.usedJSHeapSize / (1024 * 1024)).toFixed(2);
  }
  return 'N/A';
}

function logMemory(label) {
  const mb = getMemoryUsage();
  console.log(`%c[Memory] ${label}: ${mb} MB`, 'color: #aaa; font-style: italic');
}

logMemory('Module Initialized');


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

console.log("%c[FaceEngineWeb] Module Loaded | Version: v4.0.260307.1200", "color: #60c060; font-weight: bold");
export class FaceEngineWeb {
  constructor() {
    this._detSession  = null;
    this._recSession  = null;
    this._mpDetector  = null;
    this._mpLandmarker = null;
    this.modelBaseUrl = (typeof self !== 'undefined' ? self.location.origin : '') + '/models/';
    this.onProgress   = null;
  }

  setModelBaseUrl(url) {
    let absolute = url;
    if (url.startsWith('/')) {
      absolute = (typeof self !== 'undefined' ? self.location.origin : '') + url;
    }
    this.modelBaseUrl = absolute.endsWith('/') ? absolute : absolute + '/';
  }

  _progress(msg) {
    if (this.onProgress) this.onProgress(msg);
  }

  async _fetchModelCached(filename) {
    const canonicalKey = `http://onnx-model.local/${filename}`;
    const fetchUrl = `${this.modelBaseUrl}${filename}`;
    const fallbackUrls = {
      'det_10g.onnx':  'https://huggingface.co/lithiumice/insightface/resolve/main/models/buffalo_l/det_10g.onnx',
      'w600k_r50.onnx': 'https://huggingface.co/lithiumice/insightface/resolve/main/models/buffalo_l/w600k_r50.onnx'
    };
    const fallbackUrl = fallbackUrls[filename];

    if ('caches' in globalThis) {
      const cache = await caches.open(MODEL_CACHE_NAME);
      let resp = await cache.match(canonicalKey);
      if (!resp) resp = await cache.match(fetchUrl);
      if (!resp) {
        this._progress(`Downloading ${filename}…`);
        try {
          console.log(`[FaceEngineWeb] Fetching ${filename} from ${fetchUrl}`);
          resp = await fetch(fetchUrl);
          const ct = resp.headers.get('content-type') || '';
          if (ct.includes('text/html')) throw new Error(`Server returned HTML instead of ${filename}`);
          if (!resp.ok) throw new Error(`Server fetch failed: ${resp.status}`);
        } catch (e) {
          if (fallbackUrl) {
            resp = await fetch(fallbackUrl);
            if (!resp.ok) throw new Error(`Mirror failed: ${resp.status}`);
          } else throw e;
        }
        await cache.put(canonicalKey, resp.clone());
      }
      return resp.arrayBuffer();
    }
    const resp = await fetch(fetchUrl);
    return resp.arrayBuffer();
  }

  async downloadModels(onProgress) {
    for (const f of ['det_10g.onnx', 'w600k_r50.onnx']) {
      onProgress?.(`Downloading ${f}…`);
      await this._fetchModelCached(f);
    }
    return { ok: true };
  }

  async releaseModels() {
    console.log('[FaceEngineWeb] Releasing all models from memory...');
    try {
      if (this._detSession) { await this._detSession.release(); this._detSession = null; }
      if (this._recSession) { await this._recSession.release(); this._recSession = null; }
      console.log('[FaceEngineWeb] Release complete.');
    } catch (err) { console.warn('[FaceEngineWeb] Error during model release:', err); }
  }

  async getModelCacheStatus() {
    if (!('caches' in globalThis)) return { det_10g: false, w600k_r50: false };
    const cache = await caches.open(MODEL_CACHE_NAME);
    const keys = await cache.keys();
    const keyStrings = keys.map(r => r.url || String(r));
    return { 
      det_10g: keyStrings.some(k => k.includes('det_10g')), 
      w600k_r50: keyStrings.some(k => k.includes('w600k_r50')) 
    };
  }

  async _initDetector(forceProvider = null) {
    if (this._detSession) return;
    this._progress('Loading SCRFD detector…');
    const buf = await this._fetchModelCached('det_10g.onnx');
    // Hybrid Strategy: Detector MUST use WASM on Safari/Firefox due to AveragePool ceil bug
    let providers = forceProvider ? [forceProvider] : ['wasm'];
    console.log(`[FaceEngineWeb] Initializing Detector | providers=${providers}`);
    this._detSession = await ort.InferenceSession.create(buf, {
      executionProviders: providers,
      graphOptimizationLevel: 'all',
      enableCpuMemArena: true, enableMemPattern: true,
    });
    this._progress('Detector ready');
  }

  async _initRecognizer(forceProvider = null) {
    if (this._recSession) return;
    this._progress('Loading ArcFace recognizer…');
    const buf = await this._fetchModelCached('w600k_r50.onnx');
    // Hybrid Strategy: Recognizer is compute heavy, GPU acceleration is great here!
    let providers = forceProvider ? [forceProvider] : _getOrtProviders();
    console.log(`[FaceEngineWeb] Initializing Recognizer | providers=${providers}`);
    this._recSession = await ort.InferenceSession.create(buf, {
      executionProviders: providers,
      graphOptimizationLevel: 'all',
      enableCpuMemArena: true, enableMemPattern: true,
    });
    this._progress('Recognizer ready');
  }

  async _loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload  = () => resolve(img);
      img.onerror = reject;
      if (src instanceof Blob) img.src = URL.createObjectURL(src);
      else img.src = src;
    });
  }

  _letterbox(img) {
    const W = img.naturalWidth || img.width;
    const H = img.naturalHeight || img.height;
    const isMobile = /Android|iPhone|iPad/i.test(navigator.userAgent);
    const MAX_PRE_SCALE = isMobile ? 1600 : 4000;
    let source = img;
    let currentW = W, currentH = H;
    if (Math.max(W, H) > MAX_PRE_SCALE) {
      const scale = MAX_PRE_SCALE / Math.max(W, H);
      currentW = Math.round(W * scale); currentH = Math.round(H * scale);
      const preCanvas = new OffscreenCanvas(currentW, currentH);
      preCanvas.getContext('2d').drawImage(img, 0, 0, currentW, currentH);
      source = preCanvas;
    }
    const scale = Math.min(SCRFD_SIZE / currentW, SCRFD_SIZE / currentH);
    const newW = Math.round(currentW * scale); const newH = Math.round(currentH * scale);
    const invScale = Math.max(W, H) / SCRFD_SIZE;
    const canvas = new OffscreenCanvas(SCRFD_SIZE, SCRFD_SIZE);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, SCRFD_SIZE, SCRFD_SIZE);
    ctx.drawImage(source, 0, 0, newW, newH);
    return { canvas, invScale };
  }

  _canvasToSCRFDTensor(canvas) {
    const ctx = canvas.getContext('2d');
    const px = SCRFD_SIZE * SCRFD_SIZE;
    const rgba = ctx.getImageData(0, 0, SCRFD_SIZE, SCRFD_SIZE).data;
    const f32 = new Float32Array(3 * px);
    for (let i = 0; i < px; i++) {
      f32[i] = (rgba[i * 4] - 127.5) / 128.0;
      f32[i + px] = (rgba[i * 4 + 1] - 127.5) / 128.0;
      f32[i + px * 2] = (rgba[i * 4 + 2] - 127.5) / 128.0;
    }
    return new ort.Tensor('float32', f32, [1, 3, SCRFD_SIZE, SCRFD_SIZE]);
  }

  _cropFace(img, landmarks) {
    const { a, b, tx, ty } = similarityTransform(landmarks, ARC_DST);
    const canvas = new OffscreenCanvas(ARCFACE_SIZE, ARCFACE_SIZE);
    const ctx = canvas.getContext('2d');
    ctx.setTransform(a, b, -b, a, tx, ty);
    ctx.drawImage(img, 0, 0);
    ctx.resetTransform();
    return canvas;
  }

  _faceCanvasToArcFaceTensor(canvas) {
    const ctx = canvas.getContext('2d');
    const sp = ARCFACE_SIZE * ARCFACE_SIZE;
    const rgba = ctx.getImageData(0, 0, ARCFACE_SIZE, ARCFACE_SIZE).data;
    const f32 = new Float32Array(3 * sp);
    for (let i = 0; i < sp; i++) {
      f32[i] = (rgba[i * 4 + 2] - 127.5) / 128.0;
      f32[i + sp] = (rgba[i * 4 + 1] - 127.5) / 128.0;
      f32[i + sp * 2] = (rgba[i * 4] - 127.5) / 128.0;
    }
    return new ort.Tensor('float32', f32, [1, 3, ARCFACE_SIZE, ARCFACE_SIZE]);
  }

  async detectFaces(img, opts = {}) {
    const detThresh = opts.det_thresh ?? 0.5;
    const minFaceSize = opts.min_face_size ?? 0;
    const W = img.naturalWidth || img.width;
    const H = img.naturalHeight || img.height;
    await this._initDetector();
    const { canvas, invScale } = this._letterbox(img);
    const inputTensor = this._canvasToSCRFDTensor(canvas);
    try {
      const results = await this._detSession.run({ [this._detSession.inputNames[0]]: inputTensor });
      if (!this._detSession) throw new Error("Detector session is null");
      let faces = decodeSCRFD(results, this._detSession.outputNames, invScale, detThresh);
      for (const t of Object.values(results)) t.dispose?.();
      faces = applyNMS(faces);
      if (minFaceSize > 0) faces = faces.filter(f => Math.min(f.bbox[2]-f.bbox[0], f.bbox[3]-f.bbox[1]) >= minFaceSize);
      return { faces, imageWidth: W, imageHeight: H };
    } finally { inputTensor.dispose(); }
  }

  async embedFace(img, landmarks) {
    await this._initRecognizer();
    const faceCanvas = this._cropFace(img, landmarks);
    const inputTensor = this._faceCanvasToArcFaceTensor(faceCanvas);
    try {
      const result = await this._recSession.run({ [this._recSession.inputNames[0]]: inputTensor });
      const raw = Array.from(result[this._recSession.outputNames[0]].data);
      for (const t of Object.values(result)) t.dispose?.();
      return l2normalize(raw);
    } finally { inputTensor.dispose(); }
  }

  
  async runInferenceBenchmark(file, progressCallback) {
    logMemory('Benchmark START');
    const results = [];
    const backends = [
      { name: 'WASM', ep: 'wasm', simd: false },
      { name: 'WASM + SIMD', ep: 'wasm', simd: true },
      { name: 'WebGL', ep: 'webgl', simd: true },
      { name: 'WebGPU', ep: 'webgpu', simd: true }
    ];
    const originalPrefs = { ..._ortPrefs };
    for (const b of backends) {
      try {
        if (progressCallback) progressCallback(`Testing ${b.name}...`);
        logMemory(`Before ${b.name}`);
        await this.releaseModels();
        _ortPrefs.simd = b.simd; ort.env.wasm.simd = b.simd;
        const loadStart = performance.now();
        let detLoadOk = false; let recLoadOk = false;
        let detRunOk = false; let recRunOk = false;
        let detErr = ''; let recErr = '';
        try { await this._initDetector(b.ep); detLoadOk = true; } catch(e) { detErr = e.message; }
        try { await this._initRecognizer(b.ep); recLoadOk = true; } catch(e) { recErr = e.message; }
        const warmupMs = Math.round(performance.now() - loadStart);
        let detMs = 0; let recMs = 0;
        if (detLoadOk) {
          try {
            const start = performance.now();
            const dummyInput = new ort.Tensor('float32', new Float32Array(3 * 640 * 640), [1, 3, 640, 640]);
            await this._detSession.run({ [this._detSession.inputNames[0]]: dummyInput });
            detMs = Math.round(performance.now() - start);
            detRunOk = true; dummyInput.dispose();
          } catch(e) { detErr = e.message; }
        }
        if (recLoadOk) {
          try {
            const start = performance.now();
            const dummyInput = new ort.Tensor('float32', new Float32Array(3 * 112 * 112), [1, 3, 112, 112]);
            await this._recSession.run({ [this._recSession.inputNames[0]]: dummyInput });
            recMs = Math.round(performance.now() - start);
            recRunOk = true; dummyInput.dispose();
          } catch(e) { recErr = e.message; }
        }
        let status = '✓';
        if (detRunOk && recRunOk) { status = `✓ D:${detMs}ms R:${recMs}ms`; }
        else {
          status = '';
          if (!detLoadOk) status += 'Det:L-FAIL '; else if (!detRunOk) status += 'Det:R-FAIL '; else status += `D:${detMs}ms `;
          if (!recLoadOk) status += 'Rec:L-FAIL'; else if (!recRunOk) status += 'Rec:R-FAIL'; else status += `R:${recMs}ms`;
        }
        const currentMem = getMemoryUsage();
        results.push({
          backend: b.name, warmup_ms: warmupMs, duration_ms: detMs + recMs,
          faces: detRunOk ? 'OK' : '0', status: status, success: detRunOk || recRunOk,
          memory_mb: currentMem
        });
        logMemory(`After ${b.name}`);
      } catch (err) { results.push({ backend: b.name, error: err.message, success: false, status: '✗ Fatal' }); }
    }
    Object.assign(_ortPrefs, originalPrefs);
    ort.env.wasm.simd = _ortPrefs.simd;
    await this.releaseModels();
    logMemory('Benchmark END');
    return results;
  }

  async processFile(fileOrBase64, opts = {}) {
    let file = fileOrBase64;
    if (typeof fileOrBase64 === 'string' && fileOrBase64.includes(';base64,')) {
      const parts = fileOrBase64.split(',');
      const mime = parts[0].match(/:(.*?);/)[1];
      const bstr = atob(parts[1]);
      let n = bstr.length;
      const u8arr = new Uint8Array(n);
      while(n--) u8arr[n] = bstr.charCodeAt(n);
      file = new File([u8arr], 'image.jpg', { type: mime });
    }
    const img = await this._loadImage(file);
    const W = img.naturalWidth || img.width;
    const H = img.naturalHeight || img.height;
    this._progress('Detecting faces…');
    const detection = await this.detectFaces(img, opts);
    const { faces } = detection;
    this._progress(`${faces.length} face(s) found — computing embeddings…`);
    const facePayloads = [];
    for (let fi = 0; fi < faces.length; fi++) {
      const embedding = await this.embedFace(img, faces[fi].landmarks);
      const [x1, y1, x2, y2] = faces[fi].bbox;
      facePayloads.push({
        bbox_left: Math.max(0, x1/W), bbox_top: Math.max(0, y1/H),
        bbox_right: Math.min(1, x2/W), bbox_bottom: Math.min(1, y2/H),
        detection_confidence: faces[fi].score, embedding, embedding_dimension: embedding.length,
      });
    }
    const THUMB = opts.thumb_size || 200;
    const tW = Math.round(THUMB * W / Math.max(W, H));
    const tH = Math.round(THUMB * H / Math.max(W, H));
    const thumbCanvas = new OffscreenCanvas(tW, tH);
    thumbCanvas.getContext('2d').drawImage(img, 0, 0, tW, tH);
    const thumbBlob = await thumbCanvas.convertToBlob({ type: 'image/jpeg', quality: 0.75 });
    const thumbnail_b64 = (await blobToBase64(thumbBlob)).replace(/^data:[^;]+;base64,/, '');
    const file_hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', await file.arrayBuffer())))
      .map(b => b.toString(16).padStart(2, '0')).join('');
    
    let vlmResult = null;
    if (opts.vlm_enabled === true || opts.vlm_enabled === 'true') {
      try {
        const vlmMod = await import('./VlmWeb.js?t=' + Date.now());
        const vlmClientWeb = vlmMod.vlmClientWeb ?? vlmMod.default;
        vlmClientWeb.setKeys(opts.vlm_keys || {});
        vlmResult = await vlmClientWeb.enrichImage(file, opts.vlm_provider, opts.vlm_model, opts.vlm_prompt, opts.vlm_max_size || 0);
      } catch (e) { console.error('VLM failed:', e); }
    }
    
    if (img && img.src && img.src.startsWith('blob:')) URL.revokeObjectURL(img.src);
    
    return {
      local_path: file.name, filename: file.name, width: W, height: H,
      file_size: file.size, file_hash, thumbnail_b64, local_model: 'buffalo_l',
      faces: facePayloads, visibility: opts.visibility || 'shared',
      description: vlmResult?.description || null, scene_type: vlmResult?.scene_type || null,
      tags: vlmResult?.tags || [],
    };
  }
}

export const faceEngineWeb = new FaceEngineWeb();
export default faceEngineWeb;
