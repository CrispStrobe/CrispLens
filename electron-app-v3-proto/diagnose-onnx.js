/**
 * diagnose-onnx.js
 */
'use strict';
const ort = require('onnxruntime-node');
const sharp = require('sharp');
const path = require('path');

async function main() {
  const modelDir = path.join(__dirname, 'models', 'buffalo_l');
  const session = await ort.InferenceSession.create(path.join(modelDir, 'det_10g.onnx'));
  
  const input = new ort.Tensor('float32', new Float32Array(3 * 640 * 640), [1, 3, 640, 640]);
  const outputs = await session.run({ [session.inputNames[0]]: input });
  
  const keys = Object.keys(outputs).sort((a,b) => parseInt(a)-parseInt(b));
  console.log('--- ONNX Output Diagnostics ---');
  keys.forEach(k => {
    const data = outputs[k].data;
    let min = Infinity, max = -Infinity, sum = 0;
    for(let i=0; i<data.length; i++) {
      if(data[i] < min) min = data[i];
      if(data[i] > max) max = data[i];
      sum += data[i];
    }
    console.log(`Key: ${k} | Dims: [${outputs[k].dims}] | Min: ${min.toFixed(4)} | Max: ${max.toFixed(4)} | Mean: ${(sum/data.length).toFixed(4)}`);
  });
}
main();
