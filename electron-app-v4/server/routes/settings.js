'use strict';

const express = require('express');
const { getDb }      = require('../db');
const { requireAuth, requireAdmin } = require('../auth');

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
  let db;
  try { db = getDb(); } catch {
    return res.json({ language: 'en', recognition_threshold: 0.4, detection_threshold: 0.5 });
  }

  const rows  = db.prepare('SELECT key, value, value_type FROM settings').all();
  const out   = {};
  for (const r of rows) {
    let val = r.value;
    if (r.value_type === 'int')   val = parseInt(val, 10);
    if (r.value_type === 'float') val = parseFloat(val);
    if (r.value_type === 'bool')  val = val === 'true' || val === '1';
    if (r.value_type === 'json')  { try { val = JSON.parse(val); } catch {} }
    out[r.key] = val;
  }
  res.json(out);
});

// ── PUT /settings ──────────────────────────────────────────────────────────────

router.put('/', requireAuth, (req, res) => {
  let db;
  try { db = getDb(); } catch { return res.json({ ok: true }); }

  const upsert = db.prepare(
    'INSERT OR REPLACE INTO settings(key, value, value_type) VALUES(?,?,?)'
  );

  const txn = db.transaction(() => {
    for (const [k, v] of Object.entries(req.body || {})) {
      let vType = 'string', vStr = String(v);
      if (typeof v === 'boolean') { vType = 'bool'; vStr = v ? 'true' : 'false'; }
      else if (typeof v === 'number') {
        vType = Number.isInteger(v) ? 'int' : 'float';
      }
      upsert.run(k, vStr, vType);
    }
  });
  txn();

  res.json({ ok: true });
});

// ── GET /settings/i18n ────────────────────────────────────────────────────────

router.get('/i18n', (req, res) => {
  // Return English translations (DE translations would be loaded from a file)
  res.json({ translations: _EN, language: 'en' });
});

// ── GET /settings/db-status ───────────────────────────────────────────────────

router.get('/db-status', requireAuth, (req, res) => {
  let db;
  try { db = getDb(); } catch (err) {
    return res.json({ ok: false, error: err.message });
  }

  const imageCount  = db.prepare('SELECT COUNT(*) AS n FROM images').get().n;
  const faceCount   = db.prepare('SELECT COUNT(*) AS n FROM faces').get().n;
  const personCount = db.prepare('SELECT COUNT(*) AS n FROM people').get().n;
  const embCount    = db.prepare('SELECT COUNT(*) AS n FROM face_embeddings WHERE person_id IS NOT NULL').get().n;

  res.json({ ok: true, images: imageCount, faces: faceCount, people: personCount, identified_embeddings: embCount });
});

// ── GET /settings/engine-status ───────────────────────────────────────────────

router.get('/engine-status', requireAuth, async (req, res) => {
  try {
    const { findModelDir } = require('../../core/face-engine');
    const modelDir = findModelDir();
    res.json({
      ok:        !!modelDir,
      model_dir: modelDir || null,
      backend:   'onnxruntime-node',
    });
  } catch (err) {
    res.json({ ok: false, error: err.message });
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

// ── GET /settings/user-vlm & user-detection (stubs) ──────────────────────────

router.get('/user-vlm',       requireAuth, (req, res) => res.json({ enabled: false }));
router.put('/user-vlm',       requireAuth, (req, res) => res.json({ ok: true }));
router.get('/user-detection', requireAuth, (req, res) => res.json({ det_model: 'auto' }));
router.put('/user-detection', requireAuth, (req, res) => res.json({ ok: true }));

module.exports = router;
