'use strict';

const express = require('express');
const router  = express.Router();
const path    = require('path');
const fs      = require('fs');
const { requireAuth, requireAdmin } = require('../auth');
const { getDb } = require('../db');
const { FaceEngine, findModelDir } = require('../../core/face-engine');

router.post('/server', requireAdmin, async (req, res) => {
  console.log('[Benchmark] Server benchmark started');
  
  const results = [];
  const db = getDb();
  
  // 1. Pick a sample image from DB that has some faces if possible
  let sample = db.prepare(`
    SELECT i.filepath, i.id, COUNT(f.id) as face_count 
    FROM images i 
    LEFT JOIN faces f ON f.image_id = i.id 
    GROUP BY i.id 
    HAVING face_count > 0 
    ORDER BY face_count DESC 
    LIMIT 1
  `).get();
  
  if (!sample) {
    sample = db.prepare('SELECT filepath, id FROM images LIMIT 1').get();
  }
  
  if (!sample || !fs.existsSync(sample.filepath)) {
    return res.status(400).json({ error: 'No suitable sample image found in database or disk.' });
  }

  const imagePath = sample.filepath;
  const modelDir = findModelDir();
  
  // Providers to test
  const providers = [
    { id: 'cpu', label: 'CPU (WASM)' },
    { id: 'coreml', label: 'CoreML (macOS)' },
    { id: 'cuda', label: 'CUDA (NVIDIA)' },
    { id: 'directml', label: 'DirectML (Windows)' }
  ];

  for (const p of providers) {
    try {
      console.log(`[Benchmark] Testing server provider: ${p.label}`);
      
      const engine = new FaceEngine(modelDir);
      
      // Override init to force specific provider
      engine.init = async function() {
        const ort = require('onnxruntime-node');
        const sessionOpts = {
          executionProviders: [p.id === 'cpu' ? 'cpu' : p.id, 'cpu'],
          graphOptimizationLevel: 'all'
        };
        
        const detPath = path.join(this.modelDir, 'det_10g.onnx');
        const recPath = path.join(this.modelDir, 'w600k_r50.onnx');
        
        this.detSession = await ort.InferenceSession.create(detPath, sessionOpts);
        this.recSession = await ort.InferenceSession.create(recPath, sessionOpts);
        this.initialized = true;
      };

      const start = Date.now();
      const memStart = process.memoryUsage().heapUsed;
      
      await engine.init();
      const resData = await engine.processImage(imagePath, { det_thresh: 0.5 });
      
      const duration = Date.now() - start;
      const memEnd = process.memoryUsage().heapUsed;
      const memDiff = memEnd - memStart;

      results.push({
        provider: p.label,
        duration_ms: duration,
        faces: resData.faces.length,
        memory_mb: (memDiff / (1024 * 1024)).toFixed(2),
        success: true
      });
      
      // Cleanup
      engine.detSession = null;
      engine.recSession = null;
      
    } catch (err) {
      console.error(`[Benchmark] ${p.label} failed: ${err.message}`);
      results.push({
        provider: p.label,
        error: err.message,
        success: false
      });
    }
  }

  res.json({
    sample_image: path.basename(imagePath),
    results
  });
});

module.exports = router;
