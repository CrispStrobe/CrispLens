'use strict';

/**
 * editing.js — Image editing: canvas-size, convert, convert-batch, formats.
 *
 * Endpoints:
 *   GET  /api/edit/formats        — list supported output formats
 *   POST /api/edit/canvas-size    — add border (solid color or mirror-edge)
 *   POST /api/edit/convert        — convert/resize images (sync, up to 50)
 *   POST /api/edit/convert-batch  — streaming batch convert (SSE)
 */

const express = require('express');
const path    = require('path');
const fs      = require('fs');
const sharp   = require('sharp');
const { getDb }      = require('../db');
const { requireAuth } = require('../auth');

const router = express.Router();

const SUPPORTED_FORMATS = {
  jpeg: { ext: '.jpg',  mime: 'image/jpeg', quality: true  },
  png:  { ext: '.png',  mime: 'image/png',  quality: false },
  webp: { ext: '.webp', mime: 'image/webp', quality: true  },
  tiff: { ext: '.tiff', mime: 'image/tiff', quality: false },
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function registerConvertedFile(db, outPath, w, h, ownerId) {
  const filename = path.basename(outPath);
  const r = db.prepare(`
    INSERT OR IGNORE INTO images (filepath, filename, width, height, processed, owner_id, visibility)
    VALUES (?, ?, ?, ?, 1, ?, 'shared')
  `).run(outPath, filename, w, h, ownerId ?? null);
  if (r.lastInsertRowid) return r.lastInsertRowid;
  const existing = db.prepare('SELECT id FROM images WHERE filepath=?').get(outPath);
  return existing ? existing.id : null;
}

/** Parse '#rrggbb' or '#rgb' → { r, g, b } */
function hexToRgb(hex) {
  let s = hex.replace('#', '');
  if (s.length === 3) s = s[0]+s[0] + s[1]+s[1] + s[2]+s[2];
  return { r: parseInt(s.slice(0,2),16)||0, g: parseInt(s.slice(2,4),16)||0, b: parseInt(s.slice(4,6),16)||0 };
}

function buildOutPath(filepath, body) {
  const fmtInfo = SUPPORTED_FORMATS[body.output_format];
  const p       = path.parse(filepath);
  const stem    = p.name + (body.save_as === 'new_file' ? (body.suffix || '_converted') : '');
  const newName = stem + fmtInfo.ext;
  if (body.save_as === 'output_folder' && body.output_folder) {
    fs.mkdirSync(body.output_folder, { recursive: true });
    return path.join(body.output_folder, newName);
  }
  return path.join(p.dir, newName);
}

async function doConvertOne(filepath, outPath, body) {
  let pipeline = sharp(filepath).rotate();

  // Resize
  if (body.resize_mode === 'fit' && body.max_width && body.max_height) {
    pipeline = pipeline.resize(body.max_width, body.max_height, { fit: 'inside', withoutEnlargement: true });
  } else if (body.resize_mode === 'exact' && body.max_width && body.max_height) {
    pipeline = pipeline.resize(body.max_width, body.max_height, { fit: 'fill' });
  }

  // Format + quality
  switch (body.output_format) {
    case 'jpeg': pipeline = pipeline.flatten({ background: '#ffffff' }).jpeg({ quality: body.quality || 85 }); break;
    case 'png':  pipeline = pipeline.png(); break;
    case 'webp': pipeline = pipeline.webp({ quality: body.quality || 85 }); break;
    case 'tiff': pipeline = pipeline.tiff(); break;
    default:     pipeline = pipeline.jpeg({ quality: 85 });
  }

  await pipeline.toFile(outPath);
  const meta = await sharp(outPath).metadata();
  return { w: meta.width || 0, h: meta.height || 0 };
}

// ── Routes ────────────────────────────────────────────────────────────────────

// GET /api/edit/formats
router.get('/formats', requireAuth, (req, res) => {
  res.json(Object.entries(SUPPORTED_FORMATS).map(([id, v]) => ({
    id, label: id.toUpperCase(), quality_option: v.quality,
  })));
});


// POST /api/edit/canvas-size
router.post('/canvas-size', requireAuth, async (req, res) => {
  const {
    image_id,
    add_top    = 0,
    add_bottom = 0,
    add_left   = 0,
    add_right  = 0,
    fill_mode  = 'solid',
    fill_color = '#000000',
    save_as    = 'new_file',
    suffix     = '_border',
  } = req.body || {};

  if (!image_id) return res.status(400).json({ detail: 'image_id required' });
  if (!['solid', 'mirror'].includes(fill_mode))
    return res.status(400).json({ detail: `Unsupported fill_mode: ${fill_mode}. Use 'solid' or 'mirror'.` });

  const addT = Math.max(0, add_top|0),    addB = Math.max(0, add_bottom|0);
  const addL = Math.max(0, add_left|0),   addR = Math.max(0, add_right|0);

  if (addT === 0 && addB === 0 && addL === 0 && addR === 0)
    return res.status(400).json({ detail: 'All border sizes are zero — nothing to do' });

  const db  = getDb();
  const row = db.prepare('SELECT filepath FROM images WHERE id=?').get(image_id);
  if (!row) return res.status(404).json({ detail: 'Image not found' });
  if (!fs.existsSync(row.filepath)) return res.status(404).json({ detail: 'File not found on disk' });

  try {
    const meta  = await sharp(row.filepath).rotate().metadata();
    const origW = meta.width  || 0;
    const origH = meta.height || 0;
    const newW  = origW + addL + addR;
    const newH  = origH + addT + addB;

    let outBuf;

    if (fill_mode === 'solid') {
      const { r, g, b } = hexToRgb(fill_color || '#000000');
      // Create solid canvas, paste original on top
      outBuf = await sharp({
        create: { width: newW, height: newH, channels: 3, background: { r, g, b } },
      })
        .composite([{
          input: await sharp(row.filepath).rotate().jpeg({ quality: 95 }).toBuffer(),
          left: addL, top: addT,
        }])
        .jpeg({ quality: 92 })
        .toBuffer();
    } else {
      // mirror: start with original pasted at offset, fill each border by stretching edge pixel row/col
      const origBuf = await sharp(row.filepath).rotate().toBuffer();

      const composites = [];

      // Original at center
      composites.push({ input: origBuf, left: addL, top: addT });

      // Top strip: stretch top row
      if (addT > 0) {
        const strip = await sharp(origBuf).extract({ left: 0, top: 0, width: origW, height: 1 })
          .resize(origW, addT, { fit: 'fill', kernel: 'nearest' }).toBuffer();
        composites.push({ input: strip, left: addL, top: 0 });
      }
      // Bottom strip
      if (addB > 0) {
        const strip = await sharp(origBuf).extract({ left: 0, top: origH - 1, width: origW, height: 1 })
          .resize(origW, addB, { fit: 'fill', kernel: 'nearest' }).toBuffer();
        composites.push({ input: strip, left: addL, top: addT + origH });
      }
      // Left strip
      if (addL > 0) {
        const strip = await sharp(origBuf).extract({ left: 0, top: 0, width: 1, height: origH })
          .resize(addL, origH, { fit: 'fill', kernel: 'nearest' }).toBuffer();
        composites.push({ input: strip, left: 0, top: addT });
      }
      // Right strip
      if (addR > 0) {
        const strip = await sharp(origBuf).extract({ left: origW - 1, top: 0, width: 1, height: origH })
          .resize(addR, origH, { fit: 'fill', kernel: 'nearest' }).toBuffer();
        composites.push({ input: strip, left: addL + origW, top: addT });
      }
      // Corner pixels — get from orig metadata and fill
      const { data: px } = await sharp(origBuf).raw().toBuffer({ resolveWithObject: true });
      const ch = meta.channels || 3;
      const getPixel = (x, y) => ({
        r: px[(y * origW + x) * ch],
        g: px[(y * origW + x) * ch + 1],
        b: px[(y * origW + x) * ch + 2],
      });

      const corners = [
        { cond: addT > 0 && addL > 0, px: getPixel(0, 0),           left: 0,         top: 0,         width: addL, height: addT },
        { cond: addT > 0 && addR > 0, px: getPixel(origW-1, 0),     left: addL+origW, top: 0,         width: addR, height: addT },
        { cond: addB > 0 && addL > 0, px: getPixel(0, origH-1),     left: 0,         top: addT+origH, width: addL, height: addB },
        { cond: addB > 0 && addR > 0, px: getPixel(origW-1, origH-1),left: addL+origW,top: addT+origH,width: addR, height: addB },
      ];
      for (const c of corners) {
        if (!c.cond || c.width <= 0 || c.height <= 0) continue;
        const cornerBuf = await sharp({ create: { width: c.width, height: c.height, channels: 3, background: c.px } })
          .jpeg({ quality: 95 }).toBuffer();
        composites.push({ input: cornerBuf, left: c.left, top: c.top });
      }

      outBuf = await sharp({
        create: { width: newW, height: newH, channels: 3, background: { r: 0, g: 0, b: 0 } },
      })
        .composite(composites)
        .jpeg({ quality: 92 })
        .toBuffer();
    }

    // Determine output path — preserve original extension if possible
    const p       = path.parse(row.filepath);
    const origExt = p.ext.toLowerCase();
    // Always save as JPEG for simplicity (consistent with BFL output)
    const outPath = save_as === 'replace' ? row.filepath
      : path.join(p.dir, p.name + suffix + (origExt || '.jpg'));

    fs.writeFileSync(outPath, outBuf);
    const outMeta = await sharp(outPath).metadata();
    const { width: w, height: h } = outMeta;

    let newImageId = null;
    if (save_as === 'replace') {
      db.prepare('UPDATE images SET width=?, height=? WHERE id=?').run(w, h, image_id);
      newImageId = image_id;
    } else {
      newImageId = registerConvertedFile(db, outPath, w, h, req.user?.userId);
    }

    res.json({ ok: true, image_id, new_image_id: newImageId, filepath: outPath, width: w, height: h });
  } catch (err) {
    console.error('[edit/canvas-size] error:', err.message, err.stack);
    res.status(500).json({ detail: err.message });
  }
});


// POST /api/edit/convert  (sync, up to 50 images)
router.post('/convert', requireAuth, async (req, res) => {
  const {
    image_ids      = [],
    output_format  = 'jpeg',
    quality        = 85,
    resize_mode    = 'none',
    max_width      = null,
    max_height     = null,
    save_as        = 'new_file',
    output_folder  = null,
    suffix         = '_converted',
  } = req.body || {};

  if (!SUPPORTED_FORMATS[output_format])
    return res.status(400).json({ detail: `Unsupported format: ${output_format}` });
  if (image_ids.length > 50)
    return res.status(400).json({ detail: 'Use /convert-batch for > 50 images' });

  const db      = getDb();
  const body    = { output_format, quality, resize_mode, max_width, max_height, save_as, output_folder, suffix };
  const results = [];

  for (const image_id of image_ids) {
    const row = db.prepare('SELECT filepath FROM images WHERE id=?').get(image_id);
    if (!row || !fs.existsSync(row.filepath)) {
      results.push({ image_id, ok: false, error: 'File not found' });
      continue;
    }
    const outPath = save_as === 'replace' ? row.filepath : buildOutPath(row.filepath, body);
    try {
      const { w, h } = await doConvertOne(row.filepath, outPath, body);
      let newId = null;
      if (save_as === 'replace') {
        db.prepare('UPDATE images SET width=?, height=? WHERE id=?').run(w, h, image_id);
        newId = image_id;
      } else {
        newId = registerConvertedFile(db, outPath, w, h, req.user?.userId);
      }
      results.push({ image_id, new_image_id: newId, ok: true, filepath: outPath, width: w, height: h });
    } catch (e) {
      console.error(`[edit/convert] image_id=${image_id} error:`, e.message);
      results.push({ image_id, ok: false, error: 'Conversion failed' });
    }
  }

  res.json({ results, total: results.length, ok: results.filter(r => r.ok).length });
});


// POST /api/edit/convert-batch  (SSE streaming)
router.post('/convert-batch', requireAuth, async (req, res) => {
  const {
    image_ids      = [],
    output_format  = 'jpeg',
    quality        = 85,
    resize_mode    = 'none',
    max_width      = null,
    max_height     = null,
    save_as        = 'new_file',
    output_folder  = null,
    suffix         = '_converted',
  } = req.body || {};

  if (!SUPPORTED_FORMATS[output_format]) {
    res.status(400).json({ detail: `Unsupported format: ${output_format}` });
    return;
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  const db   = getDb();
  const body = { output_format, quality, resize_mode, max_width, max_height, save_as, output_folder, suffix };
  const total = image_ids.length;
  let done = 0, ok = 0;

  const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

  for (const image_id of image_ids) {
    const row = db.prepare('SELECT filepath FROM images WHERE id=?').get(image_id);
    if (!row || !fs.existsSync(row.filepath)) {
      done++;
      send({ index: done, total, image_id, ok: false, error: 'not found' });
      continue;
    }
    const outPath = save_as === 'replace' ? row.filepath : buildOutPath(row.filepath, body);
    try {
      const { w, h } = await doConvertOne(row.filepath, outPath, body);
      let newId = null;
      if (save_as === 'replace') {
        db.prepare('UPDATE images SET width=?, height=? WHERE id=?').run(w, h, image_id);
        newId = image_id;
      } else {
        newId = registerConvertedFile(db, outPath, w, h, req.user?.userId);
      }
      done++; ok++;
      send({ index: done, total, image_id, new_image_id: newId, ok: true, filepath: outPath, width: w, height: h });
    } catch (e) {
      console.error(`[edit/convert-batch] image_id=${image_id} error:`, e.message);
      done++;
      send({ index: done, total, image_id, ok: false, error: 'Conversion failed' });
    }
  }

  send({ done: true, total, ok });
  res.end();
});

module.exports = router;
