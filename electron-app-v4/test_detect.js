'use strict';
const { FaceEngine, findModelDir } = require('./core/face-engine');
const sharp = require('sharp');

async function test() {
  const imgPath = '/Users/christianstrobele/Downloads/2025 Islamberatung 10 Jahre.jpg';
  const modelDir = findModelDir();
  if (!modelDir) { console.log('no models found'); return; }

  const engine = new FaceEngine(modelDir);
  await engine.init();

  const meta = await sharp(imgPath).metadata();
  console.log('Image:', meta.width, 'x', meta.height, 'orientation:', meta.orientation || 1);

  const t = Date.now();
  const { faces, imageWidth, imageHeight } = await engine.detectFaces(imgPath);
  console.log('Detected', faces.length, 'faces in', Date.now() - t, 'ms, display dims:', imageWidth, 'x', imageHeight);

  for (const f of faces) {
    const [x1, y1, x2, y2] = f.bbox;
    const W = imageWidth, H = imageHeight;
    console.log(
      '  score=' + f.score.toFixed(3) +
      '  norm={top:' + (y1/H).toFixed(3) +
      ' right:' + (x2/W).toFixed(3) +
      ' bottom:' + (y2/H).toFixed(3) +
      ' left:' + (x1/W).toFixed(3) + '}' +
      '  px=[' + [x1,y1,x2,y2].map(Math.round).join(',') + ']' +
      '  size=' + Math.round(x2-x1) + 'x' + Math.round(y2-y1) + 'px'
    );
  }

  console.log('\nGround truth from DB (v2 Python InsightFace):');
  console.log('  Hussein Hamdan:          top=0.425 right=0.333 bottom=0.577 left=0.257');
  console.log('  Christian Stroebele:     top=0.351 right=0.789 bottom=0.520 left=0.713');
  console.log('  Karin Schieszl-Rathgeb:  top=0.455 right=0.543 bottom=0.587 left=0.479');
}

test().catch(e => { console.error('ERROR:', e.message); process.exit(1); });

async function test2() {
  const imgPath = '/Users/christianstrobele/Downloads/image-20250729-123908-826.jpeg';
  const modelDir = findModelDir();
  const engine = new FaceEngine(modelDir);
  await engine.init();
  const meta = await sharp(imgPath).metadata();
  console.log('\n--- Image 2:', meta.width, 'x', meta.height, 'orientation:', meta.orientation || 1);
  const { faces, imageWidth, imageHeight } = await engine.detectFaces(imgPath);
  console.log('Detected', faces.length, 'faces');
  for (const f of faces) {
    const [x1,y1,x2,y2]=f.bbox, W=imageWidth, H=imageHeight;
    console.log('  score='+f.score.toFixed(3)+'  norm={top:'+(y1/H).toFixed(3)+' right:'+(x2/W).toFixed(3)+' bottom:'+(y2/H).toFixed(3)+' left:'+(x1/W).toFixed(3)+'}');
  }
  console.log('GT: Jonathan Eckstein: top=0.223 right=0.369 bottom=0.352 left=0.291');
  console.log('GT: Viktor:            top=0.165 right=0.701 bottom=0.293 left=0.627');
}
test2().catch(e => console.error(e.message));
