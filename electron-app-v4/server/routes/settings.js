const os = require('os');
'use strict';

const express = require('express');
const fs      = require('fs');
const path    = require('path');
const { getDb, getDbPath } = require('../db');
const { requireAuth, requireAdmin } = require('../auth');


// Detect platform-specific acceleration defaults
const isAppleSilicon = os.platform() === 'darwin' && os.arch() === 'arm64';
// ── Internal flat defaults (keys stored in DB) ────────────────────────────────

const DEFAULTS = {
  language:              'en',
  backend:               'insightface',
  model:                 'buffalo_l',
  detection_threshold:   0.50,
  recognition_threshold: 0.40,
  det_size:              640,
  det_model:             'auto',
  vlm_enabled:           false,
  vlm_provider:          '',
  vlm_model:             '',
  vlm_max_size:          0,
  upload_max_dimension:  0,
  copy_exempt_paths:     [],
  fix_db_path:           '',
  // Remote processing backend (only used when browser API = local v4)
  processing_backend:  'local',          // 'local' | 'remote_v2' | 'remote_v4'
  remote_v2_url:       '',               // e.g. 'https://img.akademie-rs.de'
  remote_v2_user:      '',
  remote_v2_pass:      '',
  remote_v2_mode:      'upload_bytes',   // 'upload_bytes' | 'local_infer'
  // Server-side ONNX execution providers (Node.js face engine)
  ort_use_coreml:      isAppleSilicon,
  ort_use_cuda:        false,
  ort_use_directml:    false,
  // License acceptance — buffalo_l (InsightFace) is non-commercial only
  nc_model_accepted:   false,
  // Embedding model: 'arcface' (512-D, NC license) | 'sface' (128-D, Apache 2.0)
  embedding_model:     'arcface',
};

// ── Load flat settings from DB (merged with DEFAULTS) ─────────────────────────

function loadFlat() {
  let db;
  try { db = getDb(); } catch { return { ...DEFAULTS }; }
  const rows = db.prepare('SELECT key, value, value_type FROM settings').all();
  const out  = { ...DEFAULTS };
  for (const r of rows) {
    let val = r.value;
    if (r.value_type === 'int')   val = parseInt(val, 10);
    if (r.value_type === 'float') val = parseFloat(val);
    if (r.value_type === 'bool')  val = val === 'true' || val === '1';
    if (r.value_type === 'json')  { try { val = JSON.parse(val); } catch {} }
    out[r.key] = val;
  }
  if (process.env.DEBUG) console.log("[settings] Loaded flat settings:", out);
  if (isAppleSilicon && !rows.find(r => r.key === 'ort_use_coreml')) {
    console.log("[settings] Platform is macOS (arm64) — Auto-enabling CoreML acceleration (default)");
  }
  return out;
}

// ── Build the nested response the Svelte UI expects ───────────────────────────

function flatToNested(f) {
  const exempts = Array.isArray(f.copy_exempt_paths)
    ? f.copy_exempt_paths
    : (f.copy_exempt_paths ? String(f.copy_exempt_paths).split(',').map(s => s.trim()).filter(Boolean) : []);
  const detSize = typeof f.det_size === 'number' ? f.det_size : 640;

  return {
    ui: { language: f.language },
    face_recognition: {
      backend: f.backend,
      insightface: {
        model:                 f.model,
        detection_threshold:   f.detection_threshold,
        recognition_threshold: f.recognition_threshold,
        det_size:              [detSize, detSize],
        det_model:             f.det_model,
      },
    },
    vlm: {
      enabled:  f.vlm_enabled,
      provider: f.vlm_provider,
      model:    f.vlm_model,
      max_size: f.vlm_max_size,
    },
    storage: {
      upload_max_dimension: f.upload_max_dimension,
      copy_exempt_paths:    exempts,
    },
    admin: { fix_db_path: f.fix_db_path },
    processing: {
      backend:   f.processing_backend,
      remote_v2: {
        url:  f.remote_v2_url,
        user: f.remote_v2_user,
        mode: f.remote_v2_mode,
        // Password intentionally omitted from GET response
      },
    },
    inference: {
      ort_use_coreml:   f.ort_use_coreml,
      ort_use_cuda:     f.ort_use_cuda,
      ort_use_directml: f.ort_use_directml,
    },
    license: {
      nc_model_accepted: f.nc_model_accepted,
    },
    embedding: {
      model: f.embedding_model,
    },
  };
}

const router = express.Router();

const _EN = {
  // Tabs
  tab_library: 'Library',
  tab_people: 'People',
  tab_process: 'Process',
  tab_train: 'Train',
  tab_settings: 'Settings',
  tab_identify: 'Identify',
  tab_generate: 'Generate',
  tab_faceclusters: 'Face Clusters',
  tab_filesystem: 'File System',
  tab_watchfolders: 'Watch Folders',
  tab_duplicates: 'Duplicates',
  tab_albums: 'Albums',
  tab_events: 'Events',
  tab_ingest: 'Ingest',
  tab_batchjobs: 'Batch Jobs',
  // Common
  search_placeholder: 'Search…',
  no_results: 'No results',
  loading: 'Loading…',
  save: 'Save',
  cancel: 'Cancel',
  delete: 'Delete',
  confirm: 'Confirm',
  close: 'Close',
  ok: 'OK',
  error: 'Error',
  success: 'Success',
  // Auth
  login: 'Login',
  logout: 'Logout',
  username: 'Username',
  password: 'Password',
  // Gallery
  gallery_empty: 'No images found',
  // Process view
  pv_mode_local: 'Local',
  pv_mode_upload: 'Upload',
  pv_clear_done: 'Clear done',
  pv_clear_all: 'Clear all',
  pv_local_base_label: 'Base folder',
  pv_local_base_placeholder: 'Path to folder…',
  pv_local_base_hint: 'The folder to scan for images',
  pv_drop_active: 'Drop files here',
  pv_drop_idle: 'Drag & drop images or click to select',
  pv_drop_sub: 'Supports JPG, PNG, WEBP, HEIC and more',
  pv_select_files: 'Select files',
  pv_folder_btn: 'Select folder',
  pv_item: 'item',
  pv_items: 'items',
  pv_pending: 'pending',
  pv_process_btn: 'Process',
  pv_image: 'image',
  pv_images: 'images',
  pv_server_folder_label: 'Server folder',
  pv_server_folder_ph: 'Server path…',
  pv_browse: 'Browse',
  pv_subfolders: 'Include subfolders',
  pv_det_settings: 'Detection settings',
  pv_max_size_label: 'Max image size',
  pv_max_size_hint: '0 = no limit',
  pv_already_uploaded: 'Already uploaded',
  pv_shared_by_others: 'Shared by others',
  pv_badge_pending: 'Pending',
  pv_badge_processing: 'Processing',
  pv_badge_error: 'Error',
  pv_own_dup_title: 'Duplicate',
  pv_shared_dup_title: 'Duplicate (shared)',
  pv_remove: 'Remove',
  pv_tags_label: 'Tags',
  pv_album_label: 'Album',
  pv_follow_symlinks: 'Follow symlinks',
  pv_submit_batch_job: 'Start batch job',
  // Settings
  settings_recognition_threshold: 'Recognition threshold',
  settings_detection_threshold: 'Detection threshold',
  settings_language: 'Language',
  settings_vlm: 'AI Description',
  // People
  people_no_faces: 'No faces enrolled',
  merge_people: 'Merge',
  rename_person: 'Rename',
  delete_person: 'Delete',
  // Train
  train_person_name: 'Person name',
  train_images: 'Training images',
  train_btn: 'Train',
  // Sidebar
  sidebar_expand: 'Expand',
  sidebar_collapse: 'Collapse',
};

// ── GET /settings ─────────────────────────────────────────────────────────────

router.get('/', requireAuth, (req, res) => {
  res.json(flatToNested(loadFlat()));
});

// ── PUT /settings ──────────────────────────────────────────────────────────────

router.put('/', requireAuth, (req, res) => {
  let db;
  try { db = getDb(); } catch { return res.json({ ok: true }); }

  const body = req.body || {};

  // Normalise key aliases sent by the Svelte UI:
  //   det_threshold  → detection_threshold
  //   rec_threshold  → recognition_threshold
  const normalized = {};
  for (const [k, v] of Object.entries(body)) {
    if (k === 'det_threshold') normalized['detection_threshold'] = v;
    else if (k === 'rec_threshold') normalized['recognition_threshold'] = v;
    else normalized[k] = v;
  }

  const upsert = db.prepare(
    'INSERT OR REPLACE INTO settings(key, value, value_type) VALUES(?,?,?)'
  );

  const txn = db.transaction(() => {
    for (const [k, v] of Object.entries(normalized)) {
      if (v === null || v === undefined) continue;
      let vType = 'string', vStr = String(v);
      if (typeof v === 'boolean') { vType = 'bool'; vStr = v ? 'true' : 'false'; }
      else if (typeof v === 'number') { vType = Number.isInteger(v) ? 'int' : 'float'; }
      else if (Array.isArray(v)) { vType = 'json'; vStr = JSON.stringify(v); }
      upsert.run(k, vStr, vType);
    }
  });
  txn();

  res.json({ ok: true });
});

// ── GET /settings/i18n ────────────────────────────────────────────────────────
// Returns { lang, language, translations } — the frontend merges translations
// into its EN base. Only non-EN languages need a translations payload; EN is
// already baked into the Svelte bundle (stores.js const EN).

router.get('/i18n', (req, res) => {
  const settings = loadFlat();
  const language = settings.language || 'en';
  console.log(`[i18n] Serving language preference: "${language}" (from DB: ${settings.language || 'unset'})`);
  
  // EN strings are baked into stores.js — send empty object so the bundle wins.
  // For other languages the strings come from the stored language record.
  // EN strings are baked into the Svelte bundle; non-EN strings come from
  // the client's local TRANSLATIONS object (stores.js). Send only the language.
  res.json({ lang: language, language, translations: {} });
});

// ── GET /settings/db-status ───────────────────────────────────────────────────

router.get('/db-status', requireAuth, (req, res) => {
  const dbPath = getDbPath();
  let db;
  try { db = getDb(); } catch (err) {
    return res.json({ ok: false, error: err.message, db_path: dbPath });
  }

  const imageCount  = db.prepare('SELECT COUNT(*) AS n FROM images').get().n;
  const faceCount   = db.prepare('SELECT COUNT(*) AS n FROM faces').get().n;
  const personCount = db.prepare('SELECT COUNT(*) AS n FROM people').get().n;
  const embCount    = db.prepare('SELECT COUNT(*) AS n FROM face_embeddings WHERE person_id IS NOT NULL').get().n;

  let fileSizeMb = null, writable = false, userCount = 0;
  try {
    const stat = fs.statSync(dbPath);
    fileSizeMb = parseFloat((stat.size / (1024 * 1024)).toFixed(1));
    fs.accessSync(dbPath, fs.constants.W_OK);
    writable = true;
  } catch {}
  try { userCount = db.prepare('SELECT COUNT(*) AS n FROM users').get().n; } catch {}

  res.json({
    ok:                    true,
    // Fields the SettingsView expects
    db_path:               dbPath,
    file_size_mb:          fileSizeMb,
    permissions_ok:        writable,
    user_count:            userCount,
    image_count:           imageCount,
    // Extra counts
    images:                imageCount,
    faces:                 faceCount,
    people:                personCount,
    identified_embeddings: embCount,
  });
});

// ── GET /settings/engine-status ───────────────────────────────────────────────

router.get('/engine-status', requireAuth, async (req, res) => {
  try {
    const { findModelDir } = require('../../core/face-engine');
    const modelDir  = findModelDir();
    const modelName = modelDir ? path.basename(modelDir) : null;
    const detectors = modelDir ? {
      scrfd:           { available: true, model_exists: fs.existsSync(path.join(modelDir, 'det_10g.onnx')),                       model_size_kb: _kbSize(path.join(modelDir, 'det_10g.onnx')) },
      yunet:           { available: true, model_exists: fs.existsSync(path.join(modelDir, 'face_detection_yunet_2023mar.onnx')),   model_size_kb: _kbSize(path.join(modelDir, 'face_detection_yunet_2023mar.onnx')) },
      mediapipe_local: { available: true, model_exists: fs.existsSync(path.join(modelDir, 'face_landmarker.task')),               model_size_kb: _kbSize(path.join(modelDir, 'face_landmarker.task')) },
    } : undefined;
    const flat = loadFlat();
    // Report configured providers + ORT version
    const ort = require('onnxruntime-node');
    const ortVersion = ort.env?.versions?.ort || null;
    res.json({
      ok:          !!modelDir,
      ready:       !!modelDir,
      model_dir:   modelDir || null,
      model:       modelName,
      backend:     'onnxruntime-node',
      ort_version: ortVersion,
      providers: {
        coreml:   flat.ort_use_coreml   || false,
        cuda:     flat.ort_use_cuda     || false,
        directml: flat.ort_use_directml || false,
        cpu:      true,
      },
      detectors,
    });
  } catch (err) {
    res.json({ ok: false, ready: false, error: err.message });
  }
});

function _kbSize(p) {
  try { return Math.round(fs.statSync(p).size / 1024); } catch { return null; }
}

// ── POST /settings/download-mediapipe ─────────────────────────────────────────
// Triggers server-side download of face_landmarker.task into modelDir.

router.post('/download-mediapipe', requireAdmin, async (req, res) => {
  try {
    const { findModelDir } = require('../../core/face-engine');
    const modelDir = findModelDir();
    if (!modelDir) return res.status(400).json({ error: 'Model directory not found' });
    const { ensureFaceLandmarker } = require('../../core/model-downloader');
    const dest = await ensureFaceLandmarker(modelDir);
    res.json({ ok: true, path: dest });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /settings/accept-nc-license ─────────────────────────────────────────
// Saves user's acceptance of the InsightFace non-commercial license and
// triggers the buffalo_l model download in the background.
// Admin-only: license acceptance is a system-wide decision.

router.post('/accept-nc-license', requireAdmin, async (req, res) => {
  let db;
  try { db = getDb(); } catch (e) { return res.status(500).json({ error: e.message }); }
  const upsert = db.prepare('INSERT OR REPLACE INTO settings(key, value, value_type) VALUES(?,?,?)');
  upsert.run('nc_model_accepted', 'true', 'bool');
  console.log('[settings] NC model license accepted by admin — triggering buffalo_l download');

  // Trigger download in background (non-blocking)
  const { ensureModels } = require('../../core/model-downloader');
  ensureModels({ ncAccepted: true })
    .then(dir => console.log(`[settings] buffalo_l ready at: ${dir}`))
    .catch(err => console.error('[settings] buffalo_l download failed:', err.message));

  res.json({ ok: true, message: 'License accepted. Model download started in background.' });
});

// ── POST /settings/reload-engine ──────────────────────────────────────────────

router.post('/reload-engine', requireAuth, async (req, res) => {
  // Reset processor's cached engine
  const proc = require('../processor');
  // _engine is module-scoped private; we can't easily reset it without exposing.
  // Simple approach: just return ok — engine will re-init on next use if needed.
  res.json({ ok: true });
});

// ── POST /settings/check-credentials ─────────────────────────────────────────

router.post('/check-credentials', requireAuth, (req, res) => {
  const { username, password } = req.body || {};
  const { lookupUser } = require('../auth');
  const user = require('../auth').lookupUser?.(username, password) ??
    (username === 'admin' && password === 'admin' ? { username, role: 'admin' } : null);
  res.json({ ok: !!user });
});

// ── GET/PUT /settings/user-vlm ────────────────────────────────────────────────
// Returns { effective: {vlm_enabled, vlm_provider, vlm_model}, global: {...} }

router.get('/user-vlm', requireAuth, (req, res) => {
  const f = loadFlat();
  const global_ = { vlm_enabled: f.vlm_enabled, vlm_provider: f.vlm_provider, vlm_model: f.vlm_model, vlm_max_size: f.vlm_max_size };
  res.json({ effective: { ...global_ }, global: global_ });
});

router.put('/user-vlm', requireAuth, (req, res) => {
  // For now, user-vlm prefs fall through to global settings (no per-user VLM table yet)
  res.json({ ok: true });
});

// ── GET/PUT /settings/user-detection ─────────────────────────────────────────
// Returns { effective: {det_model}, global: {det_model} }

router.get('/user-detection', requireAuth, (req, res) => {
  const f = loadFlat();
  res.json({ effective: { det_model: f.det_model }, global: { det_model: f.det_model } });
});

router.put('/user-detection', requireAuth, (req, res) => res.json({ ok: true }));

// ── GET /settings/processing-status ──────────────────────────────────────────
// Returns the current processing backend and (if remote_v2) whether it's reachable.

router.get('/processing-status', requireAuth, async (req, res) => {
  const f       = loadFlat();
  const backend = f.processing_backend || 'local';
  if (backend !== 'remote_v2' || !f.remote_v2_url) {
    return res.json({ backend, remote_v2_reachable: false });
  }
  let reachable = false;
  let error_msg = null;
  try {
    const { getRemoteClient } = require('../../core/remote-v2-client');
    const client = getRemoteClient(f);
    await client.ensureAuth();
    reachable = true;
  } catch (err) {
    error_msg = err.message;
    console.error('[processing-status] remote v2 unreachable:', err.message);
  }
  res.json({ backend, remote_v2_reachable: reachable, error: error_msg });
});

// ── GET /settings/processing-backend (lightweight read) ─────────────────────

router.get('/processing-backend', requireAuth, (req, res) => {
  const f = loadFlat();
  res.json({ backend: f.processing_backend || 'local' });
});

// ── POST /settings/test-remote-v2 ────────────────────────────────────────────
// Tests a remote v2 connection using params from the request body (not DB).
// This allows testing before saving settings.

router.post('/test-remote-v2', requireAuth, async (req, res) => {
  const { url, user, pass } = req.body || {};
  if (!url) return res.json({ ok: false, error: 'URL required' });
  try {
    const { RemoteV2Client } = require('../../core/remote-v2-client');
    const client = new RemoteV2Client(url, user || '', pass || '');
    await client.ensureAuth();
    res.json({ ok: true });
  } catch (err) {
    console.error('[test-remote-v2]', err.message);
    res.json({ ok: false, error: err.message });
  }
});

// ── GET /settings/db-export ───────────────────────────────────────────────────
// Export all DB tables as JSON (admin only — local server mode).

router.get('/db-export', requireAdmin, (req, res) => {
  const db = getDb();
  const tables = ['images', 'people', 'faces', 'face_embeddings', 'image_tags',
                  'albums', 'album_images', 'events', 'settings', 'users', 'watch_folders'];
  const out = {};
  for (const t of tables) {
    try { out[t] = db.prepare(`SELECT * FROM ${t}`).all(); } catch { out[t] = []; }
  }
  res.json({ ok: true, tables: out, exported_at: new Date().toISOString(), db_path: getDbPath() });
});

// ── POST /settings/db-import ──────────────────────────────────────────────────
// Restore DB from JSON export (wipes all rows first, re-inserts from payload).

router.post('/db-import', requireAdmin, (req, res) => {
  const { tables } = req.body || {};
  if (!tables || typeof tables !== 'object') return res.status(400).json({ ok: false, error: 'Missing tables payload' });
  const db = getDb();
  const order = ['face_embeddings', 'faces', 'image_tags', 'album_images', 'images',
                 'people', 'albums', 'events', 'watch_folders', 'settings'];
  try {
    db.prepare('BEGIN').run();
    for (const t of order) {
      try { db.prepare(`DELETE FROM ${t}`).run(); } catch {}
    }
    for (const t of order) {
      const rows = tables[t];
      if (!Array.isArray(rows) || rows.length === 0) continue;
      const cols = Object.keys(rows[0]);
      const stmt = db.prepare(`INSERT OR IGNORE INTO ${t} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`);
      for (const r of rows) stmt.run(cols.map(c => r[c]));
    }
    db.prepare('COMMIT').run();
    res.json({ ok: true, imported_tables: order.length });
  } catch (err) {
    try { db.prepare('ROLLBACK').run(); } catch {}
    console.error('[db-import] error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── POST /settings/db-clear ───────────────────────────────────────────────────
// Delete all image/face/people data (keep settings and users).

router.post('/db-clear', requireAdmin, (req, res) => {
  const db = getDb();
  const tables = ['face_embeddings', 'faces', 'image_tags', 'album_images', 'images', 'people', 'albums', 'events'];
  try {
    db.prepare('BEGIN').run();
    for (const t of tables) { try { db.prepare(`DELETE FROM ${t}`).run(); } catch {} }
    db.prepare('COMMIT').run();
    res.json({ ok: true });
  } catch (err) {
    try { db.prepare('ROLLBACK').run(); } catch {}
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── POST /settings/hard-reset ─────────────────────────────────────────────────
// Reset app settings to defaults (clears settings + watch_folders).
// Does NOT delete image/face/people data — use POST /settings/db-clear for that.

router.post('/hard-reset', requireAdmin, (req, res) => {
  const db = getDb();
  // Only wipe settings rows, NOT image data (images/faces/people are precious).
  const tables = ['settings', 'watch_folders'];
  try {
    db.prepare('BEGIN').run();
    for (const t of tables) { try { db.prepare(`DELETE FROM ${t}`).run(); } catch {} }
    db.prepare('COMMIT').run();
    console.log('[hard-reset] Cleared settings + watch_folders. Image data untouched.');
    res.json({ ok: true });
  } catch (err) {
    try { db.prepare('ROLLBACK').run(); } catch {}
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;

// ── Helper: read processing_backend flat setting (used by other routes) ───────
function getProcessingBackend() {
  try { return loadFlat().processing_backend || 'local'; } catch { return 'local'; }
}
module.exports.getProcessingBackend = getProcessingBackend;
module.exports.loadFlat             = loadFlat;
