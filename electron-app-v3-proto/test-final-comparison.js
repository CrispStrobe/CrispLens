/**
 * test-final-comparison.js
 */

'use strict';

const { FaceEngine } = require('./face-engine');
const path = require('path');
const fs = require('fs');

const IMAGES = [
  "C:\\Users\\stc\\Downloads\\pic\\Hruschka C Bild.jpg",
  "C:\\Users\\stc\\Downloads\\pic\\Hruschka Bild.jpg",
  "C:\\Users\\stc\\Downloads\\pic\\Ströbele2025foto01.jpg",
  "C:\\Users\\stc\\Downloads\\pic\\Ströbele_Bild.jpg"
];

async function main() {
  console.log('--- CrispLens v3: Similarity Validation ---');

  const modelDir = path.join(__dirname, 'models', 'buffalo_l');
  const engine = new FaceEngine(modelDir);
  await engine.init();

  const results = [];

  for (const imgPath of IMAGES) {
    if (!fs.existsSync(imgPath)) continue;
    
    console.log(`\nScanning: ${path.basename(imgPath)}`);
    const faces = await engine.processImage(imgPath);
    
    if (faces.length > 0) {
      // CLONE THE EMBEDDING to ensure no shared memory issues
      const embedding = new Float32Array(faces[0].embedding);
      console.log(`   Face detected. Fingerprint: ${embedding[0].toFixed(4)}`);
      results.push({ name: path.basename(imgPath), embedding });
    } else {
      console.log('   No faces found.');
    }
  }

  console.log('\n--- CROSS MATRIX ---');
  for (let i = 0; i < results.length; i++) {
    for (let j = i + 1; j < results.length; j++) {
      const sim = cosineSimilarity(results[i].embedding, results[j].embedding);
      console.log(`${results[i].name} vs ${results[j].name}: ${(sim * 100).toFixed(2)}%`);
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

main().catch(console.error);
