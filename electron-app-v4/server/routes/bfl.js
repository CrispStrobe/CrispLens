'use strict';

/**
 * bfl.js — AI image editing via Black Forest Labs (BFL) API.
 *
 * Endpoints:
 *   POST /api/bfl/outpaint  — extend image borders with FLUX.1 Fill [pro]
 *   POST /api/bfl/inpaint   — fill a masked region with FLUX.1 Fill [pro]
 *   POST /api/bfl/edit      — instruction-based editing (FLUX.1 Kontext or FLUX.2)
 *   POST /api/bfl/generate  — text-to-image generation
 *   GET  /api/bfl/preview   — serve a generated file by path
 *   POST /api/bfl/register  — register a generated file into the images DB
 */

const express = require('express');
const path    = require('path');
const fs      = require('fs');
const sharp   = require('sharp');
const { getDb, getDbPath } = require('../db');
const { requireAuth }      = require('../auth');

const router = express.Router();

const BFL_API_BASE     = 'https://api.bfl.ai/v1';
const FILL_ENDPOINT    = '/flux-pro-1.0-fill';
const KONTEXT_ENDPOINT = '/flux-kontext-pro';

const EDIT_MODELS = new Set([
  'flux-kontext-pro',
  'flux-2-pro', 'flux-2-max', 'flux-2-flex',
  'flux-2-klein-4b', 'flux-2-klein-9b',
]);

const GENERATE_ENDPOINTS = {
  'flux-kontext-pro': '/flux-kontext-pro',
  'flux-pro-1.1':     '/flux-pro-1.1',
  'flux-pro':         '/flux-pro',
  'flux-dev':         '/flux-dev',
  'flux-2-klein-4b':  '/flux-2-klein-4b',
  'flux-2-klein-9b':  '/flux-2-klein-9b',
  'flux-2-pro':       '/flux-2-pro',
  'flux-2-max':       '/flux-2-max',
  'flux-2-flex':      '/flux-2-flex',
};

const FLUX2_MODELS = new Set(Object.keys(GENERATE_ENDPOINTS).filter(m => m.startsWith('flux-2-')));

// ── Helpers ───────────────────────────────────────────────────────────────────

function getBflKey(req) {
  const db  = getDb();
  const userId = req.user?.userId ?? null;

  // Try user key first, then system key
  let row = null;
  if (userId != null) {
    row = db.prepare("SELECT key_value FROM api_keys WHERE provider='bfl' AND scope='user' AND owner_id=?").get(userId);
  }
  if (!row) {
    row = db.prepare("SELECT key_value FROM api_keys WHERE provider='bfl' AND scope='system' ORDER BY rowid DESC LIMIT 1").get();
  }
  if (!row) {
    // Fall back to env var
    const envKey = process.env.BFL_API_KEY;
    if (envKey) return envKey;
    return null;
  }
  return row.key_value;
}

function getImageInfo(imageId) {
  const db  = getDb();
  return db.prepare('SELECT filepath, filename, width, height, owner_id FROM images WHERE id=?').get(imageId) || null;
}

/** Convert sharp metadata to { width, height } after writing a file. */
async function getImageDims(filePath) {
  const meta = await sharp(filePath).metadata();
  return { w: meta.width || 0, h: meta.height || 0 };
}

/** Encode an image as base64 PNG using sharp. */
async function imgToB64Png(filePath) {
  const buf = await sharp(filePath).rotate().png().toBuffer();
  return buf.toString('base64');
}

/** Encode an image as base64 JPEG using sharp. */
async function imgToB64Jpeg(filePath) {
  const buf = await sharp(filePath).rotate().jpeg({ quality: 92 }).toBuffer();
  return buf.toString('base64');
}

/** Build a white/black PNG mask buffer of given size with optional filled rectangle. */
async function buildMaskPng(width, height, bgFill, rectFill, rect) {
  // bgFill: 0 = black, 255 = white
  // rectFill: fill value for the inner rectangle
  // rect: { x, y, w, h } or null
  const raw = Buffer.alloc(width * height, bgFill);
  if (rect && rect.w > 0 && rect.h > 0) {
    const x1 = Math.max(0, rect.x), y1 = Math.max(0, rect.y);
    const x2 = Math.min(width,  rect.x + rect.w);
    const y2 = Math.min(height, rect.y + rect.h);
    for (let row = y1; row < y2; row++) {
      raw.fill(rectFill, row * width + x1, row * width + x2);
    }
  }
  const buf = await sharp(raw, { raw: { width, height, channels: 1 } }).png().toBuffer();
  return buf.toString('base64');
}

async function bflSubmit(apiKey, endpoint, payload) {
  const resp = await fetch(BFL_API_BASE + endpoint, {
    method:  'POST',
    headers: { 'x-key': apiKey, 'Content-Type': 'application/json' },
    body:    JSON.stringify(payload),
    signal:  AbortSignal.timeout(30_000),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw Object.assign(new Error(`BFL submit error ${resp.status}: ${text.slice(0, 300)}`), { status: 502 });
  }
  const data = await resp.json();
  const requestId  = data.id || data.request_id;
  const pollingUrl = data.polling_url || `${BFL_API_BASE}/get_result?id=${requestId}`;
  return { requestId, pollingUrl };
}

async function bflPoll(apiKey, pollingUrl, timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 1500));
    const resp = await fetch(pollingUrl, {
      headers: { 'x-key': apiKey },
      signal:  AbortSignal.timeout(15_000),
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw Object.assign(new Error(`BFL poll error ${resp.status}: ${text.slice(0, 300)}`), { status: 502 });
    }
    const data   = await resp.json();
    const status = data.status || '';
    if (status === 'Ready') {
      const result = data.result;
      const sample = (result && typeof result === 'object') ? result.sample : data.sample;
      if (!sample) throw Object.assign(new Error('BFL result missing sample URL'), { status: 502 });
      return sample;
    }
    if (status === 'Error' || status === 'Failed') {
      throw Object.assign(new Error(`BFL job failed: ${data.error || status}`), { status: 502 });
    }
  }
  throw Object.assign(new Error('BFL job timed out after 180 seconds'), { status: 504 });
}

async function downloadResult(url) {
  const resp = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (!resp.ok) throw Object.assign(new Error(`Failed to download BFL result: ${resp.status}`), { status: 502 });
  return Buffer.from(await resp.arrayBuffer());
}

function buildBflOutPath(filepath, suffix) {
  const p    = path.parse(filepath);
  return path.join(p.dir, p.name + suffix + '.jpg');
}

function round16(v) { return Math.max(16, Math.floor(v / 16) * 16); }
function round32(v) { return Math.max(32, Math.floor(v / 32) * 32); }

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

async function saveAndRegister(db, resultBytes, outPath, imageId, saveAs, ownerId, register) {
  fs.writeFileSync(outPath, resultBytes);
  const { w, h } = await getImageDims(outPath);

  if (saveAs === 'replace') {
    db.prepare('UPDATE images SET width=?, height=? WHERE id=?').run(w, h, imageId);
    return { newId: imageId, w, h };
  }
  if (register) {
    const newId = registerConvertedFile(db, outPath, w, h, ownerId);
    return { newId, w, h };
  }
  return { newId: null, w, h };
}

// ── Routes ────────────────────────────────────────────────────────────────────

// POST /api/bfl/outpaint
router.post('/outpaint', requireAuth, async (req, res) => {
  const {
    image_id,
    add_top = 0, add_bottom = 0, add_left = 0, add_right = 0,
    prompt = '',
    save_as = 'new_file',
    suffix  = '_outpainted',
    register_in_db = true,
  } = req.body || {};

  if (!image_id) return res.status(400).json({ detail: 'image_id required' });
  const apiKey = getBflKey(req);
  if (!apiKey) return res.status(400).json({ detail: 'BFL API key not configured — add it in Settings → API Keys' });

  const info = getImageInfo(image_id);
  if (!info) return res.status(404).json({ detail: 'Image not found' });
  if (!fs.existsSync(info.filepath)) return res.status(404).json({ detail: 'File not found on disk' });

  try {
    const meta    = await sharp(info.filepath).rotate().metadata();
    const origW   = meta.width  || 0;
    const origH   = meta.height || 0;
    const newW    = round16(origW + (add_left|0) + (add_right|0));
    const newH    = round16(origH + (add_top|0)  + (add_bottom|0));

    // Build padded canvas (original at offset, rest black)
    const canvasBuf = await sharp({
      create: { width: newW, height: newH, channels: 3, background: { r: 0, g: 0, b: 0 } },
    })
      .composite([{ input: await sharp(info.filepath).rotate().jpeg({ quality: 95 }).toBuffer(),
                    left: add_left|0, top: add_top|0 }])
      .png().toBuffer();
    const imageB64 = canvasBuf.toString('base64');

    // Mask: white everywhere, then black rectangle preserving original
    const maskB64  = await buildMaskPng(newW, newH, 255, 0,
      { x: add_left|0, y: add_top|0, w: origW, h: origH });

    const finalPrompt = (prompt || '').trim() ||
      'Extend the image naturally to fill the surrounding area, maintaining the original composition, style, and lighting.';

    const payload = {
      image: imageB64, mask: maskB64,
      prompt: finalPrompt,
      steps: 50, guidance: 30,
      output_format: 'jpeg',
      width: newW, height: newH,
    };

    console.log(`[bfl/outpaint] image_id=${image_id} +t=${add_top} +b=${add_bottom} +l=${add_left} +r=${add_right} → ${newW}×${newH}`);
    const { pollingUrl } = await bflSubmit(apiKey, FILL_ENDPOINT, payload);
    const sampleUrl      = await bflPoll(apiKey, pollingUrl);
    const resultBytes    = await downloadResult(sampleUrl);

    const outPath = save_as === 'replace' ? info.filepath : buildBflOutPath(info.filepath, suffix);
    const db      = getDb();
    const { newId, w, h } = await saveAndRegister(db, resultBytes, outPath, image_id, save_as, req.user?.userId, register_in_db);
    console.log(`[bfl/outpaint] done → ${outPath} | new_image_id=${newId} | ${w}×${h}`);

    res.json({ ok: true, image_id, new_image_id: newId, filepath: outPath, width: w, height: h });
  } catch (err) {
    console.error('[bfl/outpaint] error:', err.message);
    res.status(err.status || 500).json({ detail: err.message });
  }
});


// POST /api/bfl/inpaint
router.post('/inpaint', requireAuth, async (req, res) => {
  const {
    image_id,
    prompt = '',
    mask_x = 0, mask_y = 0, mask_w = 0, mask_h = 0,
    save_as = 'new_file',
    suffix  = '_inpainted',
    register_in_db = true,
  } = req.body || {};

  if (!image_id) return res.status(400).json({ detail: 'image_id required' });
  if (!prompt)   return res.status(400).json({ detail: 'prompt required' });
  const apiKey = getBflKey(req);
  if (!apiKey) return res.status(400).json({ detail: 'BFL API key not configured — add it in Settings → API Keys' });

  const info = getImageInfo(image_id);
  if (!info) return res.status(404).json({ detail: 'Image not found' });
  if (!fs.existsSync(info.filepath)) return res.status(404).json({ detail: 'File not found on disk' });

  try {
    const meta  = await sharp(info.filepath).rotate().metadata();
    const newW  = round16(meta.width  || 0);
    const newH  = round16(meta.height || 0);

    const imgBuf   = await sharp(info.filepath).rotate().resize(newW, newH).png().toBuffer();
    const imageB64 = imgBuf.toString('base64');

    // Mask: black everywhere (preserve), white only inside inpaint rect
    const maskB64  = await buildMaskPng(newW, newH, 0, 255,
      { x: mask_x|0, y: mask_y|0, w: mask_w|0, h: mask_h|0 });

    const payload = {
      image: imageB64, mask: maskB64,
      prompt,
      steps: 50, guidance: 30,
      output_format: 'jpeg',
      width: newW, height: newH,
    };

    console.log(`[bfl/inpaint] image_id=${image_id} mask=[${mask_x},${mask_y},${mask_w},${mask_h}]`);
    const { pollingUrl } = await bflSubmit(apiKey, FILL_ENDPOINT, payload);
    const sampleUrl      = await bflPoll(apiKey, pollingUrl);
    const resultBytes    = await downloadResult(sampleUrl);

    const outPath = save_as === 'replace' ? info.filepath : buildBflOutPath(info.filepath, suffix);
    const db      = getDb();
    const { newId, w, h } = await saveAndRegister(db, resultBytes, outPath, image_id, save_as, req.user?.userId, register_in_db);
    console.log(`[bfl/inpaint] done → ${outPath} | new_image_id=${newId} | ${w}×${h}`);

    res.json({ ok: true, image_id, new_image_id: newId, filepath: outPath, width: w, height: h });
  } catch (err) {
    console.error('[bfl/inpaint] error:', err.message);
    res.status(err.status || 500).json({ detail: err.message });
  }
});


// POST /api/bfl/edit
router.post('/edit', requireAuth, async (req, res) => {
  const {
    image_id,
    prompt,
    model         = 'flux-kontext-pro',
    aspect_ratio  = null,
    save_as       = 'new_file',
    suffix        = '_edited',
    seed          = null,
    register_in_db = true,
  } = req.body || {};

  if (!image_id) return res.status(400).json({ detail: 'image_id required' });
  if (!prompt)   return res.status(400).json({ detail: 'prompt required' });
  if (!EDIT_MODELS.has(model)) return res.status(400).json({ detail: `Unknown model: ${model}` });

  const apiKey = getBflKey(req);
  if (!apiKey) return res.status(400).json({ detail: 'BFL API key not configured — add it in Settings → API Keys' });

  const info = getImageInfo(image_id);
  if (!info) return res.status(404).json({ detail: 'Image not found' });
  if (!fs.existsSync(info.filepath)) return res.status(404).json({ detail: 'File not found on disk' });

  try {
    const imageB64 = await imgToB64Jpeg(info.filepath);

    const payload = { prompt, input_image: imageB64, output_format: 'jpeg' };
    if (seed != null) payload.seed = seed;

    let endpoint;
    if (model.startsWith('flux-kontext')) {
      endpoint = KONTEXT_ENDPOINT;
      if (aspect_ratio) payload.aspect_ratio = aspect_ratio;
    } else {
      endpoint = `/${model}`;
    }

    console.log(`[bfl/edit] image_id=${image_id} model=${model} prompt="${prompt.slice(0, 80)}"`);
    const { pollingUrl } = await bflSubmit(apiKey, endpoint, payload);
    const sampleUrl      = await bflPoll(apiKey, pollingUrl);
    const resultBytes    = await downloadResult(sampleUrl);

    const outPath = save_as === 'replace' ? info.filepath : buildBflOutPath(info.filepath, suffix);
    const db      = getDb();
    const { newId, w, h } = await saveAndRegister(db, resultBytes, outPath, image_id, save_as, req.user?.userId, register_in_db);
    console.log(`[bfl/edit] done → ${outPath} | new_image_id=${newId} | ${w}×${h}`);

    res.json({ ok: true, image_id, new_image_id: newId, filepath: outPath, width: w, height: h });
  } catch (err) {
    console.error('[bfl/edit] error:', err.message);
    res.status(err.status || 500).json({ detail: err.message });
  }
});


// POST /api/bfl/generate
router.post('/generate', requireAuth, async (req, res) => {
  const {
    prompt,
    model            = 'flux-kontext-pro',
    aspect_ratio     = '1:1',
    width            = null,
    height           = null,
    steps            = null,
    guidance         = null,
    seed             = null,
    output_folder    = '',
    filename_prefix  = 'generated',
    image_id         = null,
    register_in_db   = true,
  } = req.body || {};

  if (!prompt) return res.status(400).json({ detail: 'prompt required' });

  const apiKey = getBflKey(req);
  if (!apiKey) return res.status(400).json({ detail: 'BFL API key not configured — add it in Settings → API Keys' });

  const isFlux2 = FLUX2_MODELS.has(model);
  const isFlex  = model === 'flux-2-flex';

  // Determine output directory
  const dbPath  = getDbPath();
  const outDir  = output_folder.trim() || path.join(path.dirname(dbPath), 'generated');
  try { fs.mkdirSync(outDir, { recursive: true }); } catch (e) {
    return res.status(500).json({ detail: `Cannot create output folder: ${e.message}` });
  }

  const prefix   = (filename_prefix || 'generated').trim();
  const hex4     = Math.floor(Math.random() * 0xFFFF).toString(16).padStart(4, '0');
  const filename = `${prefix}_${Date.now()}_${hex4}.jpg`;
  const outPath  = path.join(outDir, filename);

  try {
    const payload = { prompt, output_format: 'jpeg' };
    if (seed != null) payload.seed = seed;

    if (isFlux2) {
      payload.width  = round16(width  || 1024);
      payload.height = round16(height || 1024);
      if (isFlex) {
        if (steps    != null) payload.steps    = steps;
        if (guidance != null) payload.guidance = guidance;
      }
    } else {
      payload.aspect_ratio = aspect_ratio || '1:1';
    }

    // Optional reference image
    if (image_id != null) {
      const refInfo = getImageInfo(image_id);
      if (refInfo && fs.existsSync(refInfo.filepath)) {
        payload.input_image = await imgToB64Jpeg(refInfo.filepath);
        console.log(`[bfl/generate] attaching reference image_id=${image_id}`);
      }
    }

    const genEndpoint = GENERATE_ENDPOINTS[model] || KONTEXT_ENDPOINT;
    console.log(`[bfl/generate] model=${model} endpoint=${genEndpoint} prompt="${prompt.slice(0, 80)}"`);

    const { pollingUrl } = await bflSubmit(apiKey, genEndpoint, payload);
    const sampleUrl      = await bflPoll(apiKey, pollingUrl);
    const resultBytes    = await downloadResult(sampleUrl);

    fs.writeFileSync(outPath, resultBytes);
    const { w, h } = await getImageDims(outPath);

    let newId = null;
    if (register_in_db) {
      const db = getDb();
      newId = registerConvertedFile(db, outPath, w, h, req.user?.userId);
    }
    console.log(`[bfl/generate] done → ${outPath} | new_image_id=${newId} | ${w}×${h}`);

    res.json({ ok: true, new_image_id: newId, filepath: outPath, width: w, height: h });
  } catch (err) {
    console.error('[bfl/generate] error:', err.message);
    res.status(err.status || 500).json({ detail: err.message });
  }
});


// GET /api/bfl/preview?path=<filepath>
router.get('/preview', requireAuth, (req, res) => {
  const filePath = req.query.path;
  if (!filePath) return res.status(400).json({ detail: 'path query param required' });

  const dbPath  = getDbPath();
  const dataDir = path.resolve(path.dirname(dbPath));
  const absPath = path.resolve(filePath);

  if (!absPath.startsWith(dataDir)) {
    return res.status(403).json({ detail: 'Path not allowed' });
  }
  if (!fs.existsSync(absPath) || !fs.statSync(absPath).isFile()) {
    return res.status(404).json({ detail: 'File not found' });
  }

  const ext  = path.extname(absPath).toLowerCase();
  const mime = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' }[ext] || 'image/jpeg';
  res.setHeader('Content-Type', mime);
  res.sendFile(absPath);
});


// POST /api/bfl/register  { filepath }
router.post('/register', requireAuth, async (req, res) => {
  const { filepath } = req.body || {};
  if (!filepath) return res.status(400).json({ detail: 'filepath required' });

  const dbPath  = getDbPath();
  const dataDir = path.resolve(path.dirname(dbPath));
  const absPath = path.resolve(filepath);

  if (!absPath.startsWith(dataDir)) return res.status(403).json({ detail: 'Path not allowed' });
  if (!fs.existsSync(absPath) || !fs.statSync(absPath).isFile()) return res.status(404).json({ detail: 'File not found on disk' });

  try {
    const { w, h } = await getImageDims(absPath);
    const db       = getDb();
    const newId    = registerConvertedFile(db, absPath, w, h, req.user?.userId);
    res.json({ ok: true, new_image_id: newId, width: w, height: h });
  } catch (err) {
    res.status(500).json({ detail: err.message });
  }
});

module.exports = router;
