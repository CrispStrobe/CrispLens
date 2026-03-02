/**
 * test-human-images.js
 * Test using the @vladmandic/human engine.
 */

'use strict';

const { HumanFaceEngine } = require('./human-face-engine');
const path = require('path');
const fs = require('fs');

const IMG1 = "C:\\Users\\stc\\Downloads\\pic\\2025_Foto_MF.jpg";
const IMG2 = "C:\\Users\\stc\\Downloads\\pic\\2025_Ströbele_Studienwoche.jpg";

async function main() {
  console.log('--- CrispLens v3: Human Engine Test ---');

  const modelDir = path.join(__dirname, 'models', 'buffalo_l');
  const engine = new HumanFaceEngine(modelDir);
  await engine.init();

  console.log(`\n1. Processing: ${path.basename(IMG1)}`);
  const res1 = await engine.processImage(IMG1);
  res1.forEach((f, i) => console.log(`   Face ${i+1} Score: ${f.score.toFixed(3)} BBox: [${f.bbox.map(v => Math.round(v)).join(', ')}]`));

  console.log(`\n2. Processing: ${path.basename(IMG2)}`);
  const res2 = await engine.processImage(IMG2);
  res2.forEach((f, i) => console.log(`   Face ${i+1} Score: ${f.score.toFixed(3)} BBox: [${f.bbox.map(v => Math.round(v)).join(', ')}]`));

  if (res1.length > 0 && res2.length > 0) {
    console.log('\n--- Similarity Result ---');
    const sim = cosineSimilarity(res1[0].embedding, res2[0].embedding);
    console.log(`Similarity: ${(sim * 100).toFixed(2)}%`);
    if (sim > 0.45) console.log('RESULT: ✅ MATCH');
    else console.log('RESULT: ❌ NO MATCH');
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
