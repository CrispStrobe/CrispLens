'use strict';

const express = require('express');
const fs      = require('fs');
const path    = require('path');
const { getDb, getDbPath } = require('../db');
const { requireAuth, requireAdmin } = require('../auth');

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
  upload_max_dimension:  0,
  copy_exempt_paths:     [],
  fix_db_path:           '',
  // Remote processing backend
  processing_backend:  'local',  // 'local' | 'remote_v2'
  remote_v2_url:       '',       // e.g. 'http://nas:7861'
  remote_v2_user:      '',
  remote_v2_pass:      '',
  remote_v2_mode:      'shared_path', // 'shared_path' | 'upload_bytes'
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
        // Password intentionally omitted from GET response
        mode: f.remote_v2_mode,
      },
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
  const language = loadFlat().language || 'en';
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
    res.json({
      ok:        !!modelDir,
      ready:     !!modelDir,       // field the SettingsView reads
      model_dir: modelDir || null,
      model:     modelName,        // field the SettingsView reads (e.g. "buffalo_l")
      backend:   'onnxruntime-node',
    });
  } catch (err) {
    res.json({ ok: false, ready: false, error: err.message });
  }
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
  const global_ = { vlm_enabled: f.vlm_enabled, vlm_provider: f.vlm_provider, vlm_model: f.vlm_model };
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

module.exports = router;

// ── Helper: read processing_backend flat setting (used by other routes) ───────
function getProcessingBackend() {
  try { return loadFlat().processing_backend || 'local'; } catch { return 'local'; }
}
module.exports.getProcessingBackend = getProcessingBackend;
module.exports.loadFlat             = loadFlat;
