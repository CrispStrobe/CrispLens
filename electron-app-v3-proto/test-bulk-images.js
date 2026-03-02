/**
 * test-bulk-images.js
 * Processes 4 images and compares them all.
 */

'use strict';

const { FaceEngine } = require('./face-engine');
const path = require('path');
const fs = require('fs');

const IMAGES = [
  "C:\\Users\\stc\\Downloads\\pic\\Muslimfeindlichkeit -2209.jpg",
  "C:\\Users\\stc\\Downloads\\pic\\Ströbele2025foto01.jpg",
  "C:\\Users\\stc\\Downloads\\pic\\26215_Islamiserung in DE_251113_MH-FB_5515.jpg",
  "C:\\Users\\stc\\Downloads\\pic\\Ströbele_Bild.jpg"
];

async function main() {
  console.log('--- CrispLens v3: Bulk Comparison Test ---');

  const modelDir = path.join(__dirname, 'models', 'buffalo_l');
  const engine = new FaceEngine(modelDir);
  await engine.init();

  const results = [];

  for (const imgPath of IMAGES) {
    console.log(`\nProcessing: ${path.basename(imgPath)}`);
    const faces = await engine.processImage(imgPath);
    
    if (faces.length > 0) {
      console.log(`   Found ${faces.length} face(s). Primary Score: ${faces[0].score.toFixed(3)}`);
      const fp = Array.from(faces[0].embedding.slice(0, 5)).map(v => v.toFixed(4)).join(', ');
      console.log(`   Embedding Fingerprint: [${fp}...]`);
      results.push({ name: path.basename(imgPath), embedding: faces[0].embedding });
    } else {
      console.log('   No faces detected.');
    }
  }

  if (results.length > 1) {
    console.log('\n--- CROSS-COMPARISON MATRIX ---');
    for (let i = 0; i < results.length; i++) {
      for (let j = i + 1; j < results.length; j++) {
        const sim = cosineSimilarity(results[i].embedding, results[j].embedding);
        const match = sim > 0.45 ? '✅ MATCH' : '❌ NO MATCH';
        console.log(`${results[i].name} vs ${results[j].name}`);
        console.log(`   Similarity: ${(sim * 100).toFixed(2)}% | ${match}`);
      }
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
  const denom = Math.sqrt(mA) * Math.sqrt(mB);
  return denom === 0 ? 0 : dot / denom;
}

main().catch(err => console.error('\nBulk test failed:', err));
