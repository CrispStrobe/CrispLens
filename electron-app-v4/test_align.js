'use strict';
/**
 * test_align.js — Diagnose the face alignment / embedding issue.
 * Prints landmarks, saves the 112×112 aligned crop as PNG for visual inspection.
 */
const path  = require('path');
const sharp = require('sharp');
const { FaceEngine, findModelDir } = require('./core/face-engine');
const { warpToArcFace } = require('./core/face-align');
const Database = require('better-sqlite3');

const DB_PATH  = path.join(__dirname, '..', 'face_recognition.db');
const IMG_PATH = '/Users/christianstrobele/Downloads/2025 Islamberatung 10 Jahre.jpg';
// person: Hussein Hamdan  bbox ≈ top=0.425 right=0.333 bottom=0.577 left=0.257

async function main() {
  const db = new Database(DB_PATH, { readonly: true });

  // Get stored Python embedding for Hussein Hamdan in this image
  const row = db.prepare(`
    SELECT fe.embedding_vector, p.name
    FROM faces f
    JOIN face_embeddings fe ON fe.face_id=f.id
    JOIN people p ON p.id=fe.person_id
    JOIN images i ON i.id=f.image_id
    WHERE i.filepath=? AND length(p.name)>5
    ORDER BY f.id
    LIMIT 1
  `).get(IMG_PATH);

  if (!row) { console.log('No stored face found for this image'); return; }
  console.log('Person:', row.name);
  const storedVec = new Float32Array(row.embedding_vector.buffer, row.embedding_vector.byteOffset, 512);

  // Detect with v4
  const modelDir = findModelDir();
  const engine = new FaceEngine(modelDir);
  await engine.init();

  const { faces, imageWidth, imageHeight } = await engine.detectFaces(IMG_PATH);
  console.log(`Detected ${faces.length} faces, display dims: ${imageWidth}×${imageHeight}`);

  // Print all landmarks
  for (let fi = 0; fi < faces.length; fi++) {
    const f = faces[fi];
    const [x1,y1,x2,y2] = f.bbox;
    const W=imageWidth, H=imageHeight;
    console.log(`\nFace ${fi}: score=${f.score.toFixed(3)}  bbox norm={top:${(y1/H).toFixed(3)} right:${(x2/W).toFixed(3)} bottom:${(y2/H).toFixed(3)} left:${(x1/W).toFixed(3)}}`);
    console.log('  Landmarks (pixel coords):');
    const lmNames = ['right_eye','left_eye','nose','right_mouth','left_mouth'];
    for (let k=0; k<5; k++) {
      const [lx, ly] = f.landmarks[k];
      console.log(`    [${k}] ${lmNames[k]}: x=${Math.round(lx)} y=${Math.round(ly)}  (norm: ${(lx/W).toFixed(3)}, ${(ly/H).toFixed(3)})`);
    }

    // Are landmarks inside the bbox?
    for (let k=0; k<5; k++) {
      const [lx, ly] = f.landmarks[k];
      const inside = lx >= x1 && lx <= x2 && ly >= y1 && ly <= y2;
      if (!inside) console.log(`    *** landmark [${k}] is OUTSIDE bbox!`);
    }
  }

  // Use first face (should be Hussein Hamdan)
  const face = faces[0];

  // Read image buffer
  const srcBuf = await sharp(IMG_PATH).rotate().removeAlpha().raw().toBuffer();
  console.log(`\nSource buffer: ${srcBuf.length} bytes = ${imageWidth}×${imageHeight}×3? ${srcBuf.length === imageWidth*imageHeight*3 ? 'YES ✓' : 'NO ✗'}`);

  // Produce aligned crop
  const aligned = warpToArcFace(srcBuf, imageWidth, imageHeight, face.landmarks);

  // Save as PNG to inspect visually
  await sharp(aligned, { raw: { width:112, height:112, channels:3 } })
    .png()
    .toFile('/tmp/aligned_face.png');
  console.log('\nSaved aligned face crop → /tmp/aligned_face.png  (open to check if it looks right)');

  // Compute embedding
  const v4Vec = await engine.embedFace(IMG_PATH, face.landmarks, imageWidth, imageHeight);
  let dot = 0;
  for (let i=0; i<512; i++) dot += storedVec[i]*v4Vec[i];
  console.log(`\nCosine similarity: ${dot.toFixed(4)}`);

  // Also try with BGR order (swap R and B channels in aligned)
  const alignedBGR = Buffer.from(aligned);
  for (let i=0; i<112*112; i++) {
    const r = alignedBGR[i*3], b = alignedBGR[i*3+2];
    alignedBGR[i*3] = b; alignedBGR[i*3+2] = r;
  }
  await sharp(alignedBGR, { raw:{width:112,height:112,channels:3} }).png().toFile('/tmp/aligned_face_bgr.png');

  // Try embedding with BGR buffer directly
  const spatial = 112*112;
  const f32BGR = new Float32Array(3*spatial);
  for (let i=0; i<spatial; i++) {
    f32BGR[i          ] = (alignedBGR[i*3  ]-127.5)/128.0; // after swap: this is B
    f32BGR[i+spatial  ] = (alignedBGR[i*3+1]-127.5)/128.0; // G
    f32BGR[i+spatial*2] = (alignedBGR[i*3+2]-127.5)/128.0; // after swap: this is R
  }
  const ort = require('onnxruntime-node');
  const { l2Normalize } = require('./core/face-engine');
  const recOutputs = await engine.recModel.run({
    [engine.recModel.inputNames[0]]: new ort.Tensor('float32', f32BGR, [1,3,112,112])
  });
  const bgrVec = l2Normalize(Float32Array.from(recOutputs[engine.recModel.outputNames[0]].data));
  let dotBGR = 0;
  for (let i=0; i<512; i++) dotBGR += storedVec[i]*bgrVec[i];
  console.log(`Cosine similarity (BGR channel order): ${dotBGR.toFixed(4)}`);

  db.close();
}

main().catch(e => { console.error('ERROR:', e.message, e.stack); });
