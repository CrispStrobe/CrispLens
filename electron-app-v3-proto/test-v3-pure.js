/**
 * test-v3-pure.js
 * End-to-end test: Detect -> Embedding -> FAISS Search.
 */

'use strict';

const { FaceEngine } = require('./face-engine');
const { VectorManager } = require('./vector-manager');
const path = require('path');
const fs = require('fs');

const DB_PATH = path.join(__dirname, 'test_face_recognition.db');
const INDEX_PATH = path.join(__dirname, 'test_faiss.index');
const TEST_IMAGE = path.join(__dirname, '..', 'CrispLens.png');

async function main() {
  console.log('--- CrispLens v3: Pure Node.js E2E Test ---');

  if (!fs.existsSync(DB_PATH) || !fs.existsSync(INDEX_PATH)) {
    console.error('Test environment not found. Run create-v3-test-env.js first.');
    return;
  }

  // 1. Init Engine
  const engine = new FaceEngine(path.join(__dirname, 'models', 'buffalo_l'));
  await engine.init();

  // 2. Init Vector Manager (Search)
  const vm = new VectorManager(INDEX_PATH, DB_PATH);
  await vm.init();
  
  // Custom search for the test schema
  vm.search = function(embedding, k = 5) {
    const results = this.index.search(Array.from(embedding), k);
    const matches = [];
    for (let i = 0; i < results.labels.length; i++) {
      const id = results.labels[i];
      if (id < 0) continue;
      const person = this.db.prepare(`
        SELECT p.name 
        FROM face_embeddings fe
        JOIN people p ON fe.person_id = p.id
        WHERE fe.id = ?
      `).get(Number(id) + 1);
      matches.push({ name: person ? person.name : 'Unknown', distance: results.distances[i] });
    }
    return matches;
  };

  // 3. Process image
  console.log('\nScanning image:', TEST_IMAGE);
  const results = await engine.processImage(TEST_IMAGE);
  
  if (results.length === 0) {
    console.log('No faces found in scan (as expected for CrispLens.png logo).');
    console.log('Testing with mock embedding lookup...');
    const mockVec = new Float32Array(512).fill(0.1).map((v, i) => v + i*0.001);
    const matches = vm.search(mockVec);
    console.log('Top match:', matches[0]);
  } else {
    console.log(`Found ${results.length} faces. Searching index...`);
    const matches = vm.search(results[0].embedding);
    console.log('Match result:', matches[0]);
  }

  console.log('\n--- E2E Test Complete ---');
}

main().catch(console.error);
