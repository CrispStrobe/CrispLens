/* FACE_ENGINE_WEB_VERSION: v4.0.260308.0945 */
import * as ort from 'onnxruntime-web';

// Configure onnxruntime-web paths
const wasmBase = (typeof self !== 'undefined' ? self.location.origin : '') + '/ort-wasm/';
console.log(`[FaceEngineWeb] Setting wasmPaths to: ${wasmBase}`);
ort.env.wasm.wasmPaths = wasmBase;
ort.env.wasm.numThreads = 1;
ort.env.wasm.proxy = false;

const _ls = typeof localStorage !== 'undefined' ? localStorage : null;
const _ortPrefs = {
  simd:   _ls?.getItem('pref_ort_use_simd')   === 'true',
  webgl:  _ls?.getItem('pref_ort_use_webgl')  !== 'false', // default true
  webgpu: _ls?.getItem('pref_ort_use_webgpu') === 'true',
};
ort.env.wasm.simd = _ortPrefs.simd;

function _getOrtProviders(forceProvider = null) {
  if (forceProvider) return [forceProvider];
  const isAndroid = typeof navigator !== 'undefined' && /Android/i.test(navigator.userAgent);
  const providers = [];
  if (_ortPrefs.webgpu && !isAndroid) providers.push('webgpu');
  if (_ortPrefs.webgl && !isAndroid) providers.push('webgl');
  providers.push('wasm');
  return providers;
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
  const strides = [8, 16, 32]; const faces = [];
  for (let si=0; si<strides.length; si++) {
    const stride=strides[si], feat=SCRFD_SIZE/stride, spatial=feat*feat;
    const scores=outputs[outputNames[si]].data, bboxes=outputs[outputNames[si+3]].data, kps=outputs[outputNames[si+6]].data;
    for (let idx=0; idx<spatial; idx++) {
      const row=Math.floor(idx/feat), col=idx%feat, cx=col*stride, cy=row*stride;
      for (let a=0; a<NUM_ANCHORS; a++) {
        const ai=idx*NUM_ANCHORS+a; if (scores[ai]<detThresh) continue;
        const bi=ai*4, x1=(cx-bboxes[bi])*invScale, y1=(cy-bboxes[bi+1])*invScale, x2=(cx+bboxes[bi+2])*invScale, y2=(cy+bboxes[bi+3])*invScale;
        const ki=ai*10, landmarks=[];
        for (let kp=0; kp<5; kp++) landmarks.push([(cx+kps[ki+kp*2])*invScale, (cy+kps[ki+kp*2+1])*invScale]);
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
        this._progress(`Downloading ${filename}…`);
        resp=await fetch(fetchUrl);
        if(!resp.ok) throw new Error(`Fetch failed: ${resp.status}`);
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
      if(this._detSession){ await this._detSession.release(); this._detSession=null; }
      if(this._recSession){ await this._recSession.release(); this._recSession=null; }
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

  async _initDetector(forceProvider = null) {
    if(this._detSession) return;
    this._progress('Loading SCRFD detector…');
    const buf=await this._fetchModelCached('det_10g.onnx');
    const providers=forceProvider ? [forceProvider] : ['wasm']; 
    console.log(`[FaceEngineWeb] Initializing Detector | providers=${providers}`);
    this._detSession=await ort.InferenceSession.create(buf, { executionProviders:providers, graphOptimizationLevel:'all' });
    this._progress('Detector ready');
  }

  async _initRecognizer(forceProvider = null) {
    if(this._recSession) return;
    this._progress('Loading ArcFace recognizer…');
    const buf=await this._fetchModelCached('w600k_r50.onnx');
    const providers=forceProvider ? [forceProvider] : _getOrtProviders(); 
    console.log(`[FaceEngineWeb] Initializing Recognizer | providers=${providers}`);
    this._recSession=await ort.InferenceSession.create(buf, { executionProviders:providers, graphOptimizationLevel:'all' });
    this._progress('Recognizer ready');
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
    const img=await this._loadImage(file);
    const W=img.naturalWidth||img.width, H=img.naturalHeight||img.height;
    await this._initDetector();
    const { canvas, invScale }=this._letterbox(img);
    const it=new ort.Tensor('float32', new Float32Array(3*SCRFD_SIZE*SCRFD_SIZE), [1,3,SCRFD_SIZE,SCRFD_SIZE]);
    const ctx=canvas.getContext('2d'), px=SCRFD_SIZE*SCRFD_SIZE, rgba=ctx.getImageData(0,0,SCRFD_SIZE,SCRFD_SIZE).data;
    for(let i=0;i<px;i++){ it.data[i]=(rgba[i*4]-127.5)/128; it.data[i+px]=(rgba[i*4+1]-127.5)/128; it.data[i+px*2]=(rgba[i*4+2]-127.5)/128; }
    
    const detRes=await this._detSession.run({ [this._detSession.inputNames[0]]: it });
    let faces=decodeSCRFD(detRes, this._detSession.outputNames, invScale, opts.det_thresh||0.5);
    for(const t of Object.values(detRes)) t.dispose?.();
    it.dispose(); faces=applyNMS(faces);
    
    await this._initRecognizer();
    const facePayloads=[];
    for(const f of faces){
      const {a,b,tx,ty}=similarityTransform(f.landmarks, ARC_DST);
      const fc=new OffscreenCanvas(ARCFACE_SIZE, ARCFACE_SIZE);
      const fctx=fc.getContext('2d'); fctx.setTransform(a,b,-b,a,tx,ty); fctx.drawImage(img,0,0);
      const fit=new ort.Tensor('float32', new Float32Array(3*ARCFACE_SIZE*ARCFACE_SIZE), [1,3,ARCFACE_SIZE,ARCFACE_SIZE]);
      const frgba=fctx.getImageData(0,0,ARCFACE_SIZE,ARCFACE_SIZE).data, sp=ARCFACE_SIZE*ARCFACE_SIZE;
      for(let i=0;i<sp;i++){ fit.data[i]=(frgba[i*4+2]-127.5)/128; fit.data[i+sp]=(frgba[i*4+1]-127.5)/128; fit.data[i+sp*2]=(frgba[i*4]-127.5)/128; }
      const recRes=await this._recSession.run({ [this._recSession.inputNames[0]]: fit });
      const emb=l2normalize(Array.from(recRes[this._recSession.outputNames[0]].data));
      for(const t of Object.values(recRes)) t.dispose?.(); fit.dispose();
      facePayloads.push({ bbox_left:Math.max(0,f.bbox[0]/W), bbox_top:Math.max(0,f.bbox[1]/H), bbox_right:Math.min(1,f.bbox[2]/W), bbox_bottom:Math.min(1,f.bbox[3]/H), detection_confidence:f.score, embedding:emb, embedding_dimension:emb.length });
    }
    
    const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', await file.arrayBuffer()))).map(b=>b.toString(16).padStart(2,'0')).join('');
    if(img.src.startsWith('blob:')) URL.revokeObjectURL(img.src);
    return { local_path:file.name, filename:file.name, width:W, height:H, file_size:file.size, file_hash:hash, thumbnail_b64:'', faces:facePayloads };
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
        let dL=false, rL=false, dR=false, rR=false, dE='', rE='', dM=0, rM=0;
        try { await this._initDetector(b.ep); dL=true; } catch(e){ dE=e.message; }
        try { await this._initRecognizer(b.ep); rL=true; } catch(e){ rE=e.message; }
        const warmMs = Math.round(performance.now()-loadStart);
        if(dL){
          try {
            const s=performance.now(); const di=new ort.Tensor('float32', new Float32Array(3*640*640),[1,3,640,640]);
            await this._detSession.run({[this._detSession.inputNames[0]]:di});
            dM=Math.round(performance.now()-s); dR=true; di.dispose();
          } catch(e){ dE=e.message; }
        }
        if(rL){
          try {
            const s=performance.now(); const ri=new ort.Tensor('float32', new Float32Array(3*112*112),[1,3,112,112]);
            await this._recSession.run({[this._recSession.inputNames[0]]:ri});
            rM=Math.round(performance.now()-s); rR=true; ri.dispose();
          } catch(e){ rE=e.message; }
        }
        let status = '✓';
        if(dR && rR) status = `✓ D:${dM}ms R:${rM}ms`;
        else status = (dL?(dR?`D:${dM}ms `:`D:R-FAIL `):`D:L-FAIL `) + (rL?(rR?`R:${rM}ms`:`R:R-FAIL`):`R:L-FAIL`);
        
        results.push({
          backend: b.name, warmup_ms: warmMs, duration_ms: dM+rM,
          faces: dR ? 'OK' : '0', status: status, success: dR||rR, memory_mb: getMemoryUsage()
        });
        logMemory(`After ${b.name}`);
      } catch (err) { results.push({ backend: b.name, status: '✗ Fatal', error: err.message, success: false, memory_mb: getMemoryUsage() }); }
    }
    Object.assign(_ortPrefs, originalPrefs); ort.env.wasm.simd = _ortPrefs.simd;
    await this.releaseModels();
    logMemory('Benchmark END');
    return results;
  }
}

export const faceEngineWeb = new FaceEngineWeb();
export default faceEngineWeb;