/**
 * index.js (v3-proto)
 * Orchestrates the download and initialization of the pure Node.js AI engine.
 */

'use strict';

const { ensureModels } = require('./model-manager');
const { FaceEngine } = require('./face-engine');

async function main() {
  console.log('--- CrispLens v3 Prototype: Pure Node.js Inference ---');
  
  try {
    // 1. Ensure models are downloaded (buffalo_l from GitHub)
    const modelDir = await ensureModels();
    
    // 2. Initialize the Engine
    const engine = new FaceEngine(modelDir);
    await engine.init();
    
    console.log('
Success! The pure Node.js engine is ready.');
    console.log('You can now perform face detection and recognition WITHOUT Python.');
    
    // Suggest next step
    console.log('
To test with an image:');
    console.log('1. Place an image in this folder');
    console.log('2. Add logic to face-engine.js to run detection');
    
  } catch (err) {
    console.error('
Prototype failed:', err);
  }
}

main();
