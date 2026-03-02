'use strict';

/**
 * proto-test.js — CrispLens v4 Compatibility Proof
 *
 * Tests that the pure Node.js ArcFace pipeline produces vectors compatible
 * with the existing Python-generated FAISS/SQLite database.
 *
 * Usage:
 *   node proto-test.js [path/to/face_recognition.db]
 *
 * What it does:
 *   1. Opens the existing SQLite DB
 *   2. Finds stored face embeddings that have accessible source images
 *   3. Re-runs those images through the JS face engine
 *   4. Compares JS embedding vs stored Python embedding (cosine similarity)
 *   5. Performs a brute-force search and checks the top-1 match is correct
 *
 * Expected result: cosine similarity > 0.97 for well-aligned faces.
 */

const path     = require('path');
const fs       = require('fs');
const Database = require('better-sqlite3');
const { FaceEngine, findModelDir } = require('./core/face-engine');
const { VectorStore }              = require('./core/search');

// ── Helpers ───────────────────────────────────────────────────────────────────

function cosineSim(a, b) {
  let dot = 0, ma = 0, mb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i]*b[i]; ma += a[i]*a[i]; mb += b[i]*b[i]; }
  return dot / (Math.sqrt(ma) * Math.sqrt(mb) || 1);
}

function bar(sim) {
  const pct  = Math.round(sim * 40);
  const fill = '█'.repeat(pct) + '░'.repeat(40 - pct);
  return `[${fill}] ${(sim * 100).toFixed(2)}%`;
}

function heading(title) {
  const line = '─'.repeat(60);
  console.log(`\n${line}\n  ${title}\n${line}`);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const defaultDb  = path.join(__dirname, '..', 'face_recognition.db');
  const dbPath     = process.argv[2] || defaultDb;
  const queryImage = process.argv[3] || null;  // optional: search the DB with this image

  if (!fs.existsSync(dbPath)) {
    console.error(`DB not found: ${dbPath}`);
    console.error(`Usage: node proto-test.js [path/to/face_recognition.db]`);
    process.exit(1);
  }

  heading('CrispLens v4 — Compatibility Proof');
  console.log(`DB:     ${dbPath}`);

  // ── Check models ────────────────────────────────────────────────────────────
  const modelDir = findModelDir();
  if (!modelDir) {
    console.error(
      '\nModels not found! Run one of:\n' +
      '  1. Install InsightFace Python (downloads models automatically)\n' +
      '  2. node core/model-downloader.js\n'
    );
    process.exit(1);
  }
  console.log(`Models: ${modelDir}`);

  // ── Load sample faces from DB ────────────────────────────────────────────────
  const db = new Database(dbPath, { readonly: true });

  // Pick up to 10 faces: prefer verified ones with accessible images
  const samples = db.prepare(`
    SELECT
      fe.id            AS emb_id,
      fe.face_id,
      fe.person_id,
      fe.embedding_vector,
      fe.embedding_dimension,
      p.name           AS person_name,
      i.filepath       AS image_path
    FROM face_embeddings fe
    JOIN faces   f  ON fe.face_id   = f.id
    JOIN images  i  ON f.image_id   = i.id
    LEFT JOIN people p ON fe.person_id = p.id
    WHERE fe.embedding_vector IS NOT NULL
      AND fe.person_id IS NOT NULL
      AND fe.embedding_dimension = 512
    ORDER BY fe.verified DESC, fe.recognition_confidence DESC
    LIMIT 20
  `).all();

  db.close();

  if (samples.length === 0) {
    console.log('\nNo identified 512D faces in DB. Train some faces first, then re-run.');
    process.exit(0);
  }

  // Resolve paths: try absolute first, then relative to the DB directory,
  // then relative to the current working directory.
  const dbDir      = path.dirname(path.resolve(dbPath));
  const candidates = p => [p, path.join(dbDir, p), path.join(process.cwd(), p)];

  const accessible = samples.filter(s => {
    if (!s.image_path) return false;
    const found = candidates(s.image_path).find(c => fs.existsSync(c));
    if (found) s._resolvedPath = found;
    return !!found;
  });

  if (accessible.length === 0) {
    console.log('\nDB has embeddings, but source images are not accessible at their stored paths.');
    console.log('Stored image paths (first 5):');
    samples.slice(0, 5).forEach(s => console.log('  ', s.image_path));
    console.log(
      '\nTo run the compatibility test, make the training images accessible ' +
      '(or pass the project root as the first argument).'
    );
    if (!queryImage) {
      console.log('\nAlternative: run with a known face image to prove the engine works:');
      console.log('  node proto-test.js <db> <image.jpg>');
      process.exit(0);
    }
    // Fall through to query-image-only mode below
  }

  const toTest = accessible.slice(0, 5);
  // Use resolved paths for actual file access
  toTest.forEach(s => { s.image_path = s._resolvedPath || s.image_path; });

  // ── Init engine ──────────────────────────────────────────────────────────────
  heading('Initialising face engine');
  const engine = new FaceEngine(modelDir);
  await engine.init();

  // ── Load vector store ────────────────────────────────────────────────────────
  heading('Loading vector store');
  const store = new VectorStore(dbPath);
  store.load();

  // ── Run comparison (skip if no accessible training images) ────────────────────
  if (toTest.length === 0) {
    console.log('Skipping embedding comparison — no accessible training images.');
  }
  heading(`Processing ${toTest.length} test sample(s)`);

  const results = [];

  for (const sample of toTest) {
    console.log(`\n[emb #${sample.emb_id}] ${sample.person_name}  —  ${path.basename(sample.image_path)}`);

    let faces;
    try {
      faces = await engine.processImage(sample.image_path);
    } catch (err) {
      console.log(`  ⚠  Engine error: ${err.message}`);
      continue;
    }

    if (faces.length === 0) {
      console.log('  ⚠  No faces detected (image may have changed or face is too small).');
      continue;
    }

    // Use the highest-confidence face (usually correct for training images)
    const bestFace = faces.reduce((a, b) => a.score > b.score ? a : b);

    // Compare vs stored Python embedding
    const storedVec = new Float32Array(
      sample.embedding_vector.buffer,
      sample.embedding_vector.byteOffset,
      sample.embedding_dimension
    );
    const sim = cosineSim(bestFace.embedding, storedVec);

    console.log(`  Detection confidence:  ${(bestFace.score * 100).toFixed(1)}%`);
    console.log(`  Faces found:           ${faces.length}`);
    console.log(`  Embedding similarity:  ${bar(sim)}`);

    // Search against all stored embeddings
    const topK = store.search(bestFace.embedding, 3);
    const top1 = topK[0];
    const correct = top1 && top1.personId === sample.person_id;

    console.log(`  Search top-1:          ${top1 ? top1.personName : 'none'} ` +
      `(sim=${top1 ? (top1.similarity * 100).toFixed(2) : '-'}%)  ` +
      (correct ? '✅ CORRECT' : `❌ expected "${sample.person_name}"`));

    results.push({ sample, sim, correct, facesFound: faces.length });
  }

  // ── Summary ──────────────────────────────────────────────────────────────────
  heading('Summary');

  if (results.length === 0 && !queryImage) {
    console.log('No results — no accessible images could be processed.');
    process.exit(0);
  } else if (results.length === 0) {
    console.log('No training image results — proceeding to query image test.');
  }

  const nCorrect = results.filter(r => r.correct).length;

  if (results.length > 0) {
    const avgSim = results.reduce((s, r) => s + r.sim, 0) / results.length;

    console.log(`Samples processed:    ${results.length} / ${toTest.length}`);
    console.log(`Avg embedding sim:    ${(avgSim * 100).toFixed(2)}%`);
    console.log(`Search accuracy:      ${nCorrect} / ${results.length}`);
    console.log('');

    if (avgSim >= 0.97) {
      console.log('✅  COMPATIBLE — JS vectors match Python ArcFace embeddings.');
      console.log('    The FAISS database can be queried directly from Node.js.');
    } else if (avgSim >= 0.90) {
      console.log('⚠   MOSTLY COMPATIBLE — small alignment drift detected.');
      console.log('    Check face-align.js and ensure models are buffalo_l (not buffalo_sc).');
    } else {
      console.log('❌  INCOMPATIBLE — large embedding drift.');
      console.log('    Possible causes:');
      console.log('    • Wrong model (ensure w600k_r50.onnx from buffalo_l)');
      console.log('    • Model output names differ from expected order');
      console.log('    • Image preprocessing mismatch');
    }
  } else {
    console.log('Samples processed:    0 / 0  (no accessible training images — skipped)');
    console.log('');
    console.log('ℹ️   Run with accessible training images to check embedding compatibility.');
  }

  store.close();

  // ── Optional: search DB with a user-supplied image ──────────────────────────
  if (queryImage) {
    heading(`Searching DB with query image: ${path.basename(queryImage)}`);
    const qStore = new VectorStore(dbPath);
    qStore.load();
    const engine2 = new FaceEngine(modelDir);
    await engine2.init();

    const qFaces = await engine2.processImage(queryImage);
    console.log(`Faces found: ${qFaces.length}`);
    for (let fi = 0; fi < qFaces.length; fi++) {
      const top = qStore.search(qFaces[fi].embedding, 3);
      console.log(`\nFace ${fi + 1} (confidence ${(qFaces[fi].score*100).toFixed(1)}%):`);
      top.forEach((r, ri) => {
        console.log(`  ${ri+1}. ${r.personName} — ${(r.similarity*100).toFixed(2)}%  [${path.basename(r.filepath||'')}]`);
      });
    }
    qStore.close();
  }

  process.exit(nCorrect === results.length ? 0 : 1);
}

main().catch(err => { console.error('\nFatal:', err); process.exit(1); });
