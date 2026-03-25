'use strict';
/**
 * routes/archive.js — REST API for the Bildarchiv / Bildauswahl workflow.
 *
 * Endpoints:
 *   GET  /archive/config            — get archive config (all users)
 *   PUT  /archive/config            — update archive config (admin only)
 *   GET  /archive/choices           — get existing field values for autocomplete
 *   POST /archive/organize          — organize image(s) to Bildarchiv
 *   POST /archive/bildauswahl       — copy/move image(s) to Bildauswahl
 *   POST /archive/rename-batch      — rename/re-sort archived images
 *   POST /archive/write-exif        — write EXIF metadata to file(s)
 *   GET  /archive/resolve-path/:id  — get best available path for image
 */

const express = require('express');
const { requireAuth, requireAdmin } = require('../auth');
const { getDb } = require('../db');
const {
  getArchiveConfig,
  saveArchiveConfig,
  getArchiveChoices,
  organizeImage,
  renameArchiveImage,
  writeExifMetadata,
  resolveImagePath,
  checkExiftoolAvailable,
} = require('../../core/archive-manager');

const router = express.Router();

// ── GET /archive/config ────────────────────────────────────────────────────────

router.get('/config', requireAuth, (req, res) => {
  console.log('[archive-routes] GET /config');
  try {
    const db  = getDb();
    const cfg = getArchiveConfig(db);
    res.json({ ok: true, config: cfg });
  } catch (err) {
    console.error('[archive-routes] GET /config error:', err.message);
    res.status(500).json({ detail: err.message });
  }
});

// ── PUT /archive/config ────────────────────────────────────────────────────────

router.put('/config', requireAdmin, (req, res) => {
  console.log('[archive-routes] PUT /config body keys:', Object.keys(req.body || {}));
  try {
    const db = getDb();
    const incoming = req.body || {};

    if (typeof incoming !== 'object' || Array.isArray(incoming)) {
      return res.status(400).json({ detail: 'Request body must be a JSON object' });
    }

    // Validate fields count (max 10)
    if (incoming.fields && incoming.fields.length > 10) {
      return res.status(400).json({ detail: 'Maximum 10 custom fields allowed' });
    }

    // Merge with existing config to avoid overwriting unset keys
    const existing = getArchiveConfig(db);
    const merged = {
      ...existing,
      ...incoming,
      bildarchiv:  { ...existing.bildarchiv,  ...(incoming.bildarchiv  || {}) },
      bildauswahl: { ...existing.bildauswahl, ...(incoming.bildauswahl || {}) },
      exif_mapping: { ...existing.exif_mapping, ...(incoming.exif_mapping || {}) },
      fields: incoming.fields || existing.fields,
    };

    saveArchiveConfig(db, merged);
    console.log('[archive-routes] PUT /config saved');
    res.json({ ok: true, config: merged });
  } catch (err) {
    console.error('[archive-routes] PUT /config error:', err.message);
    res.status(500).json({ detail: err.message });
  }
});

// ── GET /archive/choices ───────────────────────────────────────────────────────

router.get('/choices', requireAuth, (req, res) => {
  console.log('[archive-routes] GET /choices');
  try {
    const db = getDb();
    const choices = getArchiveChoices(db);
    res.json({ ok: true, choices });
  } catch (err) {
    console.error('[archive-routes] GET /choices error:', err.message);
    res.status(500).json({ detail: err.message });
  }
});

// ── POST /archive/organize ─────────────────────────────────────────────────────

router.post('/organize', requireAuth, async (req, res) => {
  const { image_ids, meta, action, archive_type = 'bildarchiv', write_exif = false } = req.body || {};
  console.log(`[archive-routes] POST /organize ids=${JSON.stringify(image_ids)} action=${action} type=${archive_type} write_exif=${write_exif}`);

  if (!Array.isArray(image_ids) || image_ids.length === 0) {
    return res.status(400).json({ detail: 'image_ids must be a non-empty array' });
  }
  if (!['copy', 'move', 'leave'].includes(action)) {
    return res.status(400).json({ detail: 'action must be copy | move | leave' });
  }
  if (!['bildarchiv', 'bildauswahl'].includes(archive_type)) {
    return res.status(400).json({ detail: 'archive_type must be bildarchiv | bildauswahl' });
  }

  try {
    const db = getDb();
    const archiveCfg = getArchiveConfig(db);
    const results = [];

    for (const imageId of image_ids) {
      const result = await organizeImage({
        db,
        imageId: Number(imageId),
        archiveCfg,
        meta: meta || {},
        archiveType: archive_type,
        action,
        writeExif: write_exif,
      });
      results.push({ image_id: imageId, ...result });
    }

    const successCount = results.filter(r => r.ok).length;
    const errorCount   = results.filter(r => !r.ok).length;
    console.log(`[archive-routes] POST /organize done: ${successCount} ok, ${errorCount} errors`);
    res.json({ ok: true, results, success_count: successCount, error_count: errorCount });
  } catch (err) {
    console.error('[archive-routes] POST /organize error:', err.message);
    res.status(500).json({ detail: err.message });
  }
});

// ── POST /archive/bildauswahl ─────────────────────────────────────────────────

router.post('/bildauswahl', requireAuth, async (req, res) => {
  const { image_ids, meta, action, write_exif = false } = req.body || {};
  console.log(`[archive-routes] POST /bildauswahl ids=${JSON.stringify(image_ids)} action=${action}`);

  if (!Array.isArray(image_ids) || image_ids.length === 0) {
    return res.status(400).json({ detail: 'image_ids must be a non-empty array' });
  }
  if (!['copy', 'move', 'leave'].includes(action)) {
    return res.status(400).json({ detail: 'action must be copy | move | leave' });
  }

  try {
    const db = getDb();
    const archiveCfg = getArchiveConfig(db);
    const results = [];

    for (const imageId of image_ids) {
      const result = await organizeImage({
        db,
        imageId: Number(imageId),
        archiveCfg,
        meta: meta || {},
        archiveType: 'bildauswahl',
        action,
        writeExif: write_exif,
      });
      results.push({ image_id: imageId, ...result });
    }

    const successCount = results.filter(r => r.ok).length;
    const errorCount   = results.filter(r => !r.ok).length;
    console.log(`[archive-routes] POST /bildauswahl done: ${successCount} ok, ${errorCount} errors`);
    res.json({ ok: true, results, success_count: successCount, error_count: errorCount });
  } catch (err) {
    console.error('[archive-routes] POST /bildauswahl error:', err.message);
    res.status(500).json({ detail: err.message });
  }
});

// ── POST /archive/rename-batch ─────────────────────────────────────────────────

router.post('/rename-batch', requireAuth, async (req, res) => {
  const { image_ids, meta, archive_type = 'bildarchiv', rename_file = false } = req.body || {};
  console.log(`[archive-routes] POST /rename-batch ids=${JSON.stringify(image_ids)} type=${archive_type} rename_file=${rename_file}`);

  if (!Array.isArray(image_ids) || image_ids.length === 0) {
    return res.status(400).json({ detail: 'image_ids must be a non-empty array' });
  }

  try {
    const db = getDb();
    const archiveCfg = getArchiveConfig(db);
    const results = [];

    for (const imageId of image_ids) {
      const result = await renameArchiveImage({
        db,
        imageId: Number(imageId),
        archiveCfg,
        meta: meta || {},
        archiveType: archive_type,
        renameFile: rename_file,
      });
      results.push({ image_id: imageId, ...result });
    }

    const successCount = results.filter(r => r.ok).length;
    console.log(`[archive-routes] POST /rename-batch done: ${successCount}/${image_ids.length} ok`);
    res.json({ ok: true, results, success_count: successCount });
  } catch (err) {
    console.error('[archive-routes] POST /rename-batch error:', err.message);
    res.status(500).json({ detail: err.message });
  }
});

// ── POST /archive/write-exif ───────────────────────────────────────────────────

router.post('/write-exif', requireAuth, async (req, res) => {
  const { image_ids, fields } = req.body || {};
  console.log(`[archive-routes] POST /write-exif ids=${JSON.stringify(image_ids)}`);

  if (!Array.isArray(image_ids) || image_ids.length === 0) {
    return res.status(400).json({ detail: 'image_ids must be a non-empty array' });
  }

  const exifAvailable = await checkExiftoolAvailable();

  try {
    const db = getDb();
    const archiveCfg = getArchiveConfig(db);
    const results = [];

    for (const imageId of image_ids) {
      const row = db.prepare('SELECT filepath, local_path, bildarchiv_path, bildauswahl_path FROM images WHERE id=?').get(Number(imageId));
      if (!row) { results.push({ image_id: imageId, ok: false, error: 'Not found' }); continue; }

      // Write to best available path
      const targetPath =
        (row.bildarchiv_path  && require('fs').existsSync(row.bildarchiv_path))  ? row.bildarchiv_path  :
        (row.bildauswahl_path && require('fs').existsSync(row.bildauswahl_path)) ? row.bildauswahl_path :
        (row.filepath         && require('fs').existsSync(row.filepath))         ? row.filepath         :
        (row.local_path       && require('fs').existsSync(row.local_path))       ? row.local_path       : null;

      if (!targetPath) {
        results.push({ image_id: imageId, ok: false, skipped: true, reason: 'No accessible file path' });
        continue;
      }

      const exifResult = await writeExifMetadata(targetPath, fields || {}, archiveCfg.exif_mapping);
      results.push({ image_id: imageId, path: targetPath, ...exifResult });
    }

    res.json({ ok: true, exiftool_available: exifAvailable, results });
  } catch (err) {
    console.error('[archive-routes] POST /write-exif error:', err.message);
    res.status(500).json({ detail: err.message });
  }
});

// ── GET /archive/resolve-path/:id ─────────────────────────────────────────────

router.get('/resolve-path/:id', requireAuth, (req, res) => {
  const imageId = Number(req.params.id);
  console.log(`[archive-routes] GET /resolve-path/${imageId}`);
  try {
    const db = getDb();
    const result = resolveImagePath(db, imageId);
    if (!result) return res.status(404).json({ detail: 'No accessible file for this image' });
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error('[archive-routes] GET /resolve-path error:', err.message);
    res.status(500).json({ detail: err.message });
  }
});

// ── GET /archive/exiftool-status ──────────────────────────────────────────────

router.get('/exiftool-status', requireAuth, async (req, res) => {
  const available = await checkExiftoolAvailable();
  res.json({ ok: true, available });
});

module.exports = router;
