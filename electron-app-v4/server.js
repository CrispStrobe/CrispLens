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

app.use(cors({
  origin:      true,
  credentials: true,
}));
app.use(cookieParser());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// ── Request logging ───────────────────────────────────────────────────────────

app.use((req, res, next) => {
  const start = Date.now();
  if (process.env.DEBUG && ['POST', 'PUT', 'PATCH'].includes(req.method) && req.body) {
    const bodyStr = JSON.stringify(req.body);
    if (bodyStr.length < 512) console.log(`  body: ${bodyStr}`);
  }
  res.on('finish', () => {
    const ms = Date.now() - start;
    const color = res.statusCode >= 500 ? '\x1b[31m' : res.statusCode >= 400 ? '\x1b[33m' : '\x1b[32m';
    console.log(`${color}${req.method}\x1b[0m ${req.path} → ${res.statusCode} (${ms}ms)`);
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

// Health (no auth required) — model_ready checked lazily
app.get('/api/health', (req, res) => {
  const { findModelDir } = require('./core/face-engine');
  const modelReady = !!findModelDir();
  res.json({ ok: true, version: '4.0.0', backend: 'node-js', model_ready: modelReady });
});

app.use('/api/auth',       authRouter);
app.use('/api/images',     imagesRouter);
app.use('/api/people',     peopleRouter);
app.use('/api/faces',      facesRouter);
app.use('/api/search',     searchRouter);
app.use('/api/process',    processRouter);
app.use('/api/ingest',     ingestRouter);
app.use('/api/settings',   settingsRouter);

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
      const allowed = ['det_10g.onnx', 'w600k_r50.onnx', 'face_detection_yunet_2023mar.onnx'];
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

// Try v4's own renderer/dist first, then v2's renderer/dist
const v4dist = path.join(__dirname, 'renderer', 'dist');
const v2dist = path.join(__dirname, '..', 'electron-app-v2', 'renderer', 'dist');
const uiDist = fs.existsSync(v4dist) ? v4dist : (fs.existsSync(v2dist) ? v2dist : null);

if (uiDist) {
  console.log(`[server] Serving UI from: ${uiDist}`);
  app.use(express.static(uiDist));
  // SPA: send index.html for non-API routes
  app.get('*', (req, res) => {
    if (req.path.startsWith('/api')) return;
    res.sendFile(path.join(uiDist, 'index.html'));
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
  const { findModelDir } = require('./core/face-engine');
  if (findModelDir()) {
    require('./server/processor'); // triggers module load
    // Warm up engine (model loading is async; errors are non-fatal)
    const proc = require('./server/processor');
    if (proc.warmEngine) proc.warmEngine().catch(() => {});
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
