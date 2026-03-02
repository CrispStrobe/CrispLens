/**
 * create-v3-test-env.js
 * Creates a local test environment (SQLite + FAISS) using real inference.
 */

'use strict';

const { FaceEngine } = require('./face-engine');
const { ensureModels } = require('./model-manager');
const { IndexFlatL2 } = require('faiss-napi');
const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, 'test_face_recognition.db');
const INDEX_PATH = path.join(__dirname, 'test_faiss.index');
const TEST_IMAGE = path.join(__dirname, '..', 'CrispLens.png');

async function main() {
  console.log('--- Creating v3 Test Environment ---');

  // 1. Cleanup
  if (fs.existsSync(DB_PATH)) fs.unlinkSync(DB_PATH);
  if (fs.existsSync(INDEX_PATH)) fs.unlinkSync(INDEX_PATH);

  // 2. Init DB with core tables
  const db = new Database(DB_PATH);
  db.exec(`
    CREATE TABLE people (id INTEGER PRIMARY KEY, name TEXT);
    CREATE TABLE images (id INTEGER PRIMARY KEY, filepath TEXT, processed BOOLEAN);
    CREATE TABLE faces (id INTEGER PRIMARY KEY, image_id INTEGER);
    CREATE TABLE face_embeddings (id INTEGER PRIMARY KEY, face_id INTEGER, person_id INTEGER, embedding_vector BLOB);
  `);

  // 3. Init Engine
  const modelDir = await ensureModels();
  const engine = new FaceEngine(modelDir);
  await engine.init();

  if (!fs.existsSync(TEST_IMAGE)) {
    console.error('Test image not found at', TEST_IMAGE);
    return;
  }

  // 4. Process the image
  console.log('Processing test image:', TEST_IMAGE);
  const results = await engine.processImage(TEST_IMAGE);
  
  if (results.length === 0) {
    console.log('No faces detected in test image. Creating a mock entry for structural test.');
    const mockVec = new Float32Array(512).fill(0.1).map((v, i) => v + i*0.001);
    results.push({ embedding: mockVec });
  }

  // 5. Store in DB and FAISS
  const index = new IndexFlatL2(512);
  
  db.prepare('INSERT INTO people (name) VALUES (?)').run('Test User');
  db.prepare('INSERT INTO images (filepath, processed) VALUES (?, 1)').run(TEST_IMAGE);
  db.prepare('INSERT INTO faces (image_id) VALUES (1)').run();
  
  const embedding = results[0].embedding;
  db.prepare('INSERT INTO face_embeddings (face_id, person_id, embedding_vector) VALUES (?, ?, ?)')
    .run(1, 1, Buffer.from(embedding.buffer));

  index.add(Array.from(embedding));
  index.write(INDEX_PATH);

  console.log('\nSuccess! Created:');
  console.log('- Database:', DB_PATH);
  console.log('- FAISS Index:', INDEX_PATH);
  console.log('- Vectors indexed: 1');
}

main().catch(console.error);
