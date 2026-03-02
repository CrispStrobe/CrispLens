/**
 * human-face-engine.js
 * High-performance face recognition using @vladmandic/human.
 */

'use strict';

// Force JS-only backend for prototype robustness
require('@tensorflow/tfjs'); 
const Human = require('@vladmandic/human').default;
const path = require('path');
const fs = require('fs');

class HumanFaceEngine {
  constructor(modelDir) {
    this.modelDir = modelDir;
    this.human = null;
    this.config = {
      modelBase: `file://${modelDir}`,
      face: {
        enabled: true,
        detector: { modelPath: 'det_10g.onnx' },
        description: { enabled: true, modelPath: 'w600k_r50.onnx' },
        align: { enabled: true },
      },
      backend: 'cpu',
    };
  }

  async init() {
    console.log('[DEBUG] Initializing Human Engine (CPU)...');
    this.human = new Human(this.config);
    await this.human.load();
    await this.human.warmup();
    console.log('[DEBUG] Human Engine Ready.');
  }

  async processImage(imagePath) {
    if (!this.human) await this.init();
    const buffer = fs.readFileSync(imagePath);
    const result = await this.human.detect(buffer);
    
    return result.face.map(f => ({
      bbox: f.box,
      landmarks: f.landmarks,
      score: f.score,
      embedding: new Float32Array(f.embedding || [])
    }));
  }
}

module.exports = { HumanFaceEngine };
