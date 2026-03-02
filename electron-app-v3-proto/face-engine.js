/**
 * face-engine.js (v3-proto)
 * Pure Node.js implementation of InsightFace (SCRFD + ArcFace).
 */

'use strict';

const ort = require('onnxruntime-node');
const sharp = require('sharp');
const path = require('path');
const { Matrix, SingularValueDecomposition } = require('ml-matrix');

const ARC_DST = [
  [38.2946, 51.6963], [73.5318, 51.5014], [56.0252, 71.7366],
  [41.5493, 92.3655], [70.7299, 92.2041]
];

class FaceEngine {
  constructor(modelDir) {
    this.modelDir = modelDir;
    this.initialized = false;
    this.detShape = [640, 640];
    this.scoreThreshold = 0.5;
    this.nmsThreshold = 0.4;
  }

  async init() {
    console.log(`[INIT] Loading models from: ${this.modelDir}`);
    const opts = { executionProviders: ['cpu'], interOpNumThreads: 1, intraOpNumThreads: 4 };
    this.detModel = await ort.InferenceSession.create(path.join(this.modelDir, 'det_10g.onnx'), opts);
    this.recModel = await ort.InferenceSession.create(path.join(this.modelDir, 'w600k_r50.onnx'), opts);
    this.initialized = true;
    console.log('[INIT] ONNX Sessions Ready.');
  }

  async processImage(imagePath) {
    if (!this.initialized) await this.init();
    const tStart = Date.now();
    const img = sharp(imagePath);
    const meta = await img.metadata();
    console.log(`[PROCESS] ${path.basename(imagePath)} (${meta.width}x${meta.height})`);

    const { data } = await img.clone().resize(640, 640, { fit: 'contain', background: { r: 0, g: 0, b: 0 } }).raw().toBuffer({ resolveWithObject: true });
    const scale = Math.max(meta.width / 640, meta.height / 640);
    const f32 = new Float32Array(3 * 640 * 640);
    for (let i = 0; i < 640 * 640; i++) {
      f32[i] = (data[i*3] - 127.5) / 128.0;
      f32[i + 409600] = (data[i*3+1] - 127.5) / 128.0;
      f32[i + 819200] = (data[i*3+2] - 127.5) / 128.0;
    }
    const detOutputs = await this.detModel.run({ [this.detModel.inputNames[0]]: new ort.Tensor('float32', f32, [1, 3, 640, 640]) });
    
    const faces = this.decode(detOutputs, scale);
    const kept = this.applyNMS(faces);
    console.log(`[DET] Detected ${kept.length} face(s).`);

    const results = [];
    for (const face of kept) {
      // PROTOTYPE FIX: Use Affine Warp for high-precision recognition
      const aligned = await this.align(img, face.landmarks);
      const embedding = await this.getEmbedding(aligned);
      results.push({ bbox: face.bbox, score: face.score, embedding });
    }
    return results;
  }

  decode(outputs, scale) {
    const faces = [];
    const strides = [8, 16, 32];
    const score_keys = ['448', '471', '494'], bbox_keys = ['451', '474', '497'], kps_keys = ['454', '477', '500'];
    for (let i = 0; i < strides.length; i++) {
      const stride = strides[i];
      const scores = outputs[score_keys[i]].data, bboxes = outputs[bbox_keys[i]].data, kps = outputs[kps_keys[i]].data;
      const feat_h = 640/stride, feat_w = 640/stride, spatial = feat_h * feat_w;
      const anchors_per_cell = scores.length / spatial;
      for (let idx = 0; idx < spatial; idx++) {
        for (let a = 0; a < anchors_per_cell; a++) {
          const s_idx = idx * anchors_per_cell + a;
          const score = scores[s_idx];
          if (score < this.scoreThreshold) continue;
          const y = Math.floor(idx / feat_w), x = idx % feat_w;
          const b = s_idx * 4, k = s_idx * 10;
          faces.push({
            bbox: [(x-bboxes[b])*stride*scale, (y-bboxes[b+1])*stride*scale, (x+bboxes[b+2])*stride*scale, (y+bboxes[b+3])*stride*scale],
            landmarks: Array.from({length:5}, (_,kp) => [(x+kps[k+kp*2])*stride*scale, (y+kps[k+kp*2+1])*stride*scale]),
            score
          });
        }
      }
    }
    return faces;
  }

  applyNMS(faces) {
    const sorted = faces.sort((a, b) => b.score - a.score), keep = [], removed = new Set();
    for (let i = 0; i < sorted.length; i++) {
      if (removed.has(i)) continue;
      keep.push(sorted[i]);
      for (let j = i + 1; j < sorted.length; j++) {
        const a = sorted[i].bbox, b = sorted[j].bbox;
        const x1 = Math.max(a[0], b[0]), y1 = Math.max(a[1], b[1]), x2 = Math.min(a[2], b[2]), y2 = Math.min(a[3], b[3]);
        const inter = Math.max(0, x2-x1) * Math.max(0, y2-y1);
        const iou = inter / ((a[2]-a[0])*(a[3]-a[1]) + (b[2]-b[0])*(b[3]-b[1]) - inter);
        if (iou > this.nmsThreshold) removed.add(j);
      }
      if (keep.length > 5) break;
    }
    return keep;
  }

  async align(sharpImg, landmarks) {
    const M = this.umeyama(landmarks, ARC_DST);
    const a = M[0], b = M[1], c = M[3], d = M[4], tx = M[2], ty = M[5];
    const det = a * d - b * c;
    const invA = d/det, invB = -b/det, invC = -c/det, invD = a/det;
    const invTx = -(invA * tx + invB * ty), invTy = -(invC * tx + invD * ty);

    const { data } = await sharpImg.clone()
      .affine([invA, invB, invC, invD], { idx: invTx, idy: invTy, background: { r: 0, g: 0, b: 0 } })
      .extend({ top: 0, bottom: 112, left: 0, right: 112, background: { r: 0, g: 0, b: 0 } })
      .extract({ left: 0, top: 0, width: 112, height: 112 })
      .toFormat('raw')
      .toBuffer({ resolveWithObject: true });
    return data;
  }

  umeyama(src, dst) {
    const n = src.length;
    let mx=0, my=0, dx=0, dy=0;
    for (let i=0; i<n; i++) { mx+=src[i][0]; my+=src[i][1]; dx+=dst[i][0]; dy+=dst[i][1]; }
    mx/=n; my/=n; dx/=n; dy/=n;
    const Xc = src.map(p => [p[0]-mx, p[1]-my]), Yc = dst.map(p => [p[0]-dx, p[1]-dy]);
    let s11=0, s12=0, s21=0, s22=0;
    for (let i=0; i<n; i++) { s11+=Xc[i][0]*Yc[i][0]; s12+=Xc[i][0]*Yc[i][1]; s21+=Xc[i][1]*Yc[i][0]; s22+=Xc[i][1]*Yc[i][1]; }
    const svd = new SingularValueDecomposition(new Matrix([[s11/n, s12/n], [s21/n, s22/n]]));
    const U = svd.leftSingularVectors, V = svd.rightSingularVectors, S = svd.diagonal;
    let R = V.mmul(U.transpose());
    if ((R.get(0,0)*R.get(1,1) - R.get(0,1)*R.get(1,0)) < 0) {
      const d = Matrix.eye(2); d.set(1, 1, -1);
      R = V.mmul(d).mmul(U.transpose());
    }
    let var_x = 0;
    for (let i=0; i<n; i++) var_x += Xc[i][0]**2 + Xc[i][1]**2;
    var_x /= n;
    const scale = (S[0] + S[1]) / var_x;
    const t0 = dx - scale*(R.get(0,0)*mx + R.get(0,1)*my), t1 = dy - scale*(R.get(1,0)*mx + R.get(1,1)*my);
    return [scale*R.get(0,0), scale*R.get(0,1), t0, scale*R.get(1,0), scale*R.get(1,1), t1];
  }

  async getEmbedding(alignedBuffer) {
    const f32 = new Float32Array(3 * 112 * 112);
    const spatial = 112 * 112;
    for (let i = 0; i < spatial; i++) {
      f32[i]           = (alignedBuffer[i * 3 + 0] - 127.5) / 128.0;
      f32[i + spatial] = (alignedBuffer[i * 3 + 1] - 127.5) / 128.0;
      f32[i + 2 * spatial] = (alignedBuffer[i * 3 + 2] - 127.5) / 128.0;
    }
    const out = await this.recModel.run({ [this.recModel.inputNames[0]]: new ort.Tensor('float32', f32, [1, 3, 112, 112]) });
    const raw = out[this.recModel.outputNames[0]].data;
    let sqSum = 0;
    for (let i = 0; i < raw.length; i++) sqSum += raw[i] * raw[i];
    const norm = Math.sqrt(sqSum) || 1;
    const emb = new Float32Array(raw.length);
    for (let i = 0; i < raw.length; i++) emb[i] = raw[i] / norm;
    return emb;
  }
}

module.exports = { FaceEngine };
