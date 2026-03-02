/**
 * face-engine.js (v3-proto)
 * Pure Node.js implementation of InsightFace (SCRFD + ArcFace).
 */

'use strict';

const ort = require('onnxruntime-node');
const sharp = require('sharp');
const path = require('path');
const { Matrix, SingularValueDecomposition } = require('ml-matrix');

sharp.cache(false);

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
    const imgObj = sharp(imagePath);
    const meta = await imgObj.metadata();
    
    // 1. Detection
    const { data: detData } = await imgObj.clone()
      .resize(640, 640, { fit: 'contain', background: { r: 0, g: 0, b: 0 } })
      .raw().toBuffer({ resolveWithObject: true });

    const scale = Math.max(meta.width / 640, meta.height / 640);
    const f32Det = new Float32Array(3 * 640 * 640);
    for (let i = 0; i < 640 * 640; i++) {
      f32Det[i] = (detData[i*3] - 127.5) / 128.0;
      f32Det[i + 409600] = (detData[i*3+1] - 127.5) / 128.0;
      f32Det[i + 819200] = (detData[i*3+2] - 127.5) / 128.0;
    }
    const detOutputs = await this.detModel.run({ [this.detModel.inputNames[0]]: new ort.Tensor('float32', f32Det, [1, 3, 640, 640]) });
    
    const faces = this.decode(detOutputs, scale);
    const kept = this.applyNMS(faces);
    console.log(`[DET] Detected ${kept.length} face(s).`);

    const results = [];
    for (const face of kept) {
      // PROTOTYPE FIX: Instead of affine (tricky in Sharp), 
      // use an intelligent crop focused on landmarks to ensure we get a face.
      const alignedData = await this.landmarkCrop(imagePath, face.landmarks);
      const embedding = await this.getEmbedding(alignedData);
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
      const anchors = scores.length / spatial;
      for (let idx = 0; idx < spatial; idx++) {
        for (let a = 0; a < anchors; a++) {
          const s_idx = idx * anchors + a;
          if (scores[s_idx] < this.scoreThreshold) continue;
          const y = Math.floor(idx / feat_w), x = idx % feat_w;
          const b = s_idx * 4, k = s_idx * 10;
          faces.push({
            bbox: [(x-bboxes[b])*stride*scale, (y-bboxes[b+1])*stride*scale, (x+bboxes[b+2])*stride*scale, (y+bboxes[b+3])*stride*scale],
            landmarks: Array.from({length:5}, (_,kp) => [(x+kps[k+kp*2])*stride*scale, (y+kps[k+kp*2+1])*stride*scale]),
            score: scores[s_idx]
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

  async landmarkCrop(imagePath, landmarks) {
    // Crop around landmarks with 20% padding
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    landmarks.forEach(p => {
      if(p[0] < minX) minX = p[0]; if(p[0] > maxX) maxX = p[0];
      if(p[1] < minY) minY = p[1]; if(p[1] > maxY) maxY = p[1];
    });
    const w = maxX - minX, h = maxY - minY;
    const meta = await sharp(imagePath).metadata();
    
    const pad = Math.max(w, h) * 0.5;
    const extractBox = {
      left: Math.max(0, Math.round(minX - pad)),
      top: Math.max(0, Math.round(minY - pad)),
      width: Math.min(Math.round(w + pad * 2), meta.width - Math.max(0, Math.round(minX - pad))),
      height: Math.min(Math.round(h + pad * 2), meta.height - Math.max(0, Math.round(minY - pad)))
    };

    const { data } = await sharp(imagePath)
      .extract(extractBox)
      .resize(112, 112)
      .toFormat('raw')
      .toBuffer({ resolveWithObject: true });
    return data;
  }

  async getEmbedding(alignedBuffer) {
    const f32Rec = new Float32Array(3 * 112 * 112);
    const spatial = 112 * 112;
    for (let i = 0; i < spatial; i++) {
      f32Rec[i]           = (alignedBuffer[i * 3 + 0] - 127.5) / 128.0;
      f32Rec[i + spatial] = (alignedBuffer[i * 3 + 1] - 127.5) / 128.0;
      f32Rec[i + 2*spatial] = (alignedBuffer[i * 3 + 2] - 127.5) / 128.0;
    }
    const out = await this.recModel.run({ [this.recModel.inputNames[0]]: new ort.Tensor('float32', f32Rec, [1, 3, 112, 112]) });
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
