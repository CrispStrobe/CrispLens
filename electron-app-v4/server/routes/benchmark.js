'use strict';

const express = require('express');
const router  = express.Router();
const path    = require('path');
const fs      = require('fs');
const { requireAuth, requireAdmin } = require('../auth');
const { getDb } = require('../db');
const { FaceEngine, findModelDir } = require('../../core/face-engine');

router.post('/server', requireAdmin, async (req, res) => {
  
  const { image_id } = req.body || {};
  console.log(`[Benchmark] Server benchmark started. Requested image_id: ${image_id || 'auto'}`);
  
  const results = [];
  const db = getDb();
  
  // 1. Pick or use provided image
  let sample;
  if (image_id) {
    sample = db.prepare('SELECT filepath, id, filename FROM images WHERE id = ?').get(image_id);
    if (!sample) return res.status(404).json({ error: `Image ID ${image_id} not found in database.` });
  } else {
    // Pick a sample image from DB that has some faces if possible
    sample = db.prepare(`
      SELECT i.filepath, i.id, i.filename, COUNT(f.id) as face_count 
      FROM images i 
      LEFT JOIN faces f ON f.image_id = i.id 
      GROUP BY i.id 
      HAVING face_count > 0 
      ORDER BY face_count DESC 
      LIMIT 1
    `).get();
    
    if (!sample) {
      sample = db.prepare('SELECT filepath, id, filename FROM images LIMIT 1').get();
    }
  }
  
  if (!sample || !fs.existsSync(sample.filepath)) {
    return res.status(400).json({ error: 'No suitable sample image found on disk.' });
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
      
      const { FaceEngine } = require('../../core/face-engine');
      const engine = new FaceEngine(modelDir);
      
      // Pass 1: Warmup (includes session creation and first inference)
      console.log(`[Benchmark]   Pass 1: Warmup...`);
      const startWarmup = Date.now();
      await engine.init([p.id === 'cpu' ? 'cpu' : p.id, 'cpu']);
      if (!engine.detModel) throw new Error('detModel not initialized');
      
      // First dummy inference
      await engine.detectFaces(imagePath, { det_thresh: 0.5, det_model: 'auto' });
      const warmupDuration = Date.now() - startWarmup;
      console.log(`[Benchmark]   Warmup done in ${warmupDuration}ms`);
      
      // Pass 2: Measured Inference (sessions already optimized)
      console.log(`[Benchmark]   Pass 2: Measuring inference...`);
      const startInference = Date.now();
      const memStart = process.memoryUsage().heapUsed;
      
      const detRes = await engine.detectFaces(imagePath, { det_thresh: 0.5, det_model: 'auto' });
      
      const faces = [];
      if (detRes.faces && detRes.faces.length > 0) {
        for (const f of detRes.faces) {
          const emb = await engine.embedFace(imagePath, f.landmarks, detRes.imageWidth, detRes.imageHeight);
          faces.push({ ...f, embedding: emb });
        }
      }
      
      const inferenceDuration = Date.now() - startInference;
      console.log(`[Benchmark]   Inference done in ${inferenceDuration}ms`);
      const memEnd = process.memoryUsage().heapUsed;
      const memDiff = memEnd - memStart;

      results.push({
        provider: p.label,
        warmup_ms: warmupDuration,
        duration_ms: inferenceDuration,
        faces: faces.length,
        memory_mb: (memDiff / (1024 * 1024)).toFixed(2),
        success: true
      });
      
      engine.detModel = null;
      engine.recModel = null;
      
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
    sample_image: sample.filename || path.basename(imagePath),
    image_id: sample.id,
    results
  });
});

module.exports = router;
