/**
 * model-manager.js
 * Downloads and manages InsightFace models for the pure Node.js engine.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const AdmZip = require('adm-zip');

const MODEL_URL = 'https://github.com/deepinsight/insightface/releases/download/v0.7/buffalo_l.zip';
const MODELS_DIR = path.join(__dirname, 'models');
const BUFFALO_DIR = path.join(MODELS_DIR, 'buffalo_l');

async function downloadFile(url, dest) {
  const writer = fs.createWriteStream(dest);
  console.log(`Downloading model from ${url}...`);
  
  const response = await axios({
    url,
    method: 'GET',
    responseType: 'stream'
  });

  const totalLength = response.headers['content-length'];
  let downloadedLength = 0;

  response.data.on('data', (chunk) => {
    downloadedLength += chunk.length;
    const progress = (downloadedLength / totalLength * 100).toFixed(2);
    // Simple progress output
    if (downloadedLength % (1024 * 1024 * 5) < chunk.length) {
      process.stdout.write(`\rProgress: ${progress}% (${(downloadedLength / 1024 / 1024).toFixed(2)} MB)`);
    }
  });

  response.data.pipe(writer);

  return new Promise((resolve, reject) => {
    writer.on('finish', () => {
      console.log('\nDownload complete.');
      resolve();
    });
    writer.on('error', reject);
  });
}

async function ensureModels() {
  if (!fs.existsSync(MODELS_DIR)) {
    fs.mkdirSync(MODELS_DIR, { recursive: true });
  }

  // We look for at least the recognition model (w600k_r50.onnx) and detection model (det_10g.onnx)
  const requiredFiles = [
    'w600k_r50.onnx',
    'det_10g.onnx'
  ];

  const allExist = requiredFiles.every(f => fs.existsSync(path.join(BUFFALO_DIR, f)));

  if (allExist) {
    console.log('Models already exist in', BUFFALO_DIR);
    return BUFFALO_DIR;
  }

  const zipPath = path.join(MODELS_DIR, 'buffalo_l.zip');
  
  try {
    await downloadFile(MODEL_URL, zipPath);
    console.log('Extracting models...');
    const zip = new AdmZip(zipPath);
    zip.extractAllTo(BUFFALO_DIR, true);
    console.log('Extraction complete.');
    
    // Cleanup zip
    fs.unlinkSync(zipPath);
    return BUFFALO_DIR;
  } catch (err) {
    console.error('Error downloading/extracting models:', err.message);
    throw err;
  }
}

module.exports = { ensureModels };

if (require.main === module) {
  ensureModels().catch(console.error);
}
