/**
 * compare-engines.js
 * Head-to-head comparison: Node.js Engine vs. existing Python Database.
 */

'use strict';

const { FaceEngine } = require('./face-engine');
const { ensureModels } = require('./model-manager');
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

async function runComparison(dbPath) {
  console.log('--- CrispLens Engine Compatibility Test ---');
  
  if (!fs.existsSync(dbPath)) {
    console.error(`Error: Database not found at ${dbPath}`);
    return;
  }

  const db = new Database(dbPath);
  const modelDir = await ensureModels();
  const engine = new FaceEngine(modelDir);
  await engine.init();

  // 1. Fetch a few samples from the existing Python-generated database
  // We need the image_path and the embedding blob
  const samples = db.prepare(`
    SELECT id, image_path, embedding 
    FROM faces 
    WHERE embedding IS NOT NULL 
    LIMIT 5
  `).all();

  if (samples.length === 0) {
    console.error('No processed faces found in database to compare against.');
    return;
  }

  console.log(`
Comparing ${samples.length} samples...
`);

  for (const sample of samples) {
    const pythonEmbedding = new Float32Array(sample.embedding.buffer, sample.embedding.byteOffset, sample.embedding.byteLength / 4);
    
    if (!fs.existsSync(sample.image_path)) {
      console.log(`[ID ${sample.id}] Skip: Original image missing at ${sample.image_path}`);
      continue;
    }

    try {
      // 2. Process with Node.js Engine
      const results = await engine.processImage(sample.image_path);
      
      if (results.length === 0) {
        console.log(`[ID ${sample.id}] Node.js engine found 0 faces in ${path.basename(sample.image_path)}`);
        continue;
      }

      // Find the best matching face in the image (if multiple)
      const nodeEmbedding = results[0].embedding;

      // 3. Calculate Cosine Similarity
      const similarity = cosineSimilarity(pythonEmbedding, nodeEmbedding);
      
      const status = similarity > 0.98 ? '✅ MATCH' : '❌ DRIFT';
      console.log(`[ID ${sample.id}] ${status}`);
      console.log(`   Image: ${path.basename(sample.image_path)}`);
      console.log(`   Similarity: ${(similarity * 100).toFixed(4)}%`);
    } catch (err) {
      console.error(`[ID ${sample.id}] Error:`, err.message);
    }
  }
}

function cosineSimilarity(a, b) {
  let dot = 0, mA = 0, mB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    mA += a[i] * a[i];
    mB += b[i] * b[i];
  }
  return dot / (Math.sqrt(mA) * Math.sqrt(mB));
}

// Get DB path from CLI or default
const dbPath = process.argv[2] || path.join(process.env.APPDATA, 'CrispLens', 'face_recognition.db');
runComparison(dbPath).catch(console.error);
