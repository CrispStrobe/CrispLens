'use strict';
/**
 * test_embed.js — Compare v4 Node.js embedding vs stored Python embedding.
 *
 * Finds a real image with a named person, re-runs v4 embedding on it,
 * then prints cosine similarity against ALL stored embeddings for that person.
 */
const path = require('path');
const { FaceEngine, findModelDir, l2Normalize } = require('./core/face-engine');
const { VectorStore } = require('./core/search');
const Database = require('better-sqlite3');

const DB_PATH = path.join(__dirname, '..', 'face_recognition.db');

async function main() {
  const db = new Database(DB_PATH, { readonly: true });

  // Find a real image with a named face where the image file still exists
  const rows = db.prepare(`
    SELECT i.id as image_id, i.filepath, i.width, i.height,
           p.name as person_name, p.id as person_id,
           f.id as face_id, f.bbox_top, f.bbox_right, f.bbox_bottom, f.bbox_left,
           fe.embedding_vector
    FROM faces f
    JOIN face_embeddings fe ON fe.face_id = f.id
    JOIN people p ON p.id = fe.person_id
    JOIN images i ON i.id = f.image_id
    WHERE f.image_id > 0
      AND fe.embedding_vector IS NOT NULL
      AND length(p.name) > 5
    ORDER BY f.id DESC
    LIMIT 20
  `).all();

  const fs = require('fs');
  let testRow = null;
  for (const r of rows) {
    if (fs.existsSync(r.filepath)) { testRow = r; break; }
  }
  if (!testRow) { console.log('No accessible test image found'); return; }

  console.log(`Test image: ${testRow.filepath}`);
  console.log(`Person:     ${testRow.person_name} (id ${testRow.person_id})`);
  console.log(`Face bbox:  top=${testRow.bbox_top.toFixed(3)} right=${testRow.bbox_right.toFixed(3)} bottom=${testRow.bbox_bottom.toFixed(3)} left=${testRow.bbox_left.toFixed(3)}`);

  // Load stored Python embedding for this face
  const storedBlob = testRow.embedding_vector;
  const storedVec  = new Float32Array(storedBlob.buffer, storedBlob.byteOffset, 512);
  console.log(`Stored emb: first 4 floats = [${Array.from(storedVec.slice(0,4)).map(v=>v.toFixed(4)).join(', ')}]`);
  console.log(`Stored L2 norm: ${Math.sqrt(storedVec.reduce((s,v)=>s+v*v,0)).toFixed(6)} (should be ~1.0)`);

  // Re-run v4 ArcFace on the same image
  const modelDir = findModelDir();
  if (!modelDir) { console.log('Models not found'); return; }
  const engine = new FaceEngine(modelDir);
  await engine.init();

  console.log('\nRunning v4 face detection...');
  const { faces, imageWidth, imageHeight } = await engine.detectFaces(testRow.filepath);
  console.log(`Detected ${faces.length} face(s) in image (${imageWidth}×${imageHeight})`);

  if (faces.length === 0) { console.log('No faces detected!'); return; }

  // Find the face closest to the stored bbox
  const storedCx = (testRow.bbox_left + testRow.bbox_right) / 2;
  const storedCy = (testRow.bbox_top  + testRow.bbox_bottom) / 2;
  let bestFace = null, bestDist = Infinity;
  for (const f of faces) {
    const [x1,y1,x2,y2] = f.bbox;
    const cx = ((x1/imageWidth) + (x2/imageWidth)) / 2;
    const cy = ((y1/imageHeight) + (y2/imageHeight)) / 2;
    const d  = Math.hypot(cx - storedCx, cy - storedCy);
    if (d < bestDist) { bestDist = d; bestFace = f; }
  }
  const [x1,y1,x2,y2] = bestFace.bbox;
  const W = imageWidth, H = imageHeight;
  console.log(`Best match face: top=${(y1/H).toFixed(3)} right=${(x2/W).toFixed(3)} bottom=${(y2/H).toFixed(3)} left=${(x1/W).toFixed(3)}  (center dist=${bestDist.toFixed(3)})`);

  // Compute v4 embedding
  console.log('\nComputing v4 ArcFace embedding...');
  const v4Vec = await engine.embedFace(testRow.filepath, bestFace.landmarks, imageWidth, imageHeight);
  console.log(`v4 emb:     first 4 floats = [${Array.from(v4Vec.slice(0,4)).map(v=>v.toFixed(4)).join(', ')}]`);
  console.log(`v4 L2 norm: ${Math.sqrt(v4Vec.reduce((s,v)=>s+v*v,0)).toFixed(6)} (should be ~1.0)`);

  // Dot product = cosine similarity (both L2-normalized)
  let dot = 0;
  for (let i = 0; i < 512; i++) dot += storedVec[i] * v4Vec[i];
  console.log(`\nCosine similarity (v4 vs stored Python): ${dot.toFixed(4)}`);
  console.log(`Recognition threshold is 0.40 — ${dot >= 0.4 ? 'PASS ✓' : 'FAIL ✗ (too low)'}`);

  // Also search the full VectorStore
  console.log('\nSearching VectorStore (top 5):');
  const store = new VectorStore(DB_PATH);
  store.load();
  const results = store.search(v4Vec, 5);
  for (const r of results) {
    console.log(`  sim=${r.similarity.toFixed(4)}  person="${r.personName}"  face_id=${r.faceId}`);
  }
  store.close();
  db.close();
}

main().catch(e => { console.error('ERROR:', e.message); console.error(e.stack); });
