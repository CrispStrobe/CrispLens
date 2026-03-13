/* FACE_ENGINE_WEB_VERSION: v4.0.260308.2300 */
import * as ort from 'onnxruntime-web';

// Configure onnxruntime-web WASM paths
// For standalone/PWA, we MUST use a relative path so the Service Worker can intercept/cache it.
const wasmBase = '/ort-wasm/';
console.log(`[FaceEngineWeb] Setting wasmPaths to: ${wasmBase}`);
ort.env.wasm.wasmPaths = wasmBase;
ort.env.wasm.numThreads = 1;
ort.env.wasm.proxy = false;

// WebGPU: prefer NHWC memory layout.
// ResNet/VGG models have many Transpose ops when forced to NCHW on WebGPU, and ORT 1.21
// triggers a "Transpose called recursively" runtime error. With NHWC preference, ORT
// inserts a single input transpose and runs all conv ops natively in GPU-friendly order,
// eliminating the recursive transpose problem. (NCHW is still passed in from JS — ORT
// handles the layout conversion internally.)
if (typeof ort.env.webgpu !== 'undefined') {
  ort.env.webgpu.preferredLayout = 'NHWC';
}

const _ls = typeof localStorage !== 'undefined' ? localStorage : null;
// In Electron the WebGL EP is off by default (unreliable in embedded Chromium).
// The user can enable it via Settings → WASM Backend preferences; we then respect their choice.
// In browser/PWA: WebGL is on by default.
const _inElectron = typeof window !== 'undefined' && typeof window.electronAPI !== 'undefined';
const _webglStored = _ls?.getItem('pref_ort_use_webgl');
const _ortPrefs = {
  simd:   _ls?.getItem('pref_ort_use_simd')   === 'true',
  webgl:  _webglStored !== null ? _webglStored !== 'false' : !_inElectron,
  webgpu: _ls?.getItem('pref_ort_use_webgpu') === 'true',
};
ort.env.wasm.simd = _ortPrefs.simd;

// det_10g.onnx (SCRFD-10GF) uses AveragePool with ceil_mode=1 in its context attention
// module. ORT WebGPU does not implement ceil-mode shape computation, so the detector
// always runs on WASM regardless of the requested EP. Recognition (w600k_r50.onnx) is a
// standard ResNet50 and works on WebGPU with NHWC layout.
const DET_WEBGPU_INCOMPATIBLE = true;

function _getOrtProviders(forDet = false) {
  const isAndroid = typeof navigator !== 'undefined' && /Android/i.test(navigator.userAgent);
  // Detector is WebGPU-incompatible: always use wasm for it.
  if (forDet) {
    if (_ortPrefs.webgl && !isAndroid) return ['webgl', 'wasm'];
    return ['wasm'];
  }
  // Recognizer: full GPU preference allowed.
  const providers = [];
  if (_ortPrefs.webgpu && !isAndroid) providers.push('webgpu');
  if (_ortPrefs.webgl  && !isAndroid) providers.push('webgl');
  providers.push('wasm');
  return providers;
}

/** Build provider list for session creation.
 *  GPU EPs always include 'wasm' as fallback for unsupported ops.
 *  `forDet=true` forces WASM-only for the detector (WebGPU-incompatible model). */
function _buildProviders(forceProvider, forDet) {
  if (forceProvider) {
    // In benchmark: if forcing webgpu on the detector, we still must exclude it.
    if (forceProvider === 'webgpu' && forDet) return ['wasm'];
    return forceProvider === 'wasm' ? ['wasm'] : [forceProvider, 'wasm'];
  }
  return _getOrtProviders(forDet);
}

const SCRFD_SIZE   = 640;
const ARCFACE_SIZE = 112;
const NUM_ANCHORS  = 2;
const NMS_THRESH   = 0.4;
const MODEL_CACHE_NAME = 'crisplens-onnx-models-v1';
const ARC_DST = [[38.2946, 51.6963],[73.5318, 51.5014],[56.0252, 71.7366],[41.5493, 92.3655],[70.7299, 92.2041]];

function similarityTransform(src, dst) {
  const n = src.length; let scx=0,scy=0,dcx=0,dcy=0;
  for(let i=0;i<n;i++){ scx+=src[i][0]; scy+=src[i][1]; dcx+=dst[i][0]; dcy+=dst[i][1]; }
  scx/=n; scy/=n; dcx/=n; dcy/=n;
  let num_a=0,num_b=0,denom=0;
  for(let i=0;i<n;i++){
    const xs=src[i][0]-scx, ys=src[i][1]-scy, xd=dst[i][0]-dcx, yd=dst[i][1]-dcy;
    num_a+=xs*xd+ys*yd; num_b+=xs*yd-ys*xd; denom+=xs*xs+ys*ys;
  }
  const a=num_a/denom, b=num_b/denom;
  return { a, b, tx: dcx-a*scx+b*scy, ty: dcy-b*scx-a*scy };
}

function decodeSCRFD(outputs, outputNames, invScale, detThresh) {
  // bbox/kps raw values are in STRIDE UNITS — must multiply by stride before converting to pixels.
  // Matches InsightFace Python: bbox_preds = net_outs[idx+fmc] * stride
  const strides = [8, 16, 32]; const faces = [];
  for (let si=0; si<strides.length; si++) {
    const stride=strides[si], feat=SCRFD_SIZE/stride, spatial=feat*feat;
    const scores=outputs[outputNames[si]].data, bboxes=outputs[outputNames[si+3]].data, kps=outputs[outputNames[si+6]].data;
    for (let idx=0; idx<spatial; idx++) {
      const row=Math.floor(idx/feat), col=idx%feat, cx=col*stride, cy=row*stride;
      for (let a=0; a<NUM_ANCHORS; a++) {
        const ai=idx*NUM_ANCHORS+a; if (scores[ai]<detThresh) continue;
        const bi=ai*4,
              x1=(cx-bboxes[bi  ]*stride)*invScale, y1=(cy-bboxes[bi+1]*stride)*invScale,
              x2=(cx+bboxes[bi+2]*stride)*invScale, y2=(cy+bboxes[bi+3]*stride)*invScale;
        const ki=ai*10, landmarks=[];
        for (let kp=0; kp<5; kp++) landmarks.push([
          (cx+kps[ki+kp*2  ]*stride)*invScale,
          (cy+kps[ki+kp*2+1]*stride)*invScale,
        ]);
        faces.push({ bbox:[x1,y1,x2,y2], score:scores[ai], landmarks });
      }
    }
  }
  return faces;
}

function applyNMS(faces) {
  const sorted = [...faces].sort((a,b)=>b.score-a.score);
  const keep = []; const suppressed = new Uint8Array(sorted.length);
  for(let i=0;i<sorted.length;i++){
    if(suppressed[i]) continue; keep.push(sorted[i]);
    for(let j=i+1;j<sorted.length;j++){
      if(!suppressed[j]){
        const a=sorted[i].bbox, b=sorted[j].bbox;
        const ix=Math.max(0,Math.min(a[2],b[2])-Math.max(a[0],b[0])), iy=Math.max(0,Math.min(a[3],b[3])-Math.max(a[1],b[1]));
        const inter=ix*iy, ua=(a[2]-a[0])*(a[3]-a[1])+(b[2]-b[0])*(b[3]-b[1])-inter;
        if(ua>0 && inter/ua>NMS_THRESH) suppressed[j]=1;
      }
    }
  }
  return keep;
}

function l2normalize(vec) {
  let n=0; for(let i=0;i<vec.length;i++) n+=vec[i]*vec[i];
  n=Math.sqrt(n); return n>0 ? vec.map(v=>v/n) : vec;
}

function blobToBase64(blob) {
  return new Promise((res, rej) => { const r=new FileReader(); r.onload=()=>res(r.result); r.onerror=rej; r.readAsDataURL(blob); });
}

function getMemoryUsage() {
  if (typeof window !== 'undefined' && window.performance && window.performance.memory) {
    return (window.performance.memory.usedJSHeapSize / (1024 * 1024)).toFixed(2);
  }
  return 'N/A';
}

function logMemory(label) {
  console.log(`%c[Memory] ${label}: ${getMemoryUsage()} MB`, 'color: #888; font-style: italic');
}

export class FaceEngineWeb {
  constructor() {
    this._detSession=null; this._recSession=null;
    this.modelBaseUrl=(typeof self!=='undefined' ? self.location.origin : '')+'/models/';
    this.onProgress=null;
    logMemory('Engine Initialized');
  }

  setModelBaseUrl(url) {
    let abs=url; if(url.startsWith('/')) abs=(typeof self!=='undefined' ? self.location.origin : '')+url;
    this.modelBaseUrl=abs.endsWith('/') ? abs : abs+'/';
  }

  _progress(m) { if(this.onProgress) this.onProgress(m); }

  async _fetchModelCached(filename) {
    const canonicalKey=`http://onnx-model.local/${filename}`;
    const fetchUrl=`${this.modelBaseUrl}${filename}`;
    if ('caches' in globalThis) {
      const cache=await caches.open(MODEL_CACHE_NAME);
      let resp=await cache.match(canonicalKey);
      if(!resp) resp=await cache.match(fetchUrl);
      if(!resp){
        console.log(`[FaceEngineWeb] Model ${filename} not in cache, fetching from ${fetchUrl}...`);
        this._progress(`Downloading ${filename}…`);
        resp=await fetch(fetchUrl);
        if(!resp.ok) {
          console.error(`[FaceEngineWeb] Fetch failed for ${filename}: ${resp.status}`);
          throw new Error(`Fetch failed: ${resp.status}`);
        }
        try { 
          await cache.put(canonicalKey, resp.clone()); 
          console.log(`[FaceEngineWeb] Model ${filename} saved to Cache API`);
        } catch(e) {
          console.warn('[FaceEngineWeb] Cache.put skipped (Electron/CSP restriction):', e.message);
        }
      } else {
        console.log(`[FaceEngineWeb] Model ${filename} loaded from Cache API`);
      }
      return resp.arrayBuffer();
    }
    console.log(`[FaceEngineWeb] Cache API not available, fetching ${filename} directly...`);
    const resp = await fetch(fetchUrl);
    if (!resp.ok) throw new Error(`Fetch failed for ${filename}: ${resp.status} ${resp.statusText}`);
    return resp.arrayBuffer();
  }

    async downloadModels(onProgress) {
    const results = {};
    for (const f of ['det_10g.onnx', 'w600k_r50.onnx']) {
      onProgress?.(`Downloading …`);
      try {
        await this._fetchModelCached(f);
        results[f] = 'ok';
      } catch (e) {
        results[f] = e.message;
      }
    }
    return results;
  }

  async releaseModels() {
    console.log('[FaceEngineWeb] Releasing all models from memory...');
    try {
      if(this._detSession){ await this._detSession.release(); this._detSession=null; this._detEp=null; }
      if(this._recSession){ await this._recSession.release(); this._recSession=null; this._recEp=null; }
      console.log('[FaceEngineWeb] Release complete.');
    } catch(e){}
  }

  async getModelCacheStatus() {
    if(!('caches' in globalThis)) return { det_10g:false, w600k_r50:false };
    const cache=await caches.open(MODEL_CACHE_NAME);
    const keys=await cache.keys();
    const ks=keys.map(r=>r.url||String(r));
    return { det_10g:ks.some(k=>k.includes('det_10g')), w600k_r50:ks.some(k=>k.includes('w600k_r50')) };
  }

  /** Create an InferenceSession with a timeout.
   *  InferenceSession.create() can silently hang if WASM compilation fails or
   *  the ORT runtime is unavailable — wrap it so we always get an error. */
  async _createSession(buf, opts, label) {
    const TIMEOUT_MS = 180_000; // 3 min — WASM JIT can be slow on first run
    const create = ort.InferenceSession.create(buf, opts);
    const timeout = new Promise((_, rej) =>
      setTimeout(() => rej(new Error(
        `${label}: InferenceSession.create timed out after ${TIMEOUT_MS/1000}s. ` +
        'Check that /ort-wasm/ WASM files are served correctly (DevTools → Network).'
      )), TIMEOUT_MS)
    );
    return Promise.race([create, timeout]);
  }

  async _initDetector(forceProvider = null) {
    if(this._detSession) return;
    this._progress('Loading SCRFD detector…');
    const buf=await this._fetchModelCached('det_10g.onnx');
    // det_10g.onnx is WebGPU-incompatible (AveragePool ceil_mode=1). Always uses WASM/WebGL.
    const providers = _buildProviders(forceProvider, true);
    console.log(`[FaceEngineWeb] Initializing Detector | providers=${providers}`);
    this._progress('Compiling detector (first run: ~30–120s)…');
    this._detSession=await this._createSession(buf, { executionProviders:providers, graphOptimizationLevel:'all' }, 'det_10g');
    this._detEp = providers[0];
    this._progress('Detector ready');
  }

  async _initRecognizer(forceProvider = null) {
    if(this._recSession) return;
    this._progress('Loading ArcFace recognizer…');
    const buf=await this._fetchModelCached('w600k_r50.onnx');
    // w600k_r50.onnx (ResNet50 ArcFace) works on WebGPU with NHWC layout (set globally above).
    const providers = _buildProviders(forceProvider, false);
    console.log(`[FaceEngineWeb] Initializing Recognizer | providers=${providers}`);
    this._progress('Compiling recognizer (first run: ~30–120s)…');
    this._recSession=await this._createSession(buf, { executionProviders:providers, graphOptimizationLevel:'all' }, 'w600k_r50');
    this._recEp = providers[0];
    this._progress('Recognizer ready');
  }

  /** Run a session, adding preferredOutputLocation:'cpu' for WebGPU sessions.
   *  WebGPU keeps output tensors on the GPU buffer by default; JS cannot read
   *  tensor.data without explicitly requesting CPU output location. */
  async _run(session, ep, inputs) {
    const opts = ep === 'webgpu' ? { preferredOutputLocation: 'cpu' } : {};
    return session.run(inputs, opts);
  }

  async _loadImage(src) {
    return new Promise((res, rej) => {
      const i=new Image(); i.crossOrigin='anonymous';
      i.onload=()=>res(i); i.onerror=rej;
      if(src instanceof Blob) i.src=URL.createObjectURL(src); else i.src=src;
    });
  }

  _letterbox(img) {
    const W=img.naturalWidth||img.width, H=img.naturalHeight||img.height;
    const invScale=Math.max(W,H)/SCRFD_SIZE;
    const canvas=new OffscreenCanvas(SCRFD_SIZE, SCRFD_SIZE);
    const ctx=canvas.getContext('2d');
    ctx.fillStyle='#000'; ctx.fillRect(0,0,SCRFD_SIZE,SCRFD_SIZE);
    const scale=Math.min(SCRFD_SIZE/W, SCRFD_SIZE/H);
    ctx.drawImage(img, 0, 0, Math.round(W*scale), Math.round(H*scale));
    return { canvas, invScale };
  }

  async processFile(fileOrBase64, opts={}) {
    let file=fileOrBase64;
    if(typeof fileOrBase64==='string' && fileOrBase64.includes(';base64,')){
      const p=fileOrBase64.split(','), m=p[0].match(/:(.*?);/)[1], b=atob(p[1]);
      let n=b.length; const u=new Uint8Array(n); while(n--) u[n]=b.charCodeAt(n);
      file=new File([u], 'image.jpg', {type:m});
    }
    
    // Set engine progress callback
    if (opts.onProgress) this.onProgress = opts.onProgress;

    console.log(`[FaceEngineWeb] processFile START | name=${file.name} size=${(file.size/1024).toFixed(1)}KB det_thresh=${opts.det_thresh??'default'} min_face=${opts.min_face_size??'default'} vlm=${opts.vlm_enabled?opts.vlm_provider:'off'}`);
    this._progress('Loading image…');
    
    const t0=performance.now();
    let img;
    try {
      img = await this._loadImage(file);
    } catch (e) {
      console.error(`[FaceEngineWeb] Failed to load image ${file.name}:`, e);
      this._progress('Error: Could not load image');
      throw e;
    }

    // Always revoke the blob URL when done, even on error.
    const imgBlobUrl = img.src.startsWith('blob:') ? img.src : null;
    try {
      const W=img.naturalWidth||img.width, H=img.naturalHeight||img.height;

      // ── Detection ─────────────────────────────────────────────────────────
      this._progress('Initializing detector…');
      await this._initDetector();
      
      this._progress('Running face detection…');
      let faces;
      {
        // Scoped block so canvas + pixel data are eligible for GC before recognition.
        const { canvas, invScale }=this._letterbox(img);
        const ctx=canvas.getContext('2d'), px=SCRFD_SIZE*SCRFD_SIZE;
        const rgba=ctx.getImageData(0,0,SCRFD_SIZE,SCRFD_SIZE).data;
        const it=new ort.Tensor('float32', new Float32Array(3*px), [1,3,SCRFD_SIZE,SCRFD_SIZE]);
        for(let i=0;i<px;i++){ it.data[i]=(rgba[i*4]-127.5)/128; it.data[i+px]=(rgba[i*4+1]-127.5)/128; it.data[i+px*2]=(rgba[i*4+2]-127.5)/128; }
        
        console.log('[FaceEngineWeb] Detector run...');
        const detRes=await this._run(this._detSession, this._detEp, { [this._detSession.inputNames[0]]: it });
        
        this._progress('Decoding faces…');
        faces=decodeSCRFD(detRes, this._detSession.outputNames, invScale, opts.det_thresh||0.5);
        for(const t of Object.values(detRes)) t.dispose?.();
        it.dispose();
      }
      faces=applyNMS(faces);
      console.log(`[FaceEngineWeb] Detection: ${faces.length} face(s) after NMS | ${(performance.now()-t0).toFixed(0)}ms`);

      // ── Recognition ───────────────────────────────────────────────────────
      if (faces.length > 0) {
        this._progress('Initializing recognizer…');
        await this._initRecognizer();
      }

      const facePayloads=[];
      for(let i=0; i<faces.length; i++){
        const f = faces[i];
        this._progress(`Embedding face ${i+1}/${faces.length}…`);
        
        const {a,b,tx,ty}=similarityTransform(f.landmarks, ARC_DST);
        let emb, face_crop_b64 = null;
        {
          const fc=new OffscreenCanvas(ARCFACE_SIZE, ARCFACE_SIZE);
          const fctx=fc.getContext('2d'); fctx.setTransform(a,b,-b,a,tx,ty); fctx.drawImage(img,0,0);
          const sp=ARCFACE_SIZE*ARCFACE_SIZE;
          const frgba=fctx.getImageData(0,0,ARCFACE_SIZE,ARCFACE_SIZE).data;
          const fit=new ort.Tensor('float32', new Float32Array(3*sp), [1,3,ARCFACE_SIZE,ARCFACE_SIZE]);
          for(let j=0;j<sp;j++){ fit.data[j]=(frgba[j*4+2]-127.5)/128; fit.data[j+sp]=(frgba[j*4+1]-127.5)/128; fit.data[j+sp*2]=(frgba[j*4]-127.5)/128; }
          
          const recRes=await this._run(this._recSession, this._recEp, { [this._recSession.inputNames[0]]: fit });
          const rawEmb=Array.from(recRes[this._recSession.outputNames[0]].data);
          emb=l2normalize(rawEmb);
          for(const t of Object.values(recRes)) t.dispose?.(); fit.dispose();
        }

        try {
          const [fx1,fy1,fx2,fy2]=f.bbox;
          const fw=fx2-fx1, fh=fy2-fy1;
          const pad=Math.max(fw,fh)*0.2;
          const cx=Math.max(0,Math.round(fx1-pad)), cy=Math.max(0,Math.round(fy1-pad));
          const cw=Math.min(W-cx,Math.round(fw+pad*2)), ch=Math.min(H-cy,Math.round(fh+pad*2));
          const FACE_THUMB=160;
          const ftc=new OffscreenCanvas(FACE_THUMB,FACE_THUMB);
          ftc.getContext('2d').drawImage(img, cx, cy, cw, ch, 0, 0, FACE_THUMB, FACE_THUMB);
          const ftb=await ftc.convertToBlob({type:'image/jpeg',quality:0.9});
          face_crop_b64=await new Promise(res=>{const r=new FileReader();r.onload=()=>res(r.result.split(',')[1]);r.readAsDataURL(ftb);});
        } catch(e) { console.warn('[FaceEngineWeb] face thumbnail failed:', e.message); }

        facePayloads.push({ bbox_left:Math.max(0,f.bbox[0]/W), bbox_top:Math.max(0,f.bbox[1]/H), bbox_right:Math.min(1,f.bbox[2]/W), bbox_bottom:Math.min(1,f.bbox[3]/H), detection_confidence:f.score, embedding:emb, embedding_dimension:emb.length, face_crop_b64 });
      }

      // ── Thumbnail ──────────────────────────────────────────────────────────
      this._progress('Generating thumbnail…');
      const thumbSize = opts.thumb_size || 200;
      let thumbnail_b64 = '';
      try {
        const scale = Math.min(thumbSize / W, thumbSize / H, 1);
        const tw = Math.round(W * scale), th = Math.round(H * scale);
        const tc = new OffscreenCanvas(tw, th);
        tc.getContext('2d').drawImage(img, 0, 0, tw, th);
        const tb = await tc.convertToBlob({ type: 'image/jpeg', quality: 0.75 });
        thumbnail_b64 = await new Promise(res => {
          const r = new FileReader(); r.onload = () => res(r.result.split(',')[1]); r.readAsDataURL(tb);
        });
      } catch(e) { console.warn('[FaceEngineWeb] thumbnail generation failed:', e.message); }

      // ── SHA-256 hash ──────────────────────────────────────────────────────
      this._progress('Computing hash…');
      const hash=Array.from(new Uint8Array(
        await crypto.subtle.digest('SHA-256', await file.arrayBuffer())
      )).map(b=>b.toString(16).padStart(2,'0')).join('');

      // ── VLM enrichment ────────────────────────────────────────────────────
      let description = null, scene_type = null, tags = [];
      if (opts.vlm_enabled && opts.vlm_provider && opts.vlm_keys?.[opts.vlm_provider]) {
        this._progress(`AI Enrichment (${opts.vlm_provider})…`);
        try {
          const vlmMod = await import('./VlmWeb.js');
          const vlmClient = vlmMod.vlmClientWeb ?? vlmMod.default;
          vlmClient.setKeys(opts.vlm_keys);
          const result = await vlmClient.enrichImage(
            file, opts.vlm_provider, opts.vlm_model || '',
            opts.vlm_prompt || 'Describe this image concisely. Include: main subjects, setting, mood, notable details.',
            opts.vlm_max_size || 1024,
          );
          description = result.description || null;
          scene_type  = result.scene_type  || null;
          tags        = result.tags        || [];
        } catch(e) {
          console.warn(`[FaceEngineWeb] VLM enrichment failed (${opts.vlm_provider}):`, e.message);
        }
      }

      this._progress('Done');
      const elapsed = (performance.now()-t0).toFixed(0);
      console.log(`[FaceEngineWeb] processFile DONE | faces=${facePayloads.length} vlm=${description?'✓':'none'} total=${elapsed}ms`);
      const ext = file.name.includes('.') ? file.name.slice(file.name.lastIndexOf('.')) : '.jpg';
      return { local_path:file.name, filename:file.name,
               filepath:`browser:${hash}${ext}`,
               width:W, height:H, file_size:file.size,
               file_hash:hash, thumbnail_b64, faces:facePayloads,
               description, scene_type, tags };
    } finally {
      if (imgBlobUrl) URL.revokeObjectURL(imgBlobUrl);
    }
  }

  async runInferenceBenchmark(file, progressCallback) {
    // det_10g.onnx (SCRFD) is WebGPU-incompatible (AveragePool ceil_mode=1).
    // It always runs on WASM regardless of the EP setting.
    // w600k_r50.onnx (ArcFace ResNet50) runs on WebGPU with NHWC layout (ort.env.webgpu.preferredLayout='NHWC').
    //
    // Benchmark structure:
    //   WASM (cold)   – both models freshly loaded from cache buffer
    //   WASM (cached) – same binary, warm model cache (measures inference-only speed)
    //   WebGL         – WebGL for both (falls back to WASM if WebGL unavailable)
    //   WebGPU        – det on WASM (forced), rec on WebGPU+WASM (GPU-accelerated recognition)
    //
    // ort.env.wasm.simd is locked at module-load time; toggling between runs has no effect.
    logMemory('Benchmark START');
    const results = [];
    const backends = [
      { name: 'WASM (cold)',   detEp: 'wasm',   recEp: 'wasm'   },
      { name: 'WASM (cached)', detEp: 'wasm',   recEp: 'wasm'   },
      { name: 'WebGL',         detEp: 'webgl',  recEp: 'webgl'  },
      // WebGPU: detector forced to WASM (model incompatibility), recognizer on WebGPU.
      { name: 'WebGPU',        detEp: 'wasm',   recEp: 'webgpu' },
    ];
    for (const b of backends) {
      try {
        if (progressCallback) progressCallback(`Testing ${b.name}...`);
        logMemory(`Before ${b.name}`);
        await this.releaseModels();
        const loadStart = performance.now();
        let dL=false, rL=false, dR=false, rR=false, dE='', rE='', dM=0, rM=0;
        // Detector: pass forceProvider directly; _buildProviders will apply WebGPU exclusion if needed.
        try { await this._initDetector(b.detEp); dL=true; } catch(e){ dE=e.message?.slice(0,120)||String(e); }
        try { await this._initRecognizer(b.recEp); rL=true; } catch(e){ rE=e.message?.slice(0,120)||String(e); }
        const warmMs = Math.round(performance.now()-loadStart);
        if(dL){
          try {
            const s=performance.now();
            const di=new ort.Tensor('float32', new Float32Array(3*640*640),[1,3,640,640]);
            const res=await this._run(this._detSession, this._detEp, {[this._detSession.inputNames[0]]:di});
            for(const t of Object.values(res)) t.dispose?.();
            dM=Math.round(performance.now()-s); dR=true; di.dispose();
          } catch(e){ dE=e.message?.slice(0,120)||String(e); }
        }
        if(rL){
          // WebGPU: first run compiles WGSL shaders (can take 1-3s). Run once untracked
          // to warm the shader cache, then measure steady-state inference speed.
          if(b.recEp === 'webgpu'){
            try {
              const wi=new ort.Tensor('float32', new Float32Array(3*112*112),[1,3,112,112]);
              const wr=await this._run(this._recSession, this._recEp, {[this._recSession.inputNames[0]]:wi});
              for(const t of Object.values(wr)) t.dispose?.(); wi.dispose();
            } catch {}
          }
          try {
            const s=performance.now();
            const ri=new ort.Tensor('float32', new Float32Array(3*112*112),[1,3,112,112]);
            const res=await this._run(this._recSession, this._recEp, {[this._recSession.inputNames[0]]:ri});
            for(const t of Object.values(res)) t.dispose?.();
            rM=Math.round(performance.now()-s); rR=true; ri.dispose();
          } catch(e){ rE=e.message?.slice(0,120)||String(e); }
        }
        let status;
        if(dR && rR) {
          const recNote = b.recEp === 'webgpu' ? ` (det=WASM, rec=WebGPU)` : '';
          status = `✓ D:${dM}ms R:${rM}ms${recNote}`;
        } else {
          const dPart = dL ? (dR ? `D:${dM}ms` : `D:R-FAIL(${dE})`) : `D:L-FAIL(${dE})`;
          const rPart = rL ? (rR ? `R:${rM}ms` : `R:R-FAIL(${rE})`) : `R:L-FAIL(${rE})`;
          status = `${dPart} ${rPart}`;
        }
        results.push({
          backend: b.name, warmup_ms: warmMs, duration_ms: dM+rM,
          faces: dR ? 'OK' : '-', status, success: dR||rR, memory_mb: getMemoryUsage()
        });
        logMemory(`After ${b.name}`);
      } catch (err) {
        results.push({ backend: b.name, status: `✗ ${err.message?.slice(0,120)||err}`, success: false, memory_mb: getMemoryUsage() });
      }
    }
    await this.releaseModels();
    logMemory('Benchmark END');
    return results;
  }
}

export const faceEngineWeb = new FaceEngineWeb();
export default faceEngineWeb;