/**
 * test-real-images.js
 * Processes two specific images and compares the faces found.
 */

'use strict';

const { FaceEngine } = require('./face-engine');
const path = require('path');
const fs = require('fs');

const IMG1 = "C:\\Users\\stc\\Downloads\\pic\\2025_Foto_MF.jpg";
const IMG2 = "C:\\Users\\stc\\Downloads\\pic\\2025_Ströbele_Studienwoche.jpg";

async function main() {
  console.log('--- CrispLens v3: Real Image Test ---');

  const modelDir = path.join(__dirname, 'models', 'buffalo_l');
  const engine = new FaceEngine(modelDir);
  await engine.init();

  console.log(`\n1. Processing: ${path.basename(IMG1)}`);
  if (!fs.existsSync(IMG1)) throw new Error(`File not found: ${IMG1}`);
  const res1 = await engine.processImage(IMG1);
  console.log(`   Found ${res1.length} face(s).`);
  res1.forEach((f, i) => console.log(`   Face ${i+1} BBox: [${f.bbox.map(v => Math.round(v)).join(', ')}] Score: ${f.score.toFixed(3)}`));

  console.log(`\n2. Processing: ${path.basename(IMG2)}`);
  if (!fs.existsSync(IMG2)) throw new Error(`File not found: ${IMG2}`);
  const res2 = await engine.processImage(IMG2);
  console.log(`   Found ${res2.length} face(s).`);
  res2.forEach((f, i) => console.log(`   Face ${i+1} BBox: [${f.bbox.map(v => Math.round(v)).join(', ')}] Score: ${f.score.toFixed(3)}`));

  if (res1.length > 0 && res2.length > 0) {
    console.log('\n--- Recognition Comparison ---');
    const sim = cosineSimilarity(res1[0].embedding, res2[0].embedding);
    console.log(`Similarity between primary faces: ${(sim * 100).toFixed(2)}%`);
    
    if (sim > 0.45) {
      console.log('RESULT: ✅ SAME PERSON RECOGNIZED');
    } else {
      console.log('RESULT: ❌ DIFFERENT PEOPLE');
    }
  } else {
    console.log('\nCannot compare: Missing faces in one or both images.');
  }
}

function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) {
    console.error('[DEBUG] Vector mismatch or missing:', { a: !!a, b: !!b, lenA: a?.length, lenB: b?.length });
    return 0;
  }
  let dot = 0, mA = 0, mB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    mA += a[i] * a[i];
    mB += b[i] * b[i];
  }
  const denom = Math.sqrt(mA) * Math.sqrt(mB);
  if (denom === 0) return 0;
  return dot / denom;
}

main().catch(err => {
  console.error('\nTest failed:', err.message);
});
