'use strict';

/**
 * server.js — CrispLens v4 Node.js/Express server.
 *
 * Exposes the same REST API as the Python FastAPI backend, allowing the
 * Svelte UI (electron-app-v2/renderer) to be used without any changes.
 *
 * Usage:
 *   node server.js [port] [db-path]
 *   DB_PATH=/path/to/face_recognition.db PORT=7861 node server.js
 */

const express      = require('express');
const cookieParser = require('cookie-parser');
const cors         = require('cors');
const path         = require('path');
const fs           = require('fs');

// ── Env / CLI args ────────────────────────────────────────────────────────────

const PORT    = process.env.PORT    || process.argv[2] || 7861;
const DB_PATH = process.env.DB_PATH || process.argv[3] ||
  path.join(__dirname, '..', 'face_recognition.db');

process.env.DB_PATH = DB_PATH;

// ── App setup ────────────────────────────────────────────────────────────────

const app = express();

// ── Consolidate UI path resolution ────────────────────────────────────────────
const v4dist = path.join(__dirname, 'renderer', 'dist');
const v2dist = path.join(__dirname, '..', 'electron-app-v2', 'renderer', 'dist');
// Electron production: extraResources puts it in Resources/renderer/dist
const resourcesDist = process.resourcesPath ? path.join(process.resourcesPath, 'renderer', 'dist') : null;

let uiDist = fs.existsSync(v4dist) ? v4dist : (fs.existsSync(v2dist) ? v2dist : null);
if (!uiDist && resourcesDist && fs.existsSync(resourcesDist)) uiDist = resourcesDist;

// ── Strict Static Assets (WASM/MJS/Assets) ───────────────────────────────────
// These MUST be handled first to prevent any middleware or SPA fallback from interfering.
if (uiDist) {
  console.log(`[server] UI distribution found at: ${uiDist}`);
  express.static.mime.define({ 'application/javascript': ['mjs'], 'application/wasm': ['wasm'] });

  // MANUAL ROUTE for WASM/MJS/Assets to guarantee MIME types and avoid any catch-all interference
  app.get(['/ort-wasm/:file', '/wasm/:file', '/assets/:file'], (req, res, next) => {
    const fileName = req.params.file;
    const ext = path.extname(fileName).toLowerCase();
    
    // Determine source folder based on route
    const folder = req.path.startsWith('/assets') ? 'assets' : 'ort-wasm';
    const filePath = path.join(uiDist, folder, fileName);
    
        let finalPath = filePath;
    const { findModelDir } = require('./core/face-engine');
    const mDir = findModelDir();

    if (ext === '.onnx' || ext === '.task') {
      // Prioritize modelDir for models
      if (mDir) {
        const modelPath = path.join(mDir, fileName);
        if (fs.existsSync(modelPath)) finalPath = modelPath;
      }
    }

    if (fs.existsSync(finalPath)) {
      if (ext === '.mjs' || ext === '.js') res.setHeader('Content-Type', 'application/javascript');
      else if (ext === '.wasm') res.setHeader('Content-Type', 'application/wasm');
      else if (ext === '.css') res.setHeader('Content-Type', 'text/css');
      else if (ext === '.onnx' || ext === '.task') res.setHeader('Content-Type', 'application/octet-stream');

      res.setHeader('X-Content-Type-Options', 'nosniff');
      if (ext === '.js' || ext === '.mjs' || ext === '.css') {
        res.setHeader('Cache-Control', 'no-cache');
      } else {
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      }
      console.log(`[server] PRIORITY SERVE: ${req.path} -> ${res.getHeader('Content-Type')} from ${finalPath}`);
      return res.sendFile(finalPath);
    }`);
    res.status(404).send('Asset not found');
  });
}

app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (like mobile apps or curl)
    if (!origin) return callback(null, true);
    
    const allowedOrigins = [
      'capacitor://localhost',
      'http://localhost',
      'http://localhost:5173', // Vite dev
      'http://localhost:7861'  // Self
    ];
    
    if (allowedOrigins.includes(origin) || origin.startsWith('http://192.168.') || origin.startsWith('http://10.')) {
      callback(null, true);
    } else {
      // For development, we can be lenient or strict. 
      // Using true here allows any origin but with credentials support.
      callback(null, true); 
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept', 'Origin'],
}));
app.use(cookieParser());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// ── Request logging ───────────────────────────────────────────────────────────

app.use((req, res, next) => {
  const start = Date.now();
  if (process.env.DEBUG && ['POST', 'PUT', 'PATCH'].includes(req.method) && req.body) {
    const bodyStr = JSON.stringify(req.body);
    if (bodyStr.length < 512) console.log("  body: " + bodyStr);
  }
  res.on('finish', () => {
    const ms = Date.now() - start;
    const color = res.statusCode >= 500 ? '\x1b[31m' : res.statusCode >= 400 ? '\x1b[33m' : '\x1b[32m';
    // Use originalUrl to see the full path including /api
    console.log(`${color}${req.method}\x1b[0m ${req.originalUrl} [host: ${req.headers.host}] → ${res.statusCode} (${ms}ms)`);
  });
  next();
});

// ── Auth & session ────────────────────────────────────────────────────────────

const { sessionMiddleware } = require('./server/auth');
app.use(sessionMiddleware);

// ── Routes ────────────────────────────────────────────────────────────────────

const miscRouter    = require('./server/routes/misc');
const authRouter    = require('./server/auth').makeAuthRouter();
const imagesRouter  = require('./server/routes/images');
const peopleRouter  = require('./server/routes/people');
const facesRouter   = require('./server/routes/faces');
const searchRouter  = require('./server/routes/search');
const processRouter = require('./server/routes/process');
const ingestRouter  = require('./server/routes/ingest');
const settingsRouter = require('./server/routes/settings');
const benchmarkRouter = require('./server/routes/benchmark');

// Health (no auth required) — model_ready checked lazily
app.get('/api/health', (req, res) => {
  const { findModelDir } = require('./core/face-engine');
  const modelReady = !!findModelDir();
  let appVersion = '4.0.0-unknown';
  try {
    appVersion = fs.readFileSync(path.join(__dirname, 'app_version.txt'), 'utf8').trim();
  } catch (e) {}
  res.json({ 
    ok: true, 
    version: appVersion, 
    backend: 'node-js', 
    model_ready: modelReady,
    server_time: new Date().toISOString()
  });
});

app.use('/api/auth',       authRouter);
app.use('/api/images',     imagesRouter);
app.use('/api/people',     peopleRouter);
app.use('/api/faces',      facesRouter);
app.use('/api/search',     searchRouter);
app.use('/api/process',    processRouter);
app.use('/api/ingest',     ingestRouter);
app.use('/api/settings',   settingsRouter);
app.use('/api/benchmark',  benchmarkRouter);

// Misc routes (tags, albums, events, watchfolders, filesystem, duplicates, batch-jobs, etc.)
app.use('/api',            miscRouter);

// ── Serve ONNX models for client-side inference (browser / mobile) ───────────
// GET /models/det_10g.onnx  → SCRFD detector  (~16 MB)
// GET /models/w600k_r50.onnx → ArcFace embedder (~166 MB)
// The browser FaceEngineWeb.js fetches these once and stores them in Cache API.
{
  const { findModelDir } = require('./core/face-engine');
  const modelDir = findModelDir();
  if (modelDir) {
    app.use('/models', (req, res, next) => {
      // Only serve the two known model files — no directory traversal
      const allowed = ['det_10g.onnx', 'det_10g_int8.onnx', 'w600k_r50.onnx', 'w600k_r50_int8.onnx', 'face_detection_yunet_2023mar.onnx', 'face_landmarker.task'];
      const filename = path.basename(req.path);
      if (!allowed.includes(filename)) return res.status(404).json({ error: 'Unknown model' });
      const filePath = path.join(modelDir, filename);
      if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Model not found' });
      res.setHeader('Cache-Control', 'public, max-age=86400');
      res.setHeader('Content-Type', 'application/octet-stream');
      res.sendFile(filePath);
    });
    console.log(`[server] ONNX models served at /models/ from: ${modelDir}`);
  }
}

// ── Serve Svelte UI ───────────────────────────────────────────────────────────

if (uiDist) {
  console.log(`[server] Serving static UI from: ${uiDist}`);
  
  app.use(express.static(uiDist, {
    setHeaders: (res, filePath) => {
      if (filePath.endsWith('.mjs')) {
        res.setHeader('Content-Type', 'application/javascript');
      }
      // Service worker and entry HTML must never be cached immutably so browsers
      // always fetch the latest version and pick up new builds.
      if (filePath.endsWith('sw.js') || filePath.includes('workbox-') || filePath.endsWith('index.html')) {
        res.setHeader('Cache-Control', 'no-cache');
      }
    }
  }));

  // SPA: send index.html for non-API, non-asset routes
  app.get('*', (req, res) => {
    const p = req.path;
    
    // 1. Skip SPA fallback for known API/Asset paths
    if (p.startsWith('/api') || p.startsWith('/models') || 
        p.startsWith('/ort-wasm') || p.startsWith('/wasm') || p.startsWith('/assets')) {
      console.log(`[server] 404 for asset/API: ${p}`);
      return res.status(404).send('Not found');
    }

    // 2. Skip SPA fallback for anything with a file extension (likely a missing asset)
    const ext = path.extname(p).toLowerCase();
    const assetExts = ['.js', '.mjs', '.wasm', '.css', '.png', '.jpg', '.jpeg', '.gif', '.svg', '.ico', '.map'];
    if (ext && assetExts.includes(ext)) {
      console.log(`[server] 404 for missing asset: ${p}`);
      return res.status(404).send('Not found');
    }

    console.log(`[server] SPA fallback: ${p}`);
    if (uiDist && fs.existsSync(path.join(uiDist, 'index.html'))) {
      res.sendFile(path.join(uiDist, 'index.html'));
    } else {
      res.status(404).send('SPA Entry point not found');
    }
  });
} else {
  console.warn('[server] No renderer/dist found. API-only mode.');
  app.get('/', (req, res) => {
    res.send('<h2>CrispLens v4 API Server</h2><p>No UI build found.</p>' +
             '<p>Build the renderer: <code>cd renderer && npm run build</code></p>' +
             '<p>Or use electron-app-v2/renderer: <code>cd ../electron-app-v2/renderer && npm run build</code></p>');
  });
}

// ── Error handler ─────────────────────────────────────────────────────────────

app.use((err, req, res, _next) => {
  console.error('[server] Unhandled error:', err);
  res.status(500).json({ detail: 'Internal server error' });
});

// ── Pre-warm face engine ──────────────────────────────────────────────────────
// Load ONNX models in background at startup so re-detect / processing requests
// don't stall on first use.

setImmediate(() => {
  console.log('[server] Post-startup initialization...');
  
  // 1. Check DB connectivity immediately
  try {
    const { getDb } = require('./server/db');
    getDb(); 
    console.log('[server] Database connection verified.');
  } catch (err) {
    console.error('[server] CRITICAL: Database connection failed:', err.message);
  }

  // 2. Warm engine
  const { findModelDir } = require('./core/face-engine');
  if (findModelDir()) {
    console.log('[server] Warming up face engine...');
    require('./server/processor'); // triggers module load
    const proc = require('./server/processor');
    if (proc.warmEngine) {
      proc.warmEngine()
        .then(() => console.log('[server] Face engine warm and ready.'))
        .catch(err => console.warn('[server] Face engine warmup failed:', err.message));
    }
  } else {
    console.warn('[server] ONNX models not found — local inference will be disabled.');
  }
});

// ── Start (only when run directly, not when require()'d by Electron) ─────────

let _httpServer = null;

if (require.main === module) {
  // Direct: node server.js
  _httpServer = app.listen(PORT, () => {
    console.log('');
    console.log('┌─────────────────────────────────────────────┐');
    console.log('│  CrispLens v4 — Node.js backend             │');
    console.log('├─────────────────────────────────────────────┤');
    console.log(`│  API:  http://localhost:${PORT}/api           │`);
    console.log(`│  UI:   http://localhost:${PORT}/              │`);
    console.log(`│  DB:   ${path.basename(DB_PATH)}${' '.repeat(Math.max(0, 36 - path.basename(DB_PATH).length))}│`);
    if (process.env.DEBUG) {
      console.log('│  DEBUG mode: verbose logging enabled        │');
    }
    console.log('└─────────────────────────────────────────────┘');
    console.log('  Tip: set DEBUG=1 for verbose request/detection logs');
    console.log('');
  });
} else {
  // Required by electron-main.js — start listening on the configured PORT
  _httpServer = app.listen(PORT, '0.0.0.0', () => {
    // Quiet start for Electron mode
  });
}

module.exports = app;
module.exports.httpServer = _httpServer;
